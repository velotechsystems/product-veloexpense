/**
 * The DB-friendly Money shape — what every persisted money column carries.
 *
 * `amountMinor` is the value in the currency's minor units (cents for
 * USD, sen for JPY which has exponent 0). Stored as BigInt to avoid
 * float drift on totals across thousands of line items.
 *
 * `currencyCode` is the ISO-4217 alpha code (USD, CAD, JPY, …) and MUST
 * match a row in `Currency.code` so display + FX queries can resolve it.
 */
export interface Money {
  amountMinor: bigint;
  currencyCode: string;
}

/**
 * JSON-friendly serialization of `Money`. tRPC + browser payloads can't
 * carry BigInts (JSON.stringify chokes), so we string-encode at the
 * boundary and decode on the consumer side. Use `toWire` / `fromWire`
 * at every JSON boundary; never hand-roll.
 */
export interface MoneyWire {
  amountMinor: string;
  currencyCode: string;
}

export function toWire(m: Money): MoneyWire {
  return { amountMinor: m.amountMinor.toString(), currencyCode: m.currencyCode };
}

export function fromWire(w: MoneyWire): Money {
  return { amountMinor: BigInt(w.amountMinor), currencyCode: w.currencyCode };
}
