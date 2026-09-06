/**
 * VX5-9 — POST /api/internal/billing/meter
 *
 * What makes the meter readings happen. Same shape, same gate and the same
 * fail-closed reasoning as the three internal routes before it
 * (`/compliance/scan`, `/compliance/evaluate`, `/ledger/drain`,
 * `/notifications/drain`): a route rather than a worker process because
 * VeloExpense has one deployable, a shared secret compared in constant time, and
 * an unconfigured deployment gets a sweep that never runs rather than an endpoint
 * anybody can post to.
 *
 * ── IT METERS THE CURRENT MONTH, AND THE PERIOD IS OVERRIDABLE ─────────────
 *
 * Default: the UTC calendar month containing now. An optional `{"month":
 * "2026-09"}` body meters a named month instead, which exists for exactly one
 * reason — a sweep that failed or was never scheduled leaves a gap, and the repair
 * has to be possible without editing code at the moment somebody is already
 * dealing with a missing invoice.
 *
 * That is safe to expose because `recordReadings` is idempotent by a unique index
 * and uses ON CONFLICT DO NOTHING: re-metering a month that already has readings
 * writes nothing and reports how many it skipped. It cannot be used to overwrite
 * history, which is the property that makes an operator-facing period parameter
 * something other than a foot-gun.
 *
 * A FUTURE month is refused. It would write a reading for a period that has not
 * happened, which is not a repair — it is a wrong number with a plausible date on
 * it, and the invoice built from it would look entirely normal.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { meterAllTenants, monthOf, type Period } from '@/lib/billing/metering';

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

/** `YYYY-MM` → the UTC month. Returns null for anything else. */
function periodFromMonth(month: string): Period | null {
  const m = /^(\d{4})-(\d{2})$/.exec(month.trim());
  if (m === null) return null;
  const year = Number(m[1]);
  const monthIndex = Number(m[2]) - 1;
  if (monthIndex < 0 || monthIndex > 11) return null;
  const start = new Date(Date.UTC(year, monthIndex, 1));
  const end = new Date(Date.UTC(year, monthIndex + 1, 1));
  return { start, end };
}

export async function POST(req: NextRequest) {
  // 404, not 401 — an endpoint that says "wrong password" confirms it exists.
  if (!authorized(req)) return new NextResponse('Not found', { status: 404 });

  let period = monthOf(new Date());

  // A body is optional. An unparseable one is refused rather than ignored: a
  // scheduled job that silently metered the wrong month because of a typo is the
  // failure this whole route is careful about.
  const raw = await req.text();
  if (raw.trim() !== '') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return NextResponse.json({ error: 'body is not JSON' }, { status: 400 });
    }
    const month = (parsed as { month?: unknown } | null)?.month;
    if (month !== undefined) {
      if (typeof month !== 'string') {
        return NextResponse.json({ error: 'month must be a string, "YYYY-MM"' }, { status: 400 });
      }
      const named = periodFromMonth(month);
      if (named === null) {
        return NextResponse.json({ error: `month "${month}" is not YYYY-MM` }, { status: 400 });
      }
      if (named.start > new Date()) {
        return NextResponse.json(
          { error: `month "${month}" has not started — a reading for it would be invented` },
          { status: 400 },
        );
      }
      period = named;
    }
  }

  const result = await meterAllTenants(period);
  // The period is echoed back. An operator repairing a gap needs to see WHICH
  // month this run actually measured, not infer it from the request they think
  // they sent.
  return NextResponse.json({
    period: { start: period.start.toISOString(), end: period.end.toISOString() },
    ...result,
  });
}

/** GET is deliberately absent — a sweep that writes is not a link. */
