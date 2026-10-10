/**
 * Stamping a line's GL account from its category.
 *
 * One helper, in the shared package, because FOUR places write expense line items —
 * the tRPC create, the tRPC update, the worker's extraction prefill, and the
 * worker's determination rebuild. Four copies of "look up the category's account"
 * is how three of them end up correct and the fourth quietly writes null; that
 * already happened once in this codebase with the two mileage forms, and the cost
 * was a wrong reimbursement nobody could see.
 *
 * The stamp is a SNAPSHOT, not a cache. Re-pointing a category's GL account must not
 * restate lines that were already filed and posted — the same rule the FX rate and
 * the tax figures follow. Which means: stamp on write, and never refresh.
 */

// VeloExpense: VeloExpense's generated client (lib/generated/prisma).
import type { PrismaClient } from '@/lib/generated/prisma/client';

type Db = Pick<PrismaClient, 'expenseCategory'>;

/**
 * GL account ids for a set of categories, keyed by category id.
 *
 * Batched because the worker writes a whole expense's lines at once, and one query
 * per line would turn a five-line receipt into six round-trips.
 *
 * A category with no account maps to `null` — a real answer, not an omission. The
 * caller writes the null rather than skipping the field, so a line whose category
 * was unmapped at write time is distinguishable from one that was never stamped.
 */
export async function glAccountIdsForCategories(
  db: Db,
  categoryIds: readonly string[],
): Promise<Map<string, string | null>> {
  const unique = [...new Set(categoryIds.filter(Boolean))];
  if (unique.length === 0) return new Map();
  const rows = await db.expenseCategory.findMany({
    where: { id: { in: unique } },
    // VeloExpense: through the account row, not the category's column — see below.
    select: { id: true, glAccount: { select: { id: true } } },
  });
  return new Map(rows.map((r) => [r.id, r.glAccount?.id ?? null]));
}

/**
 * The GL account id to stamp on one line.
 *
 * Null when the category has none, or when the category has vanished — neither is
 * worth failing a write over. An employee filing an expense cannot fix a GL mapping,
 * and refusing their line because an admin has not finished configuring the chart
 * would block work on a problem they do not own.
 *
 * VeloExpense (w2-02b): read THROUGH the account row (`glAccount`) rather than off the
 * category's `gl_account_id`. VeloExpense's chart is gated on the accounting module in
 * the database (0022): with the module off its rows are invisible, and VeloExpense's own
 * `accountForCategory` (lib/accounts/service.ts) stamps null — "a tenant without
 * accounting files expenses with no GL coding, which is the truth". Read off the column,
 * the id of an account the tenant cannot see went into the line and the insert failed on
 * its foreign key: every line a tenant without accounting tried to add on the workbench
 * was refused (modules-flow, w2-02b).
 */
export async function glAccountIdForCategory(db: Db, categoryId: string): Promise<string | null> {
  const row = await db.expenseCategory.findUnique({
    where: { id: categoryId },
    select: { glAccount: { select: { id: true } } },
  });
  return row?.glAccount?.id ?? null;
}
