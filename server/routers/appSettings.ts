/**
 * Application-settings tRPC surface — the read/write API behind the
 * Settings tab of `/admin/platform`.
 *
 * Sub-routers, each backed by its own table:
 *
 *   - jobLevels   : the approval-tier ladder (Manager / Director / VP /
 *                   Above) the approval-workflow engine resolves against.
 *   - fiscalYears : reporting periods; exactly one row is `isCurrent`.
 *                   `setCurrent` flips the prior current row in a transaction.
 *   - currencies  : read-only active-currency list for the settings pickers.
 *
 * The Organization JSON section of PlatformConfig stays on the
 * existing `platform.config.{get, update}` surface and is NOT moved
 * here — it doesn't warrant CRUD semantics.
 *
 * Ported from ExpenseOS `apps/web/src/server/routers/appSettings.ts` (550b2945):
 * `currencies` with legal entities (w1-02), `jobLevels` and `fiscalYears` with their
 * screens (w1-04, w1-05). VeloExpense differences, marked below: the label rules are
 * VeloExpense's `labelSchema` (French optional while it is off — see adminLookup.ts);
 * a fiscal year's dates are calendar days; the writes answer a database refusal with a
 * 4xx (`writeProcedure`); and the currency list's shape (see its note).
 */

import { auditActions, withAudit } from '@expenseos/audit';
import { permissions as P } from '@expenseos/rbac';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { router, withPermission } from '@/server/trpc';
import {
  externalIdsSchema,
  flattenExternalIds,
  labelSchema,
  syncEntityAliases,
} from './adminLookup';

// ── Shared helpers ────────────────────────────────────────────────
// labelSchema (strict { en, 'fr-CA' }) is imported from adminLookup so JobLevel
// and FiscalYear labels can't be saved without FR-CA — a loose string→string
// record previously let an en-only or empty label through, breaking FR-CA.
// VeloExpense: adminLookup's labelSchema requires French only while French is switched
// on (7 Oct); English is required either way, and the tables require it too (0050).

/**
 * VeloExpense: the writes answer a refusal the database makes with the code it means,
 * rather than a 500. ExpenseOS lets these through as INTERNAL_SERVER_ERROR; here they are
 * reachable by an ordinary admin — a row another tenant owns (hidden by RLS, so Prisma
 * reports it missing, P2025), a duplicate code (P2002), or a fiscal year whose patched end
 * falls before its stored start (0050's `fiscal_year_dates` CHECK, which the router's own
 * test cannot see when only one date is patched), or a delete another row still
 * references (P2003: a job level a per-diem rate is scoped to, 0053).
 */
function databaseRefusal(cause: unknown): TRPCError | null {
  const err = cause as { code?: string; name?: string; message?: string } | null;
  if (err?.code === 'P2025') return new TRPCError({ code: 'NOT_FOUND', cause });
  // A row something else still points at, refused by a foreign key's ON DELETE
  // RESTRICT — a job level a per-diem rate is scoped to (0053), say.
  if (err?.code === 'P2003') {
    return new TRPCError({ code: 'BAD_REQUEST', message: 'It is still in use elsewhere.', cause });
  }
  if (err?.code === 'P2002') {
    return new TRPCError({ code: 'CONFLICT', message: 'That code is already in use.', cause });
  }
  if (err?.name === 'DriverAdapterError' && err.message?.includes('"fiscal_year_dates"')) {
    return new TRPCError({ code: 'BAD_REQUEST', message: 'endDate must be after startDate', cause });
  }
  return null;
}

/** VeloExpense: `withPermission` for this router's writes, with `databaseRefusal` applied. */
function writeProcedure(permission: Parameters<typeof withPermission>[0]) {
  return withPermission(permission).use(async ({ next }) => {
    const result = await next();
    if (!result.ok) {
      const refusal = databaseRefusal(result.error.cause);
      if (refusal) throw refusal;
    }
    return result;
  });
}

/** Actor block for withAudit, shared by every mutation in this router. */
function auditActor(ctx: {
  rbac: { id: string; roleLabel: string };
  session: { user: { name?: string | null; email: string } };
}) {
  return {
    kind: 'user' as const,
    id: ctx.rbac.id,
    name: ctx.session.user.name ?? ctx.session.user.email,
    roleLabel: ctx.rbac.roleLabel,
  };
}

// ── jobLevels ─────────────────────────────────────────────────────

const jobLevelTrackSchema = z.enum(['INDIVIDUAL_CONTRIBUTOR', 'MANAGER', 'EXECUTIVE', 'BOARD']);
const jobLevelCodeSchema = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .regex(/^[A-Za-z0-9_-]+$/, 'Code may only contain letters, digits, dash, and underscore.');

const JOB_LEVEL_SELECT = {
  id: true,
  code: true,
  track: true,
  label: true,
  sortOrder: true,
  active: true,
  createdAt: true,
  updatedAt: true,
  externalIds: { select: { sourceValue: true, source: { select: { code: true } } } },
} as const;

const jobLevels = router({
  list: withPermission(P.config.policyRead).query(async ({ ctx }) => {
    const rows = await ctx.db.jobLevel.findMany({
      select: JOB_LEVEL_SELECT,
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
    return rows.map((r) => flattenExternalIds({ ...r }));
  }),

  create: writeProcedure(P.config.jobLevelUpdate)
    .input(
      z.object({
        code: jobLevelCodeSchema,
        track: jobLevelTrackSchema,
        label: labelSchema,
        // sortOrder is no longer surfaced in the UI — server auto-assigns
        // next-available so admins don't have to manage it manually.
        sortOrder: z.number().int().optional(),
        active: z.boolean().default(true),
        externalIds: externalIdsSchema.default({}),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const sortOrder =
        input.sortOrder ??
        ((await ctx.db.jobLevel.aggregate({ _max: { sortOrder: true } }))._max.sortOrder ?? 0) + 1;
      const { externalIds, ...data } = input;
      return withAudit(
        ctx.db,
        {
          action: auditActions.admin.jobLevelCreate,
          entityType: 'JobLevel',
          actor: auditActor(ctx),
          details: { code: data.code },
        },
        async (tx) => {
          const row = await tx.jobLevel.create({ data: { ...data, sortOrder } });
          await syncEntityAliases(tx, 'jobLevel', row.id, externalIds);
          return row;
        },
        (r) => r.id,
      );
    }),

  update: writeProcedure(P.config.jobLevelUpdate)
    .input(
      z.object({
        id: z.string().uuid(),
        patch: z.object({
          code: jobLevelCodeSchema.optional(),
          track: jobLevelTrackSchema.optional(),
          label: labelSchema.optional(),
          // Still accepted for internal callers (seed, future drag-reorder),
          // not exposed in the standard edit drawer.
          sortOrder: z.number().int().optional(),
          active: z.boolean().optional(),
          externalIds: externalIdsSchema.optional(),
        }),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { externalIds, ...patch } = input.patch;
      return withAudit(
        ctx.db,
        {
          action: auditActions.admin.jobLevelUpdate,
          entityType: 'JobLevel',
          entityId: input.id,
          actor: auditActor(ctx),
          details: { changedFields: Object.keys(input.patch) },
        },
        async (tx) => {
          const row = await tx.jobLevel.update({ where: { id: input.id }, data: patch });
          if (externalIds !== undefined) {
            await syncEntityAliases(tx, 'jobLevel', row.id, externalIds);
          }
          return row;
        },
      );
    }),

  delete: writeProcedure(P.config.jobLevelUpdate)
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      // Block when any user is assigned this level (FK is onDelete: SetNull,
      // but a coherent error beats silently unassigning everyone).
      const refs = await ctx.db.user.count({ where: { jobLevelId: input.id } });
      if (refs > 0) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `Cannot delete: ${refs} user(s) are assigned this job level.`,
        });
      }
      return withAudit(
        ctx.db,
        {
          action: auditActions.admin.jobLevelDelete,
          entityType: 'JobLevel',
          entityId: input.id,
          actor: auditActor(ctx),
        },
        async (tx) => {
          await tx.jobLevel.delete({ where: { id: input.id } });
          return { ok: true as const };
        },
      );
    }),
});

// ── fiscalYears ───────────────────────────────────────────────────

const fiscalYearInput = z.object({
  label: labelSchema,
  startDate: z.coerce.date(),
  endDate: z.coerce.date(),
  isCurrent: z.boolean().default(false),
  closed: z.boolean().default(false),
  externalIds: externalIdsSchema.default({}),
});

const FISCAL_YEAR_SELECT = {
  id: true,
  label: true,
  startDate: true,
  endDate: true,
  isCurrent: true,
  closed: true,
  createdAt: true,
  updatedAt: true,
  externalIds: { select: { sourceValue: true, source: { select: { code: true } } } },
} as const;

const fiscalYears = router({
  list: withPermission(P.config.policyRead).query(async ({ ctx }) => {
    const rows = await ctx.db.fiscalYear.findMany({
      select: FISCAL_YEAR_SELECT,
      orderBy: { startDate: 'desc' },
    });
    return rows.map((r) => flattenExternalIds({ ...r }));
  }),

  /** Resolve the single current FY. Returns null when no row is set
   *  current (admins should pick one in the UI). */
  current: withPermission(P.config.policyRead).query(async ({ ctx }) => {
    return ctx.db.fiscalYear.findFirst({ where: { isCurrent: true } });
  }),

  create: writeProcedure(P.config.fiscalYearUpdate)
    .input(fiscalYearInput)
    .mutation(async ({ ctx, input }) => {
      if (input.endDate <= input.startDate) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'endDate must be after startDate' });
      }
      // If the new row is marked current, flip every other row in the
      // same transaction so the "exactly one current" invariant holds.
      const { externalIds, ...data } = input;
      return withAudit(
        ctx.db,
        {
          action: auditActions.admin.fiscalYearCreate,
          entityType: 'FiscalYear',
          actor: auditActor(ctx),
          details: { isCurrent: data.isCurrent },
        },
        async (tx) => {
          if (data.isCurrent) {
            await tx.fiscalYear.updateMany({
              where: { isCurrent: true },
              data: { isCurrent: false },
            });
          }
          const row = await tx.fiscalYear.create({ data });
          await syncEntityAliases(tx, 'fiscalYear', row.id, externalIds);
          return row;
        },
        (r) => r.id,
      );
    }),

  update: writeProcedure(P.config.fiscalYearUpdate)
    .input(
      z.object({
        id: z.string().uuid(),
        patch: fiscalYearInput.partial(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { id, patch } = input;
      if (patch.startDate && patch.endDate && patch.endDate <= patch.startDate) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'endDate must be after startDate' });
      }
      const { externalIds, ...data } = patch;
      return withAudit(
        ctx.db,
        {
          action: auditActions.admin.fiscalYearUpdate,
          entityType: 'FiscalYear',
          entityId: id,
          actor: auditActor(ctx),
          details: { changedFields: Object.keys(patch) },
        },
        async (tx) => {
          if (data.isCurrent === true) {
            await tx.fiscalYear.updateMany({
              where: { isCurrent: true, id: { not: id } },
              data: { isCurrent: false },
            });
          }
          const row = await tx.fiscalYear.update({ where: { id }, data });
          if (externalIds !== undefined) {
            await syncEntityAliases(tx, 'fiscalYear', row.id, externalIds);
          }
          return row;
        },
      );
    }),

  /** Atomic "make this FY current" — explicit endpoint so the UI doesn't
   *  have to choreograph the transaction. */
  setCurrent: writeProcedure(P.config.fiscalYearUpdate)
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      return withAudit(
        ctx.db,
        {
          action: auditActions.admin.fiscalYearSetCurrent,
          entityType: 'FiscalYear',
          entityId: input.id,
          actor: auditActor(ctx),
        },
        async (tx) => {
          await tx.fiscalYear.updateMany({
            where: { isCurrent: true, id: { not: input.id } },
            data: { isCurrent: false },
          });
          return tx.fiscalYear.update({
            where: { id: input.id },
            data: { isCurrent: true },
          });
        },
      );
    }),

  /** Advance `isCurrent` to whichever FY's [startDate, endDate] contains
   *  today, if any. No-op when the date-matching FY is already marked
   *  current, or when no FY covers today (orphan period). Safe to call
   *  idempotently — the UI fires this on page mount, and a cron can call
   *  it daily for true background advancement. Returns the resulting
   *  current FY id (or null when no FY covers today). */
  advanceCurrent: writeProcedure(P.config.fiscalYearUpdate).mutation(async ({ ctx }) => {
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const matching = await ctx.db.fiscalYear.findFirst({
      where: { startDate: { lte: today }, endDate: { gte: today } },
      select: { id: true, isCurrent: true },
    });
    if (!matching) return { ok: true as const, changed: false, currentId: null };
    if (matching.isCurrent) {
      return { ok: true as const, changed: false, currentId: matching.id };
    }
    await withAudit(
      ctx.db,
      {
        action: auditActions.admin.fiscalYearSetCurrent,
        entityType: 'FiscalYear',
        entityId: matching.id,
        actor: auditActor(ctx),
        details: { via: 'advanceCurrent' },
      },
      async (tx) => {
        await tx.fiscalYear.updateMany({
          where: { isCurrent: true, id: { not: matching.id } },
          data: { isCurrent: false },
        });
        await tx.fiscalYear.update({ where: { id: matching.id }, data: { isCurrent: true } });
      },
    );
    return { ok: true as const, changed: true, currentId: matching.id };
  }),

  delete: writeProcedure(P.config.fiscalYearUpdate)
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const target = await ctx.db.fiscalYear.findUnique({ where: { id: input.id } });
      if (!target) throw new TRPCError({ code: 'NOT_FOUND' });
      if (target.isCurrent) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Cannot delete the current fiscal year. Set another year current first.',
        });
      }
      return withAudit(
        ctx.db,
        {
          action: auditActions.admin.fiscalYearDelete,
          entityType: 'FiscalYear',
          entityId: input.id,
          actor: auditActor(ctx),
          details: { label: target.label },
        },
        async (tx) => {
          await tx.fiscalYear.delete({ where: { id: input.id } });
          return { ok: true as const };
        },
      );
    }),
});

// ── currencies (read-only) ────────────────────────────────────────
//
// Surfaced here (vs a standalone `currencies` router) because the
// Application Settings UI is the only consumer today — Organization
// reporting-currency picker and the Approval Threshold currency
// picker both bind to the same list. Promote when a second consumer
// shows up.
//
// VeloExpense: the shared `currency` table (migration 0001) is keyed by the ISO code and
// has an English name and minor units — no uuid, symbol, localized label or active flag.
// Every row is usable, so all are listed, and each is returned in ExpenseOS's shape: the
// code doubles as the id (it is the foreign key's value, prisma/schema.prisma), the name
// becomes `{ en }`, and there is no symbol.

const currencies = router({
  list: withPermission(P.config.policyRead).query(async ({ ctx }) => {
    const rows = await ctx.db.currency.findMany({
      select: { code: true, name: true, minorUnit: true },
      orderBy: { code: 'asc' },
    });
    return rows.map((c) => ({
      id: c.code,
      code: c.code,
      symbol: '',
      label: { en: c.name } as Record<string, string>,
      precision: c.minorUnit,
    }));
  }),
});

// ── Composite export ──────────────────────────────────────────────

export const appSettingsRouter = router({
  jobLevels,
  fiscalYears,
  currencies,
});
