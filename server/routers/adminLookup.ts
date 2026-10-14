/**
 * Generic CRUD router factory for the admin "lookup-table" entities:
 * BusinessUnit, LegalEntity, Department.
 *
 * Every lookup table shares the same shape:
 *   - `id` (UUIDv7 primary key — the only machine identifier)
 *   - `label` (locale-keyed Json)
 *   - `description` (optional locale-keyed Json)
 *   - `externalIds` (Json map of external system IDs)
 *   - `active` (soft toggle)
 *   - audit fields
 *
 * Rather than hand-roll five near-identical routers, this factory takes
 * a small descriptor (Prisma model accessor + audit-action names +
 * permission codes) and emits the four standard procedures: `list`,
 * `create`, `update`, `setActive`. Entity-specific fields (LegalEntity's
 * `country`/`homeCurrency`, Department's `parentId`) are layered on
 * top via `extraFields` / `extraSelect`.
 *
 * Ported from ExpenseOS `apps/web/src/server/routers/adminLookup.ts` (550b2945).
 * VeloExpense differences, each marked below:
 *   · the French name is optional while French is switched off, and an empty language in
 *     a name or description is left out rather than refused (`labelSchema`);
 *   · External IDs sources are per tenant, so `syncEntityAliases` finds the tenant's source
 *     by code instead of upserting on a global `code`;
 *   · `Prisma` and the transaction type come from VeloExpense's tenant-scoped client.
 */
import { auditActions, withAudit } from '@expenseos/audit';
import { ENABLED_LOCALES } from '@expenseos/i18n/locales';
import type { Permission } from '@expenseos/rbac';
import { TRPCError } from '@trpc/server';
import { type ZodTypeAny, z } from 'zod';
import { Prisma, type TenantDb } from '@/lib/db/prisma';
import { protectedProcedure, router, withPermission } from '@/server/trpc';

// ── Shared zod fragments ──────────────────────────────────────────

/**
 * VeloExpense: an empty language is ABSENT. The screen always sends both keys
 * (`{ en, 'fr-CA' }`), and an untouched French field arrives as `''`.
 *
 *   · `label`: the French name is optional while French is switched off (7 Oct) — the
 *     screen does not ask for it (`ENABLED_LOCALES`) — and goes back to required when it is
 *     switched on. The English name is required either way, and the database requires it
 *     too (migration 0047).
 *   · `description`: ExpenseOS's `labelSchema.partial()` takes a key as optional but an
 *     EMPTY one as invalid, so a description written in only one language — which the
 *     form allows — was refused on save. That is an ExpenseOS bug; here the empty language
 *     is dropped, and a description with no language left is no description (null).
 */
const blankToUndefined = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);
const localizedText = z.string().min(1).max(200);

export const labelSchema = z
  .object({
    en: localizedText,
    'fr-CA': z.preprocess(blankToUndefined, localizedText.optional()),
  })
  .refine((l) => !ENABLED_LOCALES.includes('fr-CA') || l['fr-CA'] !== undefined, {
    path: ['fr-CA'],
    message: 'Required',
  });

export const descriptionSchema = z
  .object({
    en: z.preprocess(blankToUndefined, localizedText.optional()),
    'fr-CA': z.preprocess(blankToUndefined, localizedText.optional()),
  })
  .transform((d) => {
    const out: { en?: string; 'fr-CA'?: string } = {};
    if (d.en !== undefined) out.en = d.en;
    if (d['fr-CA'] !== undefined) out['fr-CA'] = d['fr-CA'];
    return Object.keys(out).length > 0 ? out : null;
  });

export const externalIdsSchema = z.record(z.string().min(1).max(100), z.string().min(1).max(200));

export type AdminEntityKey = 'BusinessUnit' | 'LegalEntity' | 'Department';

/** Map of permission codes for a single entity. */
export interface AdminPermissionSet {
  list: Permission;
  create: Permission;
  update: Permission;
  delete: Permission;
}

/** Map of audit action codes for a single entity. */
export interface AdminAuditActionSet {
  create: string;
  update: string;
  delete: string;
}

/**
 * Descriptor for one entity's router. Generic over the Prisma model
 * accessor so the type-checker keeps `ctx.db[modelKey]` strongly typed
 * inside the factory.
 */
export interface AdminLookupRouterConfig<E extends string> {
  /** Display name used in audit/error messages, e.g. "Business unit". */
  entityLabel: string;
  /** Lowercase key under `ctx.db` — e.g. `'businessUnit'`. */
  modelKey: 'businessUnit' | 'legalEntity' | 'department';
  /** Lowercase key under `auditActions.admin` prefix family. Not used
   *  directly; the audit action codes are passed via `audit`. */
  permissions: AdminPermissionSet;
  audit: AdminAuditActionSet;
  /** Extra zod input fields layered onto create/update (e.g. country). */
  extraFields?: Record<string, ZodTypeAny>;
  /** Extra Prisma `select` keys appended to the default projection. A nested
   *  `{ select: … }` is allowed so an entity can project a scalar THROUGH a
   *  relation — e.g. LegalEntity reading its currency's `code` now that
   *  `homeCurrency` is a FK rather than a stored string. */
  extraSelect?: Record<string, true | { select: Record<string, true> }>;
  /** Hook for per-entity write-time validation (e.g. cycle detection
   *  on Department.parentId). Receives the Prisma tx + the writing
   *  payload. Throws TRPCError to refuse. */
  preWrite?: (
    tx: TenantDb,
    payload: {
      id?: string;
      patch: Record<string, unknown>;
    },
  ) => Promise<void>;
  E?: E;
}

const DEFAULT_SELECT = {
  id: true,
  label: true,
  description: true,
  externalIds: { select: { sourceValue: true, source: { select: { code: true } } } },
  active: true,
  createdAt: true,
  updatedAt: true,
} as const;

/** Per-entity alias table + FK field, keyed by the lookup model. */
const ALIAS_TABLE: Record<string, { model: string; fk: string }> = {
  businessUnit: { model: 'businessUnitExternalId', fk: 'businessUnitId' },
  legalEntity: { model: 'legalEntityExternalId', fk: 'legalEntityId' },
  department: { model: 'departmentExternalId', fk: 'departmentId' },
  jobLevel: { model: 'jobLevelExternalId', fk: 'jobLevelId' },
  fiscalYear: { model: 'fiscalYearExternalId', fk: 'fiscalYearId' },
};

type AliasRow = { sourceValue: string; source: { code: string } };

/** Flatten the external-id alias rows on a query result into a
 *  { sourceCode: value } map, preserving the Record<string,string> UI
 *  contract. Mutates and returns the row. */
export function flattenExternalIds(row: Record<string, unknown>): Record<string, unknown> {
  const aliases = row.externalIds as AliasRow[] | undefined;
  if (Array.isArray(aliases)) {
    const map: Record<string, string> = {};
    for (const a of aliases) map[a.source.code] = a.sourceValue;
    row.externalIds = map;
  }
  return row;
}

/** Replace an entity's alias rows to match the given { sourceCode: value }
 *  map (delete-all + recreate, inside the caller's tx). Unknown source codes
 *  are auto-created so the editor stays free-form. */
export async function syncEntityAliases(
  tx: TenantDb,
  modelKey: string,
  entityId: string,
  externalIds: Record<string, string>,
): Promise<void> {
  const alias = ALIAS_TABLE[modelKey];
  if (!alias) return;
  // biome-ignore lint/suspicious/noExplicitAny: dynamic delegate access by modelKey
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- VeloExpense: the same exemption for ESLint
  const aliasModel = (tx as any)[alias.model];
  await aliasModel.deleteMany({ where: { [alias.fk]: entityId } });
  for (const [code, value] of Object.entries(externalIds)) {
    // VeloExpense: a source is the tenant's own (`@@unique([organizationId, code])`), so
    // there is no global `code` to upsert on. Found by code within the tenant scope (RLS),
    // created there when new — the same effect as ExpenseOS's upsert.
    const source =
      (await tx.externalIdSource.findFirst({ where: { code }, select: { id: true } })) ??
      (await tx.externalIdSource.create({
        data: { code, label: { en: code, 'fr-CA': code } },
        select: { id: true },
      }));
    await aliasModel.create({
      data: { sourceId: source.id, sourceValue: value, [alias.fk]: entityId },
    });
  }
}

/**
 * Build a tRPC router for one admin lookup entity. Returns a router
 * with: `list`, `create`, `update`, `setActive`.
 */
export function adminLookupRouter<E extends string>(cfg: AdminLookupRouterConfig<E>) {
  const select = { ...DEFAULT_SELECT, ...(cfg.extraSelect ?? {}) } as const;

  // Build the create/update body schemas. `extraFields` is layered on
  // top of the base shape; the merge is intentionally permissive — the
  // caller defines whether each extra is required or optional via the
  // zod schema it provides.
  const baseCreate = {
    label: labelSchema,
    description: descriptionSchema.nullable().optional(),
    externalIds: externalIdsSchema.default({}),
    active: z.boolean().default(true),
    ...(cfg.extraFields ?? {}),
  };
  const createInput = z.object(baseCreate);

  // Update: all fields optional except `id`.
  const updateInput = z.object({
    id: z.string().uuid(),
    patch: z
      .object({
        label: labelSchema.optional(),
        description: descriptionSchema.nullable().optional(),
        externalIds: externalIdsSchema.optional(),
        active: z.boolean().optional(),
        ...Object.fromEntries(
          Object.entries(cfg.extraFields ?? {}).map(([k, v]) => [k, (v as ZodTypeAny).optional()]),
        ),
      })
      .strict()
      .refine((p) => Object.keys(p).length > 0, { message: 'patch is empty' }),
  });

  return router({
    // ── list ────────────────────────────────────────────────────
    list: withPermission(cfg.permissions.list)
      .input(
        z
          .object({
            search: z.string().trim().max(200).optional(),
            includeInactive: z.boolean().default(false),
          })
          .default({ includeInactive: false }),
      )
      .query(async ({ ctx, input }) => {
        const where: Record<string, unknown> = {};
        if (!input.includeInactive) where.active = true;
        if (input.search) {
          // Match against the English label JSON path. Cheap on
          // lookup-table cardinality (< 10k typical). FR-CA fall-
          // through can be added later via Prisma's `path` filter
          // or a raw ILIKE on the JSON's text representation.
          where.label = { path: ['en'], string_contains: input.search };
        }
        // Cast: Prisma's model accessors are heterogeneous; using
        // a discriminated lookup is safe because `modelKey` is
        // constrained at compile time.
        const model = (
          ctx.db as unknown as Record<
            string,
            {
              findMany: (args: unknown) => Promise<unknown[]>;
            }
          >
        )[cfg.modelKey];
        const items = (await model.findMany({
          where,
          // System rows have no semantic ordering anymore; stable id
          // sort keeps results deterministic across requests.
          orderBy: [{ id: 'asc' }],
          select,
        })) as Array<Record<string, unknown>>;
        return { items: items.map(flattenExternalIds) };
      }),

    // ── create ──────────────────────────────────────────────────
    create: withPermission(cfg.permissions.create)
      .input(createInput)
      .mutation(async ({ ctx, input }) => {
        return withAudit(
          ctx.db,
          {
            action: cfg.audit.create,
            entityType: cfg.entityLabel.replace(/\s+/g, ''),
            actor: {
              kind: 'user',
              id: ctx.rbac.id,
              name: ctx.session.user.name ?? ctx.session.user.email,
              roleLabel: ctx.rbac.roleLabel,
            },
            details: { label: input.label },
          },
          async (tx) => {
            if (cfg.preWrite) {
              await cfg.preWrite(tx, { patch: input as Record<string, unknown> });
            }
            const model = (
              tx as unknown as Record<
                string,
                {
                  create: (args: unknown) => Promise<unknown>;
                }
              >
            )[cfg.modelKey];
            try {
              const { externalIds, ...rest } = input as typeof input & {
                externalIds: Record<string, string>;
              };
              const data: Record<string, unknown> = {
                ...rest,
                ...(input.description === null ? { description: Prisma.JsonNull } : {}),
              };
              const created = (await model.create({ data, select: { id: true } })) as {
                id: string;
              };
              await syncEntityAliases(tx, cfg.modelKey, created.id, externalIds ?? {});
              const full = (await (
                tx as unknown as Record<string, { findUnique: (args: unknown) => Promise<unknown> }>
              )[cfg.modelKey].findUnique({ where: { id: created.id }, select })) as Record<
                string,
                unknown
              >;
              return flattenExternalIds(full);
            } catch (err) {
              const msg = String((err as { message?: string })?.message ?? err);
              if (msg.includes('Unique constraint')) {
                throw new TRPCError({
                  code: 'CONFLICT',
                  message: `A ${cfg.entityLabel} with these values already exists`,
                });
              }
              throw err;
            }
          },
          // entityId isn't known until the row is created; resolve it from
          // the result so the audit row (and its hash) records the real id.
          (result) => (result as { id?: string }).id,
        );
      }),

    // ── update ──────────────────────────────────────────────────
    update: withPermission(cfg.permissions.update)
      .input(updateInput)
      .mutation(async ({ ctx, input }) => {
        return withAudit(
          ctx.db,
          {
            action: cfg.audit.update,
            entityType: cfg.entityLabel.replace(/\s+/g, ''),
            entityId: input.id,
            actor: {
              kind: 'user',
              id: ctx.rbac.id,
              name: ctx.session.user.name ?? ctx.session.user.email,
              roleLabel: ctx.rbac.roleLabel,
            },
            details: { changedFields: Object.keys(input.patch) },
          },
          async (tx) => {
            if (cfg.preWrite) {
              await cfg.preWrite(tx, {
                id: input.id,
                patch: input.patch as Record<string, unknown>,
              });
            }
            const model = (
              tx as unknown as Record<
                string,
                {
                  update: (args: unknown) => Promise<unknown>;
                }
              >
            )[cfg.modelKey];
            try {
              const { externalIds, ...restPatch } = input.patch as typeof input.patch & {
                externalIds?: Record<string, string>;
              };
              const patch: Record<string, unknown> = {
                ...restPatch,
                ...(input.patch.description === null ? { description: Prisma.JsonNull } : {}),
              };
              await model.update({ where: { id: input.id }, data: patch, select: { id: true } });
              if (externalIds !== undefined) {
                await syncEntityAliases(tx, cfg.modelKey, input.id, externalIds);
              }
              const full = (await (
                tx as unknown as Record<string, { findUnique: (args: unknown) => Promise<unknown> }>
              )[cfg.modelKey].findUnique({ where: { id: input.id }, select })) as Record<
                string,
                unknown
              >;
              return flattenExternalIds(full);
            } catch (err) {
              const msg = String((err as { message?: string })?.message ?? err);
              if (msg.includes('Unique constraint')) {
                throw new TRPCError({
                  code: 'CONFLICT',
                  message: 'Update collides with an existing row',
                });
              }
              // VeloExpense: Prisma 7 words it "No record was found for an update" (P2025);
              // ExpenseOS's Prisma said "Record to update not found". Both are matched.
              if (
                msg.includes('Record to update not found') ||
                (err as { code?: string })?.code === 'P2025'
              ) {
                throw new TRPCError({ code: 'NOT_FOUND' });
              }
              throw err;
            }
          },
        );
      }),

    // ── setActive (soft delete / restore) ───────────────────────
    // We never hard-delete lookup rows — historical references
    // (Audit rows, ExpenseReports, etc.) need the codes to stay
    // resolvable. `active = false` hides the row from pickers.
    setActive: withPermission(cfg.permissions.delete)
      .input(z.object({ id: z.string().uuid(), active: z.boolean() }))
      .mutation(async ({ ctx, input }) => {
        return withAudit(
          ctx.db,
          {
            action: input.active ? cfg.audit.update : cfg.audit.delete,
            entityType: cfg.entityLabel.replace(/\s+/g, ''),
            entityId: input.id,
            actor: {
              kind: 'user',
              id: ctx.rbac.id,
              name: ctx.session.user.name ?? ctx.session.user.email,
              roleLabel: ctx.rbac.roleLabel,
            },
            details: { active: input.active },
          },
          async (tx) => {
            const model = (
              tx as unknown as Record<
                string,
                {
                  update: (args: unknown) => Promise<unknown>;
                }
              >
            )[cfg.modelKey];
            const updated = (await model.update({
              where: { id: input.id },
              data: { active: input.active },
              select,
            })) as Record<string, unknown>;
            return flattenExternalIds(updated);
          },
        );
      }),
  });
}

// ── Re-exports used by the per-entity router files ───────────────
export { auditActions, protectedProcedure, z };
