// Ported from ExpenseOS `apps/web/src/server/policy/budgetOverage.test.ts` (550b2945), w4-02a (d63). Each adaptation is
// marked "VeloExpense:"; travel, which is out of VeloExpense's scope, is the main one.
import { describe, expect, it } from 'vitest';
import { type PolicyContext, runRules } from './engine';
import { buildFacts } from './facts';
// VeloExpense: `BudgetImpact` from ./types (see there).
import type { BudgetImpact, HydratedReport, PolicyRuleInstance } from './types';

/**
 * The BUDGET_OVERAGE rule kind.
 *
 * It reads impacts the loader hydrated rather than querying, because a kind's
 * `evaluateAggregate` is synchronous and the budget scan is not. So the thing
 * worth pinning is what it does with those impacts: ONE warning carrying all of
 * them, never a BLOCK, and nothing at all when the loader found nothing —
 * including when the finance-reporting module is off, which reaches the kind as
 * `budgetImpacts: null` rather than as an empty array.
 *
 * The one-finding shape is not a simplification, it is forced: a violation's
 * identity is `(ruleCode, lineItemId)`, so `runRules`' own `dedupe` drops a
 * second report-level finding from the same instance. The first version of this
 * kind emitted one per (budget, month) and silently lost all but the first —
 * which is what the first test below now pins.
 */

const INSTANCE: PolicyRuleInstance = {
  id: 'rule-budget-1',
  kindCode: 'BUDGET_OVERAGE',
  scope: 'AGGREGATE',
  severity: 'WARNING',
  condition: null,
  params: {},
  messageKey: 'budgetOverage',
  categoryId: null,
};

const impact = (over: Partial<BudgetImpact> = {}): BudgetImpact => ({
  budgetId: 'b1',
  glAccountId: 'gl-travel',
  monthIndex: 5,
  amountMinor: 100_000n,
  usedMinor: 95_000n,
  crossedBp: 9000,
  currencyCode: 'CAD',
  ...over,
});

function run(budgetImpacts: readonly BudgetImpact[] | null) {
  const report: HydratedReport = {
    id: 'rep1',
    submittedAt: null,
    submitter: { id: 'u1', homeCurrency: 'CAD', localePref: 'en', jobLevelId: null },
    lineItems: [],
  };
  const ctx: PolicyContext = {
    report,
    policiesByCategoryId: new Map(),
    policyCurrency: 'CAD',
    fxRates: new Map(),
    fiscalCloseDate: null,
    perDiemEnabled: false,
    perDiem: null,
    budgetImpacts,
    rules: [INSTANCE],
    facts: buildFacts({
      now: new Date('2026-07-01T00:00:00Z'),
      reportTotalMinor: 0n,
      reportCurrencyCode: 'CAD',
      submitter: {
        jobLevelId: null,
        departmentId: null,
        legalEntityId: null,
        businessUnitId: null,
        homeCurrency: 'CAD',
      },
      lines: [],
    }),
    t: (key: string) => key,
  };
  return runRules(ctx);
}

describe('BUDGET_OVERAGE', () => {
  it('emits ONE violation that keeps every crossed budget-month', () => {
    // Emitting one finding per impact looks right and is not: `dedupe` keys on
    // (ruleCode, lineItemId), so the 2nd and 3rd would vanish without a trace
    // and the submitter would be told about one budget when three are over.
    const violations = run([
      impact({ budgetId: 'b1', monthIndex: 5 }),
      impact({ budgetId: 'b1', monthIndex: 6 }),
      impact({ budgetId: 'b2', monthIndex: 5, crossedBp: 10_000 }),
    ]);
    expect(violations).toHaveLength(1);
    const data = violations[0].data as { budgetCount: number; impacts: unknown[] };
    expect(data.budgetCount).toBe(3);
    expect(data.impacts).toHaveLength(3);
  });

  it('leads with the worst crossing', () => {
    // 100% is what somebody needs to act on; 50% is context.
    const violations = run([
      impact({ budgetId: 'b1', crossedBp: 5000 }),
      impact({ budgetId: 'b2', crossedBp: 10_000 }),
      impact({ budgetId: 'b3', crossedBp: 9000 }),
    ]);
    expect(violations[0].data).toMatchObject({ worstCrossedBp: 10_000 });
  });

  it('never blocks, whatever the overage', () => {
    // The money on a card has already left. An unsubmittable claim strands a
    // real expense, so over-budget spend routes to an approver instead.
    const violations = run([impact({ usedMinor: 900_000n, crossedBp: 10_000 })]);
    expect(violations).toHaveLength(1);
    expect(violations[0].severity).toBe('WARNING');
    expect(violations.some((v) => v.severity === 'BLOCK')).toBe(false);
  });

  it('says nothing when the loader found no impacts', () => {
    expect(run([])).toHaveLength(0);
  });

  it('says nothing when budgets are unavailable, rather than throwing', () => {
    // `null` is what the loader passes when the finance-reporting module is off
    // or no BUDGET_OVERAGE instance is enabled. A crash here would take the
    // whole submit path down with it.
    expect(run(null)).toHaveLength(0);
  });

  it('keeps each impact addressable in data', () => {
    // The warning sentence is one line; the drawer needs to say WHICH budget and
    // WHICH month, so the ids have to survive into the row.
    const violations = run([impact({ budgetId: 'b7', monthIndex: 11, crossedBp: 9000 })]);
    const data = violations[0].data as { impacts: Record<string, unknown>[] };
    expect(data.impacts[0]).toMatchObject({
      budgetId: 'b7',
      monthIndex: 11,
      crossedBp: 9000,
      currencyCode: 'CAD',
    });
  });

  it('is a report-level finding, not pinned to a line item', () => {
    // A budget is crossed by the report as a whole; blaming one line would be
    // arbitrary, and the workbench renders unpinned violations at report level.
    const violations = run([impact()]);
    expect(violations[0].lineItemId).toBeNull();
  });
});
