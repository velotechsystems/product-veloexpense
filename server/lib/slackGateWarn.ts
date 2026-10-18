/**
 * Say why an inbound Slack request is being refused — once per reason, per route, per
 * process.
 *
 * Both Slack endpoints refuse for the same four reasons and both are hammered when they
 * do: Slack retries a failed delivery and then redelivers the backlog, so an
 * unconditional log line is a flood that buries itself.
 *
 * Per REASON rather than once outright, because the reasons get fixed in sequence. An
 * operator pastes a bot token and restarts nothing; the next thing they need to be told
 * is that the signing secret is still missing, and a single latch would have swallowed
 * exactly that message.
 *
 * It lives here rather than beside the handlers because a Next.js `route.ts` may only
 * export request methods and route config — an exported helper (or the reset the tests
 * need) fails the generated route-type check at build time.
 *
 * w5-02b — ExpenseOS's `apps/web/src/server/lib/slackGateWarn.ts` (1e682dd6), unchanged but
 * for the import. VeloExpense has one Slack endpoint (events); ExpenseOS's interactions
 * route was retired before the port.
 */
import type { SlackConfigState } from '@/lib/notifications/slack';

const warned = new Map<string, Set<SlackConfigState>>();

export function warnSlackGateOnce(route: string, state: SlackConfigState, message: string): void {
  let seen = warned.get(route);
  if (!seen) {
    seen = new Set();
    warned.set(route, seen);
  }
  if (seen.has(state)) return;
  seen.add(state);
  console.warn(`[${route}] refusing the request — ${message}`);
}

/** Drop the latches. Exported for tests: they are module-level, so the first test to trip
 *  one silences every later test that asserts on it. */
export function resetSlackGateWarnings(): void {
  warned.clear();
}
