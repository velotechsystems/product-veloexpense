/**
 * VX2-7 — the notification core against a real Postgres.
 *
 * Own org slug ('notif-co') because the DB suites share one database and each
 * TRUNCATEs (vitest.config.ts, fileParallelism: false).
 *
 * ── The three tests the ticket is actually about ────────────────────────────
 *
 * The board's acceptance criteria are "a decision notifies the submitter in-app;
 * preferences suppress it; an empty template table still renders shipped copy".
 * All three are here, and the THIRD one is the interesting one, because
 * ExpenseOS wrote that exact test and it did not work. Their own comment
 * (GAP-AUDIT NT-5) on the test named "falls back to default copy when the
 * catalog has no digest strings":
 *
 *   "asserted on the fallback copy while never once reaching it … the assertion
 *    passed only because those strings happen to be character-identical to the
 *    code's fallbacks. Rewriting the fallback in source left all 20 tests green.
 *    The test named a behaviour it could not observe."
 *
 * So the fallback tests here assert `fromTemplate`, the RESOLUTION PATH, and one
 * of them deliberately stores a template whose text is character-identical to
 * the shipped string — which is the case an output assertion cannot see.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { Pool } from 'pg';
import { withOrg } from '@/lib/tenant/context';
import * as expenses from '@/lib/expenses/service';
import * as lifecycle from '@/lib/expenses/lifecycle';
import * as approvals from '@/lib/approvals/service';
import { decide } from '@/lib/approvals/engine';
import { DEFAULT_LOCALE, shippedBody, templateKeyFor } from '@/lib/notifications/catalog';
import { TEST_ACTOR } from './support/audit-actor';
import { TODAY } from './support/dates';
import {
  listInbox,
  listSubjectActivity,
  markAllRead,
  markRead,
  notify,
  notifyRecipients,
  preferencesFor,
  recordActivity,
  renderMessage,
  setPreference,
  setTemplate,
  listTemplates,
  unreadCount,
} from '@/lib/notifications/service';

const ADMIN_URL = process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL;
if (!ADMIN_URL) {
  throw new Error(
    'notifications.db.test.ts needs ADMIN_DATABASE_URL (or DATABASE_URL). See HANDOFF.md.',
  );
}
const admin = new Pool({ connectionString: ADMIN_URL });

const SUBMITTER = 'sub@notif.test';
const APPROVED_KEY = 'expense_management.report_approved';

let orgId: string;
let categoryId: string;
let submitter: string;
let manager: string;
let second: string;
let finance: string;
let bystander: string;

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

/** A submitted report with a run open on it. */
async function submitted(amountMinor = 1000, title = 'Trip') {
  const reportId = await withOrg(orgId, async (tx) => {
    const report = await expenses.createReport(tx, SUBMITTER, {
      title,
      currencyCode: 'CAD',
    });
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

function inboxOf(userId: string, unreadOnly = false) {
  return withOrg(orgId, (tx) => listInbox(tx, userId, { unreadOnly }));
}

function approve(taskId: string, actorId: string) {
  return withOrg(orgId, (tx) =>
    decide(tx, taskId, actorId, 'APPROVED', { receiptViewAcknowledged: true }),
  );
}

beforeAll(async () => {
  await admin.query('TRUNCATE app_user, organization CASCADE');
  const o = await admin.query(
    "INSERT INTO organization (slug, name) VALUES ('notif-co','Notif Co') RETURNING id",
  );
  orgId = o.rows[0].id;
  manager = await mkUser('mgr@notif.test', 'MANAGER');
  submitter = await mkUser(SUBMITTER, 'EMPLOYEE', manager);
  second = await mkUser('second@notif.test', 'MANAGER', null);
  finance = await mkUser('fin@notif.test', 'ADMIN');
  bystander = await mkUser('by@notif.test', 'MANAGER');
  await withOrg(orgId, async (tx) => {
    const c = await tx.query(
      `INSERT INTO expense_category (organization_id, code, label) VALUES ($1,'meals','{"en":"Meals"}') RETURNING id`,
      [orgId],
    );
    categoryId = c.rows[0].id;
  });
});

/**
 * A clean slate per test, keeping only the cast.
 *
 * Most tests here COUNT notifications, so a row left behind by an earlier test
 * is a wrong answer rather than noise — the same leakage `routing.db.test.ts`,
 * `approval-inbox.db.test.ts` and `delegations.db.test.ts` all fix this way, and
 * the one I twice talked myself out of before being proved wrong.
 *
 * ONE statement string, so it runs on ONE pooled connection: the audit purge
 * hatch is transaction-local, and opening it in a separate `query()` call would
 * set it on a connection that goes back to the pool before the DELETE runs.
 * `notification` before `activity` and both before `app_user`, explicitly,
 * rather than relying on the cascades — a missing ON DELETE clause should fail
 * here loudly instead of leaving rows behind quietly.
 */
beforeEach(async () => {
  await admin.query(
    `BEGIN;
     SELECT set_config('app.audit_purge', 'on', true);
     DELETE FROM audit_entry;
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
  await admin.end();
});

/* ── the acceptance criteria ───────────────────────────────────────────────── */

describe('a decision notifies the submitter', () => {
  it('lands in the submitter inbox, with the report named and the amount formatted', async () => {
    const { reportId, taskId } = await submitted(123456, 'Berlin');
    await approve(taskId!, manager);

    const mine = await inboxOf(submitter);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({
      eventType: 'APPROVED',
      subjectType: 'EXPENSE_REPORT',
      subjectId: reportId,
      actorId: manager,
      actorName: 'mgr',
      readAt: null,
      fromTemplate: false,
    });
    // The placeholders actually resolved — a body still carrying `{report}` is
    // the failure this asserts against, and it is invisible if you only check
    // that a row exists.
    expect(mine[0].body).toContain('Berlin');
    expect(mine[0].body).not.toContain('{');

    // The AMOUNT is asserted on the approver's notification, not the
    // submitter's, because that is where it belongs and where the copy carries
    // it. `report_awaiting_approval` says "{actor} needs your approval on
    // {report} ({total})"; `report_approved` deliberately does not repeat the
    // figure back to the person who filed it — they know what the trip cost, and
    // the approver is the one being asked to commit money sight-unseen.
    //
    // Asserting `{total}` on the APPROVED sentence was this test's own mistake,
    // and the right fix was to assert it where it is used rather than to add a
    // placeholder to shipped copy so a test would pass.
    //
    // Grouped digits, not the currency symbol: `Intl.NumberFormat` renders CAD
    // as '$' under en-CA and 'CA$' under a fallback locale, so the symbol
    // asserts the runner's ICU data. `test/money.test.ts` made the same choice.
    const theirs = await inboxOf(manager);
    expect(theirs[0].eventType).toBe('TASK_ASSIGNED');
    expect(theirs[0].body).toContain('1,234.56');
    expect(theirs[0].body).not.toContain('{');

    // The control: nobody else hears about it.
    expect(await inboxOf(bystander)).toHaveLength(0);
    expect(await inboxOf(finance)).toHaveLength(0);
  });

  it('tells the approver at submit, not the submitter', async () => {
    await submitted();
    const theirs = await inboxOf(manager);
    expect(theirs).toHaveLength(1);
    expect(theirs[0]).toMatchObject({ eventType: 'TASK_ASSIGNED', actorName: 'sub' });
    // The submitter is the ACTOR of their own submit, so they get nothing —
    // the person who clicked Submit does not need telling that they clicked it.
    expect(await inboxOf(submitter)).toHaveLength(0);
  });

  it('never tells the actor about their own action', async () => {
    // The general rule, made visible: `notifyRecipients` drops the actor even
    // when a caller passes them. Without it, an approver who approves gets a
    // bell saying they approved.
    const { reportId } = await submitted();
    const out = await withOrg(orgId, (tx) =>
      notify(
        tx,
        {
          subjectType: 'EXPENSE_REPORT',
          subjectId: reportId,
          eventType: 'APPROVED',
          actorId: manager,
          payload: { report: 'x' },
        },
        [manager, submitter],
      ),
    );
    expect(out.notified).toEqual([submitter]);
  });

  it('rejects and returns reach the submitter too', async () => {
    for (const decision of ['REJECTED', 'RETURNED'] as const) {
      await admin.query(
        `BEGIN;
         SELECT set_config('app.audit_purge','on',true);
         DELETE FROM audit_entry; DELETE FROM notification; DELETE FROM activity;
         DELETE FROM approval_task; DELETE FROM approval_request;
         DELETE FROM expense_report_event; DELETE FROM expense_line_item;
         DELETE FROM expense; DELETE FROM expense_report;
         COMMIT;`,
      );
      const { taskId } = await submitted();
      await withOrg(orgId, (tx) => decide(tx, taskId!, manager, decision));
      const mine = await inboxOf(submitter);
      expect(mine.map((r) => r.eventType), decision).toEqual([decision]);
    }
  });
});

describe('preferences suppress it', () => {
  it('a muted event does not appear in the list or the count', async () => {
    const { taskId } = await submitted();
    await approve(taskId!, manager);
    expect(await inboxOf(submitter)).toHaveLength(1);
    expect(await withOrg(orgId, (tx) => unreadCount(tx, submitter))).toBe(1);

    await withOrg(orgId, (tx) => setPreference(tx, submitter, 'APPROVED', 'IN_APP', false));
    expect(await inboxOf(submitter)).toHaveLength(0);
    expect(await withOrg(orgId, (tx) => unreadCount(tx, submitter))).toBe(0);
  });

  it('mutes only the event it names', async () => {
    await withOrg(orgId, (tx) => setPreference(tx, submitter, 'REJECTED', 'IN_APP', false));
    const { taskId } = await submitted();
    await approve(taskId!, manager);
    // APPROVED is untouched. Without this the test above passes on a build where
    // one mute silences everything.
    expect(await inboxOf(submitter)).toHaveLength(1);
  });

  it('filters at READ time, so un-muting brings the history back', async () => {
    // The consequence of the design, asserted so it is a decision and not a
    // surprise: the row is written whenever ANY channel wants it, and the bell
    // filters. Suppressing the ROW would make IN_APP a master switch that
    // silently mutes the email VX2-8 will send from the same row.
    const { taskId } = await submitted();
    await withOrg(orgId, (tx) => setPreference(tx, submitter, 'APPROVED', 'IN_APP', false));
    await approve(taskId!, manager);
    expect(await inboxOf(submitter)).toHaveLength(0);

    await withOrg(orgId, (tx) => setPreference(tx, submitter, 'APPROVED', 'IN_APP', null));
    expect(await inboxOf(submitter)).toHaveLength(1);
  });

  it('writes no row at all when every channel is off', async () => {
    for (const channel of ['IN_APP', 'EMAIL', 'SLACK'] as const) {
      await withOrg(orgId, (tx) => setPreference(tx, submitter, 'APPROVED', channel, false));
    }
    const { reportId } = await submitted();
    const out = await withOrg(orgId, (tx) =>
      notify(
        tx,
        {
          subjectType: 'EXPENSE_REPORT',
          subjectId: reportId,
          eventType: 'APPROVED',
          actorId: manager,
        },
        [submitter],
      ),
    );
    // Nothing to deliver anywhere, so nothing is stored — and therefore nothing
    // reappears if they un-mute in-app alone.
    expect(out.notified).toEqual([]);
    // Scoped to the SUBMITTER. `submitted()` above already wrote a TASK_ASSIGNED
    // row to the manager, so an unscoped `count(*) FROM notification` counts
    // somebody else's inbox and fails — which is exactly what it did.
    const rows = await admin.query(
      'SELECT count(*)::int AS n FROM notification WHERE recipient_id = $1',
      [submitter],
    );
    expect(rows.rows[0].n).toBe(0);
  });

  it('clearing an override returns the user to the default, not to its current value', async () => {
    await withOrg(orgId, (tx) => setPreference(tx, submitter, 'APPROVED', 'SLACK', true));
    expect((await withOrg(orgId, (tx) => preferencesFor(tx, submitter))).get('APPROVED:SLACK')).toBe(
      true,
    );
    await withOrg(orgId, (tx) => setPreference(tx, submitter, 'APPROVED', 'SLACK', null));
    // The ROW is gone, which is the point — a stored `false` would pin them to
    // today's default forever (GAP-AUDIT NT-3).
    const after = await withOrg(orgId, (tx) => preferencesFor(tx, submitter));
    expect(after.has('APPROVED:SLACK')).toBe(false);
  });

  it('refuses an unknown event type or channel', async () => {
    await expect(
      withOrg(orgId, (tx) => setPreference(tx, submitter, 'NOPE', 'IN_APP', false)),
    ).rejects.toThrow(/unknown event type/);
    await expect(
      withOrg(orgId, (tx) => setPreference(tx, submitter, 'APPROVED', 'CARRIER_PIGEON', false)),
    ).rejects.toThrow(/unknown channel/);
  });
});

describe('an empty template table still renders shipped copy', () => {
  it('reports fromTemplate=false, not merely the right words', async () => {
    // THE test ExpenseOS got wrong. Asserting the sentence cannot distinguish
    // "the shipped string" from "a stored template that happens to say the same
    // thing", so this asserts the PATH.
    const out = await withOrg(orgId, (tx) =>
      renderMessage(tx, {
        channel: 'IN_APP',
        eventType: 'APPROVED',
        subjectType: 'EXPENSE_REPORT',
        values: { actor: 'Ada', report: 'Q3' },
      }),
    );
    expect(out.fromTemplate).toBe(false);
    expect(out.body).toBe(
      shippedBody('APPROVED', 'EXPENSE_REPORT', DEFAULT_LOCALE)
        .replace('{actor}', 'Ada')
        .replace('{report}', 'Q3'),
    );
  });

  it('a stored template overrides it, and says so', async () => {
    await withOrg(orgId, (tx) =>
      setTemplate(tx, finance, {
        templateKey: APPROVED_KEY,
        channel: 'IN_APP',
        body: '{actor} signed off {report}. Nice.',
      }),
    );
    const out = await withOrg(orgId, (tx) =>
      renderMessage(tx, {
        channel: 'IN_APP',
        eventType: 'APPROVED',
        subjectType: 'EXPENSE_REPORT',
        values: { actor: 'Ada', report: 'Q3' },
      }),
    );
    expect(out).toMatchObject({ fromTemplate: true, body: 'Ada signed off Q3. Nice.' });
  });

  it('distinguishes the two paths even when the text is IDENTICAL', async () => {
    // Precisely the case that made ExpenseOS's assertion vacuous: store the
    // shipped string verbatim as a template. An output assertion cannot tell
    // these apart; `fromTemplate` can, and it is the reason the field exists.
    const shipped = shippedBody('APPROVED', 'EXPENSE_REPORT', DEFAULT_LOCALE);
    const before = await withOrg(orgId, (tx) =>
      renderMessage(tx, { channel: 'IN_APP', eventType: 'APPROVED', subjectType: 'EXPENSE_REPORT' }),
    );
    await withOrg(orgId, (tx) =>
      setTemplate(tx, finance, { templateKey: APPROVED_KEY, channel: 'IN_APP', body: shipped }),
    );
    const after = await withOrg(orgId, (tx) =>
      renderMessage(tx, { channel: 'IN_APP', eventType: 'APPROVED', subjectType: 'EXPENSE_REPORT' }),
    );
    expect(before.body).toBe(after.body);
    expect(before.fromTemplate).toBe(false);
    expect(after.fromTemplate).toBe(true);
  });

  it('a template for another CHANNEL does not answer for this one', async () => {
    await withOrg(orgId, (tx) =>
      setTemplate(tx, finance, {
        templateKey: APPROVED_KEY,
        channel: 'EMAIL',
        body: 'email wording',
        subject: 'subj',
      }),
    );
    const inApp = await withOrg(orgId, (tx) =>
      renderMessage(tx, { channel: 'IN_APP', eventType: 'APPROVED', subjectType: 'EXPENSE_REPORT' }),
    );
    expect(inApp.fromTemplate).toBe(false);
  });

  it('the inbox renders the tenant wording once it exists', async () => {
    const { taskId } = await submitted(500, 'Lisbon');
    await approve(taskId!, manager);
    expect((await inboxOf(submitter))[0].fromTemplate).toBe(false);

    await withOrg(orgId, (tx) =>
      setTemplate(tx, finance, {
        templateKey: APPROVED_KEY,
        channel: 'IN_APP',
        body: 'Signed off: {report} for {total}.',
      }),
    );
    const after = (await inboxOf(submitter))[0];
    expect(after.fromTemplate).toBe(true);
    // Same reason as above: the amount's digits are the product's behaviour, the
    // currency symbol is ICU's.
    expect(after.body).toMatch(/^Signed off: Lisbon for .*5\.00\.$/);
  });

  it('clearing a template is a RESET, not a stored blank', async () => {
    await withOrg(orgId, (tx) =>
      setTemplate(tx, finance, { templateKey: APPROVED_KEY, channel: 'IN_APP', body: 'mine' }),
    );
    await withOrg(orgId, (tx) =>
      setTemplate(tx, finance, { templateKey: APPROVED_KEY, channel: 'IN_APP', body: null }),
    );
    // No row survives — "reset to shipped" and "shipped" are ONE state, not two
    // that render the same.
    const rows = await admin.query('SELECT count(*)::int AS n FROM notification_template');
    expect(rows.rows[0].n).toBe(0);
    const out = await withOrg(orgId, (tx) =>
      renderMessage(tx, { channel: 'IN_APP', eventType: 'APPROVED', subjectType: 'EXPENSE_REPORT' }),
    );
    expect(out.fromTemplate).toBe(false);
  });

  it('a whitespace-only body is a reset too', async () => {
    await withOrg(orgId, (tx) =>
      setTemplate(tx, finance, { templateKey: APPROVED_KEY, channel: 'IN_APP', body: '   ' }),
    );
    const rows = await admin.query('SELECT count(*)::int AS n FROM notification_template');
    expect(rows.rows[0].n).toBe(0);
  });

  it('refuses a key nothing renders from', async () => {
    await expect(
      withOrg(orgId, (tx) =>
        setTemplate(tx, finance, {
          templateKey: 'marketing.newsletter',
          channel: 'IN_APP',
          body: 'x',
        }),
      ),
    ).rejects.toThrow(/unknown template key/);
    // Well-formed AND owned, but not in the registry: still refused, because a
    // row nothing resolves to is a row nobody will ever read.
    await expect(
      withOrg(orgId, (tx) =>
        setTemplate(tx, finance, {
          templateKey: 'expense_management.no_such_message',
          channel: 'IN_APP',
          body: 'x',
        }),
      ),
    ).rejects.toThrow(/unknown template key/);
  });

  it('lists every shipped message whether or not a row exists', async () => {
    // Driven by the CODE registry, left-joined to the table — which is what
    // makes a fresh tenant's zero rows a working configuration and not an empty
    // screen.
    const before = await withOrg(orgId, (tx) => listTemplates(tx, 'IN_APP'));
    expect(before.length).toBeGreaterThan(0);
    expect(before.every((t) => t.body === null)).toBe(true);
    expect(before.every((t) => t.shipped.length > 0)).toBe(true);

    await withOrg(orgId, (tx) =>
      setTemplate(tx, finance, { templateKey: APPROVED_KEY, channel: 'IN_APP', body: 'mine' }),
    );
    const after = await withOrg(orgId, (tx) => listTemplates(tx, 'IN_APP'));
    expect(after).toHaveLength(before.length);
    const row = after.find((t) => t.templateKey === APPROVED_KEY);
    expect(row).toMatchObject({ body: 'mine', updatedByName: 'fin' });
  });
});

/* ── the fan-out ───────────────────────────────────────────────────────────── */

describe('the fan-out', () => {
  it('de-dupes recipients and cannot write two rows for one pair', async () => {
    const { reportId } = await submitted();
    const activityId = await withOrg(orgId, (tx) =>
      recordActivity(tx, {
        subjectType: 'EXPENSE_REPORT',
        subjectId: reportId,
        eventType: 'APPROVED',
        actorId: manager,
      }),
    );
    // Three mentions of one person in one call.
    const first = await withOrg(orgId, (tx) =>
      notifyRecipients(tx, activityId, [submitter, submitter, null, undefined, submitter]),
    );
    expect(first).toEqual([submitter]);
    // And a SECOND fan-out of the same activity, which the application de-dupe
    // cannot see. ExpenseOS documents "one row per (activity, recipient)" and
    // enforces nothing; `0011` carries the UNIQUE.
    const again = await withOrg(orgId, (tx) => notifyRecipients(tx, activityId, [submitter]));
    expect(again).toEqual([]);
    expect(await inboxOf(submitter)).toHaveLength(1);
  });

  it('tells every active holder of a claim role, and nobody who is not one', async () => {
    // A role pool is the one fan-out wider than one person: nobody is assigned
    // from it, so a task nobody is told about is a task nobody claims.
    await withOrg(orgId, (tx) =>
      approvals.createPolicy(tx, {
        name: 'Finance',
        sequence: 1,
        thresholdMinor: '0',
        requireReceiptViewAck: false,
        enabled: true,
        approvers: [{ position: 1, approverKind: 'ROLE', approverRole: 'ADMIN' }],
      }),
    );
    const otherAdmin = await mkUser('fin2@notif.test', 'ADMIN');
    const goneAdmin = await mkUser('fin3@notif.test', 'ADMIN');
    await admin.query("UPDATE app_user SET employee_status = 'DEACTIVATED' WHERE id = $1", [
      goneAdmin,
    ]);

    await submitted();
    expect((await inboxOf(finance)).map((r) => r.eventType)).toEqual(['TASK_ASSIGNED']);
    expect((await inboxOf(otherAdmin)).map((r) => r.eventType)).toEqual(['TASK_ASSIGNED']);
    // Membership has to mean ACTIVE membership, and a MANAGER is not in the
    // ADMIN pool.
    expect(await inboxOf(goneAdmin)).toHaveLength(0);
    expect(await inboxOf(bystander)).toHaveLength(0);

    // DEACTIVATED rather than deleted: `activity.actor_id` is ON DELETE
    // RESTRICT, so a hard delete here would either fail or depend on these two
    // never having acted — a fixture that works by luck. Taking them out of the
    // ADMIN pool is all the next test needs.
    await admin.query(
      "UPDATE app_user SET employee_status = 'DEACTIVATED' WHERE id = ANY($1::uuid[])",
      [[otherAdmin, goneAdmin]],
    );
  });

  it('tells the next step approver when a middle step passes, and not the submitter', async () => {
    await withOrg(orgId, async (tx) => {
      await approvals.createPolicy(tx, {
        name: 'Manager',
        sequence: 1,
        thresholdMinor: '0',
        requireReceiptViewAck: false,
        enabled: true,
        approvers: [{ position: 1, approverKind: 'MANAGER', managerLevel: 1 }],
      });
      await approvals.createPolicy(tx, {
        name: 'Second',
        sequence: 2,
        thresholdMinor: '0',
        requireReceiptViewAck: false,
        enabled: true,
        approvers: [{ position: 1, approverKind: 'USER', approverUserId: second }],
      });
    });
    const { taskId } = await submitted();
    await approve(taskId!, manager);

    expect((await inboxOf(second)).map((r) => r.eventType)).toEqual(['TASK_ASSIGNED']);
    // A bell per rung is how somebody learns to ignore the bell. The submitter
    // hears from us when the run ENDS, not at every step.
    expect(await inboxOf(submitter)).toHaveLength(0);
  });

  it('tells the approvers whose tasks a recall just cancelled', async () => {
    const { reportId } = await submitted();
    expect((await inboxOf(manager)).map((r) => r.eventType)).toEqual(['TASK_ASSIGNED']);
    await withOrg(orgId, (tx) => lifecycle.recallReport(tx, reportId, submitter));

    const theirs = await inboxOf(manager);
    expect(theirs.map((r) => r.eventType).sort()).toEqual(['RECALLED', 'TASK_ASSIGNED']);
    // The submitter recalled it, so they are the actor and hear nothing.
    expect(await inboxOf(submitter)).toHaveLength(0);
  });

  it('refuses an unknown event type at the point of recording', async () => {
    const { reportId } = await submitted();
    await expect(
      withOrg(orgId, (tx) =>
        recordActivity(tx, {
          subjectType: 'EXPENSE_REPORT',
          subjectId: reportId,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          eventType: 'INVENTED' as any,
          actorId: manager,
        }),
      ),
    ).rejects.toThrow(/unknown event type/);
  });

  it('a payload key cannot shadow {actor}', async () => {
    // Rule 4 of the substitution rules, end to end. The payload arrives from a
    // caller; `actor` is supplied by the machinery and applied last.
    const { reportId } = await submitted();
    await withOrg(orgId, (tx) =>
      notify(
        tx,
        {
          subjectType: 'EXPENSE_REPORT',
          subjectId: reportId,
          eventType: 'APPROVED',
          actorId: manager,
          payload: { actor: 'AN IMPOSTOR', report: 'Q3' },
        },
        [submitter],
      ),
    );
    const body = (await inboxOf(submitter))[0].body;
    expect(body).toContain('mgr');
    expect(body).not.toContain('IMPOSTOR');
  });
});

/* ── read state ────────────────────────────────────────────────────────────── */

describe('read state', () => {
  it('marks one read, idempotently, and only for its own recipient', async () => {
    const { taskId } = await submitted();
    await approve(taskId!, manager);
    const id = (await inboxOf(submitter))[0].notificationId;

    expect(await withOrg(orgId, (tx) => markRead(tx, id, submitter))).toBe(true);
    // Already read: false, not an error. A double-click is not a failure.
    expect(await withOrg(orgId, (tx) => markRead(tx, id, submitter))).toBe(false);
    expect(await withOrg(orgId, (tx) => unreadCount(tx, submitter))).toBe(0);
    expect((await inboxOf(submitter, true))).toHaveLength(0);
    expect(await inboxOf(submitter)).toHaveLength(1);
  });

  it('will not let somebody else mark your mail read', async () => {
    // `WHERE recipient_id = $2` is the authorization, not a filter: RLS scopes
    // the row to the tenant, this scopes it to the person. Without it a
    // colleague's notification id would be enough.
    const { taskId } = await submitted();
    await approve(taskId!, manager);
    const id = (await inboxOf(submitter))[0].notificationId;
    expect(await withOrg(orgId, (tx) => markRead(tx, id, bystander))).toBe(false);
    expect(await withOrg(orgId, (tx) => unreadCount(tx, submitter))).toBe(1);
  });

  it('marks all read without touching a muted event', async () => {
    const { taskId } = await submitted();
    await approve(taskId!, manager);
    await withOrg(orgId, (tx) => setPreference(tx, submitter, 'APPROVED', 'IN_APP', false));

    expect(await withOrg(orgId, (tx) => markAllRead(tx, submitter))).toBe(0);
    // Un-mute and it is still UNREAD — "mark all read" meant the things they
    // could see, and it did not quietly consume the one they had hidden.
    await withOrg(orgId, (tx) => setPreference(tx, submitter, 'APPROVED', 'IN_APP', null));
    expect(await withOrg(orgId, (tx) => unreadCount(tx, submitter))).toBe(1);
  });
});

/* ── the subject stream ────────────────────────────────────────────────────── */

describe('listSubjectActivity', () => {
  it('returns a subject stream newest first', async () => {
    const { reportId, taskId } = await submitted();
    await approve(taskId!, manager);
    const stream = await withOrg(orgId, (tx) =>
      listSubjectActivity(tx, 'EXPENSE_REPORT', reportId),
    );
    expect(stream.map((s) => s.eventType)).toEqual(['APPROVED', 'TASK_ASSIGNED']);
    expect(stream[0].actorName).toBe('mgr');
  });

  it('carries the key its template resolves through', async () => {
    // A cheap guard on the registry matching what the engine actually emits: if
    // a wiring change started writing an event type the registry does not map,
    // this fails rather than quietly falling back to ugly copy in production.
    const { reportId, taskId } = await submitted();
    await approve(taskId!, manager);
    const stream = await withOrg(orgId, (tx) =>
      listSubjectActivity(tx, 'EXPENSE_REPORT', reportId),
    );
    for (const s of stream) {
      expect(templateKeyFor(s.eventType, 'EXPENSE_REPORT'), s.eventType).not.toBeNull();
    }
  });
});
