// @vitest-environment node
/**
 * w5-02b — a reply in a Slack DM thread becomes a COMMENT, against a real Postgres.
 *
 * `POST /api/slack/events` end to end, with requests signed exactly as Slack signs them: the
 * tenant comes from the address, that tenant's signing secret verifies the raw body, the
 * thread root maps back to the report, the replier must be the person the thread is for, and
 * the comment is posted as them with `via: 'slack'`. The mock-level cases (every ignored
 * event shape, the retry contract) are ExpenseOS's, in `app/api/slack/events/route.test.ts`.
 *
 * Redis is not here, so the dedup claim is stubbed to always succeed. Own org slugs
 * ('slack-re', 'slack-other') because the DB suites share one database and each TRUNCATEs.
 */
import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { withOrg } from '@/lib/tenant/context';
import { saveSlackConnection } from '@/lib/notifications/slackConnection';
import { resetSlackGateWarnings } from '@/server/lib/slackGateWarn';

vi.mock('@/server/lib/inboundDedup', () => ({
  claimOnce: vi.fn(async () => true),
  releaseClaim: vi.fn(async () => undefined),
}));

import { POST } from '@/app/api/slack/events/route';

process.env.SECRET_ENCRYPTION_KEY =
  process.env.SECRET_ENCRYPTION_KEY ?? Buffer.alloc(32, 19).toString('base64');

const ADMIN_URL = process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL;
if (!ADMIN_URL) throw new Error('slack-replies.db.test.ts needs ADMIN_DATABASE_URL (or DATABASE_URL).');
const admin = new Pool({ connectionString: ADMIN_URL });

const EMPLOYEE = '019e3000-0000-7000-8000-000000000004';
const APEX = 'velo.example.test';
const SECRET = 'acme-signing-secret';
const OTHER_SECRET = 'other-signing-secret';
let orgId: string;
let otherOrgId: string;
let grace: string;
let reportId: string;
let n = 0;

const HOST = `slack-re.${APEX}`;
const OTHER_HOST = `slack-other.${APEX}`;

function sign(secret: string, body: string, ts = String(Math.floor(Date.now() / 1000))) {
  return {
    'x-slack-request-timestamp': ts,
    'x-slack-signature': `v0=${createHmac('sha256', secret).update(`v0:${ts}:${body}`).digest('hex')}`,
  };
}

/** A reply event, signed with `secret`, posted to `host`. */
function reply(
  over: Record<string, unknown> = {},
  { host = HOST, secret = SECRET }: { host?: string; secret?: string } = {},
) {
  const body = JSON.stringify({
    type: 'event_callback',
    event_id: `Ev${++n}`,
    event: {
      type: 'message',
      user: 'U-GRACE',
      channel: 'D-GRACE',
      thread_ts: '100.0001',
      text: 'Receipts are attached &amp; the &lt;hotel&gt; was booked by HR.',
      ...over,
    },
  });
  return POST(
    new Request(`https://${host}/api/slack/events`, {
      method: 'POST',
      body,
      headers: { host, 'content-type': 'application/json', ...sign(secret, body) },
    }),
  );
}

async function comments() {
  return (
    await admin.query(
      `SELECT actor_id, subject_id, payload FROM activity WHERE event_type = 'COMMENT' ORDER BY occurred_at`,
    )
  ).rows as Array<{ actor_id: string; subject_id: string; payload: { body: string; via: string } }>;
}

async function mkOrg(slug: string) {
  return (
    await admin.query(`INSERT INTO organization (slug, name) VALUES ($1, $1) RETURNING id`, [slug])
  ).rows[0].id as string;
}

beforeAll(async () => {
  process.env.AUTH_COOKIE_DOMAIN = `.${APEX}`;
  await admin.query('TRUNCATE app_user, organization CASCADE');
  orgId = await mkOrg('slack-re');
  otherOrgId = await mkOrg('slack-other');
  grace = (
    await admin.query(
      `INSERT INTO app_user (organization_id, email, display_name, role_id, slack_user_id, slack_lookup_at)
       VALUES ($1, 'grace@slack.test', 'Grace Hopper', $2, 'U-GRACE', now()) RETURNING id`,
      [orgId, EMPLOYEE],
    )
  ).rows[0].id;
  const otherUser = (
    await admin.query(
      `INSERT INTO app_user (organization_id, email, display_name, role_id)
       VALUES ($1, 'ada@other.test', 'Ada', $2) RETURNING id`,
      [otherOrgId, EMPLOYEE],
    )
  ).rows[0].id as string;
  reportId = (
    await admin.query(
      `INSERT INTO expense_report (organization_id, submitter_id, title, currency_code)
       VALUES ($1, $2, 'Lisbon offsite', 'CAD') RETURNING id`,
      [orgId, grace],
    )
  ).rows[0].id;
  // Grace's DM thread about her report: the root her first notification set.
  await admin.query(
    `INSERT INTO reply_thread (organization_id, subject_type, subject_id, recipient_id, slack_channel_id, slack_thread_ts)
     VALUES ($1, 'EXPENSE_REPORT', $2, $3, 'D-GRACE', '100.0001')`,
    [orgId, reportId, grace],
  );
  await withOrg(orgId, (tx) =>
    saveSlackConnection(tx, grace, { botToken: 'xoxb-acme', signingSecret: SECRET }),
  );
  await withOrg(otherOrgId, (tx) =>
    saveSlackConnection(tx, otherUser, { botToken: 'xoxb-other', signingSecret: OTHER_SECRET }),
  );
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

beforeEach(async () => {
  resetSlackGateWarnings();
  await admin.query(
    `BEGIN;
     DELETE FROM notification_delivery;
     DELETE FROM notification;
     DELETE FROM activity;
     COMMIT;`,
  );
});

afterAll(async () => {
  delete process.env.AUTH_COOKIE_DOMAIN;
  vi.restoreAllMocks();
  await admin.end();
});

describe('a reply in the thread', () => {
  it('becomes a comment on the report, from the person the thread is for', async () => {
    const res = await reply();
    expect(res.status).toBe(200);
    const posted = await comments();
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ actor_id: grace, subject_id: reportId });
    // Slack's escaping undone, and marked as having arrived from Slack.
    expect(posted[0].payload).toMatchObject({
      body: 'Receipts are attached & the <hotel> was booked by HR.',
      via: 'slack',
    });
  });

  it('is refused from anybody else in the conversation', async () => {
    await reply({ user: 'U-SOMEONE-ELSE' });
    expect(await comments()).toEqual([]);
  });

  it('is ignored outside a thread we started', async () => {
    await reply({ thread_ts: '999.0001' });
    await reply({ thread_ts: undefined });
    expect(await comments()).toEqual([]);
  });
});

describe('one tenant’s Slack app, one tenant', () => {
  it('refuses a request signed by another tenant’s app', async () => {
    // The other tenant's own secret, at this tenant's address: the signature is valid for
    // THEIR app and means nothing here.
    const res = await reply({}, { secret: OTHER_SECRET });
    expect(res.status).toBe(401);
    expect(await comments()).toEqual([]);
  });

  it('finds nothing to comment on when the thread is another tenant’s', async () => {
    // Correctly signed for the other tenant, at the other tenant's address — but the thread
    // root is this tenant's, so the lookup inside the other tenant finds nothing.
    const res = await reply({}, { host: OTHER_HOST, secret: OTHER_SECRET });
    expect(res.status).toBe(200);
    expect(await comments()).toEqual([]);
  });

  it('404s an address that is not a tenant', async () => {
    const res = await reply({}, { host: `nobody-here.${APEX}` });
    expect(res.status).toBe(404);
  });
});

describe('a tenant whose Slack app cannot verify anything yet', () => {
  it('503s with the reason, and still answers the setup handshake', async () => {
    await admin.query('UPDATE slack_connection SET signing_secret = NULL WHERE organization_id = $1', [orgId]);
    try {
      const res = await reply();
      expect(res.status).toBe(503);
      await expect(res.text()).resolves.toContain('SIGNING SECRET');

      const body = JSON.stringify({ type: 'url_verification', challenge: 'c-1' });
      const hello = await POST(
        new Request(`https://${HOST}/api/slack/events`, { method: 'POST', body, headers: { host: HOST } }),
      );
      await expect(hello.json()).resolves.toEqual({ challenge: 'c-1' });
    } finally {
      await withOrg(orgId, (tx) =>
        saveSlackConnection(tx, grace, { botToken: '', signingSecret: SECRET }),
      );
    }
  });
});
