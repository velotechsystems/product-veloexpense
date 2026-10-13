/**
 * VX4-5 part 2 — the pure half: budget attribution.
 *
 * No database. `lib/budgets/scope.ts` is pure, and this is what that buys. (The severity
 * clamp this file also covered went with VeloExpense's v1 policy engine at w4-02d.)
 */
import { describe, it, expect } from 'vitest';
import {
  hasUnconvertible,
  projectedMinor,
  resolveBudget,
  type BudgetScope,
  type BudgetSnapshot,
} from '@/lib/budgets/scope';

const ACC = 'acc-1';
const BU = 'bu-1';
const DEPT = 'dept-1';

const scope = (over: Partial<BudgetScope>): BudgetScope => ({
  id: 'b',
  glAccountId: ACC,
  businessUnitId: null,
  departmentId: null,
  currencyCode: 'CAD',
  ...over,
});

describe('resolveBudget — most specific wins, and only one wins', () => {
  const exact = scope({ id: 'exact', businessUnitId: BU, departmentId: DEPT });
  const byUnit = scope({ id: 'by-unit', businessUnitId: BU });
  const byDept = scope({ id: 'by-dept', departmentId: DEPT });
  const company = scope({ id: 'company' });
  const all = [company, byDept, byUnit, exact];

  it('prefers the exact (unit, department) match', () => {
    expect(resolveBudget(all, ACC, BU, DEPT)?.id).toBe('exact');
  });

  it('falls back to the business-unit budget when there is no exact match', () => {
    expect(resolveBudget([company, byDept, byUnit], ACC, BU, DEPT)?.id).toBe('by-unit');
  });

  it('prefers business unit over department, which is their tie-break and ours', () => {
    // BU is the coarser and more reliably populated dimension, so preferring it
    // keeps attribution stable as departments come and go.
    expect(resolveBudget([byDept, byUnit], ACC, BU, DEPT)?.id).toBe('by-unit');
  });

  it('falls back to the department budget when the report has no business unit', () => {
    expect(resolveBudget([company, byDept, byUnit], ACC, null, DEPT)?.id).toBe('by-dept');
  });

  it('falls back to the company-wide budget last', () => {
    expect(resolveBudget(all, ACC, 'other-bu', 'other-dept')?.id).toBe('company');
  });

  it('answers null for an account nobody budgeted — the normal case', () => {
    expect(resolveBudget(all, 'acc-2', BU, DEPT)).toBeNull();
  });

  it('answers null for a line with no account at all', () => {
    expect(resolveBudget(all, null, BU, DEPT)).toBeNull();
  });

  it('returns ONE budget, never every match — the double-count this prevents', () => {
    // The whole reason this is not a filter. If spend counted against both the
    // department budget and the company-wide budget for the same account, the
    // company total would drift upward by however many department budgets exist,
    // and both numbers would look plausible on their own.
    const picked = resolveBudget(all, ACC, BU, DEPT);
    expect(picked).not.toBeNull();
    expect([picked!.id]).toHaveLength(1);
    expect(picked!.id).not.toBe('company');
  });
});

/* ── the snapshot's arithmetic ──────────────────────────────────────────────── */

const snapshot = (over: Partial<BudgetSnapshot> = {}): BudgetSnapshot => ({
  budgetId: 'b',
  budgetName: 'Travel',
  periodId: 'p',
  startsOn: '2026-09-01',
  endsOn: '2026-09-30',
  currencyCode: 'CAD',
  minorUnit: 2,
  amountMinor: 100000n,
  actualMinor: 0n,
  pendingMinor: 0n,
  unconvertibleMinor: 0n,
  reportMinor: 0n,
  reportMissingRateFrom: [],
  ...over,
});

describe('the projection counts what is committed AND what is in flight', () => {
  it('sums approved, submitted and this report', () => {
    expect(
      projectedMinor(snapshot({ actualMinor: 1000n, pendingMinor: 2000n, reportMinor: 300n })),
    ).toBe(3300n);
  });

  it('does NOT fold unconvertible spend into the projection', () => {
    // AN-7 inverted. An amount with no rate is counted nowhere else precisely so
    // it cannot masquerade as a converted one.
    expect(projectedMinor(snapshot({ actualMinor: 1000n, unconvertibleMinor: 999n }))).toBe(1000n);
  });

  it('reports unconvertible spend from either side — the period or this report', () => {
    expect(hasUnconvertible(snapshot())).toBe(false);
    expect(hasUnconvertible(snapshot({ unconvertibleMinor: 1n }))).toBe(true);
    expect(hasUnconvertible(snapshot({ reportMissingRateFrom: ['USD'] }))).toBe(true);
  });
});

// w4-02d: the severity-clamp and starter-set guards tested VeloExpense's v1 rule registry
// (lib/policy/rules.ts), which went with that engine at the cutover. ExpenseOS's kinds carry
// no severity ceiling; `BUDGET_OVERAGE` is WARNING by default and an admin chooses.
