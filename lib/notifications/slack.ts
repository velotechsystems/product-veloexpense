/**
 * Slack delivery via the Web API (chat.postMessage). One Slack app per tenant
 * (ExpenseOS: "one org-wide Slack app"): the bot token comes from the tenant's
 * Slack connection, and a DM is opened to the recipient's Slack user id.
 * Best-effort — callers treat failures as non-fatal (in-app delivery already
 * happened).
 *
 * w5-02a — ported from ExpenseOS `packages/notifications/src/slack.ts` (1e682dd6). Everything
 * below is theirs except where it says "VeloExpense:":
 *   · the app is the TENANT's (decided 17 Oct 2026): each tenant pastes its own Slack app's
 *     bot token and signing secret at /admin/slack, stored in `slack_connection` (0074), one
 *     row per tenant, rather than in an `integration` installation — VeloExpense's
 *     `integration_installation` is the accounting ledger's table;
 *   · the secrets are decrypted by `lib/crypto/secrets.ts` (AES-GCM in Node, under
 *     `SECRET_ENCRYPTION_KEY`), where ExpenseOS's go through pgcrypto under `PG_CRYPTO_KEY`;
 *   · the config is read on the caller's tenant transaction (`QueryRunner`), so RLS hands
 *     back this tenant's app and nobody else's.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { QueryRunner } from '@/lib/db/client';
import { decryptSecret } from '@/lib/crypto/secrets';

/**
 * Why Slack is unusable right now. Four states, and the whole reason they are named
 * rather than collapsed into `null`: three of them used to be indistinguishable.
 *
 *   · `not-installed` — nobody has set Slack up.
 *   · `no-bot-token` — somebody set it up, saved a signing secret, and left the token
 *     blank. Both inbound routes read the secret THROUGH this function, so they used to
 *     answer `503 not configured` for an install that is very much configured — and the
 *     operator, looking at a filled-in signing-secret field, had nothing to go on.
 *   · `no-signing-secret` — outbound DMs work; anything inbound cannot be verified.
 *   · `unreadable` — the config is encrypted and this process cannot decrypt it. In
 *     practice that is `PG_CRYPTO_KEY` missing from the WORKER's environment, which
 *     surfaced only as `[notification.dispatch] slack failed` with a bare Error.
 *
 * VeloExpense: `no-bot-token` cannot arise from /admin/slack — the token is required to
 * connect, `slack_connection.bot_token` is NOT NULL, and a blank field on an edit keeps the
 * stored token — so it is reachable only by a row whose token decrypts to blank. Kept, so
 * that row is named rather than sent to Slack.
 */
export type SlackConfigState =
  | 'ok'
  | 'not-installed'
  | 'no-bot-token'
  | 'no-signing-secret'
  | 'unreadable';

export type SlackConfigStatus =
  | { state: 'ok'; botToken: string; signingSecret: string | null }
  | { state: 'not-installed' }
  | { state: 'no-bot-token' }
  | { state: 'unreadable'; detail: string };

/**
 * One sentence naming what is wrong and the next action — for a log line an operator
 * greps, or a `503` body Slack shows back in its own request log.
 *
 * Not translated, and deliberately so: the reader is whoever is holding the deployment,
 * and every proper noun in it (`PG_CRYPTO_KEY`, `xoxb-`, the runbook path) has to survive
 * verbatim.
 *
 * VeloExpense: each sentence names /admin/slack and `SECRET_ENCRYPTION_KEY`, where
 * ExpenseOS's name /admin/integrations and `PG_CRYPTO_KEY`.
 */
export function slackConfigProblem(state: SlackConfigState, detail?: string): string {
  switch (state) {
    case 'not-installed':
      return 'Slack is not connected for this organization — an administrator connects it at /admin/slack';
    case 'no-bot-token':
      return 'Slack is connected but its BOT TOKEN is blank — a signing secret on its own does nothing; paste the Bot User OAuth Token (xoxb-…) at /admin/slack';
    case 'no-signing-secret':
      return 'Slack has no SIGNING SECRET saved, so an inbound Slack request cannot be verified — copy it from Basic Information → App Credentials in api.slack.com/apps and paste it at /admin/slack';
    case 'unreadable':
      return `the Slack connection could not be decrypted (${detail ?? 'unknown error'}) — SECRET_ENCRYPTION_KEY must be set in THIS process, and it must be the key the connection was saved under`;
    default:
      return 'Slack is usable';
  }
}

/** `slackConfigProblem`, plus where to read the long version. */
export function slackConfigAdvice(state: SlackConfigState, detail?: string): string {
  return `${slackConfigProblem(state, detail)}. See docs/runbooks/slack-setup.md.`;
}

/**
 * The tenant's Slack config, or a named reason it cannot be used.
 *
 * Never throws. A decryption failure is a state, not an exception, because both callers
 * are on paths where an exception is worse than a diagnosis: the worker swallows it into
 * a generic warning, and a route turns it into a `500` that Slack retries forever.
 *
 * VeloExpense: runs on the caller's tenant transaction — `slack_connection` is under RLS,
 * so this is the current tenant's row or none.
 */
export async function getSlackConfigStatus(tx: QueryRunner): Promise<SlackConfigStatus> {
  const r = await tx.query(`SELECT bot_token, signing_secret FROM slack_connection`);
  const raw = r.rows[0] as { bot_token: string; signing_secret: string | null } | undefined;
  if (!raw) return { state: 'not-installed' };
  // Secrets (botToken, signingSecret) are stored encrypted at rest (PLATFORM-01).
  let cfg: { botToken?: string; signingSecret?: string };
  try {
    cfg = {
      botToken: decryptSecret(raw.bot_token),
      signingSecret: raw.signing_secret ? decryptSecret(raw.signing_secret) : undefined,
    };
  } catch (e) {
    return { state: 'unreadable', detail: e instanceof Error ? e.message : String(e) };
  }
  const botToken = cfg.botToken?.trim();
  if (!botToken) return { state: 'no-bot-token' };
  return { state: 'ok', botToken, signingSecret: cfg.signingSecret?.trim() || null };
}

/** What the INBOUND route (`/api/slack/events`) needs: a bot token AND a signing
 *  secret. Collapses the four unusable states into one refusal that says which. */
export type SlackInboundGate =
  | { ok: true; botToken: string; signingSecret: string }
  | { ok: false; state: Exclude<SlackConfigState, 'ok'>; message: string };

export async function slackInboundGate(tx: QueryRunner): Promise<SlackInboundGate> {
  const status = await getSlackConfigStatus(tx);
  if (status.state !== 'ok') {
    const detail = status.state === 'unreadable' ? status.detail : undefined;
    return { ok: false, state: status.state, message: slackConfigAdvice(status.state, detail) };
  }
  if (!status.signingSecret) {
    return {
      ok: false,
      state: 'no-signing-secret',
      message: slackConfigAdvice('no-signing-secret'),
    };
  }
  return { ok: true, botToken: status.botToken, signingSecret: status.signingSecret };
}

/** Verify a Slack request signature (X-Slack-Signature over the RAW body) with
 *  a 5-minute replay window. Constant-time compare. */
export function verifySlackSignature(
  signingSecret: string,
  timestamp: string | null,
  rawBody: string,
  signature: string | null,
): boolean {
  if (!timestamp || !signature) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 300) return false;
  const mine = `v0=${createHmac('sha256', signingSecret).update(`v0:${timestamp}:${rawBody}`).digest('hex')}`;
  const a = Buffer.from(mine);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface SlackMessage {
  /** Slack user id (e.g. U0123…) to DM, or a channel id. */
  channel: string;
  /** Plain-text fallback (notification preview + clients without Block Kit). */
  text: string;
  /** Optional Block Kit blocks (e.g. action URL buttons). */
  blocks?: unknown[];
  /** Post as a reply in this message's thread (parent message ts). */
  threadTs?: string;
}

/** The posted message's ids — needed to thread later notifications and to map
 *  inbound thread replies back to the subject (see ReplyThread). */
export interface SlackPostRef {
  channel: string;
  ts: string;
}

const SLACK_API = 'https://slack.com/api/chat.postMessage';

/**
 * A Slack Web API call that came back `ok:false` (or an HTTP error), carrying Slack's own
 * error code as data rather than only inside the message.
 *
 * The message is unchanged from what this used to throw, because it is what a log reader
 * greps for. What is new is `slackError`: the dispatcher has to distinguish "this DM is
 * addressed to a Slack id that no longer exists" — which means the cached id is stale and
 * must be dropped — from every other reason a post can fail, and parsing that back out of
 * a sentence is how the string becomes load-bearing by accident.
 */
export class SlackApiError extends Error {
  readonly method: string;
  readonly slackError: string;

  constructor(method: string, slackError: string) {
    super(`slack: ${method} failed (${slackError})`);
    this.name = 'SlackApiError';
    this.method = method;
    this.slackError = slackError;
  }
}

/**
 * Slack errors that mean *this recipient id is not reachable* — the id we cached is stale
 * (the Slack account was deleted, or the person now has a different one), not the message.
 *
 * `account_inactive` is deliberately absent: that one is about the BOT's own workspace, so
 * treating it as a stale recipient would blank every user's cached id one dispatch at a
 * time while the real problem was the token.
 */
const UNREACHABLE_RECIPIENT: ReadonlySet<string> = new Set([
  'channel_not_found',
  'user_not_found',
  'users_not_found',
]);

/** True when the failure says the cached Slack id is wrong, so it should be forgotten and
 *  re-resolved from the person's email on the next attempt. */
export function isStaleSlackRecipient(err: unknown): boolean {
  return err instanceof SlackApiError && UNREACHABLE_RECIPIENT.has(err.slackError);
}

/** Post a message via the Slack Web API; returns the posted message's
 *  channel + ts. Throws on a transport error or a Slack `ok:false` response so
 *  the caller can log/retry. */
export async function sendSlack(botToken: string, msg: SlackMessage): Promise<SlackPostRef> {
  const res = await fetch(SLACK_API, {
    method: 'POST',
    headers: {
      'content-type': 'application/json; charset=utf-8',
      authorization: `Bearer ${botToken}`,
    },
    body: JSON.stringify({
      channel: msg.channel,
      text: msg.text,
      ...(msg.blocks ? { blocks: msg.blocks } : {}),
      ...(msg.threadTs ? { thread_ts: msg.threadTs } : {}),
    }),
  });
  const body = ((await res.json().catch(() => null)) ?? {}) as {
    ok?: boolean;
    error?: string;
    ts?: string;
    channel?: string;
  };
  if (!res.ok || !body.ok || !body.ts) {
    throw new SlackApiError('chat.postMessage', String(body.error ?? res.status));
  }
  return { channel: body.channel ?? msg.channel, ts: body.ts };
}

/** Probe a bot token via auth.test for the admin "Test connection" button. */
export async function verifySlackToken(
  botToken: string,
): Promise<{ ok: boolean; message: string }> {
  try {
    const res = await fetch('https://slack.com/api/auth.test', {
      method: 'POST',
      headers: { authorization: `Bearer ${botToken}` },
    });
    const body = ((await res.json().catch(() => null)) ?? {}) as {
      ok?: boolean;
      error?: string;
      team?: string;
      user?: string;
    };
    if (body.ok) {
      return { ok: true, message: `Connected as ${body.user ?? '?'} in ${body.team ?? '?'}.` };
    }
    return { ok: false, message: `Slack rejected the token: ${body.error ?? res.status}` };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * What `users.lookupByEmail` actually said.
 *
 * Three outcomes, not two, because the caller CACHES the answer for days and the old
 * `string | null` made two very different things look the same. `null` meant both "Slack
 * is certain no user has this address" and "the call did not complete" — a rate limit, a
 * revoked token, a missing scope, a 502 from Slack. The second was then written to the
 * database as a confirmed negative and suppressed every further attempt for a week.
 */
export type SlackUserLookup =
  | { outcome: 'found'; userId: string }
  | { outcome: 'not_found' }
  | { outcome: 'inconclusive'; detail: string };

/** Resolve a Slack user id from an email via users.lookupByEmail. */
export async function lookupSlackUser(botToken: string, email: string): Promise<SlackUserLookup> {
  let res: { ok: boolean; status: number; json: () => Promise<unknown> };
  try {
    res = await fetch(
      `https://slack.com/api/users.lookupByEmail?email=${encodeURIComponent(email)}`,
      { headers: { authorization: `Bearer ${botToken}` } },
    );
  } catch (e) {
    return { outcome: 'inconclusive', detail: e instanceof Error ? e.message : String(e) };
  }
  const body = ((await res.json().catch(() => null)) ?? {}) as {
    ok?: boolean;
    error?: string;
    user?: { id?: string };
  };
  if (body.ok && body.user?.id) return { outcome: 'found', userId: body.user.id };
  // `users_not_found` is the only answer that is ABOUT the person. Everything else —
  // `ratelimited`, `invalid_auth`, `missing_scope`, a 5xx with no JSON at all — is about
  // the call, and says nothing whatsoever about whether they have a Slack account.
  if (body.error === 'users_not_found') return { outcome: 'not_found' };
  return { outcome: 'inconclusive', detail: body.error ?? `HTTP ${res.status}` };
}
