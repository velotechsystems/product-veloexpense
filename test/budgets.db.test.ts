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
import * as policy from '@/lib/policy/service';
import { decide } from '@/lib/approvals/engine';
import { loadBudgetSnapshots } from '@/lib/budgets/service';
import * as alertsLib from '@/lib/budgets/alerts';
import * as budgetAdmin from '@/lib/budgets/admin';
import { TEST_ACTOR } from './support/audit-actor';
import { TODAY } from './support/dates';

const admin = new Pool({
  connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL,
});

let orgId: string;
let otherOrgId: string;
/** The submitter — an EMPLOYEE in Engineering. */
let empId: string;
/** An ADMIN in Sales, who will submit on the employee's behalf. */
let admId: string;
/** The employee's manager — the approver every submitted report routes to. */
let mgrId: string;
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
     VALUES ($1,'accounting',true), ($2,'accounting',true),
            ($1,'budgets',   true), ($2,'budgets',   true)`,
    [orgId, otherOrgId],
  );

  await withOrg(orgId, async (tx) => {
    const d = await tx.query(
      `INSERT INTO department (organization_id, label)
       VALUES ($1,'{"en":"Engineering"}'),($1,'{"en":"Sales"}')
       RETURNING id, label ->> 'en' AS name`,
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
    mgrId = m.rows[0].id;
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
       VALUES ($1,'meals','{"en":"Meals"}') RETURNING id`,
      [orgId],
    );
    categoryId = c.rows[0].id;

    const g = await tx.query(
      `INSERT INTO gl_account (organization_id, number, name, type)
       VALUES ($1,'68100','Ground Transportation','expense') RETURNING id`,
      [orgId],
    );
    accountId = g.rows[0].id;

    // VX4-5 part 2. `addLineItem` stamps `expense_line_item.gl_account_id` from
    // the CATEGORY's account (AC-10, migration 0014), so a category with no
    // account produces lines no budget can ever attribute — and every rollup test
    // below would pass by measuring nothing.
    await tx.query('UPDATE expense_category SET gl_account_id = $1 WHERE id = $2', [
      accountId,
      categoryId,
    ]);
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
  // Reports too, from VX4-5 part 2 on. The rollup is recomputed from EVERY
  // counted report in a period's date range, so a submitted report left behind by
  // an earlier test is an input to the next one's totals — the "anything a run
  // leaves behind is the next run's input" trap from §4's Playwright list, which
  // is not actually about Playwright.
  await admin.query('TRUNCATE expense_report CASCADE');
  // The unconvertible-spend tests below assert on the ABSENCE of a rate. (`fx_rate`
  // was global until 0051, so the truncate above left it; it is per tenant now.)
  // `test/policy.db.test.ts` clears it the same way for the same reason.
  await admin.query('DELETE FROM fx_rate');
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
    const e = await expenses.addExpense(tx, TEST_ACTOR, r.id, { txnDate: TODAY, currencyCode: 'CAD', merchant: 'Taxi' });
    await expenses.addLineItem(tx, TEST_ACTOR, e.id, { categoryId, amountMinor });
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
      `INSERT INTO business_unit (organization_id, label) VALUES ($1,'{"en":"West"}'),($1,'{"en":"East"}')
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

/* ══════════════════════════════════════════════════════════════════════════════
 * VX4-5 PART 2 — the rollup, the rule, and the severity clamp
 *
 * The rollup is driven through the LIFECYCLE (submit / decide / recall), because
 * the claim is about what a transition does; driving it by calling
 * `recomputeForReport` directly would only re-test the function against itself and
 * would not notice a hook that was never wired.
 *
 * The clamp is driven from both ends deliberately: `createPolicy` for the refusal
 * an admin meets, and a raw `UPDATE` for the row an admin never touched. A row
 * written by a seed, an import or Phase 5's provisioning reaches `validateReport`
 * without passing through the service, which is exactly why the clamp needs two
 * halves and why testing only the refusal would leave the invariant unproven.
 * ═════════════════════════════════════════════════════════════════════════════ */

/** A budget with one period spanning today, since `draft()`'s expenses are undated. */
async function makeBudget(
  over: {
    name?: string;
    currencyCode?: string;
    businessUnitId?: string | null;
    departmentId?: string | null;
    amountMinor?: number;
  } = {},
): Promise<{ budgetId: string; periodId: string }> {
  const b = await admin.query(
    `INSERT INTO budget (organization_id, name, gl_account_id, business_unit_id, department_id,
                         currency_code, fiscal_year)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [
      orgId,
      over.name ?? 'Travel',
      accountId,
      over.businessUnitId ?? null,
      over.departmentId ?? null,
      over.currencyCode ?? 'CAD',
      2026,
    ],
  );
  const p = await admin.query(
    `INSERT INTO budget_period (organization_id, budget_id, starts_on, ends_on, amount_minor)
     VALUES ($1,$2, current_date - 20, current_date + 20, $3) RETURNING id`,
    [orgId, b.rows[0].id, over.amountMinor ?? 100000],
  );
  return { budgetId: b.rows[0].id, periodId: p.rows[0].id };
}

async function periodTotals(periodId: string) {
  const r = await admin.query(
    `SELECT actual_minor, pending_minor, unconvertible_minor, rolled_up_at
       FROM budget_period WHERE id = $1`,
    [periodId],
  );
  const row = r.rows[0];
  return {
    actual: String(row.actual_minor),
    pending: String(row.pending_minor),
    unconvertible: String(row.unconvertible_minor),
    rolledUpAt: row.rolled_up_at as Date | null,
  };
}

/** A one-line draft in a named currency, for the FX paths. */
async function draftIn(currencyCode: string, amountMinor: number): Promise<string> {
  return withOrg(orgId, async (tx) => {
    const r = await expenses.createReport(tx, 'emp@bud.test', {
      title: `Budget fx ${Math.random().toString(36).slice(2, 8)}`,
      currencyCode,
    });
    const e = await expenses.addExpense(tx, TEST_ACTOR, r.id, { txnDate: TODAY, currencyCode, merchant: 'Taxi' });
    await expenses.addLineItem(tx, TEST_ACTOR, e.id, { categoryId, amountMinor });
    return r.id as string;
  });
}

const budgetRule = () =>
  withOrg(orgId, (tx) => policy.createPolicy(tx, { kind: 'BUDGET_OVERAGE' }));

describe('the rollup moves on the transitions that change it (BG-3)', () => {
  it('submitting puts the report into pending, and stamps rolled_up_at', async () => {
    const { periodId } = await makeBudget();
    const before = await periodTotals(periodId);
    // The precondition the rest of this file depends on: a fresh period is
    // NEVER-CALCULATED, which 0024 distinguishes from calculated-and-zero.
    expect(before.rolledUpAt).toBeNull();

    const reportId = await draft(1800);
    await withOrg(orgId, (tx) => lifecycle.submitReport(tx, reportId, empId));

    const after = await periodTotals(periodId);
    expect(after.pending).toBe('1800');
    expect(after.actual).toBe('0');
    expect(after.rolledUpAt).not.toBeNull();
  });

  it('approving moves the amount from pending into actual', async () => {
    const { periodId } = await makeBudget();
    const reportId = await draft(1800);
    const submitted = await withOrg(orgId, (tx) =>
      lifecycle.submitReport(tx, reportId, empId),
    );
    await withOrg(orgId, (tx) =>
      decide(tx, submitted.approval.taskId, mgrId, 'APPROVED', {
        receiptViewAcknowledged: true,
      }),
    );

    const after = await periodTotals(periodId);
    expect(after.actual).toBe('1800');
    expect(after.pending).toBe('0');
  });

  it('rejecting takes the amount back out — a budget that only counts upward is the one nobody trusts', async () => {
    const { periodId } = await makeBudget();
    const reportId = await draft(1800);
    const submitted = await withOrg(orgId, (tx) =>
      lifecycle.submitReport(tx, reportId, empId),
    );
    await withOrg(orgId, (tx) =>
      decide(tx, submitted.approval.taskId, mgrId, 'REJECTED', { note: 'no' }),
    );

    const after = await periodTotals(periodId);
    expect(after.actual).toBe('0');
    expect(after.pending).toBe('0');
    // Still calculated: "we looked, and the answer is nothing" is the state
    // `rolled_up_at` exists to distinguish from "never calculated".
    expect(after.rolledUpAt).not.toBeNull();
  });

  it('recalling takes the amount back out of pending', async () => {
    const { periodId } = await makeBudget();
    const reportId = await draft(1800);
    await withOrg(orgId, (tx) => lifecycle.submitReport(tx, reportId, empId));
    expect((await periodTotals(periodId)).pending).toBe('1800');

    await withOrg(orgId, (tx) => lifecycle.recallReport(tx, reportId, empId));
    expect((await periodTotals(periodId)).pending).toBe('0');
  });

  it('reimbursing does NOT move the totals — the claim that justifies having no hook there', async () => {
    // `lib/budgets/service.ts` states that APPROVED and REIMBURSED both count as
    // actual, so `reimburseReport` has nothing to recompute. That is a claim, and
    // this is what turns it into a check: if the mapping ever changes, this fails
    // rather than the numbers quietly drifting.
    const { periodId } = await makeBudget();
    const reportId = await draft(1800);
    const submitted = await withOrg(orgId, (tx) =>
      lifecycle.submitReport(tx, reportId, empId),
    );
    await withOrg(orgId, (tx) =>
      decide(tx, submitted.approval.taskId, mgrId, 'APPROVED', {
        receiptViewAcknowledged: true,
      }),
    );
    const approved = await periodTotals(periodId);

    await withOrg(orgId, (tx) => lifecycle.reimburseReport(tx, reportId, admId));
    const reimbursed = await periodTotals(periodId);
    expect(reimbursed.actual).toBe(approved.actual);
    expect(reimbursed.pending).toBe(approved.pending);
  });

  it('attributes to the MOST SPECIFIC budget only — no double count', async () => {
    const company = await makeBudget({ name: 'Travel — company' });
    const engineering = await makeBudget({
      name: 'Travel — Engineering',
      departmentId: engineeringId,
    });

    const reportId = await draft(1800);
    await withOrg(orgId, (tx) => lifecycle.submitReport(tx, reportId, empId));

    // The employee is in Engineering, so the department budget wins outright. If
    // attribution summed every match instead, the company total would drift
    // upward by however many department budgets exist and both numbers would
    // still look plausible.
    expect((await periodTotals(engineering.periodId)).pending).toBe('1800');
    expect((await periodTotals(company.periodId)).pending).toBe('0');
  });

  it('counts spend a rate cannot convert SEPARATELY, never as base currency (AN-7)', async () => {
    const { periodId } = await makeBudget({ currencyCode: 'CAD' });
    const reportId = await draftIn('USD', 1800);
    await withOrg(orgId, (tx) => lifecycle.submitReport(tx, reportId, empId));

    const after = await periodTotals(periodId);
    // The defect this inverts: their analytics adds 1800 USD to a CAD total as if
    // no conversion were needed, and reports "under budget" with a straight face.
    expect(after.unconvertible).toBe('1800');
    expect(after.pending).toBe('0');
    expect(after.actual).toBe('0');
  });
});

describe('BUDGET_OVERAGE (BG-4)', () => {
  it('warns when this report takes the period past its budget', async () => {
    await budgetRule();
    await makeBudget({ amountMinor: 1000 });
    const reportId = await draft(1800);

    const summary = await withOrg(orgId, (tx) => policy.validateReport(tx, reportId));
    const finding = summary.violations.find((v) => v.rule_code === 'BUDGET_OVERAGE');
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe('WARNING');
    expect(finding!.message).toMatch(/over by/);
    expect(String(finding!.data.overageMinor)).toBe('800');
  });

  it('says nothing when the report fits', async () => {
    await budgetRule();
    await makeBudget({ amountMinor: 100000 });
    const reportId = await draft(1800);

    const summary = await withOrg(orgId, (tx) => policy.validateReport(tx, reportId));
    expect(summary.violations.filter((v) => v.rule_code === 'BUDGET_OVERAGE')).toHaveLength(0);
  });

  it('counts what is already in flight, not just what is approved', async () => {
    await budgetRule();
    const { periodId } = await makeBudget({ amountMinor: 3000 });

    // One report already submitted and awaiting a decision.
    const first = await draft(1800);
    await withOrg(orgId, (tx) => lifecycle.submitReport(tx, first, empId));
    expect((await periodTotals(periodId)).pending).toBe('1800');

    // A second report of 1800 fits on its own (1800 < 3000) and does not fit
    // beside the first (3600 > 3000). Warning somebody at 60% while an
    // already-submitted report would take them to 120% reads as headroom.
    const second = await draft(1800);
    const summary = await withOrg(orgId, (tx) => policy.validateReport(tx, second));
    const finding = summary.violations.find((v) => v.rule_code === 'BUDGET_OVERAGE');
    expect(finding).toBeDefined();
    expect(String(finding!.data.overageMinor)).toBe('600');
  });

  it('does not run the LOADER at all when no BUDGET_OVERAGE instance is enabled', async () => {
    // The scan is the expensive part of a validation and a tenant with no budget
    // rule should not pay it, so `validateReport` skips the loader entirely.
    //
    // The obvious assertion here — "no violations" — CANNOT FAIL: with no rule
    // instance there is nothing to emit whether the loader ran or not, so it
    // would pass on a `validateReport` that loaded budgets on every save. The
    // loader leaves a fingerprint instead: it recomputes a never-calculated
    // period. `rolled_up_at` still NULL is proof it never ran.
    const { periodId } = await makeBudget({ amountMinor: 1000 });
    const reportId = await draft(1800);
    const summary = await withOrg(orgId, (tx) => policy.validateReport(tx, reportId));
    expect(await periodTotals(periodId).then((t) => t.rolledUpAt)).toBeNull();
    expect(summary.violations).toHaveLength(0);
  });

  it('calculates a never-calculated period rather than reading it as zero spend', async () => {
    await budgetRule();
    const { periodId } = await makeBudget({ amountMinor: 3000 });

    // Prior spend that no rollup has ever seen — an import, a seed, or simply the
    // first report against a brand-new budget.
    const earlier = await draft(2500);
    await admin.query(
      `UPDATE expense_report SET status = 'APPROVED', department_id = $2 WHERE id = $1`,
      [earlier, engineeringId],
    );
    expect((await periodTotals(periodId)).rolledUpAt).toBeNull();

    const reportId = await draft(1000);
    const summary = await withOrg(orgId, (tx) => policy.validateReport(tx, reportId));

    // Reading the uncalculated baseline as zero would have answered "3000 of
    // 3000, you are fine". It is 3500.
    expect((await periodTotals(periodId)).rolledUpAt).not.toBeNull();
    const finding = summary.violations.find((v) => v.rule_code === 'BUDGET_OVERAGE');
    expect(finding).toBeDefined();
    expect(String(finding!.data.overageMinor)).toBe('500');
  });

  it('reports unconvertible spend as its own INFO finding beside the overage', async () => {
    await budgetRule();
    await makeBudget({ amountMinor: 100000, currencyCode: 'CAD' });
    const reportId = await draftIn('USD', 1800);

    const summary = await withOrg(orgId, (tx) => policy.validateReport(tx, reportId));
    const info = summary.violations.find(
      (v) => v.rule_code === 'BUDGET_OVERAGE' && v.severity === 'INFO',
    );
    expect(info).toBeDefined();
    expect(info!.message).toMatch(/floor rather than a total/);
    expect(info!.data.reportMissingRateFrom).toEqual(['USD']);
    // The two findings have DIFFERENT keys, which is what lets them coexist —
    // ExpenseOS collapses everything this rule emits onto one row and loses all
    // but the first (their kinds.ts says so in its own comment).
    expect(info!.finding_key).toMatch(/\|fx$/);
  });

  it('gives each budget period its own finding, so each can be justified separately', async () => {
    await budgetRule();
    await makeBudget({ name: 'Travel — company', amountMinor: 1000 });
    await makeBudget({
      name: 'Travel — Engineering',
      departmentId: engineeringId,
      amountMinor: 1000,
    });
    // Only the department budget is attributed to (most-specific-first), so this
    // report raises exactly one finding — and its key names the budget, which is
    // what makes a second budget's finding a second row rather than a lost one.
    const reportId = await draft(1800);
    const summary = await withOrg(orgId, (tx) => policy.validateReport(tx, reportId));
    const found = summary.violations.filter((v) => v.rule_code === 'BUDGET_OVERAGE');
    expect(found).toHaveLength(1);
    expect(found[0].message).toMatch(/Travel — Engineering/);
    expect(found[0].finding_key).not.toBe('');
  });

  it('loads snapshots only for the periods the report actually lands in', async () => {
    await makeBudget({ amountMinor: 100000 });
    const reportId = await draft(1800);
    const snapshots = await withOrg(orgId, (tx) => loadBudgetSnapshots(tx, reportId));
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].reportMinor).toBe(1800n);
    expect(snapshots[0].amountMinor).toBe(100000n);
  });
});

describe('a budget never blocks, and that is enforced in both places', () => {
  it('REFUSES a BLOCK severity at the write', async () => {
    await expect(
      withOrg(orgId, (tx) => policy.createPolicy(tx, { kind: 'BUDGET_OVERAGE', severity: 'BLOCK' })),
    ).rejects.toMatchObject({ code: 'SEVERITY_ABOVE_MAXIMUM' });
  });

  it('REFUSES an update to BLOCK', async () => {
    const created = await budgetRule();
    await expect(
      withOrg(orgId, (tx) => policy.updatePolicy(tx, created.id, { severity: 'BLOCK' })),
    ).rejects.toMatchObject({ code: 'SEVERITY_ABOVE_MAXIMUM' });
  });

  it('still allows WARNING and INFO', async () => {
    const created = await budgetRule();
    const lowered = await withOrg(orgId, (tx) =>
      policy.updatePolicy(tx, created.id, { severity: 'INFO' }),
    );
    expect(lowered.severity).toBe('INFO');
  });

  it('CLAMPS a row forced to BLOCK behind the service’s back', async () => {
    // The half that makes the maximum an invariant rather than a form validation.
    // A seed, an importer, a restored backup or Phase 5's provisioning all reach
    // `expense_policy` without passing through `createPolicy`.
    const created = await budgetRule();
    await admin.query('UPDATE expense_policy SET severity = $2 WHERE id = $1', [
      created.id,
      'BLOCK',
    ]);
    await makeBudget({ amountMinor: 1000 });
    const reportId = await draft(1800);

    const summary = await withOrg(orgId, (tx) => policy.validateReport(tx, reportId));
    const finding = summary.violations.find(
      (v) => v.rule_code === 'BUDGET_OVERAGE' && v.finding_key.endsWith('|fx') === false,
    );
    expect(finding!.severity).toBe('WARNING');
    // And the consequence that actually matters: an over-budget report is still
    // submittable. BG-4's whole point is that the money has already left, so an
    // unsubmittable claim strands a real expense.
    expect(summary.blocking).toBe(false);
  });

  it('does not clamp a rule that declares no maximum', async () => {
    // The clamp is not a global downgrade: RECEIPT_REQUIRED is BLOCK by design
    // and stays BLOCK. Without this the previous test would also pass on a
    // `validateReport` that simply capped everything at WARNING.
    await withOrg(orgId, (tx) =>
      policy.createPolicy(tx, { kind: 'RECEIPT_REQUIRED', severity: 'BLOCK', params: {} }),
    );
    const reportId = await draft(1800);
    const summary = await withOrg(orgId, (tx) => policy.validateReport(tx, reportId));
    const finding = summary.violations.find((v) => v.rule_code === 'RECEIPT_REQUIRED');
    expect(finding!.severity).toBe('BLOCK');
    expect(summary.blocking).toBe(true);
  });
});

/* ══════════════════════════════════════════════════════════════════════════════
 * VX4-5 PART 3a — THRESHOLD ALERTS (BG-6)
 *
 * Driven through the LIFECYCLE, like the rollup tests above, because the claim is
 * about what a transition does. `fireThresholdAlerts` called directly would only
 * re-test the function against itself.
 *
 * The test that matters most is the last one. Every other assertion here would
 * pass on ExpenseOS's design too — a marker column suppresses repeats perfectly
 * well until something fails or races. What their design cannot do is roll the
 * claim back with a failed send, and that is the one this file injects a real
 * failure to prove.
 * ═════════════════════════════════════════════════════════════════════════════ */

async function addThreshold(budgetId: string, bp: number, recipients: string[] = []) {
  const t = await admin.query(
    `INSERT INTO budget_alert_threshold (organization_id, budget_id, threshold_bp)
     VALUES ($1,$2,$3) RETURNING id`,
    [orgId, budgetId, bp],
  );
  for (const userId of recipients) {
    await admin.query(
      `INSERT INTO budget_alert_recipient (organization_id, threshold_id, user_id)
       VALUES ($1,$2,$3)`,
      [orgId, t.rows[0].id, userId],
    );
  }
  return t.rows[0].id as string;
}

async function setOwner(budgetId: string, userId: string | null) {
  await admin.query('UPDATE budget SET owner_id = $2 WHERE id = $1', [budgetId, userId]);
}

async function claims(periodId: string) {
  const r = await admin.query(
    `SELECT threshold_bp, notified_count, used_minor, amount_minor
       FROM budget_alert_claim WHERE period_id = $1 ORDER BY threshold_bp`,
    [periodId],
  );
  return r.rows.map((x) => ({
    bp: Number(x.threshold_bp),
    notified: Number(x.notified_count),
    used: String(x.used_minor),
    amount: String(x.amount_minor),
  }));
}

/** Who has a BUDGET_THRESHOLD notification, and what it says. */
async function alerts() {
  const r = await admin.query(
    `SELECT n.recipient_id, a.payload
       FROM notification n
       JOIN activity a ON a.id = n.activity_id
      WHERE a.event_type = 'BUDGET_THRESHOLD'
      ORDER BY n.created_at, n.recipient_id`,
  );
  return r.rows.map((x) => ({
    recipientId: x.recipient_id as string,
    payload: x.payload as Record<string, unknown>,
  }));
}

describe('budget threshold alerts fire once per crossing (BG-6)', () => {
  beforeEach(async () => {
    await admin.query('TRUNCATE activity CASCADE');
  });

  it('alerts the owner when a threshold is crossed, once', async () => {
    const { budgetId, periodId } = await makeBudget({ amountMinor: 2000 });
    await setOwner(budgetId, mgrId);
    await addThreshold(budgetId, 9000);

    const first = await draft(1800); // 90% of 2000
    await withOrg(orgId, (tx) => lifecycle.submitReport(tx, first, empId));

    expect(await claims(periodId)).toEqual([
      { bp: 9000, notified: 1, used: '1800', amount: '2000' },
    ]);
    const sent = await alerts();
    expect(sent).toHaveLength(1);
    expect(sent[0].recipientId).toBe(mgrId);
    expect(sent[0].payload.thresholdPercent).toBe('90');
  });

  it('does not alert again while the period sits at the same level', async () => {
    const { budgetId, periodId } = await makeBudget({ amountMinor: 4000 });
    await setOwner(budgetId, mgrId);
    await addThreshold(budgetId, 9000);

    // Two submissions, each on its own report, both leaving the period at or
    // past 90%. This is the noise their marker exists to suppress — "an alert
    // that arrives on every save is one people filter within a day".
    for (const amount of [3600, 100]) {
      const r = await draft(amount);
      await withOrg(orgId, (tx) => lifecycle.submitReport(tx, r, empId));
    }
    expect(await claims(periodId)).toHaveLength(1);
    expect(await alerts()).toHaveLength(1);
  });

  it('alerts AGAIN when a higher threshold is crossed', async () => {
    const { budgetId, periodId } = await makeBudget({ amountMinor: 4000 });
    await setOwner(budgetId, mgrId);
    await addThreshold(budgetId, 5000);
    await addThreshold(budgetId, 10000);

    const first = await draft(2000); // 50%
    await withOrg(orgId, (tx) => lifecycle.submitReport(tx, first, empId));
    expect((await claims(periodId)).map((c) => c.bp)).toEqual([5000]);

    const second = await draft(2000); // 100%
    await withOrg(orgId, (tx) => lifecycle.submitReport(tx, second, empId));
    expect((await claims(periodId)).map((c) => c.bp)).toEqual([5000, 10000]);
    expect(await alerts()).toHaveLength(2);
  });

  it('a claim at a HIGHER level suppresses a lower crossing', async () => {
    // The half a unique index cannot express: a period already alerted at 100%
    // must not alert again at 90% because a correction brought it down a little.
    //
    // THE ORDERING HERE IS THE WHOLE TEST, and the first version of it did not
    // have it — sabotaging `threshold_bp >= $2` to `= $2` failed nothing, because
    // every path the test took happened to re-cross the SAME level. For `>=` to
    // be load-bearing the period has to hold a claim at 100% and NO claim at 90%,
    // which only happens when it jumps past both levels in one movement:
    //
    //   small (7.5%)              no crossing, no claim
    //   + big  -> 100%            crosses BOTH; only the highest is claimed
    //   recall small -> 92.5%     crosses 90%, which has never been claimed
    //
    // Under `=` that last step alerts a second time. Under `>=` it does not.
    const { budgetId, periodId } = await makeBudget({ amountMinor: 4000 });
    await setOwner(budgetId, mgrId);
    await addThreshold(budgetId, 9000);
    await addThreshold(budgetId, 10000);

    const small = await draft(300);
    await withOrg(orgId, (tx) => lifecycle.submitReport(tx, small, empId));
    expect(await claims(periodId)).toHaveLength(0);

    const big = await draft(3700); // 300 + 3700 = 4000 = 100%
    await withOrg(orgId, (tx) => lifecycle.submitReport(tx, big, empId));
    expect((await claims(periodId)).map((c) => c.bp)).toEqual([10000]);

    // Back to 92.5%: over 90%, so no re-arm, and 90% has no claim of its own.
    await withOrg(orgId, (tx) => lifecycle.recallReport(tx, small, empId));
    expect((await periodTotals(periodId)).pending).toBe('3700');
    expect((await claims(periodId)).map((c) => c.bp)).toEqual([10000]);
    expect(await alerts()).toHaveLength(1);
  });

  it('RE-ARMS when the period falls back under every threshold', async () => {
    // Their `clearBudgetAlertMarkers`, as a delete. Without it a budget that goes
    // over, gets a correction and goes over again stays silent the second time.
    const { budgetId, periodId } = await makeBudget({ amountMinor: 2000 });
    await setOwner(budgetId, mgrId);
    await addThreshold(budgetId, 9000);

    const first = await draft(1800);
    await withOrg(orgId, (tx) => lifecycle.submitReport(tx, first, empId));
    expect(await claims(periodId)).toHaveLength(1);

    await withOrg(orgId, (tx) => lifecycle.recallReport(tx, first, empId));
    expect(await claims(periodId)).toHaveLength(0);

    const again = await draft(1800);
    await withOrg(orgId, (tx) => lifecycle.submitReport(tx, again, empId));
    expect(await claims(periodId)).toHaveLength(1);
    expect(await alerts()).toHaveLength(2);
  });

  it('tells the level’s own recipients as well as the owner, de-duped', async () => {
    const { budgetId } = await makeBudget({ amountMinor: 2000 });
    await setOwner(budgetId, mgrId);
    // The owner is ALSO a named recipient. An empty recipient list means "owner
    // only", never "nobody" — and a doubled list must not mean two bells.
    await addThreshold(budgetId, 9000, [mgrId, admId]);

    const r = await draft(1800);
    await withOrg(orgId, (tx) => lifecycle.submitReport(tx, r, empId));

    const sent = await alerts();
    expect(sent.map((s) => s.recipientId).sort()).toEqual([mgrId, admId].sort());
  });

  it('tells a budget owner who broke their OWN budget', async () => {
    // The one place `includeActor` is used. Every other event in the product
    // excludes the actor, correctly — but a threshold alert is about a running
    // total, and the owner filing the claim that breaks it is exactly who needs
    // telling.
    const { budgetId } = await makeBudget({ amountMinor: 2000 });
    await setOwner(budgetId, empId);
    await addThreshold(budgetId, 9000);

    const r = await draft(1800);
    await withOrg(orgId, (tx) => lifecycle.submitReport(tx, r, empId));

    const sent = await alerts();
    expect(sent).toHaveLength(1);
    expect(sent[0].recipientId).toBe(empId);
  });

  it('records the crossing even when there is nobody to tell', async () => {
    // "Nobody to tell, but the crossing still happened" — so making somebody the
    // owner next month does not deliver a backlog of stale alerts.
    const { budgetId, periodId } = await makeBudget({ amountMinor: 2000 });
    await addThreshold(budgetId, 9000);

    const r = await draft(1800);
    await withOrg(orgId, (tx) => lifecycle.submitReport(tx, r, empId));

    expect(await claims(periodId)).toEqual([
      { bp: 9000, notified: 0, used: '1800', amount: '2000' },
    ]);
    expect(await alerts()).toHaveLength(0);
  });

  it('claims nothing when the budget has no thresholds configured', async () => {
    const { budgetId, periodId } = await makeBudget({ amountMinor: 100 });
    await setOwner(budgetId, mgrId);

    const r = await draft(1800); // far over, but nobody asked to be told
    await withOrg(orgId, (tx) => lifecycle.submitReport(tx, r, empId));

    expect(await claims(periodId)).toHaveLength(0);
    expect(await alerts()).toHaveLength(0);
  });

  it('sends nothing when a claim for this level is already on the row', async () => {
    // THE FAST-FAIL READ, and named for it. An earlier version of this test
    // claimed to be about the atomic claim and was not: the read catches
    // `threshold_bp >= crossed`, which includes the equal case, so a sequential
    // caller can NEVER reach the `ON CONFLICT`. Sabotaging the conflict clause
    // failed nothing, which is how that was found. The real guard is exercised by
    // the two-connection test below.
    const { budgetId, periodId } = await makeBudget({ amountMinor: 2000 });
    await setOwner(budgetId, mgrId);
    await addThreshold(budgetId, 9000);
    await admin.query(
      `INSERT INTO budget_alert_claim
         (organization_id, period_id, threshold_bp, used_minor, amount_minor, notified_count)
       VALUES ($1,$2,9000,0,2000,7)`,
      [orgId, periodId],
    );

    const r = await draft(1800);
    await withOrg(orgId, (tx) => lifecycle.submitReport(tx, r, empId));

    // Untouched — notified_count is still the other writer's, not overwritten.
    expect(await claims(periodId)).toEqual([
      { bp: 9000, notified: 7, used: '0', amount: '2000' },
    ]);
    expect(await alerts()).toHaveLength(0);
  });

  it('the CLAIM refuses a second writer that got past the read (two connections)', async () => {
    // The guarantee the whole design rests on, and the only test here that can
    // reach it. `ON CONFLICT DO NOTHING` is a CONCURRENCY guard: sequentially the
    // fast-fail read always fires first, so a single-threaded test cannot exercise
    // it — an earlier version of this file had an assertion that looked like
    // coverage and was not, found by sabotaging the conflict clause and watching
    // nothing fail.
    //
    // Driven through `fireThresholdAlerts` ITSELF on two hand-managed
    // connections, not through raw SQL. A raw INSERT here would prove that
    // Postgres enforces a unique index, which was never in doubt; what needs
    // proving is that the CODE asks it to. `QueryRunner` is `Pick<PoolClient,
    // 'query'>`, so a client is one.
    //
    // This is BG-6's first double-send path exactly: "two concurrent submits both
    // pass the read. No row lock, no unique guard."
    const { budgetId, periodId } = await makeBudget({ amountMinor: 2000 });
    await setOwner(budgetId, mgrId);
    await addThreshold(budgetId, 9000);
    await admin.query(
      `UPDATE budget_period SET actual_minor = 1800, rolled_up_at = now() WHERE id = $1`,
      [periodId],
    );

    const a = await admin.connect();
    const b = await admin.connect();
    try {
      for (const c of [a, b]) {
        await c.query('BEGIN');
        await c.query("SELECT set_config('app.current_org', $1, true)", [orgId]);
      }

      // A claims and sends, and does NOT commit yet.
      const first = await alertsLib.fireThresholdAlerts(a, [periodId], empId);
      expect(first).toEqual({ fired: 1, rearmed: 0 });

      // B RUNS ON A PROXY THAT CONTROLS ONE THING: when A commits.
      //
      // The first version of this test just started B and committed A beside it,
      // trusting the interleaving. It does not work — B's three reads and A's
      // COMMIT are separate round trips, and A's commit lands before B's fast-fail
      // read every time, so B saw the claim and returned early. The test passed
      // and the sabotage that upserts instead of refusing ALSO passed, which is
      // how the hole was found.
      //
      // The proxy holds A open until B is at the INSERT, which is the only moment
      // the `ON CONFLICT` can be reached. It intercepts TIMING and never an
      // outcome — every statement is still run against a real connection, and both
      // results remain reachable.
      let aCommitted = false;
      const bAtTheInsert = {
        query: async (text: string, params?: unknown[]) => {
          if (!aCommitted && text.includes('INSERT INTO budget_alert_claim')) {
            aCommitted = true;
            await a.query('COMMIT');
          }
          return b.query(text, params);
        },
      } as unknown as Parameters<typeof alertsLib.fireThresholdAlerts>[0];

      const second = await alertsLib.fireThresholdAlerts(bAtTheInsert, [periodId], empId);
      expect(aCommitted).toBe(true); // B really did reach the insert
      expect(second).toEqual({ fired: 0, rearmed: 0 });
      await b.query('COMMIT');

      const rows = await admin.query(
        'SELECT count(*)::int AS n FROM budget_alert_claim WHERE period_id = $1',
        [periodId],
      );
      expect(rows.rows[0].n).toBe(1);
      // One claim AND one bell. A second notification is the defect; a second
      // claim is merely how it would have happened.
      expect(await alerts()).toHaveLength(1);
    } finally {
      // ROLL BOTH BACK BEFORE RELEASING. A connection returned to the pool with an
      // open transaction keeps its locks, and every later test that touches
      // `budget_alert_claim` then waits five seconds and times out — which is what
      // happened while sabotaging this file, and turned one real failure into
      // three that pointed nowhere. Harmless after a COMMIT.
      await a.query('ROLLBACK').catch(() => {});
      await b.query('ROLLBACK').catch(() => {});
      a.release();
      b.release();
    }
  });

  it('the LOADER\'s first-sight recompute does not alert', async () => {
    // `loadBudgetSnapshots` recomputes a never-calculated period, so it writes the
    // same totals the transition hook does — and must NOT alert on them. That
    // recompute is a lazy initialisation of a baseline, not an observation that
    // spend moved: alerting there would fire on history the moment somebody opened
    // a draft, attributed to whoever happened to be editing.
    //
    // Asserted on the CLAIM rather than on the notification, because a claim with
    // nobody to tell is still a claim — checking only the bell would pass on an
    // alert pass that ran and found no audience.
    await budgetRule();
    const { budgetId, periodId } = await makeBudget({ amountMinor: 2000 });
    await setOwner(budgetId, mgrId);
    await addThreshold(budgetId, 9000);

    // THE FIXTURE IS THE TEST. An earlier version just validated a draft against
    // an empty period — where the loader recomputes to zero, nothing crosses, and
    // no alert would fire whether the loader alerted or not. It passed with the
    // loader wired to alert, which is how that was found.
    //
    // So the period has to hold spend that ALREADY crosses the threshold while
    // still being never-calculated: an approved report written straight to the
    // database, the way a seed, an import or a restored backup arrives.
    const earlier = await draft(1900);
    await admin.query(
      `UPDATE expense_report SET status = 'APPROVED', department_id = $2 WHERE id = $1`,
      [earlier, engineeringId],
    );
    expect((await periodTotals(periodId)).rolledUpAt).toBeNull();

    const r = await draft(50);
    const summary = await withOrg(orgId, (tx) => policy.validateReport(tx, r));

    // The rollup DID run — the never-calculated path from part 2 — and it found
    // 1900 of 2000, which is over the 90% threshold.
    const after = await periodTotals(periodId);
    expect(after.rolledUpAt).not.toBeNull();
    expect(after.actual).toBe('1900');
    // The rule answered too, so this is not a case of nothing having happened.
    expect(summary.violations.some((v) => v.rule_code === 'BUDGET_OVERAGE')).toBe(false);

    // …and NOTHING was claimed or sent, because a lazy initialisation of a
    // baseline is not an observation that spend moved.
    expect(await claims(periodId)).toHaveLength(0);
    expect(await alerts()).toHaveLength(0);
  });

  it('a FAILED send leaves no claim, and does not take the submit down with it', async () => {
    // THE TEST THIS DESIGN EXISTS FOR, and the one ExpenseOS's shape cannot pass.
    //
    // Their marker is stamped after the fan-out precisely so a failure re-fires —
    // but their fan-out and their stamp are separate statements with a `catch`
    // between them, so a send that succeeds and a stamp that throws sends twice,
    // and there is no arrangement of the two that fixes both directions.
    //
    // Here the claim and the send are one savepoint. Breaking the notification
    // path mid-transaction must leave: no claim (so it re-fires), no notification,
    // and a report that submitted anyway — because "an expense report that cannot
    // be submitted because a notification failed is a worse outcome than a missing
    // notification".
    //
    // The failure is injected in the database rather than mocked: these tests run
    // the real service against a real Postgres, and a stubbed `notify` would prove
    // only that the code calls something.
    const { budgetId, periodId } = await makeBudget({ amountMinor: 2000 });
    await setOwner(budgetId, mgrId);
    await addThreshold(budgetId, 9000);

    // The injection is SCOPED TO BUDGET ACTIVITY ROWS, and the first version was
    // not — it renamed `activity.payload`, which also broke the approval run's own
    // notification in `openRun`. That call is not inside a savepoint and correctly
    // took the submit down with it, so the test failed for a reason that had
    // nothing to do with what it was asserting. A CHECK on `subject_type` breaks
    // exactly one insert: the budget alert's.
    const r = await draft(1800);
    await admin.query(
      `ALTER TABLE activity ADD CONSTRAINT tmp_no_budget_activity
         CHECK (subject_type <> 'BUDGET')`,
    );
    try {
      await withOrg(orgId, (tx) => lifecycle.submitReport(tx, r, empId));
    } finally {
      await admin.query('ALTER TABLE activity DROP CONSTRAINT tmp_no_budget_activity');
    }

    // The submit went through and the ROLLUP still happened — the alert is the
    // only thing that was lost.
    const status = await admin.query('SELECT status FROM expense_report WHERE id = $1', [r]);
    expect(status.rows[0].status).toBe('SUBMITTED');
    expect((await periodTotals(periodId)).pending).toBe('1800');

    // No claim, so the next evaluation tries again. This is the assertion that
    // fails if the claim is written outside the savepoint.
    expect(await claims(periodId)).toHaveLength(0);
    expect(await alerts()).toHaveLength(0);

    // And it really does re-fire once the path works again.
    const next = await draft(100);
    await withOrg(orgId, (tx) => lifecycle.submitReport(tx, next, empId));
    expect(await claims(periodId)).toHaveLength(1);
    expect(await alerts()).toHaveLength(1);
  });
});

/* ══════════════════════════════════════════════════════════════════════════════
 * VX4-5 PART 3b — THE ADMIN SERVICE
 *
 * Driven through `lib/budgets/admin.ts` rather than raw SQL, because the claims
 * here are about what the SERVICE does — the module gate, the percent
 * conversion, the idempotent seed. The constraints underneath already have their
 * own tests further up this file, driven the other way for the reason `0023`
 * established.
 * ═════════════════════════════════════════════════════════════════════════════ */

async function moduleOff<T>(run: () => Promise<T>): Promise<T> {
  await admin.query(
    `UPDATE module_entitlement SET enabled = false
      WHERE organization_id = $1 AND module_code = 'budgets'`,
    [orgId],
  );
  try {
    return await run();
  } finally {
    await admin.query(
      `UPDATE module_entitlement SET enabled = true
        WHERE organization_id = $1 AND module_code = 'budgets'`,
      [orgId],
    );
  }
}

describe('the budgets admin service (VX4-5 part 3b)', () => {
  it('converts a percentage to basis points in exactly one place', () => {
    expect(budgetAdmin.percentToBp(90)).toBe(9000);
    expect(budgetAdmin.percentToBp('90')).toBe(9000);
    expect(budgetAdmin.percentToBp('90.5')).toBe(9050);
    expect(budgetAdmin.percentToBp('99.99')).toBe(9999);
    expect(budgetAdmin.percentToBp('100')).toBe(10000);
  });

  it('REFUSES a percentage it would have to round, rather than rounding it', () => {
    // Same rule `parseAmountToMinor` follows: a threshold silently moved from what
    // somebody typed is a threshold nobody can explain later.
    expect(() => budgetAdmin.percentToBp('90.123')).toThrow(/at most two decimals/);
    expect(() => budgetAdmin.percentToBp('ninety')).toThrow(/not a percentage/);
    expect(() => budgetAdmin.percentToBp('0')).toThrow(/between/);
    expect(() => budgetAdmin.percentToBp('201')).toThrow(/between/);
  });

  it('creates a budget, and refuses a second one for the same scope', async () => {
    const made = await withOrg(orgId, (tx) =>
      budgetAdmin.createBudget(tx, {
        name: 'Travel',
        glAccountId: accountId,
        currencyCode: 'CAD',
        fiscalYear: 2026,
        ownerId: mgrId,
      }),
    );
    expect(made.name).toBe('Travel');
    expect(made.owner_id).toBe(mgrId);

    // The company-wide case, which is the one NULLS NOT DISTINCT exists for: two
    // NULL narrowings are DISTINCT to Postgres by default, so without that clause
    // this second create would succeed and every total afterwards would be wrong.
    await expect(
      withOrg(orgId, (tx) =>
        budgetAdmin.createBudget(tx, {
          name: 'Travel again',
          glAccountId: accountId,
          currencyCode: 'CAD',
          fiscalYear: 2026,
        }),
      ),
    ).rejects.toMatchObject({ code: 'DUPLICATE_SCOPE' });
  });

  it('a narrower scope is a DIFFERENT budget, not a duplicate', async () => {
    await withOrg(orgId, (tx) =>
      budgetAdmin.createBudget(tx, {
        name: 'Travel — company',
        glAccountId: accountId,
        currencyCode: 'CAD',
        fiscalYear: 2026,
      }),
    );
    const scoped = await withOrg(orgId, (tx) =>
      budgetAdmin.createBudget(tx, {
        name: 'Travel — Engineering',
        glAccountId: accountId,
        currencyCode: 'CAD',
        fiscalYear: 2026,
        departmentId: engineeringId,
      }),
    );
    expect(scoped.department_name).toBe('Engineering');
    expect(await withOrg(orgId, (tx) => budgetAdmin.listBudgets(tx))).toHaveLength(2);
  });

  it('REFUSES every write when the module is off, and still allows the READ', async () => {
    // MT-3: the gate is below the screen, so it holds for any caller. And the read
    // is deliberately ungated — a screen that cannot ask why it is empty cannot
    // tell "module off" from "no budgets yet", which is AC-22's mistake.
    await moduleOff(async () => {
      await expect(
        withOrg(orgId, (tx) =>
          budgetAdmin.createBudget(tx, {
            name: 'Nope',
            glAccountId: accountId,
            currencyCode: 'CAD',
            fiscalYear: 2026,
          }),
        ),
      ).rejects.toThrow(/not enabled for this organization/);

      const readable = await withOrg(orgId, (tx) => budgetAdmin.listBudgets(tx));
      expect(readable).toEqual([]);
    });
  });

  it('seeds twelve calendar months, and re-running adds only what is missing', async () => {
    const made = await withOrg(orgId, (tx) =>
      budgetAdmin.createBudget(tx, {
        name: 'Travel',
        glAccountId: accountId,
        currencyCode: 'CAD',
        fiscalYear: 2026,
      }),
    );
    const created = await withOrg(orgId, (tx) =>
      budgetAdmin.seedMonthlyPeriods(tx, made.id, { startsOn: '2026-01-01', amountMinor: 50000 }),
    );
    expect(created).toBe(12);

    const view = await withOrg(orgId, (tx) => budgetAdmin.getBudget(tx, made.id));
    expect(view!.periods).toHaveLength(12);
    expect(view!.periods[0].starts_on).toBe('2026-01-01');
    // Month arithmetic done by Postgres, not by JavaScript: February lands on the
    // 28th by itself, where a date built from (year, month + n, day) in JS rolls
    // a 31-day start into the following month.
    expect(view!.periods[1].starts_on).toBe('2026-02-01');
    expect(view!.periods[1].ends_on).toBe('2026-02-28');
    expect(view!.periods[11].ends_on).toBe('2026-12-31');

    // IDEMPOTENT on the start-date unique index, so a half-finished seed is
    // finished rather than doubled.
    const again = await withOrg(orgId, (tx) =>
      budgetAdmin.seedMonthlyPeriods(tx, made.id, { startsOn: '2026-01-01', amountMinor: 50000 }),
    );
    expect(again).toBe(0);
    expect((await withOrg(orgId, (tx) => budgetAdmin.getBudget(tx, made.id)))!.periods).toHaveLength(
      12,
    );
  });

  it('four periods is a different seeding decision, not a different schema (BG-5)', async () => {
    const made = await withOrg(orgId, (tx) =>
      budgetAdmin.createBudget(tx, {
        name: 'Quarterly',
        glAccountId: accountId,
        currencyCode: 'CAD',
        fiscalYear: 2026,
      }),
    );
    const created = await withOrg(orgId, (tx) =>
      budgetAdmin.seedMonthlyPeriods(tx, made.id, {
        startsOn: '2026-01-01',
        months: 4,
        amountMinor: 100000,
      }),
    );
    expect(created).toBe(4);
  });

  it('adds a threshold as a PERCENTAGE and refuses the same level twice', async () => {
    const made = await withOrg(orgId, (tx) =>
      budgetAdmin.createBudget(tx, {
        name: 'Travel',
        glAccountId: accountId,
        currencyCode: 'CAD',
        fiscalYear: 2026,
      }),
    );
    await withOrg(orgId, (tx) => budgetAdmin.addThreshold(tx, made.id, '90'));
    const view = await withOrg(orgId, (tx) => budgetAdmin.getBudget(tx, made.id));
    expect(view!.thresholds.map((t) => t.threshold_bp)).toEqual([9000]);

    await expect(
      withOrg(orgId, (tx) => budgetAdmin.addThreshold(tx, made.id, '90')),
    ).rejects.toMatchObject({ code: 'DUPLICATE_THRESHOLD' });
  });

  it('recipients are idempotent, and removing a threshold takes them with it', async () => {
    const made = await withOrg(orgId, (tx) =>
      budgetAdmin.createBudget(tx, {
        name: 'Travel',
        glAccountId: accountId,
        currencyCode: 'CAD',
        fiscalYear: 2026,
      }),
    );
    const thresholdId = await withOrg(orgId, (tx) =>
      budgetAdmin.addThreshold(tx, made.id, '90'),
    );
    // Twice: a double-click is not an error worth a banner.
    await withOrg(orgId, (tx) => budgetAdmin.addRecipient(tx, thresholdId, admId));
    await withOrg(orgId, (tx) => budgetAdmin.addRecipient(tx, thresholdId, admId));
    let view = await withOrg(orgId, (tx) => budgetAdmin.getBudget(tx, made.id));
    expect(view!.thresholds[0].recipients).toHaveLength(1);

    await withOrg(orgId, (tx) => budgetAdmin.removeThreshold(tx, thresholdId));
    view = await withOrg(orgId, (tx) => budgetAdmin.getBudget(tx, made.id));
    expect(view!.thresholds).toHaveLength(0);
    const orphans = await admin.query(
      'SELECT count(*)::int AS n FROM budget_alert_recipient WHERE threshold_id = $1',
      [thresholdId],
    );
    expect(orphans.rows[0].n).toBe(0);
  });

  it('a threshold with no recipients still renders, rather than vanishing', async () => {
    // The LEFT JOIN in `listBudgets`. An inner join would drop a threshold nobody
    // is named on — which is the NORMAL state, since an empty recipient list means
    // "owner only" — and the screen would then offer no way to add one.
    const made = await withOrg(orgId, (tx) =>
      budgetAdmin.createBudget(tx, {
        name: 'Travel',
        glAccountId: accountId,
        currencyCode: 'CAD',
        fiscalYear: 2026,
      }),
    );
    await withOrg(orgId, (tx) => budgetAdmin.addThreshold(tx, made.id, '75'));
    const view = await withOrg(orgId, (tx) => budgetAdmin.getBudget(tx, made.id));
    expect(view!.thresholds).toHaveLength(1);
    expect(view!.thresholds[0].recipients).toEqual([]);
  });

  it('clears an owner with an explicit null, which COALESCE could not express', async () => {
    const made = await withOrg(orgId, (tx) =>
      budgetAdmin.createBudget(tx, {
        name: 'Travel',
        glAccountId: accountId,
        currencyCode: 'CAD',
        fiscalYear: 2026,
        ownerId: mgrId,
      }),
    );
    const cleared = await withOrg(orgId, (tx) =>
      budgetAdmin.updateBudget(tx, made.id, { ownerId: null }),
    );
    expect(cleared.owner_id).toBeNull();
    // An ABSENT key leaves it alone, which is the other half of patch-with-nulls.
    const renamed = await withOrg(orgId, (tx) =>
      budgetAdmin.updateBudget(tx, made.id, { name: 'Travel 2026' }),
    );
    expect(renamed.name).toBe('Travel 2026');
    expect(renamed.owner_id).toBeNull();
  });

  it('deleting a budget takes its periods, thresholds and alert claims with it', async () => {
    const made = await withOrg(orgId, (tx) =>
      budgetAdmin.createBudget(tx, {
        name: 'Travel',
        glAccountId: accountId,
        currencyCode: 'CAD',
        fiscalYear: 2026,
      }),
    );
    await withOrg(orgId, (tx) =>
      budgetAdmin.seedMonthlyPeriods(tx, made.id, { startsOn: '2026-01-01', amountMinor: 1000 }),
    );
    await withOrg(orgId, (tx) => budgetAdmin.addThreshold(tx, made.id, '90'));
    const period = await admin.query(
      'SELECT id FROM budget_period WHERE budget_id = $1 LIMIT 1',
      [made.id],
    );
    await admin.query(
      `INSERT INTO budget_alert_claim
         (organization_id, period_id, threshold_bp, used_minor, amount_minor)
       VALUES ($1,$2,9000,900,1000)`,
      [orgId, period.rows[0].id],
    );

    await withOrg(orgId, (tx) => budgetAdmin.deleteBudget(tx, made.id));

    for (const table of ['budget_period', 'budget_alert_threshold', 'budget_alert_claim']) {
      const left = await admin.query(`SELECT count(*)::int AS n FROM ${table}`);
      expect(left.rows[0].n, table).toBe(0);
    }
  });
});
