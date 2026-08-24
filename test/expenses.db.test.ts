/**
 * VX1-4 — expense-report service DB test. Exercises the service directly over a
 * tenant transaction (withOrg), so it doesn't need an auth session. Proves
 * numbering, the report→expense→line-item hierarchy, and total recompute.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { withOrg } from '@/lib/tenant/context';
import * as svc from '@/lib/expenses/service';

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
      "INSERT INTO expense_category (organization_id, code, label) VALUES ($1,'meals','Meals') RETURNING id",
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
      const expense = await svc.addExpense(tx, report.id, { currencyCode: 'CAD', merchant: 'Cafe' });
      await svc.addLineItem(tx, expense.id, { categoryId, amountMinor: 1500 });
      await svc.addLineItem(tx, expense.id, { categoryId, amountMinor: 2500 });
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
      const expense = await svc.addExpense(tx, report.id, { currencyCode: 'CAD' });
      const li = await svc.addLineItem(tx, expense.id, { categoryId, amountMinor: 999 });
      await svc.removeLineItem(tx, li.id);
      const full = await svc.getReport(tx, report.id);
      return String(full!.report.total_minor);
    });
    expect(total).toBe('0');
  });
});
