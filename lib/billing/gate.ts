/**
 * VX5-11 — the write gate. What a tenant that is not paying may no longer do.
 *
 * ── THE DECISION, AND WHERE I NARROWED IT ──────────────────────────────────
 *
 * John chose "read-only" over "locked out" on 6 Sep, and the option he chose was
 * described as: *they can sign in, read and export everything, but cannot submit,
 * approve or post*. This file implements THAT SENTENCE rather than the label
 * above it, and the difference is worth stating plainly because it is my
 * interpretation and not his instruction:
 *
 *   **A lapsed tenant can still edit DRAFTS.** Creating a report, adding an
 *   expense, coding a line — all still work. A strict reading of "read-only"
 *   would block them.
 *
 * Two reasons, and if either is wrong this is the paragraph to argue with. A
 * draft has no financial effect: nothing has been claimed, approved, posted or
 * paid, so refusing the keystroke protects nobody. And it means a team can keep
 * working while somebody in finance sorts out a card, then submit the backlog the
 * moment it clears — where blocking drafts would turn a billing lapse into lost
 * work, which is a much worse thing to do to a customer over an expired card than
 * to withhold a submit button.
 *
 * ── AND WHAT IS DELIBERATELY *NOT* GATED, BEYOND DRAFTS ────────────────────
 *
 * `recallReport`. A person withdrawing their own submission is undoing something,
 * not doing something, and a tenant that cannot recall would have reports frozen
 * mid-flight with no way to take them back. Refusing an undo is how a read-only
 * mode becomes a trap.
 *
 * Every READ, obviously — that is the whole point of read-only rather than locked
 * out, and it is what keeps the product on the right side of PIPEDA and GDPR,
 * under which a customer retains a right of access to their own data.
 *
 * ── ONE LIST, AND IT IS THE TEST'S INPUT TOO ───────────────────────────────
 *
 * `GATED_ACTIONS` is exported and `test/billing-gate.db.test.ts` drives every
 * member of it. That is deliberate: the failure mode for a gate like this is not
 * a wrong implementation, it is a NEW write path that nobody remembers to gate —
 * MT-3's "a gate at the edge is a gate the next caller forgets", which this
 * codebase has already paid for once in VX4-9, where the same admin predicate was
 * copy-pasted fifteen times and had begun to diverge.
 *
 * A list plus a test that iterates it does not stop somebody adding an ungated
 * path. Nothing at this layer can. What it does is make the gated set READABLE in
 * one place, so a reviewer asking "is the new endpoint covered" has somewhere to
 * look.
 */
import type { QueryRunner } from '@/lib/db/client';
import { DomainError } from '@/lib/errors/domain';
import { canWrite, canWriteWithoutSubscription } from '@/lib/billing/plans';
import { effectiveStatus } from '@/lib/billing/service';

/**
 * The write paths a lapsed tenant may not take.
 *
 * Named by what the PERSON is doing, not by the function — the string reaches a
 * test and a comment, not a user, and "submit a report" survives a rename of
 * `submitReport` where a function name would silently stop matching.
 */
export const GATED_ACTIONS = [
  'submit a report',
  'decide an approval',
  'mark a report reimbursed',
  'release a held post',
  'retry a failed post',
] as const;
export type GatedAction = (typeof GATED_ACTIONS)[number];

export class BillingLapsedError extends DomainError {
  constructor(readonly action: GatedAction) {
    super(`billing: this organization's subscription does not permit "${action}"`, 'BILLING_LAPSED');
    this.name = 'BillingLapsedError';
  }
}

/**
 * Refuse if this tenant's subscription does not permit writing.
 *
 * INSIDE the caller's transaction, taking its `tx`, so the check and the write it
 * guards see the same snapshot. A gate that opened its own connection could pass
 * against a subscription that the same transaction is about to change — narrow,
 * but this codebase has now been bitten twice by "true of one interleaving" and
 * the fix costs a parameter.
 *
 * NO SUBSCRIPTION IS PERMITTED, via `canWriteWithoutSubscription`, and that is the
 * single most important line here on the day this ships: every tenant created
 * before migration 0037 has no row, and the seeded fixtures have none either.
 * Answering "no" would take every existing customer offline on deploy — which is
 * the shape of failure that gets found by customers rather than by CI, because CI
 * builds its tenants after 0037.
 */
export async function assertTenantMayWrite(tx: QueryRunner, action: GatedAction): Promise<void> {
  // `effectiveStatus`, NOT `liveSubscription`, and the difference was a live bug
  // this file's own test caught: `liveSubscription` excludes CANCELLED rows, so a
  // customer who had cancelled looked like a tenant with no subscription — which
  // is the one absence that is deliberately permitted. They kept full write
  // access. `effectiveStatus` separates "never subscribed" from "left".
  const status = await effectiveStatus(tx);
  const permitted = status === null ? canWriteWithoutSubscription() : canWrite(status);
  if (!permitted) throw new BillingLapsedError(action);
}
