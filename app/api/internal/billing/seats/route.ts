/**
 * VX5-20 — POST /api/internal/billing/seats
 *
 * The reconcile sweep: push every tenant's current seat count to the platform.
 * Same shape, same gate and the same fail-closed reasoning as the five internal
 * routes before it — a route rather than a worker process because VeloExpense has
 * one deployable, a shared secret compared in constant time, 404 rather than 401
 * because an endpoint that says "wrong password" confirms it exists, and an
 * unconfigured deployment gets a sweep that never runs rather than an endpoint
 * anybody can post to.
 *
 * ── WHY THIS IS NOT OPTIONAL, WHICH IS THE ONLY INTERESTING PART ───────────
 *
 * The event-driven pushes — invitation accepted, employee deactivated,
 * reactivated — are fire-and-forget by design: nobody should fail to sign in, or
 * wait, because the platform is slow. `lib/billing/seats.ts` says so at length.
 *
 * The price of that is a dropped push. A timeout, a deploy mid-request, a
 * serverless function frozen before its floating promise settled — any of those
 * leaves the platform holding a stale seat count, and because a seat count is a
 * LEVEL rather than an event, nothing later contradicts it. The tenant is
 * mis-billed until somebody notices, and the person who notices is the customer.
 *
 * So this exists to make the event-driven path's failures self-healing rather
 * than permanent, and it is the difference between "best effort" meaning
 * eventually right and meaning occasionally wrong forever. VeloCRM's own seat sync
 * has the same exposure and no sweep; it gets away with it because the CRM is
 * where the users are, so a missed sync is corrected by the next user edit in the
 * same process.
 *
 * ── IT REPORTS, IT DOES NOT REFUSE ─────────────────────────────────────────
 *
 * 200 with a body even when tenants failed. A sweep that 500s on the first
 * unreachable tenant tells an operator nothing about the other forty, and a cron
 * that retries the whole thing because of one failure re-pushes thirty-nine
 * numbers that were already right. `failures` names every tenant that did not
 * land, which is what somebody needs at the moment they are looking.
 *
 * `skipped` is the count with no platform account — a tenant that signed up
 * through VeloExpense's own front door. That is a normal state, not a failure,
 * and it is surfaced because during the cutover it is the number that says how
 * much of the estate the platform has never heard of.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { reconcileAllTenants, seatPushConfigured } from '@/lib/billing/seats';

export const dynamic = 'force-dynamic';

function authorized(req: NextRequest): boolean {
  const expected = process.env.WORKER_SECRET?.trim();
  if (!expected) return false;
  const header = req.headers.get('authorization') ?? '';
  const presented = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!presented) return false;
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(req: NextRequest) {
  // 404, not 401 — an endpoint that says "wrong password" confirms it exists.
  if (!authorized(req)) return new NextResponse(null, { status: 404 });

  // Distinguished from an empty sweep on purpose. "0 sent, 0 skipped" on a
  // deployment with no platform integration reads like a broken sweep; saying
  // `configured: false` says which of the two it is, and it is the first thing
  // somebody checks when the platform's numbers look wrong.
  if (!seatPushConfigured()) {
    return NextResponse.json(
      { configured: false, message: 'PLATFORM_API_URL / PLATFORM_SERVICE_TOKEN are not set' },
      { status: 200 },
    );
  }

  const result = await reconcileAllTenants();
  return NextResponse.json({ configured: true, ...result }, { status: 200 });
}
