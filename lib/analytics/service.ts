/**
 * VX4-6a — spend analytics (ExpenseOS Module 13).
 *
 * ── What the audit deleted, and what is left ────────────────────────────────
 *
 * AN-1: their module is ONE router with three procedures and a three-tab page.
 * The report builder and the scheduled exports are four declared permissions and
 * nothing behind them, so "port Analytics" is not a BI product.
 *
 * AN-2/3/5/9: four separate cross-tenant leaks, all the same shape — the
 * privileged case is the ABSENCE of a predicate, and a test of theirs asserts
 * that absence. That class cannot recur here: RLS supplies the predicate below
 * the query and `test/rls-isolation.test.ts` proves it per table. Nothing to port.
 *
 * What is left is a money defect and a performance shape, and both are here.
 *
 * ── AN-7: a missing rate is LOUD ────────────────────────────────────────────
 *
 * Theirs is one line: `return c ? c.amountMinor : amountMinor; // missing rate ->
 * best-effort raw`. Yen get added to cents and reported as base currency with
 * nothing on the response to say so. Ours puts that spend in `unconvertible`,
 * never folds it into a total, and names the currencies — the same shape
 * `budget_period.unconvertible_minor` already has, because a report that quietly
 * under-states is worse than one that says it cannot answer.
 *
 * ── UD-6: valued at the rate of its OWN date ────────────────────────────────
 *
 * Upstream's `b9e242d7` is the record of getting this wrong: a rolled-up total
 * re-valued at today's FX table disagreed with its own line by 15 cents on
 * $125.50, and "a filed claim is worth what it was worth when it was incurred.
 * Otherwise an approved report's total moves on its own overnight." Every group
 * here is converted at the rate for ITS OWN DAY, through the same date-bounded
 * `lib/fx/rates.ts` lookup the budget rollup uses too.
 *
 * ── AN-10: the aggregation shape (John's call, 2 Sep) ───────────────────────
 *
 * Theirs loads every matching spend row into memory, aggregates in JS, filters
 * months in JS afterwards, and puts no `take` on anything — with both range ends
 * optional and the home page calling it with none, so every login aggregates all
 * history.
 *
 * Ours SUMS IN SQL, grouped down to (currency_code, day, dimension value), and
 * converts those groups in JS. The row count is therefore bounded by CARDINALITY
 * — how many distinct currency/day/value combinations actually carry spend — and
 * not by transaction volume, which is the property AN-10 is about. Doing the FX
 * in SQL instead would have meant a second implementation of the rate rules
 * (reciprocals included) living in a query; doing the whole aggregation in JS is
 * what we are porting away from.
 *
 * And the range is REQUIRED. Not defaulted — refused. A default is how theirs
 * ended up aggregating all history on a page nobody thought was expensive.
 */
import type { QueryRunner } from '@/lib/db/client';
import type { UserMessage } from '@/lib/errors/domain';
import type { UserMessageCode } from '@/lib/i18n/catalog/errors';
import { DomainError } from '@/lib/errors/domain';
import { convertMinor } from '@/lib/money';
import { buildRateLookup, type RateLookup, type RateRow } from '@/lib/fx/rates';
import { policyCurrencyCode } from '@/lib/fx/policyCurrency';
import { requireModule } from '@/lib/modules/service';
import { COMMITTED_STATUSES, COUNTED_STATUSES } from '@/lib/spend/statuses';

/** The date an expense is attributed by — one expression, shared in spirit with
 *  the budget rollup, because two copies of it become two different answers. */
const ON_DATE = `COALESCE(e.txn_date, e.created_at::date)`;

export type AnalyticsErrorCode = 'RANGE_REQUIRED' | 'RANGE_INVERTED';

export class AnalyticsError extends DomainError {
  constructor(
    message: string,
    readonly code: AnalyticsErrorCode,
    userMessage: UserMessageCode | UserMessage | null = null,
  ) {
    super(message, userMessage);
    this.name = 'AnalyticsError';
  }
}

export interface SpendRange {
  /** Inclusive, ISO date. REQUIRED — see the header on why there is no default. */
  from: string;
  /** Inclusive, ISO date. */
  to: string;
}

/** One dimension's slice of spend, already in the base currency. */
export interface SpendSlice {
  key: string | null;
  label: string;
  committedMinor: bigint;
  pendingMinor: bigint;
}

/**
 * Spend that could not be valued in the base currency.
 *
 * Its own field, never folded into a total — AN-7 inverted. `byCurrency` is what
 * makes it actionable: "we cannot value 240,000 JPY of this" tells an admin which
 * rate to add, where a bare flag tells them only that something is wrong.
 */
export interface Unconvertible {
  committedMinor: bigint;
  pendingMinor: bigint;
  /** Source currency -> the minor units left out, in THAT currency. */
  byCurrency: Record<string, string>;
  /**
   * That currency's `minor_unit`, so a screen can format the figure as money.
   * Carried rather than assumed: `formatMinor(x, 'JPY', 2)` prints a hundredth of
   * the real number, and "every currency we ship has two" is exactly the
   * assumption `lib/money.ts` refuses to make.
   */
  minorUnits: Record<string, number>;
}

export interface SpendSummary {
  baseCurrency: string;
  /** `currency.minor_unit` for the base currency. Never 2 by assumption. */
  baseMinorUnit: number;
  range: SpendRange;
  committedMinor: bigint;
  pendingMinor: bigint;
  unconvertible: Unconvertible;
  /** Ascending, one entry per month that carries spend. */
  byMonth: SpendSlice[];
  byCategory: SpendSlice[];
  byGlAccount: SpendSlice[];
  byDepartment: SpendSlice[];
  byBusinessUnit: SpendSlice[];
  bySubmitter: SpendSlice[];
}

/* ── the grouped read ──────────────────────────────────────────────────────── */

interface GroupRow {
  currency_code: string;
  on_date: string;
  status: string;
  amount_minor: string;
  month: string;
  category_id: string | null;
  category_label: string | null;
  gl_account_id: string | null;
  gl_account_label: string | null;
  department_id: string | null;
  department_label: string | null;
  business_unit_id: string | null;
  business_unit_label: string | null;
  submitter_id: string;
  submitter_label: string;
}

/**
 * ONE query, grouped by every dimension at once, and this is a correction to my
 * own first design rather than the obvious choice.
 *
 * The first version ran six queries, each grouped by (currency, day, one
 * dimension). It was smaller and it had a real defect: each grouping rounds its
 * own conversion, so the header total and the category chart under it could
 * differ by cents — which is precisely the disagreement upstream's `b9e242d7`
 * spent a year showing to users ("Report header CAD 174.29 / the one line
 * composing it CAD 174.14"). Rounding once per emitted figure does not fix it
 * either: the sum of rounded slices is not the rounded sum, and no arrangement of
 * six independent groupings makes six sets of slices agree.
 *
 * Grouping by all dimensions together fixes it by construction. Every dimension
 * is folded from the SAME converted rows, so every chart and the header add up to
 * the same number exactly, and `test/analytics.db.test.ts` asserts that across
 * all six rather than trusting it.
 *
 * The cost is honest: cardinality is now the distinct combinations of (currency,
 * day, category, account, department, business unit, submitter, status) that
 * carry spend, which on a busy tenant approaches the line-item count. It is still
 * the DATABASE doing the summation over a BOUNDED range, which is the property
 * AN-10 is about — theirs loads every expense row with its joins and its
 * allocation rows and aggregates the lot in JS, with no range at all.
 *
 * No interpolated SQL either, which the six-query version needed.
 */
async function loadGroups(tx: QueryRunner, range: SpendRange): Promise<GroupRow[]> {
  const r = await tx.query(
    `SELECT e.currency_code, ${ON_DATE}::text AS on_date, r.status::text AS status,
            sum(li.amount_minor)::text AS amount_minor,
            to_char(${ON_DATE}, 'YYYY-MM') AS month,
            li.category_id::text          AS category_id,
            c.label ->> 'en'              AS category_label,
            li.gl_account_id::text        AS gl_account_id,
            g.number || ' — ' || g.name   AS gl_account_label,
            r.department_id::text         AS department_id,
            d.label ->> 'en'              AS department_label,
            r.business_unit_id::text      AS business_unit_id,
            bu.label ->> 'en'             AS business_unit_label,
            r.submitter_id::text          AS submitter_id,
            coalesce(u.display_name, u.email) AS submitter_label
       FROM expense_report r
       JOIN expense e ON e.report_id = r.id
       JOIN expense_line_item li ON li.expense_id = e.id
       JOIN expense_category c ON c.id = li.category_id
       JOIN app_user u ON u.id = r.submitter_id
       LEFT JOIN gl_account g ON g.id = li.gl_account_id
       LEFT JOIN department d ON d.id = r.department_id
       LEFT JOIN business_unit bu ON bu.id = r.business_unit_id
      WHERE r.status = ANY($1::expense_report_status[])
        AND ${ON_DATE} BETWEEN $2::date AND $3::date
      GROUP BY e.currency_code, ${ON_DATE}, r.status, li.category_id, c.label ->> 'en',
               li.gl_account_id, g.number, g.name, r.department_id, d.label ->> 'en',
               r.business_unit_id, bu.label ->> 'en', r.submitter_id, u.display_name, u.email`,
    [COUNTED_STATUSES, range.from, range.to],
  );
  return r.rows as GroupRow[];
}

/** Rate lookups bounded by each GROUP's own day, memoized. UD-6's principle. */
function rateLookups(rows: RateRow[]) {
  const cache = new Map<string, RateLookup>();
  return (on: string): RateLookup => {
    let hit = cache.get(on);
    if (!hit) {
      hit = buildRateLookup(rows, on);
      cache.set(on, hit);
    }
    return hit;
  };
}

/** A converted group: base-currency minor units, plus which bucket it belongs in. */
interface Converted {
  row: GroupRow;
  amount: bigint;
  committed: boolean;
}

type Dimension = (row: GroupRow) => { key: string | null; label: string | null };

/** Fold already-converted rows into one dimension's slices. */
function fold(rows: Converted[], dimension: Dimension, unassigned: string): SpendSlice[] {
  const slices = new Map<string, SpendSlice>();
  for (const { row, amount, committed } of rows) {
    const { key, label } = dimension(row);
    const mapKey = key ?? '\u0000unassigned';
    const slice =
      slices.get(mapKey) ??
      ({ key, label: label ?? unassigned, committedMinor: 0n, pendingMinor: 0n } as SpendSlice);
    if (committed) slice.committedMinor += amount;
    else slice.pendingMinor += amount;
    slices.set(mapKey, slice);
  }
  return [...slices.values()];
}

/** Biggest committed spend first; an unassigned bucket sorts with the rest. */
function ranked(slices: SpendSlice[]): SpendSlice[] {
  return [...slices].sort((a, b) =>
    b.committedMinor === a.committedMinor ? 0 : b.committedMinor > a.committedMinor ? 1 : -1,
  );
}

/* ── the one public read ───────────────────────────────────────────────────── */

export async function spendSummary(tx: QueryRunner, range: SpendRange): Promise<SpendSummary> {
  await requireModule(tx, 'analytics');

  // REFUSED, not defaulted. AN-10: their range ends are both optional and the
  // home page passes neither, so every signed-in user triggers a full-history
  // aggregate on login. A default here would be the same decision made quietly.
  if (!range?.from || !range?.to) {
    throw new AnalyticsError(
      'analytics needs a start and an end date — there is deliberately no default range',
      'RANGE_REQUIRED',
      'ANALYTICS_RANGE_REQUIRED',
    );
  }
  if (range.from > range.to) {
    throw new AnalyticsError(
      `the range ends before it begins (${range.from} to ${range.to})`,
      'RANGE_INVERTED',
      'ANALYTICS_RANGE_INVERTED',
    );
  }

  const base = await policyCurrencyCode(tx);
  const unitRows = await tx.query('SELECT code, minor_unit FROM currency');
  const units: Record<string, number> = {};
  for (const row of unitRows.rows) units[row.code as string] = Number(row.minor_unit);
  const lookupFor = rateLookups(
    (await tx.query('SELECT base, quote, rate, as_of FROM fx_rate ORDER BY as_of DESC, fetched_at DESC'))
      .rows as RateRow[],
  );

  // ── convert once, per group, at that group's own day ──────────────────────
  const converted: Converted[] = [];
  const unconvertible: Unconvertible = {
    committedMinor: 0n,
    pendingMinor: 0n,
    byCurrency: {},
    minorUnits: {},
  };
  let committedMinor = 0n;
  let pendingMinor = 0n;

  for (const row of await loadGroups(tx, range)) {
    const amount = BigInt(row.amount_minor);
    const committed = (COMMITTED_STATUSES as readonly string[]).includes(row.status);
    const hit = lookupFor(row.on_date).find(row.currency_code, base);
    if (!hit) {
      // AN-7 INVERTED. Theirs is `return c ? c.amountMinor : amountMinor` — yen
      // added to cents and reported as base currency with nothing saying so. This
      // spend is counted HERE and nowhere else, in its own currency, because
      // summing amounts we could not convert into one figure would be the very
      // arithmetic being avoided.
      if (committed) unconvertible.committedMinor += amount;
      else unconvertible.pendingMinor += amount;
      const held = BigInt(unconvertible.byCurrency[row.currency_code] ?? '0');
      unconvertible.byCurrency[row.currency_code] = (held + amount).toString();
      unconvertible.minorUnits[row.currency_code] = units[row.currency_code] ?? 2;
      continue;
    }
    const inBase = convertMinor(
      amount,
      hit.scaled,
      units[row.currency_code] ?? 2,
      units[base] ?? 2,
    );
    converted.push({ row, amount: inBase, committed });
    if (committed) committedMinor += inBase;
    else pendingMinor += inBase;
  }

  const byMonth = fold(converted, (r) => ({ key: r.month, label: r.month }), 'Undated').sort((a, b) =>
    a.label < b.label ? -1 : 1,
  );

  return {
    baseCurrency: base,
    baseMinorUnit: units[base] ?? 2,
    range,
    // The total is the sum of the SAME converted rows every dimension folds, so
    // the header and every chart under it agree exactly rather than to the cent.
    committedMinor,
    pendingMinor,
    unconvertible,
    byMonth,
    byCategory: ranked(
      fold(converted, (r) => ({ key: r.category_id, label: r.category_label }), 'Uncategorised'),
    ),
    byGlAccount: ranked(
      fold(converted, (r) => ({ key: r.gl_account_id, label: r.gl_account_label }), 'No GL account'),
    ),
    // The STAMPED department (VX4-5), never a join through the submitter — that is
    // the whole reason 0024 added the column: a transfer must not rewrite a closed
    // period's numbers, and it must not move last quarter's chart either.
    byDepartment: ranked(
      fold(converted, (r) => ({ key: r.department_id, label: r.department_label }), 'Unassigned'),
    ),
    byBusinessUnit: ranked(
      fold(
        converted,
        (r) => ({ key: r.business_unit_id, label: r.business_unit_label }),
        'Unassigned',
      ),
    ),
    bySubmitter: ranked(
      fold(converted, (r) => ({ key: r.submitter_id, label: r.submitter_label }), 'Unknown'),
    ),
  };
}
