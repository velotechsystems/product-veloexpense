/**
 * VX2-8 — the outbox, the transport and the approve-link, against a real Postgres.
 *
 * Own org slug ('deliv-co') because the DB suites share one database and each
 * TRUNCATEs (vitest.config.ts, fileParallelism: false).
 *
 * ── The tests that matter ───────────────────────────────────────────────────
 *
 * The board's acceptance is "an approval email arrives with working actions; a
 * failed send retries and shows in the admin queue; every job sets
 * app.current_org". All three are here. The one worth reading first is
 * `withoutOrg sees nothing` — it asserts the property the whole platform-hatch
 * design rests on (GAP-AUDIT NT-19), and if it ever fails, the hatch is not a
 * hatch and two of these files are wrong.
 *
 * The MEMORY TRANSPORT is used throughout, and VX1-9 already recorded why that is
 * a limitation rather than a win: "MemoryStorage signs memory:// URLs no browser
 * can fetch, which is exactly how every vitest suite stays green while a real
 * upload is broken." Everything below proves the message was COMPOSED. Nothing
 * below proves SMTP works — that needs a real sink, and it is VX2-10's problem.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { Pool } from 'pg';
import { withOrg, withoutOrg, withPlatformRead } from '@/lib/tenant/context';
import * as expenses from '@/lib/expenses/service';
import * as lifecycle from '@/lib/expenses/lifecycle';
import { decide } from '@/lib/approvals/engine';
import {
  MemoryEmailTransport,
  resetEmailTransport,
  setEmailTransport,
} from '@/lib/notifications/email';
import { drainOutbox, prepareEmail } from '@/lib/notifications/dispatch';
import {
  claimDelivery,
  dueDeliveries,
  listQueue,
  queueSummary,
  retryNow,
  MAX_ATTEMPTS,
} from '@/lib/notifications/outbox';
import { addBusinessDays, TOKEN_TTL_BUSINESS_DAYS } from '@/lib/notifications/action-tokens';
import { decideFromToken, inspectToken } from '@/lib/notifications/approve';
import { TEST_ACTOR } from './support/audit-actor';
import { TODAY } from './support/dates';

const ADMIN_URL = process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL;
if (!ADMIN_URL) {
  throw new Error('delivery.db.test.ts needs ADMIN_DATABASE_URL (or DATABASE_URL). See HANDOFF.md.');
}
const admin = new Pool({ connectionString: ADMIN_URL });

const SUBMITTER = 'sub@deliv.test';
const mail = new MemoryEmailTransport();
let restoreTransport: (() => void) | null = null;

let orgId: string;
let categoryId: string;
let submitter: string;
let manager: string;

async function mkUser(email: string, role: string, managerId: string | null = null) {
  return withOrg(orgId, async (tx) => {
    const r = await tx.query(
      `INSERT INTO app_user (organization_id, email, display_name, role, manager_id)
       VALUES (current_setting('app.current_org', true)::uuid, $1, $2, $3, $4)
       RETURNING id`,
      [email, email.split('@')[0], role, managerId],
    );
    return r.rows[0].id as string;
  });
}

async function submitted(amountMinor = 250000, title = 'Munich') {
  const reportId = await withOrg(orgId, async (tx) => {
    const report = await expenses.createReport(tx, SUBMITTER, { title, currencyCode: 'CAD' });
    const expense = await expenses.addExpense(tx, TEST_ACTOR, report.id, { txnDate: TODAY,
      currencyCode: 'CAD',
      merchant: 'M',
    });
    await expenses.addLineItem(tx, TEST_ACTOR, expense.id, { categoryId, amountMinor });
    return report.id as string;
  });
  const { approval } = await withOrg(orgId, (tx) =>
    lifecycle.submitReport(tx, reportId, submitter),
  );
  return { reportId, ...approval };
}

/** The delivery rows for this tenant, whatever their state. */
async function deliveries() {
  const r = await admin.query(
    `SELECT d.id, d.status, d.attempts, d.channel, d.last_error, d.destination,
            a.event_type
       FROM notification_delivery d
       JOIN notification n ON n.id = d.notification_id
       JOIN activity a ON a.id = n.activity_id
      ORDER BY d.created_at`,
  );
  return r.rows as {
    id: string;
    status: string;
    attempts: number;
    channel: string;
    last_error: string | null;
    destination: string | null;
    event_type: string;
  }[];
}

/** The token values out of the most recent email. */
function tokensFromLastEmail(): { approve: string; reject: string } | null {
  const last = mail.sent[mail.sent.length - 1];
  if (!last) return null;
  const found = [...last.text.matchAll(/\/approve\?token=([\w-]+)/g)].map((m) => m[1]);
  if (found.length < 2) return null;
  return { approve: found[0], reject: found[1] };
}

beforeAll(async () => {
  await admin.query('TRUNCATE app_user, organization CASCADE');
  const o = await admin.query(
    "INSERT INTO organization (slug, name) VALUES ('deliv-co','Delivery Co') RETURNING id",
  );
  orgId = o.rows[0].id;
  manager = await mkUser('mgr@deliv.test', 'MANAGER');
  submitter = await mkUser(SUBMITTER, 'EMPLOYEE', manager);
  await withOrg(orgId, async (tx) => {
    const c = await tx.query(
      `INSERT INTO expense_category (organization_id, code, label) VALUES ($1,'meals','{"en":"Meals"}') RETURNING id`,
      [orgId],
    );
    categoryId = c.rows[0].id;
  });
  // An origin, or every link is null and half this file asserts nothing (NT-14).
  process.env.APP_URL = 'https://velo.test';
  restoreTransport = setEmailTransport(mail);
});

beforeEach(async () => {
  mail.reset();
  await admin.query(
    `BEGIN;
     SELECT set_config('app.audit_purge', 'on', true);
     DELETE FROM audit_entry;
     DELETE FROM action_token;
     DELETE FROM notification_delivery;
     DELETE FROM notification;
     DELETE FROM activity;
     DELETE FROM notification_preference;
     DELETE FROM notification_template;
     DELETE FROM approval_task;
     DELETE FROM approval_request;
     DELETE FROM expense_report_event;
     DELETE FROM policy_violation;
     DELETE FROM receipt;
     DELETE FROM expense_line_item;
     DELETE FROM expense;
     DELETE FROM expense_report;
     DELETE FROM approval_policy_approver;
     DELETE FROM approval_policy;
     DELETE FROM expense_policy;
     COMMIT;`,
  );
});

afterAll(async () => {
  restoreTransport?.();
  resetEmailTransport();
  await admin.end();
});

/* ── the property everything else rests on ─────────────────────────────────── */

describe('the platform read hatch', () => {
  it('withoutOrg sees NOTHING, and withPlatformRead sees due work', async () => {
    // GAP-AUDIT NT-19. `withoutOrg` is named as if it were a cross-tenant read
    // and it is not: it still connects as `veloapp` under FORCE RLS, so an unset
    // `app.current_org` makes every policy body NULL. If this test ever fails,
    // the hatch in `0012` is unnecessary AND `withoutOrg` has become a
    // cross-tenant hole — so it is worth an assertion of its own.
    await submitted();
    expect(await withoutOrg((tx) => dueDeliveries(tx, 10))).toEqual([]);
    const due = await withPlatformRead((tx) => dueDeliveries(tx, 10));
    expect(due).toHaveLength(1);
    expect(due[0].organizationId).toBe(orgId);
  });

  it('the hatch cannot see settled work, even asked directly', async () => {
    // The policy is narrowed to PENDING/FAILED, so a widened WHERE clause still
    // cannot read a tenant's SENT history.
    await submitted();
    await drainOutbox();
    const rows = await withPlatformRead((tx) =>
      tx.query('SELECT id, status FROM notification_delivery'),
    );
    expect(rows.rows).toEqual([]);
    // ...while the tenant sees it perfectly well.
    const mine = await withOrg(orgId, (tx) => tx.query('SELECT status FROM notification_delivery'));
    expect(mine.rows.map((r) => r.status)).toEqual(['SENT']);
  });

  it('the hatch is read-only', async () => {
    await submitted();
    const due = await withPlatformRead((tx) => dueDeliveries(tx, 10));
    // `platform_read` is FOR SELECT, so an UPDATE finds no row to update rather
    // than throwing — RLS filters, it does not raise. Zero rows affected is the
    // refusal.
    const updated = await withPlatformRead((tx) =>
      tx.query("UPDATE notification_delivery SET status = 'CANCELLED' WHERE id = $1", [due[0].id]),
    );
    expect(updated.rowCount).toBe(0);
  });
});

/* ── the acceptance criteria ───────────────────────────────────────────────── */

describe('an approval email arrives with working actions', () => {
  it('queues on submit, sends on drain, and carries both links', async () => {
    await submitted(250000, 'Munich');

    const queued = await deliveries();
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ status: 'PENDING', channel: 'EMAIL', attempts: 0 });
    expect(queued[0].event_type).toBe('TASK_ASSIGNED');

    const summary = await drainOutbox();
    expect(summary).toMatchObject({ scanned: 1, sent: 1, failed: 0, dead: 0, cancelled: 0 });

    expect(mail.sent).toHaveLength(1);
    const msg = mail.sent[0];
    expect(msg.to).toBe('mgr@deliv.test');
    expect(msg.text).toContain('Munich');
    expect(msg.text).toContain('2,500.00');
    // RFC 3834 — see NT-18. Without it an out-of-office responder answers a
    // notification and the two of them keep going.
    expect(msg.headers?.['Auto-Submitted']).toBe('auto-generated');
    // A unique Message-ID per message, a SHARED References root for the thread.
    expect(msg.messageId).toContain('velo-n-');
    expect(msg.references).toContain('velo-thread-');

    const tokens = tokensFromLastEmail();
    expect(tokens).not.toBeNull();
    expect(tokens!.approve).not.toBe(tokens!.reject);

    const after = await deliveries();
    expect(after[0]).toMatchObject({ status: 'SENT', destination: 'mgr@deliv.test' });
  });

  it('the approve link approves, once', async () => {
    const { reportId } = await submitted();
    await drainOutbox();
    const tokens = tokensFromLastEmail()!;

    // The GET-equivalent: reading the token must not decide anything.
    const preview = await inspectToken(tokens.approve);
    expect(preview).toMatchObject({ kind: 'READY', action: 'APPROVED', step: 1, totalSteps: 1 });
    const stillOpen = await admin.query('SELECT status FROM expense_report WHERE id = $1', [
      reportId,
    ]);
    expect(stillOpen.rows[0].status).toBe('SUBMITTED');

    const done = await decideFromToken(tokens.approve, { receiptViewAcknowledged: true });
    expect(done).toMatchObject({ kind: 'DONE', action: 'APPROVED' });
    const settled = await admin.query('SELECT status FROM expense_report WHERE id = $1', [reportId]);
    expect(settled.rows[0].status).toBe('APPROVED');

    // Single use. The second attempt is INVALID, not a second approval.
    expect(await decideFromToken(tokens.approve)).toEqual({ kind: 'INVALID' });
  });

  it('retires the other half of the pair once one is used', async () => {
    await submitted();
    await drainOutbox();
    const tokens = tokensFromLastEmail()!;
    await decideFromToken(tokens.approve, { receiptViewAcknowledged: true });
    // The REJECT link is now a credential with nothing to do. `decide` would
    // refuse it anyway; consuming it means it is not a live credential at all.
    expect(await inspectToken(tokens.reject)).toEqual({ kind: 'INVALID' });
  });

  it('the reject link rejects', async () => {
    const { reportId } = await submitted();
    await drainOutbox();
    const tokens = tokensFromLastEmail()!;
    expect(await decideFromToken(tokens.reject)).toMatchObject({
      kind: 'DONE',
      action: 'REJECTED',
    });
    const r = await admin.query('SELECT status FROM expense_report WHERE id = $1', [reportId]);
    expect(r.rows[0].status).toBe('REJECTED');
  });

  it('refuses a decision the guard would refuse — the token does not authorize', async () => {
    // The property ExpenseOS's header states and this ticket depends on: "the
    // caller still re-runs canDecide + the atomic claim, so it never bypasses
    // authorization." Here the task is decided in the app first, so the emailed
    // link points at something already settled.
    const { reportId, taskId } = await submitted();
    await drainOutbox();
    const tokens = tokensFromLastEmail()!;
    await withOrg(orgId, (tx) =>
      decide(tx, taskId, manager, 'APPROVED', { receiptViewAcknowledged: true }),
    );
    const outcome = await inspectToken(tokens.approve);
    expect(outcome).toMatchObject({ kind: 'REFUSED', reportId });
    // And using it changes nothing.
    const used = await decideFromToken(tokens.approve);
    expect(used.kind === 'DONE').toBe(false);
  });

  it('refuses an expired token, and the row is invisible to the hatch', async () => {
    await submitted();
    await drainOutbox();
    const tokens = tokensFromLastEmail()!;
    await admin.query("UPDATE action_token SET expires_at = now() - interval '1 day'");
    // Two guards, and this asserts the STRUCTURAL one: `0012`'s platform policy
    // excludes expired tokens, so the tenant cannot even be resolved.
    expect(await withPlatformRead((tx) => tx.query('SELECT id FROM action_token'))).toMatchObject({
      rowCount: 0,
    });
    expect(await inspectToken(tokens.approve)).toEqual({ kind: 'INVALID' });
  });

  it('mints tokens that expire five business days out', async () => {
    await submitted();
    await drainOutbox();
    const r = await admin.query('SELECT expires_at FROM action_token LIMIT 1');
    const expected = addBusinessDays(new Date(), TOKEN_TTL_BUSINESS_DAYS);
    // Within a day: the fixture and the code call `new Date()` at different
    // moments, and the point of the assertion is the WEEKEND SKIP, not the clock.
    const diffDays =
      Math.abs((r.rows[0].expires_at as Date).getTime() - expected.getTime()) / 86_400_000;
    expect(diffDays).toBeLessThan(1);
    // Five business days is never fewer than five calendar days and is seven
    // across a weekend, so the constant cannot silently have become calendar days.
    const calendarDays = (expected.getTime() - Date.now()) / 86_400_000;
    expect(calendarDays).toBeGreaterThanOrEqual(4.9);
  });

  it('sends no action links on a notification the recipient cannot act on', async () => {
    // An APPROVED mail goes to the submitter, who has nothing to decide. Buttons
    // there would be a link that always fails.
    const { taskId } = await submitted();
    await withOrg(orgId, (tx) =>
      decide(tx, taskId, manager, 'APPROVED', { receiptViewAcknowledged: true }),
    );
    mail.reset();
    await drainOutbox();
    const toSubmitter = mail.sent.find((m) => m.to === SUBMITTER);
    expect(toSubmitter).toBeTruthy();
    expect(toSubmitter!.text).not.toContain('/approve?token=');
    expect(toSubmitter!.text).toContain('/expenses/');
  });
});

describe('a failed send retries and shows in the admin queue', () => {
  it('records the reason verbatim, backs off, and retries', async () => {
    await submitted();
    mail.failNext = new Error('550 5.1.1 recipient rejected');

    const first = await drainOutbox();
    expect(first).toMatchObject({ sent: 0, failed: 1, dead: 0 });
    const failed = await deliveries();
    expect(failed[0]).toMatchObject({ status: 'FAILED', attempts: 1 });
    // Verbatim. Paraphrasing is how "delivery failed" becomes all anybody can
    // find out — the NT-11 incident this screen exists for.
    expect(failed[0].last_error).toBe('550 5.1.1 recipient rejected');

    // The backoff is the row: nothing is due yet, so an immediate drain is a
    // no-op rather than a hot loop.
    expect(await drainOutbox()).toMatchObject({ scanned: 0 });

    // Bring it forward and it goes.
    await admin.query('UPDATE notification_delivery SET next_attempt_at = now()');
    expect(await drainOutbox()).toMatchObject({ sent: 1 });
    expect((await deliveries())[0]).toMatchObject({ status: 'SENT', attempts: 2 });
  });

  it('dead-letters after the last attempt, and an admin can retry it', async () => {
    await submitted();
    for (let i = 0; i < MAX_ATTEMPTS; i += 1) {
      mail.failNext = new Error(`attempt ${i + 1} failed`);
      await admin.query('UPDATE notification_delivery SET next_attempt_at = now()');
      await drainOutbox();
    }
    const dead = await deliveries();
    expect(dead[0]).toMatchObject({ status: 'DEAD', attempts: MAX_ATTEMPTS });
    // A DEAD row is not retried by the poller, however long you wait.
    await admin.query('UPDATE notification_delivery SET next_attempt_at = now()');
    expect(await drainOutbox()).toMatchObject({ scanned: 0 });

    // The admin button gives it a fresh budget — without resetting attempts it
    // would die again on the next poll and the button would appear to do nothing.
    expect(await withOrg(orgId, (tx) => retryNow(tx, dead[0].id))).toBe(true);
    const revived = await deliveries();
    expect(revived[0]).toMatchObject({ status: 'PENDING', attempts: 0 });
    // The error text SURVIVES the retry, so the screen can still say what went
    // wrong last time while the new attempt is in flight.
    expect(revived[0].last_error).toBe(`attempt ${MAX_ATTEMPTS} failed`);
    expect(await drainOutbox()).toMatchObject({ sent: 1 });
  });

  it('shows up in the admin queue, worst first', async () => {
    await submitted(1000, 'One');
    mail.failNext = new Error('boom');
    await drainOutbox();
    await submitted(2000, 'Two');

    const rows = await withOrg(orgId, (tx) => listQueue(tx));
    expect(rows).toHaveLength(2);
    // FAILED outranks PENDING: a queue sorted by time buries the row somebody
    // has to act on.
    expect(rows[0].status).toBe('FAILED');
    expect(rows[1].status).toBe('PENDING');
    expect(rows[0].recipientEmail).toBe('mgr@deliv.test');

    const s = await withOrg(orgId, (tx) => queueSummary(tx));
    expect(s).toMatchObject({ failed: 1, pending: 1, sent: 0, dead: 0 });
  });

  it('cancels rather than retries when there is nothing to send', async () => {
    // CANCELLED and DEAD are different answers: "there was never anything to do"
    // versus "we tried and could not". Here the report is gone — `activity`
    // carries a polymorphic subject_id with no FK (NT-1), so the activity and its
    // notification survive a deleted subject and the delivery has nothing to
    // describe.
    const { reportId } = await submitted();
    await admin.query('DELETE FROM expense_line_item');
    await admin.query('DELETE FROM approval_task');
    await admin.query('DELETE FROM approval_request');
    await admin.query('DELETE FROM expense_report_event');
    await admin.query('DELETE FROM expense');
    await admin.query('DELETE FROM expense_report WHERE id = $1', [reportId]);

    expect(await drainOutbox()).toMatchObject({ cancelled: 1, sent: 0, failed: 0 });
    const rows = await deliveries();
    expect(rows[0].status).toBe('CANCELLED');
    expect(rows[0].last_error).toContain('nothing to link to');
    expect(mail.sent).toHaveLength(0);
  });

  it('cancels a channel it has no transport for', async () => {
    // Nothing writes a SLACK row today — `notifyRecipients` enqueues EMAIL only —
    // so this inserts one directly. The guard exists because the alternative is
    // composing an email in response to a Slack job.
    await submitted();
    const n = await admin.query('SELECT id, organization_id FROM notification LIMIT 1');
    await admin.query(
      `INSERT INTO notification_delivery (organization_id, notification_id, channel)
       VALUES ($1, $2, 'SLACK')`,
      [n.rows[0].organization_id, n.rows[0].id],
    );
    const summary = await drainOutbox();
    expect(summary.cancelled).toBe(1);
    expect(summary.sent).toBe(1);
    const slack = (await deliveries()).find((d) => d.channel === 'SLACK');
    expect(slack).toMatchObject({ status: 'CANCELLED' });
    expect(slack!.last_error).toContain('no transport for SLACK');
  });
});

/* ── the claim ─────────────────────────────────────────────────────────────── */

describe('the claim', () => {
  it('lets exactly one poller win', async () => {
    await submitted();
    const due = await withPlatformRead((tx) => dueDeliveries(tx, 10));
    const first = await withOrg(orgId, (tx) => claimDelivery(tx, due[0].id, 'poller-a'));
    const second = await withOrg(orgId, (tx) => claimDelivery(tx, due[0].id, 'poller-b'));
    expect(first).not.toBeNull();
    expect(second).toBeNull();
    // And the loser's drain reports it as skipped rather than failed.
    expect(await drainOutbox()).toMatchObject({ scanned: 0 });
  });

  it('releases a claim that has gone stale, and the attempt is not refunded', async () => {
    // The visibility timeout. A poller that dies between claiming and marking
    // leaves a row nothing else would ever release — there is no lock to expire,
    // because the claiming transaction committed. This is the piece easiest to
    // leave out and worst to leave out.
    await submitted();
    const due = await withPlatformRead((tx) => dueDeliveries(tx, 10));
    const claimed = await withOrg(orgId, (tx) => claimDelivery(tx, due[0].id, 'poller-that-died'));
    expect(claimed).not.toBeNull();
    expect(await withPlatformRead((tx) => dueDeliveries(tx, 10))).toEqual([]);

    await admin.query("UPDATE notification_delivery SET claimed_at = now() - interval '1 hour'");
    expect(await withPlatformRead((tx) => dueDeliveries(tx, 10))).toHaveLength(1);

    // attempts increments at CLAIM time, so the dead poller spent one. That is
    // what stops a message which kills its handler from looping forever.
    await drainOutbox();
    expect((await deliveries())[0]).toMatchObject({ status: 'SENT', attempts: 2 });
  });

  it('is idempotent on (notification, channel)', async () => {
    await submitted();
    const n = await admin.query('SELECT id, organization_id FROM notification LIMIT 1');
    // A second enqueue must not create a second job: two approval emails for one
    // task means two live approve links, which is the thing the UNIQUE exists to
    // prevent.
    await expect(
      admin.query(
        `INSERT INTO notification_delivery (organization_id, notification_id, channel)
         VALUES ($1, $2, 'EMAIL')`,
        [n.rows[0].organization_id, n.rows[0].id],
      ),
    ).rejects.toThrow();
  });
});

/* ── composition ──────────────────────────────────────────────────────────── */

describe('composition', () => {
  it('uses the tenant wording when there is one, for the EMAIL channel', async () => {
    await withOrg(orgId, (tx) =>
      tx.query(
        `INSERT INTO notification_template
           (organization_id, template_key, channel, body, subject)
         VALUES (current_setting('app.current_org', true)::uuid,
                 'expense_management.report_awaiting_approval', 'EMAIL', $1::jsonb, $2::jsonb)`,
        [
          JSON.stringify({ 'en-CA': 'Please look at {report} ({total}) from {actor}.' }),
          JSON.stringify({ 'en-CA': 'Approval needed: {report}' }),
        ],
      ),
    );
    await submitted(50000, 'Oslo');
    await drainOutbox();
    expect(mail.sent[0].subject).toBe('Approval needed: Oslo');
    expect(mail.sent[0].text).toContain('Please look at Oslo ($500.00) from sub.');
  });

  it('IGNORES a template still keyed on the retagged-away `en`', async () => {
    // VX4-7. This fixture is what a tenant row written before 0027 looks like,
    // and the assertion is at the layer that actually sends rather than in the
    // pure renderer — because "the wrong copy went out by email" is the failure
    // that cannot be taken back.
    //
    // Falling through to shipped copy is the right outcome and the honest one: an
    // `en` row is copy in an unknown locale as far as the registry is concerned,
    // and 0027 retagged every such row precisely so this case cannot arise in a
    // migrated database. What this test protects against is the case arising
    // AGAIN — a seed, a fixture or an admin action that writes the old key — and
    // it makes the symptom "the tenant's wording silently stopped applying",
    // which is visible, rather than "half the tenants render an unknown tag".
    await withOrg(orgId, (tx) =>
      tx.query(
        `INSERT INTO notification_template
           (organization_id, template_key, channel, body, subject)
         VALUES (current_setting('app.current_org', true)::uuid,
                 'expense_management.report_awaiting_approval', 'EMAIL', $1::jsonb, $2::jsonb)`,
        [
          JSON.stringify({ en: 'STALE KEY — should not be sent.' }),
          JSON.stringify({ en: 'STALE SUBJECT' }),
        ],
      ),
    );
    await submitted(50000, 'Bergen');
    await drainOutbox();
    expect(mail.sent[0].subject).not.toBe('STALE SUBJECT');
    expect(mail.sent[0].text).not.toContain('STALE KEY');
    // The shipped sentence instead, which is `en-CA` in the catalogue.
    expect(mail.sent[0].text).toContain('needs your approval on Bergen');
  });

  it('re-minting on a retry retires the previous email links', async () => {
    // The links cannot be reused — only the hash is stored, so the raw value is
    // unrecoverable by design. So a retry mints new ones, and the old ones are
    // consumed rather than accumulating one live pair per attempt.
    await submitted();
    mail.failNext = new Error('transient');
    await drainOutbox();
    await admin.query('UPDATE notification_delivery SET next_attempt_at = now()');
    // The first attempt composed a message but did not deliver it, so grab the
    // tokens from the database instead of the transport.
    const before = await admin.query('SELECT token_hash FROM action_token ORDER BY created_at');
    await drainOutbox();
    const live = await admin.query(
      'SELECT token_hash FROM action_token WHERE consumed_at IS NULL ORDER BY created_at',
    );
    expect(before.rows).toHaveLength(2);
    expect(live.rows).toHaveLength(2);
    // Different tokens: the first pair was retired.
    expect(live.rows.map((r) => r.token_hash)).not.toEqual(
      before.rows.map((r) => r.token_hash),
    );
  });

  it('composes without links when no origin is configured', async () => {
    // NT-14's incident, inverted into a test: an empty origin produced mail with
    // no link and no buttons, "indistinguishable from 'this notification was never
    // meant to be actionable'". It must still SEND — a sentence with no link beats
    // no notification — and the missing origin is a logged warning, not a failure.
    const saved = process.env.APP_URL;
    delete process.env.APP_URL;
    const savedAuth = process.env.AUTH_URL;
    delete process.env.AUTH_URL;
    const savedNextAuth = process.env.NEXTAUTH_URL;
    delete process.env.NEXTAUTH_URL;
    try {
      await submitted();
      expect(await drainOutbox()).toMatchObject({ sent: 1 });
      expect(mail.sent[0].text).not.toContain('/approve?token=');
      expect(mail.sent[0].text).not.toContain('https://');
      // And no tokens were minted for a link nobody can follow.
      const t = await admin.query('SELECT count(*)::int AS n FROM action_token');
      expect(t.rows[0].n).toBe(0);
    } finally {
      if (saved) process.env.APP_URL = saved;
      if (savedAuth) process.env.AUTH_URL = savedAuth;
      if (savedNextAuth) process.env.NEXTAUTH_URL = savedNextAuth;
    }
  });

  it('escapes the wording into the HTML part', async () => {
    await withOrg(orgId, (tx) =>
      tx.query(
        `INSERT INTO notification_template (organization_id, template_key, channel, body)
         VALUES (current_setting('app.current_org', true)::uuid,
                 'expense_management.report_awaiting_approval', 'EMAIL', $1::jsonb)`,
        [JSON.stringify({ 'en-CA': 'Look at <script>alert(1)</script> {report}' })],
      ),
    );
    await submitted(1000, 'Bath & Wells');
    await drainOutbox();
    expect(mail.sent[0].html).toContain('&lt;script&gt;');
    expect(mail.sent[0].html).not.toContain('<script>');
    // The report title too — it comes from a user, not an admin.
    expect(mail.sent[0].html).toContain('Bath &amp; Wells');
  });

  it('prepareEmail returns a reason rather than throwing on an unpreparable row', async () => {
    await submitted();
    const due = await withPlatformRead((tx) => dueDeliveries(tx, 10));
    const out = await withOrg(orgId, async (tx) => {
      const claim = await claimDelivery(tx, due[0].id, 'test');
      await tx.query('DELETE FROM notification WHERE id = $1', [claim!.notificationId]);
      return prepareEmail(tx, claim!);
    });
    expect(out).toMatchObject({ kind: 'CANCEL' });
  });
});
