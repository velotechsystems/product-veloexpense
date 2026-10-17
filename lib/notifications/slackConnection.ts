/**
 * w5-02a — the tenant's Slack connection: save it, test it, disconnect it.
 *
 * VeloExpense-built, not ported. ExpenseOS stores its one Slack app as an `integration`
 * installation and manages it through the generic Platform → Integrations screen (its
 * `secrets.ts`: secrets redacted on read, merged on write, encrypted at rest). VeloExpense
 * gives each tenant its own Slack app (decided 17 Oct 2026) in `slack_connection` (0074), so
 * this file is the small store that screen's generic code would otherwise have been. The
 * three rules are ExpenseOS's, and /admin/integrations states them too:
 *
 *   · a secret is NEVER returned — the view says whether one is set, nothing more;
 *   · a blank field on a save means "unchanged", so re-saving the form does not wipe a
 *     secret nobody retyped;
 *   · DISCONNECT DELETES the row, credentials and all.
 *
 * Every function runs on the caller's tenant transaction; `slack_connection` is under RLS.
 * Reading the decrypted config for a send is `getSlackConfigStatus` in ./slack.ts.
 */
import type { QueryRunner } from '@/lib/db/client';
import { DomainError } from '@/lib/errors/domain';
import { encryptSecret } from '@/lib/crypto/secrets';
import { getSlackConfigStatus, slackConfigProblem } from '@/lib/notifications/slack';

export class SlackConnectionError extends DomainError {
  constructor(message: string, userMessage: 'SLACK_TOKEN_REQUIRED' | 'SLACK_NOT_CONNECTED') {
    super(message, userMessage);
    this.name = 'SlackConnectionError';
  }
}

/** What the admin screen may know. No secret, in any form. */
export interface SlackConnectionView {
  connected: boolean;
  signingSecretSet: boolean;
  connectedAt: Date | null;
  connectedByName: string | null;
  lastTestAt: Date | null;
  lastTestOk: boolean | null;
  lastTestError: string | null;
}

const NOT_CONNECTED: SlackConnectionView = {
  connected: false,
  signingSecretSet: false,
  connectedAt: null,
  connectedByName: null,
  lastTestAt: null,
  lastTestOk: null,
  lastTestError: null,
};

export async function getSlackConnection(tx: QueryRunner): Promise<SlackConnectionView> {
  const r = await tx.query(
    `SELECT s.signing_secret IS NOT NULL AS signing_secret_set,
            s.connected_at, s.last_test_at, s.last_test_ok, s.last_test_error,
            COALESCE(u.display_name, u.email) AS connected_by_name
       FROM slack_connection s
       LEFT JOIN app_user u ON u.id = s.connected_by_id`,
  );
  const row = r.rows[0];
  if (!row) return NOT_CONNECTED;
  return {
    connected: true,
    signingSecretSet: Boolean(row.signing_secret_set),
    connectedAt: row.connected_at as Date,
    connectedByName: (row.connected_by_name as string | null) ?? null,
    lastTestAt: (row.last_test_at as Date | null) ?? null,
    lastTestOk: (row.last_test_ok as boolean | null) ?? null,
    lastTestError: (row.last_test_error as string | null) ?? null,
  };
}

/**
 * Connect, or change the stored secrets.
 *
 * The bot token is required to connect (ExpenseOS's schema: `required: ['botToken']`). The
 * signing secret is optional, as ExpenseOS's is — "so an install can be completed before the
 * app is finished in Slack" — and only inbound replies need it. On an existing connection a
 * blank field keeps what is stored; a changed token clears the last test, which was about
 * the old one.
 */
export async function saveSlackConnection(
  tx: QueryRunner,
  actorId: string,
  input: { botToken: string; signingSecret: string },
): Promise<void> {
  const botToken = input.botToken.trim();
  const signingSecret = input.signingSecret.trim();
  const existing = await tx.query(`SELECT 1 FROM slack_connection`);

  if (existing.rows.length === 0) {
    if (!botToken) {
      throw new SlackConnectionError('connecting Slack needs a bot token', 'SLACK_TOKEN_REQUIRED');
    }
    await tx.query(
      `INSERT INTO slack_connection (bot_token, signing_secret, connected_by_id)
       VALUES ($1, $2, $3)`,
      [encryptSecret(botToken), signingSecret ? encryptSecret(signingSecret) : null, actorId],
    );
    return;
  }

  if (!botToken && !signingSecret) return;
  await tx.query(
    `UPDATE slack_connection
        SET bot_token = COALESCE($1, bot_token),
            signing_secret = COALESCE($2, signing_secret),
            last_test_at    = CASE WHEN $1::text IS NULL THEN last_test_at END,
            last_test_ok    = CASE WHEN $1::text IS NULL THEN last_test_ok END,
            last_test_error = CASE WHEN $1::text IS NULL THEN last_test_error END,
            updated_at = clock_timestamp()`,
    [botToken ? encryptSecret(botToken) : null, signingSecret ? encryptSecret(signingSecret) : null],
  );
}

/**
 * The stored bot token, for a test — or, when it cannot be used, the failed test's answer.
 *
 * `unreadable` and `no-bot-token` are not errors here: a test that cannot even read the
 * token HAS an answer, and it belongs on the row like any other (ExpenseOS's
 * `slackConfigProblem` sentence). Only "not connected" is refused, because there is no row
 * to record anything on.
 */
export async function slackTokenForTest(
  tx: QueryRunner,
): Promise<{ token: string } | { token: null; failed: { ok: false; message: string } }> {
  const status = await getSlackConfigStatus(tx);
  if (status.state === 'ok') return { token: status.botToken };
  if (status.state === 'not-installed') {
    throw new SlackConnectionError('there is no Slack connection to test', 'SLACK_NOT_CONNECTED');
  }
  return {
    token: null,
    failed: {
      ok: false,
      message: slackConfigProblem(
        status.state,
        status.state === 'unreadable' ? status.detail : undefined,
      ),
    },
  };
}

/**
 * Record what ExpenseOS's "Test connection" (`verifySlackToken`, `auth.test`) said.
 *
 * The call itself is made OUTSIDE any transaction — the caller reads the token with
 * `slackTokenForTest`, calls `verifySlackToken`, then records the answer here — so a slow
 * Slack does not hold a pooled connection. Like ExpenseOS's, the test does not check scopes:
 * `auth.test` passes with none.
 */
export async function recordSlackTest(
  tx: QueryRunner,
  result: { ok: boolean; message: string },
): Promise<void> {
  await tx.query(
    `UPDATE slack_connection
        SET last_test_at = clock_timestamp(), last_test_ok = $1, last_test_error = $2,
            updated_at = clock_timestamp()`,
    [result.ok, result.ok ? null : result.message],
  );
}

/** Delete the connection and its credentials. */
export async function disconnectSlack(tx: QueryRunner): Promise<void> {
  await tx.query(`DELETE FROM slack_connection`);
}
