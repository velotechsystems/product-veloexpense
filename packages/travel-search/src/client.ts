/**
 * The SerpApi seam.
 *
 * Everything in this package runs SERVER-SIDE. SerpApi bills per search and the
 * key is a spending credential, so it never reaches the browser — the same rule
 * the Maps integration follows, for the same reason.
 *
 * One `get` for all four engines because they share a host, an auth parameter and
 * an error envelope. What differs is the `engine` value and the response shape,
 * and those live in the modules that own them.
 *
 * ON COST. Every call here is money. That shapes the design more than anything
 * else: `search` takes an injectable `fetch` so tests never spend, callers pass a
 * `signal` so an abandoned form doesn't pay for a result nobody reads, and the
 * travel module caches what it gets onto the request rather than re-querying to
 * re-render. A search is treated as a purchase, not as a read.
 */

/** No API key configured — the caller degrades to manual entry. */
export class TravelSearchUnavailableError extends Error {}
/** SerpApi answered, and said no. `status` is the HTTP status when there was one. */
export class TravelSearchError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'TravelSearchError';
  }
}

const ENDPOINT = 'https://serpapi.com/search.json';
/** A traveller filling in a form will not wait longer than this, and a request
 *  they have abandoned is a search we paid for and threw away. */
const TIMEOUT_MS = 12_000;

export interface SerpApiConfig {
  apiKey: string;
  /** Default localisation for every engine. `gl` biases results by country, `hl`
   *  picks the language; both are the SerpApi parameter names verbatim. */
  gl?: string;
  hl?: string;
  /** ISO-4217 the provider should price in. Quotes are stored in this currency. */
  currency?: string;
}

/** The `fetch` shape this package needs — narrow enough that a test can supply
 *  three lines instead of a whole polyfill. */
export type FetchLike = (
  url: string,
  init?: { signal?: AbortSignal; headers?: Record<string, string> },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>;

export interface SearchOptions {
  fetchImpl?: FetchLike;
  /** Caller's cancellation — an abandoned form should stop paying. */
  signal?: AbortSignal;
}

/**
 * Run one SerpApi search.
 *
 * `params` are passed through verbatim, so the caller reads as the documented API
 * rather than as our re-spelling of it: a reader comparing this with SerpApi's
 * docs should not have to translate. Undefined and empty values are dropped so an
 * absent filter is absent rather than sent as the string "undefined".
 */
export async function serpApiSearch(
  config: SerpApiConfig,
  params: Record<string, string | number | boolean | undefined>,
  opts: SearchOptions = {},
): Promise<Record<string, unknown>> {
  const key = config.apiKey?.trim();
  if (!key) throw new TravelSearchUnavailableError('SerpApi key is not configured');

  const query = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    query.set(k, String(v));
  }
  query.set('api_key', key);

  const doFetch = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  // Either the caller's cancellation or our timeout ends the request.
  const onAbort = () => controller.abort();
  opts.signal?.addEventListener('abort', onAbort);

  try {
    const res = await doFetch(`${ENDPOINT}?${query.toString()}`, { signal: controller.signal });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new TravelSearchError(
        `SerpApi ${res.status}: ${serpApiMessage(body) ?? body.slice(0, 200)}`,
        res.status,
      );
    }
    const json = (await res.json()) as Record<string, unknown>;
    // SerpApi reports business failures in a 200 body, so an `error` field is a
    // failure even though the transport succeeded — EXCEPT when it is telling us the
    // search simply matched nothing, which is an answer. See `isNoResultsMessage`.
    const err = typeof json.error === 'string' ? json.error : null;
    if (err && !isNoResultsMessage(err))
      throw new TravelSearchError(`SerpApi: ${err.slice(0, 200)}`);
    return json;
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * Did the provider find nothing, as opposed to fail?
 *
 * SerpApi answers an empty search with HTTP 200 and an `error` string —
 * "Google Flights hasn't returned any results for this query." — which is the same
 * envelope it uses for a rejected key or a malformed parameter. Treating the whole
 * envelope as a failure turned "there are no flights on this route" into a thrown
 * error, and the traveller was told "Live prices could not be fetched… try again
 * later" about a route where trying again can never help.
 *
 * Observed on dev for Orlando → Napa: APC has no scheduled service, so the engine
 * correctly returns nothing, and the caller reported a provider outage.
 *
 * Matched narrowly on the sentence the engines share, so a real error is still an
 * error. Callers get an ordinary payload with no results in it, and the normalizers
 * turn that into an empty list — which the travel module already reports honestly as
 * "no flights or stays were found for these dates".
 */
export function isNoResultsMessage(message: string): boolean {
  // Both apostrophe forms: the engines send U+0027 today, and a message that switched to
  // the typographic U+2019 would silently turn every empty search back into an outage.
  return /hasn[\u0027\u2019]?t returned any results/i.test(message);
}

/** SerpApi puts the reason in `error`; anything else is HTML or a proxy page. */
export function serpApiMessage(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { error?: unknown };
    return typeof parsed.error === 'string' && parsed.error.trim()
      ? parsed.error.slice(0, 200)
      : null;
  } catch {
    return null;
  }
}

/**
 * Which of the failures that actually happen is this?
 *
 * A code rather than a sentence, because two callers need the same classification for
 * different audiences: Test Connection renders English prose for an admin who just
 * pressed it, and the travel quote has to tell a traveller — in their own locale, from
 * an i18n catalog — why the price fetch came back empty. Deriving both from one
 * classifier is what stops the two answers from disagreeing about the same error.
 *
 * `UNKNOWN` is a real outcome, not a fallback for laziness: a provider can fail in ways
 * nobody has seen yet, and claiming to know which one would be worse than saying so.
 */
export type SerpApiFailureKind = 'KEY_REJECTED' | 'PLAN_EXHAUSTED' | 'BAD_REQUEST' | 'UNKNOWN';

export function serpApiFailureKind(
  status: number | undefined,
  message: string,
): SerpApiFailureKind {
  const text = message.toLowerCase();
  if (text.includes('invalid api key') || status === 401) return 'KEY_REJECTED';
  if (text.includes('run out of searches') || text.includes('exceeded') || status === 429) {
    return 'PLAN_EXHAUSTED';
  }
  if (text.includes('missing') || text.includes('unsupported') || status === 400) {
    return 'BAD_REQUEST';
  }
  return 'UNKNOWN';
}

/**
 * What to actually DO about a SerpApi rejection.
 *
 * Same reasoning as the Maps remedies: the provider's message is accurate and
 * says nothing about which setting is wrong. These are the three that actually
 * happen — a bad key, an exhausted plan, and a parameter the engine rejected.
 *
 * English, and deliberately so: the only caller is Test Connection, which an admin
 * presses and reads immediately. A traveller-facing surface must go through the i18n
 * catalog instead — take {@link serpApiFailureKind} and translate the code.
 */
export function serpApiRemedy(status: number | undefined, message: string): string | null {
  switch (serpApiFailureKind(status, message)) {
    case 'KEY_REJECTED':
      return 'The SerpApi key was rejected — check it was pasted whole under Admin → Integrations → SerpApi.';
    case 'PLAN_EXHAUSTED':
      return 'The SerpApi plan has no searches left this cycle. Travel pricing falls back to manual entry until it resets.';
    case 'BAD_REQUEST':
      return 'SerpApi rejected the search parameters — this is a bug on our side, not a configuration problem.';
    default:
      return null;
  }
}
