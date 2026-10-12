/**
 * VX1-8 — report lifecycle DB test.
 *
 * Own org slug ('lifecycle-co') because the DB suites share one database and
 * each TRUNCATEs (vitest.config.ts, fileParallelism: false).
 *
 * The gate is the point of this ticket, so most of these are about what submit
 * REFUSES, and about the audit row surviving as evidence of what the gate saw.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
// w4-00c: the lifecycle starts the approval engine, which needs the tenant's Prisma
// transaction (test/support/tenant-tx.ts) — the same `QueryRunner`, under the same name.
import { seedDefaultFlow, withTenantTx as withOrg } from './support/tenant-tx';
import * as expenses from '@/lib/expenses/service';
import * as policy from '@/lib/policy/service';
import * as lifecycle from '@/lib/expenses/lifecycle';
import { TEST_ACTOR } from './support/audit-actor';
import { errorParam, userMessageOf } from '@/lib/errors/domain';
import { renderUserMessage } from '@/lib/i18n/catalog/errors';
import { TODAY } from './support/dates';

const admin = new Pool({
  connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL,
});

let orgId: string;
let userId: string;
let categoryId: string;

/** A DRAFT with one coded line, ready to submit unless a rule says otherwise. */
async function draft(amountMinor = 1000) {
  return withOrg(orgId, async (tx) => {
    const report = await expenses.createReport(tx, 'l@lifecycle.test', {
      title: 'Submittable',
      currencyCode: 'CAD',
    });
    const expense = await expenses.addExpense(tx, TEST_ACTOR, report.id, { txnDate: TODAY,
      currencyCode: 'CAD',
      merchant: 'Merchant',
    });
    const line = await expenses.addLineItem(tx, TEST_ACTOR, expense.id, { categoryId, amountMinor });
    return { reportId: report.id as string, expenseId: expense.id as string, lineId: line.id as string };
  });
}

beforeAll(async () => {
  await admin.query('TRUNCATE app_user, organization CASCADE');
  const o = await admin.query(
    "INSERT INTO organization (slug, name) VALUES ('lifecycle-co','Lifecycle Co') RETURNING id",
  );
  orgId = o.rows[0].id;
  // w4-00c: the default approval flow a provisioned tenant starts with (d54); without it a
  // submit is refused (d58).
  await seedDefaultFlow(orgId);
  await withOrg(orgId, async (tx) => {
    // A MANAGER above the submitter, added when VX2-3 made submit open an
    // approval run: submitting now routes the ladder, and a tenant whose only
    // employee has neither a manager nor an active administrator has nobody to
    // approve anything — which the resolver refuses, correctly. A one-person
    // tenant was never a realistic fixture; it just went unnoticed while submit
    // did not care who would approve.
    const m = await tx.query(
      `INSERT INTO app_user (organization_id, email, display_name, role)
       VALUES ($1,'mgr@lifecycle.test','Mgr','MANAGER') RETURNING id`,
      [orgId],
    );
    const u = await tx.query(
      `INSERT INTO app_user (organization_id, email, display_name, manager_id)
       VALUES ($1,'l@lifecycle.test','L',$2) RETURNING id`,
      [orgId, m.rows[0].id],
    );
    userId = u.rows[0].id;
    const c = await tx.query(
      `INSERT INTO expense_category (organization_id, code, label) VALUES ($1,'meals','{"en":"Meals"}') RETURNING id`,
      [orgId],
    );
    categoryId = c.rows[0].id;
  });
});

afterAll(async () => {
  await admin.end();
});

describe('submit', () => {
  it('moves a clean draft to SUBMITTED and stamps submitted_at', async () => {
    const { reportId } = await draft();
    const result = await withOrg(orgId, async (tx) => {
      await tx.query('DELETE FROM expense_policy');
      return lifecycle.submitReport(tx, reportId, userId);
    });
    expect(result.report.status).toBe('SUBMITTED');
    expect(result.report.submitted_at).not.toBeNull();
  });

  /**
   * VX4-11. `txn_date` is nullable and the form collected it without insisting, so
   * a tenant whose people skipped it got NO duplicate detection at all and nothing
   * said so — `lib/fraud/rules.ts`'s duplicate and outlier detectors both bound on
   * the column, and an undated expense is invisible to them rather than reported
   * by them.
   *
   * The gate is at SUBMIT rather than on the column, because `startFromReceipts`
   * creates one expense per uploaded receipt before anybody knows the date. A
   * draft may be incomplete; a submitted report may not.
   */
  it('REFUSES a submit while an expense has no date', async () => {
    const { reportId, expenseId } = await draft();
    await withOrg(orgId, async (tx) => {
      await tx.query('DELETE FROM expense_policy');
      await tx.query('UPDATE expense SET txn_date = NULL WHERE id = $1', [expenseId]);
    });
    const err = await withOrg(orgId, (tx) => lifecycle.submitReport(tx, reportId, userId)).catch(
      (e: unknown) => e,
    );
    expect((err as lifecycle.LifecycleError).code).toBe('UNDATED');
    expect(userMessageOf(err)?.code).toBe('SUBMIT_UNDATED_ONE');
    // Still a DRAFT — a refused submit must not half-happen.
    const after = await admin.query('SELECT status FROM expense_report WHERE id = $1', [reportId]);
    expect(after.rows[0].status).toBe('DRAFT');
  });

  it('counts them, and the plural is a different sentence', async () => {
    const { reportId, expenseId } = await draft();
    await withOrg(orgId, async (tx) => {
      await tx.query('DELETE FROM expense_policy');
      await tx.query('UPDATE expense SET txn_date = NULL WHERE id = $1', [expenseId]);
      // A second undated expense, with a line so the report stays submittable on
      // every other count.
      const e = await expenses.addExpense(tx, TEST_ACTOR, reportId, { currencyCode: 'CAD' });
      await expenses.addLineItem(tx, TEST_ACTOR, e.id, { categoryId, amountMinor: 500 });
    });
    const err = await withOrg(orgId, (tx) => lifecycle.submitReport(tx, reportId, userId)).catch(
      (e: unknown) => e,
    );
    const user = userMessageOf(err);
    expect(user?.code).toBe('SUBMIT_UNDATED_MANY');
    expect(user?.params).toMatchObject({ count: '2' });
    // The count reaches the reader through `errorParam`'s encoding, which is the
    // only path a message takes to a screen.
    expect(renderUserMessage(errorParam(err, 'test'), 'en-CA')).toContain('2 expenses');
  });

  it('lets a dated report through — the gate is the date, not the submit', async () => {
    const { reportId } = await draft();
    const result = await withOrg(orgId, async (tx) => {
      await tx.query('DELETE FROM expense_policy');
      return lifecycle.submitReport(tx, reportId, userId);
    });
    expect(result.report.status).toBe('SUBMITTED');
  });

  it('writes one audit row recording what the gate saw', async () => {
    const { reportId } = await draft(4200);
    const events = await withOrg(orgId, async (tx) => {
      await tx.query('DELETE FROM expense_policy');
      await lifecycle.submitReport(tx, reportId, userId);
      return lifecycle.listEvents(tx, reportId);
    });
    expect(events).toHaveLength(1);
    expect(events[0].action).toBe('SUBMIT');
    expect(events[0].from_status).toBe('DRAFT');
    expect(events[0].to_status).toBe('SUBMITTED');
    expect(events[0].actor_name).toBe('L');
    expect(events[0].context.totalMinor).toBe('4200');
    expect(events[0].context.violationCounts).toEqual({ INFO: 0, WARNING: 0, BLOCK: 0 });
  });

  it('refuses a report with no line items', async () => {
    const reportId = await withOrg(orgId, async (tx) => {
      const report = await expenses.createReport(tx, 'l@lifecycle.test', {
        title: 'Empty',
        currencyCode: 'CAD',
      });
      await expenses.addExpense(tx, TEST_ACTOR, report.id, { txnDate: TODAY, currencyCode: 'CAD' });
      return report.id as string;
    });
    await withOrg(orgId, async (tx) => {
      await expect(lifecycle.submitReport(tx, reportId, userId)).rejects.toThrow(/no line items/);
    });
  });

  it('refuses while a BLOCK violation is open, and allows it once fixed', async () => {
    const { reportId, lineId } = await draft(75_00);
    await withOrg(orgId, async (tx) => {
      await tx.query('DELETE FROM expense_policy');
      await policy.createPolicy(tx, {
        kind: 'PER_TRANSACTION_LIMIT',
        severity: 'BLOCK',
        params: { thresholdMinor: 50_00 },
      });
      await expect(lifecycle.submitReport(tx, reportId, userId)).rejects.toThrow(/blocking policy/);
    });

    const after = await withOrg(orgId, async (tx) => {
      await expenses.updateLineItem(tx, TEST_ACTOR, lineId, { amountMinor: 1000 });
      return lifecycle.submitReport(tx, reportId, userId);
    });
    expect(after.report.status).toBe('SUBMITTED');
  });

  it('carries the blocking findings on the error so the UI can list them', async () => {
    const { reportId } = await draft(75_00);
    await withOrg(orgId, async (tx) => {
      await tx.query('DELETE FROM expense_policy');
      await policy.createPolicy(tx, {
        kind: 'PER_TRANSACTION_LIMIT',
        severity: 'BLOCK',
        params: { thresholdMinor: 50_00 },
      });
      const error = await lifecycle
        .submitReport(tx, reportId, userId)
        .then(() => null)
        .catch((err: lifecycle.LifecycleError) => err);
      expect(error?.code).toBe('BLOCKED_BY_POLICY');
      expect(error?.violations).toHaveLength(1);
      expect(error?.violations[0].rule_code).toBe('PER_TRANSACTION_LIMIT');
    });
  });

  /**
   * w2-11 (d34): ExpenseOS's rule replaced VeloExpense's. This case used to read "allows
   * submit over a WARNING, acknowledged or not" — Module 9's "warnings propagate to the
   * approver". ExpenseOS lets a warning through only once the submitter has said why: "a
   * warning is submittable only once the submitter attaches a comment over the exception".
   * The three cases below are that rule's three answers.
   */
  const warnAbove50 = (tx: Parameters<Parameters<typeof withOrg>[1]>[0]) =>
    policy.createPolicy(tx, {
      kind: 'PER_TRANSACTION_LIMIT',
      severity: 'WARNING',
      params: { thresholdMinor: 50_00 },
    });

  it('REFUSES a submit over a WARNING nobody has justified', async () => {
    const { reportId } = await draft(75_00);
    const err = await withOrg(orgId, async (tx) => {
      await tx.query('DELETE FROM expense_policy');
      await warnAbove50(tx);
      return lifecycle.submitReport(tx, reportId, userId).catch((e: unknown) => e);
    });
    expect(err).toBeInstanceOf(lifecycle.LifecycleError);
    expect((err as lifecycle.LifecycleError).code).toBe('UNJUSTIFIED_WARNING');
    expect((err as lifecycle.LifecycleError).violations).toHaveLength(1);
    expect(userMessageOf(err)?.code).toBe('SUBMIT_UNJUSTIFIED_WARNING_ONE');
    const status = await admin.query('SELECT status FROM expense_report WHERE id = $1', [reportId]);
    expect(status.rows[0].status).toBe('DRAFT');
  });

  it('allows submit over a WARNING once it is acknowledged with a note', async () => {
    const { reportId } = await draft(75_00);
    const result = await withOrg(orgId, async (tx) => {
      await tx.query('DELETE FROM expense_policy');
      await warnAbove50(tx);
      const v = await policy.validateReport(tx, reportId);
      await policy.acknowledgeViolation(tx, v.violations[0].id, userId, 'Client dinner, approved');
      return lifecycle.submitReport(tx, reportId, userId);
    });
    expect(result.report.status).toBe('SUBMITTED');
    expect(result.validation.counts.WARNING).toBe(1);
    expect(result.validation.unjustifiedWarning).toBe(0);
  });

  it("takes the expense's explanation as the justification, and records it", async () => {
    // ExpenseOS's `explanationJustifies`: the explanation on the expense stands in for the
    // note, recorded as the submitter's.
    const { reportId, expenseId } = await draft(75_00);
    const result = await withOrg(orgId, async (tx) => {
      await tx.query('DELETE FROM expense_policy');
      await warnAbove50(tx);
      await tx.query(`UPDATE expense SET explanation = '  Team offsite  ' WHERE id = $1`, [
        expenseId,
      ]);
      return lifecycle.submitReport(tx, reportId, userId);
    });
    expect(result.report.status).toBe('SUBMITTED');
    const v = result.validation.violations[0];
    expect(v.resolve_note).toBe('Team offsite');
    expect(v.resolved_by_id).toBe(userId);
  });

  it("takes the explanation for a warning about the expense itself, not one line (w2-02b)", async () => {
    // A missing receipt is a finding about the EXPENSE: it has no line, and names the expense
    // in its data. The workbench shows it on that expense, beside the explanation field — so
    // the explanation answers it as it answers a line's.
    const { reportId, expenseId } = await draft(75_00);
    const result = await withOrg(orgId, async (tx) => {
      await tx.query('DELETE FROM expense_policy');
      await policy.createPolicy(tx, { kind: 'RECEIPT_REQUIRED', severity: 'WARNING', params: {} });
      await tx.query(`UPDATE expense SET explanation = 'Taxi, no receipt offered' WHERE id = $1`, [
        expenseId,
      ]);
      return lifecycle.submitReport(tx, reportId, userId);
    });
    expect(result.report.status).toBe('SUBMITTED');
    const v = result.validation.violations.find((x) => x.rule_code === 'RECEIPT_REQUIRED');
    expect(v?.line_item_id).toBeNull();
    expect(v?.resolve_note).toBe('Taxi, no receipt offered');
  });

  it('resubmits a RETURNED report where it stands (d26)', async () => {
    // ExpenseOS's rule: an approver sending a report back is an invitation to edit and
    // resubmit, not to recall it first.
    const { reportId } = await draft();
    await withOrg(orgId, (tx) => tx.query('DELETE FROM expense_policy'));
    await admin.query(`UPDATE expense_report SET status = 'RETURNED' WHERE id = $1`, [reportId]);
    const result = await withOrg(orgId, (tx) => lifecycle.submitReport(tx, reportId, userId));
    expect(result.report.status).toBe('SUBMITTED');
    const events = await admin.query(
      `SELECT from_status FROM expense_report_event WHERE report_id = $1 AND action = 'SUBMIT'`,
      [reportId],
    );
    expect(events.rows.map((r) => r.from_status)).toEqual(['RETURNED']);
  });

  it('re-runs the rules at submit rather than trusting the last save', async () => {
    // The report saves clean, THEN an admin adds a blocking rule. The stored
    // findings say "fine"; the submit must not.
    const { reportId } = await draft(75_00);
    await withOrg(orgId, async (tx) => {
      await tx.query('DELETE FROM expense_policy');
      const clean = await policy.getValidation(tx, reportId);
      expect(clean.violations).toHaveLength(0);
      await policy.createPolicy(tx, {
        kind: 'PER_TRANSACTION_LIMIT',
        severity: 'BLOCK',
        params: { thresholdMinor: 50_00 },
      });
      await expect(lifecycle.submitReport(tx, reportId, userId)).rejects.toThrow(/blocking policy/);
    });
  });

  it('cannot be submitted twice', async () => {
    const { reportId } = await draft();
    await withOrg(orgId, async (tx) => {
      await tx.query('DELETE FROM expense_policy');
      await lifecycle.submitReport(tx, reportId, userId);
      await expect(lifecycle.submitReport(tx, reportId, userId)).rejects.toThrow(/only a DRAFT/);
    });
  });

  it('freezes the report — edits are refused once submitted', async () => {
    const { reportId, expenseId, lineId } = await draft();
    await withOrg(orgId, async (tx) => {
      await tx.query('DELETE FROM expense_policy');
      await lifecycle.submitReport(tx, reportId, userId);
      await expect(expenses.updateReport(tx, TEST_ACTOR, reportId, { title: 'Nope' })).rejects.toThrow(/only DRAFT/);
      await expect(expenses.addLineItem(tx, TEST_ACTOR, expenseId, { categoryId, amountMinor: 1 })).rejects.toThrow(/only DRAFT/);
      await expect(expenses.removeLineItem(tx, TEST_ACTOR, lineId)).rejects.toThrow(/only DRAFT/);
      await expect(expenses.deleteReport(tx, TEST_ACTOR, reportId)).rejects.toThrow(/only DRAFT/);
    });
  });
});

describe('recall', () => {
  it('returns a submitted report to DRAFT, clears submitted_at, and logs it', async () => {
    const { reportId } = await draft();
    const result = await withOrg(orgId, async (tx) => {
      await tx.query('DELETE FROM expense_policy');
      await lifecycle.submitReport(tx, reportId, userId);
      await lifecycle.recallReport(tx, reportId, userId, 'Wrong month');
      const report = await expenses.getReport(tx, reportId);
      return { report: report!.report, events: await lifecycle.listEvents(tx, reportId) };
    });
    expect(result.report.status).toBe('DRAFT');
    expect(result.report.submitted_at).toBeNull();
    expect(result.events).toHaveLength(2);
    expect(result.events[0].action).toBe('RECALL');
    expect(result.events[0].note).toBe('Wrong month');
  });

  it('makes the report editable again and lets it be resubmitted', async () => {
    const { reportId, lineId } = await draft();
    const result = await withOrg(orgId, async (tx) => {
      await tx.query('DELETE FROM expense_policy');
      await lifecycle.submitReport(tx, reportId, userId);
      await lifecycle.recallReport(tx, reportId, userId);
      await expenses.updateLineItem(tx, TEST_ACTOR, lineId, { amountMinor: 2200 });
      return lifecycle.submitReport(tx, reportId, userId);
    });
    expect(result.report.status).toBe('SUBMITTED');
    expect(result.validation.blocking).toBe(false);
  });

  it('refuses to recall a draft', async () => {
    const { reportId } = await draft();
    await withOrg(orgId, async (tx) => {
      await expect(lifecycle.recallReport(tx, reportId, userId)).rejects.toThrow(/only a submitted/);
    });
  });

  it('recalls a RETURNED report too', async () => {
    const { reportId } = await draft();
    const status = await withOrg(orgId, async (tx) => {
      await tx.query("UPDATE expense_report SET status = 'RETURNED' WHERE id = $1", [reportId]);
      const recalled = await lifecycle.recallReport(tx, reportId, userId);
      return recalled.status;
    });
    expect(status).toBe('DRAFT');
  });
});

describe('submit readiness', () => {
  it('explains each reason a report is not ready', async () => {
    const reportId = await withOrg(orgId, async (tx) => {
      const report = await expenses.createReport(tx, 'l@lifecycle.test', {
        title: 'Not ready',
        currencyCode: 'CAD',
      });
      return report.id as string;
    });
    const readiness = await withOrg(orgId, (tx) => lifecycle.getSubmitReadiness(tx, reportId));
    expect(readiness.canSubmit).toBe(false);
    expect(readiness.canRecall).toBe(false);
    expect(readiness.reasons).toContain('it has no line items');
  });

  it('is ready for a clean draft with a line', async () => {
    const { reportId } = await draft();
    const readiness = await withOrg(orgId, async (tx) => {
      await tx.query('DELETE FROM expense_policy');
      await policy.validateReport(tx, reportId);
      return lifecycle.getSubmitReadiness(tx, reportId);
    });
    expect(readiness).toEqual({ canSubmit: true, canRecall: false, reasons: [] });
  });
});
