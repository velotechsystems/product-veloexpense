/**
 * VX5-20 — the seat count going UP to the platform.
 *
 * ── WHY THIS IS THE FIRST OF ITS KIND IN THE SUITE ─────────────────────────
 *
 * Every platform integration in this product so far reads DOWNWARDS: an
 * entitlement comes from VeloCRM and `lib/billing/service.ts` mirrors it. This is
 * the other direction, and it exists because **only VeloExpense can count
 * VeloExpense seats.**
 *
 * VeloLedger never needed this: it bills flat-per-org, so the platform can price
 * it without asking. VeloCRM bills per seat and counts its own `users` table
 * in-process. VeloExpense is the first product that is per-seat AND lives
 * somewhere else, so the platform has no way to know the number.
 *
 * ── WHAT THIS IS NOT: IT IS NOT USAGE ──────────────────────────────────────
 *
 * The platform has a usage endpoint — `POST /api/v1/platform/usage` — and it
 * would accept this. It even has an optional `meter` field. Sending a seat count
 * there would be wrong, and quietly:
 *
 *   · that endpoint feeds `platform_usage_events`, whose `recordUsage` computes
 *     `credits = tokensToCredits(quantity, model)` **ignoring `meter`**. Four
 *     seats would be stored as 0.0007 AI credits.
 *   · those rows are billed through Stripe METER EVENTS (usage-based). Seats are
 *     billed as a subscription item QUANTITY (licensed per-unit) — a different
 *     Stripe mechanism entirely, which the platform already drives from
 *     `stripeService.syncSeatQuantity()`.
 *
 * An event is a thing that happened: append-only, summed, deduplicated by key. A
 * seat count is a LEVEL: last-write-wins, and re-sending the same number is a
 * no-op rather than a double charge. Those are different contracts and they need
 * different doors.
 *
 * So this posts to `POST /api/v1/platform/seats` — a level endpoint. **That route
 * does not exist on the platform yet** (John is adding it); until it does, every
 * push gets a 404 and this module reports `error` without disturbing anything.
 * See the fail-soft argument below, which is why that is safe to ship.
 *
 * ── `observedAt`, AND WHY A LEVEL NEEDS ONE ────────────────────────────────
 *
 * A level endpoint has no idempotency key — re-sending 4 is meant to be
 * harmless. The cost is ORDERING: an add and a remove a second apart can arrive
 * out of order and leave the platform holding the older number, permanently,
 * because nothing later contradicts it.
 *
 * Every push therefore carries the instant the count was taken, INSIDE the same
 * transaction that took it. The platform is expected to ignore a push whose
 * `observedAt` is older than the one it has recorded. That is a promise about the
 * receiver and this file cannot enforce it — which is exactly why it is written
 * down here rather than assumed: if the platform ignores the field, out-of-order
 * pushes are a real defect and the reconcile sweep is the only thing correcting
 * them.
 *
 * ── FAIL SOFT, EVERY TIME ──────────────────────────────────────────────────
 *
 * Nothing here throws into a caller. Adding an employee must not fail because the
 * platform is down, and this is the same argument `canWriteWithoutSubscription`
 * makes from the other direction: *"a billing integration that can take a working
 * product offline by being absent or down is not a billing integration — it is a
 * single point of failure with an invoice attached."*
 *
 * The consequence is stated rather than hidden: a dropped push leaves the
 * platform's number stale until the next one. That is what
 * `reconcileAllTenants()` is for, and why it exists at all rather than trusting
 * the event-driven path — VeloCRM's own seat sync has the same exposure and gets
 * away with it because the CRM is where the users are.
 */
import { withOrg, withPlatformRead } from '@/lib/tenant/context';
import { ORG } from '@/lib/tenant/sql';
import { countFor } from '@/lib/billing/metering';
import type { QueryRunner } from '@/lib/db/client';

/** The product dimension the platform keys plans and usage by. */
const PRODUCT = 'veloexpense';

/**
 * How long a push may take before it is abandoned.
 *
 * Short, because this runs inside a server action a person is waiting on. A
 * platform that is slow must not make adding an employee feel broken; the
 * reconcile sweep will catch what the timeout drops.
 */
const TIMEOUT_MS = 4_000;

/**
 * What happened, as a value the caller can branch on rather than an exception.
 *
 * The same discriminated shape as `EntitlementResult` in `entitlements.ts`, and
 * for the same reason: every one of these is a NORMAL outcome in some deployment,
 * so none of them is an error in the throwing sense.
 */
export type SeatPushResult =
  /** No `PLATFORM_API_URL` / `PLATFORM_SERVICE_TOKEN`. Most deployments today. */
  | { state: 'disabled' }
  /**
   * This tenant has no `organization.account_id`, so the platform has never heard
   * of it. A tenant that signed up through VeloExpense's own front door is in
   * exactly this state, and it is NOT an error — the same call
   * `canWriteWithoutSubscription` makes about a missing mirror.
   */
  | { state: 'skipped'; reason: 'no_account' }
  | { state: 'sent'; seatCount: number }
  | { state: 'error'; message: string };

/** True when both platform env vars are present. Mirrors `entitlements.ts`. */
export function seatPushConfigured(): boolean {
  return Boolean(process.env.PLATFORM_API_URL && process.env.PLATFORM_SERVICE_TOKEN);
}

/**
 * The account this tenant belongs to on the platform, or null.
 *
 * `organization` carries no tenant policy (0001), so this reads under the
 * established context without a hatch — and the caller is already inside
 * `withOrg`, so `${ORG}` scopes it to the one tenant.
 */
async function accountIdFor(tx: QueryRunner): Promise<string | null> {
  const r = await tx.query(`SELECT account_id FROM organization WHERE id = ${ORG}`);
  if (r.rowCount === 0) return null;
  return (r.rows[0].account_id as string | null) ?? null;
}

/**
 * What one tenant's seat count is, and when it was taken.
 *
 * `countFor(tx, 'SEAT')` rather than a query of its own, deliberately: what a
 * seat IS was John's decision (anybody who can sign in — a non-deleted
 * `app_user`) and `lib/billing/metering.ts` already encodes it, with
 * `test/metering.db.test.ts` pinning the equivalence between being billable and
 * being able to log in. A second COUNT(*) here would be a second definition, and
 * the day they disagree is the day a customer is charged for somebody who cannot
 * get in. UD-9, in billing.
 *
 * `observedAt` is taken INSIDE the transaction that counted, so the pair is
 * consistent even under a slow push.
 */
export interface SeatObservation {
  accountId: string | null;
  seatCount: number;
  observedAt: Date;
}

export async function observeSeats(tx: QueryRunner): Promise<SeatObservation> {
  const accountId = await accountIdFor(tx);
  const seats = await countFor(tx, 'SEAT');
  return {
    accountId,
    // The counter returns bigint because a reading is stored as one. A seat count
    // that overflows Number is not a scenario worth carrying a bigint through an
    // HTTP body for.
    seatCount: Number(seats),
    observedAt: new Date(),
  };
}

/**
 * Report one tenant's seat count to the platform.
 *
 * Never throws. Reads and pushes; the read is in a transaction and the push is
 * not, which is on purpose — holding a database transaction open across a network
 * call to another service is how a slow dependency becomes a connection-pool
 * outage.
 */
export async function pushSeatCount(organizationId: string): Promise<SeatPushResult> {
  const baseUrl = process.env.PLATFORM_API_URL;
  const token = process.env.PLATFORM_SERVICE_TOKEN;
  if (!baseUrl || !token) return { state: 'disabled' };

  let observation: SeatObservation;
  try {
    observation = await withOrg(organizationId, observeSeats);
  } catch (err) {
    return {
      state: 'error',
      message: err instanceof Error ? err.message : 'could not count seats',
    };
  }

  if (observation.accountId === null) return { state: 'skipped', reason: 'no_account' };

  let res: Response;
  try {
    res = await fetch(`${baseUrl.replace(/\/+$/, '')}/api/v1/platform/seats`, {
      method: 'POST',
      headers: {
        // Service-to-service. The header name is the platform's, and it is the
        // same one `entitlements.ts` uses to read — one token, both directions.
        'x-platform-key': token,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({
        accountId: observation.accountId,
        product: PRODUCT,
        seatCount: observation.seatCount,
        observedAt: observation.observedAt.toISOString(),
      }),
      cache: 'no-store',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    return {
      state: 'error',
      message: err instanceof Error ? err.message : 'platform request failed',
    };
  }

  if (!res.ok) return { state: 'error', message: `platform responded ${res.status}` };
  return { state: 'sent', seatCount: observation.seatCount };
}

export interface SeatSweepResult {
  organizations: number;
  sent: number;
  skipped: number;
  failures: { organizationId: string; message: string }[];
}

/**
 * Push every tenant's seat count.
 *
 * THE POINT OF THIS EXISTING is that the event-driven pushes are best-effort. A
 * timeout, a deploy mid-request, a platform restart — any of those leaves one
 * tenant's number stale on the platform, and because a level is last-write-wins
 * there is nothing to notice it. Only another push fixes it.
 *
 * EVERY tenant, including those with no account: the skip is counted, so the
 * sweep's output says how many tenants the platform has never heard of, which is
 * a number worth being able to read during the cutover.
 *
 * Sequential rather than concurrent. There are tens of tenants, this runs from a
 * cron route, and a burst of parallel POSTs at a service that is already
 * struggling is how a slow platform becomes a down platform.
 */
export async function reconcileAllTenants(): Promise<SeatSweepResult> {
  const orgs = await withPlatformRead(async (tx) => {
    const r = await tx.query('SELECT id FROM organization ORDER BY id');
    return r.rows.map((row) => row.id as string);
  });

  const result: SeatSweepResult = {
    organizations: orgs.length,
    sent: 0,
    skipped: 0,
    failures: [],
  };

  for (const organizationId of orgs) {
    const outcome = await pushSeatCount(organizationId);
    switch (outcome.state) {
      case 'sent':
        result.sent += 1;
        break;
      case 'skipped':
      case 'disabled':
        result.skipped += 1;
        break;
      case 'error':
        result.failures.push({ organizationId, message: outcome.message });
        break;
    }
  }
  return result;
}

/**
 * Fire a push and ignore the outcome — for a server action that has just changed
 * the seat count and must not wait on the platform or fail because of it.
 *
 * `void` on purpose, and the shape is copied from VeloCRM's own
 * `void stripeService.syncSeatQuantity(tenantId)` in `routes/teamMembers.ts`.
 *
 * NOT awaited, which has a real consequence on a serverless runtime: a function
 * that returns before its floating promise settles may be frozen mid-flight and
 * the push lost. That is a dropped push, which the reconcile sweep is for, and it
 * is the reason the sweep is not optional. Said here because the alternative —
 * awaiting — makes a person adding an employee wait on another company's uptime.
 */
export function pushSeatCountInBackground(organizationId: string): void {
  void pushSeatCount(organizationId).catch(() => {
    // `pushSeatCount` does not throw; this is belt and braces so a future edit
    // that makes it throw cannot turn adding an employee into a 500.
  });
}
