import type { PrismaClient } from '@expenseos/db';
import { permissions as P, type RbacUser } from '@expenseos/rbac';

/**
 * True if the caller can view the target user's profile.
 *
 * Visibility rule (any of):
 *   - caller holds `user.read.all` (admins / EAs)
 *   - target is the caller (self)
 *   - target sits anywhere in the caller's DOWNWARD reporting chain
 *     (recursive direct reports, transitive any depth)
 *
 * Implementation uses a recursive CTE so the entire chain is walked
 * in a single round-trip. Depth is capped at 20 levels to defend
 * against accidental cycles in the data.
 *
 * Ported from ExpenseOS `server/lib/canViewUser.ts` (1e682dd6), People 1. VeloExpense: the
 * raw SQL names `app_user` and its snake_case columns; RLS keeps the walk in the tenant.
 */
export async function canViewUser(
  db: PrismaClient,
  caller: RbacUser,
  targetId: string,
): Promise<boolean> {
  if (caller.permissions.includes(P.user.readAll)) return true;
  if (caller.id === targetId) return true;

  const rows = await db.$queryRaw<Array<{ visible: boolean }>>`
    WITH RECURSIVE chain AS (
      -- Start with the caller themselves.
      SELECT id, 0 AS depth FROM app_user WHERE id = ${caller.id}::uuid
      UNION ALL
      -- Walk DOWN: pick up any user whose manager is already in the chain.
      SELECT u.id, c.depth + 1
      FROM app_user u
      JOIN chain c ON u.manager_id = c.id
      WHERE c.depth < 20
    )
    SELECT EXISTS (SELECT 1 FROM chain WHERE id = ${targetId}::uuid) AS visible;
  `;
  return rows[0]?.visible === true;
}
