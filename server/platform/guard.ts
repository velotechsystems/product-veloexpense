import { notFound } from 'next/navigation';
import { shellContext } from '@/server/shell';

/**
 * Ported from ExpenseOS `apps/web/src/server/platform/guard.ts`: a page whose module is
 * not active is a 404, not a page that half-works.
 *
 * VeloExpense: ExpenseOS asks `isModuleActive(db, slug)` against its one database. Here
 * the answer depends on the reader's tenant, and the request's shell context
 * (server/shell.ts) has already resolved this tenant's active modules — `cache()`d, so
 * asking again costs nothing. No shell (no session, not a member) is a 404 too.
 */
export async function requireActiveModule(slug: string): Promise<void> {
  const shell = await shellContext();
  if (!shell?.activeModules.has(slug)) notFound();
}
