/**
 * VX3-4 — the retry policy shared by every outbox in this product.
 *
 * PURE. Extracted from `lib/notifications/outbox.ts` (VX2-8), which is now a
 * consumer rather than the owner.
 *
 * ── Why the POLICY is shared and the TABLES are not ─────────────────────────
 *
 * GAP-AUDIT AC-7 says VeloExpense should not build a second queue, and it is
 * right about the reason: VX2-8 already chose Postgres over Redis so that an
 * enqueue in the same transaction as the business change cannot be lost, which
 * removes the need for ExpenseOS's fire-and-forget trade AND the 30-minute cron
 * sweep that compensates for it. What AC-7 slightly overstated is that the same
 * TABLE should carry both: an email delivery and a ledger post have different
 * payloads, different terminal states, and different admin screens, and merging
 * them would mean a migration on working notification machinery in the same PR as
 * the first real adapter.
 *
 * So this file is the part that genuinely must not diverge — how long to wait,
 * how many times to try, when to give up, how long a claim is honoured. Two
 * outboxes that disagreed about those would be two operational behaviours to
 * learn, which is the actual cost AC-7 was pointing at.
 */

/**
 * Automatic attempts before a row is DEAD and a human owns it.
 *
 * Five, sized against a measured incident on the ExpenseOS side: their sweep
 * comment records "three reports at 46 attempts each — 138 guaranteed-to-fail
 * posts". Five gives a transient blip all the room it needs and caps a permanent
 * failure at five wasted calls.
 */
export const MAX_ATTEMPTS = 5;

/**
 * Backoff by attempt number, in seconds. Index 0 is unused (attempts start at 1).
 *
 * A table rather than a formula, because the shape matters more than the maths: a
 * minute for the blip, then widening fast enough that a real outage is not a load
 * generator. Past the end of the table the row is DEAD, so there is no cap to
 * choose.
 */
export const BACKOFF_SECONDS = [0, 60, 300, 900, 3600, 14400] as const;

/**
 * How long a claim is honoured before another poller may take the row.
 *
 * Longer than any plausible HTTP or SMTP timeout — work that is genuinely still
 * in flight must not be duplicated — and short enough that a crashed poller does
 * not strand a queue for an hour.
 */
export const CLAIM_TIMEOUT_SECONDS = 300;

/**
 * Seconds to wait before the attempt AFTER the one just failed.
 *
 * `attempts` is the count INCLUDING the failure that just happened, which is what
 * a row holds immediately after `attempts = attempts + 1`.
 */
export function backoffSecondsFor(attempts: number): number {
  const index = Math.max(1, Math.min(attempts, BACKOFF_SECONDS.length - 1));
  return BACKOFF_SECONDS[index];
}

/** Whether a row that has just failed has any automatic attempts left. */
export function isExhausted(attempts: number): boolean {
  return attempts >= MAX_ATTEMPTS;
}
