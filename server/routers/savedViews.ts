import { auditActions, withAudit } from '@expenseos/audit';
import type { Prisma } from '@expenseos/db';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { protectedProcedure, router } from '@/server/trpc';

/**
 * Saved views — per-user, per-resource persistence of filter / sort /
 * column / grouping state for any directory page (people, expenses,
 * cards). The `state` JSON is opaque to Postgres; we validate it here.
 *
 * Ported from ExpenseOS (550b2945) with w4-08. VeloExpense: the table is per tenant under RLS
 * (0067, `saved_view`), so every read is the tenant's before it is the owner's; one pinned
 * default per owner and list is also a partial unique index there, which the clear-then-set
 * order below satisfies. ExpenseOS's resource list is kept whole, including lists VeloExpense
 * has not ported yet: a key no screen sends costs nothing.
 */

// Resources that currently support saved views. New directories add
// themselves to this list — keeps the surface small while still
// avoiding a Prisma enum that would require a migration per addition.
// Admin lookup tables share the saved-view machinery — admins can
// pin their favourite "filter combinations" the same way they would
// on the People directory.
const RESOURCES = [
  'people',
  'expenses',
  'cards',
  'transactions',
  'businessUnits',
  'legalEntities',
  'departments',
  'roles',
  'approvals',
  'delegations',
  'budgets',
] as const;
const resourceSchema = z.enum(RESOURCES);

// View state schema — mirrors the client's ViewState/FilterClause
// shape. Kept loose on `field` (string) so adding new filterable
// columns in the UI doesn't need a server-side edit.
const filterClauseSchema = z.object({
  id: z.string().min(1),
  field: z.string().min(1),
  op: z.enum([
    'equals',
    'doesNotEqual',
    'contains',
    'doesNotContain',
    'startsWith',
    'endsWith',
    'isAnyOf',
    'isNoneOf',
    'isEmpty',
    'isNotEmpty',
    // Date-kind ops (kept in sync with the data-view FilterOp union so any
    // saved view carrying a date clause round-trips through persistence).
    'on',
    'before',
    'after',
    'between',
    'within',
  ]),
  value: z.string(),
});

const viewStateSchema = z.object({
  scope: z.enum(['all', 'direct', 'indirect', 'chain', 'self']).optional(),
  filters: z.array(filterClauseSchema).max(50),
  visibleColumns: z.array(z.string()).optional(),
  sort: z.object({ field: z.string(), dir: z.enum(['asc', 'desc']) }).optional(),
  density: z.enum(['compact', 'normal', 'comfortable']).optional(),
  groupBy: z.enum(['manager', 'department', 'businessUnit', 'status']).nullable().optional(),
});

const nameSchema = z.string().trim().min(1).max(80);

const SELECT = {
  id: true,
  resource: true,
  name: true,
  state: true,
  pinned: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.SavedViewSelect;

function makeActor(ctx: {
  rbac: { id: string; roleLabel: string };
  session: { user: { name?: string | null; email: string } };
}) {
  return {
    kind: 'user' as const,
    id: ctx.rbac.id,
    name: [ctx.session.user.name].filter(Boolean).join(' ') || ctx.session.user.email,
    roleLabel: ctx.rbac.roleLabel,
  };
}

export const savedViewsRouter = router({
  list: protectedProcedure
    .input(z.object({ resource: resourceSchema }))
    .query(async ({ ctx, input }) => {
      return ctx.db.savedView.findMany({
        where: {
          ownerId: ctx.rbac.id,
          resource: input.resource,
          deletedAt: null,
        },
        orderBy: [{ pinned: 'desc' }, { name: 'asc' }],
        select: SELECT,
      });
    }),

  create: protectedProcedure
    .input(
      z.object({
        resource: resourceSchema,
        name: nameSchema,
        state: viewStateSchema,
        pinned: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      return withAudit(
        ctx.db,
        {
          action: auditActions.savedView.create,
          entityType: 'SavedView',
          actor: makeActor(ctx),
          details: {
            resource: input.resource,
            name: input.name,
            pinned: input.pinned ?? false,
          },
        },
        async (tx) => {
          // A resource has at most ONE default view per user; creating a new
          // default clears the previous one.
          if (input.pinned) {
            await tx.savedView.updateMany({
              where: {
                ownerId: ctx.rbac.id,
                resource: input.resource,
                pinned: true,
                deletedAt: null,
              },
              data: { pinned: false },
            });
          }
          return tx.savedView.create({
            data: {
              ownerId: ctx.rbac.id,
              resource: input.resource,
              name: input.name,
              state: input.state as Prisma.InputJsonValue,
              pinned: input.pinned ?? false,
            },
            select: SELECT,
          });
        },
      );
    }),

  update: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        name: nameSchema.optional(),
        state: viewStateSchema.optional(),
        pinned: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const existing = await ctx.db.savedView.findFirst({
        where: { id: input.id, ownerId: ctx.rbac.id, deletedAt: null },
        select: { id: true, resource: true, pinned: true },
      });
      if (!existing) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'View not found' });
      }

      const changedFields = Object.keys(input).filter(
        (k) => k !== 'id' && input[k as keyof typeof input] !== undefined,
      );

      return withAudit(
        ctx.db,
        {
          action: auditActions.savedView.update,
          entityType: 'SavedView',
          entityId: input.id,
          actor: makeActor(ctx),
          details: { changedFields },
        },
        async (tx) => {
          // Promoting this view to the default clears any previous default for
          // the same resource (single default per user + resource).
          if (input.pinned === true && existing.pinned === false) {
            await tx.savedView.updateMany({
              where: {
                ownerId: ctx.rbac.id,
                resource: existing.resource,
                pinned: true,
                deletedAt: null,
                id: { not: existing.id },
              },
              data: { pinned: false },
            });
          }
          return tx.savedView.update({
            where: { id: input.id },
            data: {
              ...(input.name !== undefined ? { name: input.name } : {}),
              ...(input.state !== undefined ? { state: input.state as Prisma.InputJsonValue } : {}),
              ...(input.pinned !== undefined ? { pinned: input.pinned } : {}),
            },
            select: SELECT,
          });
        },
      );
    }),

  delete: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const existing = await ctx.db.savedView.findFirst({
        where: { id: input.id, ownerId: ctx.rbac.id, deletedAt: null },
        select: { id: true, name: true, resource: true },
      });
      if (!existing) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'View not found' });
      }

      await withAudit(
        ctx.db,
        {
          action: auditActions.savedView.delete,
          entityType: 'SavedView',
          entityId: input.id,
          actor: makeActor(ctx),
          details: { name: existing.name, resource: existing.resource },
        },
        async (tx) => {
          await tx.savedView.update({
            where: { id: input.id },
            data: { deletedAt: new Date() },
          });
        },
      );
      return { ok: true as const };
    }),

  togglePinned: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const existing = await ctx.db.savedView.findFirst({
        where: { id: input.id, ownerId: ctx.rbac.id, deletedAt: null },
        select: { id: true, resource: true, pinned: true },
      });
      if (!existing) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'View not found' });
      }

      const nextPinned = !existing.pinned;

      return withAudit(
        ctx.db,
        {
          action: auditActions.savedView.update,
          entityType: 'SavedView',
          entityId: input.id,
          actor: makeActor(ctx),
          details: { changedFields: ['pinned'], pinned: nextPinned },
        },
        async (tx) => {
          // Exclusive default: setting this view as default clears any other
          // default for the same user + resource.
          if (nextPinned) {
            await tx.savedView.updateMany({
              where: {
                ownerId: ctx.rbac.id,
                resource: existing.resource,
                pinned: true,
                deletedAt: null,
                id: { not: existing.id },
              },
              data: { pinned: false },
            });
          }
          return tx.savedView.update({
            where: { id: input.id },
            data: { pinned: nextPinned },
            select: SELECT,
          });
        },
      );
    }),
});
