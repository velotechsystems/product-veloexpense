// Ported from ExpenseOS `apps/web/src/server/policy/builtinKinds.test.ts` (550b2945), w4-02a (d63). Each adaptation is
// marked "VeloExpense:"; travel, which is out of VeloExpense's scope, is the main one.
// @vitest-environment node
import type { ExpensePolicy } from '@expenseos/db';
import { describe, expect, it } from 'vitest';
import { type PolicyContext, runRules } from './engine';
import { buildFacts } from './facts';
import type { HydratedReport, PolicyRuleInstance, Severity } from './types';

// VeloExpense: ExpenseOS's three uuid fixtures (UUID_USER, UUID_LEVEL, UUID_OTHER_LEVEL)
// sit here for REQUIRES_APPROVED_TRAVEL's exemptions; that kind is travel and not carried.

/** Behavioral parity tests for the built-in kinds migrated from the legacy
 *  hardcoded rules (R1–R12). Each seeded instance is modelled here; we run the
 *  real orchestrator and assert the ported behavior (severity + anchor + message
 *  key + data), which is what the legacy functions produced. */

const INST: Record<string, PolicyRuleInstance> = {
  PER_TXN_LIMIT: mkInst('i-txn', 'PER_TXN_LIMIT', 'WARNING', 'perTransactionLimit'),
  RUNNING_LIMIT: mkInst('i-run', 'RUNNING_LIMIT', 'WARNING', 'dailyLimit'),
  RECEIPT_REQUIRED: mkInst('i-rcpt', 'RECEIPT_REQUIRED', 'BLOCK', 'receiptMissing'),
  FUTURE_DATED: mkInst('i-fut', 'FUTURE_DATED', 'WARNING', 'futureDated'),
  DUPLICATE: mkInst('i-dup', 'DUPLICATE', 'WARNING', 'duplicate'),
  CURRENCY_MISMATCH: mkInst('i-cur', 'CURRENCY_MISMATCH', 'INFO', 'currencyMismatch'),
  FISCAL_CLOSE: mkInst('i-fis', 'FISCAL_CLOSE', 'BLOCK', 'fiscalClose'),
};

/** MILEAGE_MAX carries params, so it needs a per-test instance. */
function mileageInst(params: {
  maxKmPerEntry?: number;
  maxKmPerMonth?: number;
}): PolicyRuleInstance {
  return { ...mkInst('i-mil', 'MILEAGE_MAX', 'WARNING', 'mileageMaxPerEntry'), params };
}

function mkInst(
  id: string,
  kindCode: string,
  severity: Severity,
  messageKey: string,
): PolicyRuleInstance {
  return {
    id,
    kindCode,
    scope: 'AGGREGATE',
    severity,
    condition: null,
    params: {},
    messageKey,
    categoryId: null,
  };
}

function policy(over: Partial<ExpensePolicy> & { categoryId: string }): ExpensePolicy {
  return {
    receiptRequired: false,
    approvalRequired: false,
    perTransactionLimitMinor: null,
    dailyLimitMinor: null,
    monthlyLimitMinor: null,
    annualLimitMinor: null,
    notes: null,
    ...over,
  } as ExpensePolicy;
}

type LineIn = {
  id: string;
  amountMinor: bigint;
  categoryId?: string;
  categoryCode?: string;
  /** A distance-based category — the receipt rules skip these. */
  isMileage?: boolean;
  currency?: string;
  merchant?: string | null;
  date?: Date;
  receipts?: number;
  /** Decimal string, as the hydrated line carries it. */
  mileageKm?: string | null;
  /** Voluntary tip INSIDE amountMinor; the pre-tip base is the difference. */
  tipMinor?: bigint;
  /** Parent expense's business purpose (trimmed, null when blank). */
  purpose?: string | null;
  /** Attendees recorded on the parent expense. */
  attendeeCount?: number;
  /** Meal / entertainment category — the only kind that needs attendees. */
  requiresAttendees?: boolean;
};

function run(opts: {
  lines: LineIn[];
  instances: PolicyRuleInstance[];
  policies?: ExpensePolicy[];
  policyCurrency?: string;
  fxRates?: Map<string, string>;
  fiscalCloseDate?: Date | null;
  homeCurrency?: string | null;
  jobLevelId?: string | null;
  submitterId?: string;
}) {
  const lineItems: HydratedReport['lineItems'] = opts.lines.map((l) => ({
    id: l.id,
    date: l.date ?? new Date('2026-07-01T00:00:00Z'),
    amountMinor: l.amountMinor,
    merchant: l.merchant ?? null,
    category: {
      id: l.categoryId ?? 'cat-A',
      code: l.categoryCode ?? 'MEALS',
      isMileage: l.isMileage ?? false,
      requiresAttendees: l.requiresAttendees ?? false,
    },
    currency: { code: l.currency ?? 'USD' },
    receipts: Array.from({ length: l.receipts ?? 0 }, (_, i) => ({ id: `r${l.id}-${i}` })),
    mileageKm: l.mileageKm ?? null,
    tipMinor: l.tipMinor ?? 0n,
    purpose: l.purpose ?? null,
    attendeeCount: l.attendeeCount ?? 0,
  }));
  const report: HydratedReport = {
    id: 'rep1',
    submittedAt: null,
    submitter: {
      id: opts.submitterId ?? 'u1',
      homeCurrency: opts.homeCurrency ?? 'USD',
      localePref: 'en',
      jobLevelId: opts.jobLevelId ?? null,
    },
    lineItems,
  };
  const ctx: PolicyContext = {
    report,
    policiesByCategoryId: new Map((opts.policies ?? []).map((p) => [p.categoryId, p])),
    policyCurrency: opts.policyCurrency ?? 'USD',
    fxRates: opts.fxRates ?? new Map(),
    fiscalCloseDate: opts.fiscalCloseDate ?? null,
    perDiemEnabled: false,
    budgetImpacts: null,
    perDiem: null,
    rules: opts.instances,
    facts: buildFacts({
      now: new Date('2026-07-01T00:00:00Z'),
      reportTotalMinor: 0n,
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
  return runRules(ctx);
}

describe('PER_TXN_LIMIT (R1)', () => {
  const pol = [policy({ categoryId: 'cat-A', perTransactionLimitMinor: 10000n })];
  it('flags a line over its category limit (WARNING)', () => {
    const v = run({
      lines: [{ id: 'l1', amountMinor: 12000n }],
      instances: [INST.PER_TXN_LIMIT],
      policies: pol,
    });
    expect(v).toEqual([
      expect.objectContaining({
        ruleCode: 'i-txn',
        severity: 'WARNING',
        message: 'perTransactionLimit',
        lineItemId: 'l1',
      }),
    ]);
    expect(v[0].data).toMatchObject({ limitMinor: '10000', actualMinor: '12000' });
  });
  it('passes a line under the limit', () => {
    expect(
      run({
        lines: [{ id: 'l1', amountMinor: 9000n }],
        instances: [INST.PER_TXN_LIMIT],
        policies: pol,
      }),
    ).toEqual([]);
  });
  it('emits a degraded fxRateMissing INFO when the line cannot be converted', () => {
    const v = run({
      lines: [{ id: 'l1', amountMinor: 12000n, currency: 'EUR' }],
      instances: [INST.PER_TXN_LIMIT],
      policies: pol,
      policyCurrency: 'USD',
    });
    expect(v).toEqual([
      expect.objectContaining({
        ruleCode: 'i-txn',
        severity: 'INFO',
        message: 'fxRateMissing',
        lineItemId: 'l1',
      }),
    ]);
  });
});

describe('RUNNING_LIMIT (R2-4)', () => {
  it('flags the line that pushes a category’s daily total over the limit', () => {
    const v = run({
      lines: [
        { id: 'l1', amountMinor: 6000n },
        { id: 'l2', amountMinor: 6000n },
      ],
      instances: [INST.RUNNING_LIMIT],
      policies: [policy({ categoryId: 'cat-A', dailyLimitMinor: 10000n })],
    });
    // l1 (6000) under; l1+l2 (12000) crosses → l2 flagged, daily key.
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({
      ruleCode: 'i-run',
      severity: 'WARNING',
      message: 'dailyLimit',
      lineItemId: 'l2',
    });
  });
});

describe('RECEIPT_REQUIRED (R5)', () => {
  const pol = [policy({ categoryId: 'cat-A', receiptRequired: true })];
  it('BLOCKs a receiptless line when the category requires a receipt', () => {
    const v = run({
      lines: [{ id: 'l1', amountMinor: 5000n, receipts: 0 }],
      instances: [INST.RECEIPT_REQUIRED],
      policies: pol,
    });
    expect(v).toEqual([
      expect.objectContaining({
        ruleCode: 'i-rcpt',
        severity: 'BLOCK',
        message: 'receiptMissing',
        lineItemId: 'l1',
      }),
    ]);
  });
  it('passes when a receipt is attached', () => {
    expect(
      run({
        lines: [{ id: 'l1', amountMinor: 5000n, receipts: 1 }],
        instances: [INST.RECEIPT_REQUIRED],
        policies: pol,
      }),
    ).toEqual([]);
  });

  it('exempts a mileage line, which has no receipt to produce', () => {
    // Nobody is handed a document for driving their own car. The evidence is the
    // measured route and the rate, snapshotted onto the line. At BLOCK severity
    // this made a legitimate mileage claim unfileable rather than merely annoying.
    expect(
      run({
        lines: [{ id: 'l1', amountMinor: 5000n, receipts: 0, isMileage: true }],
        instances: [INST.RECEIPT_REQUIRED],
        policies: pol,
      }),
    ).toEqual([]);
  });

  it('still blocks a receiptless ORDINARY line on the same report', () => {
    // The exemption is per line, not per report — a mileage line must not
    // launder the meal beside it.
    const v = run({
      lines: [
        { id: 'mileage', amountMinor: 5000n, receipts: 0, isMileage: true },
        { id: 'meal', amountMinor: 5000n, receipts: 0 },
      ],
      instances: [INST.RECEIPT_REQUIRED],
      policies: pol,
    });
    expect(v.map((x) => x.lineItemId)).toEqual(['meal']);
  });
});

/** Both instances are the same kind; only the threshold and severity differ. */
function receiptThresholdInst(
  id: string,
  severity: Severity,
  messageKey: string,
  thresholdMinor: string,
): PolicyRuleInstance {
  return {
    ...mkInst(id, 'RECEIPT_THRESHOLD', severity, messageKey),
    params: { thresholdMinor },
  };
}
const WARN_25 = receiptThresholdInst('i-r25', 'WARNING', 'receiptThresholdWarn', '2500');
const BLOCK_50 = receiptThresholdInst('i-r50', 'BLOCK', 'receiptThresholdBlock', '5000');

describe('RECEIPT_THRESHOLD', () => {
  it('exempts mileage, however far somebody drove', () => {
    // This rule is category-INDEPENDENT, so before the exemption it could not be
    // turned off for mileage without turning it off for everything. A long drive
    // priced over the threshold raised a violation no action could ever satisfy.
    expect(
      run({
        lines: [{ id: 'l1', amountMinor: 90_000n, receipts: 0, isMileage: true }],
        instances: [WARN_25, BLOCK_50],
      }),
    ).toEqual([]);
  });

  it('reports only the BLOCK when a $60 line breaches both thresholds', () => {
    // Both instances genuinely fire — but they are one problem, and reporting two is worse than
    // cosmetic: the submit gate counts unjustified WARNINGs, so the submitter would be asked to
    // justify a warning about the very thing already blocking them, and justifying it would
    // change nothing.
    const v = run({
      lines: [{ id: 'l1', amountMinor: 6000n }],
      instances: [WARN_25, BLOCK_50],
    });
    expect(v).toEqual([
      expect.objectContaining({ severity: 'BLOCK', message: 'receiptThresholdBlock' }),
    ]);
  });

  it('keeps the BLOCK whichever order the instances are configured in', () => {
    const forward = run({
      lines: [{ id: 'l1', amountMinor: 6000n }],
      instances: [WARN_25, BLOCK_50],
    });
    const reversed = run({
      lines: [{ id: 'l1', amountMinor: 6000n }],
      instances: [BLOCK_50, WARN_25],
    });
    expect(forward.map((x) => x.severity)).toEqual(['BLOCK']);
    expect(reversed.map((x) => x.severity)).toEqual(['BLOCK']);
  });

  it('collapses per line item, not across the report', () => {
    // Two lines each breaching both thresholds is two problems, not one.
    const v = run({
      lines: [
        { id: 'l1', amountMinor: 6000n },
        { id: 'l2', amountMinor: 7000n },
      ],
      instances: [WARN_25, BLOCK_50],
    });
    expect(v.map((x) => [x.lineItemId, x.severity])).toEqual([
      ['l1', 'BLOCK'],
      ['l2', 'BLOCK'],
    ]);
  });

  it('warns but does not block between the two thresholds', () => {
    const v = run({ lines: [{ id: 'l1', amountMinor: 3000n }], instances: [WARN_25, BLOCK_50] });
    expect(v).toEqual([expect.objectContaining({ severity: 'WARNING', lineItemId: 'l1' })]);
  });

  it('fires exactly at the threshold — $25.00 is "over $25"', () => {
    expect(run({ lines: [{ id: 'l1', amountMinor: 2500n }], instances: [WARN_25] })).toHaveLength(
      1,
    );
    expect(run({ lines: [{ id: 'l1', amountMinor: 2499n }], instances: [WARN_25] })).toEqual([]);
  });

  it('says nothing about a line that already has a receipt', () => {
    expect(
      run({ lines: [{ id: 'l1', amountMinor: 9900n, receipts: 1 }], instances: [BLOCK_50] }),
    ).toEqual([]);
  });

  it('compares in the policy currency, not the line currency', () => {
    // €30 at 1.40 is $42 — over the $25 warning but under the $50 block.
    const fx = new Map([['EUR->USD', '1.40']]);
    const v = run({
      lines: [{ id: 'l1', amountMinor: 3000n, currency: 'EUR' }],
      instances: [WARN_25, BLOCK_50],
      fxRates: fx,
    });
    expect(v).toEqual([expect.objectContaining({ severity: 'WARNING' })]);
    expect(v[0].data).toMatchObject({ amountMinor: '4200', thresholdMinor: '2500' });
  });

  it('skips a line it cannot convert rather than guessing at its size', () => {
    expect(
      run({
        lines: [{ id: 'l1', amountMinor: 9900n, currency: 'EUR' }],
        instances: [BLOCK_50],
      }),
    ).toEqual([]);
  });
});

const TIP_20: PolicyRuleInstance = {
  ...mkInst('i-tip', 'TIP_PERCENTAGE', 'WARNING', 'tipPercentage'),
  params: { maxPercent: 20 },
};

describe('TIP_PERCENTAGE', () => {
  it('measures the tip against the PRE-TIP bill', () => {
    /**
     * The choice that decides whether this rule works at all. `amountMinor` INCLUDES
     * the tip, so a $22 tip on a $100 bill is a $122 line. Against the pre-tip base
     * that is 22% and breaches a 20% guideline, which is what the person who left it
     * and the reviewer checking it both mean by "a 22% tip". Against the line total
     * it is 18% and passes — so a 20% threshold would only catch tips above roughly
     * a quarter of the bill, and the rule would look broken to whoever set it.
     */
    const v = run({
      lines: [{ id: 'l1', amountMinor: 12_200n, tipMinor: 2_200n }],
      instances: [TIP_20],
    });
    expect(v).toEqual([expect.objectContaining({ severity: 'WARNING', message: 'tipPercentage' })]);
    expect(v[0]?.data).toMatchObject({ percent: '22.0', maxPercent: 20, baseMinor: '10000' });
  });

  it('passes a tip exactly on the guideline', () => {
    // $20 on $100. Over, not at — a policy that fires on its own stated limit reads
    // as off-by-one to the person who set it to 20.
    expect(
      run({ lines: [{ id: 'l1', amountMinor: 12_000n, tipMinor: 2_000n }], instances: [TIP_20] }),
    ).toEqual([]);
  });

  it('says nothing about a line with no tip', () => {
    // Not "0%, which passes": a per-line finding on every flight and taxi would bury
    // the one line that matters, on reports where nobody tipped at all.
    expect(
      run({
        lines: [
          { id: 'l1', amountMinor: 50_000n },
          { id: 'l2', amountMinor: 1_200n, tipMinor: 0n },
        ],
        instances: [TIP_20],
      }),
    ).toEqual([]);
  });

  it('ignores a tip with no bill behind it', () => {
    // A tip equal to (or exceeding) the line total is a data problem, not generosity.
    // Any percentage of nothing is meaningless and would render as ∞%.
    expect(
      run({ lines: [{ id: 'l1', amountMinor: 2_000n, tipMinor: 2_000n }], instances: [TIP_20] }),
    ).toEqual([]);
  });

  it('anchors the finding on the line, and names both figures', () => {
    const v = run({
      lines: [
        { id: 'l1', amountMinor: 11_000n, tipMinor: 1_000n },
        { id: 'l2', amountMinor: 13_500n, tipMinor: 3_500n },
      ],
      instances: [TIP_20],
    });
    // 10% passes, 35% does not.
    expect(v).toHaveLength(1);
    expect(v[0]?.lineItemId).toBe('l2');
    expect(v[0]?.data).toMatchObject({ percent: '35.0', currency: 'USD' });
  });

  it('does not need an FX rate', () => {
    // A ratio of two amounts in the SAME currency is already currency-free.
    // Converting both sides would only add the fx-missing failure mode.
    const v = run({
      lines: [{ id: 'l1', amountMinor: 12_200n, tipMinor: 2_200n, currency: 'JPY' }],
      instances: [TIP_20],
      policyCurrency: 'USD',
      fxRates: new Map(),
    });
    expect(v).toHaveLength(1);
    expect(v[0]?.data).toMatchObject({ currency: 'JPY' });
  });

  it('keeps cents on a large bill', () => {
    // Scaled integer maths then one divide: going through Number first loses cents,
    // and this is the size of bill where that starts to move the percentage.
    const v = run({
      lines: [{ id: 'l1', amountMinor: 1_234_567n + 259_259n, tipMinor: 259_259n }],
      instances: [TIP_20],
    });
    expect(v[0]?.data).toMatchObject({ baseMinor: '1234567', percent: '21.0' });
  });
});

describe('FUTURE_DATED (R9)', () => {
  it('flags a future-dated line (WARNING)', () => {
    const v = run({
      lines: [{ id: 'l1', amountMinor: 5000n, date: new Date(Date.now() + 7 * 864e5) }],
      instances: [INST.FUTURE_DATED],
    });
    expect(v).toEqual([
      expect.objectContaining({
        ruleCode: 'i-fut',
        severity: 'WARNING',
        message: 'futureDated',
        lineItemId: 'l1',
      }),
    ]);
  });
});

describe('DUPLICATE (R10)', () => {
  it('flags the second of two identical lines and links the first', () => {
    const d = new Date('2026-06-10T00:00:00Z');
    const v = run({
      lines: [
        { id: 'l1', amountMinor: 5000n, merchant: 'Adobe', date: d },
        { id: 'l2', amountMinor: 5000n, merchant: 'adobe', date: d },
      ],
      instances: [INST.DUPLICATE],
    });
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({
      ruleCode: 'i-dup',
      severity: 'WARNING',
      message: 'duplicate',
      lineItemId: 'l2',
    });
    expect(v[0].data).toMatchObject({ duplicateOfLineItemId: 'l1' });
  });
});

describe('CURRENCY_MISMATCH (R11)', () => {
  it('flags a line whose currency differs from the submitter home currency (INFO)', () => {
    const v = run({
      lines: [{ id: 'l1', amountMinor: 5000n, currency: 'EUR' }],
      instances: [INST.CURRENCY_MISMATCH],
      homeCurrency: 'USD',
    });
    expect(v).toEqual([
      expect.objectContaining({
        ruleCode: 'i-cur',
        severity: 'INFO',
        message: 'currencyMismatch',
        lineItemId: 'l1',
      }),
    ]);
  });
});

describe('FISCAL_CLOSE (R12)', () => {
  it('BLOCKs the whole report when a line is dated on/before the fiscal-close date', () => {
    const v = run({
      lines: [{ id: 'l1', amountMinor: 5000n, date: new Date('2026-05-01T00:00:00Z') }],
      instances: [INST.FISCAL_CLOSE],
      fiscalCloseDate: new Date('2026-06-30T00:00:00Z'),
    });
    expect(v).toEqual([
      expect.objectContaining({
        ruleCode: 'i-fis',
        severity: 'BLOCK',
        message: 'fiscalClose',
        lineItemId: null,
      }),
    ]);
  });
  it('no-op when there is no fiscal-close date', () => {
    expect(
      run({ lines: [{ id: 'l1', amountMinor: 5000n }], instances: [INST.FISCAL_CLOSE] }),
    ).toEqual([]);
  });
});

describe('MILEAGE_MAX (R7)', () => {
  const km = (id: string, mileageKm: string, date?: Date) => ({
    id,
    amountMinor: 5000n,
    mileageKm,
    ...(date ? { date } : {}),
  });

  it('warns on a single trip over the per-entry cap', () => {
    const v = run({ lines: [km('l1', '900')], instances: [mileageInst({ maxKmPerEntry: 500 })] });
    expect(v).toEqual([
      expect.objectContaining({
        severity: 'WARNING',
        message: 'mileageMaxPerEntry',
        lineItemId: 'l1',
      }),
    ]);
  });

  it('warns, never blocks — a long drive may be genuine', () => {
    // The rule exists to make an approver look, not to stop a submission.
    const v = run({ lines: [km('l1', '900')], instances: [mileageInst({ maxKmPerEntry: 500 })] });
    expect(v.every((x) => x.severity !== 'BLOCK')).toBe(true);
  });

  it('stays silent at or under the cap', () => {
    expect(
      run({ lines: [km('l1', '500')], instances: [mileageInst({ maxKmPerEntry: 500 })] }),
    ).toEqual([]);
  });

  it('sums a month across lines for the monthly cap', () => {
    const v = run({
      lines: [
        km('l1', '400', new Date('2026-07-02T00:00:00Z')),
        km('l2', '400', new Date('2026-07-20T00:00:00Z')),
      ],
      instances: [mileageInst({ maxKmPerMonth: 700 })],
    });
    expect(v).toHaveLength(1);
    expect(v[0]).toEqual(expect.objectContaining({ message: 'mileageMaxPerMonth' }));
  });

  it('buckets by calendar month, so a month boundary resets the total', () => {
    const v = run({
      lines: [
        km('l1', '400', new Date('2026-07-28T00:00:00Z')),
        km('l2', '400', new Date('2026-08-02T00:00:00Z')),
      ],
      instances: [mileageInst({ maxKmPerMonth: 700 })],
    });
    expect(v).toEqual([]);
  });

  it('ignores ordinary lines, so the rule is inert without mileage categories', () => {
    const v = run({
      lines: [{ id: 'l1', amountMinor: 900_00n }],
      instances: [mileageInst({ maxKmPerEntry: 1 })],
    });
    expect(v).toEqual([]);
  });

  it('does nothing when neither cap is configured', () => {
    // paramsSchema refuses an empty instance; the evaluator must not throw on
    // one that slipped through.
    const v = run({ lines: [km('l1', '900')], instances: [mileageInst({})] });
    expect(v).toEqual([]);
  });

  it('rounds the reported distance to one decimal', () => {
    const v = run({
      lines: [km('l1', '123.44'), km('l2', '123.46')],
      instances: [mileageInst({ maxKmPerEntry: 100 })],
    });
    // Raw floats would surface as 123.44000000000001 in the message values.
    for (const x of v) expect(String(x.message)).toBe('mileageMaxPerEntry');
    expect(v).toHaveLength(2);
  });
});

// VeloExpense: ExpenseOS's `describe('REQUIRES_APPROVED_TRAVEL')` (7 cases: fires without an
// approved trip, silent once approved, category scoping, and the job-level and named-user
// exemptions) is not carried with its kind — travel is out of VeloExpense's scope.


describe('AUDIT_THRESHOLD — documentation required on a large claim', () => {
  /**
   * Large claims are the ones an auditor pulls, and the two things they ask for are why
   * the money was spent and who it was spent on. The rule exists so that requirement
   * kicks in at a money threshold instead of taxing every $12 coffee.
   */
  const inst = (
    params: {
      thresholdMinor?: string;
      requirePurpose?: boolean;
      requireAttendees?: boolean;
    },
    severity: Severity = 'WARNING',
  ): PolicyRuleInstance => ({
    ...mkInst('i-audit', 'AUDIT_THRESHOLD', severity, 'auditThresholdPurpose'),
    params,
  });

  it('flags a line over the threshold with no business purpose', () => {
    const res = run({
      lines: [{ id: 'l1', amountMinor: 2500_00n, purpose: null }],
      instances: [inst({ thresholdMinor: '100000' })],
    });
    expect(res).toHaveLength(1);
    expect(res[0]).toMatchObject({
      lineItemId: 'l1',
      message: 'auditThresholdPurpose',
    });
    expect(res[0].data).toMatchObject({ missing: ['purpose'] });
  });

  it('leaves a line under the threshold alone', () => {
    // The whole point of a threshold: small claims are not worth the paperwork.
    const res = run({
      lines: [{ id: 'l1', amountMinor: 999_99n, purpose: null }],
      instances: [inst({ thresholdMinor: '100000' })],
    });
    expect(res).toEqual([]);
  });

  it('treats the threshold as inclusive', () => {
    // "over $1,000" in finance means "at or over" — an exact-threshold claim is
    // exactly the one somebody would structure a spend to hit.
    const res = run({
      lines: [{ id: 'l1', amountMinor: 100_000n, purpose: null }],
      instances: [inst({ thresholdMinor: '100000' })],
    });
    expect(res).toHaveLength(1);
  });

  it('is satisfied by a business purpose', () => {
    const res = run({
      lines: [{ id: 'l1', amountMinor: 2500_00n, purpose: 'Client kickoff, Acme migration' }],
      instances: [inst({ thresholdMinor: '100000' })],
    });
    expect(res).toEqual([]);
  });

  describe('attendees', () => {
    it('requires them on a category that says so', () => {
      const res = run({
        lines: [
          { id: 'l1', amountMinor: 2500_00n, purpose: 'Client dinner', requiresAttendees: true },
        ],
        instances: [inst({ thresholdMinor: '100000' })],
      });
      expect(res).toHaveLength(1);
      expect(res[0].message).toBe('auditThresholdAttendees');
      expect(res[0].data).toMatchObject({ missing: ['attendees'] });
    });

    it('does NOT require them on a category that does not', () => {
      /**
       * The mileage trap, in a different costume: a $2,000 flight has no attendees to
       * name, so demanding them would raise a violation no action by the claimant
       * could satisfy. Gating on `requiresAttendees` is what prevents that.
       */
      const res = run({
        lines: [
          { id: 'l1', amountMinor: 2500_00n, purpose: 'Onsite travel', requiresAttendees: false },
        ],
        instances: [inst({ thresholdMinor: '100000' })],
      });
      expect(res).toEqual([]);
    });

    it('is satisfied by at least one recorded attendee', () => {
      const res = run({
        lines: [
          {
            id: 'l1',
            amountMinor: 2500_00n,
            purpose: 'Client dinner',
            requiresAttendees: true,
            attendeeCount: 3,
          },
        ],
        instances: [inst({ thresholdMinor: '100000' })],
      });
      expect(res).toEqual([]);
    });
  });

  it('raises ONE finding when both are missing, naming both', () => {
    /**
     * The dedup trap, asserted directly. Violation identity is
     * `(ruleCode, lineItemId)` and `runRules` dedupes on it, so two findings for one
     * line would silently lose the second — the claimant would add a purpose,
     * resubmit, and be stopped again by a requirement they were never shown.
     */
    const res = run({
      lines: [{ id: 'l1', amountMinor: 2500_00n, purpose: null, requiresAttendees: true }],
      instances: [inst({ thresholdMinor: '100000' })],
    });
    expect(res).toHaveLength(1);
    expect(res[0].message).toBe('auditThresholdBoth');
    expect(res[0].data).toMatchObject({ missing: ['purpose', 'attendees'] });
  });

  it('can police purpose alone', () => {
    const res = run({
      lines: [{ id: 'l1', amountMinor: 2500_00n, purpose: null, requiresAttendees: true }],
      instances: [inst({ thresholdMinor: '100000', requireAttendees: false })],
    });
    expect(res).toHaveLength(1);
    expect(res[0].message).toBe('auditThresholdPurpose');
  });

  it('can police attendees alone', () => {
    const res = run({
      lines: [{ id: 'l1', amountMinor: 2500_00n, purpose: null, requiresAttendees: true }],
      instances: [inst({ thresholdMinor: '100000', requirePurpose: false })],
    });
    expect(res).toHaveLength(1);
    expect(res[0].message).toBe('auditThresholdAttendees');
  });

  it('does nothing when both switches are off', () => {
    const res = run({
      lines: [{ id: 'l1', amountMinor: 2500_00n, purpose: null, requiresAttendees: true }],
      instances: [
        inst({ thresholdMinor: '100000', requirePurpose: false, requireAttendees: false }),
      ],
    });
    expect(res).toEqual([]);
  });

  it('does nothing without a threshold param', () => {
    // A misconfigured instance must be inert, not block every report in the company.
    const res = run({
      lines: [{ id: 'l1', amountMinor: 2500_00n, purpose: null }],
      instances: [inst({})],
    });
    expect(res).toEqual([]);
  });

  it('compares in the policy currency, not the line currency', () => {
    // 2,000.00 EUR at 1.20 = 2,400.00 USD, which clears a 2,300.00 threshold —
    // whereas comparing the raw 2,000.00 against it would NOT.
    const res = run({
      lines: [{ id: 'l1', amountMinor: 2000_00n, currency: 'EUR', purpose: null }],
      instances: [inst({ thresholdMinor: '230000' })],
      policyCurrency: 'USD',
      fxRates: new Map([['EUR->USD', '1.20']]),
    });
    expect(res).toHaveLength(1);
    expect(res[0].data).toMatchObject({ policyCurrency: 'USD' });
  });

  it('skips a line it cannot convert rather than guessing', () => {
    // PER_TXN_LIMIT already raises `fxRateMissing`; inventing a rate here would
    // produce a violation whose number nobody can reproduce.
    const res = run({
      lines: [{ id: 'l1', amountMinor: 9000_00n, currency: 'JPY', purpose: null }],
      instances: [inst({ thresholdMinor: '100000' })],
      policyCurrency: 'USD',
      fxRates: new Map(),
    });
    expect(res).toEqual([]);
  });

  it('still skips an unconvertible line when the threshold is ZERO', () => {
    /**
     * The case that makes the null-conversion guard load-bearing, and the only one
     * that does.
     *
     * At any positive threshold, dropping the guard is invisible: `null < 100000n`
     * coerces null to 0 and the line is skipped anyway. At a threshold of `0` —
     * which the params schema permits and which reads as "every claim needs a
     * purpose" — `null < 0n` is false, so without the guard an unconvertible line
     * would be reported using an amount that was never computed.
     */
    const res = run({
      lines: [{ id: 'l1', amountMinor: 9000_00n, currency: 'JPY', purpose: null }],
      instances: [inst({ thresholdMinor: '0' })],
      policyCurrency: 'USD',
      fxRates: new Map(),
    });
    expect(res).toEqual([]);
  });

  it('applies to every claim when the threshold is zero and the line converts', () => {
    // The other half: a zero threshold is a legitimate configuration, not a
    // disabled rule, so it must still fire on a line it CAN convert.
    const res = run({
      lines: [{ id: 'l1', amountMinor: 1_00n, purpose: null }],
      instances: [inst({ thresholdMinor: '0' })],
    });
    expect(res).toHaveLength(1);
  });

  it('carries the instance severity, so finance can run warn-low and block-high', () => {
    const res = run({
      lines: [{ id: 'l1', amountMinor: 2500_00n, purpose: null }],
      instances: [inst({ thresholdMinor: '100000' }, 'BLOCK')],
    });
    expect(res[0].severity).toBe('BLOCK');
  });

  it('flags each offending line independently', () => {
    const res = run({
      lines: [
        { id: 'l1', amountMinor: 2500_00n, purpose: null },
        { id: 'l2', amountMinor: 2500_00n, purpose: 'Stated' },
        { id: 'l3', amountMinor: 2500_00n, purpose: null },
      ],
      instances: [inst({ thresholdMinor: '100000' })],
    });
    expect(res.map((v) => v.lineItemId).sort()).toEqual(['l1', 'l3']);
  });
});
