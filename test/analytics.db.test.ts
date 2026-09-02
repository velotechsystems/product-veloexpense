/**
 * VX4-6a — spend analytics, against a real database.
 *
 * Own org slugs ('ana-co'). Fixtures are driven through the services where the
 * claim is about what a service does, and through the admin pool where the claim
 * is about data that arrives without one — an import, a seed, a restored backup.
 *
 * ── The three claims worth reading the file for ─────────────────────────────
 *
 * 1. A group is valued at the rate of ITS OWN DAY (UD-6). Two identical amounts
 *    on two days with two different rates must produce two different figures, and
 *    re-running the summary tomorrow must not move either.
 * 2. Spend with no usable rate is NEVER in the total (AN-7). Theirs adds the raw
 *    minor units and reports them as base currency.
 * 3. The range is REFUSED when absent, not defaulted (AN-10).
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { Pool } from 'pg';
import { withOrg } from '@/lib/tenant/context';
import * as analytics from '@/lib/analytics/service';

const admin = new Pool({
  connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL,
});

let orgId: string;
let empId: string;
let mgrId: string;
let engineeringId: string;
let salesId: string;
let mealsId: string;
let travelId: string;
let mealsAccountId: string;

/** A wide range that contains every fixture below. */
const ALL = { from: '2026-01-01', to: '2026-12-31' };

beforeAll(async () => {
  await admin.query('TRUNCATE app_user, organization CASCADE');
  const o = await admin.query(
    `INSERT INTO organization (slug, name) VALUES ('ana-co','Ana Co') RETURNING id`,
  );
  orgId = o.rows[0].id;

  // Immediately after the org and BEFORE any gl_account write — 0022 puts
  // app_module_enabled('accounting') in that table's policy, and this is the
  // fourth ticket in a row where a misplaced entitlement row would have produced
  // "new row violates row-level security policy".
  await admin.query(
    `INSERT INTO module_entitlement (organization_id, module_code, enabled)
     VALUES ($1,'accounting',true), ($1,'analytics',true)`,
    [orgId],
  );

  await withOrg(orgId, async (tx) => {
    const d = await tx.query(
      `INSERT INTO department (organization_id, name) VALUES ($1,'Engineering'),($1,'Sales')
       RETURNING id, name`,
      [orgId],
    );
    engineeringId = d.rows.find((r) => r.name === 'Engineering').id;
    salesId = d.rows.find((r) => r.name === 'Sales').id;

    const m = await tx.query(
      `INSERT INTO app_user (organization_id, email, display_name, role)
       VALUES ($1,'mgr@ana.test','Ana Manager','MANAGER') RETURNING id`,
      [orgId],
    );
    mgrId = m.rows[0].id;
    const e = await tx.query(
      `INSERT INTO app_user (organization_id, email, display_name, role, manager_id, department_id)
       VALUES ($1,'emp@ana.test','Ana Employee','EMPLOYEE',$2,$3) RETURNING id`,
      [orgId, mgrId, engineeringId],
    );
    empId = e.rows[0].id;

    const g = await tx.query(
      `INSERT INTO gl_account (organization_id, number, name, type)
       VALUES ($1,'68200','Meals','expense'), ($1,'68100','Travel','expense')
       RETURNING id, number`,
      [orgId],
    );
    mealsAccountId = g.rows.find((r) => r.number === '68200').id;
    const travelAccountId = g.rows.find((r) => r.number === '68100').id;

    const c = await tx.query(
      `INSERT INTO expense_category (organization_id, code, label, gl_account_id)
       VALUES ($1,'meals','Meals',$2), ($1,'travel','Travel',$3)
       RETURNING id, code`,
      [orgId, mealsAccountId, travelAccountId],
    );
    mealsId = c.rows.find((r) => r.code === 'meals').id;
    travelId = c.rows.find((r) => r.code === 'travel').id;
  });
});

beforeEach(async () => {
  await admin.query('TRUNCATE expense_report CASCADE');
  await admin.query('DELETE FROM fx_rate');
});

afterAll(async () => {
  await admin.end();
});

/**
 * A report written straight to a status, with a stamped department.
 *
 * Through the admin pool deliberately: analytics reads history, and history
 * arrives from an import or a backup as often as from a submit. Driving every
 * fixture through `submitReport` would also drag the approval engine, the policy
 * engine and the budget rollup into a test about aggregation.
 */
async function spend(input: {
  status: string;
  amountMinor: number;
  onDate?: string | null;
  currencyCode?: string;
  categoryId?: string;
  departmentId?: string | null;
  submitterId?: string;
}): Promise<string> {
  const currency = input.currencyCode ?? 'CAD';
  // TWO constraints from `0013` govern a REIMBURSED row, and this helper had to
  // learn both — the first draft was refused twice, which is the schema being
  // right rather than the test being unlucky:
  //   · `expense_report_reimbursed_stamped`: (status = 'REIMBURSED') = (reimbursed_at
  //     IS NOT NULL). "A report that has been paid and still looks payable is the
  //     exact double-payment outcome RB-2 describes."
  //   · `expense_report_reimbursement_complete`: (reimbursed_at IS NULL) =
  //     (reimbursed_by_id IS NULL). "A report with reimbursed_at and no actor is a
  //     payment nobody made."
  // Satisfied rather than sidestepped by dropping REIMBURSED from the fixtures,
  // because REIMBURSED counting as committed spend is one of the claims here.
  const r = await admin.query(
    `INSERT INTO expense_report
       (organization_id, submitter_id, title, currency_code, status, department_id, total_minor,
        reimbursed_at, reimbursed_by_id)
     VALUES ($1,$2,$3,$4,$5::expense_report_status,$6,$7,
             CASE WHEN $5 = 'REIMBURSED' THEN now() END,
             CASE WHEN $5 = 'REIMBURSED' THEN $8::uuid END) RETURNING id`,
    [
      orgId,
      input.submitterId ?? empId,
      `Ana ${Math.random().toString(36).slice(2, 8)}`,
      currency,
      input.status,
      'departmentId' in input ? input.departmentId : engineeringId,
      input.amountMinor,
      mgrId,
    ],
  );
  const reportId = r.rows[0].id as string;
  const e = await admin.query(
    `INSERT INTO expense (organization_id, report_id, currency_code, merchant, txn_date)
     VALUES ($1,$2,$3,'Ana Cafe',$4::date) RETURNING id`,
    [orgId, reportId, currency, input.onDate ?? '2026-03-15'],
  );
  const categoryId = input.categoryId ?? mealsId;
  const account = await admin.query(
    'SELECT gl_account_id FROM expense_category WHERE id = $1',
    [categoryId],
  );
  await admin.query(
    `INSERT INTO expense_line_item
       (organization_id, expense_id, category_id, amount_minor, gl_account_id)
     VALUES ($1,$2,$3,$4,$5)`,
    [orgId, e.rows[0].id, categoryId, input.amountMinor, account.rows[0].gl_account_id],
  );
  return reportId;
}

async function rate(base: string, quote: string, value: string, asOf: string) {
  await admin.query(
    `INSERT INTO fx_rate (base, quote, rate, as_of, source) VALUES ($1,$2,$3,$4::date,'MANUAL')`,
    [base, quote, value, asOf],
  );
}

const summary = (range = ALL) => withOrg(orgId, (tx) => analytics.spendSummary(tx, range));

describe('the range is refused rather than defaulted (AN-10)', () => {
  it('refuses a missing range, both halves', async () => {
    await expect(
      withOrg(orgId, (tx) =>
        analytics.spendSummary(tx, { from: '', to: '2026-12-31' } as analytics.SpendRange),
      ),
    ).rejects.toMatchObject({ code: 'RANGE_REQUIRED' });
    await expect(
      withOrg(orgId, (tx) =>
        analytics.spendSummary(tx, { from: '2026-01-01', to: '' } as analytics.SpendRange),
      ),
    ).rejects.toMatchObject({ code: 'RANGE_REQUIRED' });
  });

  it('refuses a range that ends before it begins', async () => {
    await expect(summary({ from: '2026-06-01', to: '2026-01-01' })).rejects.toMatchObject({
      code: 'RANGE_INVERTED',
    });
  });

  it('leaves spend outside the range out', async () => {
    await spend({ status: 'APPROVED', amountMinor: 1000, onDate: '2026-03-15' });
    await spend({ status: 'APPROVED', amountMinor: 9999, onDate: '2026-09-15' });
    const march = await summary({ from: '2026-03-01', to: '2026-03-31' });
    expect(march.committedMinor).toBe(1000n);
  });
});

describe('which statuses count', () => {
  it('separates committed from in-flight, and ignores the rest', async () => {
    await spend({ status: 'APPROVED', amountMinor: 1000 });
    await spend({ status: 'REIMBURSED', amountMinor: 2000 });
    await spend({ status: 'SUBMITTED', amountMinor: 400 });
    // Not spend in either bucket: one never claimed, two claimed and refused.
    await spend({ status: 'DRAFT', amountMinor: 500000 });
    await spend({ status: 'REJECTED', amountMinor: 500000 });
    await spend({ status: 'RETURNED', amountMinor: 500000 });

    const s = await summary();
    expect(s.committedMinor).toBe(3000n);
    expect(s.pendingMinor).toBe(400n);
  });
});

describe('a group is valued at the rate of its OWN day (UD-6)', () => {
  it('uses each day’s rate, not the newest one', async () => {
    // 100.00 USD on two days, with the rate moving between them. One figure would
    // mean the total had been re-valued at whatever the table says now — which is
    // upstream's b9e242d7, where a header and its own single line disagreed by 15
    // cents for a year.
    await rate('USD', 'CAD', '1.30000000', '2026-03-01');
    await rate('USD', 'CAD', '1.40000000', '2026-06-01');
    await spend({ status: 'APPROVED', amountMinor: 10000, currencyCode: 'USD', onDate: '2026-03-15' });
    await spend({ status: 'APPROVED', amountMinor: 10000, currencyCode: 'USD', onDate: '2026-06-15' });

    const s = await summary();
    // 13000 + 14000, not 28000 (both at today's 1.40) and not 26000 (both at 1.30).
    expect(s.committedMinor).toBe(27000n);
    const march = s.byMonth.find((m) => m.label === '2026-03')!;
    const june = s.byMonth.find((m) => m.label === '2026-06')!;
    expect(march.committedMinor).toBe(13000n);
    expect(june.committedMinor).toBe(14000n);
  });

  it('a rate added LATER does not move an earlier month', async () => {
    await rate('USD', 'CAD', '1.30000000', '2026-03-01');
    await spend({ status: 'APPROVED', amountMinor: 10000, currencyCode: 'USD', onDate: '2026-03-15' });
    expect((await summary()).committedMinor).toBe(13000n);

    // The market moves. March did not.
    await rate('USD', 'CAD', '1.90000000', '2026-07-01');
    expect((await summary()).committedMinor).toBe(13000n);
  });
});

describe('a missing rate is loud, never coerced (AN-7)', () => {
  it('keeps unconvertible spend OUT of the total and names its currency', async () => {
    await spend({ status: 'APPROVED', amountMinor: 1000 });
    // USD with no rate at all. Theirs adds 5000 raw minor units to the CAD total
    // and reports it as base currency with nothing on the response to say so.
    await spend({ status: 'APPROVED', amountMinor: 5000, currencyCode: 'USD' });
    await spend({ status: 'SUBMITTED', amountMinor: 700, currencyCode: 'USD' });

    const s = await summary();
    expect(s.committedMinor).toBe(1000n);
    expect(s.pendingMinor).toBe(0n);
    expect(s.unconvertible.committedMinor).toBe(5000n);
    expect(s.unconvertible.pendingMinor).toBe(700n);
    // In the SOURCE currency: summing what could not be converted into one figure
    // would be the arithmetic this whole branch exists to avoid.
    expect(s.unconvertible.byCurrency).toEqual({ USD: '5700' });
  });

  it('a rate that exists only AFTER the expense does not rescue it', async () => {
    // `buildRateLookup` is "latest on or before", so a rate published in June
    // cannot value a March claim. The alternative — reaching forward — is how a
    // total starts moving on its own.
    await rate('USD', 'CAD', '1.30000000', '2026-06-01');
    await spend({ status: 'APPROVED', amountMinor: 10000, currencyCode: 'USD', onDate: '2026-03-15' });
    const s = await summary();
    expect(s.committedMinor).toBe(0n);
    expect(s.unconvertible.byCurrency).toEqual({ USD: '10000' });
  });

  it('converts by RECIPROCAL when only the other direction is published', async () => {
    // The Bank of Canada publishes CAD-quoted pairs, so USD->CAD exists and
    // CAD->USD does not. `lib/policy/rates.ts` derives the reciprocal, and doing
    // the FX in SQL would have meant reimplementing that rule in a query.
    await admin.query(`UPDATE organization SET policy_currency_code = 'USD' WHERE id = $1`, [orgId]);
    try {
      await rate('USD', 'CAD', '1.25000000', '2026-03-01');
      await spend({ status: 'APPROVED', amountMinor: 10000, onDate: '2026-03-15' });
      const s = await summary();
      expect(s.baseCurrency).toBe('USD');
      expect(s.committedMinor).toBe(8000n);
      expect(s.unconvertible.byCurrency).toEqual({});
    } finally {
      await admin.query(`UPDATE organization SET policy_currency_code = 'CAD' WHERE id = $1`, [orgId]);
    }
  });
});

describe('the dimensions', () => {
  it('EVERY dimension adds up to the header, exactly', async () => {
    // THE INVARIANT THE ONE-QUERY DESIGN EXISTS FOR, and the reason the first
    // version of the service was rewritten. Six independent groupings each round
    // their own conversion, so a header and the chart under it can differ by
    // cents — which is upstream's b9e242d7, a report header reading CAD 174.29
    // over its only line reading CAD 174.14, for a year.
    //
    // Multiple currencies and multiple days on purpose: with one currency the
    // conversion is the identity and this assertion cannot fail.
    await rate('USD', 'CAD', '1.37000000', '2026-03-01');
    await spend({ status: 'APPROVED', amountMinor: 3333, onDate: '2026-03-15', currencyCode: 'USD' });
    await spend({ status: 'APPROVED', amountMinor: 777, onDate: '2026-03-16', currencyCode: 'USD', categoryId: travelId });
    await spend({ status: 'APPROVED', amountMinor: 2500, onDate: '2026-04-15' });
    await spend({ status: 'SUBMITTED', amountMinor: 999, onDate: '2026-04-16', currencyCode: 'USD', submitterId: mgrId });

    const s = await summary();
    const sum = (slices: analytics.SpendSlice[], field: 'committedMinor' | 'pendingMinor') =>
      slices.reduce((acc, x) => acc + x[field], 0n);

    for (const [name, slices] of [
      ['byMonth', s.byMonth],
      ['byCategory', s.byCategory],
      ['byGlAccount', s.byGlAccount],
      ['byDepartment', s.byDepartment],
      ['byBusinessUnit', s.byBusinessUnit],
      ['bySubmitter', s.bySubmitter],
    ] as const) {
      expect(sum(slices, 'committedMinor'), `${name} committed`).toBe(s.committedMinor);
      expect(sum(slices, 'pendingMinor'), `${name} pending`).toBe(s.pendingMinor);
    }
    // …and the totals are not trivially zero, which is what would make the loop
    // above pass without proving anything.
    expect(s.committedMinor).toBeGreaterThan(0n);
    expect(s.pendingMinor).toBeGreaterThan(0n);
    expect(s.byMonth.map((m) => m.label)).toEqual(['2026-03', '2026-04']);
  });

  it('splits by category, GL account and submitter, biggest first', async () => {
    await spend({ status: 'APPROVED', amountMinor: 1000, categoryId: mealsId });
    await spend({ status: 'APPROVED', amountMinor: 4000, categoryId: travelId });
    await spend({ status: 'APPROVED', amountMinor: 300, submitterId: mgrId, departmentId: salesId });

    const s = await summary();
    expect(s.byCategory.map((c) => c.label)).toEqual(['Travel', 'Meals']);
    expect(s.byCategory[0].committedMinor).toBe(4000n);
    expect(s.byGlAccount.map((a) => a.label)).toEqual([
      '68100 — Travel',
      '68200 — Meals',
    ]);
    expect(s.bySubmitter.map((u) => u.label)).toEqual(['Ana Employee', 'Ana Manager']);
  });

  it('uses the STAMPED department, so a transfer cannot move last quarter', async () => {
    await spend({ status: 'APPROVED', amountMinor: 1000, departmentId: engineeringId });
    // The employee moves to Sales. A join through the submitter would rewrite the
    // chart; the stamp is why 0024 added the column.
    await admin.query('UPDATE app_user SET department_id = $2 WHERE id = $1', [empId, salesId]);
    try {
      const s = await summary();
      expect(s.byDepartment.map((d) => d.label)).toEqual(['Engineering']);
    } finally {
      await admin.query('UPDATE app_user SET department_id = $2 WHERE id = $1', [
        empId,
        engineeringId,
      ]);
    }
  });

  it('says Unassigned rather than dropping spend with no department', async () => {
    // An INNER JOIN would silently omit it, and the dimension totals would then
    // be quietly smaller than the header — the disagreement class again.
    await spend({ status: 'APPROVED', amountMinor: 1000, departmentId: null });
    const s = await summary();
    expect(s.byDepartment).toHaveLength(1);
    expect(s.byDepartment[0]).toMatchObject({ key: null, label: 'Unassigned' });
    expect(s.byDepartment[0].committedMinor).toBe(1000n);
  });

  it('attributes an UNDATED expense by created_at, not by today', async () => {
    // `txn_date` is nullable and the fallback is `created_at::date` — the same
    // expression the budget rollup uses, chosen because it is immutable where
    // `current_date` would make a total change overnight on its own.
    const reportId = await spend({ status: 'APPROVED', amountMinor: 1000 });
    await admin.query(
      `UPDATE expense SET txn_date = NULL, created_at = '2026-05-20T12:00:00Z' WHERE report_id = $1`,
      [reportId],
    );
    const may = await summary({ from: '2026-05-01', to: '2026-05-31' });
    expect(may.committedMinor).toBe(1000n);
    expect(may.byMonth[0].label).toBe('2026-05');
  });
});

describe('the module gate', () => {
  it('refuses the read entirely when analytics is off', async () => {
    // Unlike budgets, analytics owns no tables — so the gate is ON THE READ, and
    // a tenant without the module has no analytics at all rather than an empty
    // one. The screen renders its own off-state from the ungated isModuleEnabled.
    await admin.query(
      `UPDATE module_entitlement SET enabled = false
        WHERE organization_id = $1 AND module_code = 'analytics'`,
      [orgId],
    );
    try {
      await expect(summary()).rejects.toThrow(/not enabled for this organization/);
    } finally {
      await admin.query(
        `UPDATE module_entitlement SET enabled = true
          WHERE organization_id = $1 AND module_code = 'analytics'`,
        [orgId],
      );
    }
  });
});
