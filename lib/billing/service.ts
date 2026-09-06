/**
 * VX5-8 — the subscription, read and written.
 *
 * ── WHAT THIS TICKET DELIBERATELY DOES NOT DO ───────────────────────────────
 *
 * It does not gate a single write. `canWrite` lives in `plans.ts` and is tested
 * there, and nothing calls it yet, because putting a subscription check into every
 * submit, approve and post path is a diff across a dozen files that deserves its
 * own review rather than arriving as a footnote to a schema.
 *
 * That is the VX5-1 shape — ship the mechanism with nothing able to misuse it —
 * with one difference that matters: this one is NOT dead code. `startTrial` is
 * called from `createOrganization`'s transaction in this PR, so every tenant
 * created from today has a real subscription row and the shape is exercised by
 * the provisioning tests rather than only by its own.
 *
 * ── NO INVOICES, NO PAYMENTS, NO METER READINGS ────────────────────────────
 *
 * A provider owns the money (John, 6 Sep). An invoice table here would be a second
 * copy of somebody else's record, drifting from it — which is UD-9's defect in
 * another costume, and UD-9 turned up a THIRD hand-kept copy the audit had not
 * even listed. Readings land with VX5-9, because a table nothing writes is a table
 * whose shape nobody has tested.
 */
import { type QueryRunner } from '@/lib/db/client';
import { ORG } from '@/lib/tenant/sql';
import {
  canWrite,
  canWriteWithoutSubscription,
  type Meter,
  type SubscriptionStatus,
} from '@/lib/billing/plans';

export interface PlanComponent {
  meter: Meter;
  unitAmountMinor: bigint;
  includedUnits: number;
}

export interface Plan {
  code: string;
  name: string;
  active: boolean;
  period: 'MONTH' | 'YEAR';
  currencyCode: string;
  trialDays: number;
  components: PlanComponent[];
}

export interface Subscription {
  id: string;
  planCode: string;
  status: SubscriptionStatus;
  trialEndsAt: Date | null;
  currentPeriodStart: Date;
  currentPeriodEnd: Date | null;
  provider: string | null;
  cancelledAt: Date | null;
}

/**
 * The plan a brand-new tenant starts on.
 *
 * A constant rather than a column on `organization`, and rather than "the first
 * row by sort_order". The first-row version reads as flexible and is the worse
 * shape: reordering the catalogue for the pricing page would silently change what
 * every new customer gets, and nothing would fail.
 */
export const DEFAULT_PLAN_CODE = 'STARTER';

/**
 * The catalogue. Global reference data, so no tenant context is needed to read it
 * — `billing_plan` has no `organization_id` and no RLS, the same category as
 * `currency`.
 *
 * Inactive plans are returned when asked for, because a tenant sitting on a
 * withdrawn plan still has to be shown what it is paying for. AC-11's rule from
 * the chart of accounts: withdrawn deactivates, it does not disappear.
 */
export async function listPlans(
  tx: QueryRunner,
  opts: { includeInactive?: boolean } = {},
): Promise<Plan[]> {
  const plans = await tx.query(
    `SELECT code, name, active, period, currency_code, trial_days
       FROM billing_plan
      WHERE ($1::boolean OR active)
      ORDER BY sort_order, code`,
    [opts.includeInactive ?? false],
  );
  if (plans.rows.length === 0) return [];

  const codes = plans.rows.map((r) => r.code as string);
  const components = await tx.query(
    `SELECT plan_code, meter, unit_amount_minor, included_units
       FROM billing_plan_component
      WHERE plan_code = ANY($1::text[])
      ORDER BY plan_code, meter`,
    [codes],
  );

  const byPlan = new Map<string, PlanComponent[]>();
  for (const row of components.rows) {
    const list = byPlan.get(row.plan_code as string) ?? [];
    list.push({
      meter: row.meter as Meter,
      // bigint, like every amount in this schema. `pg` hands back a string for
      // int8 and the whole of `lib/money.ts` exists because turning that into a
      // Number is how money goes wrong.
      unitAmountMinor: BigInt(row.unit_amount_minor as string),
      includedUnits: Number(row.included_units),
    });
    byPlan.set(row.plan_code as string, list);
  }

  return plans.rows.map((r) => ({
    code: r.code as string,
    name: r.name as string,
    active: r.active as boolean,
    period: r.period as 'MONTH' | 'YEAR',
    currencyCode: r.currency_code as string,
    trialDays: Number(r.trial_days),
    components: byPlan.get(r.code as string) ?? [],
  }));
}

/**
 * This tenant's live subscription, or null.
 *
 * Under `tenant_isolation`, so it needs a real tenant context and returns nothing
 * without one — which is the correct failure and not a special case: `withoutOrg`
 * does not bypass RLS, it connects under FORCE RLS with no context, so every
 * tenant table returns zero rows. That fact cost this project every SSO sign-in
 * once (VX5-3) and is worth restating wherever a read looks tenant-optional.
 */
export async function liveSubscription(tx: QueryRunner): Promise<Subscription | null> {
  const r = await tx.query(
    `SELECT id, plan_code, status, trial_ends_at, current_period_start,
            current_period_end, provider, cancelled_at
       FROM subscription
      WHERE organization_id = ${ORG} AND status <> 'CANCELLED'`,
  );
  if (r.rowCount === 0) return null;
  const row = r.rows[0];
  return {
    id: row.id as string,
    planCode: row.plan_code as string,
    status: row.status as SubscriptionStatus,
    trialEndsAt: (row.trial_ends_at as Date | null) ?? null,
    currentPeriodStart: row.current_period_start as Date,
    currentPeriodEnd: (row.current_period_end as Date | null) ?? null,
    provider: (row.provider as string | null) ?? null,
    cancelledAt: (row.cancelled_at as Date | null) ?? null,
  };
}

/**
 * Start a tenant's trial. Called from `createOrganization`, inside its transaction.
 *
 * INSIDE that transaction on purpose, for the reason its own header gives about
 * the admin row and VX5-4 gives about categories: a tenant that exists without the
 * thing that makes it usable is the half-existing state this function's caller
 * refuses on principle. A tenant with no subscription is one that no billing sweep
 * will ever pick up and no screen can describe.
 *
 * THE TRIAL END IS COMPUTED FROM THE PLAN, not from a constant here, because
 * `billing_plan.trial_days` is where a change to the offer belongs — and zero is a
 * legitimate value meaning "no trial", which is why the status it produces differs.
 */
export async function startTrial(
  tx: QueryRunner,
  opts: { planCode?: string } = {},
): Promise<{
  subscriptionId: string;
  planCode: string;
  status: SubscriptionStatus;
  trialEndsAt: Date | null;
}> {
  const planCode = opts.planCode ?? DEFAULT_PLAN_CODE;

  const plan = await tx.query('SELECT trial_days FROM billing_plan WHERE code = $1 AND active', [
    planCode,
  ]);
  if (plan.rowCount === 0) {
    // A refusal naming the plan, not a foreign-key error naming a constraint. The
    // caller here is `createOrganization`, whose failure mode is a customer whose
    // signup did not work.
    throw new Error(`billing: no active plan '${planCode}'`);
  }
  const trialDays = Number(plan.rows[0].trial_days);

  // A plan with no trial starts ACTIVE rather than TRIALING, and the CHECK in
  // 0037 enforces the pairing either way: TRIALING has a trial end, nothing else
  // may have one. Two claims about the same tenant is the state that CHECK exists
  // to make unrepresentable.
  const status: SubscriptionStatus = trialDays > 0 ? 'TRIALING' : 'ACTIVE';

  const r = await tx.query(
    `INSERT INTO subscription (organization_id, plan_code, status, trial_ends_at)
     VALUES (${ORG}, $1, $2,
             CASE WHEN $3::int > 0
                  THEN clock_timestamp() + make_interval(days => $3::int)
                  ELSE NULL END)
     RETURNING id, status, trial_ends_at`,
    [planCode, status, trialDays],
  );
  const row = r.rows[0];
  return {
    subscriptionId: row.id as string,
    planCode,
    status: row.status as SubscriptionStatus,
    trialEndsAt: (row.trial_ends_at as Date | null) ?? null,
  };
}

/**
 * Whether this tenant may write, right now.
 *
 * The function a write gate will call. It is here rather than at each call site so
 * that the "no subscription" case is answered in ONE place — see
 * `canWriteWithoutSubscription`, whose comment is the argument. A tenant created
 * before 0037 has no row, and the wrong answer there takes every existing customer
 * offline on deploy.
 */
export async function tenantMayWrite(tx: QueryRunner): Promise<boolean> {
  const sub = await liveSubscription(tx);
  return sub === null ? canWriteWithoutSubscription() : canWrite(sub.status);
}
