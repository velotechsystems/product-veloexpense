// @vitest-environment node
/**
 * w5-01 — replying to a notification email posts a comment, against a real Postgres.
 *
 * Both halves, end to end: the outbound email about a report carries a `reply+<token>@`
 * Reply-To on the tenant's address (ExpenseOS's notification dispatch), and a reply stored
 * where SES would put it, handed to `email.ingestReply`, becomes a COMMENT on that report
 * from the person it was addressed to, told to the rest of the thread (ExpenseOS's inbound
 * reply path). The refusals are the ones ExpenseOS's path makes — an unknown token, a sender
 * who is not the recipient — plus VeloExpense's two: the message's own From must be the
 * authenticated sender, and an auto-submitted message is not a comment.
 *
 * Own org slug ('reply-co') because the DB suites share one database and each TRUNCATEs.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import * as expenses from '@/lib/expenses/service';
import {
  MemoryEmailTransport,
  resetEmailTransport,
  setEmailTransport,
} from '@/lib/notifications/email';
import { drainOutbox } from '@/lib/notifications/dispatch';
import { MemoryStorage, setInboundMailStorage } from '@/lib/storage';
import { withTenantDb, withTenantStatements } from '@/lib/db/prisma';
import { ensureReplyThread, issueEmailReplyToken } from '@/lib/notifications/replyThreads';
import { handleIngestReplyEmail } from '../worker/src/handlers/ingest-reply-email';
import { seedDefaultFlow, submitAsApp, withTenantTx as withOrg } from './support/tenant-tx';
import { TEST_ACTOR } from './support/audit-actor';
import { TODAY } from './support/dates';

vi.mock('@/auth', () => ({ auth: vi.fn(async () => null) }));
vi.mock('@/lib/tenant/request', () => ({ hostTenantSlug: async () => null }));

const ADMIN_URL = process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL;
if (!ADMIN_URL) throw new Error('reply-threads.db.test.ts needs ADMIN_DATABASE_URL (or DATABASE_URL).');
const admin = new Pool({ connectionString: ADMIN_URL });

const DOMAIN = 'mail.velo.test';
const SUBMITTER = 'sub@reply.test';
const MANAGER = 'mgr@reply.test';
const mail = new MemoryEmailTransport();
const inbound = new MemoryStorage();
let orgId: string;
let submitter: string;
let manager: string;
let categoryId: string;
let n = 0;

async function mkUser(email: string, role: string, managerId: string | null = null) {
  return withOrg(orgId, async (tx) => {
    const r = await tx.query(
      `INSERT INTO app_user (organization_id, email, display_name, role_id, manager_id)
       VALUES (current_setting('app.current_org', true)::uuid, $1, $2, $3, $4) RETURNING id`,
      [
        email,
        email === MANAGER ? 'Margaret Manager' : 'Sam Submitter',
        role === 'ADMIN' ? '019e3000-0000-7000-8000-000000000001' : '019e3000-0000-7000-8000-000000000004',
        managerId,
      ],
    );
    return r.rows[0].id as string;
  });
}

/** A submitted report: the manager gets TASK_ASSIGNED, and so an email about it. */
async function submitted(title = 'Lisbon offsite') {
  const reportId = await withOrg(orgId, async (tx) => {
    const report = await expenses.createReport(tx, SUBMITTER, { title, currencyCode: 'CAD' });
    const expense = await expenses.addExpense(tx, TEST_ACTOR, report.id, {
      txnDate: TODAY,
      currencyCode: 'CAD',
      merchant: 'M',
    });
    await expenses.addLineItem(tx, TEST_ACTOR, expense.id, { categoryId, amountMinor: 12000 });
    return report.id as string;
  });
  await submitAsApp(orgId, reportId, submitter);
  return reportId;
}

/** The token in a `reply+<token>@` address. */
const tokenOf = (replyTo: string | undefined) => replyTo?.match(/^reply\+([^@]+)@/)?.[1] ?? '';

function mime(from: string, body: string, extra: string[] = []): string {
  return [
    `From: ${from}`,
    `To: reply+x@reply-co.${DOMAIN}`,
    'Subject: Re: Lisbon offsite',
    `Message-ID: <r-${++n}@mail.test>`,
    ...extra,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    '',
    body,
    '',
  ].join('\r\n');
}

/** Store `raw` where SES would have, and run the job the route would enqueue. */
async function reply(token: string, sender: string, raw: string) {
  const objectKey = `inbound/reply-${++n}`;
  inbound.put(objectKey, raw, 'message/rfc822');
  await withTenantStatements(orgId, () =>
    handleIngestReplyEmail({
      bucket: 'inbound-bucket',
      objectKey,
      sesMessageId: `ses-${n}`,
      token,
      sender,
      organizationId: orgId,
    }),
  );
}

async function comments() {
  return (
    await admin.query(
      `SELECT a.actor_id, a.payload, a.subject_id FROM activity a
        WHERE a.event_type = 'COMMENT' ORDER BY a.occurred_at`,
    )
  ).rows as Array<{ actor_id: string; payload: { body: string; via: string }; subject_id: string }>;
}

/** The manager's TASK_ASSIGNED email for a freshly submitted report. */
async function managersEmail() {
  const reportId = await submitted();
  await drainOutbox();
  const email = mail.sent.find((m) => m.to === MANAGER);
  if (!email) throw new Error('no email to the manager');
  return { reportId, email };
}

beforeAll(async () => {
  await admin.query('TRUNCATE app_user, organization CASCADE');
  orgId = (
    await admin.query("INSERT INTO organization (slug, name) VALUES ('reply-co','Reply Co') RETURNING id")
  ).rows[0].id;
  await seedDefaultFlow(orgId);
  manager = await mkUser(MANAGER, 'MANAGER');
  submitter = await mkUser(SUBMITTER, 'EMPLOYEE', manager);
  categoryId = await withOrg(orgId, async (tx) =>
    (
      await tx.query(
        `INSERT INTO expense_category (organization_id, code, label) VALUES ($1,'meals','{"en":"Meals"}') RETURNING id`,
        [orgId],
      )
    ).rows[0].id as string,
  );
  process.env.APP_URL = 'https://velo.test';
  process.env.AUTH_SECRET ??= 'reply-threads-test-secret';
  process.env.S3_INBOUND_MAIL_BUCKET = 'inbound-bucket';
  setEmailTransport(mail);
  setInboundMailStorage(inbound);
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

beforeEach(async () => {
  process.env.INBOUND_EMAIL_DOMAIN = DOMAIN;
  mail.reset();
  await admin.query(
    `BEGIN;
     SELECT set_config('app.audit_purge', 'on', true);
     DELETE FROM audit_entry;
     DELETE FROM reply_thread;
     DELETE FROM notification_delivery;
     DELETE FROM notification;
     DELETE FROM activity;
     DELETE FROM approval_instance;
     DELETE FROM expense_report_event;
     DELETE FROM policy_violation;
     DELETE FROM expense_line_item;
     DELETE FROM expense;
     DELETE FROM expense_report;
     COMMIT;`,
  );
});

afterAll(async () => {
  resetEmailTransport();
  setInboundMailStorage(null);
  delete process.env.INBOUND_EMAIL_DOMAIN;
  await admin.end();
});

describe('the outbound email', () => {
  it("carries a reply address on the tenant's domain, and invites a reply", async () => {
    const { email } = await managersEmail();
    expect(email.replyTo).toMatch(new RegExp(`^reply\\+[\\w-]+@reply-co\\.${DOMAIN.replace(/\./g, '\\.')}$`));
    expect(email.text).toContain('Or reply to this email to start a discussion.');
    expect(email.html).toContain('Or reply to this email to start a discussion.');
  });

  it('keeps one address per person and report, so replying to an older email still works', async () => {
    // ExpenseOS: the token is an HMAC over the thread id, not random per message, so every
    // email in a thread carries the same Reply-To.
    const { reportId, email } = await managersEmail();
    const again = await withTenantDb(orgId, async (db) => {
      const thread = await ensureReplyThread(db, {
        subjectType: 'EXPENSE_REPORT',
        subjectId: reportId,
        recipientId: manager,
      });
      return issueEmailReplyToken(db, thread.id);
    });
    expect(again).toBe(tokenOf(email.replyTo));
    const threads = await admin.query('SELECT count(*)::int AS n FROM reply_thread');
    expect(threads.rows[0].n).toBe(1);
  });

  it('offers no reply address when no inbound domain is configured', async () => {
    // "Inviting a discussion into a mailbox nothing reads is worse than not inviting one."
    delete process.env.INBOUND_EMAIL_DOMAIN;
    const { email } = await managersEmail();
    expect(email.replyTo).toBeUndefined();
    expect(email.text).not.toContain('reply to this email');
  });
});

describe('a reply', () => {
  it('becomes a comment from the person it was addressed to, told to the rest of the thread', async () => {
    const { reportId, email } = await managersEmail();
    await reply(
      tokenOf(email.replyTo),
      MANAGER,
      mime(`Margaret <${MANAGER}>`, 'The hotel looks high.\n\nOn Mon, VeloExpense wrote:\n> Lisbon offsite'),
    );

    const posted = await comments();
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ actor_id: manager, subject_id: reportId });
    expect(posted[0].payload).toMatchObject({ body: 'The hotel looks high.', via: 'email' });

    // Told to the submitter — the rest of the thread — and not back to the replier.
    const told = await admin.query(
      `SELECT n.recipient_id FROM notification n JOIN activity a ON a.id = n.activity_id
        WHERE a.event_type = 'COMMENT'`,
    );
    expect(told.rows.map((r) => r.recipient_id)).toEqual([submitter]);
  });

  it('is refused for a token nobody was given', async () => {
    await managersEmail();
    await reply('not-a-token', MANAGER, mime(MANAGER, 'Hello'));
    expect(await comments()).toEqual([]);
  });

  it('is refused when the sender is not the person the address was for', async () => {
    // Defence in depth on top of the secret token.
    const { email } = await managersEmail();
    await reply(tokenOf(email.replyTo), SUBMITTER, mime(SUBMITTER, 'Posting as the manager'));
    expect(await comments()).toEqual([]);
  });

  it("is refused when the message's own From is not the authenticated sender", async () => {
    // VeloExpense: the route checked one header of this message; a different one is not it.
    const { email } = await managersEmail();
    await reply(tokenOf(email.replyTo), MANAGER, mime('someone@else.test', 'Hi'));
    expect(await comments()).toEqual([]);
  });

  it('is ignored when a machine sent it', async () => {
    // VeloExpense: an out-of-office answering the notification is not a comment.
    const { email } = await managersEmail();
    await reply(
      tokenOf(email.replyTo),
      MANAGER,
      mime(MANAGER, 'I am out of the office until Monday.', ['Auto-Submitted: auto-replied']),
    );
    expect(await comments()).toEqual([]);
  });

  it('is not read at all when it is larger than a comment could be', async () => {
    // ExpenseOS's comment ceiling: "A reply is prose; anything this large is an attachment
    // nobody will see in a comment, or a mistake."
    const { email } = await managersEmail();
    await reply(tokenOf(email.replyTo), MANAGER, mime(MANAGER, `Big ${'x'.repeat(3 * 1024 * 1024)}`));
    expect(await comments()).toEqual([]);
  });

  it('is ignored when nothing is left once the quoted history is gone', async () => {
    const { email } = await managersEmail();
    await reply(tokenOf(email.replyTo), MANAGER, mime(MANAGER, '> Lisbon offsite\n> quoted'));
    expect(await comments()).toEqual([]);
  });
});
