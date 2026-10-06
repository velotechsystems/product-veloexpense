/**
 * GET /api/health — liveness, for the load balancer and the container.
 *
 * The shared ALB's target group and the ECS container health check both call
 * this (infrastructure/cdk/lib/compute-stack.ts). It answers 200 when the Node
 * process is serving requests, and that is ALL it claims.
 *
 * ── WHY IT DOES NOT TOUCH THE DATABASE ──────────────────────────────────────
 *
 * A failing health check REPLACES the task. If this route queried Postgres, a
 * database blip — a failover, Aurora scaling from its minimum, the pool
 * momentarily exhausted — would mark every task unhealthy at once, and ECS
 * would kill the only processes able to recover when the database came back.
 * The outage would outlast its cause. A process that is up and cannot reach its
 * database should answer requests with the errors it already produces, not be
 * restarted in a loop.
 *
 * Unauthenticated, so `proxy.ts` lists it as public in both places — the target
 * group sends no session cookie, and a 307 to /login is not a 200.
 *
 * It says nothing about the deployment (no version, no commit): an
 * unauthenticated endpoint is answered for anybody who asks.
 */
export const dynamic = 'force-dynamic';

export function GET() {
  return Response.json({ ok: true }, { headers: { 'cache-control': 'no-store' } });
}
