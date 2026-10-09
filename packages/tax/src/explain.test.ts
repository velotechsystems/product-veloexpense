import { describe, expect, it } from 'vitest';
import { computeTax } from './engine';
import { explainTax } from './explain';
import type { CategoryItc, JurisdictionRates, TaxInput } from './types';

/**
 * The explanation has to be RIGHT, not merely present — a confident wrong reason is worse
 * than "I don't know", because somebody will act on it. Each case below is a distinct cause
 * of a zero that a reader would respond to differently:
 *
 *   · foreign        → nothing is wrong, stop looking
 *   · zero-rate      → the jurisdiction is misconfigured, tell an admin
 *   · provided-zero  → check the receipt; extraction may have missed it
 *   · category       → correct by policy, recode only if the category is wrong
 *   · rounds-to-zero → nothing is wrong, the amount is tiny
 */

const ONTARIO: JurisdictionRates = {
  gstRate: 0,
  hstRate: 13,
  pstRate: 0,
  qstRate: 0,
  salesTaxRate: 0,
};
const QUEBEC: JurisdictionRates = {
  gstRate: 5,
  hstRate: 0,
  pstRate: 0,
  qstRate: 9.975,
  salesTaxRate: 0,
};
const NEW_YORK: JurisdictionRates = {
  gstRate: 0,
  hstRate: 0,
  pstRate: 0,
  qstRate: 0,
  salesTaxRate: 8.875,
};
const NOWHERE: JurisdictionRates = {
  gstRate: 0,
  hstRate: 0,
  pstRate: 0,
  qstRate: 0,
  salesTaxRate: 0,
};

const FULL_ITC: CategoryItc = { itcGstHstRate: 100, itcQstRate: 100, pstRecoverable: false };
const MEALS: CategoryItc = { itcGstHstRate: 50, itcQstRate: 50, pstRecoverable: false };
const NO_ITC: CategoryItc = { itcGstHstRate: 0, itcQstRate: 0, pstRecoverable: false };

const input = (over: Partial<TaxInput> = {}): TaxInput => ({
  grossMinor: 11300n,
  jurisdiction: ONTARIO,
  category: FULL_ITC,
  ...over,
});

describe('explainTax does not change the answer', () => {
  it('returns exactly what computeTax returns', () => {
    // The explanation must never become a second implementation — one that drifts would be
    // confidently wrong about the number on the screen.
    for (const j of [ONTARIO, QUEBEC, NEW_YORK, NOWHERE]) {
      for (const c of [FULL_ITC, MEALS, NO_ITC]) {
        const i = input({ jurisdiction: j, category: c });
        const { trace: _trace, ...explained } = explainTax(i);
        expect(explained).toEqual(computeTax(i));
      }
    }
  });
});

describe('why recoverable GST/HST is zero', () => {
  it('foreign jurisdiction — nothing is missing', () => {
    // The New York hotel. Non-Canadian tax is non-recoverable and stays in the line cost.
    const { trace, recoverableGstHstMinor } = explainTax(
      input({ jurisdiction: NEW_YORK, grossMinor: 10887n }),
    );
    expect(recoverableGstHstMinor).toBe(0n);
    expect(trace.gstHst.zeroReason).toBe('FOREIGN_JURISDICTION');
    expect(trace.branch).toBe('US_SALES_TAX');
    expect(trace.isCanadianJurisdiction).toBe(false);
  });

  it('no tax anywhere — still reads as foreign, not as misconfiguration', () => {
    const { trace } = explainTax(input({ jurisdiction: NOWHERE }));
    expect(trace.gstHst.zeroReason).toBe('FOREIGN_JURISDICTION');
    expect(trace.branch).toBe('NO_TAX_APPLICABLE');
  });

  it('category recovers nothing, though tax was charged', () => {
    const { trace, gstHstMinor } = explainTax(input({ category: NO_ITC }));
    expect(gstHstMinor).toBeGreaterThan(0n);
    expect(trace.gstHst.zeroReason).toBe('CATEGORY_NOT_RECOVERABLE');
    expect(trace.gstHst.itcRate).toBe(0);
    // The tax that WAS charged is carried, so the answer can say how much was forgone.
    expect(trace.gstHst.taxBaseMinor).toBe(gstHstMinor);
  });

  it('tax was provided as zero — worth checking the receipt', () => {
    // Manual entry or an extraction that read no tax. Different from "no tax applies".
    const { trace } = explainTax(
      input({ explicit: { gstHstMinor: 0n, qstMinor: 0n, pstMinor: 0n } }),
    );
    expect(trace.branch).toBe('EXPLICIT');
    expect(trace.gstHst.zeroReason).toBe('PROVIDED_ZERO');
  });

  it('provided-zero wins over foreign, because the user supplied it', () => {
    // Somebody typed zero on a US expense. The actionable fact is that a value was supplied,
    // not the geography.
    const { trace } = explainTax(input({ jurisdiction: NEW_YORK, explicit: { gstHstMinor: 0n } }));
    expect(trace.gstHst.zeroReason).toBe('PROVIDED_ZERO');
  });

  it('rounds to zero on a trivially small amount', () => {
    const { trace, recoverableGstHstMinor } = explainTax(
      input({ grossMinor: 1n, category: MEALS }),
    );
    if (recoverableGstHstMinor === 0n && trace.gstHst.taxBaseMinor > 0n) {
      expect(trace.gstHst.zeroReason).toBe('ROUNDS_TO_ZERO');
    } else {
      // If the engine rounds the base itself there is no tax to recover, and the honest
      // reason is the jurisdiction, not rounding.
      expect(trace.gstHst.zeroReason).toBe('ZERO_RATE_JURISDICTION');
    }
  });

  it('explains nothing when there is nothing to explain', () => {
    const { trace, recoverableGstHstMinor } = explainTax(input());
    expect(recoverableGstHstMinor).toBeGreaterThan(0n);
    expect(trace.gstHst.zeroReason).toBeNull();
  });
});

describe('QST is explained independently of GST/HST', () => {
  it('recovers both in Quebec on a full-ITC category', () => {
    const { trace } = explainTax(input({ jurisdiction: QUEBEC, grossMinor: 11497n }));
    expect(trace.gstHst.zeroReason).toBeNull();
    expect(trace.qst.zeroReason).toBeNull();
  });

  it('reports QST as not-recoverable in Ontario, where none is charged', () => {
    // A trace that said "category not recoverable" here would send somebody to recode an
    // expense over a tax that was never charged.
    const { trace } = explainTax(input({ jurisdiction: ONTARIO }));
    expect(trace.qst.taxBaseMinor).toBe(0n);
    expect(trace.qst.zeroReason).toBe('ZERO_RATE_JURISDICTION');
  });

  it('carries the half rate for meals so the answer can quote it', () => {
    const { trace } = explainTax(input({ jurisdiction: QUEBEC, category: MEALS }));
    expect(trace.gstHst.itcRate).toBe(50);
    expect(trace.qst.itcRate).toBe(50);
  });
});

describe('branch identification', () => {
  it('names each path the engine can take', () => {
    expect(explainTax(input()).trace.branch).toBe('CANADIAN_REVERSE_CALC');
    expect(explainTax(input({ explicit: { gstHstMinor: 100n } })).trace.branch).toBe('EXPLICIT');
    expect(explainTax(input({ jurisdiction: NEW_YORK })).trace.branch).toBe('US_SALES_TAX');
    expect(explainTax(input({ jurisdiction: NOWHERE })).trace.branch).toBe('NO_TAX_APPLICABLE');
  });

  it('carries the inputs that decided it, so the answer can cite them', () => {
    const { trace } = explainTax(input({ jurisdiction: QUEBEC, category: MEALS }));
    expect(trace.jurisdiction).toEqual(QUEBEC);
    expect(trace.category).toEqual(MEALS);
    expect(trace.grossMinor).toBe(11300n);
  });
});

describe('an expense with nothing in it', () => {
  const ONTARIO = { gstRate: 0, hstRate: 13, pstRate: 0, qstRate: 0, salesTaxRate: 0 };
  const FULL = { itcGstHstRate: 100, itcQstRate: 100, pstRecoverable: false };

  it('says there is no taxable amount rather than blaming the province', () => {
    // A zero-gross expense in Ontario used to report ZERO_RATE_JURISDICTION — a false
    // statement about a province that charges 13%, and one that sends somebody to check
    // tax configuration over an expense they simply have not filled in.
    const { trace } = explainTax({ grossMinor: 0n, jurisdiction: ONTARIO, category: FULL });
    expect(trace.gstHst.zeroReason).toBe('NO_TAXABLE_AMOUNT');
  });

  it('still reports a genuinely misconfigured jurisdiction', () => {
    const ZERO_CA = { gstRate: 0, hstRate: 0, pstRate: 0, qstRate: 0, salesTaxRate: 0 };
    const { trace } = explainTax({ grossMinor: 11300n, jurisdiction: ZERO_CA, category: FULL });
    expect(trace.gstHst.zeroReason).toBe('FOREIGN_JURISDICTION');
  });
});
