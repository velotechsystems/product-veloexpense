/**
 * VX4-8 part 4 — POST /api/internal/compliance/scan
 *
 * What makes the fraud detectors run. Same shape, same gate and the same
 * fail-closed reasoning as `/api/internal/ledger/drain` and
 * `/api/internal/notifications/drain`: a route rather than a worker process
 * because VeloExpense has one deployable, a shared secret compared in constant
 * time, and an unconfigured deployment gets a scan that never runs rather than an
 * endpoint anybody can post to.
 *
 * A SECOND ROUTE beside `/evaluate`, for the reason the ledger drain gives for
 * being separate from the mail drain: they fail independently and belong on
 * different schedules. A fraud scan is cheap and wants to be frequent; a control
 * evaluation writes a run row somebody reads as a period's record and wants to be
 * daily or weekly. One route would couple the two and give an operator one number
 * where two are needed.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { scanAllTenants } from '@/lib/fraud/scan';

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
  if (!authorized(req)) return new NextResponse('Not found', { status: 404 });
  return NextResponse.json(await scanAllTenants());
}

/** GET is deliberately absent — a scan is not idempotent enough to be a link. */
