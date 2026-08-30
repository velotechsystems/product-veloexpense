/**
 * VX3-4 — POST /api/internal/ledger/drain
 *
 * The thing that makes the ledger post queue move. Same shape, same gate and same
 * reasoning as `/api/internal/notifications/drain` (VX2-8) — a route rather than a
 * worker process because VeloExpense has one deployable, and a shared secret
 * compared in constant time, FAIL-CLOSED so an unconfigured deployment has a queue
 * that does not move rather than an endpoint anybody can post to.
 *
 * Deliberately a SECOND route rather than one that drains both. They fail
 * independently and at different rates: a mail outage should not stop approved
 * reports reaching the ledger, and a ledger outage should not delay a notification.
 * One route would couple the two schedules and give an operator one number where
 * two are needed.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { drainPosts } from '@/lib/integrations/dispatch';

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
  if (!authorized(req)) {
    // 404, not 401 — an endpoint that says "wrong password" confirms it exists.
    return new NextResponse('Not found', { status: 404 });
  }
  const limit = Number(new URL(req.url).searchParams.get('limit') ?? '25');
  const summary = await drainPosts(Number.isFinite(limit) ? limit : 25);
  return NextResponse.json(summary);
}

/** GET is deliberately absent — see the note on the notifications drain route. */
