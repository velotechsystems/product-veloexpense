/**
 * VX4-5 part 2 — the budget rollup, and the snapshot loader the policy rule reads.
 *
 * ── BG-3, and what we are deliberately NOT porting ──────────────────────────
 *
 * ExpenseOS's `computeActuals` (`packages/approvals/src/budgets.ts:205-343`)
 * scans a whole fiscal year of expenses and card transactions on EVERY approval
 * decision, apportions live, stores nothing, and loads every FX rate ever fetched
 * — unbounded — per call. It runs inside `loadSubject`, so it fires on every
 * `startInstance`, every `decide` and every expiry sweep.
 *
 * Ours stores the totals on `budget_period` and recomputes them DELIBERATELY, on
 * the transitions that can change them, bounded to the periods the report in hand
 * actually touches. A report filed in March never recomputes November.
 *
 * ── The transitions that change a total, and the one that does not ──────────
 *
 * `budget_period.pending_minor` is SUBMITTED spend; `actual_minor` is APPROVED
 * and beyond. So membership changes on:
 *   · submit          DRAFT → SUBMITTED          (enters pending)
 *   · recall          SUBMITTED/RETURNED → DRAFT (leaves pending)
 *   · a decision      SUBMITTED → APPROVED / REJECTED / RETURNED
 *
 * and NOT on reimbursement: APPROVED and REIMBURSED both count as actual, so
 * `reimburseReport` has nothing to recompute. That is a claim rather than an
 * omission, so `test/budgets.db.test.ts` asserts the totals do not move across
 * a reimbursement — if the mapping above ever changes, that test fails rather
 * than the numbers quietly drifting.
 *
 * A report's AMOUNTS cannot change outside DRAFT (`assertDraft` is the single
 * write gate, VX1-6), so there is no fourth trigger hiding in the expense writes.
 *
 * ── Dating a line, and why the fallback is `created_at` ─────────────────────
 *
 * `expense.txn_date` is nullable. A line with no date still has to land in a
 * period or the totals silently under-report, which is the AN-7 family. The
 * fallback is `created_at::date` — when it was entered — chosen because it is
 * DETERMINISTIC and IMMUTABLE. `current_date` would make a budget total change
 * on its own overnight, and `submitted_at` moves when a report is recalled and
 * resubmitted. The rollup and the rule use the same expression, so the number
 * the submitter is warned about is the number the rollup then stores.
 */
import type { QueryRunner } from '@/lib/db/client';
import { convertMinor } from '@/lib/money';
import { buildRateLookup, type RateLookup, type RateRow } from '@/lib/fx/rates';
import { resolveBudget, type BudgetScope, type BudgetSnapshot } from '@/lib/budgets/scope';
import { COMMITTED_STATUSES, COUNTED_STATUSES } from '@/lib/spend/statuses';
import { fireThresholdAlerts, type AlertOutcome } from '@/lib/budgets/alerts';

/**
 * Statuses whose spend is counted, and the bucket each falls in.
 *
 * IMPORTED, not declared. This was a private `COUNTED` array here until VX4-6
 * needed the same answer for analytics — and AN-7's real lesson is that their two
 * halves disagreed about what was reportable precisely because each decided for
 * itself. `lib/spend/statuses.ts` is the one statement both read.
 */

/**
 * The date a line is attributed by — see the header. Written once, used by both
 * the rollup and the loader, because two copies of this expression is how they
 * become two different answers.
 */
const ON_DATE = `COALESCE(e.txn_date, e.created_at::date)`;

interface PeriodRow {
  budget_id: string;
  budget_name: string;
  gl_account_id: string;
  business_unit_id: string | null;
  department_id: string | null;
  currency_code: string;
  minor_unit: number;
  period_id: string;
  starts_on: string;
  ends_on: string;
  amount_minor: string;
  actual_minor: string;
  pending_minor: string;
  unconvertible_minor: string;
  rolled_up_at: Date | null;
}

interface SpendRow {
  gl_account_id: string;
  amount_minor: string;
  on_date: string;
  currency_code: string;
  business_unit_id: string | null;
  department_id: string | null;
  status: string;
}

function dateOnly(value: string | Date): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}

/**
 * Rate lookups bounded by each expense's OWN date, memoized per date.
 *
 * Not one lookup for the whole rollup: a budget compared against re-converted
 * history moves every time a new rate row arrives, and `lib/fx/rates.ts`'s
 * first property — latest on or before — is what stops that. ExpenseOS reaches
 * the same place from the other side, preferring the rate snapshot the expense
 * carried when it was filed; we have no per-expense snapshot column, so bounding
 * by the expense's date is the nearest stable equivalent.
 */
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

/** Minor units per currency code, for conversion. */
async function minorUnits(tx: QueryRunner): Promise<Record<string, number>> {
  const r = await tx.query('SELECT code, minor_unit FROM currency');
  const out: Record<string, number> = {};
  for (const row of r.rows) out[row.code as string] = Number(row.minor_unit);
  return out;
}

async function rateRows(tx: QueryRunner): Promise<RateRow[]> {
  const r = await tx.query('SELECT base, quote, rate, as_of FROM fx_rate ORDER BY as_of DESC, fetched_at DESC');
  return r.rows as RateRow[];
}

/** The accounts and the date span one report reaches. Empty when it budgets nothing. */
async function footprint(
  tx: QueryRunner,
  reportId: string,
): Promise<{ accountIds: string[]; earliest: string; latest: string } | null> {
  const r = await tx.query(
    `SELECT array_agg(DISTINCT li.gl_account_id) AS accounts,
            min(${ON_DATE})::text AS earliest,
            max(${ON_DATE})::text AS latest
       FROM expense_line_item li
       JOIN expense e ON e.id = li.expense_id
      WHERE e.report_id = $1 AND li.gl_account_id IS NOT NULL`,
    [reportId],
  );
  const row = r.rows[0];
  if (!row?.accounts || row.accounts.length === 0) return null;
  return { accountIds: row.accounts as string[], earliest: row.earliest, latest: row.latest };
}

/**
 * Every budget period overlapping a date span on any of a set of accounts.
 *
 * ALL budgets on those accounts, not only the ones matching the report's own
 * business unit and department — `resolveBudget` needs the full candidate set to
 * pick the most specific match, and narrowing here would hand it a company-wide
 * budget while hiding the department budget that should have won.
 *
 * The ORDER BY is for determinism rather than presentation: two budgets for the
 * same scope in overlapping fiscal years is a data error, and `resolveBudget`'s
 * `find` would otherwise answer according to whatever order the planner chose.
 */
async function periodsOverlapping(
  tx: QueryRunner,
  accountIds: string[],
  earliest: string,
  latest: string,
): Promise<PeriodRow[]> {
  const r = await tx.query(
    `SELECT b.id AS budget_id, b.name AS budget_name, b.gl_account_id,
            b.business_unit_id, b.department_id, b.currency_code, c.minor_unit,
            p.id AS period_id, p.starts_on::text, p.ends_on::text,
            p.amount_minor, p.actual_minor, p.pending_minor, p.unconvertible_minor,
            p.rolled_up_at
       FROM budget b
       JOIN budget_period p ON p.budget_id = b.id
       JOIN currency c ON c.code = b.currency_code
      WHERE b.gl_account_id = ANY($1::uuid[])
        AND p.starts_on <= $3::date AND p.ends_on >= $2::date
      ORDER BY b.fiscal_year, b.id, p.starts_on`,
    [accountIds, earliest, latest],
  );
  return r.rows as PeriodRow[];
}

function scopesOf(periods: PeriodRow[]): BudgetScope[] {
  const seen = new Map<string, BudgetScope>();
  for (const p of periods) {
    if (seen.has(p.budget_id)) continue;
    seen.set(p.budget_id, {
      id: p.budget_id,
      glAccountId: p.gl_account_id,
      businessUnitId: p.business_unit_id,
      departmentId: p.department_id,
      currencyCode: p.currency_code,
    });
  }
  return [...seen.values()];
}

/** The period of `budgetId` covering `on`, if there is one. */
function periodCovering(periods: PeriodRow[], budgetId: string, on: string): PeriodRow | null {
  return (
    periods.find((p) => p.budget_id === budgetId && p.starts_on <= on && p.ends_on >= on) ?? null
  );
}

interface Totals {
  actual: bigint;
  pending: bigint;
  unconvertible: bigint;
}

/**
 * Recompute the stored rollup for every period this report touches.
 *
 * Called ON THE TRANSITION, in the transaction that performs it — the shape AC-6
 * established for the ledger hand-off, and for the same reason: a hook on the
 * transition cannot be forgotten by a new caller, where a hook in four callers
 * plus a sweep already has been (ExpenseOS's post was "silently never sent to
 * NetSuite" for a report that auto-approved on submit).
 *
 * Returns the number of periods rewritten and what the alert pass did, which is
 * what the tests assert on.
 *
 * VX4-5 part 3a: THIS is where threshold alerts fire, and `recomputePeriods` below
 * deliberately does not. The distinction is that this function is the transition
 * hook — it runs because spend actually moved — where the loader's first-sight
 * recompute is a lazy initialisation of a baseline. Firing there would alert on
 * history the moment somebody opened a draft, attributed to whoever was editing.
 */
export async function recomputeForReport(
  tx: QueryRunner,
  reportId: string,
  actorId: string | null = null,
): Promise<{ periods: number; alerts: AlertOutcome }> {
  const none = { periods: 0, alerts: { fired: 0, rearmed: 0 } };
  const reach = await footprint(tx, reportId);
  if (!reach) return none;
  const periods = await periodsOverlapping(tx, reach.accountIds, reach.earliest, reach.latest);
  if (periods.length === 0) return none;
  const rewritten = await recomputePeriods(tx, periods);
  const alerts = await fireThresholdAlerts(
    tx,
    periods.map((p) => p.period_id),
    actorId,
  );
  return { periods: rewritten, alerts };
}

/**
 * The recompute itself, over an already-selected set of periods.
 *
 * The spend query is bounded by the union of those periods' dates and by the
 * accounts they budget — not by a fiscal year, and not by "every expense". A
 * report that touches one month recomputes one month.
 */
async function recomputePeriods(tx: QueryRunner, periods: PeriodRow[]): Promise<number> {
  const scopes = scopesOf(periods);
  const accountIds = [...new Set(scopes.map((s) => s.glAccountId))];
  const from = periods.reduce((a, p) => (p.starts_on < a ? p.starts_on : a), periods[0].starts_on);
  const to = periods.reduce((a, p) => (p.ends_on > a ? p.ends_on : a), periods[0].ends_on);

  const spend = await tx.query(
    `SELECT li.gl_account_id, li.amount_minor, ${ON_DATE}::text AS on_date,
            e.currency_code, r.business_unit_id, r.department_id, r.status::text AS status
       FROM expense_report r
       JOIN expense e ON e.report_id = r.id
       JOIN expense_line_item li ON li.expense_id = e.id
      WHERE r.status = ANY($1::expense_report_status[])
        AND li.gl_account_id = ANY($2::uuid[])
        AND ${ON_DATE} BETWEEN $3::date AND $4::date`,
    [COUNTED_STATUSES, accountIds, from, to],
  );

  const units = await minorUnits(tx);
  const lookupFor = rateLookups(await rateRows(tx));

  const totals = new Map<string, Totals>();
  const bump = (periodId: string, key: keyof Totals, amount: bigint) => {
    const cur = totals.get(periodId) ?? { actual: 0n, pending: 0n, unconvertible: 0n };
    cur[key] += amount;
    totals.set(periodId, cur);
  };

  for (const row of spend.rows as SpendRow[]) {
    // The STAMPED department, never the submitter's current one. Everything in
    // this query is past DRAFT, so `department_id` was written at submit — and
    // reaching through to `app_user` here would undo the whole point of stamping
    // it, letting a transfer rewrite a closed period's totals (0024's header).
    const budget = resolveBudget(
      scopes,
      row.gl_account_id,
      row.business_unit_id,
      row.department_id,
    );
    if (!budget) continue;
    const period = periodCovering(periods, budget.id, row.on_date);
    if (!period) continue;

    // PENDING vs COMMITTED from the shared statement rather than a literal, so a
    // status moving between buckets moves for analytics at the same time. Renamed
    // from `committed` while doing it: that variable was true for SUBMITTED and
    // fed `committed ? 'pending' : 'actual'`, so it meant the opposite of its name.
    const isPending = !(COMMITTED_STATUSES as readonly string[]).includes(row.status);
    const amount = BigInt(row.amount_minor);
    const hit = lookupFor(row.on_date).find(row.currency_code, budget.currencyCode);
    if (!hit) {
      // NEVER folded into actual or pending. AN-7 is exactly this branch done
      // wrong: their analytics adds the unconverted amount as if it were already
      // in base currency, so "I have no rate for this" is reported as "you are
      // under budget".
      bump(period.period_id, 'unconvertible', amount);
      continue;
    }
    const converted = convertMinor(
      amount,
      hit.scaled,
      units[row.currency_code] ?? 2,
      units[budget.currencyCode] ?? 2,
    );
    bump(period.period_id, isPending ? 'pending' : 'actual', converted);
  }

  // Every period in the set is written, including the ones that came back empty.
  // A period that HAD spend and no longer does has to fall back to zero, and it
  // has to end up with a non-NULL `rolled_up_at` either way: "calculated, and the
  // answer is nothing" is the state `rolled_up_at` exists to distinguish from
  // "never calculated".
  for (const p of periods) {
    const t = totals.get(p.period_id) ?? { actual: 0n, pending: 0n, unconvertible: 0n };
    await tx.query(
      `UPDATE budget_period
          SET actual_minor = $2, pending_minor = $3, unconvertible_minor = $4,
              rolled_up_at = now(), updated_at = now()
        WHERE id = $1`,
      [p.period_id, t.actual.toString(), t.pending.toString(), t.unconvertible.toString()],
    );
  }
  return periods.length;
}

/**
 * The budget half of `PolicyContext`, for one report.
 *
 * Returns [] when the report codes nothing to a budgeted account — the normal
 * case — so the rule iterates an empty list rather than branching on null.
 *
 * ── Why this may WRITE ──────────────────────────────────────────────────────
 *
 * A period whose `rolled_up_at` is NULL has never been calculated, which is NOT
 * the same as zero spend (0024 says so in a column comment and enforces it with
 * `budget_period_totals_need_a_rollup`). Reading one as a baseline would answer
 * "you are under budget" for a period that might be fully committed.
 *
 * So a never-calculated period is recomputed here, on first sight, once. That is
 * bounded — every period pays it at most once, and the transition hooks keep it
 * fresh afterwards — and it is emphatically not BG-3's recompute-on-every-read.
 * `validateReport` already writes (it reconciles `policy_violation`) and already
 * runs only on write paths, so this adds no new class of side effect.
 *
 * The consequence is a guarantee the rule depends on: a snapshot never rests on
 * an uncalculated period, so `BudgetSnapshot` carries no `rolledUpAt` and the
 * rule has no branch for one. A branch that can never be taken hides every defect
 * in the outcome it cannot produce.
 */
export async function loadBudgetSnapshots(
  tx: QueryRunner,
  reportId: string,
): Promise<BudgetSnapshot[]> {
  const reach = await footprint(tx, reportId);
  if (!reach) return [];
  let periods = await periodsOverlapping(tx, reach.accountIds, reach.earliest, reach.latest);
  if (periods.length === 0) return [];

  const never = periods.filter((p) => p.rolled_up_at === null);
  if (never.length > 0) {
    await recomputePeriods(tx, never);
    periods = await periodsOverlapping(tx, reach.accountIds, reach.earliest, reach.latest);
  }

  // The dimensions THIS report will count against. `department_id` is NULL while
  // the report is a DRAFT and is stamped at submit, so the coalesce reads the
  // value that WILL be stamped — otherwise the warning shown at submit time would
  // be computed against a different department from the rollup that follows it.
  // Once stamped, the stamp wins, which is what makes this correct for a report
  // in any status.
  const dims = await tx.query(
    `SELECT r.business_unit_id,
            COALESCE(r.department_id,
                     (SELECT u.department_id FROM app_user u WHERE u.id = r.submitter_id))
              AS department_id
       FROM expense_report r WHERE r.id = $1`,
    [reportId],
  );
  const businessUnitId = (dims.rows[0]?.business_unit_id as string | null) ?? null;
  const departmentId = (dims.rows[0]?.department_id as string | null) ?? null;

  const lines = await tx.query(
    `SELECT li.gl_account_id, li.amount_minor, ${ON_DATE}::text AS on_date, e.currency_code
       FROM expense_line_item li
       JOIN expense e ON e.id = li.expense_id
      WHERE e.report_id = $1 AND li.gl_account_id IS NOT NULL`,
    [reportId],
  );

  const scopes = scopesOf(periods);
  const units = await minorUnits(tx);
  const lookupFor = rateLookups(await rateRows(tx));

  const own = new Map<string, { minor: bigint; missing: Set<string> }>();
  for (const row of lines.rows as SpendRow[]) {
    const budget = resolveBudget(scopes, row.gl_account_id, businessUnitId, departmentId);
    if (!budget) continue;
    const period = periodCovering(periods, budget.id, row.on_date);
    if (!period) continue;
    const cur = own.get(period.period_id) ?? { minor: 0n, missing: new Set<string>() };
    const hit = lookupFor(row.on_date).find(row.currency_code, budget.currencyCode);
    if (!hit) cur.missing.add(row.currency_code);
    else
      cur.minor += convertMinor(
        BigInt(row.amount_minor),
        hit.scaled,
        units[row.currency_code] ?? 2,
        units[budget.currencyCode] ?? 2,
      );
    own.set(period.period_id, cur);
  }

  // Only the periods this report actually lands in. A budget whose period this
  // report does not touch is not this report's business, and warning about it
  // would make every submission a report on the whole company.
  const out: BudgetSnapshot[] = [];
  for (const p of periods) {
    const mine = own.get(p.period_id);
    if (!mine) continue;
    out.push({
      budgetId: p.budget_id,
      budgetName: p.budget_name,
      periodId: p.period_id,
      startsOn: dateOnly(p.starts_on),
      endsOn: dateOnly(p.ends_on),
      currencyCode: p.currency_code,
      minorUnit: Number(p.minor_unit),
      amountMinor: BigInt(p.amount_minor),
      actualMinor: BigInt(p.actual_minor),
      pendingMinor: BigInt(p.pending_minor),
      unconvertibleMinor: BigInt(p.unconvertible_minor),
      reportMinor: mine.minor,
      reportMissingRateFrom: [...mine.missing].sort(),
    });
  }
  return out;
}
