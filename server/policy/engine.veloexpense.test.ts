// @vitest-environment node
/**
 * VeloExpense's changes to ExpenseOS's engine at the cutover (w4-02d). Not a port: each case
 * covers a "VeloExpense:" adaptation in engine.ts / facts.ts / veloexpenseKinds.ts.
 *
 *   · PE-7 (d67): a line whose currency has no rate into the policy currency is NOT
 *     compared raw. A rule that compares its amount raises an INFO `fxRateMissing` for it,
 *     and a rule that does not compare amounts still runs.
 *   · f36: an AGGREGATE kind honours the instance's category scope, as LINE kinds do.
 *   · d70: CATEGORY_ACTIVE refuses a line on a deactivated category.
 */
import { describe, expect, it } from 'vitest';
import { type PolicyContext, runRules } from './engine';
import { buildFacts, type FactLine } from './facts';
import type { HydratedReport, PolicyRuleInstance } from './types';

type Line = HydratedReport['lineItems'][number];

const line = (over: Partial<Line> & { id: string }): Line => ({
  date: new Date('2026-07-01'),
  amountMinor: 10_000n,
  merchant: 'Cafe',
  category: { id: 'c-meals', code: 'MEALS', isMileage: false, requiresAttendees: false },
  currency: { code: 'CAD' },
  receipts: [],
  mileageKm: null,
  tipMinor: 0n,
  purpose: null,
  attendeeCount: 0,
  ...over,
});

function ctx(rules: PolicyRuleInstance[], lines: Line[], fxRates = new Map<string, string>()): PolicyContext {
  const factLines: FactLine[] = lines.map((l) => ({
    lineItemId: l.id,
    categoryId: l.category.id,
    categoryCode: l.category.code,
    amountMinor: l.amountMinor,
    currencyCode: l.currency.code,
    merchant: l.merchant,
    date: l.date,
    hasReceipt: l.receipts.length > 0,
  }));
  const total = lines.reduce((s, l) => s + l.amountMinor, 0n);
  return {
    report: {
      id: 'r1',
      submittedAt: null,
      submitter: { id: 'u1', homeCurrency: 'CAD', localePref: 'en', jobLevelId: null },
      lineItems: lines,
    },
    policiesByCategoryId: new Map(),
    policyCurrency: 'CAD',
    fxRates,
    fiscalCloseDate: null,
    perDiemEnabled: false,
    perDiem: null,
    budgetImpacts: null,
    rules,
    facts: buildFacts({
      now: new Date('2026-07-02'),
      reportTotalMinor: total,
      reportCurrencyCode: lines[0]?.currency.code ?? 'CAD',
      submitter: { jobLevelId: null, departmentId: null, legalEntityId: null, businessUnitId: null, homeCurrency: 'CAD' },
      lines: factLines,
      fxRates,
      policyCurrency: 'CAD',
    }),
    t: (key) => key,
  };
}

const rule = (over: Partial<PolicyRuleInstance>): PolicyRuleInstance => ({
  id: 'rule-1',
  kindCode: 'PREDICATE_LINE',
  scope: 'LINE',
  severity: 'WARNING',
  condition: { all: [{ field: 'lineAmount', op: 'gt', value: 5_000 }] },
  params: {},
  messageKey: 'perTransactionLimit',
  categoryId: null,
  ...over,
});

describe('PE-7: a missing FX rate is reported, never compared raw', () => {
  it('raises an INFO on the unconvertible line instead of judging its amount', () => {
    // ¥10,000 compared raw would read as $100.00 and trip a $50 limit; €40 would slip under.
    const v = runRules(
      ctx([rule({})], [line({ id: 'li-jpy', currency: { code: 'JPY' } }), line({ id: 'li-cad', amountMinor: 9_000n })]),
    );
    expect(v).toEqual([
      expect.objectContaining({ lineItemId: 'li-jpy', severity: 'INFO', message: 'fxRateMissing', data: { from: 'JPY', to: 'CAD' } }),
      expect.objectContaining({ lineItemId: 'li-cad', severity: 'WARNING', message: 'perTransactionLimit' }),
    ]);
  });

  it('judges the line normally once a rate links the currencies', () => {
    const rates = new Map([['USD->CAD', '1.40']]);
    const v = runRules(ctx([rule({})], [line({ id: 'li-usd', amountMinor: 4_000n, currency: { code: 'USD' } })], rates));
    // US$40.00 is CA$56.00, over the $50 limit.
    expect(v).toEqual([expect.objectContaining({ lineItemId: 'li-usd', severity: 'WARNING' })]);
  });

  it('still runs a rule that does not compare amounts', () => {
    const merchantRule = rule({ condition: { all: [{ field: 'merchant', op: 'eq', value: 'Cafe' }] } });
    const v = runRules(ctx([merchantRule], [line({ id: 'li-jpy', currency: { code: 'JPY' } })]));
    expect(v).toEqual([expect.objectContaining({ lineItemId: 'li-jpy', severity: 'WARNING' })]);
  });

  it('reports a report-level rule on the converted total as one INFO', () => {
    const totalRule = rule({
      kindCode: 'PREDICATE_REPORT',
      scope: 'REPORT',
      condition: { all: [{ field: 'reportTotal', op: 'gt', value: 1 }] },
    });
    const v = runRules(ctx([totalRule], [line({ id: 'li-jpy', currency: { code: 'JPY' } })]));
    expect(v).toEqual([expect.objectContaining({ lineItemId: null, severity: 'INFO', message: 'fxRateMissing' })]);
  });

  it('leaves the facts null rather than raw', () => {
    const c = ctx([], [line({ id: 'li-jpy', currency: { code: 'JPY' } })]);
    expect(c.facts.lines[0]).toMatchObject({ facts: { lineAmount: null }, fxGap: { from: 'JPY', to: 'CAD' } });
    expect(c.facts.report).toMatchObject({ reportTotal: null, maxLineAmount: null });
  });
});

describe('f36: an aggregate kind keeps to its category scope', () => {
  const receiptsForMeals = rule({
    kindCode: 'RECEIPT_THRESHOLD',
    scope: 'AGGREGATE',
    condition: null,
    params: { thresholdMinor: '2500' },
    messageKey: 'receiptThreshold',
    categoryId: 'c-meals',
  });

  it('fires on the scoped category only', () => {
    const taxi = { id: 'c-taxi', code: 'TAXI', isMileage: false, requiresAttendees: false };
    const v = runRules(ctx([receiptsForMeals], [line({ id: 'li-meal' }), line({ id: 'li-taxi', category: taxi })]));
    expect(v.map((x) => x.lineItemId)).toEqual(['li-meal']);
  });

  it('fires on every category when the rule is unscoped', () => {
    const taxi = { id: 'c-taxi', code: 'TAXI', isMileage: false, requiresAttendees: false };
    const v = runRules(
      ctx([{ ...receiptsForMeals, categoryId: null }], [line({ id: 'li-meal' }), line({ id: 'li-taxi', category: taxi })]),
    );
    expect(v.map((x) => x.lineItemId)).toEqual(['li-meal', 'li-taxi']);
  });
});

describe('d70: CATEGORY_ACTIVE', () => {
  const active = rule({ kindCode: 'CATEGORY_ACTIVE', scope: 'AGGREGATE', condition: null, severity: 'BLOCK', messageKey: 'categoryInactive' });

  it('blocks a line on a deactivated category, and only that line', () => {
    const retired = { id: 'c-old', code: 'OLD', isMileage: false, requiresAttendees: false, active: false };
    const v = runRules(ctx([active], [line({ id: 'li-old', category: retired }), line({ id: 'li-ok' })]));
    expect(v).toEqual([
      expect.objectContaining({ lineItemId: 'li-old', severity: 'BLOCK', message: 'categoryInactive', data: { categoryId: 'c-old', categoryCode: 'OLD' } }),
    ]);
  });
});

describe('BG-4: a budget never blocks', () => {
  it('holds a BUDGET_OVERAGE instance set to BLOCK down to WARNING', () => {
    const budget = rule({ kindCode: 'BUDGET_OVERAGE', scope: 'AGGREGATE', condition: null, severity: 'BLOCK', messageKey: 'budgetOverage' });
    const c = ctx([budget], [line({ id: 'li-1' })]);
    c.budgetImpacts = [
      { budgetId: 'b1', glAccountId: 'g1', monthIndex: 1, amountMinor: 1000n, usedMinor: 1800n, crossedBp: 10000, currencyCode: 'CAD' },
    ];
    expect(runRules(c)).toEqual([expect.objectContaining({ severity: 'WARNING', message: 'budgetOverage' })]);
  });

  it('leaves a kind with no ceiling alone', () => {
    const receipts = rule({ kindCode: 'RECEIPT_THRESHOLD', scope: 'AGGREGATE', condition: null, severity: 'BLOCK', params: { thresholdMinor: '0' } });
    expect(runRules(ctx([receipts], [line({ id: 'li-1' })]))).toEqual([expect.objectContaining({ severity: 'BLOCK' })]);
  });
});
