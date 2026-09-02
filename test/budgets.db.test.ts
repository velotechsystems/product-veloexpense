/**
 * VX4-5 part 1 — the budget schema, and the department stamped at submit.
 * Own org slugs ('bud-co', 'bud-co-2').
 *
 * ── Two layers, tested separately, for the reason 0023 established ──────────
 *
 * The CONSTRAINTS are driven with raw SQL through the admin pool, because an
 * importer, a support script, a seed and a restored backup all reach the columns
 * without reaching any service. Every one of them would still be a guarantee if
 * `lib/budgets` were deleted tomorrow.
 *
 * The STAMP is driven through `lifecycle.submitReport`, because the claim is about
 * what submitting a report DOES, and a raw UPDATE would only re-test the SQL I
 * already wrote.
 *
 * ── The assertion that mattered most ────────────────────────────────────────
 *
 * `submitReport` performs NO ownership check — the action layer does, and it allows
 * `submitter_id === actor.id || role === 'ADMIN'`. So an admin submitting somebody
 * else's report is a supported path, and the first draft of the stamp keyed on
 * `actorId`, which would have written the ADMIN's department onto an employee's
 * spend. `submitting as an ADMIN stamps the SUBMITTER's department` is that bug's
 * regression test, and it is the one test here that could not have been written
 * without noticing the ownership check is somewhere else.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { Pool } from 'pg';
import { withOrg } from '@/lib/tenant/context';
import * as expenses from '@/lib/expenses/service';
import * as lifecycle from '@/lib/expenses/lifecycle';

const admin = new Pool({
  connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL,
});

let orgId: string;
let otherOrgId: string;
/** The submitter — an EMPLOYEE in Engineering. */
let empId: string;
/** An ADMIN in Sales, who will submit on the employee's behalf. */
let admId: string;
let engineeringId: string;
let salesId: string;
let categoryId: string;
let accountId: string;
let otherAccountId: string;

beforeAll(async () => {
  await admin.query('TRUNCATE app_user, organization CASCADE');
  const o = await admin.query(
    `INSERT INTO organization (slug, name)
     VALUES ('bud-co','Bud Co'), ('bud-co-2','Bud Co 2') RETURNING id, slug`,
  );
  orgId = o.rows.find((r) => r.slug === 'bud-co').id;
  otherOrgId = o.rows.find((r) => r.slug === 'bud-co-2').id;

  // IMMEDIATELY after the orgs and BEFORE any gl_account write. Migration `0022`
  // puts `app_module_enabled('accounting')` into `gl_account`'s RLS policy, so an
  // unentitled tenant cannot insert one — the fail-closed default VX4-1 chose on
  // purpose. The first draft of this file created the accounts first and got
  // "new row violates row-level security policy for table gl_account", which is
  // the third time this ticket family has cost a misplaced entitlement row. Via
  // the admin pool because that connection bypasses RLS; the accounts below go
  // through `withOrg` and would not.
  await admin.query(
    `INSERT INTO module_entitlement (organization_id, module_code, enabled)
     VALUES ($1,'accounting',true), ($2,'accounting',true)`,
    [orgId, otherOrgId],
  );

  await withOrg(orgId, async (tx) => {
    const d = await tx.query(
      `INSERT INTO department (organization_id, name) VALUES ($1,'Engineering'),($1,'Sales')
       RETURNING id, name`,
      [orgId],
    );
    engineeringId = d.rows.find((r) => r.name === 'Engineering').id;
    salesId = d.rows.find((r) => r.name === 'Sales').id;

    // A MANAGER above the submitter: submit opens an approval run (VX2-3) and a
    // tenant with nobody able to approve is refused, correctly.
    const m = await tx.query(
      `INSERT INTO app_user (organization_id, email, display_name, role)
       VALUES ($1,'mgr@bud.test','Mgr','MANAGER') RETURNING id`,
      [orgId],
    );
    const e = await tx.query(
      `INSERT INTO app_user (organization_id, email, display_name, role, manager_id, department_id)
       VALUES ($1,'emp@bud.test','Emp','EMPLOYEE',$2,$3) RETURNING id`,
      [orgId, m.rows[0].id, engineeringId],
    );
    empId = e.rows[0].id;
    const a = await tx.query(
      `INSERT INTO app_user (organization_id, email, display_name, role, department_id)
       VALUES ($1,'adm@bud.test','Adm','ADMIN',$2) RETURNING id`,
      [orgId, salesId],
    );
    admId = a.rows[0].id;

    const c = await tx.query(
      `INSERT INTO expense_category (organization_id, code, label)
       VALUES ($1,'meals','Meals') RETURNING id`,
      [orgId],
    );
    categoryId = c.rows[0].id;

    const g = await tx.query(
      `INSERT INTO gl_account (organization_id, number, name, type)
       VALUES ($1,'68100','Ground Transportation','expense') RETURNING id`,
      [orgId],
    );
    accountId = g.rows[0].id;
  });

  await withOrg(otherOrgId, async (tx) => {
    const g = await tx.query(
      `INSERT INTO gl_account (organization_id, number, name, type)
       VALUES ($1,'68100','Ground Transportation','expense') RETURNING id`,
      [otherOrgId],
    );
    otherAccountId = g.rows[0].id;
  });
});

beforeEach(async () => {
  await admin.query('TRUNCATE budget CASCADE');
  // Amounts stay under the starter receipt threshold so submit is not blocked;
  // `expense-flow`'s rules are not installed here, but leaving room is cheaper
  // than depending on that.
  await admin.query('DELETE FROM expense_policy');
});

afterAll(async () => {
  await admin.end();
});

/**
 * A one-line draft owned by the EMPLOYEE. `createReport` takes the submitter's
 * EMAIL and resolves the row itself — taken from `lifecycle.db.test.ts` rather
 * than from reading the signature, per §4's first rule.
 */
async function draft(amountMinor = 1800): Promise<string> {
  return withOrg(orgId, async (tx) => {
    const r = await expenses.createReport(tx, 'emp@bud.test', {
      title: `Budget test ${Math.random().toString(36).slice(2, 8)}`,
      currencyCode: 'CAD',
    });
    const e = await expenses.addExpense(tx, r.id, { currencyCode: 'CAD', merchant: 'Taxi' });
    await expenses.addLineItem(tx, e.id, { categoryId, amountMinor });
    return r.id as string;
  });
}

describe('the department stamp (VX4-5)', () => {
  it('is NULL on a draft — a report only belongs to a department once submitted', async () => {
    const reportId = await draft();
    const row = await withOrg(orgId, (tx) =>
      tx.query('SELECT department_id FROM expense_report WHERE id = $1', [reportId]),
    );
    expect(row.rows[0].department_id).toBeNull();
  });

  it('takes the SUBMITTER\'s department', async () => {
    const reportId = await draft();
    await withOrg(orgId, (tx) => lifecycle.submitReport(tx, reportId, empId));
    const row = await withOrg(orgId, (tx) =>
      tx.query('SELECT department_id FROM expense_report WHERE id = $1', [reportId]),
    );
    expect(row.rows[0].department_id).toBe(engineeringId);
  });

  it('takes the SUBMITTER\'s department even when an ADMIN does the submitting', async () => {
    // THE REGRESSION TEST. `submitReport` has no ownership check of its own, so
    // this path is supported, and keying the stamp on the actor would write Sales
    // onto an Engineering employee's spend. The admin is in Sales precisely so
    // that mistake cannot pass.
    const reportId = await draft();
    await withOrg(orgId, (tx) => lifecycle.submitReport(tx, reportId, admId));
    const row = await withOrg(orgId, (tx) =>
      tx.query('SELECT department_id FROM expense_report WHERE id = $1', [reportId]),
    );
    expect(row.rows[0].department_id).toBe(engineeringId);
    expect(row.rows[0].department_id).not.toBe(salesId);
  });

  it('does NOT move when the submitter later transfers — the whole point of stamping', async () => {
    const reportId = await draft();
    await withOrg(orgId, (tx) => lifecycle.submitReport(tx, reportId, empId));
    await admin.query('UPDATE app_user SET department_id = $1 WHERE id = $2', [salesId, empId]);
    try {
      const row = await withOrg(orgId, (tx) =>
        tx.query('SELECT department_id FROM expense_report WHERE id = $1', [reportId]),
      );
      // A join through the submitter would answer Sales here, and last quarter's
      // budget totals would have changed because somebody transferred.
      expect(row.rows[0].department_id).toBe(engineeringId);
    } finally {
      await admin.query('UPDATE app_user SET department_id = $1 WHERE id = $2', [
        engineeringId,
        empId,
      ]);
    }
  });

  it('is NULL, not an error, for a submitter with no department', async () => {
    await admin.query('UPDATE app_user SET department_id = NULL WHERE id = $1', [empId]);
    try {
      const reportId = await draft();
      await withOrg(orgId, (tx) => lifecycle.submitReport(tx, reportId, empId));
      const row = await withOrg(orgId, (tx) =>
        tx.query('SELECT department_id FROM expense_report WHERE id = $1', [reportId]),
      );
      expect(row.rows[0].department_id).toBeNull();
    } finally {
      await admin.query('UPDATE app_user SET department_id = $1 WHERE id = $2', [
        engineeringId,
        empId,
      ]);
    }
  });
});

describe('the budget schema refuses independently of any service (0024)', () => {
  const insertBudget = (fields: Record<string, unknown>) => {
    const merged: Record<string, unknown> = {
      organization_id: orgId,
      name: 'Travel',
      gl_account_id: accountId,
      currency_code: 'CAD',
      fiscal_year: 2026,
      ...fields,
    };
    const keys = Object.keys(merged);
    return admin.query(
      `INSERT INTO budget (${keys.join(',')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')}) RETURNING id`,
      keys.map((k) => merged[k]),
    );
  };

  it('accepts one budget per scope', async () => {
    const r = await insertBudget({});
    expect(r.rows[0].id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('refuses a SECOND company-wide budget for the same account and year', async () => {
    // BG-1. Without `NULLS NOT DISTINCT` Postgres treats two NULL business units
    // as distinct, so this would succeed and every total afterwards would be
    // wrong with nothing on screen to show it.
    await insertBudget({});
    await expect(insertBudget({ name: 'Travel again' })).rejects.toThrow(/budget_scope_unique/);
  });

  it('allows the same account narrowed to DIFFERENT business units', async () => {
    const bu = await admin.query(
      `INSERT INTO business_unit (organization_id, name) VALUES ($1,'West'),($1,'East')
       RETURNING id`,
      [orgId],
    );
    await insertBudget({ business_unit_id: bu.rows[0].id });
    const second = await insertBudget({ name: 'Travel East', business_unit_id: bu.rows[1].id });
    expect(second.rows[0].id).toBeTruthy();
  });

  it('refuses another tenant\'s GL account (TN-1)', async () => {
    // Referential integrity runs as the constraint owner with RLS BYPASSED, so a
    // single-column REFERENCES would have accepted this.
    await expect(insertBudget({ gl_account_id: otherAccountId })).rejects.toThrow(
      /budget_gl_account_id_fkey/,
    );
  });

  it('refuses an empty name and an absurd fiscal year', async () => {
    await expect(insertBudget({ name: '   ' })).rejects.toThrow(/budget_name_nonempty/);
    await expect(insertBudget({ fiscal_year: 12026 })).rejects.toThrow(/budget_fiscal_year_sane/);
  });
});

describe('budget periods refuse independently of any service (0024)', () => {
  let budgetId: string;

  beforeEach(async () => {
    const b = await admin.query(
      `INSERT INTO budget (organization_id, name, gl_account_id, currency_code, fiscal_year)
       VALUES ($1,'Travel',$2,'CAD',2026) RETURNING id`,
      [orgId, accountId],
    );
    budgetId = b.rows[0].id;
  });

  const insertPeriod = (fields: Record<string, unknown>) => {
    const merged: Record<string, unknown> = {
      organization_id: orgId,
      budget_id: budgetId,
      starts_on: '2026-01-01',
      ends_on: '2026-01-31',
      amount_minor: 500000,
      ...fields,
    };
    const keys = Object.keys(merged);
    return admin.query(
      `INSERT INTO budget_period (${keys.join(',')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')}) RETURNING id`,
      keys.map((k) => merged[k]),
    );
  };

  it('accepts a period with dates rather than a month number (BG-5)', async () => {
    // Periods carry `starts_on`/`ends_on` so 4-4-5 is a seeding decision rather
    // than a migration — theirs hard-codes twelve months and rules 4-4-5 out.
    const r = await insertPeriod({});
    expect(r.rows[0].id).toBeTruthy();
    const fourFourFive = await insertPeriod({ starts_on: '2026-02-01', ends_on: '2026-02-28' });
    expect(fourFourFive.rows[0].id).toBeTruthy();
  });

  it('refuses an end before its start', async () => {
    await expect(insertPeriod({ starts_on: '2026-02-01', ends_on: '2026-01-31' })).rejects.toThrow(
      /budget_period_dates/,
    );
  });

  it('refuses two periods starting on the same day', async () => {
    await insertPeriod({});
    await expect(insertPeriod({ ends_on: '2026-02-28' })).rejects.toThrow(
      /budget_period_start_unique/,
    );
  });

  it('refuses a total with no rollup stamp, and allows a stamped rollup that found nothing', async () => {
    // `rolled_up_at IS NULL` must mean "never calculated", not "zero spend" — a
    // screen has to be able to say which.
    await expect(insertPeriod({ actual_minor: 12345 })).rejects.toThrow(
      /budget_period_totals_need_a_rollup/,
    );
    const r = await insertPeriod({});
    const stamped = await admin.query(
      'UPDATE budget_period SET rolled_up_at = now() WHERE id = $1 RETURNING rolled_up_at, actual_minor',
      [r.rows[0].id],
    );
    expect(stamped.rows[0].rolled_up_at).not.toBeNull();
    expect(String(stamped.rows[0].actual_minor)).toBe('0');
  });

  it('refuses a negative amount or a negative total', async () => {
    await expect(insertPeriod({ amount_minor: -1 })).rejects.toThrow(
      /budget_period_amount_nonneg/,
    );
    await expect(insertPeriod({ actual_minor: -1, rolled_up_at: new Date() })).rejects.toThrow(
      /budget_period_rollup_nonneg/,
    );
  });

  it('cascades away with its budget', async () => {
    await insertPeriod({});
    await admin.query('DELETE FROM budget WHERE id = $1', [budgetId]);
    const left = await admin.query('SELECT count(*)::int AS n FROM budget_period WHERE budget_id = $1', [
      budgetId,
    ]);
    expect(left.rows[0].n).toBe(0);
  });
});

describe('tenancy (VX4-5)', () => {
  it('one tenant\'s budgets are invisible to another', async () => {
    await admin.query(
      `INSERT INTO budget (organization_id, name, gl_account_id, currency_code, fiscal_year)
       VALUES ($1,'Travel',$2,'CAD',2026)`,
      [orgId, accountId],
    );
    const mine = await withOrg(orgId, (tx) => tx.query('SELECT count(*)::int AS n FROM budget'));
    const theirs = await withOrg(otherOrgId, (tx) =>
      tx.query('SELECT count(*)::int AS n FROM budget'),
    );
    expect(mine.rows[0].n).toBe(1);
    expect(theirs.rows[0].n).toBe(0);
  });
});
