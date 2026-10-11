/**
 * When to re-poll GuardDuty for a malware-scan verdict.
 *
 * A module of its own, with no imports, because `extract-core` pulls in
 * `@expenseos/db` — which constructs a Prisma client at module load and throws
 * without `DATABASE_URL`. Anything importable from a hermetic unit test has to
 * live outside that graph.
 */

/**
 * Delay before the next re-poll, by attempt number (0-based).
 *
 * This used to be a flat 20s, which put a **20-second floor under every
 * extraction** — because attempt 0 can never find the tag. The object is written
 * and the job runs milliseconds later; GuardDuty has not scanned it yet, so
 * attempt 0 is structurally guaranteed to miss and the FIRST re-poll delay is the
 * latency every user actually experiences. Measured on dev before this change:
 * attempt 0 returned in 0.24s, the re-poll completed at 30.57s.
 *
 * That latency was not academic. It cost a UAT session: a tester uploaded a
 * receipt, saw nothing appear, deleted the expense 64 seconds later and re-typed
 * it by hand — while the extraction it was waiting on had succeeded at t+31s. The
 * data was there and arrived too late to be believed.
 *
 * GuardDuty usually tags a small object within a few seconds, so the schedule
 * front-loads and most receipts now resolve on the 1s or 2s poll. It widens after
 * that because a scan still pending at 8s is queued behind something, and polling
 * `GetObjectTagging` every second for five minutes is just cost.
 */
const SCAN_POLL_SCHEDULE_MS = [1_000, 2_000, 3_000, 5_000, 8_000, 13_000] as const;

/** Steady-state cadence once the front-loaded schedule is exhausted. Fixed rather
 *  than exponential so the tail stays inside a predictable budget. */
const SCAN_POLL_MAX_DELAY_MS = 20_000;

export function scanPollDelayMs(attempt: number): number {
  return SCAN_POLL_SCHEDULE_MS[attempt] ?? SCAN_POLL_MAX_DELAY_MS;
}

/**
 * Max re-polls before giving up. With the schedule above the budget is ~5 minutes
 * (32s front-loaded + 14 × 20s), matching the previous 15 × 20s — so a genuinely
 * slow scan is tolerated exactly as long as before. Only a FAST scan got faster.
 */
export const MAX_SCAN_ATTEMPTS = 20;
