// @vitest-environment node
/**
 * w5-02a — a notification as a Slack DM, through the outbox, against a real Postgres.
 *
 * End to end from `notify` to `drainOutbox`, with Slack's Web API stubbed at `fetch`: the
 * tenant connects its own Slack app (encrypted at rest), a person who opted into Slack gets a
 * DM with one link button, the id Slack resolved for them is cached, the subject's first DM
 * becomes its thread root and the next one is posted in that thread. And each way it does
 * not go out is recorded on the delivery row: Slack not connected, no Slack account for the
 * address, a cached id Slack refuses (which also clears the cache).
 *
 * Own org slug ('slack-co') because the DB suites share one database and each TRUNCATEs.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { withOrg } from '@/lib/tenant/context';
import { MemoryEmailTransport, setEmailTransport } from '@/lib/notifications/email';
import { drainOutbox } from '@/lib/notifications/dispatch';
import { notify, setPreference } from '@/lib/notifications/service';
import { disconnectSlack, saveSlackConnection } from '@/lib/notifications/slackConnection';
import { resetSlackWarnings } from '@/lib/notifications/slackDispatch';

process.env.SECRET_ENCRYPTION_KEY =
  process.env.SECRET_ENCRYPTION_KEY ?? Buffer.alloc(32, 17).toString('base64');

const ADMIN_URL = process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL;
if (!ADMIN_URL) throw new Error('slack-delivery.db.test.ts needs ADMIN_DATABASE_URL (or DATABASE_URL).');
const admin = new Pool({ connectionString: ADMIN_URL });
const mail = new MemoryEmailTransport();
let restoreTransport: (() => void) | null = null;

const EMPLOYEE = '019e3000-0000-7000-8000-000000000004';
const TOKEN = 'xoxb-test-token';
let orgId: string;
let ada: string;
let grace: string;
let reportId: string;

/** A stand-in for Slack's Web API: who has an account, and every message posted. */
const slack = {
  accounts: new Map<string, string>(),
  posts: [] as Array<Record<string, unknown> & { auth: string }>,
  lookups: 0,
  postError: null as string | null,
  lookupError: null as string | null,
  nextTs: 1,
};

function stubSlack() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init?: { body?: string; headers?: Record<string, string> }) => {
      const url = String(input);
      const auth = init?.headers?.authorization ?? '';
      const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
      if (url.startsWith('https://slack.com/api/users.lookupByEmail')) {
        slack.lookups += 1;
        if (slack.lookupError) return json({ ok: false, error: slack.lookupError });
        const email = new URL(url).searchParams.get('email') ?? '';
        const id = slack.accounts.get(email);
        return json(id ? { ok: true, user: { id } } : { ok: false, error: 'users_not_found' });
      }
      if (url === 'https://slack.com/api/chat.postMessage') {
        if (slack.postError) return json({ ok: false, error: slack.postError });
        const body = JSON.parse(init?.body ?? '{}') as Record<string, unknown>;
        slack.posts.push({ ...body, auth });
        return json({ ok: true, channel: `D-${body.channel as string}`, ts: `${slack.nextTs++}.0001` });
      }
      throw new Error(`unexpected fetch in test: ${url}`);
    }),
  );
}

async function mkUser(email: string, name: string) {
  return (
    await admin.query(
      `INSERT INTO app_user (organization_id, email, display_name, role_id)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [orgId, email, name, EMPLOYEE],
    )
  ).rows[0].id as string;
}

/** Grace comments on the report; ada is told. COMMENT's EMAIL is held for the digest, so
 *  only the Slack row is due at once. */
function comment(body: string, report = reportId) {
  return withOrg(orgId, (tx) =>
    notify(
      tx,
      { subjectType: 'EXPENSE_REPORT', subjectId: report, eventType: 'COMMENT', actorId: grace, payload: { body } },
      [ada],
    ),
  );
}

async function slackRows() {
  return (
    await admin.query(
      `SELECT status, destination, last_error FROM notification_delivery
        WHERE channel = 'SLACK' ORDER BY created_at`,
    )
  ).rows as Array<{ status: string; destination: string | null; last_error: string | null }>;
}

async function adaCache() {
  return (
    await admin.query('SELECT slack_user_id, slack_lookup_at FROM app_user WHERE id = $1', [ada])
  ).rows[0] as { slack_user_id: string | null; slack_lookup_at: Date | null };
}

const connect = () =>
  withOrg(orgId, (tx) => saveSlackConnection(tx, grace, { botToken: TOKEN, signingSecret: 'shh' }));

beforeAll(async () => {
  await admin.query('TRUNCATE app_user, organization CASCADE');
  orgId = (
    await admin.query("INSERT INTO organization (slug, name) VALUES ('slack-co', 'Slack Co') RETURNING id")
  ).rows[0].id;
  ada = await mkUser('ada@slack.test', 'Ada Lovelace');
  grace = await mkUser('grace@slack.test', 'Grace Hopper');
  reportId = (
    await admin.query(
      `INSERT INTO expense_report (organization_id, submitter_id, title, currency_code)
       VALUES ($1, $2, 'Lisbon offsite', 'CAD') RETURNING id`,
      [orgId, grace],
    )
  ).rows[0].id;
  // Slack is opt-in (ExpenseOS's default); ada opted in for comments.
  await withOrg(orgId, (tx) => setPreference(tx, ada, 'COMMENT', 'SLACK', true));
  process.env.APP_URL = 'https://velo.test';
  restoreTransport = setEmailTransport(mail);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

beforeEach(async () => {
  stubSlack();
  resetSlackWarnings();
  slack.accounts = new Map([['ada@slack.test', 'U-ADA']]);
  slack.posts = [];
  slack.lookups = 0;
  slack.postError = null;
  slack.lookupError = null;
  slack.nextTs = 1;
  await admin.query(
    `BEGIN;
     DELETE FROM notification_delivery;
     DELETE FROM notification;
     DELETE FROM activity;
     DELETE FROM reply_thread;
     DELETE FROM slack_connection;
     UPDATE app_user SET slack_user_id = NULL, slack_lookup_at = NULL;
     COMMIT;`,
  );
  await connect();
});

afterAll(async () => {
  restoreTransport?.();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await admin.end();
});

describe('connecting', () => {
  it('stores the token and the signing secret encrypted, never as typed', async () => {
    const row = (await admin.query('SELECT bot_token, signing_secret FROM slack_connection')).rows[0];
    expect(row.bot_token).toMatch(/^enc:v1:/);
    expect(row.signing_secret).toMatch(/^enc:v1:/);
    expect(JSON.stringify(row)).not.toContain(TOKEN);
  });

  it('keeps a stored secret when the field is left blank, and changes the one retyped', async () => {
    const before = (await admin.query('SELECT bot_token, signing_secret FROM slack_connection')).rows[0];
    await withOrg(orgId, (tx) =>
      saveSlackConnection(tx, grace, { botToken: '', signingSecret: 'new-secret' }),
    );
    const after = (await admin.query('SELECT bot_token, signing_secret FROM slack_connection')).rows[0];
    expect(after.bot_token).toBe(before.bot_token);
    expect(after.signing_secret).not.toBe(before.signing_secret);
  });
});

describe('a DM', () => {
  it('goes to the person Slack resolves from their email, with one link button', async () => {
    await comment('The hotel looks high.');
    const summary = await drainOutbox();
    expect(summary.sent).toBe(1);

    expect(slack.posts).toHaveLength(1);
    const post = slack.posts[0];
    expect(post.auth).toBe(`Bearer ${TOKEN}`);
    expect(post.channel).toBe('U-ADA');
    expect(post.thread_ts).toBeUndefined();
    const link = `https://velo.test/expenses/${reportId}`;
    expect(post.text).toContain(`<${link}|View expense report>`);
    expect(post.blocks).toEqual([
      { type: 'context', elements: [{ type: 'mrkdwn', text: '*Expense report*' }] },
      { type: 'section', text: { type: 'mrkdwn', text: expect.stringContaining('Grace Hopper') } },
      {
        type: 'actions',
        elements: [{ type: 'button', text: { type: 'plain_text', text: 'View expense report' }, url: link }],
      },
    ]);

    expect(await slackRows()).toEqual([{ status: 'SENT', destination: 'U-ADA', last_error: null }]);
    expect((await adaCache()).slack_user_id).toBe('U-ADA');
  });

  it('is not held for the digest, while the comment email is', async () => {
    // ExpenseOS's digest is email only; a Slack DM about a comment goes at once.
    await withOrg(orgId, (tx) => setPreference(tx, ada, 'COMMENT', 'EMAIL', true));
    await comment('Held?');
    await drainOutbox();
    expect(slack.posts).toHaveLength(1);
    const email = await admin.query(`SELECT status FROM notification_delivery WHERE channel = 'EMAIL'`);
    expect(email.rows.map((r) => r.status)).toEqual(['PENDING']);
    await withOrg(orgId, (tx) => setPreference(tx, ada, 'COMMENT', 'EMAIL', null));
  });

  it('makes the first DM about a report its thread root, and threads the next one under it', async () => {
    await comment('First.');
    await drainOutbox();
    const thread = (
      await admin.query('SELECT slack_channel_id, slack_thread_ts FROM reply_thread WHERE recipient_id = $1', [ada])
    ).rows[0];
    expect(thread).toEqual({ slack_channel_id: 'D-U-ADA', slack_thread_ts: '1.0001' });

    await comment('Second.');
    await drainOutbox();
    expect(slack.posts[1].thread_ts).toBe('1.0001');
    // The cached id is used, not asked for again.
    expect(slack.lookups).toBe(1);
  });

  it('escapes markup a person typed, so a report title cannot become a disguised link', async () => {
    const sneaky = (
      await admin.query(
        `INSERT INTO expense_report (organization_id, submitter_id, title, currency_code)
         VALUES ($1, $2, '<https://evil.example.test|Approve now>', 'CAD') RETURNING id`,
        [orgId, grace],
      )
    ).rows[0].id as string;
    await comment('<https://evil.example.test|click>', sneaky);
    await drainOutbox();
    const section = (slack.posts[0].blocks as Array<{ type: string; text?: { text: string } }>).find(
      (b) => b.type === 'section',
    );
    expect(section?.text?.text).not.toMatch(/<https:\/\/evil/);
    expect(slack.posts[0].text as string).not.toMatch(/<https:\/\/evil/);
  });

  it('is not enqueued for somebody who has not opted in', async () => {
    await withOrg(orgId, (tx) =>
      notify(
        tx,
        { subjectType: 'EXPENSE_REPORT', subjectId: reportId, eventType: 'COMMENT', actorId: ada, payload: { body: 'x' } },
        [grace],
      ),
    );
    expect(await slackRows()).toEqual([]);
  });
});

describe('a DM that does not go out says why', () => {
  it('when the organization has not connected Slack', async () => {
    await withOrg(orgId, (tx) => disconnectSlack(tx));
    await comment('Nobody connected Slack.');
    const summary = await drainOutbox();
    expect(summary.cancelled).toBe(1);
    const [row] = await slackRows();
    expect(row.status).toBe('CANCELLED');
    expect(row.last_error).toContain('/admin/slack');
    expect(slack.posts).toEqual([]);
  });

  it('when Slack has no account for the address — and that is cached as a negative', async () => {
    slack.accounts.clear();
    await comment('Unknown to Slack.');
    await drainOutbox();
    const [row] = await slackRows();
    expect(row.status).toBe('CANCELLED');
    expect(row.last_error).toContain('Slack has no account for ada@slack.test');
    const cache = await adaCache();
    expect(cache.slack_user_id).toBeNull();
    expect(cache.slack_lookup_at).not.toBeNull();
  });

  it('when Slack could not be asked: FAILED, to be retried, and nothing cached', async () => {
    slack.lookupError = 'ratelimited';
    await comment('Busy Slack.');
    const summary = await drainOutbox();
    expect(summary.failed).toBe(1);
    const [row] = await slackRows();
    expect(row.status).toBe('FAILED');
    expect(row.last_error).toContain('ratelimited');
    expect(await adaCache()).toEqual({ slack_user_id: null, slack_lookup_at: null });
  });

  it('when Slack refuses the cached id: FAILED, and the cache is cleared for the retry', async () => {
    await admin.query(
      `UPDATE app_user SET slack_user_id = 'U-GONE', slack_lookup_at = now() WHERE id = $1`,
      [ada],
    );
    slack.postError = 'channel_not_found';
    await comment('To a dead id.');
    await drainOutbox();
    const [row] = await slackRows();
    expect(row.status).toBe('FAILED');
    expect(row.last_error).toContain('channel_not_found');
    expect(await adaCache()).toEqual({ slack_user_id: null, slack_lookup_at: null });
  });
});
