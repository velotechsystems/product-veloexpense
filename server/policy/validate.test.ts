// Ported from ExpenseOS `apps/web/src/server/policy/validate.test.ts` (550b2945), w4-02d (d63). Each adaptation is
// marked "VeloExpense:". Its travel case was left out then and restored by w6-01.
/* eslint-disable @typescript-eslint/no-explicit-any -- VeloExpense: ExpenseOS's suite casts its db double and reads the rule context untyped (`as any`); Biome allows it there. */
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The orchestrator the tRPC layer calls, and the only place that turns a stored report
 * into the violation list the submit gate reads.
 *
 * The rules themselves are covered in `builtinKinds.test.ts` and `engine.v2.test.ts`;
 * what happens HERE is the loading, the projections, and the write — and each of those
 * has a way of being quietly wrong that no rule test would catch:
 *
 *   · **Mileage is converted to km before the rules see it.** The MILEAGE_MAX threshold
 *     is a km figure. A line recorded in miles compared raw under-triggers by ~38%,
 *     which is a rule that silently stops applying to half the fleet.
 *   · **The FX map keeps the newest rate per pair.** The query is ordered newest-first
 *     and the first row per pair wins; reversing that compares today's spend against
 *     last quarter's rate.
 *   · **A prior justification survives a re-validate.** A violation's identity is
 *     (lineItemId, ruleCode). Wiping the resolve fields on every save would make a
 *     submitter re-explain an exception every time they touched an unrelated line.
 *   · **Budget markers are cleared BEFORE the crossings fire.** A period that fell back
 *     under every threshold has to be re-armed first, or a correction followed by a
 *     fresh overage stays silent.
 */

/*
 * VeloExpense: the loader's VeloExpense differences, each marked below. The budget
 * impacts come from VeloExpense's budgets (./budgetBridge, d66) with no module check and
 * no alert markers, so ExpenseOS's two marker cases and its module case are not carried;
 * there are no system flags, so the per-diem cases with the flag on and the fiscal-close
 * case read as ExpenseOS's defaults; and the policy currency is the organization's.
 */

const h = vi.hoisted(() => ({
  ranWith: null as Record<string, unknown> | null,
  violations: [] as Array<Record<string, unknown>>,
  facts: null as Record<string, unknown> | null,
  budgetEval: { impacts: ['impact'], underThreshold: ['under'] } as Record<string, unknown>,
  order: [] as string[],
  cleared: [] as unknown[],
  fired: [] as unknown[],
}));

vi.mock('./engine', () => ({
  runRules: (ctx: Record<string, unknown>) => {
    h.ranWith = ctx;
    return h.violations;
  },
}));
vi.mock('./facts', () => ({
  buildFacts: (input: Record<string, unknown>) => {
    h.facts = input;
    return { line: [], report: {} };
  },
}));
// VeloExpense: the budget impacts come from VeloExpense's budgets (d66).
vi.mock('./budgetBridge', () => ({
  budgetImpactsFor: async () => {
    h.order.push('bridge');
    return (h.budgetEval as { impacts: unknown[] }).impacts;
  },
}));
vi.mock('@expenseos/expense-lines', () => ({ tipMinorOf: () => 0 }));

import { validateReport } from './validate';

// ── A report, and a database that returns it ──────────────────────────────────

const lineItem = (over: Record<string, unknown> = {}) => ({
  id: 'li-1',
  amountMinor: 5000n,
  kind: 'STANDARD',
  payload: null,
  mileageDistance: null,
  mileageUnit: null,
  category: {
    id: 'cat-1',
    code: 'MEALS',
    label: { en: 'Meals' },
    isMileage: false,
    requiresAttendees: false,
    active: true,
  },
  ...over,
});

const expense = (over: Record<string, unknown> = {}) => ({
  id: 'exp-1',
  date: new Date('2026-07-01T00:00:00Z'),
  // VeloExpense: what an undated draft expense is judged as of.
  createdAt: new Date('2026-06-30T12:00:00Z'),
  placeText: 'Toronto',
  merchant: 'Canoe',
  explanation: null,
  purpose: 'Client dinner',
  currency: { code: 'CAD' },
  receipts: [{ id: 'r-1' }],
  _count: { attendees: 2 },
  lineItems: [lineItem()],
  ...over,
});

const report = (over: Record<string, unknown> = {}) => ({
  id: 'rep-1',
  submittedAt: null,
  totalMinor: 5000n,
  currency: { code: 'CAD' },
  travelRequest: null,
  // VeloExpense: the home currency is the legal entity's; no locale on the person.
  submitter: {
    id: 'u-1',
    entity: { homeCurrency: { code: 'USD' } },
    jobLevelId: 'jl-1',
    departmentId: 'dep-1',
    legalEntityId: 'le-1',
    businessUnitId: 'bu-1',
    roleId: 'role-1',
  },
  expenses: [expense()],
  ...over,
});

type DbOver = {
  report?: unknown;
  policies?: unknown[];
  fx?: Array<{ base: string; quote: string; rate: { toString(): string } }>;
  /** VeloExpense: the organization's policy currency; `null` for no organization row. */
  policyCurrency?: string | null;
  rules?: Array<Record<string, unknown>>;
  perDiemRates?: unknown[];
  currencies?: Array<{ id: string; code: string }>;
  prior?: Array<Record<string, unknown>>;
};

/** Everything the loader touches, and a record of what it wrote. */
function makeDb(over: DbOver = {}) {
  const written: Array<{ op: string; arg: unknown }> = [];
  // VeloExpense: one object. The loader runs inside the request's transaction, so the
  // reads, the lock and the swap all go to the same client; `$queryRaw` answers both the
  // policy-currency read and the per-report row lock, told apart by their SQL.
  const db = {
    $queryRaw: async (sql: TemplateStringsArray) => {
      if (sql.join('').includes('FOR UPDATE')) {
        written.push({ op: 'lock', arg: null });
        return [{ id: 'rep-1' }];
      }
      const code = 'policyCurrency' in over ? over.policyCurrency : 'CAD';
      return code === null ? [] : [{ code }];
    },
    policyViolation: {
      findMany: async () => over.prior ?? [],
      deleteMany: async (arg: unknown) => {
        written.push({ op: 'delete', arg });
      },
      createMany: async (arg: unknown) => {
        written.push({ op: 'create', arg });
      },
    },
    expenseReport: { findUnique: async () => ('report' in over ? over.report : report()) },
    expensePolicy: { findMany: async () => over.policies ?? [] },
    fxRate: { findMany: async () => over.fx ?? [] },
    policyRule: { findMany: async () => over.rules ?? [] },
    perDiemRate: { findMany: async () => over.perDiemRates ?? [] },
    currency: { findMany: async () => over.currencies ?? [] },
  };
  return { db, written };
}

const run = async (over: DbOver = {}) => {
  const { db, written } = makeDb(over);
  // `as any` twice: the double implements only the slice of PrismaClient this function
  // touches, and the rule context is read back field by field.
  const result = await validateReport({ db: db as any, reportId: 'rep-1', t: (k) => k });
  return { result, written, ctx: h.ranWith as Record<string, any> };
};

beforeEach(() => {
  h.ranWith = null;
  h.facts = null;
  h.violations = [];
  h.order = [];
  h.cleared = [];
  h.fired = [];
  h.budgetEval = { impacts: ['impact'], underThreshold: ['under'] };
});

describe('a report that is not there', () => {
  it('throws naming the id, rather than validating an empty report as clean', async () => {
    /**
     * Returning `{violations: [], counts: 0}` would read to the submit gate as "this
     * report has no policy problems" — which is the answer that lets it through.
     */
    await expect(run({ report: null })).rejects.toThrow('policy.validate: report rep-1 not found');
  });
});

describe('what the rules are handed', () => {
  it('flattens the submitter’s currency to a code, not a row', async () => {
    const { ctx } = await run();
    expect(ctx.report.submitter.homeCurrency).toBe('USD');
  });

  it('leaves a submitter with no home currency as null', async () => {
    // VeloExpense: no legal entity, or an entity with no currency.
    const { ctx } = await run({
      report: report({ submitter: { ...report().submitter, entity: null } }),
    });
    expect(ctx.report.submitter.homeCurrency).toBeNull();
  });

  it('reads travel as approved only when the linked request actually is', async () => {
    /** A pre-approval rule asks whether the spend was authorised in advance — merely
     *  HAVING a request is not that. */
    const approved = await run({ report: report({ travelRequest: { status: 'APPROVED' } }) });
    expect(approved.ctx.report.travelApproved).toBe(true);
    const submitted = await run({ report: report({ travelRequest: { status: 'SUBMITTED' } }) });
    expect(submitted.ctx.report.travelApproved).toBe(false);
    const none = await run();
    expect(none.ctx.report.travelApproved).toBe(false);
  });

  it('judges an undated draft expense as of when it was entered (VeloExpense)', async () => {
    // A null date would crash the date facts; the expense's creation time is the honest
    // stand-in until the claimant fills it in.
    const { ctx } = await run({ report: report({ expenses: [expense({ date: null })] }) });
    expect(ctx.report.lineItems[0].date).toEqual(new Date('2026-06-30T12:00:00Z'));
  });

  it('tells CATEGORY_ACTIVE whether each line’s category is still in use (VeloExpense)', async () => {
    const retired = { ...lineItem().category, active: false };
    const { ctx } = await run({
      report: report({ expenses: [expense({ lineItems: [lineItem({ category: retired })] })] }),
    });
    expect(ctx.report.lineItems[0].category.active).toBe(false);
  });

  it('carries the parent expense’s facts down onto each line', async () => {
    /** Date, merchant, receipts and purpose live on the Expense; the rules are written
     *  against lines, so a line that lost them would evaluate as if the expense had
     *  none — no receipt, no purpose, no date. */
    const { ctx } = await run();
    expect(ctx.report.lineItems[0]).toMatchObject({
      merchant: 'Canoe',
      purpose: 'Client dinner',
      attendeeCount: 2,
    });
    expect(ctx.report.lineItems[0].receipts).toHaveLength(1);
  });

  it('treats a purpose of only spaces as no purpose at all', async () => {
    /** AUDIT_THRESHOLD asks for a business purpose; three spaces is not one, and it is
     *  exactly what a required field collects from somebody tabbing through. */
    const { ctx } = await run({
      report: report({ expenses: [expense({ purpose: '   ' })] }),
    });
    expect(ctx.report.lineItems[0].purpose).toBeNull();
  });

  it('converts a mileage line recorded in miles into kilometres', async () => {
    /**
     * MILEAGE_MAX is a km threshold. Comparing 100 miles as 100 km under-triggers by
     * ~38% — a rule that silently stops applying to anybody whose profile is in miles.
     */
    const { ctx } = await run({
      report: report({
        expenses: [expense({ lineItems: [lineItem({ mileageDistance: 100, mileageUnit: 'MI' })] })],
      }),
    });
    expect(ctx.report.lineItems[0].mileageKm).toBe('160.93');
  });

  it('leaves a kilometre line alone', async () => {
    const { ctx } = await run({
      report: report({
        expenses: [expense({ lineItems: [lineItem({ mileageDistance: 250, mileageUnit: 'KM' })] })],
      }),
    });
    expect(ctx.report.lineItems[0].mileageKm).toBe('250');
  });

  it('leaves a non-mileage line with no distance', async () => {
    const { ctx } = await run();
    expect(ctx.report.lineItems[0].mileageKm).toBeNull();
  });

  it('falls back to the localized label for a category with no code', async () => {
    /** `code` is a real column now, but a category an admin created by hand has none —
     *  and a rule keyed on the code would otherwise match nothing for it. */
    const { ctx } = await run({
      report: report({
        expenses: [
          expense({
            lineItems: [
              lineItem({
                category: {
                  id: 'cat-2',
                  code: null,
                  label: { 'fr-CA': 'Hébergement' },
                  isMileage: false,
                  requiresAttendees: false,
                },
              }),
            ],
          }),
        ],
      }),
    });
    // No `en` key, so any value stands in rather than exporting an empty code.
    expect(ctx.report.lineItems[0].category.code).toBe('Hébergement');
  });
});

describe('the reference data it loads', () => {
  it('keeps the newest rate for a pair and ignores the older ones', async () => {
    /** The query is ordered newest-first; the first row per pair wins. Reversing that
     *  compares today's spend against last quarter's rate. */
    const { ctx } = await run({
      fx: [
        { base: 'USD', quote: 'CAD', rate: { toString: () => '1.37' } },
        { base: 'USD', quote: 'CAD', rate: { toString: () => '1.21' } },
        { base: 'EUR', quote: 'CAD', rate: { toString: () => '1.48' } },
      ],
    });
    expect(ctx.fxRates.get('USD->CAD')).toBe('1.37');
    expect(ctx.fxRates.get('EUR->CAD')).toBe('1.48');
  });

  it('defaults the policy currency to CAD when no flag is set', async () => {
    // VeloExpense: no organization row to read it from.
    const { ctx } = await run({ policyCurrency: null });
    expect(ctx.policyCurrency).toBe('CAD');
  });

  it('honours a policy currency that is set', async () => {
    // VeloExpense: the organization's `policy_currency_code`.
    const { ctx } = await run({ policyCurrency: 'USD' });
    expect(ctx.policyCurrency).toBe('USD');
  });

  it('treats per-diem as off unless the flag says otherwise', async () => {
    const { ctx } = await run();
    expect(ctx.perDiemEnabled).toBe(false);
    expect(ctx.perDiem).toBeNull();
  });

  it('reads a fiscal close date, and null when there is none', async () => {
    // VeloExpense: no setting for one yet, so always none (ExpenseOS's unset default).
    const without = await run();
    expect(without.ctx.fiscalCloseDate).toBeNull();
  });
});

describe('per-diem inputs', () => {
  const rate = { city: 'Toronto', categoryId: 'cat-1', amountMinor: 7500n, currencyId: 'CAD' };

  it('is not loaded at all while the feature is off', async () => {
    /** The rate query is per-tier and joins four scopes; a deployment not using per-diem
     *  should not pay for it on every validate. */
    const { ctx } = await run({ perDiemRates: [rate] });
    expect(ctx.perDiem).toBeNull();
  });

  // VeloExpense: ExpenseOS's two cases with the `perDiemEnabled` flag ON are not carried —
  // there is no such setting here yet, so the feature is always off (its default).
});

describe('budget impacts', () => {
  const budgetRule = {
    id: 'r-1',
    kindCode: 'BUDGET_OVERAGE',
    scope: 'REPORT',
    severity: 'WARNING',
    condition: null,
    params: {},
    messageKey: 'policy.budget',
    categoryId: null,
  };

  it('are not calculated without a rule that would use them', async () => {
    /** The scan is the expensive part of this loader. */
    const { ctx } = await run();
    expect(ctx.budgetImpacts).toBeNull();
    expect(h.order).toEqual([]);
  });

  // VeloExpense: ExpenseOS's "not calculated when the finance module is not installed" and
  // "clears the markers BEFORE firing the crossings" are not carried — the bridge checks no
  // module (a tenant with no budgets has no periods) and sets no alert markers.

  it('are calculated when the rule is there', async () => {
    const { ctx } = await run({ rules: [budgetRule] });
    expect(ctx.budgetImpacts).toEqual(['impact']);
    expect(h.order).toEqual(['bridge']);
  });
});

describe('replacing the violation set', () => {
  const violation = (over: Record<string, unknown> = {}) => ({
    lineItemId: 'li-1',
    ruleCode: 'RECEIPT_REQUIRED',
    severity: 'WARNING',
    message: 'A receipt is required',
    data: null,
    ...over,
  });

  const created = (written: Array<{ op: string; arg: unknown }>) =>
    (written.find((w) => w.op === 'create')?.arg as { data: Record<string, unknown>[] })?.data ??
    [];

  // VeloExpense: in the request's one transaction, which the loader runs inside.
  it('locks the report row, then deletes the prior set and writes the new one, in one transaction', async () => {
    /** The lock has to come FIRST: anything read before it is read unprotected, and the
     *  prior-set read is what decides which justifications are carried forward. */
    h.violations = [violation()];
    const { written } = await run();
    expect(written.map((w) => w.op)).toEqual(['lock', 'delete', 'create']);
  });

  it('writes nothing when a report comes back clean', async () => {
    /** `createMany` with an empty array is a round trip for no reason. */
    h.violations = [];
    const { written } = await run();
    expect(written.map((w) => w.op)).toEqual(['lock', 'delete']);
  });

  it('anchors a line-scoped violation to its parent expense', async () => {
    /** So the register can name the expense and the FE can navigate to it. */
    h.violations = [violation()];
    const { written } = await run();
    expect(created(written)[0]).toMatchObject({ lineItemId: 'li-1', expenseId: 'exp-1' });
  });

  it('leaves a report-scoped violation with no expense', async () => {
    h.violations = [violation({ lineItemId: null, ruleCode: 'AUDIT_THRESHOLD' })];
    const { written } = await run();
    expect(created(written)[0]).toMatchObject({ lineItemId: null, expenseId: null });
  });

  it('carries a prior justification onto the matching new row', async () => {
    /**
     * A violation's identity is (lineItemId, ruleCode). Wiping the resolve fields on
     * every save would make a submitter re-explain an exception every time they touched
     * an unrelated line.
     */
    const resolvedAt = new Date('2026-07-02T00:00:00Z');
    h.violations = [violation()];
    const { written } = await run({
      prior: [
        {
          lineItemId: 'li-1',
          ruleCode: 'RECEIPT_REQUIRED',
          resolveNote: 'Taxi gave no receipt',
          resolvedAt,
          resolvedBy: 'u-1',
        },
      ],
    });
    expect(created(written)[0]).toMatchObject({
      resolveNote: 'Taxi gave no receipt',
      resolvedAt,
      resolvedBy: 'u-1',
    });
  });

  it('does not carry forward a prior row that was never resolved', async () => {
    h.violations = [violation()];
    const { written } = await run({
      prior: [
        {
          lineItemId: 'li-1',
          ruleCode: 'RECEIPT_REQUIRED',
          resolveNote: null,
          resolvedAt: null,
          resolvedBy: null,
        },
      ],
    });
    expect(created(written)[0]).toMatchObject({ resolveNote: null, resolvedAt: null });
  });

  it('lets the expense’s explanation stand in as the justification', async () => {
    /** The "Explain this charge" field is the lightweight path: one note covers every
     *  WARNING on that expense rather than one comment per exception. */
    h.violations = [violation()];
    const { written } = await run({
      report: report({ expenses: [expense({ explanation: 'Client would not itemise' })] }),
    });
    expect(created(written)[0]).toMatchObject({
      resolveNote: 'Client would not itemise',
      resolvedBy: 'u-1',
    });
  });

  it('ignores an explanation of only whitespace', async () => {
    h.violations = [violation()];
    const { written } = await run({
      report: report({ expenses: [expense({ explanation: '   ' })] }),
    });
    expect(created(written)[0]).toMatchObject({ resolveNote: null });
  });

  it('does not let an explanation justify a BLOCK', async () => {
    /** A block is a refusal, not an exception somebody may explain past. */
    h.violations = [violation({ severity: 'BLOCK' })];
    const { written } = await run({
      report: report({ expenses: [expense({ explanation: 'we had to' })] }),
    });
    expect(created(written)[0]).toMatchObject({ resolveNote: null });
  });

  it('prefers an explicit prior exception over the expense explanation', async () => {
    const resolvedAt = new Date('2026-07-02T00:00:00Z');
    h.violations = [violation()];
    const { written } = await run({
      report: report({ expenses: [expense({ explanation: 'generic note' })] }),
      prior: [
        {
          lineItemId: 'li-1',
          ruleCode: 'RECEIPT_REQUIRED',
          resolveNote: 'the specific one',
          resolvedAt,
          resolvedBy: 'u-9',
        },
      ],
    });
    expect(created(written)[0]).toMatchObject({ resolveNote: 'the specific one' });
  });
});

describe('the tally the submit gate reads', () => {
  const v = (severity: string, over: Record<string, unknown> = {}) => ({
    lineItemId: 'li-1',
    ruleCode: `RULE_${severity}`,
    severity,
    message: severity,
    data: null,
    ...over,
  });

  it('counts each severity separately', async () => {
    h.violations = [v('INFO'), v('WARNING'), v('BLOCK'), v('BLOCK', { ruleCode: 'B2' })];
    const { result } = await run();
    expect(result.counts).toMatchObject({ info: 1, warning: 1, block: 2 });
  });

  it('counts a warning nobody has explained as unjustified', async () => {
    h.violations = [v('WARNING')];
    const { result } = await run();
    expect(result.counts.unjustifiedWarning).toBe(1);
  });

  it('stops counting it once the expense carries an explanation', async () => {
    /** This is the number the submit gate blocks on, so it is the one that decides
     *  whether the report can leave the submitter's hands. */
    h.violations = [v('WARNING')];
    const { result } = await run({
      report: report({ expenses: [expense({ explanation: 'Taxi gave no receipt' })] }),
    });
    expect(result.counts.unjustifiedWarning).toBe(0);
  });

  it('stops counting it once a prior exception was resolved', async () => {
    h.violations = [v('WARNING')];
    const { result } = await run({
      prior: [
        {
          lineItemId: 'li-1',
          ruleCode: 'RULE_WARNING',
          resolveNote: 'noted',
          resolvedAt: new Date('2026-07-02T00:00:00Z'),
          resolvedBy: 'u-1',
        },
      ],
    });
    expect(result.counts.unjustifiedWarning).toBe(0);
  });

  it('never counts a BLOCK as a justifiable warning', async () => {
    h.violations = [v('BLOCK')];
    const { result } = await run({
      report: report({ expenses: [expense({ explanation: 'we had to' })] }),
    });
    expect(result.counts).toMatchObject({ block: 1, unjustifiedWarning: 0, warning: 0 });
  });

  it('returns the violations it wrote, for the caller to render inline', async () => {
    h.violations = [v('WARNING')];
    const { result } = await run();
    expect(result.violations).toHaveLength(1);
  });
});
