/**
 * f31 — `check:ui-kit` rides out a registry blip, and still fails on a real answer.
 *
 * On 12 Oct (#206) GitHub Pages answered 503 for one kit item and the CI job failed; a re-run
 * passed. These pin the retry: transient failures (5xx, 429, a thrown fetch) are asked again
 * with a growing pause, a 404 is final at once, and the last failure is the one reported.
 */
import { describe, expect, it, vi } from 'vitest';
import { fetchJsonWithRetry, isTransient } from '../scripts/lib/fetch-retry.mjs';

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const status = (n: number) => ({ ok: false, status: n, json: async () => ({}) });

function scripted(...answers: Array<unknown | Error>) {
  const fetchImpl = vi.fn(async () => {
    const next = answers.shift();
    if (next instanceof Error) throw next;
    return next;
  });
  const sleep = vi.fn<(ms: number) => Promise<void>>(async () => {});
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls: fetchImpl, sleep };
}

describe('fetchJsonWithRetry', () => {
  it('returns the body on the first good answer', async () => {
    const s = scripted(ok({ a: 1 }));
    await expect(fetchJsonWithRetry('u', s)).resolves.toEqual({ a: 1 });
    expect(s.calls).toHaveBeenCalledTimes(1);
    expect(s.sleep).not.toHaveBeenCalled();
  });

  it('asks again after a 503 — the #206 blip — and succeeds', async () => {
    const s = scripted(status(503), ok({ a: 2 }));
    await expect(fetchJsonWithRetry('u', s)).resolves.toEqual({ a: 2 });
    expect(s.calls).toHaveBeenCalledTimes(2);
  });

  it('asks again after a thrown fetch (a timeout, a reset) and after a 429', async () => {
    const s = scripted(new Error('The operation was aborted due to timeout'), status(429), ok(3));
    await expect(fetchJsonWithRetry('u', s)).resolves.toBe(3);
    // A growing pause: the second wait is longer than the first.
    expect(s.sleep.mock.calls.map((c) => c[0])).toEqual([2000, 4000]);
  });

  it('gives up after three tries, reporting the last failure', async () => {
    const s = scripted(status(503), status(502), status(500));
    await expect(fetchJsonWithRetry('https://kit/r/x.json', s)).rejects.toThrow(
      'https://kit/r/x.json answered 500',
    );
    expect(s.calls).toHaveBeenCalledTimes(3);
    expect(s.sleep).toHaveBeenCalledTimes(2);
  });

  it('does not retry a 404: a missing item is an answer, said at once', async () => {
    const s = scripted(status(404), ok({}));
    await expect(fetchJsonWithRetry('u', s)).rejects.toThrow('u answered 404');
    expect(s.calls).toHaveBeenCalledTimes(1);
  });

  it('counts 429 and 5xx as transient, and nothing else', () => {
    expect([429, 500, 502, 503, 504, 599].every(isTransient)).toBe(true);
    expect([200, 400, 401, 403, 404, 410].some(isTransient)).toBe(false);
  });
});
