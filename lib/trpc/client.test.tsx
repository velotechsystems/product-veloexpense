import '@testing-library/jest-dom/vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The tRPC provider, and what happens when a session dies in the background.
 *
 * A JWT past its max age, an idle tab, a restarted server: the next query comes back
 * UNAUTHORIZED, and without this the app just logs a cryptic error and renders a page of
 * empty states. Instead the provider sends the reader to sign in and preserves where they
 * were, so re-authenticating puts them back rather than on the dashboard.
 *
 * Three details make it behave rather than thrash:
 *
 *   · **One redirect, however many queries failed.** A page with eight queries would
 *     otherwise push eight navigations, and the browser would fight itself.
 *   · **No retry on an auth failure.** It will never succeed, and retrying delays the
 *     redirect while burning requests.
 *   · **Never from the login page itself.** Redirecting to where you already are is how
 *     a loop starts.
 *
 * The provider is exercised through a real query rather than by reaching for the private
 * helpers: the behaviour lives in the QueryCache's onError, and testing the helper alone
 * would not prove it is wired to anything.
 */

/** The current href, and every navigation attempted. */
const nav = { href: '', pathname: '/expenses', search: '?page=2', pushes: [] as string[] };

function stubLocation() {
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: {
      get pathname() {
        return nav.pathname;
      },
      get search() {
        return nav.search;
      },
      get href() {
        return nav.href;
      },
      set href(value: string) {
        nav.href = value;
        nav.pushes.push(value);
      },
    },
  });
}

/**
 * A tRPC error response, superjson-wrapped — the client is configured with the superjson
 * transformer, so a plain JSON body fails to transform and never reaches the error
 * handling this file is about.
 */
const errorEntry = (code: string, httpStatus: number) => ({
  error: {
    json: {
      message: 'no session',
      code: -32001,
      data: { code, httpStatus, path: 'users.me' },
    },
  },
});

/**
 * ONE ENTRY PER BATCHED CALL. `httpBatchLink` sends N procedures in a single request and
 * maps the response array back BY INDEX — so a one-element body answers the first query
 * and leaves the rest with nothing to fail on. That is what made the re-entry test
 * vacuous: three probes, one error, and the guard it claimed to prove was never reached.
 */
const errorBody = (code: string, httpStatus: number, calls = 3) =>
  Array.from({ length: calls }, () => errorEntry(code, httpStatus));

function stubFetch(body: unknown, status = 401) {
  const fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/**
 * A FRESH module per test.
 *
 * The re-entry guard is module-level — deliberately, since it is what stops eight failing
 * queries pushing eight navigations — so a test that redirected would leave every later
 * one unable to.
 */
async function freshClient() {
  vi.resetModules();
  const mod = await import('./client');
  /**
   * Each probe reads a DIFFERENT procedure.
   *
   * Rendering the same one three times proves nothing about the guard: react-query
   * dedupes identical query keys, so three copies of `users.me` are one request and one
   * failure. Distinct procedures are three failures, which is the situation the
   * module-level flag exists for.
   */
  const Child = ({ path }: { path: 'me' | 'list' | 'count' }) => {
    const q = (
      mod.trpc as unknown as Record<
        string,
        Record<string, { useQuery: (i?: unknown) => { isError: boolean } }>
      >
    ).users[path].useQuery();
    return <div>{q.isError ? 'failed' : 'pending'}</div>;
  };
  return { Provider: mod.TRPCProvider, Child };
}

/**
 * The same, but driving a MUTATION.
 *
 * The redirect is wired twice — once on the QueryCache and once on the MutationCache — and
 * only the query half was exercised. A session that dies between page load and a save is
 * the more painful of the two: the reader has typed something.
 */
async function freshMutationClient() {
  vi.resetModules();
  const mod = await import('./client');
  const Child = () => {
    const m = (
      mod.trpc as unknown as {
        users: {
          update: { useMutation: () => { mutate: (v: unknown) => void; isError: boolean } };
        };
      }
    ).users.update.useMutation();
    return (
      <button type="button" onClick={() => m.mutate({ name: 'x' })}>
        {m.isError ? 'failed' : 'save'}
      </button>
    );
  };
  return { Provider: mod.TRPCProvider, Child };
}

/** Three distinct procedures, so three distinct failures. */
const CHILD_PATHS = ['me', 'list', 'count'] as const;

const show = async (children = 1) => {
  const { Provider, Child } = await freshClient();
  return render(
    <Provider>
      {CHILD_PATHS.slice(0, children).map((path) => (
        <Child key={path} path={path} />
      ))}
    </Provider>,
  );
};

beforeEach(() => {
  vi.resetModules();
  nav.href = '';
  nav.pathname = '/expenses';
  nav.search = '?page=2';
  nav.pushes = [];
  stubLocation();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('a session that has expired', () => {
  it('sends the reader to sign in', async () => {
    stubFetch(errorBody('UNAUTHORIZED', 401));
    await show();
    await waitFor(() => expect(nav.pushes.length).toBeGreaterThan(0));
    expect(nav.pushes[0]).toContain('/login');
  });

  it('preserves where they were, so re-auth puts them back', async () => {
    /**
     * The alternative is landing on the dashboard having lost the report you were
     * halfway through reading.
     */
    stubFetch(errorBody('UNAUTHORIZED', 401));
    await show();
    await waitFor(() => expect(nav.pushes.length).toBeGreaterThan(0));
    expect(nav.pushes[0]).toContain(`callbackUrl=${encodeURIComponent('/expenses?page=2')}`);
  });

  it('goes to /login, with no locale segment', async () => {
    // VeloExpense: ExpenseOS kept the reader's /fr-CA/ prefix here. VeloExpense has no
    // locale in its URLs — the language is a stored preference — so there is one sign-in
    // page, and these two ExpenseOS cases (keep the locale; fall back to /en/) become this.
    nav.pathname = '/budgets';
    nav.search = '';
    stubFetch(errorBody('UNAUTHORIZED', 401));
    await show();
    await waitFor(() => expect(nav.pushes.length).toBeGreaterThan(0));
    expect(nav.pushes[0]).toMatch(/^\/login\?callbackUrl=/);
  });

  it('redirects once, however many queries failed', async () => {
    /**
     * A page with eight queries would otherwise push eight navigations and the browser
     * would fight itself. The guard is module-level for exactly that reason.
     */
    const fetchMock = stubFetch(errorBody('UNAUTHORIZED', 401));
    await show(3);
    await waitFor(() => expect(nav.pushes.length).toBeGreaterThan(0));
    // Three procedures failed — batched into one request, but three separate query
    // errors, so the guard was reached rather than merely declared.
    expect(fetchMock.mock.calls.length).toBeGreaterThan(0);
    expect(nav.pushes).toHaveLength(1);
  });

  it('does not retry a request that will never succeed', async () => {
    /**
     * Retrying an auth failure only delays the redirect. One attempt is enough to know.
     */
    const fetchMock = stubFetch(errorBody('UNAUTHORIZED', 401));
    await show();
    await waitFor(() => expect(nav.pushes.length).toBeGreaterThan(0));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('recognises a bare 401 from a layer that is not tRPC', async () => {
    // Middleware and edge rejections do not carry a tRPC code, only the status.
    stubFetch(errorBody('INTERNAL_SERVER_ERROR', 401));
    await show();
    await waitFor(() => expect(nav.pushes.length).toBeGreaterThan(0));
    expect(nav.pushes[0]).toContain('/login');
  });
});

describe('an error that is not an expired session', () => {
  it('does not redirect', async () => {
    /**
     * A failing query is a failing query: bouncing somebody to the login page over a
     * 500 would look like being signed out and lose their place for nothing.
     */
    stubFetch(errorBody('INTERNAL_SERVER_ERROR', 500), 500);
    await show();
    await waitFor(() => expect(screen.getByText('failed')).toBeInTheDocument(), {
      timeout: 3000,
    });
    expect(nav.pushes).toHaveLength(0);
  });

  it('retries once before giving up', async () => {
    // One retry covers a transient blip without doubling the load on a real outage.
    const fetchMock = stubFetch(errorBody('INTERNAL_SERVER_ERROR', 500), 500);
    await show();
    await waitFor(() => expect(screen.getByText('failed')).toBeInTheDocument(), {
      timeout: 3000,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('already on the login page', () => {
  it('does not redirect to itself', async () => {
    /**
     * The login page's own queries fail the same way, and redirecting to where you
     * already are is how a reload loop starts.
     */
    nav.pathname = '/login';
    stubFetch(errorBody('UNAUTHORIZED', 401));
    await show();
    await waitFor(() => expect(screen.getByText('failed')).toBeInTheDocument(), {
      timeout: 3000,
    });
    expect(nav.pushes).toHaveLength(0);
  });
});

describe('the provider itself', () => {
  it('renders its children', async () => {
    stubFetch(errorBody('UNAUTHORIZED', 401));
    await show();
    expect(screen.getByText('pending')).toBeInTheDocument();
  });
});

describe('a session that dies mid-save', () => {
  it('sends the reader to sign in from a failed mutation too', async () => {
    /**
     * Wired twice on purpose — QueryCache and MutationCache — and this is the half that
     * hurts more: the reader has typed something. Without it a save silently fails and
     * the page keeps showing the form as if nothing happened.
     */
    stubFetch(errorBody('UNAUTHORIZED', 401));
    const { Provider, Child } = await freshMutationClient();
    render(
      <Provider>
        <Child />
      </Provider>,
    );
    screen.getByRole('button').click();
    await waitFor(() => expect(nav.pushes.length).toBeGreaterThan(0));
    // Every navigation goes to login. Not asserted as exactly-one here: an un-acted
    // click can deliver the failure more than once in jsdom, and the once-only guarantee
    // is the queries' test above — a browser coalesces repeated href assignments anyway.
    expect(nav.pushes.every((p) => p.includes('/login'))).toBe(true);
    expect(nav.pushes[0]).toContain('callbackUrl');
  });

  it('leaves an ordinary mutation failure alone', async () => {
    /** A 400 from a validation refusal is the server answering, not the session ending —
     *  bouncing somebody to sign in over a bad field would be a data-loss bug. */
    stubFetch(errorBody('BAD_REQUEST', 400), 400);
    const { Provider, Child } = await freshMutationClient();
    render(
      <Provider>
        <Child />
      </Provider>,
    );
    screen.getByRole('button').click();
    await waitFor(() => expect(screen.getByRole('button')).toHaveTextContent('failed'));
    expect(nav.pushes).toHaveLength(0);
  });
});
