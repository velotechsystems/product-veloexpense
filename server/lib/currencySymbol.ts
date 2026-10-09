/**
 * VeloExpense: a currency's display symbol, from the platform.
 *
 * ExpenseOS stores `Currency.symbol`; VeloExpense's shared `currency` table (0001) holds
 * the ISO code, an English name and the minor units, and no symbol. `Intl` knows the
 * narrow symbol for every ISO-4217 code, so the ported code's `symbol` comes from here
 * rather than from a column nobody maintains. An unknown code falls back to itself.
 */
export function currencySymbol(code: string): string {
  try {
    return (
      new Intl.NumberFormat('en-CA', { style: 'currency', currency: code, currencyDisplay: 'narrowSymbol' })
        .formatToParts(0)
        .find((p) => p.type === 'currency')?.value ?? code
    );
  } catch {
    return code;
  }
}
