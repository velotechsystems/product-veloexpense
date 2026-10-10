/**
 * Server-authoritative currency conversion at the EXPENSE level.
 *
 * An employee is paid in their LEGAL ENTITY's home currency — not their own
 * preference, not the report's — so every expense carries the rate that was
 * actually applied and the converted amount it produced. Both are snapshotted.
 *
 * They have to be. The rate previously lived only in the global `FxRate` table and
 * was read at render time, which means a filed report's converted total changed
 * whenever somebody added a rate for that day. A claim has to stand as filed, and
 * an approver has to be approving the number they were shown.
 *
 * Precedence is the same as tax, for the same reason — a figure a human supplied
 * or a document stated beats one we derived:
 *
 *   MANUAL     the employee (or AP) typed the rate their statement actually shows
 *   EXTRACTED  a rate implied by an uploaded card statement / bank document
 *   CALCULATED the daily FxRate table
 *
 * CALCULATED has to work in every direction, because the table does not. The only feed
 * is the Bank of Canada, whose series are all `FX<ISO>CAD` — so every stored row quotes
 * CAD and none quotes anything else. Asking it for `CAD->USD` will never succeed no
 * matter how long it runs. So the derivation tries the published pair, then its
 * reciprocal, then a pivot through any currency both sides are quoted against; see
 * `deriveRate`.
 */

import { convertMoney } from '@expenseos/money';
// VeloExpense: VeloExpense's generated client (lib/generated/prisma), and its text enums.
import { Prisma, type PrismaClient } from '@/lib/generated/prisma/client';
import type { FxRateSource } from './enums';

export interface ResolveExpenseFxParams {
  /** The expense total in its own currency. */
  amountMinor: bigint;
  /** ISO code the expense is denominated in. */
  currencyCode: string;
  /** The entity's home currency — what the employee is paid in. */
  homeCurrency: string;
  /**
   * A rate the caller already holds: typed by a human (MANUAL) or read off a
   * document (EXTRACTED). When present it is used as-is; only its provenance is
   * recorded. Null means "derive it".
   */
  providedRate?: { rate: string; source: Extract<FxRateSource, 'MANUAL' | 'EXTRACTED'> } | null;
}

export interface ResolvedExpenseFx {
  fxRate: Prisma.Decimal | string | null;
  fxRateSource: FxRateSource | null;
  homeCurrency: string;
  /** null when no rate could be found — the caller surfaces that rather than
   *  guessing, because a converted total nobody can justify is worse than none. */
  homeAmountMinor: bigint | null;
}

/** Same-currency expenses need no rate and must not invent one. */
function sameCurrency(amountMinor: bigint, homeCurrency: string): ResolvedExpenseFx {
  return {
    fxRate: null,
    fxRateSource: null,
    homeCurrency,
    homeAmountMinor: amountMinor,
  };
}

export async function resolveExpenseFx(
  db: Pick<Prisma.TransactionClient, 'fxRate'>,
  params: ResolveExpenseFxParams,
): Promise<ResolvedExpenseFx> {
  const from = params.currencyCode.toUpperCase();
  const to = params.homeCurrency.toUpperCase();
  if (from === to) return sameCurrency(params.amountMinor, to);

  // MANUAL / EXTRACTED — the rate is given; we only apply it.
  if (params.providedRate) {
    const rates = new Map([[`${from}->${to}`, params.providedRate.rate]]);
    return {
      fxRate: params.providedRate.rate,
      fxRateSource: params.providedRate.source,
      homeCurrency: to,
      homeAmountMinor: convert(params.amountMinor, from, to, rates),
    };
  }

  // CALCULATED — the latest daily rate for the pair, snapshotted now so it can't
  // move under a filed claim.
  const rate = await deriveRate(db, from, to);
  if (rate === null) {
    return { fxRate: null, fxRateSource: null, homeCurrency: to, homeAmountMinor: null };
  }
  return {
    fxRate: rate,
    fxRateSource: 'CALCULATED',
    homeCurrency: to,
    homeAmountMinor: convert(params.amountMinor, from, to, new Map([[`${from}->${to}`, rate]])),
  };
}

/** What the FxRate column holds, so a derived rate can be stored and re-applied
 *  identically. Rounding here rather than at write time keeps the snapshot honest: the
 *  rate we record is the rate we converted at. */
const RATE_DP = 8;

/** A rate is `quote per 1 base`, so the opposite direction is its reciprocal. */
function reciprocal(rate: Prisma.Decimal): Prisma.Decimal | null {
  if (rate.isZero() || !rate.isFinite()) return null;
  return new Prisma.Decimal(1).div(rate);
}

/** Rounded to the column's precision, or null if that rounds the rate away entirely —
 *  a stored zero would convert every amount to nothing. */
function storable(rate: Prisma.Decimal | null): string | null {
  if (rate === null || !rate.isFinite() || rate.isNegative()) return null;
  const rounded = rate.toDecimalPlaces(RATE_DP);
  return rounded.isZero() ? null : rounded.toString();
}

/**
 * Every currency `code` has a latest rate against, expressed as `code -> other`.
 *
 * Rows are read newest-first, so the first sighting of a counterpart is its latest
 * quote regardless of which side of the pair `code` sits on — a pair published in both
 * directions resolves to whichever was fetched most recently.
 */
async function legs(
  db: Pick<Prisma.TransactionClient, 'fxRate'>,
  code: string,
): Promise<Map<string, Prisma.Decimal>> {
  const rows = await db.fxRate.findMany({
    where: { OR: [{ base: code }, { quote: code }] },
    orderBy: { fetchedAt: 'desc' },
    select: { base: true, quote: true, rate: true },
  });
  const out = new Map<string, Prisma.Decimal>();
  for (const row of rows) {
    const other = row.base === code ? row.quote : row.base;
    if (other === code || out.has(other)) continue;
    const rate = new Prisma.Decimal(row.rate.toString());
    const asFrom = row.base === code ? rate : reciprocal(rate);
    if (asFrom !== null) out.set(other, asFrom);
  }
  return out;
}

/**
 * The rate to convert `from` into `to`, derived from what the feed actually publishes.
 *
 * Three attempts, cheapest and most faithful first:
 *
 *   1. the published pair — always preferred, since deriving introduces rounding the
 *      published figure does not have;
 *   2. its reciprocal, which is what a non-CAD home currency needs on every expense;
 *   3. a pivot through any currency both sides are quoted against, which is what a
 *      EUR expense on a USD-home entity needs — the feed quotes both against CAD but
 *      neither against the other.
 *
 * The pivot is discovered, not hardcoded to CAD: a second feed quoting against
 * something else would be used the same way rather than silently ignored.
 */
async function deriveRate(
  db: Pick<Prisma.TransactionClient, 'fxRate'>,
  from: string,
  to: string,
): Promise<string | null> {
  const direct = await db.fxRate.findFirst({
    where: { base: from, quote: to },
    orderBy: { fetchedAt: 'desc' },
    select: { rate: true },
  });
  // Straight off the feed. Still normalised through `storable`, so a published rate and
  // a derived one are stored in the same form.
  if (direct) return storable(new Prisma.Decimal(direct.rate.toString()));

  const inverse = await db.fxRate.findFirst({
    where: { base: to, quote: from },
    orderBy: { fetchedAt: 'desc' },
    select: { rate: true },
  });
  if (inverse) return storable(reciprocal(new Prisma.Decimal(inverse.rate.toString())));

  // `from -> pivot` over `to -> pivot` cancels the pivot and leaves `to per 1 from`.
  const [fromLegs, toLegs] = await Promise.all([legs(db, from), legs(db, to)]);
  for (const pivot of [...fromLegs.keys()].sort()) {
    const a = fromLegs.get(pivot);
    const b = toLegs.get(pivot);
    if (!a || !b || b.isZero()) continue;
    const derived = storable(a.div(b));
    if (derived !== null) return derived;
  }
  return null;
}

/** `convertMoney` throws on an unknown ISO code; a bad code is a missing rate as
 *  far as the caller is concerned, not a crash. */
function convert(
  amountMinor: bigint,
  from: string,
  to: string,
  rates: Map<string, string>,
): bigint | null {
  try {
    const out = convertMoney({ amountMinor, currencyCode: from }, to, rates);
    return out ? out.amountMinor : null;
  } catch {
    return null;
  }
}

/**
 * Everything the FX snapshot needs off an expense row. Exported so `recomputeTotals`
 * can fold these fields into the lookup it already does rather than issuing a
 * second query for them.
 */
export const EXPENSE_FX_SELECT = {
  amountMinor: true,
  currency: { select: { code: true } },
  fxRate: true,
  fxRateSource: true,
  // VeloExpense: the entity's `homeCurrencyId` holds the ISO code itself (0048).
  owner: { select: { entity: { select: { homeCurrencyId: true } } } },
} as const;

export interface ExpenseFxRow {
  amountMinor: bigint;
  currency: { code: string };
  fxRate: { toString(): string } | null;
  /** VeloExpense: text with a CHECK (0054), so the client types it `string`; the database
   *  admits only `FxRateSource`'s values. */
  fxRateSource: FxRateSource | string | null;
  /** Optional so a caller that selected the row without the relation degrades to
   *  "no home currency" instead of throwing mid-write. `homeCurrency` is a FK now,
   *  so this is the projected code — see EXPENSE_FX_SELECT. */
  // VeloExpense: the code itself, as `homeCurrencyId` (see EXPENSE_FX_SELECT).
  owner?: { entity: { homeCurrencyId: string | null } | null } | null;
}

/**
 * Turn an expense row into resolver params. A rate already on the row that a
 * human or a document supplied is carried forward — recomputing an expense's
 * lines must not quietly replace AP's statement rate with today's daily rate.
 * `overrideAmountMinor` is for callers that have just recalculated the total and
 * hold a fresher figure than the row does.
 */
export function fxParamsFrom(
  row: ExpenseFxRow,
  overrideAmountMinor?: bigint,
): ResolveExpenseFxParams {
  const kept =
    row.fxRate != null && (row.fxRateSource === 'MANUAL' || row.fxRateSource === 'EXTRACTED')
      ? {
          rate: row.fxRate.toString(),
          // VeloExpense: the column is `string` to the client (see ExpenseFxRow), so the
          // check above narrows the value, not the type.
          source: row.fxRateSource as Extract<FxRateSource, 'MANUAL' | 'EXTRACTED'>,
        }
      : null;
  return {
    amountMinor: overrideAmountMinor ?? row.amountMinor,
    currencyCode: row.currency.code,
    // No entity, or an entity with no home currency configured, means we have
    // nothing to convert INTO. Treating the expense's own currency as home
    // leaves the snapshot inert rather than inventing a conversion.
    homeCurrency: row.owner?.entity?.homeCurrencyId ?? row.currency.code,
    providedRate: kept,
  };
}

/**
 * Write the FX snapshot onto a set of expenses, optionally forcing a rate.
 *
 * This is how the AP report-level override reaches the numbers: it writes down
 * onto the expenses it applies to, so the expense row remains the single place a
 * rate is recorded. `force: null` clears any MANUAL/EXTRACTED rate and lets the
 * daily table supply one again.
 *
 * Returns the ids it actually touched.
 */
export async function snapshotExpensesFx(
  db: PrismaClient,
  params: {
    expenseIds: readonly string[];
    /** Omit to keep whatever provenance each expense already has. */
    force?: { rate: string; source: Extract<FxRateSource, 'MANUAL' | 'EXTRACTED'> } | null;
  },
): Promise<string[]> {
  if (params.expenseIds.length === 0) return [];
  const rows = await db.expense.findMany({
    where: { id: { in: [...params.expenseIds] } },
    select: { id: true, ...EXPENSE_FX_SELECT },
  });
  const touched: string[] = [];
  for (const row of rows) {
    const base = fxParamsFrom(row);
    const fx = await resolveExpenseFx(db, {
      ...base,
      // `force` present means the caller is deciding provenance: a rate to
      // adopt, or null to drop back to the derived rate.
      providedRate: params.force === undefined ? base.providedRate : params.force,
    });
    await db.expense.update({ where: { id: row.id }, data: fxColumns(fx) });
    touched.push(row.id);
  }
  return touched;
}

/** The four columns a resolved snapshot writes. Shared so every writer stores
 *  the same shape — a rate with no converted amount, or neither. */
export function fxColumns(fx: ResolvedExpenseFx) {
  return {
    fxRate: fx.fxRate,
    fxRateSource: fx.fxRateSource,
    homeCurrency: fx.homeCurrency,
    homeAmountMinor: fx.homeAmountMinor,
  };
}
