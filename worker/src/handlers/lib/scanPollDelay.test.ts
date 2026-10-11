import { describe, expect, it } from 'vitest';
import { MAX_SCAN_ATTEMPTS, scanPollDelayMs } from './scanPolicy';

/**
 * The malware-scan re-poll schedule.
 *
 * Worth its own test because the number it produces is a number a person waits,
 * and the old value was wrong in a way nothing caught. Attempt 0 can NEVER find
 * the GuardDuty tag — the object was written milliseconds before the job ran — so
 * the FIRST re-poll delay is, in practice, the extraction latency every user
 * experiences. A flat 20s therefore meant no receipt could ever extract in under
 * 20 seconds.
 *
 * That cost a real UAT session: a receipt was uploaded, nothing appeared, the
 * expense was deleted 64 seconds later and retyped by hand — while the extraction
 * had succeeded at t+31s. So "the first poll is fast" is a product requirement,
 * not a preference, and it is pinned here.
 */

describe('scanPollDelayMs', () => {
  it('polls within a second on the first retry', () => {
    // The whole point. Attempt 0 always misses, so this delay IS the latency a
    // user sees on a receipt that scans promptly.
    expect(scanPollDelayMs(0)).toBeLessThanOrEqual(1_000);
  });

  it('reaches a second poll inside 5 seconds total', () => {
    // Two polls should still land well inside the window where somebody is
    // watching the upload rather than concluding it failed.
    expect(scanPollDelayMs(0) + scanPollDelayMs(1)).toBeLessThanOrEqual(5_000);
  });

  it('increases monotonically', () => {
    // A schedule that dips would poll harder the longer a scan takes, which is
    // backwards: a scan still pending at 10s is queued, not nearly done.
    for (let a = 1; a < MAX_SCAN_ATTEMPTS; a += 1) {
      expect(scanPollDelayMs(a), `attempt ${a}`).toBeGreaterThanOrEqual(scanPollDelayMs(a - 1));
    }
  });

  it('settles at a steady delay rather than growing without bound', () => {
    // Exponential backoff would push the tail past any sensible budget; the tail
    // is a fixed cadence.
    expect(scanPollDelayMs(MAX_SCAN_ATTEMPTS)).toBe(scanPollDelayMs(MAX_SCAN_ATTEMPTS + 50));
  });

  it('never returns zero or negative, which would busy-wait the queue', () => {
    for (let a = 0; a <= MAX_SCAN_ATTEMPTS + 5; a += 1) {
      expect(scanPollDelayMs(a), `attempt ${a}`).toBeGreaterThan(0);
    }
  });

  it('keeps a total budget of at least 4 minutes for a genuinely slow scan', () => {
    // The front-loading must not shorten how long a slow-but-real scan is
    // tolerated — that would turn a latency fix into a new failure mode
    // ('malware scan timed out' on a scan that would have completed).
    let total = 0;
    for (let a = 0; a < MAX_SCAN_ATTEMPTS; a += 1) total += scanPollDelayMs(a);
    expect(total).toBeGreaterThanOrEqual(4 * 60 * 1_000);
  });
});
