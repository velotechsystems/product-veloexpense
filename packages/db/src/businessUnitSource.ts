/**
 * Which business unit column wins — decided here, once.
 *
 * VeloExpense: ExpenseOS's module, in the one position VeloExpense has. ExpenseOS can code
 * an allocation to an admin business unit (`businessUnitId`) or to a row of its NetSuite
 * business unit mirror, and a hidden integration config key picks which is the source of
 * truth: `EXPENSEOS` (the admin business unit only — what it does where NetSuite is not
 * configured) or its NetSuite position. VeloExpense codes to its own business units and
 * has no mirror, so it is always in `EXPENSEOS`; the type keeps ExpenseOS's name so the
 * ported callers, which take the source as a REQUIRED parameter, carry over unchanged.
 * The NetSuite position's helpers (the alias lookups and `pickBusinessUnit`) are not
 * ported: nothing in VeloExpense could reach them.
 */

import type { Prisma, PrismaClient } from '@/lib/generated/prisma/client';
import type { CodingDefaults } from './expenseCodingDefaults';

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * `EXPENSEOS` — the admin `businessUnitId` is the only business unit. What the product did
 * before the NetSuite column existed, and the answer wherever NetSuite is not configured
 * at all.
 */
export type BusinessUnitSource = 'EXPENSEOS';

/** What `codingDefaultsFor` reads off the person filing: their stored coding. */
export type CodingDefaultsUser = CodingDefaults;

/**
 * The shape of the resolver that turns a person's stored coding into the defaults a new
 * expense carries under a given source. `codingDefaultsFor` below is the one
 * implementation; the type stays exported so a caller can name it.
 */
export type CodingDefaultsFor = (
  db: Db,
  user: CodingDefaultsUser | null,
  source: BusinessUnitSource,
) => Promise<CodingDefaults | null>;

/**
 * The coding a new expense starts with, resolved for the business unit source (FR-4, FR-5).
 *
 * `EXPENSEOS` — the person's stored columns, exactly as before the NetSuite column
 * existed. No query runs.
 *
 * The answer is what `defaultAllocationFrom` is handed, with the same `source`.
 */
export const codingDefaultsFor: CodingDefaultsFor = async (_db, user, _source) => {
  if (!user) return null;
  const { businessUnitId, departmentId } = user;
  return { businessUnitId, departmentId };
};
