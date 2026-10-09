/**
 * Public surface of `@expenseos/money`.
 *
 * The package owns the application-wide Money primitive: the DB-friendly
 * `{ amountMinor: bigint, currencyCode: string }` shape and the dinero.js
 * adapters that wrap precise integer-arithmetic, multi-currency formatting,
 * and FX conversion around it.
 *
 * Boundary contract:
 *   - Persistence rows store `amountMinor` (BigInt) and `currencyCode`
 *     (ISO-4217, matching `Currency.code` in @expenseos/db).
 *   - tRPC payloads carry the same pair as { amountMinor: string,
 *     currencyCode: string } — strings because JSON can't carry BigInts.
 *   - In-memory math happens on the dinero handle (`toDinero(m)`); never
 *     do arithmetic on `amountMinor` directly. dinero handles JPY-style
 *     zero-exponent currencies correctly; raw cents math does not.
 *   - UI formatting goes through `formatMoney(m, locale)` — locale-aware
 *     symbol placement, grouping, and exponent.
 */

export { convertMoney, type FxRateMap } from './convert';
export { getCurrency, isKnownCurrency } from './currencies';
export { fromDinero, toDinero } from './dinero';
export { type FormatMoneyOptions, formatMoney } from './format';
export { fromWire, type Money, type MoneyWire, toWire } from './money';
// The report FX/VAT roll-up. Here rather than in apps/web because the WORKER
// writes report totals too (extraction prefill), and it was computing a raw
// cross-currency sum while the web app converted — two answers for one number.
export {
  buildReportRollup,
  fxRateMapFrom,
  type ReportRollup,
  type RollupCurrencyLine,
  type RollupExpense,
  withFxOverride,
} from './reportRollup';
export { splitExact } from './split';
