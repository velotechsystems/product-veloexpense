/**
 * The two numeric caps this product can actually count — `maxUsers` and
 * `expensesPerYear` — enforced where the thing they count is created.
 *
 * ── WHY THIS FILE EXISTS ───────────────────────────────────────────────────
 *
 * `capIsEnforced()` answered `true` for both of these from the day #124 parsed
 * them, and nothing anywhere refused on either. A tenant on a 5-seat plan could
 * accept a sixth, a sixtieth, a six-hundredth invitation. The function a screen
 * would ask "is this limit real?" said yes about a limit no code kept. That is
 * the defect shape this project tracks — an instrument reporting success about
 * something it does not observe — and it was in the billing layer, where the
 * customer and we both believed the ceiling was there.
 *
 * `test/plan-entitlement.test.ts` now guards the other direction too: a cap that
 * `capIsEnforced` claims must have a `withinCap(…, '<cap>', …)` call site in
 * `lib/`, so this cannot silently happen again.
 *
 * ── WHERE THE CHECKS SIT ───────────────────────────────────────────────────
 *
 *   · SEATS: `createEmployee` (the only place an `app_user` row is created after
 *     a tenant exists — every invitation acceptance arrives there) and the
 *     reactivation branch of `updateEmployee`, because the seat counter
 *     (`lib/billing/metering.ts`) counts rows with `deleted_at IS NULL`, and
 *     reactivating clears it. A cap enforced on creation alone is walked round
 *     by deactivating somebody and reactivating them later.
 *   · EXPENSES: `addExpense`, the only `INSERT INTO expense` in the product.
 *
 * Provisioning's founder row (`lib/onboarding/provision.ts`) is deliberately NOT
 * checked: it runs before the platform has mirrored any plan, and a tenant
 * cannot be refused its first seat.
 *
 * ── ABSENT AND UNLIMITED PERMIT, AND COST NOTHING ──────────────────────────
 *
 * No mirrored subscription, a plan that never sent `limits`, a cap that is
 * absent or `null`: all permit, per `plan-entitlement.ts`'s contract (fail open
 * on what we were told). That is most tenants today, so the plan is read FIRST
 * and nothing is locked or counted unless a number is actually in force.
 *
 * ── WHY THE ORGANIZATION ROW IS LOCKED ─────────────────────────────────────
 *
 * Count-then-insert under READ COMMITTED lets two acceptances at 4-of-5 both
 * count four and both insert: six seats on a five-seat plan. The count runs under
 * a lock on this tenant's `organization` row — the same row `createReport` locks
 * for its numbering — so additions to one tenant serialize at the check and the
 * second sees the first. Only when a cap is in force; an unlimited tenant takes
 * no lock here at all.
 */
import type { QueryRunner } from '@/lib/db/client';
import { DomainError } from '@/lib/errors/domain';
import { liveSubscription } from '@/lib/billing/service';
import { withinCap, type Cap, type PlanEntitlement } from '@/lib/billing/plan-entitlement';
import { ORG } from '@/lib/tenant/sql';

export type CapReachedCode = 'SEAT_LIMIT_REACHED' | 'EXPENSE_LIMIT_REACHED';

/** A refusal that names the limit, so the person reading it knows what it is. */
export class CapReachedError extends DomainError {
  constructor(
    readonly cap: Cap,
    readonly limit: number,
    readonly code: CapReachedCode,
  ) {
    super(`plan limit reached: ${cap} is ${limit}`, { code, params: { limit } });
    this.name = 'CapReachedError';
  }
}

/** The plan and the cap's number, or null when the plan does not limit it. */
async function limitInForce(
  tx: QueryRunner,
  cap: Cap,
): Promise<{ plan: PlanEntitlement; limit: number } | null> {
  const sub = await liveSubscription(tx);
  if (sub === null) return null;
  const value = sub.plan.caps[cap];
  return typeof value === 'number' ? { plan: sub.plan, limit: value } : null;
}

async function lockTenant(tx: QueryRunner): Promise<void> {
  await tx.query(`SELECT id FROM organization WHERE id = ${ORG} FOR UPDATE`);
}

/**
 * Refuse a NEW seat when the plan's `maxUsers` is already used up. Call before
 * inserting, or before clearing `deleted_at`.
 */
export async function assertSeatAvailable(tx: QueryRunner): Promise<void> {
  const inForce = await limitInForce(tx, 'maxUsers');
  if (inForce === null) return;
  await lockTenant(tx);
  // The same predicate as the SEAT meter in `lib/billing/metering.ts`, so the
  // number refused on here is the number billed on.
  const r = await tx.query(
    `SELECT count(*)::int AS n FROM app_user WHERE organization_id = ${ORG} AND deleted_at IS NULL`,
  );
  const after = (r.rows[0].n as number) + 1;
  if (!withinCap(inForce.plan, 'maxUsers', after)) {
    throw new CapReachedError('maxUsers', inForce.limit, 'SEAT_LIMIT_REACHED');
  }
}

/**
 * Refuse a NEW expense when the plan's `expensesPerYear` is already used up.
 *
 * "Per year" is ROLLING — the last 365 days, matching the cap's declaration in
 * `plan-entitlement.ts` — not the calendar year, so nobody gets a second
 * allowance on 1 January. An expense that is DELETED stops counting: the cap is
 * on what a tenant keeps, and a counter of creations would charge somebody for a
 * line they typed and removed.
 */
export async function assertExpenseAllowance(tx: QueryRunner, adding = 1): Promise<void> {
  const inForce = await limitInForce(tx, 'expensesPerYear');
  if (inForce === null) return;
  await lockTenant(tx);
  const r = await tx.query(
    `SELECT count(*)::int AS n FROM expense
      WHERE organization_id = ${ORG} AND created_at > now() - interval '365 days'`,
  );
  // `adding` (Wave 2, w2-09): a report filed from N receipts creates N expenses at once,
  // so the cap is checked against all of them before any is written.
  const after = (r.rows[0].n as number) + adding;
  if (!withinCap(inForce.plan, 'expensesPerYear', after)) {
    throw new CapReachedError('expensesPerYear', inForce.limit, 'EXPENSE_LIMIT_REACHED');
  }
}
