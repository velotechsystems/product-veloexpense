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
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { withOrg } from '@/lib/tenant/context';
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

beforeAll(async () => {
  await admin.query('TRUNCATE app_user, organization CASCADE');
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
