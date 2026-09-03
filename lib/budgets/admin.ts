/**
 * VX4-5 part 3b — the budgets admin service.
 *
 * Every WRITE is gated with `requireModule(tx, 'budgets')` and every READ is not,
 * which is VX4-1's rule and MT-3's lesson: the gate lives below the router, and a
 * gated read would make "the module is off" indistinguishable from "there are no
 * budgets" — the AC-22 mistake, where a screen cannot say why it is empty because
 * asking is itself refused.
 *
 * `0025` already makes the DATA unreachable for a tenant without the module: the
 * RLS policy on every budget table carries `app_module_enabled('budgets')`. These
 * gates are the other half — the human sentence, produced before a write silently
 * writes nothing.
 *
 * ── Where the percent/basis-point conversion lives, and why only here ────────
 *
 * `budget_alert_threshold.threshold_bp` is basis points, so integer maths carries
 * all the way to `crossedThresholdBp` (a float would put 10000.00000001 on the
 * wrong side of 100%). But bp is a terrible thing to type: somebody meaning 90%
 * who writes `90` gets 0.9%, which is a legal value that alerts on the first
 * dollar, and no CHECK constraint can tell those apart. `0025` says so in a
 * comment and hands the problem here. `addThreshold` takes a PERCENT and is the
 * only place in the product that multiplies — so there is one conversion to get
 * right rather than one per caller.
 */
import type { QueryRunner } from '@/lib/db/client';
import { DomainError } from '@/lib/errors/domain';
import { requireModule } from '@/lib/modules/service';

const ORG = "NULLIF(current_setting('app.current_org', true), '')::uuid";

// The module code is written out at every call site rather than through a
// constant, and that is the guard's requirement rather than a style choice:
// `test/module-gates.test.ts` scans each gated function's TEXT for
// `requireModule(tx, '<code>')`, deliberately, so that a false PASS would need
// somebody to write the call and not mean it. A constant defeats the scan — the
// first version of this file used one, the gate was real, and the guard failed
// it anyway. That is the guard being right: what it can verify is the literal.

export type BudgetErrorCode =
  | 'NOT_FOUND'
  | 'INVALID_INPUT'
  | 'DUPLICATE_SCOPE'
  | 'DUPLICATE_THRESHOLD'
  | 'UNKNOWN_ACCOUNT'
  | 'NO_TENANT';

export class BudgetError extends DomainError {
  constructor(
    message: string,
    readonly code: BudgetErrorCode,
  ) {
    super(message);
    this.name = 'BudgetError';
  }
}

export interface BudgetPeriodView {
  id: string;
  starts_on: string;
  ends_on: string;
  amount_minor: string;
  actual_minor: string;
  pending_minor: string;
  unconvertible_minor: string;
  rolled_up_at: Date | null;
}

export interface BudgetThresholdView {
  id: string;
  threshold_bp: number;
  recipients: Array<{ id: string; user_id: string; display_name: string | null; email: string }>;
}

export interface BudgetView {
  id: string;
  name: string;
  gl_account_id: string;
  gl_account_number: string | null;
  gl_account_name: string | null;
  business_unit_id: string | null;
  business_unit_name: string | null;
  department_id: string | null;
  department_name: string | null;
  currency_code: string;
  minor_unit: number;
  fiscal_year: number;
  owner_id: string | null;
  owner_name: string | null;
  notes: string | null;
  periods: BudgetPeriodView[];
  thresholds: BudgetThresholdView[];
}

/* ── reads (deliberately ungated) ──────────────────────────────────────────── */

const SELECT_BUDGET = `
  SELECT b.id, b.name, b.gl_account_id, g.number AS gl_account_number, g.name AS gl_account_name,
         b.business_unit_id, bu.name AS business_unit_name,
         b.department_id, d.name AS department_name,
         b.currency_code, c.minor_unit, b.fiscal_year, b.owner_id,
         COALESCE(o.display_name, o.email) AS owner_name, b.notes
    FROM budget b
    JOIN currency c ON c.code = b.currency_code
    LEFT JOIN gl_account   g  ON g.id  = b.gl_account_id
    LEFT JOIN business_unit bu ON bu.id = b.business_unit_id
    LEFT JOIN department   d  ON d.id  = b.department_id
    LEFT JOIN app_user     o  ON o.id  = b.owner_id`;

/**
 * Every budget with its periods and thresholds.
 *
 * Three queries rather than one join: a budget joined to periods AND thresholds
 * is a cross product, and de-duplicating it in TypeScript is how a rollup total
 * gets counted twice. The row counts here are tens, not thousands.
 */
export async function listBudgets(tx: QueryRunner): Promise<BudgetView[]> {
  const budgets = await tx.query(`${SELECT_BUDGET} ORDER BY b.fiscal_year DESC, b.name`);
  if (budgets.rows.length === 0) return [];
  const ids = budgets.rows.map((b) => b.id as string);

  const periods = await tx.query(
    `SELECT id, budget_id, starts_on::text, ends_on::text, amount_minor, actual_minor,
            pending_minor, unconvertible_minor, rolled_up_at
       FROM budget_period WHERE budget_id = ANY($1::uuid[]) ORDER BY starts_on`,
    [ids],
  );
  const thresholds = await tx.query(
    `SELECT t.id, t.budget_id, t.threshold_bp,
            r.id AS recipient_id, r.user_id,
            u.display_name, u.email
       FROM budget_alert_threshold t
       LEFT JOIN budget_alert_recipient r ON r.threshold_id = t.id
       LEFT JOIN app_user u ON u.id = r.user_id
      WHERE t.budget_id = ANY($1::uuid[])
      ORDER BY t.threshold_bp, u.email`,
    [ids],
  );

  return budgets.rows.map((b) => {
    const thresholdMap = new Map<string, BudgetThresholdView>();
    for (const row of thresholds.rows) {
      if (row.budget_id !== b.id) continue;
      let held = thresholdMap.get(row.id as string);
      if (!held) {
        held = { id: row.id as string, threshold_bp: Number(row.threshold_bp), recipients: [] };
        thresholdMap.set(row.id as string, held);
      }
      // LEFT JOIN: a threshold with no recipients still gets its row, with none.
      if (row.recipient_id) {
        held.recipients.push({
          id: row.recipient_id as string,
          user_id: row.user_id as string,
          display_name: row.display_name as string | null,
          email: row.email as string,
        });
      }
    }
    return {
      ...(b as unknown as Omit<BudgetView, 'periods' | 'thresholds'>),
      minor_unit: Number(b.minor_unit),
      fiscal_year: Number(b.fiscal_year),
      periods: periods.rows
        .filter((p) => p.budget_id === b.id)
        .map((p) => p as unknown as BudgetPeriodView),
      thresholds: [...thresholdMap.values()],
    };
  });
}

export async function getBudget(tx: QueryRunner, budgetId: string): Promise<BudgetView | null> {
  const all = await listBudgets(tx);
  return all.find((b) => b.id === budgetId) ?? null;
}

/* ── writes (gated) ────────────────────────────────────────────────────────── */

export interface NewBudget {
  name: string;
  glAccountId: string;
  businessUnitId?: string | null;
  departmentId?: string | null;
  currencyCode: string;
  fiscalYear: number;
  ownerId?: string | null;
  notes?: string | null;
}

export async function createBudget(tx: QueryRunner, input: NewBudget): Promise<BudgetView> {
  await requireModule(tx, 'budgets');
  const name = input.name?.trim();
  if (!name) throw new BudgetError('a budget needs a name', 'INVALID_INPUT');
  if (!input.glAccountId) {
    throw new BudgetError(
      'a budget has to name a GL account — it is what makes the number reconcilable',
      'INVALID_INPUT',
    );
  }
  if (!Number.isInteger(input.fiscalYear) || input.fiscalYear < 1900 || input.fiscalYear > 2999) {
    throw new BudgetError('the fiscal year has to be a whole year like 2026', 'INVALID_INPUT');
  }

  let r;
  try {
    r = await tx.query(
      `INSERT INTO budget (organization_id, name, gl_account_id, business_unit_id, department_id,
                           currency_code, fiscal_year, owner_id, notes, created_by_id)
       VALUES (${ORG}, $1, $2, $3, $4, $5, $6, $7, $8,
               (SELECT id FROM app_user WHERE id = $7))
       RETURNING id`,
      [
        name,
        input.glAccountId,
        input.businessUnitId ?? null,
        input.departmentId ?? null,
        input.currencyCode,
        input.fiscalYear,
        input.ownerId ?? null,
        input.notes?.trim() || null,
      ],
    );
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === '23505') {
      // `budget_scope_unique` is NULLS NOT DISTINCT (0024/BG-1), so this fires for
      // the company-wide case too — which is the whole reason that clause is
      // there. Without it "the company-wide travel budget" could exist twice and
      // every total afterwards would be wrong with nothing on screen to show it.
      throw new BudgetError(
        'a budget already exists for that account and scope in that fiscal year — edit it instead',
        'DUPLICATE_SCOPE',
      );
    }
    if (code === '23503') {
      throw new BudgetError(
        'that GL account, business unit, department or owner is not in this organization',
        'UNKNOWN_ACCOUNT',
      );
    }
    throw err;
  }
  return (await getBudget(tx, r.rows[0].id as string))!;
}

export interface BudgetPatch {
  name?: string;
  ownerId?: string | null;
  notes?: string | null;
}

export async function updateBudget(
  tx: QueryRunner,
  budgetId: string,
  patch: BudgetPatch,
): Promise<BudgetView> {
  await requireModule(tx, 'budgets');
  const sets: string[] = [];
  const values: unknown[] = [budgetId];
  const set = (column: string, value: unknown) => {
    values.push(value);
    sets.push(`${column} = $${values.length}`);
  };
  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (!name) throw new BudgetError('a budget needs a name', 'INVALID_INPUT');
    set('name', name);
  }
  // Patch-with-nulls, matching updateReport and updateEmployee: an absent key
  // leaves the value, an explicit null clears it. Under COALESCE, unassigning an
  // owner would be impossible.
  if ('ownerId' in patch) set('owner_id', patch.ownerId ?? null);
  if ('notes' in patch) set('notes', patch.notes?.trim() || null);
  if (sets.length === 0) {
    const current = await getBudget(tx, budgetId);
    if (!current) throw new BudgetError('budget not found', 'NOT_FOUND');
    return current;
  }

  const done = await tx.query(
    `UPDATE budget SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`,
    values,
  );
  if (done.rowCount === 0) throw new BudgetError('budget not found', 'NOT_FOUND');
  return (await getBudget(tx, budgetId))!;
}

export async function deleteBudget(tx: QueryRunner, budgetId: string): Promise<void> {
  await requireModule(tx, 'budgets');
  // Periods, thresholds, recipients and alert claims all CASCADE (0024/0025).
  // A budget's history is not evidence anybody reconciles against — unlike an
  // audit entry or a posted bill — so it goes with it rather than being kept as
  // orphaned rows nothing can render.
  await tx.query('DELETE FROM budget WHERE id = $1', [budgetId]);
}

/**
 * Create consecutive calendar-month periods, each carrying the same amount.
 *
 * TWELVE IS A DEFAULT, NOT A CONSTANT — which is `0024`'s BG-5 decision made
 * usable. ExpenseOS hard-codes `MONTHS_IN_BUDGET_YEAR = 12` and rules 4-4-5 out;
 * here the count is an argument and the dates are rows, so a 4-4-5 calendar is a
 * different call to a different seeder rather than a migration.
 *
 * IDEMPOTENT, on `budget_period_start_unique`. Re-running adds only the months
 * that are missing and reports how many, the same shape `ensureDefaultPolicies`
 * uses — so a half-finished seed is finished rather than duplicated.
 */
export async function seedMonthlyPeriods(
  tx: QueryRunner,
  budgetId: string,
  input: { startsOn: string; months?: number; amountMinor: string | number | bigint },
): Promise<number> {
  await requireModule(tx, 'budgets');
  const months = input.months ?? 12;
  if (!Number.isInteger(months) || months < 1 || months > 53) {
    throw new BudgetError('a budget year is between 1 and 53 periods', 'INVALID_INPUT');
  }
  let amount: bigint;
  try {
    amount = BigInt(String(input.amountMinor).trim());
  } catch {
    throw new BudgetError('the amount must be a whole number of minor units', 'INVALID_INPUT');
  }
  if (amount < 0n) throw new BudgetError('a budget cannot be negative', 'INVALID_INPUT');

  // The month arithmetic is Postgres's, not JavaScript's: `+ interval '1 month'`
  // lands on the last day of a short month by itself, where a date built from
  // (year, month + n, day) in JS silently rolls 31 Jan into 3 March.
  const r = await tx.query(
    `INSERT INTO budget_period (organization_id, budget_id, starts_on, ends_on, amount_minor)
     SELECT ${ORG}, $1,
            ($2::date + make_interval(months => g))::date,
            ($2::date + make_interval(months => g + 1) - interval '1 day')::date,
            $3::bigint
       FROM generate_series(0, $4::int - 1) AS g
     ON CONFLICT (organization_id, budget_id, starts_on) DO NOTHING
     RETURNING id`,
    [budgetId, input.startsOn, amount.toString(), months],
  );
  return r.rows.length;
}

/* ── thresholds ────────────────────────────────────────────────────────────── */

/**
 * Percent to basis points, and the ONE place it happens.
 *
 * Accepts `90`, `90.5`, `99.99`. Refuses more than two decimals rather than
 * rounding them away — the same rule `parseAmountToMinor` follows, and for the
 * same reason: a threshold silently moved from what somebody typed is a threshold
 * nobody can explain later.
 */
export function percentToBp(input: string | number): number {
  const text = String(input).trim();
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(text)) {
    throw new BudgetError(
      `"${input}" is not a percentage — use a number like 90 or 99.5, with at most two decimals`,
      'INVALID_INPUT',
    );
  }
  const [whole, fraction = ''] = text.split('.');
  const bp = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (bp < 1 || bp > 20000) {
    throw new BudgetError('a threshold is between 0.01% and 200%', 'INVALID_INPUT');
  }
  return bp;
}

export async function addThreshold(
  tx: QueryRunner,
  budgetId: string,
  percent: string | number,
): Promise<string> {
  await requireModule(tx, 'budgets');
  const bp = percentToBp(percent);
  try {
    const r = await tx.query(
      `INSERT INTO budget_alert_threshold (organization_id, budget_id, threshold_bp)
       VALUES (${ORG}, $1, $2) RETURNING id`,
      [budgetId, bp],
    );
    return r.rows[0].id as string;
  } catch (err) {
    if ((err as { code?: string }).code === '23505') {
      throw new BudgetError(
        'that threshold is already configured for this budget',
        'DUPLICATE_THRESHOLD',
      );
    }
    throw err;
  }
}

export async function removeThreshold(tx: QueryRunner, thresholdId: string): Promise<void> {
  await requireModule(tx, 'budgets');
  // Recipients cascade. The alert CLAIMS do not hang off the threshold — they are
  // keyed on (period, threshold_bp) — so removing a level and adding it back
  // leaves the period's history intact rather than silently re-alerting for a
  // crossing somebody was already told about.
  await tx.query('DELETE FROM budget_alert_threshold WHERE id = $1', [thresholdId]);
}

export async function addRecipient(
  tx: QueryRunner,
  thresholdId: string,
  userId: string,
): Promise<void> {
  await requireModule(tx, 'budgets');
  // Idempotent: adding somebody twice is a double-click, not an error worth a
  // banner. The owner is notified whether or not they are listed here.
  await tx.query(
    `INSERT INTO budget_alert_recipient (organization_id, threshold_id, user_id)
     VALUES (${ORG}, $1, $2)
     ON CONFLICT (organization_id, threshold_id, user_id) DO NOTHING`,
    [thresholdId, userId],
  );
}

export async function removeRecipient(tx: QueryRunner, recipientId: string): Promise<void> {
  await requireModule(tx, 'budgets');
  await tx.query('DELETE FROM budget_alert_recipient WHERE id = $1', [recipientId]);
}
