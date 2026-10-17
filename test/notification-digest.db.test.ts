/**
 * w5-00 — the email digest, against a real Postgres.
 *
 * ExpenseOS's `notification-email-digest.test.ts` pins its job's rules — one email per
 * recipient, the count in the subject, stamping only after a send succeeds, a failing
 * recipient not taking the others down. VeloExpense sends the digest through its delivery
 * outbox (decided 17 Oct 2026), so the same rules are asserted here on the outbox rows: a
 * digest-type email is held until the next quarter hour, the drain gathers one person's due
 * rows into one message, and every row it covers is marked together. The message's own
 * content is `lib/notifications/digest.test.ts`.
 *
 * Own org slug ('digest-co') because the DB suites share one database and each TRUNCATEs
 * (vitest.config.ts, fileParallelism: false).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { withOrg } from '@/lib/tenant/context';
import {
  MemoryEmailTransport,
  resetEmailTransport,
  setEmailTransport,
} from '@/lib/notifications/email';
import { drainOutbox } from '@/lib/notifications/dispatch';
import { notify, setPreference } from '@/lib/notifications/service';
import { listQueue } from '@/lib/notifications/outbox';

const ADMIN_URL = process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL;
if (!ADMIN_URL) {
  throw new Error('notification-digest.db.test.ts needs ADMIN_DATABASE_URL (or DATABASE_URL).');
}
const admin = new Pool({ connectionString: ADMIN_URL });
const mail = new MemoryEmailTransport();
let restoreTransport: (() => void) | null = null;

let orgId: string;
let ada: string;
let bob: string;
let grace: string;
let reportA: string;
let reportB: string;

const EMPLOYEE = '019e3000-0000-7000-8000-000000000004';

async function mkUser(email: string, name: string) {
  return (
    await admin.query(
      `INSERT INTO app_user (organization_id, email, display_name, role_id)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [orgId, email, name, EMPLOYEE],
    )
  ).rows[0].id as string;
}

async function mkReport(title: string) {
  return (
    await admin.query(
      `INSERT INTO expense_report (organization_id, submitter_id, title, currency_code)
       VALUES ($1, $2, $3, 'CAD') RETURNING id`,
      [orgId, grace, title],
    )
  ).rows[0].id as string;
}

/** Grace comments on `reportId`; everybody named is told. */
function comment(reportId: string, body: string, to: string[]) {
  return withOrg(orgId, (tx) =>
    notify(
      tx,
      { subjectType: 'EXPENSE_REPORT', subjectId: reportId, eventType: 'COMMENT', actorId: grace, payload: { body } },
      to,
    ),
  );
}

async function rows() {
  return (
    await admin.query(
      `SELECT d.id, d.status, d.attempts, d.destination, d.next_attempt_at, u.email, a.event_type
         FROM notification_delivery d
         JOIN notification n ON n.id = d.notification_id
         JOIN app_user u ON u.id = n.recipient_id
         JOIN activity a ON a.id = n.activity_id
        ORDER BY d.created_at`,
    )
  ).rows as Array<{
    id: string;
    status: string;
    attempts: number;
    destination: string | null;
    next_attempt_at: Date;
    email: string;
    event_type: string;
  }>;
}

/** Bring every held row's quarter hour forward to now, ada's first. */
async function makeDue() {
  await admin.query(
    `UPDATE notification_delivery d SET next_attempt_at = clock_timestamp() - interval '1 minute'
       FROM notification n JOIN app_user u ON u.id = n.recipient_id
      WHERE n.id = d.notification_id AND u.email = 'ada@digest.test'`,
  );
  await admin.query(
    `UPDATE notification_delivery SET next_attempt_at = clock_timestamp() - interval '30 seconds'
      WHERE next_attempt_at > clock_timestamp()`,
  );
}

beforeAll(async () => {
  await admin.query('TRUNCATE app_user, organization CASCADE');
  orgId = (
    await admin.query("INSERT INTO organization (slug, name) VALUES ('digest-co', 'Digest Co') RETURNING id")
  ).rows[0].id;
  ada = await mkUser('ada@digest.test', 'Ada Lovelace');
  bob = await mkUser('bob@digest.test', 'Bob Kahn');
  grace = await mkUser('grace@digest.test', 'Grace Hopper');
  reportA = await mkReport('Lisbon offsite');
  reportB = await mkReport('Q3 mileage');
  // Comment emails are off by default (ExpenseOS's one per-type exception); ada and bob
  // asked for them, grace did not.
  await withOrg(orgId, async (tx) => {
    await setPreference(tx, ada, 'COMMENT', 'EMAIL', true);
    await setPreference(tx, bob, 'COMMENT', 'EMAIL', true);
  });
  process.env.APP_URL = 'https://velo.test';
  restoreTransport = setEmailTransport(mail);
});

beforeEach(async () => {
  mail.reset();
  mail.failNext = null;
  await admin.query(
    `BEGIN;
     DELETE FROM notification_delivery;
     DELETE FROM notification;
     DELETE FROM activity;
     COMMIT;`,
  );
});

afterAll(async () => {
  restoreTransport?.();
  resetEmailTransport();
  await admin.end();
});

describe('holding for the digest', () => {
  it('holds a comment email until the next quarter hour, and sends nothing before then', async () => {
    await comment(reportA, 'Is the hotel receipt attached?', [ada]);

    const [row] = await rows();
    const held = row.next_attempt_at;
    expect(held.getTime()).toBeGreaterThan(Date.now());
    expect(held.getTime() - Date.now()).toBeLessThanOrEqual(15 * 60 * 1000);
    // On the quarter hour, as ExpenseOS's `*/15` schedule runs.
    expect(held.getUTCMinutes() % 15).toBe(0);
    expect(held.getUTCSeconds()).toBe(0);

    const summary = await drainOutbox();
    expect(summary.sent).toBe(0);
    expect(mail.sent).toHaveLength(0);
    expect((await rows())[0].status).toBe('PENDING');

    // The Email delivery screen says it is held, so a waiting row is not read as stuck.
    const queue = await withOrg(orgId, (tx) => listQueue(tx));
    expect(queue.map((q) => q.heldForDigest)).toEqual([true]);
    await makeDue();
    expect((await withOrg(orgId, (tx) => listQueue(tx))).map((q) => q.heldForDigest)).toEqual([false]);
  });

  it('holds comments back entirely until the recipient opts in', async () => {
    // ExpenseOS's composition of the two rules: digest-eligible AND email-off by default.
    // Ada comments; Grace, who never asked for comment emails, is told in-app only.
    await withOrg(orgId, (tx) =>
      notify(
        tx,
        { subjectType: 'EXPENSE_REPORT', subjectId: reportA, eventType: 'COMMENT', actorId: ada, payload: { body: 'x' } },
        [grace],
      ),
    );
    expect(await rows()).toEqual([]);
  });
});

describe('sending the digest', () => {
  it('sends one email per person covering everything due, and marks each row sent', async () => {
    // The entire reason the digest exists.
    await comment(reportA, 'Is the hotel receipt attached?', [ada, bob]);
    await comment(reportA, 'Found it, thanks', [ada]);
    await comment(reportB, 'Mileage looks high', [ada]);
    await makeDue();

    const summary = await drainOutbox();

    expect(mail.sent).toHaveLength(2);
    const toAda = mail.sent.find((m) => m.to === 'ada@digest.test')!;
    const toBob = mail.sent.find((m) => m.to === 'bob@digest.test')!;
    expect(toAda.subject).toBe('3 new updates in VeloExpense');
    expect(toBob.subject).toBe('1 new update in VeloExpense');

    // Each line is that comment's own sentence, linked to its own report.
    expect(toAda.text).toContain('Grace Hopper commented on Lisbon offsite: Is the hotel receipt attached?');
    expect(toAda.text).toContain('Grace Hopper commented on Q3 mileage: Mileage looks high');
    expect(toAda.text).toContain(`https://velo.test/expenses/${reportA}`);
    expect(toAda.text).toContain(`https://velo.test/expenses/${reportB}`);
    expect(toAda.html).toContain(`href="https://velo.test/expenses/${reportB}"`);

    // Every row it covered is SENT, to that address — the delivery screen's record.
    const after = await rows();
    expect(after.map((r) => r.status)).toEqual(['SENT', 'SENT', 'SENT', 'SENT']);
    expect(new Set(after.map((r) => r.destination))).toEqual(
      new Set(['ada@digest.test', 'bob@digest.test']),
    );
    expect(summary.sent).toBe(4);

    // And nothing is sent twice.
    mail.reset();
    await drainOutbox();
    expect(mail.sent).toHaveLength(0);
  });

  it('leaves events that are not digest types to go out on their own, at once', async () => {
    await withOrg(orgId, (tx) =>
      notify(
        tx,
        { subjectType: 'EXPENSE_REPORT', subjectId: reportA, eventType: 'REIMBURSED', actorId: grace },
        [ada],
      ),
    );
    await comment(reportA, 'Paid out', [ada]);

    const [reimbursed] = (await rows()).filter((r) => r.event_type === 'REIMBURSED');
    expect(reimbursed.next_attempt_at.getTime()).toBeLessThanOrEqual(Date.now());

    await drainOutbox();
    // The reimbursement went alone; the comment is still held.
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0].subject).not.toMatch(/new update/);
    expect((await rows()).find((r) => r.event_type === 'COMMENT')!.status).toBe('PENDING');
  });

  it('fails every row a failed digest covered, and still sends everybody else theirs', async () => {
    /**
     * ExpenseOS: "Stamping on failure would discard the notifications outright … And one
     * bad address must not cost everybody else their digest." Here the rows go FAILED with
     * a backoff rather than staying unstamped, and are retried as one digest again.
     */
    await comment(reportA, 'One', [ada]);
    await comment(reportB, 'Two', [ada]);
    await comment(reportB, 'Three', [bob]);
    await makeDue();
    mail.failNext = new Error('550 mailbox unavailable');

    await drainOutbox();

    const after = await rows();
    const adas = after.filter((r) => r.email === 'ada@digest.test');
    expect(adas.map((r) => [r.status, r.attempts])).toEqual([
      ['FAILED', 1],
      ['FAILED', 1],
    ]);
    expect(after.find((r) => r.email === 'bob@digest.test')!.status).toBe('SENT');
    expect(mail.sent.map((m) => m.to)).toEqual(['bob@digest.test']);
  });
});
