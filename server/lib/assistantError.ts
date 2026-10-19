/**
 * Why a turn died, in terms a person can act on.
 *
 * The chat route answers a stream, so once the first byte is out it cannot change its mind
 * and send a 503 — a failure has to arrive as an event inside the stream. It used to arrive
 * as `{ type: 'error' }` and nothing else, which the panel rendered as "Something went
 * wrong. Try asking again." That sentence is advice, and it is wrong advice for most of the
 * ways this fails: asking again does not fund an account, rotate a revoked key, or shorten
 * a conversation that no longer fits.
 *
 * What is NOT here is as deliberate as what is. The upstream error's own message never
 * reaches the client. It can carry request fragments, a key prefix, or a stack, and a chat
 * transcript is a place people paste into support tickets. This maps the error to one of a
 * closed set of REASONS; the client owns the sentence, so it is also the right language.
 */

/** The closed set. `unknown` is the honest answer, not the default one. */
export type TurnFailureReason =
  | 'overloaded'
  | 'rateLimited'
  | 'credential'
  | 'tooLong'
  | 'upstream'
  | 'network'
  | 'unknown';

/** The shape of an Anthropic SDK error, duck-typed.
 *
 *  Not `instanceof APIError`: this file is imported by the route, and pulling the SDK's
 *  class in for a type test would make the classifier depend on the transport it is
 *  describing. The two fields below are the SDK's public contract. */
interface ApiLikeError {
  status?: unknown;
  error?: { type?: unknown; message?: unknown } | null;
  name?: unknown;
  message?: unknown;
}

const BY_API_TYPE: Record<string, TurnFailureReason> = {
  overloaded_error: 'overloaded',
  rate_limit_error: 'rateLimited',
  authentication_error: 'credential',
  permission_error: 'credential',
  billing_error: 'credential',
  request_too_large: 'tooLong',
  api_error: 'upstream',
};

/**
 * Classify a thrown turn failure.
 *
 * Ordered by how specific the signal is: the API's own `error.type` first, then the HTTP
 * status, then the error name. A 400 is deliberately NOT `unknown` — an
 * `invalid_request_error` at this layer is almost always the transcript exceeding the
 * window, which is the one 400 a person can do something about.
 */
export function classifyTurnFailure(err: unknown): TurnFailureReason {
  if (err == null || typeof err !== 'object') return 'unknown';
  const e = err as ApiLikeError;

  const apiType = typeof e.error?.type === 'string' ? e.error.type : null;
  if (apiType && apiType in BY_API_TYPE) return BY_API_TYPE[apiType];

  const status = typeof e.status === 'number' ? e.status : null;
  if (status === 401 || status === 403) return 'credential';
  if (status === 429) return 'rateLimited';
  if (status === 529) return 'overloaded';
  if (status === 413) return 'tooLong';
  if (status === 400 && /context|token|too long|maximum/i.test(String(e.message ?? ''))) {
    return 'tooLong';
  }
  if (status !== null && status >= 500) return 'upstream';

  // `APIConnectionError` / `APIConnectionTimeoutError` from the SDK, and the bare
  // `TypeError: fetch failed` Node throws when the socket never opens.
  const name = typeof e.name === 'string' ? e.name : '';
  if (/connection|timeout/i.test(name)) return 'network';
  if (name === 'TypeError' && /fetch failed/i.test(String(e.message ?? ''))) return 'network';

  return 'unknown';
}

/**
 * A one-line server-side summary — and, for our OWN bugs, the stack.
 *
 * The log is the only place a failed turn is diagnosable, and "turn failed: [object
 * Object]" is what it produced before.
 *
 * The message is withheld from anything that came back from the API: an error body can
 * quote the request, and CloudWatch has a different retention and access regime than the
 * audit log. But an error with NO upstream provenance — no HTTP status, no API error type
 * — did not come from Anthropic. It is a TypeError in our own code, its message is our own
 * text, and withholding it means a real bug logs as `reason=unknown name=TypeError` and
 * nothing else. That is what happened: a broken tool call was undiagnosable from the log
 * it wrote.
 */
export function describeTurnFailure(err: unknown): string {
  const reason = classifyTurnFailure(err);
  if (err == null || typeof err !== 'object') return `reason=${reason}`;
  const e = err as ApiLikeError;
  const bits = [`reason=${reason}`];
  if (typeof e.status === 'number') bits.push(`status=${e.status}`);
  if (typeof e.error?.type === 'string') bits.push(`type=${e.error.type}`);
  if (typeof e.name === 'string' && e.name) bits.push(`name=${e.name}`);

  const fromUpstream = typeof e.status === 'number' || typeof e.error?.type === 'string';
  if (!fromUpstream) {
    // Ours. The stack is the whole point of the line.
    const stack = err instanceof Error ? (err.stack ?? err.message) : String(e.message ?? '');
    if (stack) bits.push(`\n${stack}`);
  }
  return bits.join(' ');
}
