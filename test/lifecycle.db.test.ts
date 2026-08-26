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
import { withOrg } from '@/lib/tenant/context';
import * as expenses from '@/lib/expenses/service';
import * as policy from '@/lib/policy/service';
import * as lifecycle from '@/lib/expenses/lifecycle';

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
    const expense = await expenses.addExpense(tx, report.id, {
      currencyCode: 'CAD',
      merchant: 'Merchant',
    });
    const line = await expenses.addLineItem(tx, expense.id, { categoryId, amountMinor });
    return { reportId: report.id as string, expenseId: expense.id as string, lineId: line.id as string };
  });
}

beforeAll(async () => {
  await admin.query('TRUNCATE app_user, organization CASCADE');
  const o = await admin.query(
    "INSERT INTO organization (slug, name) VALUES ('lifecycle-co','Lifecycle Co') RETURNING id",
  );
  orgId = o.rows[0].id;
  await withOrg(orgId, async (tx) => {
    const u = await tx.query(
      "INSERT INTO app_user (organization_id, email, display_name) VALUES ($1,'l@lifecycle.test','L') RETURNING id",
      [orgId],
    );
    userId = u.rows[0].id;
    const c = await tx.query(
      "INSERT INTO expense_category (organization_id, code, label) VALUES ($1,'meals','Meals') RETURNING id",
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
      await expenses.addExpense(tx, report.id, { currencyCode: 'CAD' });
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
      await expenses.updateLineItem(tx, lineId, { amountMinor: 1000 });
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

  it('allows submit over a WARNING, acknowledged or not', async () => {
    const { reportId } = await draft(75_00);
    const result = await withOrg(orgId, async (tx) => {
      await tx.query('DELETE FROM expense_policy');
      await policy.createPolicy(tx, {
        kind: 'PER_TRANSACTION_LIMIT',
        severity: 'WARNING',
        params: { thresholdMinor: 50_00 },
      });
      return lifecycle.submitReport(tx, reportId, userId);
    });
    expect(result.report.status).toBe('SUBMITTED');
    expect(result.validation.counts.WARNING).toBe(1);
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
      await expect(expenses.updateReport(tx, reportId, { title: 'Nope' })).rejects.toThrow(/only DRAFT/);
      await expect(expenses.addLineItem(tx, expenseId, { categoryId, amountMinor: 1 })).rejects.toThrow(/only DRAFT/);
      await expect(expenses.removeLineItem(tx, lineId)).rejects.toThrow(/only DRAFT/);
      await expect(expenses.deleteReport(tx, reportId)).rejects.toThrow(/only DRAFT/);
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
      await expenses.updateLineItem(tx, lineId, { amountMinor: 2200 });
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
