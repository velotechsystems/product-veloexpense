import type { Page } from '@playwright/test';

/**
 * Calling a tRPC procedure as the signed-in person, from inside the browser.
 *
 * Two jobs, and neither of them is "drive the app faster".
 *
 *  · **The bypass.** A refusal that only exists as a disabled button is not a refusal —
 *    it is a suggestion. `expenses.submit` re-runs the whole policy evaluation server-side
 *    precisely so a crafted request cannot get past it, and the only way to test that
 *    claim is to craft the request. `expect(button).toBeDisabled()` proves the screen is
 *    polite; this proves the server is not.
 *  · **Reading what no screen renders.** `expenses.explainTax` and `expenses.explainPerDiem`
 *    have no UI consumer in `apps/web` — they exist for the assistant and for MCP clients.
 *    Their answers are still product behaviour a person receives (through the assistant),
 *    and they are the only place the engine says WHY, so they are asserted here directly.
 *
 * Run through `page.evaluate` rather than `request.post` on purpose: the fetch is
 * same-origin and therefore carries the NextAuth session cookie of whoever `signIn` last
 * adopted. An APIRequestContext has its own cookie jar, so the same call would arrive
 * unauthenticated and every assertion would collapse into UNAUTHORIZED — a green-looking
 * "the server refused" for entirely the wrong reason.
 *
 * Non-batched (`/api/trpc/<path>` with no `?batch=1`): the v11 fetch adapter reads the body
 * as one superjson payload, so the shape is `{ json: input }` in and `result.data.json` out.
 */

export interface TrpcResult<T = unknown> {
  /** HTTP status. 200 on success; tRPC maps its error codes onto real statuses. */
  status: number;
  /** The procedure's return value, superjson-unwrapped. Absent on failure. */
  data?: T;
  /** The refusal, when there is one. `code` is the TRPCError code, e.g. PRECONDITION_FAILED. */
  error?: { message: string; code: string };
}

/** POST a MUTATION and report the outcome. */
export async function trpcCall<T = unknown>(
  page: Page,
  path: string,
  input: unknown,
): Promise<TrpcResult<T>> {
  return page.evaluate(
    async ({ path, input }) => {
      const res = await fetch(`/api/trpc/${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ json: input }),
      });
      const body = (await res.json()) as {
        result?: { data?: { json?: unknown } };
        error?: { json?: { message?: string; data?: { code?: string } } };
      };
      const err = body.error?.json;
      return {
        status: res.status,
        data: body.result?.data?.json as T | undefined,
        error: err ? { message: err.message ?? '', code: err.data?.code ?? '' } : undefined,
      };
    },
    { path, input },
  );
}

/**
 * GET a QUERY.
 *
 * A separate function rather than a flag, because the adapter refuses the other verb
 * outright: POSTing a query answers `METHOD_NOT_SUPPORTED` with no data, which a caller
 * that only checks `data` reads as "the engine returned nothing" — an explain endpoint
 * that says nothing looks exactly like an explain endpoint that has nothing to say.
 */
export async function trpcQuery<T = unknown>(
  page: Page,
  path: string,
  input: unknown,
): Promise<TrpcResult<T>> {
  return page.evaluate(
    async ({ path, input }) => {
      const qs = `?input=${encodeURIComponent(JSON.stringify({ json: input }))}`;
      const res = await fetch(`/api/trpc/${path}${qs}`, { method: 'GET' });
      const body = (await res.json()) as {
        result?: { data?: { json?: unknown } };
        error?: { json?: { message?: string; data?: { code?: string } } };
      };
      const err = body.error?.json;
      return {
        status: res.status,
        data: body.result?.data?.json as T | undefined,
        error: err ? { message: err.message ?? '', code: err.data?.code ?? '' } : undefined,
      };
    },
    { path, input },
  );
}

/**
 * The same call, but a refusal is a test failure.
 *
 * For the setup steps — flipping a system flag, stamping a tax jurisdiction — where a
 * silent failure would otherwise surface much later as "the tax is zero", pointing at the
 * engine rather than at the setup that never happened.
 */
export async function trpcOk<T = unknown>(page: Page, path: string, input: unknown): Promise<T> {
  return demand(path, await trpcCall<T>(page, path, input));
}

/** `trpcQuery`, but a refusal is a test failure. */
export async function trpcQueryOk<T = unknown>(
  page: Page,
  path: string,
  input: unknown,
): Promise<T> {
  return demand(path, await trpcQuery<T>(page, path, input));
}

function demand<T>(path: string, out: TrpcResult<T>): T {
  if (out.error || out.data === undefined) {
    throw new Error(
      `${path} should have succeeded, but answered ${out.status} ${out.error?.code ?? ''} ${
        out.error?.message ?? '(no data)'
      }`,
    );
  }
  return out.data;
}
