import type { PrismaClient } from '@expenseos/db';

/**
 * Directory scopes — match the `scope` chip group on /users.
 *
 *   all      — every employee in the org (admin only).
 *   direct   — caller's direct reports (managerId = caller.id).
 *   indirect — caller's chain at depth >= 2 (reports of reports, …).
 *   chain    — caller's direct + indirect reports (everyone below them).
 *   self     — only the caller.
 */
export type DirectoryScope = 'all' | 'direct' | 'indirect' | 'chain' | 'self';

/*
 * Ported from ExpenseOS `server/lib/userScope.ts` (1e682dd6). The type came first (Wave 0,
 * for the table chrome); `resolveScopedIds` arrived with the People port (People 1).
 * VeloExpense: the raw SQL names `app_user` and its snake_case columns, and runs inside the
 * caller's tenant transaction, so RLS keeps the walk inside the tenant.
 */

const MAX_CHAIN_DEPTH = 20;

/**
 * Resolves a scope to a concrete set of user IDs the caller is allowed
 * to see for that scope. Returns `null` for `scope: 'all'` (no
 * restriction; the caller's permission to use 'all' is enforced at the
 * router boundary, not here).
 *
 * For 'chain' and 'indirect' we run a depth-bounded recursive CTE
 * walking *down* the manager tree starting from the caller. The CTE
 * tracks `depth` so 'indirect' is a one-line filter (`depth >= 2`).
 */
export async function resolveScopedIds(
  db: PrismaClient,
  callerId: string,
  scope: DirectoryScope,
): Promise<string[] | null> {
  if (scope === 'all') return null;
  if (scope === 'self') return [callerId];

  if (scope === 'direct') {
    const rows = await db.user.findMany({
      where: { managerId: callerId, deletedAt: null },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }

  // 'chain' or 'indirect' — recursive CTE walking down.
  const minDepth = scope === 'indirect' ? 2 : 1;
  const rows = await db.$queryRaw<Array<{ id: string }>>`
    WITH RECURSIVE downward AS (
      SELECT id, 0 AS depth FROM app_user WHERE id = ${callerId}::uuid
      UNION ALL
      SELECT u.id, d.depth + 1 FROM app_user u
      JOIN downward d ON u.manager_id = d.id
      WHERE d.depth < ${MAX_CHAIN_DEPTH} AND u.deleted_at IS NULL
    )
    SELECT id FROM downward WHERE depth >= ${minDepth};
  `;
  return rows.map((r) => r.id);
}
