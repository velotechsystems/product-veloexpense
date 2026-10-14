import 'server-only';
import { SYSTEM_ROLE_LABELS } from '@expenseos/rbac';
import { systemRoleFor, type VeloExpenseRole } from '@expenseos/rbac/server';
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
 * The role label is VeloExpense's system-role label (`SYSTEM_ROLE_LABELS`, both locales) —
 * what the session's English `roleLabel` is drawn from — until the role builder (w4-10)
 * gives roles their own labels.
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
      select: { role: true, departmentId: true },
    });
    const department = me.departmentId
      ? await tx.department.findUnique({ where: { id: me.departmentId }, select: { id: true, label: true } })
      : null;
    return {
      role: { label: SYSTEM_ROLE_LABELS[systemRoleFor(me.role as VeloExpenseRole)] },
      department: department ? { id: department.id, label: department.label as Record<string, string> } : null,
    };
  });
}
