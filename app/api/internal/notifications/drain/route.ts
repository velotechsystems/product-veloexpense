/**
 * VX2-8 — POST /api/internal/notifications/drain
 *
 * The thing that makes the outbox move. A scheduler (cron, an ECS scheduled task,
 * a Vercel cron entry) posts here on an interval and the handler sends whatever is
 * due.
 *
 * ── Why a route rather than a worker process ────────────────────────────────
 *
 * ExpenseOS runs `apps/worker` as its own long-lived process against Redis.
 * VeloExpense has one deployable and `output: 'standalone'`, so a second process
 * would mean a second image, a second thing to deploy, and — the part that
 * actually costs — a second place where `@/` path aliases and the tenant helpers
 * have to resolve. A route reuses the build that already exists.
 *
 * The trade, stated because it is real: this is pull, not push. A notification
 * waits up to one polling interval, so the interval IS the delivery latency. One
 * minute is a reasonable setting and nothing here depends on it.
 *
 * `drainOutbox` is also called directly by the admin screen's "send now" button
 * and by the tests, so the path exercised in CI is the path that ships — VX1-9's
 * lesson about MemoryStorage was that a test-only path proves nothing about the
 * real one.
 *
 * ── The gate ────────────────────────────────────────────────────────────────
 *
 * A shared secret in an Authorization header, compared in constant time, and
 * FAIL-CLOSED: with `WORKER_SECRET` unset the route refuses rather than running
 * open. That direction is the whole point — an unconfigured deployment should
 * have a queue that does not move, not an endpoint anybody can post to. The
 * failure is loud on the admin screen, which shows the queue depth.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { drainOutbox } from '@/lib/notifications/dispatch';

export const dynamic = 'force-dynamic';

/** No session, no tenant. The secret is the only credential. */
function authorized(req: NextRequest): boolean {
  const expected = process.env.WORKER_SECRET?.trim();
  if (!expected) return false;
  const header = req.headers.get('authorization') ?? '';
  const presented = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!presented) return false;
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  // Lengths differ → not equal, and `timingSafeEqual` would throw. Comparing
  // lengths first leaks the secret's length, which is not a secret worth keeping.
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(req: NextRequest) {
  if (!authorized(req)) {
    // 404, not 401: an endpoint that says "wrong password" confirms it exists.
    // There is no legitimate caller who needs to tell the two apart.
    return new NextResponse('Not found', { status: 404 });
  }
  const limit = Number(new URL(req.url).searchParams.get('limit') ?? '25');
  const summary = await drainOutbox({
    limit: Number.isFinite(limit) ? limit : 25,
    claimedBy: 'drain-route',
  });
  return NextResponse.json(summary);
}

/**
 * GET is deliberately absent.
 *
 * A GET that drained a queue would be drained by anything that crawls a URL, and
 * the whole reason /approve is a POST applies here for the same reason.
 */
