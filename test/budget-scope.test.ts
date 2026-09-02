/**
 * VX4-5 part 2 — the pure half: budget attribution and the severity clamp.
 *
 * No database. `lib/budgets/scope.ts` and the severity helpers in
 * `lib/policy/rules.ts` are pure by the same house rule that keeps `rules.ts` and
 * `rates.ts` pure, and this is what that buys.
 *
 * The last two blocks are GUARDS in the house pattern — generated over the
 * registry rather than written per rule, so a rule kind added next year cannot
 * quietly opt out of them.
 */
import { describe, it, expect } from 'vitest';
import {
  hasUnconvertible,
  projectedMinor,
  resolveBudget,
  type BudgetScope,
  type BudgetSnapshot,
} from '@/lib/budgets/scope';
import {
  clampSeverity,
  severityExceeds,
  DEFAULT_POLICIES,
  RULE_DEFINITIONS,
  RULE_KINDS,
  SEVERITIES,
} from '@/lib/policy/rules';

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

/* ── the clamp, as arithmetic over SEVERITIES ───────────────────────────────── */

describe('severity clamping is an index comparison, not a hand-written order', () => {
  it('ranks by position in SEVERITIES', () => {
    expect(severityExceeds('BLOCK', 'WARNING')).toBe(true);
    expect(severityExceeds('WARNING', 'WARNING')).toBe(false);
    expect(severityExceeds('INFO', 'WARNING')).toBe(false);
  });

  it('holds a severity down to the maximum', () => {
    expect(clampSeverity('BLOCK', 'WARNING')).toBe('WARNING');
    expect(clampSeverity('INFO', 'WARNING')).toBe('INFO');
  });

  it('leaves a rule with no maximum alone', () => {
    for (const s of SEVERITIES) expect(clampSeverity(s, undefined)).toBe(s);
  });
});

/* ── guards, generated over the registry ────────────────────────────────────── */

describe('every rule definition is internally consistent (guard)', () => {
  it.each(RULE_KINDS)('%s default severity is within its own maximum', (kind) => {
    const definition = RULE_DEFINITIONS[kind];
    if (definition.maxSeverity === undefined) return;
    // A default the write path would refuse is a rule nobody can create from the
    // "Add a rule" form without changing the severity first.
    expect(severityExceeds(definition.defaultSeverity, definition.maxSeverity)).toBe(false);
  });

  it('at least one rule declares a maximum, or this file proves nothing', () => {
    // The guard above passes vacuously if no rule has a maximum — an assertion
    // that can only produce one outcome. This is the check that it cannot.
    expect(RULE_KINDS.some((k) => RULE_DEFINITIONS[k].maxSeverity !== undefined)).toBe(true);
  });
});

describe('the starter set respects the maximums (guard)', () => {
  it.each(DEFAULT_POLICIES)('$kind at $severity is creatable', (preset) => {
    const maximum = RULE_DEFINITIONS[preset.kind].maxSeverity;
    if (maximum === undefined) return;
    // "Restore starter rules" writes these straight to SQL, bypassing
    // `createPolicy` and therefore bypassing its refusal.
    expect(severityExceeds(preset.severity, maximum)).toBe(false);
  });
});
