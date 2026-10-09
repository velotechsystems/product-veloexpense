/**
 * Shapes for the tax engine (`computeTax`). All money is minor units (BigInt),
 * matching the persistence + `@expenseos/money` contract. Rates are percentages
 * (e.g. 13 = 13%, 9.975 = 9.975%), as stored on `TaxJurisdiction`.
 */

export interface JurisdictionRates {
  gstRate: number;
  hstRate: number;
  pstRate: number;
  qstRate: number;
  /**
   * US state sales tax; 0 for Canadian jurisdictions.
   *
   * Read by `explain.ts` to report the `US_SALES_TAX` branch — NOT by `computeTax`, which
   * deliberately splits nothing for a US jurisdiction because the tax belongs in the cost.
   * It is the only signal separating "a US state" from "no jurisdiction coded".
   */
  salesTaxRate: number;
}

/** Category-intrinsic ITC recoverability (from `ExpenseCategory`). */
export interface CategoryItc {
  /** Percent of GST/HST recoverable (100, or 50 for meals/entertainment). */
  itcGstHstRate: number;
  itcQstRate: number;
  /** PST/RST is never recoverable in Canada; false in practice. */
  pstRecoverable: boolean;
}

/** Tax amounts resolved upstream from MANUAL or EXTRACTED sources. */
export interface ExplicitTax {
  gstHstMinor?: bigint;
  qstMinor?: bigint;
  pstMinor?: bigint;
}

export interface TaxInput {
  /**
   * Tax-INCLUSIVE amount to reverse-calc from, minor units. For meals the
   * caller excludes the voluntary tip (untaxed) but KEEPS the mandatory
   * gratuity (taxable). Ignored for the split when `explicit` is provided.
   */
  grossMinor: bigint;
  jurisdiction: JurisdictionRates;
  category: CategoryItc;
  /**
   * Resolved MANUAL/EXTRACTED tax amounts. Precedence is decided upstream
   * (MANUAL > EXTRACTED > CALCULATED); when present here, they are used
   * verbatim (explicit-wins) and the gross is only used to derive the net.
   */
  explicit?: ExplicitTax;
}

export interface TaxResult {
  /** PROVIDED = from `explicit` (manual/extracted); CALCULATED = reverse-calc. */
  source: 'PROVIDED' | 'CALCULATED';
  /** Net (pre-tax) amount — posts to the expense GL account. */
  preTaxMinor: bigint;
  gstHstMinor: bigint;
  qstMinor: bigint;
  pstMinor: bigint;
  /** Recoverable ITC slice — posts to GL 110400 / 110410. */
  recoverableGstHstMinor: bigint;
  recoverableQstMinor: bigint;
  recoverablePstMinor: bigint;
  totalTaxMinor: bigint;
}
