import type { Prisma, PrismaClient } from '@/lib/generated/prisma/client';

type Db = PrismaClient | Prisma.TransactionClient;

/** The last resort when a tenant has no legal entity with a currency at all. */
export const LAST_RESORT_CURRENCY = 'CAD';

/**
 * A person's home currency: their legal entity's; if they have none, the tenant's main
 * legal entity's (the oldest active one with a currency); CAD only when the tenant has none.
 *
 * VeloExpense (12 Oct 2026, f29): ONE answer for two questions ExpenseOS answers differently.
 * Starting a report from receipts fell back to USD (`resolveIntakeCurrencyId`, ExpenseOS's
 * rule) while the currency a reader's totals are converted into fell back to CAD
 * (`readerCurrencyCode`, also ExpenseOS's) — so somebody with no legal entity opened every
 * receipt-started report in USD and then read it as "no exchange rate to USD for CAD". The
 * tenant's main entity is the right fallback for a tenant in any country; CAD remains only
 * for a tenant that has configured no entity.
 *
 * Reads under the caller's tenant scope (RLS), so "the tenant" is the one in scope.
 */
export async function homeCurrencyCode(db: Db, userId: string): Promise<string> {
  const me = await db.user.findUnique({
    where: { id: userId },
    select: { entity: { select: { homeCurrencyId: true } } },
  });
  if (me?.entity?.homeCurrencyId) return me.entity.homeCurrencyId;
  const main = await db.legalEntity.findFirst({
    where: { active: true, homeCurrencyId: { not: null } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { homeCurrencyId: true },
  });
  return main?.homeCurrencyId ?? LAST_RESORT_CURRENCY;
}
