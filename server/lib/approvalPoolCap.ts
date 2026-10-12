/**
 * A bound on how much of an approval pool a single inbox load will MATERIALIZE,
 * and — the part that matters — a signal when it bites.
 *
 * The distinction is deliberate and was argued over. A bound on VISIBILITY (a
 * small `take`, no signal) silently drops claimable work: an approver never
 * learns that a task exists, it lapses on its TTL, and the auto-reject is
 * indistinguishable from a decision somebody made. What this is instead is a
 * bound on MATERIALIZATION that is reported to the caller (`capped: true` on the
 * response, so the inbox can say so) and reported to operations (this warn, which
 * a CloudWatch metric filter turns into an alarmed metric — see
 * `infrastructure/cdk/lib/observability-stack.ts`).
 *
 * VeloExpense (w4-00c): ported unchanged. VeloExpense has no observability stack yet, so the
 * metric filter and its alarm do not exist here: the warn line is written and nothing pages
 * on it. That gap is a flag on the tracker, not something this file can close.
 *
 * THE METRIC IS THE CONTROL; `capped` IS ONLY THE RECEIPT. Above the cap, a queue
 * is being worked FIFO with a tail nobody can see, which is a real starvation
 * hazard — instrumented, not fixed. Shipping the counter without an alert on it
 * would amount to writing the bug down and filing it. If you raise, lower, or
 * remove the cap, keep the alarm.
 *
 * Not throttled, on purpose: every approver's load that trips it emits a line, so
 * the metric is a RATE that reflects how many people are actually looking at a
 * truncated queue rather than a single latched "it happened once".
 */

/** How many rows one pool may materialize. Query with `APPROVAL_POOL_CAP + 1` and
 *  treat the extra row as "there is more" — a `take` equal to the cap cannot tell
 *  a full page from an overflowing one. */
export const APPROVAL_POOL_CAP = 5000;

/**
 * The literal a CloudWatch metric filter matches on. It is duplicated in
 * `infrastructure/cdk/lib/observability-stack.ts` as a filter pattern, because a
 * log-derived metric has no other way to be coupled; `observability-stack.test.ts`
 * asserts the two still agree, so a rename breaks a test rather than the alarm.
 */
export const APPROVAL_POOL_CAPPED_METRIC = 'APPROVAL_POOL_CAPPED';

/** Truncate an over-cap pool, telling both the caller and operations that it did.
 *  `rows` is expected to have been read with `take: APPROVAL_POOL_CAP + 1`. */
export function capApprovalPool<T>(
  pool: string,
  subjectType: string,
  actorId: string,
  rows: T[],
): { rows: T[]; capped: boolean } {
  if (rows.length <= APPROVAL_POOL_CAP) return { rows, capped: false };
  // `seen` is a floor, not a count — the query stopped looking at cap + 1.
  console.warn(
    `[approvals] ${APPROVAL_POOL_CAPPED_METRIC} pool=${pool} subjectType=${subjectType} ` +
      `actorId=${actorId} cap=${APPROVAL_POOL_CAP} seen=>${APPROVAL_POOL_CAP} ` +
      `— the inbox is showing a prefix of this queue`,
  );
  return { rows: rows.slice(0, APPROVAL_POOL_CAP), capped: true };
}
