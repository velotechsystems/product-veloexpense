/**
 * Pure tax engine — reverse-calculates or accepts explicit tax on a
 * tax-inclusive amount, splits GST/HST vs QST vs PST, and applies category ITC
 * recoverability (CRA). Ported from the retired app's `calculateRecoverableVAT`
 * (docs/legacy/business-rules.md §1); server-authoritative, minor-unit BigInt.
 *
 * Precedence (resolved upstream, fed via `explicit`): MANUAL > EXTRACTED >
 * CALCULATED. If `explicit` carries any amount, it is trusted; otherwise the
 * engine reverse-calcs from `grossMinor` + jurisdiction rates.
 */

import type { TaxInput, TaxResult } from './types';

/** Round-half-up integer division for non-negative operands. */
function divRound(numer: bigint, denom: bigint): bigint {
  if (denom === 0n) return 0n;
  const neg = numer < 0n;
  const n = neg ? -numer : numer;
  const q = (n + denom / 2n) / denom;
  return neg ? -q : q;
}

/** Percent (≤3 decimals) → scaled BigInt (×1000). e.g. 9.975 → 9975. */
function scalePct(pct: number): bigint {
  return BigInt(Math.round(pct * 1000));
}

/** `amountMinor × pct%`, rounded. pct scaled by 1000, divided by 100·1000. */
function pctOf(amountMinor: bigint, pct: number): bigint {
  if (pct <= 0) return 0n;
  return divRound(amountMinor * scalePct(pct), 100000n);
}

/** Reverse a tax-inclusive amount to its pre-tax base for a total rate %. */
function preTaxOf(grossMinor: bigint, totalRatePct: number): bigint {
  if (totalRatePct <= 0) return grossMinor;
  // preTax = gross / (1 + rate/100) = gross · 100000 / (100000 + rate·1000)
  return divRound(grossMinor * 100000n, 100000n + scalePct(totalRatePct));
}

function hasExplicit(e: TaxInput['explicit']): boolean {
  return !!e && (e.gstHstMinor != null || e.qstMinor != null || e.pstMinor != null);
}

export function computeTax(input: TaxInput): TaxResult {
  const { grossMinor, jurisdiction: j, category: c, explicit } = input;
  const isCanadian = j.gstRate > 0 || j.hstRate > 0 || j.pstRate > 0 || j.qstRate > 0;

  let gstHstMinor = 0n;
  let qstMinor = 0n;
  let pstMinor = 0n;
  let preTaxMinor = grossMinor;
  let source: TaxResult['source'] = 'CALCULATED';

  if (hasExplicit(explicit)) {
    // MANUAL or EXTRACTED — trust the amounts; derive net from them.
    gstHstMinor = explicit?.gstHstMinor ?? 0n;
    qstMinor = explicit?.qstMinor ?? 0n;
    pstMinor = explicit?.pstMinor ?? 0n;
    preTaxMinor = grossMinor - gstHstMinor - qstMinor - pstMinor;
    source = 'PROVIDED';
  } else if (isCanadian) {
    const total = j.gstRate + j.hstRate + j.pstRate + j.qstRate;
    preTaxMinor = preTaxOf(grossMinor, total);
    // HST replaces GST where it applies (never both non-zero in the table).
    gstHstMinor = pctOf(preTaxMinor, j.hstRate > 0 ? j.hstRate : j.gstRate);
    qstMinor = pctOf(preTaxMinor, j.qstRate);
    pstMinor = pctOf(preTaxMinor, j.pstRate);
  }
  /**
   * No US branch, deliberately.
   *
   * A US-state charge falls through with `preTaxMinor === grossMinor` and every tax at
   * zero — the whole amount is the cost. That is the intended treatment: non-Canadian tax
   * is never captured, it stays inside the line, and nobody reclaims it.
   *
   * There used to be a branch here that reverse-calced `salesTaxMinor` from the state rate
   * and reduced `preTaxMinor` by it. Both outputs went nowhere: `salesTaxMinor` had no
   * column, no API field and no reader outside this file, and `preTaxMinor` is not
   * persisted at all. It computed a figure off a 51-state rate table that nothing
   * consumed, which is worse than harmless — it read as though US tax were being handled,
   * and a reader would reasonably assume it fed something.
   *
   * `salesTaxRate` itself is still load-bearing and stays: `explain.ts` reads it to return
   * the `US_SALES_TAX` branch, which is the only thing that distinguishes "a US state,
   * where the tax belongs in the cost" from "no jurisdiction coded at all".
   */

  return {
    source,
    preTaxMinor,
    gstHstMinor,
    qstMinor,
    pstMinor,
    recoverableGstHstMinor: pctOf(gstHstMinor, c.itcGstHstRate),
    recoverableQstMinor: pctOf(qstMinor, c.itcQstRate),
    recoverablePstMinor: c.pstRecoverable ? pstMinor : 0n,
    totalTaxMinor: gstHstMinor + qstMinor + pstMinor,
  };
}
