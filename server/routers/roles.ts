/**
 * Role admin router (Role Builder).
 *
 * Roles aren't a simple lookup table:
 *   - `permissions` is a String[] of permission codes — every value
 *     must exist in @expenseos/rbac's typed registry.
 *   - `isSystem` rows can have their permissions edited but cannot be
 *     deleted. There is no `code` column anymore — system-role
 *     identity is the UUID `id`, stored in @expenseos/rbac's
 *     SYSTEM_ROLE_IDS map; the "last admin" guard is a
 *     permission-graph check ("refuse to remove a permission if no
 *     other active role still grants it") so renames don't bypass it.
 *   - When `permissions` change, the Redis cache for the role MUST
 *     be invalidated so existing sessions pick up the new perms on
 *     their next request.
 *
 * So this isn't routed through `adminLookupRouter`. It carries the
 * same `externalIds` map for parity, but everything else is bespoke.
 *
 * VeloExpense (w4-10c, d73): ExpenseOS's router (550b2945; unchanged at 1e682dd6). The
 * plumbing, each marked below:
 *   · a role is its TENANT's (0068): the key is (organization, id), and every tenant's
 *     system roles carry ExpenseOS's fixed ids. Reads find by id within the tenant scope
 *     (RLS); writes name the compound key with the caller's organization;
 *   · the permission cache is keyed by organization as well (packages/rbac/src/cache.ts),
 *     so an invalidation names both;
 *   · an alias source is the tenant's own (`@@unique([organizationId, code])`), so there is
 *     no global code to upsert on — found within the tenant, created there when new, as
 *     `syncEntityAliases` (adminLookup.ts) does;
 *   · a pending invitation names a role too (`invite.role_id`, 0069), so a role somebody
 *     has been invited to is refused for deletion as one somebody holds is.
 */
import { auditActions, withAudit } from '@expenseos/audit';
import { Prisma } from '@expenseos/db';
import { ALL_PERMISSIONS, isPermission, permissions as P } from '@expenseos/rbac';
import { invalidateRolePermissions } from '@expenseos/rbac/server';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { router, withPermission } from '@/server/trpc';
// VeloExpense: the lookup screens' label and description (adminLookup.ts): the French name is
// optional while French is switched off (`ENABLED_LOCALES`, 7 Oct), and a description written
// in one language only is kept rather than refused (ExpenseOS's `labelSchema.partial()` takes
// the other, empty language as invalid).
import { descriptionSchema, labelSchema } from './adminLookup';

const externalIdsSchema = z.record(z.string().min(1).max(100), z.string().min(1).max(200));

const permissionsArraySchema = z.array(z.string()).superRefine((arr, ctx) => {
  for (const code of arr) {
    if (!isPermission(code)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Unknown permission: ${code}`,
      });
    }
  }
});

const ROLE_SELECT = {
  id: true,
  label: true,
  description: true,
  isSystem: true,
  active: true,
  permissions: true,
  externalIds: { select: { sourceValue: true, source: { select: { code: true } } } },
  createdAt: true,
  updatedAt: true,
} as const;

type RoleAliasRow = { sourceValue: string; source: { code: string } };

/** Flatten Role's alias rows into a { sourceCode: value } map, preserving the
 *  Record<string,string> UI contract. */
function flattenRoleExternalIds<T extends { externalIds: RoleAliasRow[] }>(
  row: T,
): Omit<T, 'externalIds'> & { externalIds: Record<string, string> } {
  const map: Record<string, string> = {};
  for (const a of row.externalIds) map[a.source.code] = a.sourceValue;
  return { ...row, externalIds: map };
}

/** Replace a role's alias rows to match the given map (delete-all + recreate,
 *  inside the caller's tx). Unknown source codes are auto-created. */
async function syncRoleAliases(
  tx: Prisma.TransactionClient,
  roleId: string,
  externalIds: Record<string, string>,
): Promise<void> {
  await tx.roleExternalId.deleteMany({ where: { roleId } });
  for (const [code, value] of Object.entries(externalIds)) {
    // VeloExpense: a source is the tenant's own — see the header.
    const source =
      (await tx.externalIdSource.findFirst({ where: { code }, select: { id: true } })) ??
      (await tx.externalIdSource.create({
        data: { code, label: { en: code, 'fr-CA': code } },
        select: { id: true },
      }));
    await tx.roleExternalId.create({ data: { sourceId: source.id, sourceValue: value, roleId } });
  }
}

export const rolesRouter = router({
  // ── list ──────────────────────────────────────────────────────
  // No outer `.default()` on the input schema — tRPC v11 + zod's
  // .default at the object level has a history of resolving to
  // `undefined` instead of the default object when the client sends
  // no input. Leaving each field with its own `.default()` and making
  // the whole input optional is the more robust shape.
  list: withPermission(P.admin.role.list)
    .input(
      z
        .object({
          includeInactive: z.boolean().optional().default(false),
          search: z.string().trim().max(200).optional(),
        })
        .optional(),
    )
    .query(async ({ ctx, input }) => {
      const includeInactive = input?.includeInactive ?? false;
      const search = input?.search;
      const where: Prisma.RoleWhereInput = {};
      if (!includeInactive) where.active = true;
      if (search) {
        // Match against the English label JSON path. Custom roles
        // typically pick a recognizable label so this finds them.
        where.label = { path: ['en'], string_contains: search };
      }

      // `_count` on the back-relation gives us user-counts in the same
      // query — no follow-up groupBy needed. Result type is roughly
      // `Role & { _count: { users: number } }`.
      const items = await ctx.db.role.findMany({
        where,
        // System rows first, then ordered by stable id so the list is
        // deterministic across runs.
        orderBy: [{ isSystem: 'desc' }, { id: 'asc' }],
        select: {
          ...ROLE_SELECT,
          _count: { select: { users: true } },
        },
      });

      return {
        items: items.map(({ _count, ...rest }) => ({
          ...flattenRoleExternalIds(rest),
          userCount: _count.users,
        })),
      };
    }),

  // ── catalog (typed permission registry, flat list) ────────────
  // Drives the Role Builder's permission-picker UI. Permissions
  // never change at runtime — caller can cache aggressively.
  permissionCatalog: withPermission(P.admin.role.list).query(() => {
    return { permissions: ALL_PERMISSIONS };
  }),

  // ── create ────────────────────────────────────────────────────
  create: withPermission(P.admin.role.create)
    .input(
      z.object({
        label: labelSchema,
        description: descriptionSchema.nullable().optional(),
        permissions: permissionsArraySchema,
        externalIds: externalIdsSchema.default({}),
        active: z.boolean().default(true),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      return withAudit(
        ctx.db,
        {
          action: auditActions.admin.roleCreate,
          entityType: 'Role',
          actor: {
            kind: 'user',
            id: ctx.rbac.id,
            name: ctx.session.user.name ?? ctx.session.user.email,
            roleLabel: ctx.rbac.roleLabel,
          },
          details: { label: input.label, permissionCount: input.permissions.length },
        },
        async (tx) => {
          const { externalIds, ...rest } = input;
          const created = await tx.role.create({
            data: {
              ...rest,
              description: input.description === null ? Prisma.JsonNull : input.description,
              isSystem: false,
            },
            select: { id: true },
          });
          await syncRoleAliases(tx, created.id, externalIds);
          // VeloExpense: by id within the tenant scope (RLS) — the key is (organization, id).
          const full = await tx.role.findFirstOrThrow({
            where: { id: created.id },
            select: ROLE_SELECT,
          });
          return flattenRoleExternalIds(full);
        },
        // entityId isn't known until the role row is created; resolve it
        // from the result so the audit row records the real id.
        (result) => (result as { id?: string }).id,
      );
    }),

  // ── update ────────────────────────────────────────────────────
  // System roles: label/description/permissions/externalIds editable,
  // `isSystem` frozen, `active` frozen at true. There's no `code` to
  // protect; system-role identity is the row id.
  update: withPermission(P.admin.role.update)
    .input(
      z.object({
        id: z.string().uuid(),
        patch: z
          .object({
            label: labelSchema.optional(),
            description: descriptionSchema.nullable().optional(),
            permissions: permissionsArraySchema.optional(),
            externalIds: externalIdsSchema.optional(),
            active: z.boolean().optional(),
          })
          .strict()
          .refine((p) => Object.keys(p).length > 0, { message: 'patch is empty' }),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // VeloExpense: by id within the tenant scope (RLS) — the key is (organization, id).
      const target = await ctx.db.role.findFirst({
        where: { id: input.id },
        select: { id: true, isSystem: true, permissions: true },
      });
      if (!target) throw new TRPCError({ code: 'NOT_FOUND' });

      if (target.isSystem && input.patch.active === false) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'System roles cannot be deactivated',
        });
      }

      // Permission-graph last-admin guard. If this update would remove
      // a permission that's currently granted to active users only
      // through this role, refuse — orphaning the system from a
      // permission is irreversible without DB-level intervention.
      // Deactivating the role makes ALL its permissions unavailable to its
      // holders (loader returns [] for an inactive role), so treat a
      // deactivation as removing the role's entire permission set.
      const willDeactivate = input.patch.active === false;
      const removed = willDeactivate
        ? target.permissions
        : input.patch.permissions !== undefined
          ? target.permissions.filter((p) => !(input.patch.permissions as string[]).includes(p))
          : [];
      if (removed.length > 0) {
        for (const perm of removed) {
          // Any OTHER active role that still grants this permission?
          const grantedElsewhere = await ctx.db.role.count({
            where: {
              id: { not: target.id },
              active: true,
              permissions: { has: perm },
            },
          });
          if (grantedElsewhere === 0) {
            // Any active user assigned to a role that grants it?
            const usersHoldingIt = await ctx.db.user.count({
              where: {
                deletedAt: null,
                role: { active: true, permissions: { has: perm } },
              },
            });
            // If only this role grants it AND users depend on it,
            // refuse. If no user depends on it the removal is safe.
            if (usersHoldingIt > 0) {
              throw new TRPCError({
                code: 'BAD_REQUEST',
                message: `Cannot remove "${perm}" — no other active role grants it and ${usersHoldingIt} user(s) depend on it.`,
              });
            }
          }
        }
      }

      const result = await withAudit(
        ctx.db,
        {
          action: auditActions.admin.roleUpdate,
          entityType: 'Role',
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
          const { description, externalIds, ...rest } = input.patch;
          await tx.role.update({
            // VeloExpense: the compound key, with the caller's organization.
            where: { organizationId_id: { organizationId: ctx.session.user.organizationId, id: input.id } },
            data: {
              ...rest,
              ...(description === undefined
                ? {}
                : { description: description === null ? Prisma.JsonNull : description }),
            },
            select: { id: true },
          });
          if (externalIds !== undefined) {
            await syncRoleAliases(tx, input.id, externalIds);
          }
          const full = await tx.role.findFirstOrThrow({
            where: { id: input.id },
            select: ROLE_SELECT,
          });
          return flattenRoleExternalIds(full);
        },
      );

      // If permissions OR the active flag changed, blow the RBAC cache so
      // holders pick up the new perms (or lose access on deactivation) on
      // their next request rather than after the 5-minute TTL.
      if (input.patch.permissions !== undefined || input.patch.active !== undefined) {
        // Swallowed so a Redis outage cannot fail a role edit that is already committed —
        // but LOGGED, because the consequence is not "it repopulates next request". The
        // stale entry survives and keeps authorizing the OLD permission set until the
        // 5-minute TTL expires, so this narrowing is not in force yet. Anybody
        // investigating "I revoked that and it still worked" needs this line.
        // VeloExpense: the cache is keyed by organization too.
        await invalidateRolePermissions(ctx.session.user.organizationId, input.id).catch((e) => {
          console.error(
            `[rbac] could not invalidate role ${input.id}; the previous permissions stay live until the cache entry expires`,
            e,
          );
        });
      }

      return result;
    }),

  // ── delete (hard delete; refused if isSystem, users attached, or a
  //    policy rule is scoped to it) ─
  delete: withPermission(P.admin.role.delete)
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const target = await ctx.db.role.findFirst({
        where: { id: input.id },
        select: { id: true, label: true, isSystem: true },
      });
      if (!target) throw new TRPCError({ code: 'NOT_FOUND' });
      if (target.isSystem) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Cannot delete a system role' });
      }
      const userCount = await ctx.db.user.count({ where: { roleId: input.id } });
      if (userCount > 0) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `Reassign ${userCount} user${userCount === 1 ? '' : 's'} before deleting this role`,
        });
      }

      // VeloExpense: a role somebody has been invited to, and has not yet accepted, is as
      // good as held — refused the same way. An invitation that is over keeps its history
      // and forgets the role (0070: `ON DELETE SET NULL (role_id)`).
      const [{ invited }] = await ctx.db.$queryRaw<{ invited: number }[]>`
        SELECT count(*)::int AS invited FROM invite
         WHERE role_id = ${input.id}::uuid
           AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > clock_timestamp()`;
      if (invited > 0) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `Withdraw ${invited} pending invitation${invited === 1 ? '' : 's'} to this role before deleting it`,
        });
      }

      // A policy rule scoped to this role holds a Restrict foreign key, so the
      // delete below would fail in the database with a raw constraint error and
      // reach the admin as a 500. Refuse with something actionable instead.
      //
      // Every rule counts, enabled or not: the constraint does not care, and a
      // disabled rule is one somebody intends to switch back on. Re-scoping is
      // offered first because deleting the rule is the more destructive answer —
      // and blanking its scope is NOT an answer at all, since null means
      // "applies to everyone" and would silently widen the policy.
      const ruleCount = await ctx.db.policyRule.count({ where: { roleId: input.id } });
      if (ruleCount > 0) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `Re-scope or delete ${ruleCount} policy rule${
            ruleCount === 1 ? '' : 's'
          } targeting this role before deleting it`,
        });
      }

      const result = await withAudit(
        ctx.db,
        {
          action: auditActions.admin.roleDelete,
          entityType: 'Role',
          entityId: input.id,
          actor: {
            kind: 'user',
            id: ctx.rbac.id,
            name: ctx.session.user.name ?? ctx.session.user.email,
            roleLabel: ctx.rbac.roleLabel,
          },
          details: { label: target.label },
        },
        async (tx) => {
          await tx.role.delete({
            where: { organizationId_id: { organizationId: ctx.session.user.organizationId, id: input.id } },
          });
          return { ok: true as const };
        },
      );

      // Drop any cached permission set for the now-deleted role so a stale
      // entry can't keep authorizing within the 5-minute TTL window.
      // Same as `update`: the delete is committed, so this must not fail the request —
      // but a surviving entry can keep authorizing a role that no longer exists, which
      // is the one case here worth a log line of its own.
      await invalidateRolePermissions(ctx.session.user.organizationId, input.id).catch((e) => {
        console.error(
          `[rbac] could not invalidate deleted role ${input.id}; its cached permissions stay live until the entry expires`,
          e,
        );
      });

      return result;
    }),
});
