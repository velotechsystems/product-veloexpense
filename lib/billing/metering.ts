/**
 * VX5-9 — counting what a tenant is billed for.
 *
 * ── EACH METER IS A FUNCTION, AND CARD IS NOT ONE ──────────────────────────
 *
 * `COUNTERS` is a `Partial<Record<Meter, …>>` and the partiality is the point.
 * `SEAT` and `TENANT` have counters; `CARD` has none, because the VCC module does
 * not exist in VeloExpense and nothing here can count a card.
 *
 * The alternative — a `CARD` counter that returns 0 — was written first and is
 * exactly wrong: a meter reading of zero is indistinguishable from a customer who
 * genuinely owes nothing, so the failure would be invisible on every invoice and
 * in every test. Absence, by contrast, is loud: `meterIsBillable` says no, 0037's
 * CHECK refuses to attach the meter to a plan, and `countFor` throws rather than
 * guessing. Three layers all saying the same thing, because a silent zero in
 * billing is the kind of defect that is discovered by a customer.
 *
 * ── WHAT A SEAT IS ─────────────────────────────────────────────────────────
 *
 * John's decision, 6 Sep: anybody who can sign in — a non-deleted `app_user`.
 * NOT live invitations, so an admin who invites ten and gets three does not argue
 * with an invoice. And because `deleted_at` is what stops the login (VX5-3 put the
 * check in `resolveSsoUser`), the charge stops on the same event that stops the
 * access, which means a tenant can never be billed for somebody who cannot get in.
 * That equivalence is the property `test/metering.db.test.ts` pins, not the SQL.
 */
import type { QueryRunner } from '@/lib/db/client';
import { withOrg } from '@/lib/tenant/context';
import { withPlatformRead } from '@/lib/tenant/context';
import { ORG } from '@/lib/tenant/sql';
import { METERS, meterIsBillable, type Meter } from '@/lib/billing/plans';

/** A half-open period, [start, end), as everything else in this schema. */
export interface Period {
  start: Date;
  end: Date;
}

type Counter = (tx: QueryRunner) => Promise<bigint>;

const COUNTERS: Partial<Record<Meter, Counter>> = {
  /**
   * Everybody who can sign in to this tenant, right now.
   *
   * `deleted_at IS NULL` and nothing else. Deliberately NOT filtered on
   * `employee_status`: a person ON_LEAVE still holds an account, still has history
   * to read, and still signs in — `resolveSsoUser` does not consult
   * `employee_status`, so filtering on it here would bill differently from how the
   * product actually admits people. If that is ever wanted it is a pricing change,
   * with a decision behind it, not a quiet WHERE clause.
   */
  SEAT: async (tx) => {
    const r = await tx.query(
      `SELECT count(*)::bigint AS n FROM app_user
        WHERE organization_id = ${ORG} AND deleted_at IS NULL`,
    );
    return BigInt(r.rows[0].n as string);
  },

  /**
   * One. The flat-fee meter.
   *
   * It looks like a joke and it is not: a plan with a `TENANT` component charges
   * `unit_amount_minor × 1`, and expressing that as a reading of 1 means the
   * invoice arithmetic is the same shape for every meter. The alternative — a
   * special case in the pricing code for "flat" plans — is a branch that has to be
   * remembered in every place an amount is computed.
   */
  TENANT: async () => 1n,
};

/** Whether this build can measure a meter at all. */
export function canCount(meter: Meter): boolean {
  return COUNTERS[meter] !== undefined;
}

/**
 * Count one meter inside an already-established tenant context.
 *
 * THROWS for a meter with no counter rather than returning zero. See the header:
 * a zero here would be a silent wrong invoice, and the whole design of this file
 * is about making that impossible to reach by accident.
 */
export async function countFor(tx: QueryRunner, meter: Meter): Promise<bigint> {
  const counter = COUNTERS[meter];
  if (counter === undefined) {
    throw new Error(
      `billing: no counter for meter '${meter}' — this build cannot measure it, ` +
        'and returning 0 would be indistinguishable from a tenant that owes nothing',
    );
  }
  return counter(tx);
}

/**
 * The two halves of the vocabulary must agree, and this is asserted at MODULE
 * LOAD rather than in a test.
 *
 * `plans.ts` says which meters are billable; this file says which can be counted.
 * They are two lists in two files, which is the shape UD-9 caught three times —
 * so they are reconciled here, at import, and a build in which they disagree
 * fails to start rather than billing something it cannot measure or refusing to
 * measure something it bills.
 *
 * Same guard as `lib/integrations/registry.ts`'s "a declared capability must have
 * its method", and for the same reason: declared and implemented were never
 * connected at all in ExpenseOS (AC-5).
 */
for (const meter of METERS) {
  if (meterIsBillable(meter) !== canCount(meter)) {
    throw new Error(
      `billing: meter '${meter}' is ${meterIsBillable(meter) ? 'billable' : 'not billable'} ` +
        `but ${canCount(meter) ? 'has' : 'has no'} counter — lib/billing/plans.ts and ` +
        'lib/billing/metering.ts disagree',
    );
  }
}

export interface ReadingWritten {
  meter: Meter;
  quantity: bigint;
  /** False when a reading for this (tenant, meter, period) already existed. */
  inserted: boolean;
}

/**
 * Measure and record every meter this tenant's plan actually charges for.
 *
 * IDEMPOTENT, by the unique index rather than by a check: `ON CONFLICT DO
 * NOTHING`, so a second run over the same period writes nothing and says so. That
 * matters because this is a cron — it WILL be run twice, on a deploy, on a retry,
 * and by a person testing it.
 *
 * `DO NOTHING` rather than `DO UPDATE`, and the migration argues it at length: a
 * period's reading is evidence. If September said 34 seats and a later run says
 * 31, the interesting fact is that they disagree, and an overwrite destroys it.
 */
export async function recordReadings(
  tx: QueryRunner,
  period: Period,
): Promise<ReadingWritten[]> {
  const sub = await tx.query(
    `SELECT plan_code FROM subscription
      WHERE organization_id = ${ORG} AND status <> 'CANCELLED'`,
  );
  // No live subscription, nothing to meter. Not an error: a tenant created before
  // 0037 is in exactly this state, and a sweep that threw on it would stop at the
  // first legacy tenant and never reach the rest.
  if (sub.rowCount === 0) return [];
  const planCode = sub.rows[0].plan_code as string;

  // Only the meters this tenant's PLAN charges for. A seat count on a flat-fee
  // plan is a number nobody will ever price, and writing it would invite somebody
  // later to price it.
  const components = await tx.query(
    'SELECT meter FROM billing_plan_component WHERE plan_code = $1 ORDER BY meter',
    [planCode],
  );

  const written: ReadingWritten[] = [];
  for (const row of components.rows) {
    const meter = row.meter as Meter;
    const quantity = await countFor(tx, meter);
    const ins = await tx.query(
      `INSERT INTO subscription_meter_reading
         (organization_id, meter, plan_code, period_start, period_end, quantity)
       VALUES (${ORG}, $1, $2, $3, $4, $5)
       ON CONFLICT (organization_id, meter, period_start) DO NOTHING
       RETURNING id`,
      [meter, planCode, period.start, period.end, quantity.toString()],
    );
    written.push({ meter, quantity, inserted: ins.rowCount === 1 });
  }
  return written;
}

export interface SweepResult {
  organizations: number;
  readingsWritten: number;
  readingsAlreadyPresent: number;
  /** Tenants whose measurement threw, by id, with the message. Never silent. */
  failures: { organizationId: string; message: string }[];
}

/**
 * Every tenant, one at a time, each inside its own context.
 *
 * The VX0-8 shape `scanAllTenants` established: fan out per tenant and set
 * `app.current_org` for each, rather than one cross-tenant query. That is why
 * `subscription_meter_reading` has no platform hatch — counting seats is never a
 * tenant-less question, unlike the webhook lookup 0037's hatch exists for.
 *
 * ── ONE TENANT'S FAILURE MUST NOT STOP THE REST ────────────────────────────
 *
 * A sweep that throws on tenant three leaves tenants four onward unmeasured, and
 * — because this is a monthly job — unmeasured for a month, discovered when an
 * invoice is short. So each tenant is caught individually and the failures are
 * RETURNED rather than logged: the caller is an HTTP route whose response an
 * operator reads, and a failure nobody is handed is a failure nobody sees.
 */
export async function meterAllTenants(period: Period): Promise<SweepResult> {
  const orgs = await withPlatformRead(async (tx) => {
    const r = await tx.query(
      `SELECT organization_id FROM subscription
        WHERE status <> 'CANCELLED' ORDER BY organization_id`,
    );
    return r.rows.map((row) => row.organization_id as string);
  });

  const result: SweepResult = {
    organizations: orgs.length,
    readingsWritten: 0,
    readingsAlreadyPresent: 0,
    failures: [],
  };

  for (const organizationId of orgs) {
    try {
      const written = await withOrg(organizationId, (tx) => recordReadings(tx, period));
      for (const w of written) {
        if (w.inserted) result.readingsWritten += 1;
        else result.readingsAlreadyPresent += 1;
      }
    } catch (err) {
      result.failures.push({
        organizationId,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return result;
}

/**
 * The calendar month a moment falls in, in UTC, as a half-open period.
 *
 * UTC AND NOT THE TENANT'S ZONE, deliberately. A billing period has to be one
 * interval for everybody or two tenants in different zones disagree about which
 * month a seat added at midnight belongs to — and the provider's own periods are
 * not tenant-local either. VX4-7 part 1b's lesson applies in reverse here: a
 * calendar date must not carry a timezone, and a billing period must carry exactly
 * one, chosen once.
 */
export function monthOf(instant: Date): Period {
  const start = new Date(Date.UTC(instant.getUTCFullYear(), instant.getUTCMonth(), 1));
  const end = new Date(Date.UTC(instant.getUTCFullYear(), instant.getUTCMonth() + 1, 1));
  return { start, end };
}
