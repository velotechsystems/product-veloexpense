#!/usr/bin/env node
/**
 * POST one `/api/internal/*` route with WORKER_SECRET — what a scheduled job runs.
 *
 *   node scripts/tick.mjs /api/internal/notifications/drain
 *
 * HANDOFF: "THE SCHEDULER LIVES OUTSIDE THE CODEBASE. Nothing calls
 * /api/internal/notifications/drain yet." In a deployed environment this is that
 * caller: EventBridge Scheduler runs this in a one-off Fargate task, one task
 * definition per route (infrastructure/cdk compute-stack.ts).
 *
 * It calls the PUBLIC origin (APP_URL), through Cloudflare and the shared ALB,
 * exactly as an outside scheduler would. There is no private path to the web
 * task, and making one would mean a second way in to maintain.
 *
 * Exit status is the signal: 0 on a 2xx, 1 otherwise, so a failing job shows as
 * a failed task. The internal routes answer 404 to a wrong or missing secret
 * (on purpose — see the drain route), so a 404 here almost always means
 * WORKER_SECRET differs between this task and the web task, not a missing route.
 *
 * Prints the status and the start of the response body, which for these routes
 * is a summary (counts). Never the secret.
 */
const path = process.argv[2];
const origin = process.env.APP_URL?.trim().replace(/\/+$/, '');
const secret = process.env.WORKER_SECRET?.trim();

if (!path || !path.startsWith('/api/internal/')) {
  console.error('tick: usage: node scripts/tick.mjs /api/internal/<route>');
  process.exit(1);
}
if (!origin || !secret) {
  console.error(`tick: ${!origin ? 'APP_URL' : 'WORKER_SECRET'} is not set.`);
  process.exit(1);
}

const started = Date.now();
try {
  const res = await fetch(`${origin}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${secret}` },
    redirect: 'manual', // a redirect here is a misconfiguration to see, not to follow
    signal: AbortSignal.timeout(110_000),
  });
  const body = (await res.text()).slice(0, 500).replace(/\s+/g, ' ');
  const line = `tick ${path} -> ${res.status} in ${Date.now() - started}ms: ${body}`;
  if (res.status >= 200 && res.status < 300) {
    console.log(line);
  } else {
    console.error(
      res.status === 404
        ? `${line}\ntick: 404 from an internal route usually means WORKER_SECRET does not match the web task's.`
        : line,
    );
    process.exitCode = 1;
  }
} catch (err) {
  console.error(`tick ${path} failed after ${Date.now() - started}ms: ${err instanceof Error ? err.message : err}`);
  process.exitCode = 1;
}
