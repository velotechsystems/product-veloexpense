/**
 * VX1-7 — policy engine DB test (ExpenseOS Module 9).
 *
 * Exercises the service over a tenant transaction (withOrg), like the other DB
 * suites, so no auth session is needed. Own org slug ('policy-co') because the
 * suites share one database — see vitest.config.ts.
 *
 * The interesting cases are not "a rule fires" but what re-validation does:
 * findings must be idempotent, an acknowledgement must survive a re-run, and a
 * finding that stops firing must take its acknowledgement with it.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { Pool } from 'pg';
import { withOrg, withoutOrg } from '@/lib/tenant/context';
import * as expenses from '@/lib/expenses/service';
import * as policy from '@/lib/policy/service';

const admin = new Pool({
  connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL,
});

let orgId: string;
let userId: string;
let mealsId: string;
let airfareId: string;

/** A report with one expense and one line, at the given amount. */
async function draft(amountMinor: number, opts: { categoryId?: string; withReceipt?: boolean } = {}) {
  return withOrg(orgId, async (tx) => {
    const report = await expenses.createReport(tx, 'p@policy.test', {
      title: 'Policy subject',
      currencyCode: 'CAD',
    });
    const expense = await expenses.addExpense(tx, report.id, {
      currencyCode: 'CAD',
      merchant: 'Test Merchant',
    });
    const line = await expenses.addLineItem(tx, expense.id, {
      categoryId: opts.categoryId ?? mealsId,
      amountMinor,
    });
    if (opts.withReceipt) {
      await tx.query(
        `INSERT INTO receipt (organization_id, expense_id, s3_key, filename, content_type,
                              size_bytes, status, uploaded_by_id)
         VALUES ($1, $2, $3, 'r.pdf', 'application/pdf', 10, 'STORED', $4)`,
        [orgId, expense.id, `org/${orgId}/receipts/${expense.id}/r.pdf`, userId],
      );
    }
    return { reportId: report.id as string, expenseId: expense.id as string, lineId: line.id as string };
  });
}

/**
 * The same as `draft`, in a chosen currency. VX3-2: the whole point of PE-1 is
 * that a report's currency and a threshold's currency are different things, so a
 * test of it cannot use the fixture that hard-codes CAD for both.
 */
async function draftIn(currencyCode: string, amountMinor: number) {
  return withOrg(orgId, async (tx) => {
    const report = await expenses.createReport(tx, 'p@policy.test', {
      title: `Policy subject ${currencyCode}`,
      currencyCode,
    });
    const expense = await expenses.addExpense(tx, report.id, { currencyCode, merchant: 'M' });
    const line = await expenses.addLineItem(tx, expense.id, {
      categoryId: mealsId,
      amountMinor,
    });
    return { reportId: report.id as string, lineId: line.id as string };
  });
}

async function setRate(base: string, quote: string, rate: string, asOf = '2020-01-01') {
  await admin.query(
    `INSERT INTO fx_rate (base, quote, rate, as_of, source) VALUES ($1,$2,$3,$4,'MANUAL')
       ON CONFLICT (base, quote, as_of) DO UPDATE SET rate = EXCLUDED.rate`,
    [base, quote, rate, asOf],
  );
}

beforeAll(async () => {
  await admin.query('TRUNCATE app_user, organization CASCADE');
  // fx_rate is GLOBAL, so it survives the tenant truncate above and has to be
  // cleared explicitly or one test's rate leaks into another's.
  await admin.query('DELETE FROM fx_rate');
  const o = await admin.query(
    "INSERT INTO organization (slug, name) VALUES ('policy-co','Policy Co') RETURNING id",
  );
  orgId = o.rows[0].id;
  await withOrg(orgId, async (tx) => {
    const u = await tx.query(
      "INSERT INTO app_user (organization_id, email, display_name) VALUES ($1,'p@policy.test','P') RETURNING id",
      [orgId],
    );
    userId = u.rows[0].id;
    const meals = await tx.query(
      "INSERT INTO expense_category (organization_id, code, label) VALUES ($1,'meals','Meals') RETURNING id",
      [orgId],
    );
    mealsId = meals.rows[0].id;
    const air = await tx.query(
      "INSERT INTO expense_category (organization_id, code, label) VALUES ($1,'air','Airfare') RETURNING id",
      [orgId],
    );
    airfareId = air.rows[0].id;
  });
});

afterAll(async () => {
  await admin.end();
});

/** Each test owns its rule set, so one test's rules never leak into another. */
async function withRules<T>(
  presets: policy.NewPolicy[],
  fn: (tx: Parameters<Parameters<typeof withOrg>[1]>[0]) => Promise<T>,
): Promise<T> {
  return withOrg(orgId, async (tx) => {
    await tx.query('DELETE FROM expense_policy');
    for (const preset of presets) await policy.createPolicy(tx, preset);
    return fn(tx);
  });
}

describe('policy rules', () => {
  it('flags a line item over the per-transaction limit', async () => {
    const { reportId, lineId } = await draft(75_00);
    const result = await withRules(
      [{ kind: 'PER_TRANSACTION_LIMIT', severity: 'WARNING', params: { thresholdMinor: 50_00 } }],
      (tx) => policy.validateReport(tx, reportId),
    );
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].rule_code).toBe('PER_TRANSACTION_LIMIT');
    expect(result.violations[0].severity).toBe('WARNING');
    expect(result.violations[0].line_item_id).toBe(lineId);
    expect(result.violations[0].message).toContain('$75.00');
    expect(result.violations[0].message).toContain('$50.00');
    expect(result.blocking).toBe(false);
  });

  it('leaves a line at exactly the limit alone', async () => {
    const { reportId } = await draft(50_00);
    const result = await withRules(
      [{ kind: 'PER_TRANSACTION_LIMIT', params: { thresholdMinor: 50_00 } }],
      (tx) => policy.validateReport(tx, reportId),
    );
    expect(result.violations).toHaveLength(0);
  });

  it('only applies a category-scoped limit to that category', async () => {
    const meals = await draft(75_00, { categoryId: mealsId });
    const airfare = await draft(75_00, { categoryId: airfareId });
    const results = await withRules(
      [
        {
          kind: 'PER_TRANSACTION_LIMIT',
          categoryId: mealsId,
          params: { thresholdMinor: 50_00 },
        },
      ],
      async (tx) => ({
        meals: await policy.validateReport(tx, meals.reportId),
        airfare: await policy.validateReport(tx, airfare.reportId),
      }),
    );
    expect(results.meals.violations).toHaveLength(1);
    expect(results.airfare.violations).toHaveLength(0);
  });

  it('blocks an expense with no receipt and clears once one is attached', async () => {
    const { reportId, expenseId } = await draft(90_00);
    const before = await withRules(
      [{ kind: 'RECEIPT_REQUIRED', severity: 'BLOCK', params: { thresholdMinor: 25_00 } }],
      (tx) => policy.validateReport(tx, reportId),
    );
    expect(before.blocking).toBe(true);
    expect(before.violations[0].rule_code).toBe('RECEIPT_REQUIRED');
    // The finding is about an expense, not a line — keyed by expense id.
    expect(before.violations[0].line_item_id).toBeNull();
    expect(before.violations[0].finding_key).toBe(expenseId);

    const after = await withOrg(orgId, async (tx) => {
      await tx.query(
        `INSERT INTO receipt (organization_id, expense_id, s3_key, filename, content_type,
                              size_bytes, status, uploaded_by_id)
         VALUES ($1, $2, $3, 'r.pdf', 'application/pdf', 10, 'STORED', $4)`,
        [orgId, expenseId, `org/${orgId}/receipts/${expenseId}/late.pdf`, userId],
      );
      return policy.validateReport(tx, reportId);
    });
    expect(after.violations).toHaveLength(0);
    expect(after.blocking).toBe(false);
  });

  it('raises one receipt finding per expense, not one per report', async () => {
    const { reportId } = await draft(90_00);
    const result = await withOrg(orgId, async (tx) => {
      await tx.query('DELETE FROM expense_policy');
      await policy.createPolicy(tx, { kind: 'RECEIPT_REQUIRED', severity: 'WARNING', params: {} });
      const report = await expenses.getReport(tx, reportId);
      await expenses.addExpense(tx, report!.report.id, { currencyCode: 'CAD', merchant: 'Second' });
      return policy.validateReport(tx, reportId);
    });
    // Two receipt-less expenses => two findings. ExpenseOS's (ruleCode,
    // lineItemId) identity would have collapsed these into one.
    expect(result.violations.filter((v) => v.rule_code === 'RECEIPT_REQUIRED')).toHaveLength(2);
  });

  it('flags a line coded to a retired category', async () => {
    const { reportId } = await draft(10_00, { categoryId: airfareId });
    const result = await withOrg(orgId, async (tx) => {
      await tx.query('DELETE FROM expense_policy');
      await policy.createPolicy(tx, { kind: 'CATEGORY_ACTIVE', severity: 'BLOCK' });
      await tx.query('UPDATE expense_category SET active = false WHERE id = $1', [airfareId]);
      const validated = await policy.validateReport(tx, reportId);
      await tx.query('UPDATE expense_category SET active = true WHERE id = $1', [airfareId]);
      return validated;
    });
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].rule_code).toBe('CATEGORY_ACTIVE');
    expect(result.blocking).toBe(true);
  });

  it('flags a negative line item', async () => {
    const { reportId } = await draft(-500);
    const result = await withRules([{ kind: 'NON_NEGATIVE_AMOUNT', severity: 'BLOCK' }], (tx) =>
      policy.validateReport(tx, reportId),
    );
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].rule_code).toBe('NON_NEGATIVE_AMOUNT');
  });

  it('ignores a disabled rule and one outside its effective window', async () => {
    const { reportId } = await draft(75_00);
    const result = await withRules(
      [
        {
          kind: 'PER_TRANSACTION_LIMIT',
          enabled: false,
          params: { thresholdMinor: 50_00 },
        },
        {
          kind: 'RECEIPT_REQUIRED',
          categoryId: mealsId,
          effectiveFrom: '2999-01-01',
          params: {},
        },
      ],
      (tx) => policy.validateReport(tx, reportId),
    );
    expect(result.violations).toHaveLength(0);
  });
});

describe('re-validation', () => {
  it('is idempotent — re-running does not duplicate findings', async () => {
    const { reportId } = await draft(75_00);
    const result = await withRules(
      [{ kind: 'PER_TRANSACTION_LIMIT', params: { thresholdMinor: 50_00 } }],
      async (tx) => {
        await policy.validateReport(tx, reportId);
        await policy.validateReport(tx, reportId);
        return policy.validateReport(tx, reportId);
      },
    );
    expect(result.violations).toHaveLength(1);
  });

  it('keeps an acknowledgement across a re-run, and drops it when the finding stops firing', async () => {
    const { reportId, lineId } = await draft(75_00);
    const acknowledged = await withRules(
      [{ kind: 'PER_TRANSACTION_LIMIT', severity: 'WARNING', params: { thresholdMinor: 50_00 } }],
      async (tx) => {
        const first = await policy.validateReport(tx, reportId);
        await policy.acknowledgeViolation(tx, first.violations[0].id, userId, 'Client dinner, pre-approved');
        return policy.validateReport(tx, reportId);
      },
    );
    expect(acknowledged.violations).toHaveLength(1);
    expect(acknowledged.violations[0].resolved_at).not.toBeNull();
    expect(acknowledged.violations[0].resolve_note).toBe('Client dinner, pre-approved');
    expect(acknowledged.violations[0].resolved_by_name).toBe('P');

    const fixed = await withOrg(orgId, async (tx) => {
      await expenses.updateLineItem(tx, lineId, { amountMinor: 1000 });
      return policy.validateReport(tx, reportId);
    });
    expect(fixed.violations).toHaveLength(0);
  });

  it('refuses to acknowledge a BLOCK finding', async () => {
    const { reportId } = await draft(75_00);
    await withRules(
      [{ kind: 'PER_TRANSACTION_LIMIT', severity: 'BLOCK', params: { thresholdMinor: 50_00 } }],
      async (tx) => {
        const result = await policy.validateReport(tx, reportId);
        await expect(
          policy.acknowledgeViolation(tx, result.violations[0].id, userId, 'let me through'),
        ).rejects.toThrow(/cannot be acknowledged/);
      },
    );
  });

  it('requires a note on an acknowledgement', async () => {
    const { reportId } = await draft(75_00);
    await withRules(
      [{ kind: 'PER_TRANSACTION_LIMIT', severity: 'WARNING', params: { thresholdMinor: 50_00 } }],
      async (tx) => {
        const result = await policy.validateReport(tx, reportId);
        await expect(
          policy.acknowledgeViolation(tx, result.violations[0].id, userId, '   '),
        ).rejects.toThrow(/needs a note/);
      },
    );
  });

  it('clears an acknowledgement when the rule is raised to BLOCK', async () => {
    const { reportId } = await draft(75_00);
    const result = await withRules(
      [{ kind: 'PER_TRANSACTION_LIMIT', severity: 'WARNING', params: { thresholdMinor: 50_00 } }],
      async (tx) => {
        const first = await policy.validateReport(tx, reportId);
        await policy.acknowledgeViolation(tx, first.violations[0].id, userId, 'fine by me');
        const rules = await policy.listPolicies(tx);
        await policy.updatePolicy(tx, rules[0].id, { severity: 'BLOCK' });
        return policy.validateReport(tx, reportId);
      },
    );
    expect(result.violations[0].severity).toBe('BLOCK');
    expect(result.violations[0].resolved_at).toBeNull();
    expect(result.blocking).toBe(true);
  });

  it('removes findings when their rule is deleted', async () => {
    const { reportId } = await draft(75_00);
    const result = await withRules(
      [{ kind: 'PER_TRANSACTION_LIMIT', params: { thresholdMinor: 50_00 } }],
      async (tx) => {
        await policy.validateReport(tx, reportId);
        const rules = await policy.listPolicies(tx);
        await policy.deletePolicy(tx, rules[0].id);
        return policy.getValidation(tx, reportId);
      },
    );
    expect(result.violations).toHaveLength(0);
  });
});

describe('policy configuration', () => {
  it('rejects an unknown rule kind and an unknown severity', async () => {
    await withOrg(orgId, async (tx) => {
      await expect(policy.createPolicy(tx, { kind: 'NOT_A_RULE' })).rejects.toThrow(/unknown rule kind/);
      await expect(
        policy.createPolicy(tx, { kind: 'CATEGORY_ACTIVE', severity: 'LOUD' }),
      ).rejects.toThrow(/unknown severity/);
    });
  });

  it('requires the threshold the rule declares', async () => {
    await withOrg(orgId, async (tx) => {
      await tx.query('DELETE FROM expense_policy');
      await expect(policy.createPolicy(tx, { kind: 'PER_TRANSACTION_LIMIT' })).rejects.toThrow(
        /needs Limit/,
      );
    });
  });

  it('refuses to scope a whole-report rule to a category', async () => {
    await withOrg(orgId, async (tx) => {
      await expect(
        policy.createPolicy(tx, { kind: 'NON_NEGATIVE_AMOUNT', categoryId: mealsId }),
      ).rejects.toThrow(/cannot be scoped/);
    });
  });

  it('refuses a duplicate rule at the same scope', async () => {
    await withOrg(orgId, async (tx) => {
      await tx.query('DELETE FROM expense_policy');
      await policy.createPolicy(tx, { kind: 'CATEGORY_ACTIVE' });
      await expect(policy.createPolicy(tx, { kind: 'CATEGORY_ACTIVE' })).rejects.toThrow(
        /already exists/,
      );
    });
  });

  it('restores the starter set idempotently', async () => {
    const counts = await withOrg(orgId, async (tx) => {
      await tx.query('DELETE FROM expense_policy');
      const first = await policy.ensureDefaultPolicies(tx);
      const second = await policy.ensureDefaultPolicies(tx);
      return { first, second, total: (await policy.listPolicies(tx)).length };
    });
    expect(counts.first).toBe(4);
    expect(counts.second).toBe(0);
    expect(counts.total).toBe(4);
  });
});

describe('threshold currency (VX3-2, PE-1)', () => {
  beforeEach(async () => {
    await admin.query('DELETE FROM fx_rate');
    await admin.query('DELETE FROM policy_violation');
    await admin.query('DELETE FROM expense_policy');
    await admin.query("UPDATE organization SET policy_currency_code = 'CAD' WHERE id = $1", [orgId]);
  });

  it('THE DEFECT: a CAD threshold is not applied to a USD amount unconverted', async () => {
    // The rule: nothing over CAD 500.00. The report: USD 400.00, which is CAD
    // 540.00 at 1.35 and therefore OVER. Before VX3-2 the comparison was
    // 40000 <= 50000 and the report passed — the exact case PE-1 describes.
    await setRate('USD', 'CAD', '1.35000000');
    await withOrg(orgId, (tx) =>
      policy.createPolicy(tx, {
        kind: 'PER_TRANSACTION_LIMIT',
        severity: 'WARNING',
        params: { thresholdMinor: 50000 },
      }),
    );
    const { reportId } = await draftIn('USD', 40000);
    const summary = await withOrg(orgId, (tx) => policy.validateReport(tx, reportId));
    const violation = summary.violations.find((v) => v.rule_code === 'PER_TRANSACTION_LIMIT');
    expect(violation, 'USD 400 is CAD 540 and must breach a CAD 500 limit').toBeDefined();
    expect(violation?.severity).toBe('WARNING');
    expect(violation?.data.convertedMinor).toBe('54000');
    expect(violation?.data.rateBasis).toBe('DIRECT');
  });

  it('and a USD amount that is genuinely under the converted limit does not fire', async () => {
    await setRate('USD', 'CAD', '1.35000000');
    await withOrg(orgId, (tx) =>
      policy.createPolicy(tx, {
        kind: 'PER_TRANSACTION_LIMIT',
        params: { thresholdMinor: 50000 },
      }),
    );
    // USD 370.00 -> CAD 499.50, just under.
    const { reportId } = await draftIn('USD', 37000);
    const summary = await withOrg(orgId, (tx) => policy.validateReport(tx, reportId));
    expect(summary.violations.filter((v) => v.rule_code === 'PER_TRANSACTION_LIMIT')).toEqual([]);
  });

  it('names both currencies in the message once a conversion happened', async () => {
    // The sentence is what hid this defect: "is $700.00, over the $500.00 limit"
    // with one figure USD and the other CAD reads as though it had converted.
    await setRate('USD', 'CAD', '1.35000000');
    await withOrg(orgId, (tx) =>
      policy.createPolicy(tx, { kind: 'PER_TRANSACTION_LIMIT', params: { thresholdMinor: 50000 } }),
    );
    const { reportId } = await draftIn('USD', 40000);
    const summary = await withOrg(orgId, (tx) => policy.validateReport(tx, reportId));
    const message = summary.violations.find((v) => v.rule_code === 'PER_TRANSACTION_LIMIT')!.message;
    expect(message).toMatch(/converted/);
  });

  it('degrades LOUDLY to INFO when no rate exists, and does not guess', async () => {
    // No fx_rate rows at all. ExpenseOS's v2 path returns the unconverted amount
    // here, comparing USD minor units against a CAD threshold with no signal
    // whatever (PE-7). This asserts the opposite: a finding that says so.
    await withOrg(orgId, (tx) =>
      policy.createPolicy(tx, {
        kind: 'PER_TRANSACTION_LIMIT',
        severity: 'BLOCK',
        params: { thresholdMinor: 50000 },
      }),
    );
    const { reportId } = await draftIn('USD', 40000);
    const summary = await withOrg(orgId, (tx) => policy.validateReport(tx, reportId));
    const finding = summary.violations.find((v) => v.rule_code === 'PER_TRANSACTION_LIMIT');
    expect(finding).toBeDefined();
    // INFO, not the configured BLOCK — PE-3's severity override in use.
    expect(finding?.severity).toBe('INFO');
    expect(finding?.data.fxRateMissing).toBe(true);
    expect(finding?.data).toMatchObject({ fromCurrency: 'USD', toCurrency: 'CAD' });
    // And crucially it does NOT block the submit: an unenforceable rule must not
    // become an outage caused by a missing reference row.
    expect(summary.blocking).toBe(false);
  });

  it('a same-currency report needs no rate at all', async () => {
    await withOrg(orgId, (tx) =>
      policy.createPolicy(tx, { kind: 'PER_TRANSACTION_LIMIT', params: { thresholdMinor: 50000 } }),
    );
    const { reportId } = await draftIn('CAD', 60000);
    const summary = await withOrg(orgId, (tx) => policy.validateReport(tx, reportId));
    const finding = summary.violations.find((v) => v.rule_code === 'PER_TRANSACTION_LIMIT');
    expect(finding?.severity).toBe('WARNING');
    expect(finding?.data.fxRateMissing).toBeUndefined();
  });

  it('a per-rule currency overrides the tenant default', async () => {
    // Tenant policy currency is CAD; this rule is a USD 300.00 cap. A USD 400.00
    // line breaches it with no conversion needed, and no rate is loaded — which
    // also proves the override is what was used rather than the default.
    await withOrg(orgId, (tx) =>
      policy.createPolicy(tx, {
        kind: 'PER_TRANSACTION_LIMIT',
        currencyCode: 'USD',
        params: { thresholdMinor: 30000 },
      }),
    );
    const { reportId } = await draftIn('USD', 40000);
    const summary = await withOrg(orgId, (tx) => policy.validateReport(tx, reportId));
    const finding = summary.violations.find((v) => v.rule_code === 'PER_TRANSACTION_LIMIT');
    expect(finding?.severity).toBe('WARNING');
    expect(finding?.data.thresholdCurrency).toBe('USD');
    expect(finding?.data.fxRateMissing).toBeUndefined();
  });

  it('uses the reciprocal when only the reverse pair is stored', async () => {
    // PE-7's shape: a Bank-of-Canada-style source gives USD->CAD only, and the
    // tenant's policy currency is USD. Every CAD amount is unconvertible in
    // ExpenseOS; here the inverse is derived.
    await setRate('USD', 'CAD', '1.35000000');
    await admin.query("UPDATE organization SET policy_currency_code = 'USD' WHERE id = $1", [orgId]);
    await withOrg(orgId, (tx) =>
      policy.createPolicy(tx, { kind: 'PER_TRANSACTION_LIMIT', params: { thresholdMinor: 30000 } }),
    );
    // CAD 500.00 -> about USD 370.37, over a USD 300.00 cap.
    const { reportId } = await draftIn('CAD', 50000);
    const summary = await withOrg(orgId, (tx) => policy.validateReport(tx, reportId));
    const finding = summary.violations.find((v) => v.rule_code === 'PER_TRANSACTION_LIMIT');
    expect(finding?.severity).toBe('WARNING');
    expect(finding?.data.rateBasis).toBe('RECIPROCAL');
  });

  it('a receipt rule with NO amount still blocks when no rate exists', async () => {
    // The rule that must not degrade. "Every expense needs a receipt" is about
    // presence, not about an amount, so a missing rate has nothing to do with it —
    // and a BLOCK that a missing reference row can turn into a note is not a
    // control. This is checked before any conversion happens in `rules.ts`.
    await withOrg(orgId, (tx) =>
      policy.createPolicy(tx, { kind: 'RECEIPT_REQUIRED', severity: 'BLOCK', params: {} }),
    );
    const { reportId } = await draftIn('USD', 40000);
    const summary = await withOrg(orgId, (tx) => policy.validateReport(tx, reportId));
    const finding = summary.violations.find((v) => v.rule_code === 'RECEIPT_REQUIRED');
    expect(finding?.severity).toBe('BLOCK');
    expect(summary.blocking).toBe(true);
  });

  it('reports which report currencies cannot be enforced', async () => {
    // What the admin screen warns with, before the INFO findings start arriving.
    await draftIn('USD', 1000);
    const info = await withOrg(orgId, (tx) => policy.getPolicyCurrency(tx));
    expect(info.code).toBe('CAD');
    expect(info.unconvertible).toContain('USD');
    await setRate('USD', 'CAD', '1.35000000');
    const after = await withOrg(orgId, (tx) => policy.getPolicyCurrency(tx));
    expect(after.unconvertible).toEqual([]);
    expect(after.convertible).toEqual(['USD->CAD']);
  });

  // ── PE-8 ──────────────────────────────────────────────────────────────────
  //
  // Both currency readers used to end in `?? 'CAD'`. The column is
  // `NOT NULL DEFAULT 'CAD' REFERENCES currency(code)`, so that looked like dead
  // defence — but the query keys on `current_setting('app.current_org', true)`,
  // and with no tenant that matched nothing and the fallback answered CAD.
  // Policy would then have been evaluated against a currency nobody chose,
  // which is PE-1's family, and a scheduled job is exactly the caller that
  // arrives this way (MT-5 / VX0-8).
  //
  // THERE ARE TWO no-context shapes, and the first version of this fix only
  // handled one of them. `set_config(k, v, is_local => true)` leaves the GUC
  // defined as the EMPTY STRING once the transaction ends, not undefined — so a
  // pooled connection reads NULL only until it has served its first `withOrg`,
  // and `''` for the rest of its life. A bare `::uuid` answers CAD in the first
  // shape and raises `22P02 invalid input syntax for type uuid: ""` in the
  // second. Both are asserted below, and the second is asserted explicitly
  // rather than left to whichever connection the pool hands out, because a test
  // that reproduces the defect only sometimes is a test that reports it only
  // sometimes.
  it('REFUSES rather than assuming a currency when there is no tenant context', async () => {
    await expect(withoutOrg((tx) => policy.getPolicyCurrency(tx))).rejects.toMatchObject({
      code: 'NO_TENANT',
    });
  });

  it('refuses the same way on a pooled connection whose org setting is empty, not unset', async () => {
    await expect(
      withoutOrg(async (tx) => {
        // Exactly what the connection looks like after any earlier `withOrg`.
        await tx.query("SELECT set_config('app.current_org', '', true)");
        return policy.getPolicyCurrency(tx);
      }),
    ).rejects.toMatchObject({ code: 'NO_TENANT' });
  });

  it('refuses to SET a policy currency with no tenant, rather than updating nothing', async () => {
    // The write half. `organization` always has the row when there is a tenant,
    // so nought rows means the WHERE named nobody, and a write that quietly
    // changes nothing is the worse half of the same bug.
    await expect(
      withoutOrg(async (tx) => {
        await tx.query("SELECT set_config('app.current_org', '', true)");
        return policy.setPolicyCurrency(tx, 'USD');
      }),
    ).rejects.toMatchObject({ code: 'NO_TENANT' });
  });

  it('and reads the TENANT\'s currency when there is one, not a default', async () => {
    // The other half, so the refusal above cannot be satisfied by a reader that
    // simply always throws.
    await withOrg(orgId, (tx) => policy.setPolicyCurrency(tx, 'USD'));
    const info = await withOrg(orgId, (tx) => policy.getPolicyCurrency(tx));
    expect(info.code).toBe('USD');
    await withOrg(orgId, (tx) => policy.setPolicyCurrency(tx, 'CAD'));
  });
});
