import { describe, expect, it } from 'vitest';
import { computeTax } from './engine';
import type { CategoryItc, JurisdictionRates } from './types';

const FULL_ITC: CategoryItc = { itcGstHstRate: 100, itcQstRate: 100, pstRecoverable: false };
const MEAL_ITC: CategoryItc = { itcGstHstRate: 50, itcQstRate: 50, pstRecoverable: false };

const J = (o: Partial<JurisdictionRates>): JurisdictionRates => ({
  gstRate: 0,
  hstRate: 0,
  pstRate: 0,
  qstRate: 0,
  salesTaxRate: 0,
  ...o,
});
const ON = J({ hstRate: 13 });
const QC = J({ gstRate: 5, qstRate: 9.975 });
const BC = J({ gstRate: 5, pstRate: 7 });
const AB = J({ gstRate: 5 });
const US_CA = J({ salesTaxRate: 7.25 });
const NONE = J({});

describe('computeTax — reverse-calc (CALCULATED)', () => {
  it('Ontario HST 13% backs out net + full ITC', () => {
    const r = computeTax({ grossMinor: 11300n, jurisdiction: ON, category: FULL_ITC });
    expect(r.source).toBe('CALCULATED');
    expect(r.preTaxMinor).toBe(10000n);
    expect(r.gstHstMinor).toBe(1300n);
    expect(r.qstMinor).toBe(0n);
    expect(r.recoverableGstHstMinor).toBe(1300n);
    expect(r.totalTaxMinor).toBe(1300n);
  });

  it('Ontario meal applies the 50% ITC limit', () => {
    const r = computeTax({ grossMinor: 11300n, jurisdiction: ON, category: MEAL_ITC });
    expect(r.gstHstMinor).toBe(1300n);
    expect(r.recoverableGstHstMinor).toBe(650n);
  });

  it('Quebec splits GST 5% + QST 9.975%', () => {
    const r = computeTax({ grossMinor: 11498n, jurisdiction: QC, category: FULL_ITC });
    expect(r.preTaxMinor).toBe(10000n);
    expect(r.gstHstMinor).toBe(500n);
    expect(r.qstMinor).toBe(998n);
    expect(r.recoverableQstMinor).toBe(998n);
  });

  it('Quebec meal: 50% on both GST/HST and QST', () => {
    const r = computeTax({ grossMinor: 11498n, jurisdiction: QC, category: MEAL_ITC });
    expect(r.recoverableGstHstMinor).toBe(250n);
    expect(r.recoverableQstMinor).toBe(499n);
  });

  it('BC tracks PST but never makes it recoverable', () => {
    const r = computeTax({ grossMinor: 11200n, jurisdiction: BC, category: FULL_ITC });
    expect(r.preTaxMinor).toBe(10000n);
    expect(r.gstHstMinor).toBe(500n);
    expect(r.pstMinor).toBe(700n);
    expect(r.recoverableGstHstMinor).toBe(500n);
    expect(r.recoverablePstMinor).toBe(0n);
  });

  it('Alberta GST-only 5%', () => {
    const r = computeTax({ grossMinor: 10500n, jurisdiction: AB, category: FULL_ITC });
    expect(r.preTaxMinor).toBe(10000n);
    expect(r.gstHstMinor).toBe(500n);
  });

  it('a US state charge is all cost — nothing is split out', () => {
    /**
     * The whole gross is the expense. Non-Canadian tax is never captured: it stays inside
     * the line and nobody reclaims it.
     *
     * This test used to assert the opposite — `preTaxMinor` 10000 and `salesTaxMinor` 725,
     * reverse-calced from California's 7.25%. Those two figures were real arithmetic and
     * went nowhere: `salesTaxMinor` had no column, no API field and no reader outside the
     * engine, and `preTaxMinor` is not persisted at all. The test pinned a computation
     * whose only consumer was itself, and read as though US tax were being handled.
     *
     * `US_CA` keeps its 7.25% rate, and that still matters — `explain.ts` reads it to
     * report the `US_SALES_TAX` branch, which is what separates "a US state, where the tax
     * belongs in the cost" from "no jurisdiction coded at all". The rate identifies the
     * jurisdiction; it no longer splits the money.
     */
    const r = computeTax({ grossMinor: 10725n, jurisdiction: US_CA, category: FULL_ITC });
    expect(r.preTaxMinor).toBe(10725n);
    expect(r.gstHstMinor).toBe(0n);
    expect(r.qstMinor).toBe(0n);
    expect(r.pstMinor).toBe(0n);
    expect(r.recoverableGstHstMinor).toBe(0n);
    expect(r.totalTaxMinor).toBe(0n);
  });

  it('no-tax jurisdiction returns gross as net', () => {
    const r = computeTax({ grossMinor: 10000n, jurisdiction: NONE, category: FULL_ITC });
    expect(r.preTaxMinor).toBe(10000n);
    expect(r.totalTaxMinor).toBe(0n);
  });
});

describe('computeTax — explicit wins (PROVIDED)', () => {
  it('uses the explicit GST/HST amount and derives net', () => {
    const r = computeTax({
      grossMinor: 11300n,
      jurisdiction: ON,
      category: FULL_ITC,
      explicit: { gstHstMinor: 1200n },
    });
    expect(r.source).toBe('PROVIDED');
    expect(r.gstHstMinor).toBe(1200n);
    expect(r.preTaxMinor).toBe(10100n);
    expect(r.recoverableGstHstMinor).toBe(1200n);
  });

  it('applies ITC to explicit amounts too (meal 50%)', () => {
    const r = computeTax({
      grossMinor: 11300n,
      jurisdiction: ON,
      category: MEAL_ITC,
      explicit: { gstHstMinor: 1300n },
    });
    expect(r.recoverableGstHstMinor).toBe(650n);
    expect(r.preTaxMinor).toBe(10000n);
  });
});
