/**
 * VX5-19 — the subscription MIRROR.
 *
 * Rewritten from VX5-8's version. What was a source of truth — a plan catalogue,
 * a trial this product started, a status it decided — is now a local copy of what
 * the VeloTech platform said, with the time it said it.
 *
 * ── WHY MIRROR AT ALL, WHEN VeloLedger STORES NOTHING ──────────────────────
 *
 * VeloLedger's client is a read-through with a 60-second cache, used for display
 * and, in its own words, "(future) gating". Ours gates TODAY, inside the
 * transaction that guards every submit, approval and payment.
 *
 * Putting an HTTP call in the middle of that transaction would mean a network
 * round trip inside a database transaction and every write in this product
 * failing when the platform hiccups — trading a billing outage for an operations
 * outage, which is the worse of the two to hand a customer who has paid.
 *
 * So the entitlement is fetched OUTSIDE the write path and written here, and the
 * gate reads this table. `mirrored_at` is on the row so a reader sees "the
 * platform said this, at this time" rather than "this is true".
 *
 * ── NOTHING HERE DECIDES ANYTHING ──────────────────────────────────────────
 *
 * No `startTrial`, no `DEFAULT_PLAN_CODE`, no plan lookup. The platform starts
 * trials, sets plans and cancels subscriptions; if VeloExpense appears to do any
 * of those, two systems are deciding one thing and they will disagree. The only
 * write in this file copies an answer somebody else gave.
 */
import { type QueryRunner } from '@/lib/db/client';
import { ORG } from '@/lib/tenant/sql';
import {
  canWrite,
  canWriteWithoutSubscription,
  statusFromPlatform,
  type Meter,
  type SubscriptionStatus,
} from '@/lib/billing/plans';
import type { EntitlementResult } from '@/lib/billing/entitlements';

export interface MirroredSubscription {
  id: string;
  planCode: string;
  planName: string | null;
  status: SubscriptionStatus;
  trialEndsAt: Date | null;
  currentPeriodEnd: Date | null;
  /** The platform's own verdict, or null for a row mirrored before 0039. */
  readOnly: boolean | null;
  /** When the platform last answered. Null means never mirrored. */
  mirroredAt: Date | null;
  cancelledAt: Date | null;
}

/**
 * This tenant's live mirrored subscription, or null.
 *
 * Under `tenant_isolation`, so it needs a real tenant context and returns nothing
 * without one — the correct failure, not a special case: `withoutOrg` does not
 * bypass RLS, it connects under FORCE RLS with no context, so every tenant table
 * returns zero rows. That fact cost this project every SSO sign-in once (VX5-3).
 */
export async function liveSubscription(tx: QueryRunner): Promise<MirroredSubscription | null> {
  const r = await tx.query(
    `SELECT id, plan_code, plan_name, status, trial_ends_at, current_period_end,
            read_only, mirrored_at, cancelled_at
       FROM subscription
      WHERE organization_id = ${ORG} AND status <> 'CANCELLED'`,
  );
  if (r.rowCount === 0) return null;
  const row = r.rows[0];
  return {
    id: row.id as string,
    planCode: row.plan_code as string,
    planName: (row.plan_name as string | null) ?? null,
    status: row.status as SubscriptionStatus,
    trialEndsAt: (row.trial_ends_at as Date | null) ?? null,
    currentPeriodEnd: (row.current_period_end as Date | null) ?? null,
    readOnly: (row.read_only as boolean | null) ?? null,
    mirroredAt: (row.mirrored_at as Date | null) ?? null,
    cancelledAt: (row.cancelled_at as Date | null) ?? null,
  };
}

/**
 * What this tenant's subscription says, INCLUDING a cancellation.
 *
 * A bug VX5-11's test caught and this rewrite keeps fixed: `liveSubscription`
 * filters `status <> 'CANCELLED'`, which is right for "what are they on" — a
 * customer who left is on nothing — but meant the write gate saw a cancelled
 * tenant as a tenant with NO subscription, which is the one absence deliberately
 * permitted. They kept full write access.
 *
 * Two different absences, and only one of them is permissive:
 *   · NEVER MIRRORED — no row. Permitted (see `canWriteWithoutSubscription`).
 *   · CANCELLED — a row that says they left. Refused.
 */
export async function effectiveStatus(tx: QueryRunner): Promise<SubscriptionStatus | null> {
  const live = await liveSubscription(tx);
  if (live !== null) return live.status;
  const any = await tx.query(`SELECT 1 FROM subscription WHERE organization_id = ${ORG} LIMIT 1`);
  return any.rowCount === 0 ? null : 'CANCELLED';
}

export interface MirrorOutcome {
  /** 'written' | 'unchanged' | 'skipped'. Skipped says why. */
  state: 'written' | 'skipped';
  reason?: string;
}

/**
 * Copy a platform entitlement into the mirror.
 *
 * ── WHAT IS DELIBERATELY *NOT* MIRRORED ────────────────────────────────────
 *
 * `disabled`, `not_found` and `error` all write NOTHING and say so. Each is a
 * case where the honest local state is "we do not know", and the three would be
 * flattened by writing a row:
 *
 *   · `disabled` — the integration is off. Writing anything would make a product
 *     with no billing configured look billed.
 *   · `not_found` — no platform Account. Legitimate for a tenant that came in
 *     through VeloExpense's own signup and the operator console never saw.
 *   · `error` — the platform did not answer. **The most important of the three.**
 *     Writing a refusal here would let a platform OUTAGE stop a paying customer
 *     working, which is precisely the failure the mirror exists to prevent. A
 *     stale row that still says ACTIVE is the correct thing to keep.
 *
 * An unrecognised status is skipped for the same reason: better a stale mirror
 * than one this product guessed at.
 */
export async function mirrorEntitlement(
  tx: QueryRunner,
  result: EntitlementResult,
): Promise<MirrorOutcome> {
  if (result.state !== 'ok') {
    return { state: 'skipped', reason: result.state };
  }
  const e = result.entitlement;
  if (!e.hasSubscription) {
    return { state: 'skipped', reason: 'no subscription on the platform account' };
  }
  const status = statusFromPlatform(e.status);
  if (status === null) {
    return { state: 'skipped', reason: `unrecognised platform status "${e.status ?? 'null'}"` };
  }

  // One row per tenant, updated in place. The partial unique index from 0037
  // still holds — a tenant has at most one non-cancelled subscription — so this
  // is an upsert on the tenant rather than on a provider reference.
  await tx.query(
    `INSERT INTO subscription
       (organization_id, plan_code, plan_name, status, trial_ends_at,
        current_period_end, read_only, mirrored_at, cancelled_at)
     VALUES (${ORG}, $1, $2, $3, $4, $5, $6, clock_timestamp(),
             CASE WHEN $3 = 'CANCELLED' THEN clock_timestamp() ELSE NULL END)
     ON CONFLICT (organization_id) WHERE status <> 'CANCELLED'
     DO UPDATE SET plan_code          = EXCLUDED.plan_code,
                   plan_name          = EXCLUDED.plan_name,
                   status             = EXCLUDED.status,
                   trial_ends_at      = EXCLUDED.trial_ends_at,
                   current_period_end = EXCLUDED.current_period_end,
                   read_only          = EXCLUDED.read_only,
                   mirrored_at        = EXCLUDED.mirrored_at,
                   cancelled_at       = COALESCE(subscription.cancelled_at, EXCLUDED.cancelled_at),
                   updated_at         = clock_timestamp()`,
    [
      e.planSlug ?? 'unknown',
      e.planName,
      status,
      e.trialEndsAt,
      e.currentPeriodEnd,
      e.readOnly,
    ],
  );
  return { state: 'written' };
}

/**
 * Whether this tenant may write, right now, from the mirror alone.
 *
 * THE PLATFORM'S `readOnly` WINS when the mirror has one. Deriving the answer
 * from a status was VX5-11's design, and it meant this product held an opinion
 * about what "past_due" permits that the platform's other consumers might not
 * share. `canWrite` remains as the fallback for a row mirrored before 0039 or one
 * the platform sent without a verdict.
 */
export async function tenantMayWrite(tx: QueryRunner): Promise<boolean> {
  const live = await liveSubscription(tx);
  if (live !== null) {
    return live.readOnly === null ? canWrite(live.status) : !live.readOnly;
  }
  const status = await effectiveStatus(tx);
  return status === null ? canWriteWithoutSubscription() : canWrite(status);
}

export interface ReadingView {
  meter: Meter;
  quantity: bigint;
  planCode: string;
  periodStart: Date;
  periodEnd: Date;
  measuredAt: Date;
}

/**
 * The most recent periods' readings for this tenant, newest first.
 *
 * A LIMIT rather than everything, because this feeds a screen and a tenant three
 * years in has a hundred rows nobody scrolls.
 */
export async function recentReadings(tx: QueryRunner, limit = 12): Promise<ReadingView[]> {
  const r = await tx.query(
    `SELECT meter, quantity, plan_code, period_start, period_end, measured_at
       FROM subscription_meter_reading
      WHERE organization_id = ${ORG}
      ORDER BY period_start DESC, meter
      LIMIT $1`,
    [limit],
  );
  return r.rows.map((row) => ({
    meter: row.meter as Meter,
    quantity: BigInt(row.quantity as string),
    planCode: row.plan_code as string,
    periodStart: row.period_start as Date,
    periodEnd: row.period_end as Date,
    measuredAt: row.measured_at as Date,
  }));
}
