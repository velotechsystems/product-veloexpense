/**
 * VX1-4 — expense-report service DB test. Exercises the service directly over a
 * tenant transaction (withOrg), so it doesn't need an auth session. Proves
 * numbering, the report→expense→line-item hierarchy, and total recompute.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { withOrg } from '@/lib/tenant/context';
import * as svc from '@/lib/expenses/service';
import { TEST_ACTOR } from './support/audit-actor';
import { TODAY } from './support/dates';

const admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL });

let orgId: string;
let categoryId: string;

beforeAll(async () => {
  await admin.query('TRUNCATE app_user, organization CASCADE');
  const o = await admin.query("INSERT INTO organization (slug, name) VALUES ('acme','Acme') RETURNING id");
  orgId = o.rows[0].id;
  await withOrg(orgId, async (tx) => {
    await tx.query("INSERT INTO app_user (organization_id, email, display_name) VALUES ($1,'u@acme.test','U')", [orgId]);
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

describe('expense service', () => {
  it('creates a numbered report, adds lines, recomputes total', async () => {
    const result = await withOrg(orgId, async (tx) => {
      const report = await svc.createReport(tx, 'u@acme.test', { title: 'Trip', currencyCode: 'CAD' });
      const expense = await svc.addExpense(tx, TEST_ACTOR, report.id, { txnDate: TODAY, currencyCode: 'CAD', merchant: 'Cafe' });
      await svc.addLineItem(tx, TEST_ACTOR, expense.id, { categoryId, amountMinor: 1500 });
      await svc.addLineItem(tx, TEST_ACTOR, expense.id, { categoryId, amountMinor: 2500 });
      const full = await svc.getReport(tx, report.id);
      return { number: report.number, total: String(full!.report.total_minor), lines: full!.lineItems.length };
    });
    expect(result.number).toBe('EXP-000001');
    expect(result.total).toBe('4000');
    expect(result.lines).toBe(2);
  });

  it('assigns sequential per-tenant numbers', async () => {
    const r = await withOrg(orgId, (tx) => svc.createReport(tx, 'u@acme.test', { title: 'Second', currencyCode: 'CAD' }));
    expect(r.number).toBe('EXP-000002');
  });

  it('removing a line recomputes the total', async () => {
    const total = await withOrg(orgId, async (tx) => {
      const report = await svc.createReport(tx, 'u@acme.test', { title: 'Removable', currencyCode: 'CAD' });
      const expense = await svc.addExpense(tx, TEST_ACTOR, report.id, { txnDate: TODAY, currencyCode: 'CAD' });
      const li = await svc.addLineItem(tx, TEST_ACTOR, expense.id, { categoryId, amountMinor: 999 });
      await svc.removeLineItem(tx, TEST_ACTOR, li.id);
      const full = await svc.getReport(tx, report.id);
      return String(full!.report.total_minor);
    });
    expect(total).toBe('0');
  });
});

/**
 * VX1-6 — what the workbench UI leans on: the composed editor payload, the
 * DRAFT write gate, patch-with-nulls on the report header, edits (not just
 * appends) to expenses and line items, and the list filters.
 *
 * Same org/user/category as the VX1-4 block above, so this file still owns one
 * tenant and one TRUNCATE (see vitest.config.ts — the DB suites share a
 * database and must not race).
 */
describe('expense workbench (VX1-6)', () => {
  let userId: string;

  beforeAll(async () => {
    const u = await admin.query("SELECT id FROM app_user WHERE email = 'u@acme.test'");
    userId = u.rows[0].id;
    await withOrg(orgId, (tx) =>
      tx.query("INSERT INTO app_user (organization_id, email, display_name) VALUES ($1,'other@acme.test','Other')", [
        orgId,
      ]),
    );
  });

  it('composes the editor payload with per-expense subtotals and receipts', async () => {
    const view = await withOrg(orgId, async (tx) => {
      const report = await svc.createReport(tx, 'u@acme.test', { title: 'Workbench', currencyCode: 'CAD' });
      const coded = await svc.addExpense(tx, TEST_ACTOR, report.id, { txnDate: TODAY, currencyCode: 'CAD', merchant: 'Hotel' });
      await svc.addLineItem(tx, TEST_ACTOR, coded.id, { categoryId, amountMinor: 12000, description: 'Room' });
      await svc.addLineItem(tx, TEST_ACTOR, coded.id, { categoryId, amountMinor: 1560, taxMinor: 200 });
      await svc.addExpense(tx, TEST_ACTOR, report.id, { txnDate: TODAY, currencyCode: 'CAD', merchant: 'Uncoded' });
      await tx.query(
        `INSERT INTO receipt (organization_id, expense_id, s3_key, filename, content_type, size_bytes, status, uploaded_by_id)
         VALUES ($1, $2, 'org/x/receipts/1/a.pdf', 'a.pdf', 'application/pdf', 10, 'STORED', $3)`,
        [orgId, coded.id, userId],
      );
      return svc.getReportWorkbench(tx, report.id);
    });

    expect(view).not.toBeNull();
    expect(view!.report.minor_unit).toBe(2);
    expect(view!.report.submitter_email).toBe('u@acme.test');
    expect(view!.expenses).toHaveLength(2);
    expect(view!.expenses[0].subtotal_minor).toBe('13560');
    expect(view!.expenses[0].lineItems[0].category_label).toBe('Meals');
    expect(view!.expenses[0].receipts).toHaveLength(1);
    expect(view!.uncodedExpenseCount).toBe(1);
    expect(String(view!.report.total_minor)).toBe('13560');
  });

  it('clears a field with an explicit null and leaves absent keys alone', async () => {
    const after = await withOrg(orgId, async (tx) => {
      const report = await svc.createReport(tx, 'u@acme.test', {
        title: 'Patchable',
        purpose: 'Kickoff',
        currencyCode: 'CAD',
      });
      await svc.updateReport(tx, TEST_ACTOR, report.id, { title: 'Renamed' }); // purpose untouched
      const kept = await svc.getReport(tx, report.id);
      await svc.updateReport(tx, TEST_ACTOR, report.id, { purpose: null }); // purpose cleared
      const cleared = await svc.getReport(tx, report.id);
      return { kept: kept!.report, cleared: cleared!.report };
    });
    expect(after.kept.title).toBe('Renamed');
    expect(after.kept.purpose).toBe('Kickoff');
    expect(after.cleared.purpose).toBeNull();
  });

  it('carries a currency change down to the report expenses', async () => {
    const currencies = await withOrg(orgId, async (tx) => {
      const report = await svc.createReport(tx, 'u@acme.test', { title: 'FX', currencyCode: 'CAD' });
      await svc.addExpense(tx, TEST_ACTOR, report.id, { txnDate: TODAY, currencyCode: 'CAD' });
      await svc.updateReport(tx, TEST_ACTOR, report.id, { currencyCode: 'USD' });
      const view = await svc.getReportWorkbench(tx, report.id);
      return {
        report: view!.report.currency_code,
        expense: view!.expenses[0].currency_code,
      };
    });
    expect(currencies).toEqual({ report: 'USD', expense: 'USD' });
  });

  it('edits a line item and recomputes the total', async () => {
    const total = await withOrg(orgId, async (tx) => {
      const report = await svc.createReport(tx, 'u@acme.test', { title: 'Editable', currencyCode: 'CAD' });
      const expense = await svc.addExpense(tx, TEST_ACTOR, report.id, { txnDate: TODAY, currencyCode: 'CAD' });
      const line = await svc.addLineItem(tx, TEST_ACTOR, expense.id, { categoryId, amountMinor: 1000 });
      await svc.updateLineItem(tx, TEST_ACTOR, line.id, { amountMinor: 2575, description: 'Corrected' });
      const view = await svc.getReportWorkbench(tx, report.id);
      return String(view!.report.total_minor);
    });
    expect(total).toBe('2575');
  });

  it('removing an expense drops its lines but returns its receipts to the inbox', async () => {
    const result = await withOrg(orgId, async (tx) => {
      const report = await svc.createReport(tx, 'u@acme.test', { title: 'Removable', currencyCode: 'CAD' });
      const expense = await svc.addExpense(tx, TEST_ACTOR, report.id, { txnDate: TODAY, currencyCode: 'CAD' });
      await svc.addLineItem(tx, TEST_ACTOR, expense.id, { categoryId, amountMinor: 4200 });
      const receipt = await tx.query(
        `INSERT INTO receipt (organization_id, expense_id, s3_key, filename, content_type, size_bytes, status, uploaded_by_id)
         VALUES ($1, $2, 'org/x/receipts/2/b.pdf', 'b.pdf', 'application/pdf', 10, 'STORED', $3) RETURNING id`,
        [orgId, expense.id, userId],
      );
      await svc.removeExpense(tx, TEST_ACTOR, expense.id);
      const view = await svc.getReportWorkbench(tx, report.id);
      const orphan = await tx.query('SELECT expense_id FROM receipt WHERE id = $1', [receipt.rows[0].id]);
      return {
        total: String(view!.report.total_minor),
        expenses: view!.expenses.length,
        receiptExpenseId: orphan.rows[0].expense_id,
      };
    });
    expect(result).toEqual({ total: '0', expenses: 0, receiptExpenseId: null });
  });

  it('refuses every edit once the report has left DRAFT', async () => {
    await withOrg(orgId, async (tx) => {
      const report = await svc.createReport(tx, 'u@acme.test', { title: 'Locked', currencyCode: 'CAD' });
      const expense = await svc.addExpense(tx, TEST_ACTOR, report.id, { txnDate: TODAY, currencyCode: 'CAD' });
      const line = await svc.addLineItem(tx, TEST_ACTOR, expense.id, { categoryId, amountMinor: 100 });
      await tx.query("UPDATE expense_report SET status = 'SUBMITTED' WHERE id = $1", [report.id]);

      await expect(svc.updateReport(tx, TEST_ACTOR, report.id, { title: 'Nope' })).rejects.toThrow(/only DRAFT/);
      await expect(svc.addExpense(tx, TEST_ACTOR, report.id, { txnDate: TODAY, currencyCode: 'CAD' })).rejects.toThrow(/only DRAFT/);
      await expect(svc.addLineItem(tx, TEST_ACTOR, expense.id, { categoryId, amountMinor: 1 })).rejects.toThrow(/only DRAFT/);
      await expect(svc.updateLineItem(tx, TEST_ACTOR, line.id, { amountMinor: 2 })).rejects.toThrow(/only DRAFT/);
      await expect(svc.removeLineItem(tx, TEST_ACTOR, line.id)).rejects.toThrow(/only DRAFT/);
      await expect(svc.removeExpense(tx, TEST_ACTOR, expense.id)).rejects.toThrow(/only DRAFT/);
    });
  });

  it('rejects an amount that is not whole minor units', async () => {
    await withOrg(orgId, async (tx) => {
      const report = await svc.createReport(tx, 'u@acme.test', { title: 'Bad amount', currencyCode: 'CAD' });
      const expense = await svc.addExpense(tx, TEST_ACTOR, report.id, { txnDate: TODAY, currencyCode: 'CAD' });
      await expect(svc.addLineItem(tx, TEST_ACTOR, expense.id, { categoryId, amountMinor: 12.5 })).rejects.toThrow(
        /whole number of minor units/,
      );
    });
  });

  it('scopes the list to one submitter and searches title or number', async () => {
    const { mine, theirs, searched } = await withOrg(orgId, async (tx) => {
      const target = await svc.createReport(tx, 'other@acme.test', {
        title: 'Someone else trip',
        currencyCode: 'CAD',
      });
      return {
        mine: await svc.listReports(tx, { submitterEmail: 'u@acme.test' }),
        theirs: await svc.listReports(tx, { submitterEmail: 'other@acme.test' }),
        searched: await svc.listReports(tx, { search: target.number }),
      };
    });
    expect(theirs.total).toBe(1);
    expect(theirs.reports[0].submitter_email).toBe('other@acme.test');
    expect(mine.reports.every((r) => r.submitter_email === 'u@acme.test')).toBe(true);
    expect(mine.total).toBeGreaterThan(1);
    expect(searched.total).toBe(1);
    expect(searched.reports[0].title).toBe('Someone else trip');
  });

  it('lists only active categories for the picker', async () => {
    const codes = await withOrg(orgId, async (tx) => {
      await tx.query(
        `INSERT INTO expense_category (organization_id, code, label, active) VALUES ($1,'retired','{"en":"Retired"}',false)`,
        [orgId],
      );
      const active = await svc.listCategories(tx);
      const all = await svc.listCategories(tx, { includeInactive: true });
      return { active: active.map((c) => c.code), all: all.map((c) => c.code) };
    });
    expect(codes.active).toContain('meals');
    expect(codes.active).not.toContain('retired');
    expect(codes.all).toContain('retired');
  });
});
