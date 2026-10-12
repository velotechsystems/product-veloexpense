/**
 * VeloExpense (Wave 2): VeloExpense's `pg` services, called from inside a Prisma tenant
 * transaction — on the SAME transaction.
 *
 * Ported ExpenseOS code runs on Prisma (`withTenantDb`, lib/db/prisma.ts). VeloExpense's
 * own domain services — the plan caps (lib/billing/caps.ts), approval eligibility
 * (lib/approvals), the report lifecycle the ported submit calls until Wave 4 (d23) — take
 * a `pg` `QueryRunner`. A ported procedure that must keep one of VeloExpense's rules (the
 * expense cap on a new expense, say) has to run that service inside its own transaction:
 * a second connection would count, lock and check outside the write it guards, which is
 * exactly the race those services take their locks to close.
 *
 * So this presents the Prisma transaction AS a `QueryRunner`. The SQL and its `$n`
 * parameters are the caller's, passed to Postgres as a parameterised statement exactly as
 * `pg` would pass them — this file never builds SQL from values. That is why it is the one
 * file `check:prisma-scope` lets use Prisma's `$queryRawUnsafe` / `$executeRawUnsafe`: the
 * "unsafe" in those names is about a caller interpolating values into the text, and the
 * services that come through here never do (the same contract as their `pg` call sites).
 *
 * Differences from `pg`, which a service called through here must not depend on:
 *   · int8 and numeric come back as strings, as `pg` returns them (normalised below), but
 *     `date` columns come back as `Date` (VeloExpense's `pg` parser returns them as text);
 *   · `rowCount` is the number of rows returned for a statement that returns rows
 *     (SELECT / WITH / RETURNING), and Postgres's affected-row count otherwise.
 */
import type { QueryRunner } from '@/lib/db/client';
import { Prisma, type TenantDb } from '@/lib/db/prisma';

/** Does this statement hand rows back? Leading SELECT/WITH/VALUES/TABLE, or a RETURNING clause. */
function returnsRows(text: string): boolean {
  const body = text.replace(/--[^\n]*/g, ' ').trim();
  return /^(select|with|values|table)\b/i.test(body) || /\breturning\b/i.test(body);
}

/** `pg`'s shapes for the two types Prisma's raw client returns differently. */
function pgValue(v: unknown): unknown {
  if (typeof v === 'bigint') return v.toString();
  if (v instanceof Prisma.Decimal) return v.toString();
  return v;
}

/** Each bridged runner's Prisma transaction, for `tenantDbOf`. */
const sources = new WeakMap<object, TenantDb>();

/** The tenant transaction `tx`, as the `QueryRunner` VeloExpense's `pg` services take. */
export function queryRunnerOf(tx: TenantDb): QueryRunner {
  const runner = {
    async query(text: string, values: readonly unknown[] = []) {
      if (returnsRows(text)) {
        const raw = await tx.$queryRawUnsafe<Record<string, unknown>[]>(text, ...values);
        const rows = raw.map((r) =>
          Object.fromEntries(Object.entries(r).map(([k, v]) => [k, pgValue(v)])),
        );
        return { rows, rowCount: rows.length };
      }
      const rowCount = await tx.$executeRawUnsafe(text, ...values);
      return { rows: [], rowCount };
    },
  };
  sources.set(runner, tx);
  return runner as unknown as QueryRunner;
}

/**
 * w4-00c: the Prisma transaction behind a runner `queryRunnerOf` made, or null for a plain
 * `pg` transaction (`withOrg`).
 *
 * For the report lifecycle (`lib/expenses/lifecycle.ts`), which is `pg` code and must start
 * and stop ExpenseOS's approval engine, which is Prisma code, IN THE SAME TRANSACTION as the
 * status it writes. A runner from `withOrg` is a different connection: the engine there would
 * wait on the report row the lifecycle has locked. So the lifecycle asks for the transaction
 * it was really given, and refuses a runner that has none.
 */
export function tenantDbOf(runner: QueryRunner): TenantDb | null {
  return sources.get(runner as unknown as object) ?? null;
}
