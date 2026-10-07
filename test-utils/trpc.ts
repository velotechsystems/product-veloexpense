import { vi } from 'vitest';

/**
 * Reusable tRPC client mock for component tests.
 *
 * The app's pages talk to `trpc` (`@/lib/trpc/client`) which is a real
 * `createTRPCReact` client backed by httpBatchLink — not usable in jsdom.
 * `createTrpcMock` returns a Proxy that mimics the call surface the pages
 * actually use (`trpc.<...path>.useQuery`, `.useMutation`, and
 * `trpc.useUtils()`), returning canned results so tests can drive every
 * loading / empty / error / populated / pending branch deterministically.
 *
 * Usage in a test file:
 *
 *   import { createTrpcMock } from '@/test-utils/trpc';
 *   const trpcState = { current: createTrpcMock({ queries: {...} }) };
 *   vi.mock('@/lib/trpc/client', () => ({ get trpc() { return trpcState.current; } }));
 *
 * then reassign `trpcState.current` per test in `beforeEach`.
 */

export interface QueryStub {
  data?: unknown;
  /**
   * Data derived from the query's input, for procedures whose answer genuinely
   * depends on what was asked.
   *
   * `data` alone returns the same canned value however the query is called, which
   * is fine for a list but not for a per-item read: the notification-template
   * drawer renders `preview({ versionId, locale })`, so a fixed stub makes "the
   * panel shows the version you picked, in both languages" unassertable — every
   * version and every language would come back identical.
   *
   * Takes precedence over `data` when both are set.
   */
  dataFor?: (...args: unknown[]) => unknown;
  isLoading?: boolean;
  isError?: boolean;
  error?: { message: string } | null;
  /**
   * Called with the query's arguments (input, then options).
   *
   * Pages that push their filters to the SERVER — a findings list, a paged table —
   * have no observable client-side result to assert, because this mock returns the
   * same canned rows whatever it is asked for. Without this, "the severity pill
   * narrows the query" is untestable, and a dropped filter argument looks identical
   * to a working one.
   */
  onCall?: (...args: unknown[]) => void;
}

export interface MutationStub {
  /** Called with the mutation's argument so tests can assert payloads. */
  onCall?: (...args: unknown[]) => void;
  /** Drives the lifecycle callback the component passed to useMutation. */
  outcome?: 'success' | 'error';
  /** Data handed to onSuccess (outcome:'success'). */
  data?: unknown;
  /** Error handed to onError (outcome:'error') and exposed as `.error`. `data` is the
   *  tRPC error payload — `{ refusal }` for a translatable refusal (`@/lib/trpc/refusal`). */
  error?: { message: string; data?: unknown } | null;
  isPending?: boolean;
  /**
   * Called when the component calls `mutation.reset()`.
   *
   * react-query's `reset` clears the MutationCache entry, and for a mutation whose RESULT
   * is a secret — an API token, shown once — calling it on dismiss is a security
   * requirement rather than tidiness: without it the plaintext sits in the cache until
   * `gcTime` elapses, five minutes after the panel that showed it has gone. A stub with no
   * `reset` at all made the component throw; one with a silent no-op made the requirement
   * unassertable.
   */
  onReset?: () => void;
}

export interface TrpcMockConfig {
  /** Keyed by dotted procedure path, e.g. `virtualCards.transactions.listAll`. */
  queries?: Record<string, QueryStub>;
  /** Keyed by dotted procedure path, e.g. `virtualCards.requests.decide`. */
  mutations?: Record<string, MutationStub>;
}

interface MutationOpts {
  onSuccess?: (data: unknown, vars: unknown) => void;
  /**
   * `vars` as well as the error, because react-query passes both — and a handler that
   * needs them is not exotic: a form saving one field per change has to know WHICH field
   * was refused in order to put it back. Omitting them here made such a handler throw
   * inside the harness on a path that works in the app.
   */
  onError?: (error: { message: string }, vars: unknown) => void;
}

/** A deep, callable proxy so `utils.a.b.invalidate()` resolves to a promise. */
function makeUtilsProxy(): unknown {
  const fn = () => Promise.resolve();
  return new Proxy(fn, {
    get: () => makeUtilsProxy(),
    apply: () => Promise.resolve(),
  });
}

export function createTrpcMock(config: TrpcMockConfig = {}): Record<string, unknown> {
  const utils = makeUtilsProxy();

  function build(path: string[]): unknown {
    // `() => {}` target makes the proxy callable — needed for `trpc.useUtils()`.
    const target = () => {};
    return new Proxy(target, {
      apply: () => utils, // trpc.useUtils()
      get(_t, prop) {
        if (typeof prop !== 'string') return undefined;

        if (prop === 'useQuery' || prop === 'useInfiniteQuery') {
          const key = path.join('.');
          return (...args: unknown[]) => {
            const stub = config.queries?.[key] ?? {};
            stub.onCall?.(...args);
            return {
              data: stub.dataFor ? stub.dataFor(...args) : stub.data,
              isLoading: stub.isLoading ?? false,
              isError: stub.isError ?? false,
              error: stub.error ?? null,
              isFetching: false,
              isFetchingNextPage: false,
              hasNextPage: false,
              fetchNextPage: vi.fn(),
              refetch: vi.fn(),
            };
          };
        }

        if (prop === 'useMutation') {
          const key = path.join('.');
          return (opts: MutationOpts = {}) => {
            const stub = config.mutations?.[key] ?? {};
            return {
              isPending: stub.isPending ?? false,
              error: stub.error ?? null,
              reset: () => stub.onReset?.(),
              // Derived rather than stubbed separately: react-query keeps the two in
              // step, and a stub that could set one without the other would let a test
              // assert an error banner against a hook that says it has no error.
              isError: (stub.error ?? null) != null,
              // Same model as `data` below: the stub describes a mutation that has
              // ALREADY returned. A component that only renders its confirmation after a
              // successful call is otherwise untestable here, because `mutate` cannot
              // trigger the re-render react-query's own state change would.
              isSuccess: stub.outcome === 'success' && (stub.error ?? null) == null,
              // The stub describes a mutation that has ALREADY returned this, which is
              // how a component reading `mutation.data` sees it — a probe result banner,
              // say. `mutate` here cannot re-render the way react-query's own state
              // change does, so exposing it only after a call would make that banner
              // unreachable rather than merely late.
              data: stub.data,
              // Honours the same stub as `mutate`, because a caller that awaits a
              // result cannot be tested against a bare vi.fn(): it resolves to
              // undefined, and any code destructuring the response (a presigned
              // upload, say) throws before the assertion is reached. Rejects when
              // the stub's outcome is 'error' so a failure path is reachable too.
              mutateAsync: async (...args: unknown[]) => {
                stub.onCall?.(...args);
                if (stub.outcome === 'error') {
                  // react-query fires the hook's `onError` AND rejects the promise. A
                  // page that reports the failure from `onError` (an alert, a banner)
                  // while merely awaiting the call is the common shape, so a harness
                  // that only rejected made that reporting untestable.
                  const err = stub.error ?? { message: 'error' };
                  opts.onError?.(err, args[0]);
                  throw err;
                }
                return stub.data;
              },
              mutate: (...args: unknown[]) => {
                stub.onCall?.(...args);
                // Both callback sites, because react-query has both and components use
                // both: options passed to `useMutation` (a shared error banner) and
                // options passed to this CALL (`mutate(vars, { onSuccess })`, which is how
                // a per-row action says what to refresh). A harness that only fired the
                // hook-level pair makes the second shape look like a no-op.
                const perCall = args[1] as MutationOpts | undefined;
                if (stub.outcome === 'success') {
                  opts.onSuccess?.(stub.data, args[0]);
                  perCall?.onSuccess?.(stub.data, args[0]);
                }
                if (stub.outcome === 'error') {
                  const err = stub.error ?? { message: 'error' };
                  opts.onError?.(err, args[0]);
                  perCall?.onError?.(err, args[0]);
                }
              },
            };
          };
        }

        return build([...path, prop]);
      },
    });
  }

  return build([]) as Record<string, unknown>;
}
