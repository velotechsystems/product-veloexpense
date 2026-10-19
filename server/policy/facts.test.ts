// Ported from ExpenseOS `apps/web/src/server/policy/facts.test.ts` (550b2945), w4-02a (d63). Each adaptation is
// marked "VeloExpense:". Its travel cases were left out then and restored by w6-01.
import { describe, expect, it } from 'vitest';
import { buildFacts, type FactSource } from './facts';

const SUBMITTER = {
  jobLevelId: null,
  departmentId: null,
  legalEntityId: null,
  businessUnitId: null,
  homeCurrency: null,
};

function line(amountMinor: bigint, currencyCode: string, id = 'l1') {
  return {
    lineItemId: id,
    categoryId: 'cat',
    categoryCode: 'MEALS',
    amountMinor,
    currencyCode,
    merchant: null,
    date: new Date('2026-07-01T00:00:00Z'),
    hasReceipt: true,
  };
}

const base = (over: Partial<FactSource>): FactSource => ({
  now: new Date('2026-07-01T00:00:00Z'),
  reportTotalMinor: 0n,
  reportCurrencyCode: 'CAD',
  submitter: SUBMITTER,
  lines: [],
  ...over,
});

describe('buildFacts amount facts', () => {
  it('leaves amounts as raw minor units when no fx map is supplied', () => {
    const f = buildFacts(base({ reportTotalMinor: 10000n, lines: [line(10000n, 'USD')] }));
    expect(f.lines[0].facts.lineAmount).toBe(10000);
    expect(f.report.reportTotal).toBe(10000);
  });

  it('converts line + report + max amounts into the policy currency', () => {
    const fxRates = new Map([['USD->CAD', '1.37']]);
    const f = buildFacts(
      base({
        reportCurrencyCode: 'USD',
        reportTotalMinor: 10000n, // 100.00 USD → 13700 CAD
        policyCurrency: 'CAD',
        fxRates,
        lines: [line(10000n, 'USD', 'l1'), line(5000n, 'CAD', 'l2')],
      }),
    );
    // USD line converts (10000 → 13700 CAD); CAD line stays 5000.
    expect(f.lines[0].facts.lineAmount).toBe(13700);
    expect(f.lines[1].facts.lineAmount).toBe(5000);
    // reportTotal (USD) → CAD; maxLineAmount is the max AFTER conversion (13700).
    expect(f.report.reportTotal).toBe(13700);
    expect(f.report.maxLineAmount).toBe(13700);
  });

  it('same-currency conversion is a no-op', () => {
    const f = buildFacts(
      base({
        reportTotalMinor: 9999n,
        policyCurrency: 'CAD',
        fxRates: new Map(),
        lines: [line(9999n, 'CAD')],
      }),
    );
    expect(f.lines[0].facts.lineAmount).toBe(9999);
    expect(f.report.reportTotal).toBe(9999);
  });
});

describe('travelApprovedTotal', () => {
  const base = {
    now: new Date('2026-09-10'),
    reportTotalMinor: 600_000n,
    reportCurrencyCode: 'CAD',
    submitter: {
      jobLevelId: null,
      departmentId: null,
      legalEntityId: null,
      businessUnitId: null,
      homeCurrency: 'CAD',
    },
    lines: [],
  };

  it('is ABSENT, not zero, when there is no approved travel request', () => {
    /**
     * Zero is a real approved figure — an approved request whose budget lines were all
     * removed — and `TRAVEL_OVERRUN` divides by it. The two must be distinguishable.
     */
    const f = buildFacts({ ...base, travelApproved: null }).report;
    expect('travelApprovedTotal' in f).toBe(false);
  });

  it('is present and zero when the approved figure genuinely is zero', () => {
    const f = buildFacts({
      ...base,
      travelApproved: { totalMinor: 0n, currencyCode: 'CAD' },
    }).report;
    expect(f.travelApprovedTotal).toBe(0);
  });

  it('converts the request’s OWN currency into the policy currency', () => {
    /**
     * A travel request is denominated independently of the report built from it, so
     * comparing the two raw would be comparing incommensurable minor units — a USD
     * estimate against a CAD claim reads as a 35% overrun that never happened.
     */
    const f = buildFacts({
      ...base,
      travelApproved: { totalMinor: 400_000n, currencyCode: 'USD' },
      fxRates: new Map([['USD->CAD', '1.35']]),
      policyCurrency: 'CAD',
    }).report;
    expect(f.travelApprovedTotal).toBe(540_000);
  });
});
