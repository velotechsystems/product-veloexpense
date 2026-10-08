/**
 * Department admin router. Adds `parentId` (self-FK) with cycle
 * detection on writes — assigning a parent that would create a loop
 * (A → B → A) is refused.
 *
 * Ported from ExpenseOS (550b2945). VeloExpense: a parent must be the tenant's own
 * department (marked below). The table also refuses a department as its own parent
 * (migration 0049's `department_not_own_parent`).
 */
import { auditActions } from '@expenseos/audit';
import { permissions as P } from '@expenseos/rbac';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { adminLookupRouter } from './adminLookup';

export const departmentsRouter = adminLookupRouter({
  entityLabel: 'Department',
  modelKey: 'department',
  permissions: {
    list: P.admin.department.list,
    create: P.admin.department.create,
    update: P.admin.department.update,
    delete: P.admin.department.delete,
  },
  audit: {
    create: auditActions.admin.departmentCreate,
    update: auditActions.admin.departmentUpdate,
    delete: auditActions.admin.departmentDelete,
  },
  extraFields: {
    parentId: z.string().uuid().nullable().optional(),
  },
  extraSelect: { parentId: true },
  preWrite: async (tx, { id, patch }) => {
    const parentId = patch.parentId as string | null | undefined;
    if (parentId === undefined || parentId === null) return;
    if (id && parentId === id) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'Cannot set self as parent' });
    }
    // VeloExpense: the parent must be one of THIS tenant's departments. ExpenseOS has one
    // tenant per database, so an id it cannot find was never a question there. Here RLS
    // hides another tenant's rows, so the walk below would find nothing and pass, and the
    // composite FK (0019) would then refuse the write as a 500. Refused here instead, as
    // what it is.
    const parent = await tx.department.findUnique({ where: { id: parentId }, select: { id: true } });
    if (!parent) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'Parent department not found' });
    }
    // Walk UP from the proposed parent. If we hit `id` within
    // MAX_DEPTH hops, the assignment would create a cycle.
    const MAX_DEPTH = 20;
    let walker: string | null = parentId;
    for (let i = 0; i < MAX_DEPTH && walker !== null; i += 1) {
      if (id && walker === id) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Setting this parent would create a hierarchy cycle',
        });
      }
      const next: { parentId: string | null } | null = await tx.department.findUnique({
        where: { id: walker },
        select: { parentId: true },
      });
      walker = next?.parentId ?? null;
    }
  },
});
