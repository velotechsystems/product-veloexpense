import 'server-only';
import { withTenantDb } from '@/lib/db/prisma';

/**
 * VeloExpense: the two facts `IdentityChips` reads from ExpenseOS's `users.get` — the
 * reader's role label and department label, both locale-keyed — which VeloExpense has no
 * router for (its people screens are VeloExpense's own until the directory is ported).
 *
 * The reader's own row only, in their own tenant (RLS), so there is no `canViewUser` to
 * consult. The shape is the slice of ExpenseOS's `users.get` result that the chips use, so
 * `IdentityChips` reads it unchanged.
 *
 * The role label is the reader's role row's own (0068), in both locales — ExpenseOS's
 * `users.get` reads the same relation.
 */
export interface IdentityProfile {
  role: { label: Record<string, string> };
  department: { id: string; label: Record<string, string> } | null;
}

export async function getIdentityProfile(input: {
  id: string;
  organizationId: string;
}): Promise<IdentityProfile> {
  return withTenantDb(input.organizationId, async (tx) => {
    const me = await tx.user.findUniqueOrThrow({
      where: { id: input.id },
      select: { role: { select: { label: true } }, departmentId: true },
    });
    const department = me.departmentId
      ? await tx.department.findUnique({ where: { id: me.departmentId }, select: { id: true, label: true } })
      : null;
    return {
      role: { label: me.role.label as Record<string, string> },
      department: department ? { id: department.id, label: department.label as Record<string, string> } : null,
    };
  });
}
