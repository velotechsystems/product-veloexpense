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
  // `fx_rate` is GLOBAL — not tenant-scoped, so the truncate above leaves it —
  // and the unconvertible-spend tests below assert on the ABSENCE of a rate.
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
    const e = await expenses.addExpense(tx, r.id, { currencyCode, merchant: 'Taxi' });
    await expenses.addLineItem(tx, e.id, { categoryId, amountMinor });
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
