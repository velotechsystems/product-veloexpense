// Ported from ExpenseOS `apps/web/src/server/policy/engine.v2.test.ts` (550b2945), w4-02a (d63). Each adaptation is
// marked "VeloExpense:"; travel, which is out of VeloExpense's scope, is the main one.
// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { type PolicyContext, runRules } from './engine';
import { buildFacts } from './facts';
import type { PolicyRuleInstance } from './types';

/** A minimal PolicyContext with no LEGACY inputs (empty report → the built-in
 *  rules produce nothing), so we test the v2 instance loop + dedupe in isolation. */
function ctxWith(
  rules: PolicyRuleInstance[],
  lines: { lineItemId: string; categoryId: string; categoryCode: string; amountMinor: bigint }[],
): PolicyContext {
  const facts = buildFacts({
    now: new Date('2026-07-01'),
    reportTotalMinor: 0n,
    reportCurrencyCode: 'USD',
    submitter: {
      jobLevelId: null,
      departmentId: null,
      legalEntityId: null,
      businessUnitId: null,
      homeCurrency: 'USD',
    },
    lines: lines.map((l) => ({
      ...l,
      currencyCode: 'USD',
      merchant: null,
      date: new Date('2026-07-01'),
      hasReceipt: true,
    })),
  });
  return {
    report: {
      id: 'r1',
      submittedAt: null,
      submitter: { id: 'u1', homeCurrency: 'USD', localePref: 'en', jobLevelId: null },
      lineItems: [],
    },
    policiesByCategoryId: new Map(),
    policyCurrency: 'USD',
    fxRates: new Map(),
    fiscalCloseDate: null,
    perDiemEnabled: false,
    budgetImpacts: null,
    perDiem: null,
    rules,
    facts,
    t: (key) => key,
  };
}

const mealsOver75: PolicyRuleInstance = {
  id: 'rule-1',
  kindCode: 'PREDICATE_LINE',
  scope: 'LINE',
  severity: 'BLOCK',
  condition: {
    all: [
      { field: 'categoryCode', op: 'eq', value: 'MEALS' },
      { field: 'lineAmount', op: 'gt', value: 7500 },
    ],
  },
  params: {},
  messageKey: 'policy.generic',
  categoryId: null,
};

describe('runRules — v2 instance loop', () => {
  it('fires a LINE predicate rule on the matching line, anchored to it, with the instance severity', () => {
    const v = runRules(
      ctxWith(
        [mealsOver75],
        [
          {
            lineItemId: 'li-meal',
            categoryId: 'c-meals',
            categoryCode: 'MEALS',
            amountMinor: 9000n,
          },
          { lineItemId: 'li-cab', categoryId: 'c-taxi', categoryCode: 'TAXI', amountMinor: 9000n },
          {
            lineItemId: 'li-small',
            categoryId: 'c-meals',
            categoryCode: 'MEALS',
            amountMinor: 5000n,
          },
        ],
      ),
    );
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ ruleCode: 'rule-1', severity: 'BLOCK', lineItemId: 'li-meal' });
  });

  it('honors a LINE rule category scope', () => {
    const scoped: PolicyRuleInstance = { ...mealsOver75, id: 'rule-2', categoryId: 'c-other' };
    const v = runRules(
      ctxWith(
        [scoped],
        [
          {
            lineItemId: 'li-meal',
            categoryId: 'c-meals',
            categoryCode: 'MEALS',
            amountMinor: 9000n,
          },
        ],
      ),
    );
    expect(v).toHaveLength(0); // line's category != the rule's scoped category
  });

  it('dedupes duplicate (ruleCode, lineItemId) firings', () => {
    const v = runRules(
      ctxWith(
        [mealsOver75, mealsOver75], // same instance twice → collapse
        [
          {
            lineItemId: 'li-meal',
            categoryId: 'c-meals',
            categoryCode: 'MEALS',
            amountMinor: 9000n,
          },
        ],
      ),
    );
    expect(v).toHaveLength(1);
  });

  it('an unknown kind is skipped, not thrown', () => {
    const bogus: PolicyRuleInstance = { ...mealsOver75, id: 'x', kindCode: 'NOPE' };
    expect(runRules(ctxWith([bogus], []))).toEqual([]);
  });
});

// Per-diem migrated from built-in R8 to the PER_DIEM AGGREGATE kind driven by a
// seeded instance. These lock the flip: the kind fires (only) via its instance,
// self-gates on the flag, and inherits the instance's severity.
const perDiemInst: PolicyRuleInstance = {
  id: 'pd-1',
  kindCode: 'PER_DIEM',
  scope: 'AGGREGATE',
  severity: 'WARNING',
  condition: null,
  params: {},
  messageKey: 'perDiemRate',
  categoryId: null,
};

/** A ctx whose one expense ($300 on one NYC day) exceeds a $275 cap
 *  (lodging $200 + meals $75), for a $25 overage. */
function perDiemCtx(opts: { enabled: boolean; rules: PolicyRuleInstance[] }): PolicyContext {
  return {
    report: {
      id: 'r1',
      submittedAt: null,
      submitter: { id: 'u1', homeCurrency: 'USD', localePref: 'en', jobLevelId: null },
      lineItems: [],
    },
    policiesByCategoryId: new Map(),
    policyCurrency: 'USD',
    fxRates: new Map(),
    fiscalCloseDate: null,
    perDiemEnabled: opts.enabled,
    budgetImpacts: null,
    perDiem: {
      expenses: [
        {
          date: new Date('2026-07-01'),
          placeText: 'NYC',
          lineItems: [{ amountMinor: 30000n, categoryId: 'cat-meals' }],
        },
      ],
      reportCurrencyCode: 'USD',
      rates: [
        {
          city: 'NYC',
          categoryId: 'cat-meals',
          amountMinor: 27500n,
          firstLastDay: false,
          effectiveFrom: new Date('2024-01-01'),
          effectiveTo: null,
          jobLevelId: null,
          legalEntityId: null,
          businessUnitId: null,
          currencyId: 'cur-usd',
        },
      ],
      tier: { jobLevelId: null, legalEntityId: null, businessUnitId: null },
      rateCurrencyCodeById: new Map([['cur-usd', 'USD']]),
    },
    rules: opts.rules,
    facts: buildFacts({
      now: new Date('2026-07-01'),
      reportTotalMinor: 30000n,
      reportCurrencyCode: 'USD',
      submitter: {
        jobLevelId: null,
        departmentId: null,
        legalEntityId: null,
        businessUnitId: null,
        homeCurrency: 'USD',
      },
      lines: [],
    }),
    t: (key) => key,
  };
}

describe('runRules — PER_DIEM kind (migrated from R8)', () => {
  it('fires the seeded per-diem instance on an over-allowance report', () => {
    const v = runRules(perDiemCtx({ enabled: true, rules: [perDiemInst] }));
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ ruleCode: 'pd-1', severity: 'WARNING', lineItemId: null });
  });

  it('produces nothing when the per-diem flag is off', () => {
    expect(runRules(perDiemCtx({ enabled: false, rules: [perDiemInst] }))).toEqual([]);
  });

  it('produces nothing when no per-diem instance is seeded', () => {
    expect(runRules(perDiemCtx({ enabled: true, rules: [] }))).toEqual([]);
  });
});
