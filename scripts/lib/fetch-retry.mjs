/**
 * f31 — a registry read that survives a blip.
 *
 * `check:ui-kit` reads every vendored item from the kit's GitHub Pages registry. On 12 Oct
 * (#206) Pages answered 503 for one item and the whole CI job failed; a re-run passed. A
 * drift guard that fails on somebody else's outage teaches people to re-run red builds
 * without reading them, which is worse than the drift it guards against.
 *
 * So a TRANSIENT failure is retried: a 5xx, a 429, a timeout or a network error, up to
 * `attempts` times with a growing pause. A 4xx other than 429 is not retried — a missing item
 * is an answer, and asking again would only delay saying so. The last failure is thrown as
 * it was, so the check still names the item and the status.
 */

/** A status worth asking again about. */
export function isTransient(status) {
  return status === 429 || (status >= 500 && status <= 599);
}

/**
 * GET `url` as JSON, retrying a transient failure.
 *
 * @param {string} url
 * @param {{ attempts?: number, delayMs?: number, timeoutMs?: number,
 *           fetchImpl?: typeof fetch, sleep?: (ms: number) => Promise<void> }} [opts]
 */
export async function fetchJsonWithRetry(url, opts = {}) {
  const attempts = opts.attempts ?? 3;
  const delayMs = opts.delayMs ?? 2000;
  const timeoutMs = opts.timeoutMs ?? 15000;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  let last;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let res;
    try {
      res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      // Thrown by fetch itself — a timeout, a reset connection, DNS: worth another try.
      last = err;
      res = null;
    }
    if (res) {
      if (res.ok) return res.json();
      last = new Error(`${url} answered ${res.status}`);
      // A missing or refused item is an answer; only a transient status is asked again.
      if (!isTransient(res.status)) throw last;
    }
    if (attempt < attempts) await sleep(delayMs * attempt);
  }
  throw last;
}
