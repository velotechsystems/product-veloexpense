/**
 * VX4-8 part 4 — POST /api/internal/compliance/evaluate
 *
 * What makes the control evaluation run. Sibling of `/scan`; see that file for
 * why the two are separate routes rather than one.
 *
 * NO PERIOD PARAMETER, deliberately. `runControlEvaluation` defaults to the
 * trailing 90 days, and a scheduled caller passing its own window would make the
 * stored `period_start`/`period_end` a property of whoever configured the cron
 * rather than of the product. An admin choosing a window is a screen concern and
 * lives in `/admin/compliance`.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { evaluateAllTenants } from '@/lib/fraud/evaluate';

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
  if (!authorized(req)) return new NextResponse('Not found', { status: 404 });
  return NextResponse.json(await evaluateAllTenants());
}
