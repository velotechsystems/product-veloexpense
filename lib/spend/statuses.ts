/**
 * WHICH REPORT STATUSES COUNT AS SPEND — one statement, two consumers.
 *
 * PURE. No `pg`, no imports beyond the status type.
 *
 * ── Why this is its own module ──────────────────────────────────────────────
 *
 * AN-7's most useful sentence is not about FX. It is *"the two halves of the same
 * product disagree about whether an unconvertible amount is reportable"* — their
 * analytics silently coerced it while their budget code counted it separately,
 * because each half decided for itself. The same split was one copy away from
 * happening here: `lib/budgets/service.ts` had a private `COUNTED` array, and
 * VX4-6's analytics needed the same answer.
 *
 * PE-8 is the other precedent — *"two copies of a query is how they became two
 * copies of a bad default"* — so the answer lives in one place that both import,
 * and `test/spend-statuses.test.ts` asserts the buckets actually partition the
 * counted set rather than merely looking like they do.
 *
 * ── The two buckets, and why COMMITTED excludes SUBMITTED ───────────────────
 *
 * A submitted report is a claim somebody has made, not money the company has
 * agreed to. It belongs in a separate figure — which is exactly what
 * `budget_period.pending_minor` is, and what lets a budget say "you are within
 * budget unless everything in flight is approved". Analytics reports both for the
 * same reason: one number cannot say that sentence.
 *
 * DRAFT, REJECTED and RETURNED are not spend in either bucket. A draft has not
 * been claimed; a rejected or returned report has been claimed and refused.
 */
import type { ReportStatus } from '@/lib/expenses/service';

/** APPROVED and beyond: the company has agreed to it. */
export const COMMITTED_STATUSES = ['APPROVED', 'REIMBURSED'] as const satisfies readonly ReportStatus[];

/** Claimed, not yet decided. */
export const PENDING_STATUSES = ['SUBMITTED'] as const satisfies readonly ReportStatus[];

/**
 * Everything that counts at all. The union of the two buckets, derived rather
 * than retyped — a third hand-written list is the drift this module exists to
 * prevent.
 */
export const COUNTED_STATUSES: readonly ReportStatus[] = [
  ...PENDING_STATUSES,
  ...COMMITTED_STATUSES,
];

/** Which bucket a status falls in, or null when it is not spend. */
export function spendBucketOf(status: string): 'COMMITTED' | 'PENDING' | null {
  if ((COMMITTED_STATUSES as readonly string[]).includes(status)) return 'COMMITTED';
  if ((PENDING_STATUSES as readonly string[]).includes(status)) return 'PENDING';
  return null;
}
