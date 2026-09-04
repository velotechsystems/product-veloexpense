/**
 * VX2-9 — the reimbursement transition, against a real Postgres.
 *
 * Own org slug ('reimb-co') because the DB suites share one database and each
 * TRUNCATEs (vitest.config.ts, fileParallelism: false).
 *
 * ── The two tests worth reading ─────────────────────────────────────────────
 *
 * `two callers race` is the one this ticket exists to get right. ExpenseOS reads
 * the status in one query and writes with `where: { id }` — the update never
 * re-asserts what the read checked — so two concurrent calls both write,
 * producing two audit rows and two notifications for ONE payment (GAP-AUDIT
 * RB-2). That test runs two real overlapping transactions and asserts exactly one
 * of them wins.
 *
 * `refuses your own report` is the divergence. ExpenseOS has no self-payment
 * check at all, in a codebase whose `canDecide` ordering exists because
 * self-APPROVAL is a SOX-grade control. Approval is an opinion that money should
 * move; payment asserts that it did.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { Pool } from 'pg';
import { withOrg } from '@/lib/tenant/context';
import * as expenses from '@/lib/expenses/service';
import * as lifecycle from '@/lib/expenses/lifecycle';
import { decide } from '@/lib/approvals/engine';
import { verifyChain } from '@/lib/audit/verify';
import { listInbox } from '@/lib/notifications/service';
import { TEST_ACTOR } from './support/audit-actor';

const ADMIN_URL = process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL;
if (!ADMIN_URL) {
  throw new Error('reimbursement.db.test.ts needs ADMIN_DATABASE_URL (or DATABASE_URL).');
}
const admin = new Pool({ connectionString: ADMIN_URL });

const SUBMITTER = 'sub@reimb.test';

let orgId: string;
let categoryId: string;
let submitter: string;
let manager: string;
let finance: string;

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

async function setBreakGlass(on: boolean) {
  await admin.query('UPDATE organization SET allow_sole_approver_self_approval = $1', [on]);
}

/** A report all the way to APPROVED, which is the only payable state. */
async function approved(amountMinor = 125000, title = 'Zurich', submitterEmail = SUBMITTER) {
  const reportId = await withOrg(orgId, async (tx) => {
    const report = await expenses.createReport(tx, submitterEmail, {
      title,
      currencyCode: 'CAD',
    });
    const expense = await expenses.addExpense(tx, TEST_ACTOR, report.id, {
      currencyCode: 'CAD',
      merchant: 'M',
    });
    await expenses.addLineItem(tx, TEST_ACTOR, expense.id, { categoryId, amountMinor });
    return report.id as string;
  });
  const who = submitterEmail === SUBMITTER ? submitter : finance;
  const { approval } = await withOrg(orgId, (tx) => lifecycle.submitReport(tx, reportId, who));
  // The approver is ALWAYS `manager`, whoever submitted: both `submitter` and
  // `finance` have `manager` as their manager_id, and the default ladder routes
  // to the submitter's direct manager. The first version of this helper picked
  // the approver with a ternary and named `submitter` when finance submitted,
  // which is nobody's approver — so the two self-payment tests failed inside the
  // FIXTURE with NOT_AN_APPROVER and never reached their assertions.
  await withOrg(orgId, (tx) =>
    decide(tx, approval.taskId, manager, 'APPROVED', { receiptViewAcknowledged: true }),
  );
  return reportId;
}

function reportRow(reportId: string) {
  return admin
    .query(
      `SELECT status, reimbursed_at, reimbursed_by_id, reimbursement_reference
         FROM expense_report WHERE id = $1`,
      [reportId],
    )
    .then((r) => r.rows[0]);
}

beforeAll(async () => {
  await admin.query('TRUNCATE app_user, organization CASCADE');
  const o = await admin.query(
    "INSERT INTO organization (slug, name) VALUES ('reimb-co','Reimb Co') RETURNING id",
  );
  orgId = o.rows[0].id;
  manager = await mkUser('mgr@reimb.test', 'MANAGER');
  submitter = await mkUser(SUBMITTER, 'EMPLOYEE', manager);
  // finance is an ADMIN who also has a manager, so their own report can route
  // and be approved — which is what makes the self-payment tests possible.
  finance = await mkUser('fin@reimb.test', 'ADMIN', manager);
  await withOrg(orgId, async (tx) => {
    const c = await tx.query(
      "INSERT INTO expense_category (organization_id, code, label) VALUES ($1,'meals','Meals') RETURNING id",
      [orgId],
    );
    categoryId = c.rows[0].id;
  });
});

beforeEach(async () => {
  await setBreakGlass(false);
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
  await admin.end();
});

/* ── the happy path ────────────────────────────────────────────────────────── */

describe('reimburseReport', () => {
  it('pays an approved report and stamps who, when and against what', async () => {
    const reportId = await approved(125000, 'Zurich');
    const out = await withOrg(orgId, (tx) =>
      lifecycle.reimburseReport(tx, reportId, finance, { reference: 'EFT-2026-08-114' }),
    );
    expect(out.status).toBe('REIMBURSED');
    expect(out.reimbursed_at).toBeInstanceOf(Date);

    // The three columns ExpenseOS does not have (RB-1). Their version writes one
    // column and passes an EMPTY details object to its own audit call, while the
    // same file passes real details from its neighbouring mutations.
    const row = await reportRow(reportId);
    expect(row).toMatchObject({
      status: 'REIMBURSED',
      reimbursed_by_id: finance,
      reimbursement_reference: 'EFT-2026-08-114',
    });
    expect(row.reimbursed_at).toBeInstanceOf(Date);
  });

  it('accepts no reference, because a clerk may not have one to hand', async () => {
    const reportId = await approved();
    await withOrg(orgId, (tx) => lifecycle.reimburseReport(tx, reportId, finance));
    const row = await reportRow(reportId);
    expect(row.reimbursement_reference).toBeNull();
    // But the stamp is still complete — the reference is the only optional half.
    expect(row.reimbursed_at).toBeInstanceOf(Date);
    expect(row.reimbursed_by_id).toBe(finance);
    // A whitespace-only reference is no reference, not a stored blank. Same rule
    // as VX2-7's template body, and the same bug I wrote there before the test
    // caught it.
    const second = await approved(1000, 'Oslo');
    await withOrg(orgId, (tx) =>
      lifecycle.reimburseReport(tx, second, finance, { reference: '   ' }),
    );
    expect((await reportRow(second)).reimbursement_reference).toBeNull();
  });

  it('records the transition on the report timeline AND the hash chain', async () => {
    const reportId = await approved(125000, 'Zurich');
    await withOrg(orgId, (tx) =>
      lifecycle.reimburseReport(tx, reportId, finance, {
        reference: 'CHQ-881',
        note: 'paid with the August run',
      }),
    );

    const events = await withOrg(orgId, (tx) => lifecycle.listEvents(tx, reportId));
    const reimburse = events.find((e) => e.action === 'REIMBURSE');
    expect(reimburse).toMatchObject({
      from_status: 'APPROVED',
      to_status: 'REIMBURSED',
      actor_id: finance,
      note: 'paid with the August run',
    });

    // The chain too, because this is the only transition in the product that
    // asserts money moved.
    const audit = await admin.query(
      `SELECT action, entity_type, entity_id, details FROM audit_entry
        WHERE action = 'REPORT_REIMBURSED'`,
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({ entity_type: 'expense_report', entity_id: reportId });
    expect(audit.rows[0].details).toMatchObject({
      reference: 'CHQ-881',
      totalMinor: '125000',
      currencyCode: 'CAD',
      selfReimbursedUnderBreakGlass: false,
    });
    expect(await withOrg(orgId, (tx) => verifyChain(tx))).toMatchObject({ ok: true });
  });

  it('notifies the submitter, and not the person who paid', async () => {
    const reportId = await approved();
    await withOrg(orgId, (tx) => lifecycle.reimburseReport(tx, reportId, finance));
    const theirs = await withOrg(orgId, (tx) => listInbox(tx, submitter));
    expect(theirs.map((n) => n.eventType)).toContain('REIMBURSED');
    const paid = theirs.find((n) => n.eventType === 'REIMBURSED')!;
    expect(paid.body).toContain('reimbursed');
    expect(paid.body).not.toContain('{');
    // The actor hears nothing about their own action.
    const mine = await withOrg(orgId, (tx) => listInbox(tx, finance));
    expect(mine.map((n) => n.eventType)).not.toContain('REIMBURSED');
  });

  it('queues the email for it, so VX2-8 delivers it like any other', async () => {
    const reportId = await approved();
    await withOrg(orgId, (tx) => lifecycle.reimburseReport(tx, reportId, finance));
    const d = await admin.query(
      `SELECT d.channel, d.status, a.event_type
         FROM notification_delivery d
         JOIN notification n ON n.id = d.notification_id
         JOIN activity a ON a.id = n.activity_id
        WHERE a.event_type = 'REIMBURSED'`,
    );
    expect(d.rows).toEqual([{ channel: 'EMAIL', status: 'PENDING', event_type: 'REIMBURSED' }]);
  });
});

/* ── what it refuses ───────────────────────────────────────────────────────── */

describe('what it refuses', () => {
  it('refuses every status that is not APPROVED', async () => {
    // DRAFT.
    const draft = await withOrg(orgId, async (tx) => {
      const rep = await expenses.createReport(tx, SUBMITTER, {
        title: 'Draft',
        currencyCode: 'CAD',
      });
      return rep.id as string;
    });
    await expect(
      withOrg(orgId, (tx) => lifecycle.reimburseReport(tx, draft, finance)),
    ).rejects.toThrow(/is DRAFT; only an approved report/);

    // SUBMITTED.
    const reportId = await withOrg(orgId, async (tx) => {
      const rep = await expenses.createReport(tx, SUBMITTER, {
        title: 'Waiting',
        currencyCode: 'CAD',
      });
      const e = await expenses.addExpense(tx, TEST_ACTOR, rep.id, { currencyCode: 'CAD', merchant: 'M' });
      await expenses.addLineItem(tx, TEST_ACTOR, e.id, { categoryId, amountMinor: 1000 });
      return rep.id as string;
    });
    const { approval } = await withOrg(orgId, (tx) =>
      lifecycle.submitReport(tx, reportId, submitter),
    );
    await expect(
      withOrg(orgId, (tx) => lifecycle.reimburseReport(tx, reportId, finance)),
    ).rejects.toThrow(/is SUBMITTED/);

    // REJECTED.
    await withOrg(orgId, (tx) => decide(tx, approval.taskId, manager, 'REJECTED'));
    await expect(
      withOrg(orgId, (tx) => lifecycle.reimburseReport(tx, reportId, finance)),
    ).rejects.toThrow(/is REJECTED/);
  });

  it('cannot pay the same report twice', async () => {
    // "You cannot pay it twice" and "you cannot pay an unapproved report" are ONE
    // guard, because APPROVED is the only permitted source status (RB-8).
    const reportId = await approved();
    await withOrg(orgId, (tx) => lifecycle.reimburseReport(tx, reportId, finance));
    await expect(
      withOrg(orgId, (tx) => lifecycle.reimburseReport(tx, reportId, finance)),
    ).rejects.toThrow(/is REIMBURSED/);
    // And exactly one audit row and one notification exist for the one payment.
    const audit = await admin.query(
      "SELECT count(*)::int AS n FROM audit_entry WHERE action = 'REPORT_REIMBURSED'",
    );
    expect(audit.rows[0].n).toBe(1);
  });

  it('refuses an unknown report', async () => {
    await expect(
      withOrg(orgId, (tx) =>
        lifecycle.reimburseReport(tx, '00000000-0000-4000-8000-000000000000', finance),
      ),
    ).rejects.toThrow(/report not found/);
  });

  it('two callers race, and exactly one payment happens', async () => {
    // THE test for RB-2. Two real overlapping transactions: both read APPROVED,
    // both attempt the write, Postgres serializes them on the row and the second
    // finds `status = 'APPROVED'` no longer true — so its UPDATE matches nothing
    // and `rowCount !== 1` refuses it.
    //
    // Without the predicate in the UPDATE's WHERE — which is what ExpenseOS has —
    // both would commit, and this test would find two audit rows for one payment.
    const reportId = await approved();
    const results = await Promise.allSettled([
      withOrg(orgId, (tx) => lifecycle.reimburseReport(tx, reportId, finance, { reference: 'A' })),
      withOrg(orgId, (tx) => lifecycle.reimburseReport(tx, reportId, finance, { reference: 'B' })),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);

    const audit = await admin.query(
      "SELECT count(*)::int AS n FROM audit_entry WHERE action = 'REPORT_REIMBURSED'",
    );
    expect(audit.rows[0].n).toBe(1);
    const notif = await admin.query(
      "SELECT count(*)::int AS n FROM activity WHERE event_type = 'REIMBURSED'",
    );
    expect(notif.rows[0].n).toBe(1);
    // One reference survived, and it is the winner's.
    const row = await reportRow(reportId);
    expect(['A', 'B']).toContain(row.reimbursement_reference);
  });
});

/* ── self-payment ──────────────────────────────────────────────────────────── */

describe('self-payment', () => {
  it('refuses your own report', async () => {
    const own = await approved(9000, 'My own trip', 'fin@reimb.test');
    await expect(
      withOrg(orgId, (tx) => lifecycle.reimburseReport(tx, own, finance)),
    ).rejects.toThrow(/cannot mark your own report reimbursed/);
    // Nothing was written — not the status, not the stamp, not an audit row.
    expect(await reportRow(own)).toMatchObject({ status: 'APPROVED', reimbursed_at: null });
    const audit = await admin.query(
      "SELECT count(*)::int AS n FROM audit_entry WHERE action = 'REPORT_REIMBURSED'",
    );
    expect(audit.rows[0].n).toBe(0);

    // The control: somebody else can pay it perfectly well, so the refusal above
    // is the self-check and not a broken fixture.
    //
    // `manager` is a MANAGER, not an ADMIN, and `reimburseReport` permits them —
    // deliberately. The lib's only authorization rule is the self-payment
    // refusal; the ADMIN gate lives in `app/admin/reimbursements/actions.ts`,
    // the same split `decide` uses (its `isAdmin` is a context flag, not a
    // lookup). Asserting it here rather than leaving it implicit, because a
    // reader could otherwise take this line as evidence the lib checks roles.
    await withOrg(orgId, (tx) => lifecycle.reimburseReport(tx, own, manager));
    expect((await reportRow(own)).status).toBe('REIMBURSED');
  });

  it('permits it under the AP-14 break-glass, and records that it used it', async () => {
    // The same flag and the same audited exception AP-14 established, on the same
    // reasoning: a tenant where the admin who submits is the only person who can
    // act. RB-3 records why a second flag was rejected.
    await setBreakGlass(true);
    const own = await approved(9000, 'Sole admin trip', 'fin@reimb.test');
    await withOrg(orgId, (tx) => lifecycle.reimburseReport(tx, own, finance));
    expect((await reportRow(own)).status).toBe('REIMBURSED');

    // And the audit says which of the two paths this was, so "who paid their own
    // claim" is a query rather than an investigation.
    const audit = await admin.query(
      "SELECT details FROM audit_entry WHERE action = 'REPORT_REIMBURSED'",
    );
    expect(audit.rows[0].details).toMatchObject({ selfReimbursedUnderBreakGlass: true });
    const events = await withOrg(orgId, (tx) => lifecycle.listEvents(tx, own));
    expect(events.find((e) => e.action === 'REIMBURSE')).toBeTruthy();
  });

  it('does not block paying somebody else when the flag is off', async () => {
    // The obvious control, worth an assertion because a self-check written one
    // character wrong refuses everybody.
    const reportId = await approved();
    await withOrg(orgId, (tx) => lifecycle.reimburseReport(tx, reportId, finance));
    expect((await reportRow(reportId)).status).toBe('REIMBURSED');
  });
});

/* ── the schema's own guarantees ───────────────────────────────────────────── */

describe('the constraints in 0013', () => {
  it('refuses a stamp without a status, and a status without a stamp', async () => {
    const reportId = await approved();
    // A payment stamped onto a report that still looks payable is the exact
    // double-payment outcome RB-2 describes, so the schema refuses it rather
    // than relying on the only writer being correct.
    await expect(
      admin.query('UPDATE expense_report SET reimbursed_at = now() WHERE id = $1', [reportId]),
    ).rejects.toThrow(/expense_report_reimbursed_stamped|reimbursement_complete/);
    // And the other direction: REIMBURSED with no stamp.
    await expect(
      admin.query("UPDATE expense_report SET status = 'REIMBURSED' WHERE id = $1", [reportId]),
    ).rejects.toThrow(/expense_report_reimbursed_stamped/);
  });

  it('refuses a timestamp with no actor', async () => {
    const reportId = await approved();
    await expect(
      admin.query(
        "UPDATE expense_report SET status = 'REIMBURSED', reimbursed_at = now() WHERE id = $1",
        [reportId],
      ),
    ).rejects.toThrow(/expense_report_reimbursement_complete/);
  });
});

/* ── the AP queue ──────────────────────────────────────────────────────────── */

describe('listPayableReports', () => {
  it('lists only approved reports, oldest first, and drops them once paid', async () => {
    const first = await approved(1000, 'First');
    const second = await approved(2000, 'Second');
    // Something not payable, to prove the filter.
    await withOrg(orgId, (tx) =>
      expenses.createReport(tx, SUBMITTER, { title: 'Still a draft', currencyCode: 'CAD' }),
    );

    const payable = await withOrg(orgId, (tx) => lifecycle.listPayableReports(tx));
    expect(payable.map((p) => p.title)).toEqual(['First', 'Second']);
    expect(payable[0]).toMatchObject({ submitter_name: 'sub', currency_code: 'CAD' });

    await withOrg(orgId, (tx) => lifecycle.reimburseReport(tx, first, finance));
    const after = await withOrg(orgId, (tx) => lifecycle.listPayableReports(tx));
    expect(after.map((p) => p.id)).toEqual([second]);
  });
});
