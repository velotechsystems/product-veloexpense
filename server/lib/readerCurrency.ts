/**
 * "In whose currency am I reading this?" — answered once, for every screen that asks.
 *
 * The reports LIST converts each total into the reader's currency (#342), the report
 * DETAIL offers to read itself in it (F52), and the approver's decided history sums
 * across whatever currencies their team submitted in. If those three disagreed, the
 * same report would show two different "approximately" figures on two screens, which is
 * worse than showing none: a reader who sees one number cannot tell it is the wrong one.
 *
 * The conversion half matters as much as the code. `expenses.list` had already learned
 * the rule the hard way — summing `totalMinor` raw across currencies added USD cents to
 * CAD cents and printed one `$` in front of the result, and because CAD and USD share
 * that glyph nothing on screen hinted that two currencies had been added together (GA
 * readiness report F54). A report with no rate path is EXCLUDED and counted, never
 * quietly folded in at face value.
 */

// VeloExpense: ported code's `db` is the tenant-scoped client (lib/db/prisma.ts).
import type { TenantDb as PrismaClient } from '@/lib/db/prisma';
import { buildReportRollup, convertMoney, fxRateMapFrom } from '@expenseos/money';
import { sumInHome } from '@/lib/format';

/**
 * The READER's own currency code.
 *
 * `User.homeCurrencyId` wins over their entity's — that column exists precisely so a
 * person posted outside their entity's base can be re-based without moving the entity.
 * CAD only when neither is set.
 *
 * VeloExpense: a person has no `homeCurrencyId` of their own (app_user carries none), so
 * the entity's is the reader's. The entity's `homeCurrencyId` holds the ISO code itself
 * (0048), so there is no Currency row to step through.
 */
export async function readerCurrencyCode(db: PrismaClient, userId: string): Promise<string> {
  const me = await db.user.findUnique({
    where: { id: userId },
    select: {
      entity: { select: { homeCurrencyId: true } },
    },
  });
  return me?.entity?.homeCurrencyId ?? 'CAD';
}

/** Converts a minor-unit amount into the reader's currency, or null when nothing connects
 *  the pair in either direction. Null means EXCLUDE — never "treat as zero". */
export type HomeConverter = (amountMinor: bigint, currencyCode: string) => string | null;

/**
 * Build a converter into `homeCurrency` for a set of rows.
 *
 * Loads the FX table only when at least one row is in a foreign currency, so the common
 * single-currency case costs nothing.
 */
export async function homeConverterFor(
  db: PrismaClient,
  homeCurrency: string,
  currencyCodes: readonly string[],
): Promise<HomeConverter> {
  const needsFx = currencyCodes.some((c) => c !== homeCurrency);
  const rates = needsFx
    ? fxRateMapFrom(await db.fxRate.findMany({ orderBy: { fetchedAt: 'desc' } }))
    : null;
  return (amountMinor, currencyCode) => {
    if (currencyCode === homeCurrency) return amountMinor.toString();
    // Zero converts to zero in every currency, and saying so keeps a $0.00 report out of
    // the "excluded, no rate" count where it would read as missing data.
    if (amountMinor === 0n) return '0';
    if (!rates) return null;
    try {
      return (
        convertMoney({ amountMinor, currencyCode }, homeCurrency, rates)?.amountMinor.toString() ??
        null
      );
    } catch {
      // An unknown ISO code. Excluded, exactly like a missing rate.
      return null;
    }
  };
}

/**
 * Each report's total in the reader's currency, built from its OWN expenses.
 *
 * Not "the stored total, converted once". The stored total is already rolled into the
 * REPORT's currency; converting that at today's table re-values a filed claim, and the
 * list then disagrees with the report it links to — CAD 174.29 on the row, CAD 174.14 on
 * the line (GA audit v2, GA-3).
 *
 * Rolling up per report at the reader's currency is what preserves each expense's
 * snapshotted rate, because `buildReportRollup` prefers a snapshot whenever its home
 * currency matches the currency being rolled into.
 *
 * ONE query for the whole page, not one per row: the FX facts for every listed report are
 * fetched together and grouped here. A page is 50 rows, so this is one join rather than
 * fifty round trips.
 *
 * `null` for a report nothing could be valued in — never zero, which would read as a
 * report worth nothing rather than one this currency cannot express.
 */
export async function readerTotalsFor(
  db: PrismaClient,
  readerCurrency: string,
  reports: readonly { id: string; totalMinor: bigint; currencyCode: string }[],
): Promise<Map<string, { totalMinor: string | null; excluded: number }>> {
  const out = new Map<string, { totalMinor: string | null; excluded: number }>();

  /**
   * A report ALREADY in the reader's currency is its stored total, verbatim.
   *
   * Not a roll-up of its expenses, even though that would usually agree. The list shows
   * the stored `totalMinor` in one column and this in the next, and computing them two
   * different ways lets them disagree — a report can then read "10,000" beside "0", which
   * is what an existing test caught when this recomputed unconditionally. `totalMinor` is
   * maintained by `recomputeReportTotal` and is the number the rest of the product means
   * by "the total"; second-guessing it here would make this the only screen that does.
   *
   * It is also the honest answer: there is no conversion to perform, so there is no rate
   * to preserve and nothing to get wrong.
   */
  const needsConversion = reports.filter((r) => r.currencyCode !== readerCurrency);
  for (const r of reports) {
    if (r.currencyCode === readerCurrency) {
      out.set(r.id, { totalMinor: r.totalMinor.toString(), excluded: 0 });
    }
  }
  if (needsConversion.length === 0) return out;

  /**
   * Everything else is rolled up from its OWN expenses, at the reader's currency.
   *
   * Not "the stored total, converted once". The stored total is already rolled into the
   * REPORT's currency; converting that at today's table re-values a filed claim, and the
   * row then disagrees with the report it links to — CAD 174.29 on the row, CAD 174.14 on
   * the line composing it (GA audit v2, GA-3). Rolling up at the reader's currency is what
   * preserves each expense's snapshotted rate, because `buildReportRollup` prefers a
   * snapshot whenever its home currency matches the currency being rolled into.
   *
   * ONE query for the page, not one per row.
   */
  const ids = needsConversion.map((r) => r.id);
  const expenses = await db.expense.findMany({
    where: { reportId: { in: ids } },
    select: {
      reportId: true,
      amountMinor: true,
      recoverableGstHstMinor: true,
      recoverableQstMinor: true,
      fxRate: true,
      homeCurrency: true,
      currency: { select: { code: true } },
    },
  });
  const byReport = new Map<string, typeof expenses>();
  for (const e of expenses) {
    if (!e.reportId) continue;
    byReport.set(e.reportId, [...(byReport.get(e.reportId) ?? []), e]);
  }
  const rates = fxRateMapFrom(await db.fxRate.findMany({ orderBy: { fetchedAt: 'desc' } }));

  for (const r of needsConversion) {
    const rows = byReport.get(r.id) ?? [];
    if (rows.length === 0) {
      // No expenses to value. Zero is the truth here, not a missing answer.
      out.set(r.id, { totalMinor: '0', excluded: 0 });
      continue;
    }
    try {
      const rollup = buildReportRollup(
        readerCurrency,
        rows.map((e) => ({
          amountMinor: e.amountMinor,
          currencyCode: e.currency.code,
          recoverableGstHstMinor: e.recoverableGstHstMinor,
          recoverableQstMinor: e.recoverableQstMinor,
          fxRate: e.fxRate,
          fxHomeCurrency: e.homeCurrency,
        })),
        rates,
      );
      out.set(r.id, {
        // Nothing convertible at all is NO answer, not a total of zero — the client
        // leaves it out of the summed balance and says how many it left out.
        totalMinor: rollup.missingRates.length === rows.length ? null : rollup.homeTotalMinor,
        excluded: rollup.missingRates.length,
      });
    } catch {
      // An unknown ISO code. Excluded, exactly like a missing rate.
      out.set(r.id, { totalMinor: null, excluded: rows.length });
    }
  }
  return out;
}

/**
 * One currency's slice of a set of rows, as a `groupBy` hands it over.
 *
 * `totalMinor` is in THAT currency's own minor units — never the reader's, and never
 * added to another group's. Converting is `buildHomeRollup`'s job, and it converts each
 * group separately for the reason `homeConverterFor`'s header states: adding ¥ to $ is
 * not arithmetic, it is a wrong number that looks precise.
 */
export interface CurrencyGroup {
  code: string;
  symbol: string;
  /** How many ROWS are in this group — reports, requests, tasks. Not currencies. */
  count: number;
  totalMinor: bigint;
}

/** The money half of an aggregate envelope. `count` is not here: the procedure owns what
 *  it is counting (see `expenseApprovals.myTasks`, where the rows are tasks). */
export interface HomeRollup {
  /**
   * Per-currency subtotals, sorted by ISO code so the array is stable across calls —
   * `groupBy` does not promise an order, and a panel whose currencies reshuffle between
   * loads looks broken.
   *
   * This is the disclosure half of the envelope: it is what lets a reader see that the
   * home total is made of ¥48,000 they cannot value plus CAD 3,905.15 they can.
   */
  byCurrency: Array<{
    code: string;
    symbol: string;
    count: number;
    /** The group's own total, in its own minor units, as a decimal string. */
    totalMinor: string;
    /** That subtotal in the reader's currency, or null when no rate connects them. */
    homeTotalMinor: string | null;
  }>;
  /**
   * Every convertible group added up, in the reader's currency, as a decimal string.
   *
   * `null` — never a zero — when there were rows and NONE of them could be valued. A
   * literal `'0'` there would read as "you have nothing outstanding", which is the same
   * lie as understating, printed with more confidence. `'0'` is reserved for the two
   * cases that honestly mean zero: no rows at all, and rows that really do total zero.
   */
  homeTotalMinor: string | null;
  /** How many ROWS were left out of `homeTotalMinor`. A caller that renders the total
   *  must say so when this is non-zero — a total that quietly omits rows is a wrong total. */
  excludedCount: number;
}

/**
 * Currency groups → the money half of an aggregate envelope.
 *
 * THE EXCLUSION RULE IS NOT IMPLEMENTED HERE. It is `sumInHome`'s, in `@/lib/format`,
 * and this function calls it. That shared-implementation note used to name a second,
 * row-level caller on the client (`/my-info`, then `(my-info)` once the dashboard stopped
 * being one); that page is deleted, and `sumInHome` now has exactly ONE caller in the
 * product — this one. The rule stays in `@/lib/format` rather than being inlined here,
 * because it is the row-level rule and the next surface that totals a capped page of rows
 * must reach for it instead of writing a second one. Keeping it there is what stopped the
 * drift; collapsing it into this file now would invite the drift back.
 *
 * Convert-then-sum, never sum-then-convert: `_sum.totalMinor` across groups is a number
 * with no currency, and printing it under one symbol is GA readiness report F54.
 */
export function buildHomeRollup(
  groups: readonly CurrencyGroup[],
  inHomeCurrency: HomeConverter,
): HomeRollup {
  const byCurrency = [...groups]
    .sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0))
    .map((g) => ({
      code: g.code,
      symbol: g.symbol,
      count: g.count,
      totalMinor: g.totalMinor.toString(),
      homeTotalMinor: inHomeCurrency(g.totalMinor, g.code),
    }));

  const { minor, excluded: excludedGroups } = sumInHome(byCurrency.map((g) => g.homeTotalMinor));
  // The same nulls `sumInHome` just dropped, re-read as a count of ROWS rather than of
  // groups — which is what a reader needs told ("1 report left out", not "1 currency").
  // Not a second implementation of the rule: what null MEANS for the sum was decided above.
  const excludedCount =
    excludedGroups === 0
      ? 0
      : byCurrency.reduce((n, g) => (g.homeTotalMinor === null ? n + g.count : n), 0);
  const rowCount = byCurrency.reduce((n, g) => n + g.count, 0);

  return {
    byCurrency,
    homeTotalMinor: rowCount > 0 && excludedCount === rowCount ? null : minor.toString(),
    excludedCount,
  };
}
