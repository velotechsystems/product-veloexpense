/**
 * users — ExpenseOS's People router (`server/routers/users.ts`, 1e682dd6), the server half of
 * the People screen (/users).
 *
 * People 1 of 4 (16 Oct 2026) ported the READS: the scoped directory (`listDirectory`), its
 * filter facets and counts, one person (`get`), their direct reports and their activity.
 * People 2 ported the WRITES: `update`, `setRole`, `setOnLeave`, `setAccess(Many)`,
 * `deactivate` and `reactivate`. People 3 ports `create`, which sends an invitation
 * (decided 16 Oct). `resetPassword` and `setLocalePref` are not ported:
 * VeloExpense signs in through Google only, and is English only (7 Oct 2026).
 *
 * VeloExpense, throughout:
 *   · the raw SQL names `app_user`, `user_external_id` and their snake_case columns, and runs
 *     in the caller's tenant transaction, so RLS keeps every read inside the tenant;
 *   · access is `hasAccess` (`has_access`, 0072), ExpenseOS's `hasExpenseOSAccess`;
 *   · no MFA (no second factor of VeloExpense's own) and no NetSuite fields until Wave 5;
 *   · the facet cache is shared by every tenant, so its scope bucket names the tenant;
 *   · no `sessionEpoch`: every request reads the person's role, access and deactivation from
 *     the database (`resolveTenantMember`, `requireActor`), so a change takes effect at once;
 *   · a SEAT is a person who is not deactivated (lib/billing): reactivating one is capped like
 *     a new member, and every change to the count is pushed to the platform;
 *   · DEACTIVATED moves with `deleted_at` wherever a status is written (w4-10f, 0071), and so
 *     does TERMINATED — the two leaver statuses — or a leaver would keep signing in.
 */
import { auditActions, withAudit } from '@expenseos/audit';
import { Prisma, type PrismaClient, rollUpOnOffboard } from '@expenseos/db';
import { permissions as P, SYSTEM_ROLE_IDS } from '@expenseos/rbac';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { canViewUser } from '@/server/lib/canViewUser';
import { currencySymbol } from '@/server/lib/currencySymbol';
import {
  type DirectoryCursor,
  decodeDirectoryCursor,
  encodeDirectoryCursor,
} from '@/server/lib/directoryCursor';
import {
  buildCacheKey,
  type CachedFacetEntry,
  getOrSetFacetEntry,
  hashFilterPayload,
} from '@/server/lib/facets/cache';
import { assertSeatAvailable, CapReachedError } from '@/lib/billing/caps';
import { pushSeatCountInBackground } from '@/lib/billing/seats';
import { afterCommit, type TenantDb } from '@/lib/db/prisma';
import { queryRunnerOf } from '@/lib/db/prisma-pg-bridge';
import { InviteError, sendInvite } from '@/lib/invites/service';
import { DEFAULT_ROLE_ID } from '@/lib/roles/service';
import { type Context, protectedProcedure, router, withPermission } from '@/server/trpc';
import { type DirectoryScope, resolveScopedIds } from '../lib/userScope';

/** Trim a string to null when empty. */
function nz(s: string | null | undefined): string | null {
  if (s == null) return null;
  const t = s.trim();
  return t.length > 0 ? t : null;
}

/**
 * VeloExpense: ExpenseOS's `EmployeeStatus` enum is text with a CHECK here (0004, 0072), so the
 * values are listed rather than imported.
 */
const EMPLOYEE_STATUSES = ['ACTIVE', 'ON_LEAVE', 'DEACTIVATED', 'TERMINATED'] as const;
type EmployeeStatus = (typeof EMPLOYEE_STATUSES)[number];
const employeeStatusSchema = z.enum(EMPLOYEE_STATUSES);

// ── Column filter operators ───────────────────────────────────────
// Discriminated union — each variant carries exactly the operand(s)
// it needs. The client + server share this shape; the server uses
// `columnFilterToWhere` to translate it into a Prisma WhereInput.

const columnFilterSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('contains'), value: z.string().min(1) }),
  z.object({ op: z.literal('doesNotContain'), value: z.string().min(1) }),
  z.object({ op: z.literal('equals'), value: z.string().min(1) }),
  z.object({ op: z.literal('doesNotEqual'), value: z.string().min(1) }),
  z.object({ op: z.literal('startsWith'), value: z.string().min(1) }),
  z.object({ op: z.literal('endsWith'), value: z.string().min(1) }),
  z.object({ op: z.literal('isEmpty') }),
  z.object({ op: z.literal('isNotEmpty') }),
  z.object({ op: z.literal('isAnyOf'), values: z.array(z.string()).min(1) }),
  z.object({ op: z.literal('isNoneOf'), values: z.array(z.string()).min(1) }),
]);
export type ColumnFilter = z.infer<typeof columnFilterSchema>;

/** Filter ops where the negation should apply across both name fields
 *  via AND (vs the default of "either side matches" via OR). */
const NEGATIVE_OPS = new Set<ColumnFilter['op']>([
  'doesNotContain',
  'doesNotEqual',
  'isEmpty',
  'isNoneOf',
]);

/**
 * Name filter spans firstName / lastName. Positive ops (contains,
 * equals, starts-with, …) match if EITHER side does. Negative ops
 * (doesn't contain, is empty, …) require BOTH sides to fail the
 * criterion, otherwise the match is too permissive.
 */
/**
 * "Has a manager" / "has no manager", the only manager predicate the directory
 * supports.
 *
 * A missing reporting line is not cosmetic: an approval node that routes to the
 * requester's manager cannot resolve one, so the task falls through to the
 * approver-pool fallback. Being able to list those people is how the data debt
 * gets fixed instead of absorbed — 11% of active users on dev.
 *
 * Any other operator THROWS. Silently treating "manager contains rim" as a match
 * on everything is the failure mode this whole area keeps producing, and a filter
 * that quietly does nothing is worse than one that is absent.
 */
function managerPresenceWhere(f: ColumnFilter | ColumnFilter[]): Prisma.UserWhereInput {
  const list = Array.isArray(f) ? f : [f];
  const clauses = list.map((one): Prisma.UserWhereInput => {
    if (one.op === 'isEmpty') return { managerId: null };
    if (one.op === 'isNotEmpty') return { managerId: { not: null } };
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `The manager filter supports only isEmpty / isNotEmpty, got "${one.op}"`,
    });
  });
  return clauses.length === 1 ? (clauses[0] as Prisma.UserWhereInput) : { OR: clauses };
}

function nameFilterToWhere(f: ColumnFilter): Prisma.UserWhereInput {
  const onFirst = columnFilterToWhere('firstName', f);
  const onLast = columnFilterToWhere('lastName', f);
  return NEGATIVE_OPS.has(f.op) ? { AND: [onFirst, onLast] } : { OR: [onFirst, onLast] };
}

/**
 * Build a Prisma where-fragment for a single column filter. Text
 * columns go case-insensitive ('mode: insensitive'); enum columns
 * (employeeStatus today) do an exact-value compare — Prisma rejects
 * `mode: insensitive` on enums in 7.x, and case-insensitivity is
 * meaningless when the value set is the enum's own literals.
 */
const ENUM_FIELDS = new Set(['employeeStatus']);
type StringTextFilter = {
  contains?: string;
  startsWith?: string;
  endsWith?: string;
  equals?: string;
  mode?: 'insensitive';
};
function textWhere(
  field: string,
  op: keyof StringTextFilter,
  value: string,
): Prisma.UserWhereInput {
  const isEnum = ENUM_FIELDS.has(field);
  const clause: StringTextFilter = { [op]: value };
  if (!isEnum) clause.mode = 'insensitive';
  return { [field]: clause } as Prisma.UserWhereInput;
}
function columnFilterToWhere(field: string, f: ColumnFilter): Prisma.UserWhereInput {
  switch (f.op) {
    case 'contains':
      return textWhere(field, 'contains', f.value);
    case 'doesNotContain':
      return { NOT: textWhere(field, 'contains', f.value) } as Prisma.UserWhereInput;
    case 'equals':
      return textWhere(field, 'equals', f.value);
    case 'doesNotEqual':
      return { NOT: textWhere(field, 'equals', f.value) } as Prisma.UserWhereInput;
    case 'startsWith':
      return textWhere(field, 'startsWith', f.value);
    case 'endsWith':
      return textWhere(field, 'endsWith', f.value);
    case 'isEmpty':
      return { OR: [{ [field]: null }, { [field]: '' }] } as Prisma.UserWhereInput;
    case 'isNotEmpty':
      return {
        AND: [{ [field]: { not: null } }, { [field]: { not: '' } }],
      } as Prisma.UserWhereInput;
    case 'isAnyOf': {
      // Multi-value equals. Mirror single-value `equals` (textWhere) and stay
      // case-insensitive on text columns — without `mode: insensitive` a bare
      // `in` is case-SENSITIVE, so "name equals Kati or Naveed" could miss rows
      // that a single "equals" would have matched. Enums compare exact literals.
      const anyClause = ENUM_FIELDS.has(field)
        ? { in: f.values }
        : { in: f.values, mode: 'insensitive' as const };
      return { [field]: anyClause } as Prisma.UserWhereInput;
    }
    case 'isNoneOf': {
      const noneClause = ENUM_FIELDS.has(field)
        ? { notIn: f.values }
        : { notIn: f.values, mode: 'insensitive' as const };
      return { [field]: noneClause } as Prisma.UserWhereInput;
    }
  }
}

/** Build a raw SQL predicate that matches a single `ColumnFilter` against a
 *  user's external-id alias rows (`UserExternalId.sourceValue`). Correlates on
 *  `u.id`, so the surrounding query MUST alias the User table as `u`. This is
 *  the alias-table sibling of `columnFilterToWhere`; ILIKE without wildcards
 *  is a case-insensitive exact match. */
function externalIdsFragment(f: ColumnFilter): Prisma.Sql {
  const has = (pattern: string) =>
    Prisma.sql`EXISTS (SELECT 1 FROM user_external_id uei WHERE uei.user_id = u.id AND uei.source_value ILIKE ${pattern})`;
  const lacks = (pattern: string) =>
    Prisma.sql`NOT EXISTS (SELECT 1 FROM user_external_id uei WHERE uei.user_id = u.id AND uei.source_value ILIKE ${pattern})`;
  switch (f.op) {
    case 'contains':
      return has(`%${f.value}%`);
    case 'doesNotContain':
      return lacks(`%${f.value}%`);
    case 'equals':
      return has(f.value);
    case 'doesNotEqual':
      return lacks(f.value);
    case 'startsWith':
      return has(`${f.value}%`);
    case 'endsWith':
      return has(`%${f.value}`);
    case 'isEmpty':
      return Prisma.sql`NOT EXISTS (SELECT 1 FROM user_external_id uei WHERE uei.user_id = u.id)`;
    case 'isNotEmpty':
      return Prisma.sql`EXISTS (SELECT 1 FROM user_external_id uei WHERE uei.user_id = u.id)`;
    case 'isAnyOf':
      return Prisma.sql`(${Prisma.join(
        f.values.map((v) => has(v)),
        ' OR ',
      )})`;
    case 'isNoneOf':
      return Prisma.sql`(${Prisma.join(
        f.values.map((v) => lacks(v)),
        ' AND ',
      )})`;
  }
}

// ─── Facet-count helpers ──────────────────────────────────────────
//
// `runFieldCount` executes a single GROUP BY + COUNT for one facet
// field, applying the per-column WHERE predicates supplied by the
// caller (typically all current filters EXCEPT the field's own).
// Wrapped with statement_timeout; on timeout the function recurses
// once WITHOUT filter predicates to provide a global fallback.

/** Field name (from the input API) → physical DB column name. */
// VeloExpense: `app_user`'s snake_case columns.
const SERVER_COLUMN_FOR_FIELD: Record<string, string> = {
  status: 'employee_status',
  businessUnit: 'business_unit_id',
  department: 'department_id',
  entity: 'legal_entity_id',
};

interface RunFieldCountArgs {
  db: PrismaClient;
  dbColumn: string;
  scopedIds: string[] | null;
  includeDeleted: boolean;
  otherFilters: Record<string, ColumnFilter | ColumnFilter[]>;
  forceGlobalScope: boolean;
  topN: number;
  timeoutMs: number;
}

async function runFieldCount(args: RunFieldCountArgs): Promise<CachedFacetEntry> {
  return tryFieldCount(args, false).catch(async (err) => {
    // statement_timeout produces a PG error with code 57014 — retry
    // once without scope/filter predicates so the UI still has
    // something to show. The response is tagged `scoped: false`.
    const msg = String(err?.message ?? err);
    if (msg.includes('57014') || msg.includes('canceling statement')) {
      return tryFieldCount(args, true);
    }
    throw err;
  });
}

async function tryFieldCount(
  args: RunFieldCountArgs,
  forceGlobal: boolean,
): Promise<CachedFacetEntry> {
  const { db, dbColumn, scopedIds, includeDeleted, otherFilters, topN, timeoutMs } = args;
  const useGlobal = forceGlobal || args.forceGlobalScope;

  // Build WHERE fragments. Empty list resolves to `TRUE` so the
  // composition stays well-formed for joined `AND`.
  const fragments: Prisma.Sql[] = [];
  if (!useGlobal) {
    if (scopedIds && scopedIds.length > 0) {
      fragments.push(Prisma.sql`u.id = ANY(${scopedIds}::uuid[])`);
    }
    if (!includeDeleted) {
      fragments.push(Prisma.sql`u.deleted_at IS NULL`);
    }
    for (const [field, value] of Object.entries(otherFilters)) {
      if (value === undefined) continue;
      const list = Array.isArray(value) ? value : [value];
      const target = field === 'name' ? null : (SERVER_COLUMN_FOR_FIELD[field] ?? field);
      const fieldFrags = list.map((f) => {
        if (field === 'name') {
          // Reuse the name OR/AND split logic to one SQL piece.
          const nameWhere = nameFilterToWhere(f);
          // Prisma where → SQL: not directly stringifiable. Skip
          // name predicates in count queries (the impact is small
          // — name typing is rare while iterating on facets).
          void nameWhere;
          return Prisma.sql`TRUE`;
        }
        if (field === 'externalIds') {
          return externalIdsFragment(f);
        }
        if (target == null) return Prisma.sql`TRUE`;
        return columnFilterToSql(target, f);
      });
      const firstFrag = fieldFrags[0];
      const combined =
        fieldFrags.length === 1 && firstFrag
          ? firstFrag
          : Prisma.sql`(${Prisma.join(fieldFrags, ' OR ')})`;
      fragments.push(combined);
    }
  } else {
    // Global mode still respects soft-delete (otherwise terminated
    // employees inflate every count). Skip on includeDeleted.
    if (!includeDeleted) {
      fragments.push(Prisma.sql`u.deleted_at IS NULL`);
    }
  }

  const whereSql = fragments.length === 0 ? Prisma.sql`TRUE` : Prisma.join(fragments, ' AND ');

  // Quote the column name. dbColumn is from a hardcoded map so
  // SQL injection isn't a risk; we still wrap in identifiers.
  const quoted = `"${dbColumn}"`;
  const rows = await db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${timeoutMs}`);
    return tx.$queryRaw<Array<{ value: string | null; count: bigint }>>`
      SELECT ${Prisma.raw(`u.${quoted}`)} AS value, COUNT(*)::bigint AS count
      FROM app_user u
      WHERE ${whereSql}
      AND ${Prisma.raw(`u.${quoted}`)} IS NOT NULL
      GROUP BY ${Prisma.raw(`u.${quoted}`)}
      ORDER BY count DESC, value ASC
      LIMIT ${topN}
    `;
  });

  return {
    scoped: !useGlobal,
    values: rows
      .filter((r): r is { value: string; count: bigint } => r.value !== null)
      .map((r) => ({ value: r.value, count: Number(r.count) })),
  };
}

/** Convert a ColumnFilter into a raw SQL fragment for the given
 *  column. Mirrors `columnFilterToWhere` but emits SQL strings
 *  instead of Prisma `where` objects (because we're inside a raw
 *  GROUP BY query). */
function columnFilterToSql(column: string, f: ColumnFilter): Prisma.Sql {
  const col = Prisma.raw(`u."${column}"`);
  switch (f.op) {
    case 'contains':
      return Prisma.sql`${col}::text ILIKE ${`%${f.value}%`}`;
    case 'doesNotContain':
      return Prisma.sql`(${col}::text NOT ILIKE ${`%${f.value}%`} OR ${col} IS NULL)`;
    case 'equals':
      return Prisma.sql`${col}::text = ${f.value}`;
    case 'doesNotEqual':
      return Prisma.sql`(${col}::text <> ${f.value} OR ${col} IS NULL)`;
    case 'startsWith':
      return Prisma.sql`${col}::text ILIKE ${`${f.value}%`}`;
    case 'endsWith':
      return Prisma.sql`${col}::text ILIKE ${`%${f.value}`}`;
    case 'isEmpty':
      return Prisma.sql`(${col} IS NULL OR ${col}::text = '')`;
    case 'isNotEmpty':
      return Prisma.sql`(${col} IS NOT NULL AND ${col}::text <> '')`;
    case 'isAnyOf':
      return Prisma.sql`${col}::text = ANY(${f.values}::text[])`;
    case 'isNoneOf':
      return Prisma.sql`(${col}::text <> ALL(${f.values}::text[]) OR ${col} IS NULL)`;
  }
}

/**
 * Translate the `access` enum filter ('granted' / 'denied') into a where predicate.
 *
 * The column is a plain boolean, but it reaches the server as an enum: a filter pill reading
 * "Access: granted" is legible where one reading "Access: true" is not. Ambiguous selections
 * (both or neither) constrain nothing.
 *
 * VeloExpense: the column is `hasAccess` (`has_access`, 0072) — ExpenseOS's
 * `hasExpenseOSAccess` without the product's name in it.
 */
function accessWhere(f: ColumnFilter | ColumnFilter[]): Prisma.UserWhereInput | null {
  const list = Array.isArray(f) ? f : [f];
  const want = new Set<boolean>();
  for (const one of list) {
    if (one.op === 'equals' || one.op === 'isAnyOf') {
      const vals = one.op === 'equals' ? [one.value] : one.values;
      if (vals.includes('granted')) want.add(true);
      if (vals.includes('denied')) want.add(false);
    } else if (one.op === 'doesNotEqual' || one.op === 'isNoneOf') {
      const vals = one.op === 'doesNotEqual' ? [one.value] : one.values;
      if (vals.includes('granted')) want.add(false);
      if (vals.includes('denied')) want.add(true);
    }
  }
  if (want.size !== 1) return null;
  return { hasAccess: want.has(true) };
}

/*
 * VeloExpense: ExpenseOS's `mfaEnrolledWhere` is not ported. VeloExpense signs in through
 * Google only, so it holds no second factor of its own: no TOTP secret, no passkeys, and no
 * MFA column or filter on the directory.
 */

/** Common shape returned by directory + get + getDirectReports. */
type DirectoryRow = {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  department: { id: string; label: Prisma.JsonValue } | null;
  businessUnit: { id: string; label: Prisma.JsonValue } | null;
  /** NetSuite business unit, set by the employee sync (name from the synced mirror).
   *  VeloExpense: always null until NetSuite arrives (Wave 5, w5-03). */
  nsBusinessUnit: { id: string; name: string } | null;
  entity: { id: string; label: Prisma.JsonValue } | null;
  jobLevel: { id: string; label: Prisma.JsonValue } | null;
  /** NetSuite Class assignment (name resolved from the synced reference).
   *  VeloExpense: always null until NetSuite arrives (Wave 5, w5-03). */
  nsClass: { id: string; name: string } | null;
  country: string | null;
  /** The user's home-currency CODE. `User.homeCurrency` is a FK now; the row keeps
   *  a code because that is what the directory displays and exports.
   *  VeloExpense: a person has no currency of their own; it is their legal entity's (Wave 2),
   *  so this is the entity's code. */
  homeCurrency: string | null;
  /** Flattened from the per-entity alias table: { sourceCode: value }. */
  externalIds: Record<string, string>;
  /** Open People ↔ NetSuite disagreements about this person. `divergesFromDirectory`
   *  marks the ones adopted from NetSuite that Google still contradicts (HR / IT). */
  /** VeloExpense: always empty until NetSuite arrives (Wave 5, w5-03). */
  syncDiscrepancies: { field: string; divergesFromDirectory: boolean }[];
  employeeStatus: EmployeeStatus;
  /** Whether this person may sign in. Independent of `employeeStatus` — see the select.
   *  VeloExpense: `hasAccess` (ExpenseOS's `hasExpenseOSAccess`). */
  hasAccess: boolean;
  onLeaveAt: Date | null;
  terminationDate: Date | null;
  lastLoginAt: Date | null;
  avatarUrl: string | null;
  role: { id: string; label: Prisma.JsonValue };
  manager: {
    id: string;
    firstName: string | null;
    lastName: string | null;
    role: { id: string; label: Prisma.JsonValue };
  } | null;
};

/**
 * Replace a person's external-id rows to match the map given.
 *
 * Delete-all + recreate, mirroring `syncRoleAliases` — the map sent IS the stored set,
 * so removing a key removes the mapping. An empty value is a removal rather than a
 * stored blank: no system can be asked about a person whose id there is "".
 *
 * THE CONSTRAINT IS THE INTERESTING PART. `UserExternalId` is
 * `@@unique([sourceId, sourceValue])` — one NetSuite employee maps to exactly one
 * ExpenseOS person, and it has to stay that way: the expense-report poster resolves
 * "who is being reimbursed" through it, so two people sharing an id means a
 * reimbursement can post against the wrong employee. A bare `create` would surface that
 * as Prisma's `P2002` on an opaque constraint name. Instead the holder is looked up and
 * named, because "already used by kati.birmingham@e.inc" is the only version of this
 * error anybody can act on.
 *
 * The delete runs first and inside the caller's transaction, so re-saving a person's own
 * unchanged id is not a self-collision.
 *
 * VeloExpense: a source is the tenant's own (0047), found by code inside the tenant and
 * created there, as `syncRoleAliases` does (roles.ts).
 */
async function syncUserAliases(
  tx: Prisma.TransactionClient,
  userId: string,
  externalIds: Record<string, string>,
): Promise<void> {
  await tx.userExternalId.deleteMany({ where: { userId } });
  for (const [code, raw] of Object.entries(externalIds)) {
    const sourceValue = raw.trim();
    if (!sourceValue) continue;
    const source =
      (await tx.externalIdSource.findFirst({ where: { code }, select: { id: true } })) ??
      (await tx.externalIdSource.create({
        data: { code, label: { en: code, 'fr-CA': code } },
        select: { id: true },
      }));
    const held = await tx.userExternalId.findUnique({
      where: { sourceId_sourceValue: { sourceId: source.id, sourceValue } },
      select: { user: { select: { email: true } } },
    });
    if (held) {
      throw new TRPCError({
        code: 'CONFLICT',
        message: `${code} id "${sourceValue}" is already assigned to ${held.user.email}. One ${code} record maps to one person.`,
      });
    }
    await tx.userExternalId.create({ data: { sourceId: source.id, sourceValue, userId } });
  }
}

const DIRECTORY_SELECT = {
  id: true,
  email: true,
  firstName: true,
  lastName: true,
  department: { select: { id: true, label: true } },
  businessUnit: { select: { id: true, label: true } },
  // VeloExpense: no NetSuite business unit, NetSuite class or sync discrepancies until
  // NetSuite arrives (Wave 5, w5-03); `toDirectoryRow` gives the row null / [] for them.
  // The entity carries the person's currency (see `homeCurrency` on the row).
  entity: { select: { id: true, label: true, homeCurrencyId: true } },
  jobLevel: { select: { id: true, label: true } },
  country: true,
  externalIds: { select: { sourceValue: true, source: { select: { code: true } } } },
  employeeStatus: true,
  /**
   * Whether this person may sign in at all — the `signIn` callback refuses without it, for
   * every provider. Independent of `employeeStatus`: somebody can be an active employee with
   * no business in an expense system, and somebody on leave may still need their own history.
   *
   * On the row because it was invisible: the flag shipped with the gate and nothing showed it
   * or changed it, so production spent a release with every real person locked out and nine
   * QA accounts able to sign in, and the only way to see that was to query the database.
   */
  hasAccess: true,
  onLeaveAt: true,
  terminationDate: true,
  lastLoginAt: true,
  avatarUrl: true,
  role: { select: { id: true, label: true } },
  manager: {
    select: {
      id: true,
      firstName: true,
      lastName: true,
      role: { select: { id: true, label: true } },
    },
  },
} as const;

/** The directory query shape before externalIds + homeCurrency are derived. */
type RawDirectoryRow = Omit<
  DirectoryRow,
  | 'externalIds'
  | 'homeCurrency'
  | 'entity'
  | 'nsBusinessUnit'
  | 'nsClass'
  | 'syncDiscrepancies'
  | 'employeeStatus'
> & {
  /** VeloExpense: text with a CHECK (0072), narrowed in `toDirectoryRow`. */
  employeeStatus: string;
  entity: { id: string; label: Prisma.JsonValue; homeCurrencyId: string | null } | null;
  externalIds: Array<{ sourceValue: string; source: { code: string } }>;
};

/** Flatten the external-id alias rows into a { sourceCode: value } map, so the UI keeps
 *  its Record<string,string> contract.
 *  VeloExpense: the currency is the entity's, and the NetSuite fields are empty (Wave 5). */
function toDirectoryRow(raw: RawDirectoryRow): DirectoryRow {
  const { externalIds: rawExternalIds, entity, employeeStatus, ...rest } = raw;
  const externalIds: Record<string, string> = {};
  for (const a of rawExternalIds) externalIds[a.source.code] = a.sourceValue;
  return {
    ...rest,
    // The column's CHECK admits exactly EMPLOYEE_STATUSES (0072).
    employeeStatus: employeeStatus as EmployeeStatus,
    entity: entity ? { id: entity.id, label: entity.label } : null,
    homeCurrency: entity?.homeCurrencyId ?? null,
    externalIds,
    nsBusinessUnit: null,
    nsClass: null,
    syncDiscrepancies: [],
  };
}

/** ExpenseOS's audit actor, from the request. */
function auditActor(ctx: {
  rbac: NonNullable<Context['rbac']>;
  session: NonNullable<Context['session']>;
}) {
  return {
    kind: 'user' as const,
    id: ctx.rbac.id,
    name: [ctx.session.user.name].filter(Boolean).join(' ') || ctx.session.user.email,
    roleLabel: ctx.rbac.roleLabel,
  };
}

/**
 * Set one person's `hasExpenseOSAccess`, with its audit row — what `setAccess` does, and
 * what `setAccessMany` does once per person that changes.
 *
 * VeloExpense: `hasAccess` (0072).
 */
function writeAccess(
  ctx: {
    db: Context['db'];
    rbac: NonNullable<Context['rbac']>;
    session: NonNullable<Context['session']>;
  },
  id: string,
  hasAccess: boolean,
) {
  return withAudit(
    ctx.db,
    {
      action: auditActions.admin.userUpdate,
      entityType: 'User',
      entityId: id,
      actor: auditActor(ctx),
      details: { hasAccess },
    },
    async (tx) => {
      await tx.user.update({ where: { id }, data: { hasAccess } });
      return { ok: true as const };
    },
  );
}

/**
 * VeloExpense: the two statuses that mean somebody has LEFT. Written by `update` (the edit
 * drawer offers every status) as well as by `deactivate`, so both take the same path:
 * `deleted_at` is stamped, which is what sign-in, every request and the seat meter read.
 * ExpenseOS's `update` wrote the status alone, which is the w4-10f bug VeloExpense fixed in
 * its own form (0071): a "Deactivated" person who kept signing in and kept a paid seat.
 */
const LEAVER_STATUSES: readonly EmployeeStatus[] = ['DEACTIVATED', 'TERMINATED'];

/**
 * VeloExpense: how many OTHER people hold System Administrator and are active — ExpenseOS's
 * last-admin count (`setRole`), which VeloExpense also applies to deactivation (w4-10d).
 */
async function otherActiveAdmins(db: Prisma.TransactionClient | Context['db'], id: string) {
  return db.user.count({
    where: { roleId: SYSTEM_ROLE_IDS.admin, employeeStatus: 'ACTIVE', deletedAt: null, id: { not: id } },
  });
}

/**
 * VeloExpense: a reactivation takes a seat back, so it is capped like a new member — the
 * same rule and the same SQL as `assertSeatAvailable` (lib/billing/caps.ts), run on this
 * transaction. Without it a plan's seat cap is walked round by deactivating and reactivating.
 */
async function assertSeatAvailableTx(tx: Prisma.TransactionClient): Promise<void> {
  await assertSeatAvailable(queryRunnerOf(tx as TenantDb)).catch((err: unknown) => {
    if (err instanceof CapReachedError) {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: `This organization's plan allows ${err.limit} people, and that many are active. Deactivate somebody or change the plan first.`,
      });
    }
    throw err;
  });
}

/**
 * ExpenseOS's two guards on `deactivate` — not yourself, and nobody still reporting to them —
 * and VeloExpense's third (w4-10d): not the tenant's last active System Administrator.
 * Shared with `update`, which deactivates too when it writes a leaver status.
 */
async function assertCanDeactivate(
  ctx: { db: Context['db']; rbac: NonNullable<Context['rbac']> },
  id: string,
): Promise<void> {
  if (id === ctx.rbac.id) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Cannot deactivate yourself' });
  }
  const reportsCount = await ctx.db.user.count({
    where: { managerId: id, deletedAt: null },
  });
  if (reportsCount > 0) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `Reassign ${reportsCount} direct report${reportsCount === 1 ? '' : 's'} before deactivating`,
    });
  }
  // VeloExpense (w4-10d): nor the tenant's last active System Administrator.
  const person = await ctx.db.user.findFirst({ where: { id }, select: { roleId: true, deletedAt: true } });
  if (!person) throw new TRPCError({ code: 'NOT_FOUND', message: 'User not found' });
  if (person.deletedAt === null && person.roleId === SYSTEM_ROLE_IDS.admin) {
    if ((await otherActiveAdmins(ctx.db, id)) < 1) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'Cannot deactivate the last active admin' });
    }
  }
}

/**
 * VeloExpense: a deactivation or reactivation changes the tenant's seat count, which the
 * platform bills on (VX5-20). Pushed once the transaction has committed, so it counts the
 * new state, and in the background, as every other seat change is.
 */
function pushSeatsAfterCommit(ctx: { session: NonNullable<Context['session']> }): void {
  const organizationId = ctx.session.user.organizationId;
  void afterCommit(async () => pushSeatCountInBackground(organizationId));
}

export const usersRouter = router({
  // ── List the directory ─────────────────────────────────────────
  // Open to every authenticated user; the `scope` parameter narrows the
  // visible set server-side. 'all' requires P.user.readAll (admin);
  // every other scope is gated by the recursive-chain query itself.
  listDirectory: protectedProcedure
    .input(
      z
        .object({
          cursor: z.string().optional(),
          take: z.number().int().min(1).max(1000).default(50),
          search: z.string().trim().max(100).optional(),
          scope: z.enum(['all', 'direct', 'indirect', 'chain', 'self']).optional(),
          // Per-column operator-based filters. Each filter is a
          // discriminated union — `op` tags the comparison; `value` /
          // `values` carry the operand(s); `isEmpty`/`isNotEmpty` need
          // no operand. An array of filters on the same field is
          // OR-ed together (e.g. "email contains gui OR contains max").
          name: z.union([columnFilterSchema, z.array(columnFilterSchema).min(1)]).optional(),
          status: z.union([columnFilterSchema, z.array(columnFilterSchema).min(1)]).optional(),
          businessUnit: z
            .union([columnFilterSchema, z.array(columnFilterSchema).min(1)])
            .optional(),
          department: z.union([columnFilterSchema, z.array(columnFilterSchema).min(1)]).optional(),
          entity: z.union([columnFilterSchema, z.array(columnFilterSchema).min(1)]).optional(),
          email: z.union([columnFilterSchema, z.array(columnFilterSchema).min(1)]).optional(),
          // `externalIds` is a JSONB column — Prisma's `where` can't
          // do a free-form substring match across all paths, so the
          // handler resolves matching user IDs via a raw query and
          // AND-s the result into the base where.
          externalIds: z.union([columnFilterSchema, z.array(columnFilterSchema).min(1)]).optional(),
          // VeloExpense: no `mfaEnrolled` filter (no second factor; see above).
          // Boolean column, filtered as an enum ('granted' / 'denied') so the pill reads.
          access: z.union([columnFilterSchema, z.array(columnFilterSchema).min(1)]).optional(),
          /**
           * Reporting-line presence. ONLY `isEmpty` / `isNotEmpty` are wired —
           * "who has no manager" is the question this answers, and it is a real
           * operational one: a report from somebody with no manager routes to the
           * approver-pool fallback rather than to a person, so the count here is
           * how much of that is happening. Any other op is rejected rather than
           * silently matching everything.
           */
          manager: z.union([columnFilterSchema, z.array(columnFilterSchema).min(1)]).optional(),
          managerId: z.string().uuid().optional(),
          roleId: z.string().uuid().optional(),
          includeDeleted: z.boolean().default(false),
        })
        .default({ take: 50, includeDeleted: false }),
    )
    .query(async ({ ctx, input: i }) => {
      const take = i.take;
      const search = nz(i.search ?? null);

      // Resolve scope. If the caller didn't pass one, pick a sensible
      // default: admins → 'all', everyone else → 'chain' (their full
      // downward subtree). Empty result is fine for self-only employees.
      const isAdmin = ctx.rbac.permissions.includes(P.user.readAll);
      const scope: DirectoryScope = i.scope ?? (isAdmin ? 'all' : 'chain');

      if (scope === 'all' && !isAdmin) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: "Scope 'all' requires user.read.all permission",
        });
      }

      const scopedIds = await resolveScopedIds(ctx.db, ctx.rbac.id, scope);
      // If scope resolved to an empty set (e.g. employee w/ no reports
      // asked for 'direct'), return immediately — no rows can match.
      if (scopedIds !== null && scopedIds.length === 0) {
        return { items: [] as DirectoryRow[], nextCursor: null as string | null, totalCount: 0 };
      }

      // Stack the per-column operator filters as AND clauses on top
      // of the base scope/soft-delete predicate. When a field carries
      // multiple filters (e.g. email contains "gui" or contains "max"),
      // they OR together; different fields still AND across.
      const oneOrMany = (
        field: string,
        f: ColumnFilter | ColumnFilter[],
      ): Prisma.UserWhereInput => {
        if (!Array.isArray(f)) return columnFilterToWhere(field, f);
        const sole = f[0];
        if (f.length === 1 && sole) return columnFilterToWhere(field, sole);
        return { OR: f.map((one) => columnFilterToWhere(field, one)) };
      };
      const nameOneOrMany = (f: ColumnFilter | ColumnFilter[]): Prisma.UserWhereInput => {
        if (!Array.isArray(f)) return nameFilterToWhere(f);
        const sole = f[0];
        if (f.length === 1 && sole) return nameFilterToWhere(sole);
        return { OR: f.map((one) => nameFilterToWhere(one)) };
      };
      const colFilters: Prisma.UserWhereInput[] = [];
      if (i.name) colFilters.push(nameOneOrMany(i.name));
      if (i.status) colFilters.push(oneOrMany('employeeStatus', i.status));
      if (i.businessUnit) colFilters.push(oneOrMany('businessUnitId', i.businessUnit));
      if (i.department) colFilters.push(oneOrMany('departmentId', i.department));
      if (i.entity) colFilters.push(oneOrMany('legalEntityId', i.entity));
      if (i.email) colFilters.push(oneOrMany('email', i.email));
      if (i.manager) colFilters.push(managerPresenceWhere(i.manager));
      if (i.access) {
        const w = accessWhere(i.access);
        if (w) colFilters.push(w);
      }

      // `externalIds` is JSONB — Prisma's `where` can't search across
      // all paths in one query, so we run a small raw lookup that
      // matches any value in the map (cast to text + ILIKE) and AND
      // the result IDs into the base where. Cheap on 10k-20k rows;
      // promote to a trigram index if it ever bottlenecks.
      if (i.externalIds) {
        const list = Array.isArray(i.externalIds) ? i.externalIds : [i.externalIds];
        const orFragments: Prisma.Sql[] = list.map((f) => externalIdsFragment(f));
        const idsRows = await ctx.db.$queryRaw<Array<{ id: string }>>`
          SELECT u.id FROM app_user u
          WHERE ${Prisma.join(orFragments, ' OR ')}
        `;
        const matchedIds = idsRows.map((r) => r.id);
        if (matchedIds.length === 0) {
          return { items: [] as DirectoryRow[], nextCursor: null as string | null, totalCount: 0 };
        }
        colFilters.push({ id: { in: matchedIds } });
      }

      const baseWhere: Prisma.UserWhereInput = {
        ...(scopedIds ? { id: { in: scopedIds } } : {}),
        ...(i.managerId ? { managerId: i.managerId } : {}),
        ...(i.roleId ? { roleId: i.roleId } : {}),
        ...(i.includeDeleted ? {} : { deletedAt: null }),
        ...(colFilters.length > 0 ? { AND: colFilters } : {}),
      };

      // Count is cheap-ish even on Postgres for 1k-10k rows. Filtered to
      // the same predicate so the header reflects the current view.
      const totalCount = await ctx.db.user.count({ where: baseWhere });

      // ── Search path: fuzzy match via pg_trgm, no cursor ─────────
      // Two-step: pg_trgm ranks candidate IDs (only scope + soft-delete
      // applied in SQL so the trigram index is fully usable). Then
      // Prisma findMany on those IDs applies the per-column operator
      // filters. The split keeps the operator translation in one
      // place (`columnFilterToWhere`) rather than duplicated as raw
      // SQL fragments.
      if (search) {
        const SIM_THRESHOLD = 0.2;
        // External-ID matches (NetSuite, ADP, …) are surfaced via a
        // case-insensitive substring search against the per-entity alias
        // table. They get a forced rank of 1.0 so an exact ID match floats
        // above name-similarity hits.
        const idMatchPattern = `%${search}%`;
        const extIdMatch = Prisma.sql`EXISTS (SELECT 1 FROM user_external_id uei WHERE uei.user_id = u.id AND uei.source_value ILIKE ${idMatchPattern})`;
        const rankedIds = await ctx.db.$queryRaw<Array<{ id: string; rank: number }>>`
          SELECT u.id,
                 GREATEST(
                   similarity(COALESCE(u.first_name,''), ${search}),
                   similarity(COALESCE(u.last_name,''),  ${search}),
                   similarity(u.email, ${search}),
                   CASE WHEN ${extIdMatch} THEN 1.0 ELSE 0 END
                 ) AS rank
          FROM app_user u
          WHERE
            (u.first_name % ${search}
              OR u.last_name % ${search}
              OR u.email % ${search}
              OR u.email ILIKE ${idMatchPattern}
              OR ${extIdMatch})
            ${scopedIds ? Prisma.sql`AND u.id = ANY(${scopedIds}::uuid[])` : Prisma.empty}
            ${i.includeDeleted ? Prisma.empty : Prisma.sql`AND u.deleted_at IS NULL`}
            AND GREATEST(
              similarity(COALESCE(u.first_name,''), ${search}),
              similarity(COALESCE(u.last_name,''),  ${search}),
              similarity(u.email, ${search}),
              CASE WHEN ${extIdMatch} THEN 1.0 ELSE 0 END
            ) >= ${SIM_THRESHOLD}
          ORDER BY rank DESC, u.first_name ASC NULLS LAST, u.last_name ASC NULLS LAST, u.id ASC
          LIMIT ${take}
        `;

        const ids = rankedIds.map((r) => r.id);
        if (ids.length === 0) {
          return { items: [] as DirectoryRow[], nextCursor: null as string | null, totalCount };
        }
        const itemsUnordered = await ctx.db.user.findMany({
          where: {
            id: { in: ids },
            ...(colFilters.length > 0 ? { AND: colFilters } : {}),
          },
          select: DIRECTORY_SELECT,
        });
        // Preserve the rank ordering from the raw query.
        const byId = new Map(itemsUnordered.map((u) => [u.id, u]));
        const items = ids
          .map((id) => byId.get(id))
          .filter((u): u is RawDirectoryRow => Boolean(u))
          .map(toDirectoryRow);
        return { items, nextCursor: null as string | null, totalCount };
      }

      // ── No-search path: tuple cursor by (firstName, lastName, id) ─
      const cursor = i.cursor ? decodeDirectoryCursor(i.cursor) : null;

      const where: Prisma.UserWhereInput = {
        ...baseWhere,
        ...(cursor ? { OR: tupleGreaterThan(cursor) } : {}),
      };

      const rows = await ctx.db.user.findMany({
        where,
        orderBy: [
          { firstName: { sort: 'asc', nulls: 'last' } },
          { lastName: { sort: 'asc', nulls: 'last' } },
          { id: 'asc' },
        ],
        take: take + 1, // peek one ahead
        select: DIRECTORY_SELECT,
      });

      const hasMore = rows.length > take;
      const items = (hasMore ? rows.slice(0, take) : rows).map(toDirectoryRow);
      const last = items[items.length - 1];
      const nextCursor =
        hasMore && last
          ? encodeDirectoryCursor({
              firstName: last.firstName,
              lastName: last.lastName,
              id: last.id,
            })
          : null;

      return { items, nextCursor, totalCount };
    }),

  // ── Filter facets (distinct BUs + departments for the directory) ─
  // Open to every signed-in user. None of this data is sensitive — the
  // values are visible on every row of the directory anyway.
  listFilterFacets: protectedProcedure.query(async ({ ctx }) => {
    // Org facets are the in-use lookup rows (at least one non-deleted user).
    // {id,label} — the rail renders the label, filters by id. Can't orderBy a
    // Json label, so order by createdAt (stable).
    const inUse = { users: { some: { deletedAt: null } } } as const;
    const [bus, depts, entities, roles, externalIdSources] = await Promise.all([
      ctx.db.businessUnit.findMany({
        where: { active: true, ...inUse },
        select: { id: true, label: true },
        orderBy: { createdAt: 'asc' },
      }),
      ctx.db.department.findMany({
        where: { active: true, ...inUse },
        select: { id: true, label: true },
        orderBy: { createdAt: 'asc' },
      }),
      // Legal entities are few; list all active (used by the edit-employee form,
      // not the filter rail, so no in-use restriction).
      ctx.db.legalEntity.findMany({
        where: { active: true },
        select: { id: true, label: true },
        orderBy: { createdAt: 'asc' },
      }),
      ctx.db.role.findMany({
        where: { active: true },
        select: { id: true, label: true },
        orderBy: { id: 'asc' },
      }),
      /**
       * The systems a person can carry an id in, so the edit drawer can offer a field
       * per source instead of hard-coding "netsuite". Ordered by code so the fields do
       * not reshuffle between renders.
       */
      ctx.db.externalIdSource.findMany({
        where: { active: true },
        select: { code: true, label: true },
        orderBy: { code: 'asc' },
      }),
    ]);
    return {
      businessUnits: bus,
      departments: depts,
      legalEntities: entities,
      roles,
      externalIdSources,
    };
  }),

  // ── Filter-scoped facet counts ─────────────────────────────────
  //
  // For each requested field, returns `{value, count}` pairs that
  // reflect "what would the table show if this value were ALSO
  // selected, given all currently-applied filters EXCEPT this
  // field's own". Per-field GROUP BY queries run in parallel,
  // gated by:
  //
  //   - 500K row threshold: above estimated table size,
  //     degrade to GLOBAL counts (no scope/filter predicates) —
  //     `scoped: false` in the response.
  //   - 2s statement timeout per field: on timeout, retry without
  //     predicates and tag `scoped: false`.
  //   - Top-100 cap per field: ORDER BY count DESC LIMIT 100.
  //   - 5-minute Redis cache (employee directory changes slowly).
  //
  // The policy lives inline here per the "no central registry"
  // architecture — each resource's procedure owns its own knobs.
  facetCounts: protectedProcedure
    .input(
      z.object({
        scope: z.enum(['all', 'direct', 'indirect', 'chain', 'self']).optional(),
        // Per-field filter state — same shape as listDirectory.
        name: z.union([columnFilterSchema, z.array(columnFilterSchema).min(1)]).optional(),
        status: z.union([columnFilterSchema, z.array(columnFilterSchema).min(1)]).optional(),
        businessUnit: z.union([columnFilterSchema, z.array(columnFilterSchema).min(1)]).optional(),
        department: z.union([columnFilterSchema, z.array(columnFilterSchema).min(1)]).optional(),
        entity: z.union([columnFilterSchema, z.array(columnFilterSchema).min(1)]).optional(),
        email: z.union([columnFilterSchema, z.array(columnFilterSchema).min(1)]).optional(),
        externalIds: z.union([columnFilterSchema, z.array(columnFilterSchema).min(1)]).optional(),
        includeDeleted: z.boolean().default(false),
        // Which facets to compute. Caller specifies — typically the
        // facet rail's three: status / businessUnit / department.
        fields: z.array(z.enum(['status', 'businessUnit', 'department'])).min(1),
      }),
    )
    .query(async ({ ctx, input: i }) => {
      // ─── Policy (inline — see header comment) ────────────────
      const ROW_THRESHOLD = 500_000;
      const TOP_N = 100;
      const CACHE_TTL_SEC = 5 * 60;
      const QUERY_TIMEOUT_MS = 2000;
      const RESOURCE = 'users';

      // ─── Scope resolution ───────────────────────────────────
      const isAdmin = ctx.rbac.permissions.includes(P.user.readAll);
      const scope: DirectoryScope = i.scope ?? (isAdmin ? 'all' : 'chain');
      if (scope === 'all' && !isAdmin) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: "Scope 'all' requires user.read.all permission",
        });
      }
      const scopedIds = await resolveScopedIds(ctx.db, ctx.rbac.id, scope);

      // ─── Table size check (cheap via pg_class.reltuples) ────
      let degradeAllToGlobal = false;
      try {
        const [{ reltuples }] = await ctx.db.$queryRaw<Array<{ reltuples: number }>>`
          SELECT reltuples::bigint AS reltuples
          FROM pg_class
          WHERE relname = 'app_user'
          LIMIT 1
        `;
        if (Number(reltuples) > ROW_THRESHOLD) degradeAllToGlobal = true;
      } catch {
        // pg_class not accessible — assume small.
      }

      // ─── Scope bucket for cache key ──────────────────────────
      // `all` (admin global) shares one cache entry across admins.
      // Anything else is per-user since the chain/direct query is
      // user-relative.
      //
      // VeloExpense: one Redis for every tenant, so the bucket names the tenant first. Without
      // it, the 'all' bucket would hand one organization's counts to another's admins.
      const tenant = ctx.session.user.organizationId;
      const scopeBucket = scope === 'all' ? `${tenant}:all` : `${tenant}:${scope}:${ctx.rbac.id}`;

      // Build the WHERE fragment that's used for ALL fields (scope
      // + soft-delete). Empty `id IN ()` is impossible in Postgres
      // so we early-return when the scope resolves to no ids.
      if (scopedIds !== null && scopedIds.length === 0) {
        const empty: Record<string, Array<{ value: string; count: number }>> = {};
        for (const f of i.fields) empty[f] = [];
        return { scoped: !degradeAllToGlobal, counts: empty };
      }

      // ─── Compute each facet field in parallel ────────────────
      const filtersByField: Record<string, ColumnFilter | ColumnFilter[] | undefined> = {
        name: i.name,
        status: i.status,
        businessUnit: i.businessUnit,
        department: i.department,
        entity: i.entity,
        email: i.email,
        externalIds: i.externalIds,
      };

      const perField = await Promise.all(
        i.fields.map(async (field) => {
          // Cache key = resource + scope-bucket + this-field +
          // hash of (all other filters + includeDeleted).
          const otherFilters: Record<string, unknown> = {
            includeDeleted: i.includeDeleted,
          };
          for (const [k, v] of Object.entries(filtersByField)) {
            if (k === field) continue;
            if (v !== undefined) otherFilters[k] = v;
          }
          const filterHash = hashFilterPayload(otherFilters);
          const cacheKey = buildCacheKey({
            resource: RESOURCE,
            scopeBucket,
            field,
            filterHash,
          });

          const entry = await getOrSetFacetEntry(cacheKey, CACHE_TTL_SEC, async () => {
            return runFieldCount({
              db: ctx.db,
              dbColumn: SERVER_COLUMN_FOR_FIELD[field],
              scopedIds,
              includeDeleted: i.includeDeleted,
              otherFilters: degradeAllToGlobal
                ? {} // global: drop all filter predicates
                : (Object.fromEntries(
                    Object.entries(filtersByField).filter(
                      ([k, v]) => k !== field && v !== undefined,
                    ),
                  ) as Record<string, ColumnFilter | ColumnFilter[]>),
              forceGlobalScope: degradeAllToGlobal,
              topN: TOP_N,
              timeoutMs: QUERY_TIMEOUT_MS,
            });
          });

          return [field, entry] as const;
        }),
      );

      const anyDegraded = perField.some(([, e]) => !e.scoped);

      // FK-valued facets (businessUnit/department/entity) group by the FK id;
      // resolve {id → label} so the rail can render labels while filtering by
      // id. `status` stays enum-valued (label resolved client-side).
      const labelFetchers: Record<
        string,
        (ids: string[]) => Promise<Map<string, Prisma.JsonValue>>
      > = {
        businessUnit: async (ids) =>
          new Map(
            (
              await ctx.db.businessUnit.findMany({
                where: { id: { in: ids } },
                select: { id: true, label: true },
              })
            ).map((r) => [r.id, r.label]),
          ),
        department: async (ids) =>
          new Map(
            (
              await ctx.db.department.findMany({
                where: { id: { in: ids } },
                select: { id: true, label: true },
              })
            ).map((r) => [r.id, r.label]),
          ),
        entity: async (ids) =>
          new Map(
            (
              await ctx.db.legalEntity.findMany({
                where: { id: { in: ids } },
                select: { id: true, label: true },
              })
            ).map((r) => [r.id, r.label]),
          ),
      };

      const counts: Record<
        string,
        Array<{ value: string; label?: Prisma.JsonValue; count: number }>
      > = {};
      for (const [field, e] of perField) {
        const fetcher = labelFetchers[field];
        if (!fetcher) {
          counts[field] = e.values;
          continue;
        }
        const ids = e.values.map((v) => v.value);
        const labels = ids.length > 0 ? await fetcher(ids) : new Map();
        counts[field] = e.values.map((v) => ({
          value: v.value,
          label: labels.get(v.value) ?? null,
          count: v.count,
        }));
      }

      return {
        scoped: !degradeAllToGlobal && !anyDegraded,
        counts,
      };
    }),

  // ── Get one user (admin OR self OR downward chain) ─────────────
  get: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const allowed = await canViewUser(ctx.db, ctx.rbac, input.id);
      if (!allowed) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'User not visible' });
      }
      const user = await ctx.db.user.findUnique({
        where: { id: input.id },
        select: DIRECTORY_SELECT,
      });
      if (!user) throw new TRPCError({ code: 'NOT_FOUND' });
      return toDirectoryRow(user);
    }),

  // ── Direct reports of a user (own OR admin) ────────────────────
  getDirectReports: protectedProcedure
    .input(
      z.object({
        userId: z.string().uuid(),
        status: employeeStatusSchema.optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const isSelf = input.userId === ctx.rbac.id;
      const isAdmin = ctx.rbac.permissions.includes(P.user.readAll);
      if (!isSelf && !isAdmin) {
        // Also allow if userId is in the caller's downward chain.
        const allowed = await canViewUser(ctx.db, ctx.rbac, input.userId);
        if (!allowed) {
          throw new TRPCError({ code: 'FORBIDDEN' });
        }
      }
      const items = await ctx.db.user.findMany({
        where: {
          managerId: input.userId,
          ...(input.status ? { employeeStatus: input.status } : {}),
        },
        orderBy: [
          { firstName: { sort: 'asc', nulls: 'last' } },
          { lastName: { sort: 'asc', nulls: 'last' } },
          { id: 'asc' },
        ],
        select: DIRECTORY_SELECT,
      });
      return { items: items.map(toDirectoryRow) };
    }),

  /**
   * What this person has DONE — their expense reports and their delegations.
   *
   * The drawer showed "coming soon" for both while the features had long shipped, so an
   * admin looking into somebody's account had to leave and go hunting in two other
   * screens. It exists as its own procedure rather than reusing `expenses.list` and
   * `delegations.list` because both of those answer "mine": `expenses.list` hardwires
   * `submitterId` to the caller and converts every row into the CALLER's currency, which
   * is the wrong number to print in someone else's drawer.
   *
   * Each half is authorised separately, because the two permissions are held separately —
   * a manager may see their reports' delegations without seeing their expense reports.
   * Viewing your own always shows both.
   *
   * `null` means "you may not see this"; `[]` means "there are none". The distinction is
   * the point: an empty list where the reader has no access reads as "this person has
   * filed nothing", which is exactly the false conclusion the old placeholder existed to
   * prevent.
   */
  activity: protectedProcedure
    .input(z.object({ id: z.string().uuid(), limit: z.number().int().min(1).max(50).default(10) }))
    .query(async ({ ctx, input }) => {
      // The same visibility rule as `get` — admin, self, or the downward chain — decides
      // whether the drawer opens at all, so it decides this too.
      if (!(await canViewUser(ctx.db, ctx.rbac, input.id))) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'User not visible' });
      }

      const isSelf = input.id === ctx.rbac.id;
      const perms = ctx.rbac.permissions;
      const canReadReports = isSelf
        ? perms.includes(P.expense.report.readOwn)
        : perms.includes(P.expense.report.readAll);
      const canReadDelegations = isSelf || perms.includes(P.delegation.viewAll);

      const [reportRows, delegationRows] = await Promise.all([
        canReadReports
          ? ctx.db.expenseReport.findMany({
              where: { submitterId: input.id },
              orderBy: { updatedAt: 'desc' },
              take: input.limit,
              select: {
                id: true,
                title: true,
                status: true,
                totalMinor: true,
                submittedAt: true,
                createdAt: true,
                // Reported in the report's OWN currency. Converting into the reader's
                // would put a number on screen that belongs to neither of them.
                currency: { select: { code: true } },
                _count: { select: { expenses: true } },
              },
            })
          : Promise.resolve(null),
        canReadDelegations
          ? ctx.db.delegation.findMany({
              // VeloExpense: the table's names (0008) — from/to for delegator/delegatee,
              // startsOn/endsOn for startsAt/endsAt — and `revokedAt: null` is ExpenseOS's
              // `active`, as the approval engine reads it (packages/approvals engine.ts).
              where: { OR: [{ fromUserId: input.id }, { toUserId: input.id }] },
              orderBy: [{ revokedAt: { sort: 'desc', nulls: 'first' } }, { startsOn: 'desc' }],
              take: input.limit,
              select: {
                id: true,
                fromUserId: true,
                toUserId: true,
                startsOn: true,
                endsOn: true,
                scope: true,
                revokedAt: true,
                fromUser: { select: { id: true, firstName: true, lastName: true, email: true } },
                toUser: { select: { id: true, firstName: true, lastName: true, email: true } },
              },
            })
          : Promise.resolve(null),
      ]);

      return {
        canReadReports,
        canReadDelegations,
        reports:
          reportRows?.map((r) => ({
            id: r.id,
            title: r.title,
            status: r.status,
            // BigInt does not survive the wire; the client formats from the string.
            totalMinor: r.totalMinor.toString(),
            currencyCode: r.currency.code,
            // VeloExpense: `currency` holds no symbol; Intl's narrow symbol (Wave 2).
            currencySymbol: currencySymbol(r.currency.code),
            expenseCount: r._count.expenses,
            /** Submitted date where there is one, else when it was started. */
            date: r.submittedAt ?? r.createdAt,
          })) ?? null,
        delegations:
          delegationRows?.map((d) => ({
            id: d.id,
            scope: d.scope,
            active: d.revokedAt === null,
            startsAt: d.startsOn,
            endsAt: d.endsOn,
            /** Which side of the arrangement the viewed person is on. */
            direction: d.fromUserId === input.id ? ('OUTGOING' as const) : ('INCOMING' as const),
            /** The OTHER person — the one the row is worth naming. */
            counterparty: d.fromUserId === input.id ? d.toUser : d.fromUser,
          })) ?? null,
      };
    }),

  // ── Mutations (admin) ──────────────────────────────────────────
  /**
   * Add one person from an email address alone.
   *
   * VeloExpense (decided 16 Oct 2026): adding somebody SENDS AN INVITATION. VX5-3 made the
   * invitation the only way into a tenant — the person's row is created when they accept, by
   * signing in with that verified address (lib/auth/resolve-sso-user.ts), and that is when
   * they take a seat. So ExpenseOS's Google Workspace directory lookup and its direct insert
   * are not ported; the email is the one field, as in ExpenseOS, and they get the default
   * role, as an invitation from the old Employees screen does.
   *
   * What stays ExpenseOS's: the address is trimmed and lowercased, and somebody already here
   * is REPORTED (with whether they are deactivated) rather than thrown, so the next act is
   * obvious — reactivate, rather than add again.
   *
   * Audited by the invitation itself (`INVITE_SENT` / `INVITE_RESENT`, lib/invites/service.ts),
   * where ExpenseOS writes `admin.user.create`: nobody is created here.
   */
  create: withPermission(P.user.create)
    .input(
      z.object({
        // Trimmed and lowercased here rather than in the UI: `User.email` is `@unique`, and
        // "John.Rim@e.inc " would create a second row for a person who is already here.
        email: z.string().trim().toLowerCase().email().max(320),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const already = await ctx.db.user.findFirst({
        where: { email: { equals: input.email, mode: 'insensitive' } },
        select: { id: true, firstName: true, lastName: true, email: true, deletedAt: true },
      });
      if (already) {
        return {
          status: 'exists' as const,
          userId: already.id,
          deactivated: already.deletedAt !== null,
          name:
            [already.firstName, already.lastName].filter(Boolean).join(' ').trim() || already.email,
        };
      }
      try {
        const issued = await sendInvite(
          queryRunnerOf(ctx.db as TenantDb),
          {
            id: ctx.rbac.id,
            name: ctx.session.user.name ?? ctx.session.user.email,
            role: ctx.rbac.roleLabel,
          },
          { email: input.email, roleId: DEFAULT_ROLE_ID },
          { permissions: ctx.rbac.permissions },
        );
        return { status: 'invited' as const, email: input.email, resent: issued.resent };
      } catch (err) {
        if (err instanceof InviteError) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: err.message, cause: err });
        }
        throw err;
      }
    }),

  update: withPermission(P.user.update)
    .input(
      z.object({
        id: z.string().uuid(),
        patch: z
          .object({
            firstName: z.string().min(1).max(100).nullable().optional(),
            lastName: z.string().min(1).max(100).nullable().optional(),
            departmentId: z.string().uuid().nullable().optional(),
            businessUnitId: z.string().uuid().nullable().optional(),
            legalEntityId: z.string().uuid().nullable().optional(),
            jobLevelId: z.string().uuid().nullable().optional(),
            country: z.string().length(2).nullable().optional(),
            // VeloExpense: no `homeCurrencyId` — a person's currency is their legal entity's
            // (Wave 2), so there is nothing of the person's own to write.
            employeeStatus: employeeStatusSchema.optional(),
            onLeaveAt: z.date().nullable().optional(),
            terminationDate: z.date().nullable().optional(),
            managerId: z.string().uuid().nullable().optional(),
            /**
             * `{ [ExternalIdSource.code]: value }` — what other systems call this person.
             *
             * A full REPLACE when present: the map sent is the map stored, so clearing a
             * field removes that mapping. Omit the key entirely to leave every mapping
             * untouched, which is what a patch that never opened this section does.
             *
             * An empty-string value means "remove this one" rather than "store a blank",
             * because a blank external id is not a thing any system can be asked about.
             */
            externalIds: z
              .record(z.string().trim().min(1).max(64), z.string().trim().max(200))
              .optional(),
          })
          .strict(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (input.patch.managerId === input.id) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Cannot set self as manager' });
      }
      // VeloExpense: the person and the manager are read inside the tenant (RLS), so another
      // tenant's id is "not found" here rather than a foreign-key error from the write.
      const current = await ctx.db.user.findFirst({
        where: { id: input.id },
        select: { id: true, deletedAt: true, roleId: true },
      });
      if (!current) throw new TRPCError({ code: 'NOT_FOUND', message: 'User not found' });
      if (input.patch.managerId) {
        const manager = await ctx.db.user.findFirst({
          where: { id: input.patch.managerId },
          select: { id: true },
        });
        if (!manager) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'That manager is not in this organization' });
        }
      }
      // Cycle detection: walk UP from the proposed manager; refuse if
      // we reach `input.id` within 20 hops.
      if (input.patch.managerId) {
        let walker: string | null = input.patch.managerId;
        for (let i = 0; i < 20 && walker !== null; i += 1) {
          if (walker === input.id) {
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message: 'Setting this manager would create a reporting-chain cycle',
            });
          }
          const next: { managerId: string | null } | null = await ctx.db.user.findUnique({
            where: { id: walker },
            select: { managerId: true },
          });
          walker = next?.managerId ?? null;
        }
      }

      /*
       * VeloExpense: a status that means somebody has left, or one that brings them back,
       * is a deactivation or a reactivation, with their guards and their seat (see
       * LEAVER_STATUSES). ExpenseOS's `update` writes the status alone.
       */
      const status = input.patch.employeeStatus;
      const leaving = status !== undefined && LEAVER_STATUSES.includes(status) && current.deletedAt === null;
      const returning = status !== undefined && !LEAVER_STATUSES.includes(status) && current.deletedAt !== null;
      if (leaving) await assertCanDeactivate(ctx, input.id);

      const changedFields = Object.keys(input.patch);
      /**
       * External ids are alias ROWS, not columns, so they cannot ride in the same
       * `user.update` data payload — passing them through would make Prisma reject the
       * whole write with "Unknown argument `externalIds`".
       */
      const { externalIds, ...scalarPatch } = input.patch;

      const row = await withAudit(
        ctx.db,
        {
          action: auditActions.admin.userUpdate,
          entityType: 'User',
          entityId: input.id,
          actor: auditActor(ctx),
          details: { changedFields },
        },
        async (tx) => {
          if (returning) await assertSeatAvailableTx(tx);
          if (externalIds !== undefined) {
            await syncUserAliases(tx, input.id, externalIds);
          }
          const updated = await tx.user.update({
            where: { id: input.id },
            // Prisma treats an empty `data` as a no-op update, which still returns the
            // row — so an externalIds-only patch reads back correctly without a branch.
            data: {
              ...scalarPatch,
              ...(leaving ? { deletedAt: new Date() } : {}),
              ...(returning ? { deletedAt: null } : {}),
            },
            select: DIRECTORY_SELECT,
          });
          // As `deactivate`: the leaver's open reports go to their manager.
          if (leaving) await rollUpOnOffboard(tx, input.id);
          return toDirectoryRow(updated);
        },
      );
      if (leaving || returning) pushSeatsAfterCommit(ctx);
      return row;
    }),

  setRole: withPermission(P.user.setRole)
    .input(z.object({ id: z.string().uuid(), roleId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const [target, newRole] = await Promise.all([
        ctx.db.user.findUnique({
          where: { id: input.id },
          select: { id: true, roleId: true },
        }),
        // VeloExpense: a role is the tenant's (keyed by organization and id), found by id
        // inside the tenant.
        ctx.db.role.findFirst({
          where: { id: input.roleId },
          select: { id: true, active: true, permissions: true },
        }),
      ]);
      if (!target) throw new TRPCError({ code: 'NOT_FOUND', message: 'User not found' });
      if (!newRole?.active) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Role not found or inactive' });
      }
      if (target.roleId === newRole.id) return { ok: true as const, unchanged: true };

      // Last-admin guard: if demoting from the admin system role and
      // the new role doesn't grant P.admin.role.update, refuse if the
      // org would be left with zero active users carrying that perm.
      // (We key off the system-role UUID, not a legacy `code` column.)
      const ADMIN_ID = SYSTEM_ROLE_IDS.admin;
      if (target.roleId === ADMIN_ID && newRole.id !== ADMIN_ID) {
        const remainingAdmins = await otherActiveAdmins(ctx.db, input.id);
        if (remainingAdmins < 1) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'Cannot demote the last active admin',
          });
        }
      }

      // Self-lockout guard: caller can't strip their own user.setRole.
      if (input.id === ctx.rbac.id && !newRole.permissions.includes(P.user.setRole)) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Cannot change your own role to one without user.setRole',
        });
      }

      // Grant ceiling: you cannot assign a role carrying permissions you don't
      // already hold — otherwise any holder of user.setRole could mint a more
      // privileged role (e.g. admin) for anyone, including themselves
      // (horizontal-to-vertical escalation). Admins hold every permission, so
      // they are unaffected.
      const callerPerms = new Set<string>(ctx.rbac.permissions);
      const escalating = newRole.permissions.filter((p) => !callerPerms.has(p));
      if (escalating.length > 0) {
        const sample = escalating.slice(0, 3).join(', ');
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: `Cannot assign a role with permissions you do not hold: ${sample}${escalating.length > 3 ? '…' : ''}`,
        });
      }

      const result = await withAudit(
        ctx.db,
        {
          action: auditActions.admin.userRoleChange,
          entityType: 'User',
          entityId: input.id,
          actor: auditActor(ctx),
          details: {
            fromRoleId: target.roleId,
            toRoleId: newRole.id,
          },
        },
        async (tx) => {
          return tx.user.update({
            where: { id: input.id },
            // VeloExpense: no session epoch to bump — every request reads the person's role
            // from the database (`resolveTenantMember`), so the change takes effect at once.
            data: { roleId: newRole.id },
            select: { id: true },
          });
        },
      );
      return { ok: true as const, id: result.id };
    }),

  setOnLeave: withPermission(P.user.setOnLeave)
    .input(z.object({ id: z.string().uuid(), onLeave: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      // VeloExpense: not for somebody who has left — moving them to ACTIVE here would revive
      // the status without the seat or `deleted_at` (see LEAVER_STATUSES). Reactivate them.
      const person = await ctx.db.user.findFirst({
        where: { id: input.id },
        select: { deletedAt: true },
      });
      if (!person) throw new TRPCError({ code: 'NOT_FOUND', message: 'User not found' });
      if (person.deletedAt !== null) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Reactivate this person first' });
      }
      return withAudit(
        ctx.db,
        {
          action: auditActions.admin.userUpdate,
          entityType: 'User',
          entityId: input.id,
          actor: auditActor(ctx),
          details: { onLeave: input.onLeave },
        },
        async (tx) => {
          await tx.user.update({
            where: { id: input.id },
            data: {
              employeeStatus: input.onLeave ? 'ON_LEAVE' : 'ACTIVE',
              onLeaveAt: input.onLeave ? new Date() : null,
            },
          });
          return { ok: true as const };
        },
      );
    }),

  /**
   * Grant or revoke sign-in.
   *
   * Gated on `user.setRole` rather than a permission of its own. Assigning a role and
   * granting access are the same class of act — deciding what somebody is authorised to do —
   * and `setRole` is already held only by roles that make that decision. A new permission
   * would also need a migration to reach the roles that already exist in a deployed
   * database, because the seed no longer updates rows it did not create.
   *
   * Audited, like every other change to what a person may do.
   */
  setAccess: withPermission(P.user.setRole)
    .input(z.object({ id: z.string().uuid(), hasAccess: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      // VeloExpense: inside the tenant, so another tenant's id is NOT_FOUND, not a 500.
      const person = await ctx.db.user.findFirst({ where: { id: input.id }, select: { id: true } });
      if (!person) throw new TRPCError({ code: 'NOT_FOUND', message: 'User not found' });
      return writeAccess(ctx, input.id, input.hasAccess);
    }),

  /**
   * Grant or revoke sign-in for a selection of people — the People page's bulk action.
   *
   * One audit row per person whose access actually changes, exactly as if `setAccess` had
   * been called for each: the audit trail answers "who gave Ada access", and a single row
   * naming fifty ids would answer it for nobody. Somebody already in the asked-for state is
   * left alone and not audited, because nothing happened to them.
   *
   * Never revokes the caller's own access. Select-all on the People page includes yourself,
   * and a bulk revoke that signs out the only person able to undo it is not recoverable from
   * the UI. The single `setAccess` keeps no such guard: there the row is chosen by hand.
   */
  setAccessMany: withPermission(P.user.setRole)
    .input(z.object({ ids: z.array(z.string().uuid()).min(1).max(500), hasAccess: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const ids = [...new Set(input.ids)];
      const people = await ctx.db.user.findMany({
        where: { id: { in: ids }, deletedAt: null },
        select: { id: true, hasAccess: true },
      });
      let changed = 0;
      let unchanged = 0;
      let skippedSelf = 0;
      for (const person of people) {
        if (!input.hasAccess && person.id === ctx.rbac.id) {
          skippedSelf++;
        } else if (person.hasAccess === input.hasAccess) {
          unchanged++;
        } else {
          await writeAccess(ctx, person.id, input.hasAccess);
          changed++;
        }
      }
      return { changed, unchanged, skippedSelf, notFound: ids.length - people.length };
    }),

  deactivate: withPermission(P.user.deactivate)
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      await assertCanDeactivate(ctx, input.id);
      const result = await withAudit(
        ctx.db,
        {
          action: auditActions.admin.userDeactivate,
          entityType: 'User',
          entityId: input.id,
          actor: auditActor(ctx),
        },
        async (tx) => {
          await tx.user.update({
            where: { id: input.id },
            // VeloExpense: no session epoch; `deletedAt` is read on every request.
            data: {
              deletedAt: new Date(),
              employeeStatus: 'DEACTIVATED',
            },
          });
          // Roll the departing employee's cards + open reports up to their
          // manager (or freeze/flag cards for AP when there's no manager), in
          // the same transaction so offboarding is atomic.
          // VeloExpense: reports only — no cards (packages/db/src/offboarding.ts).
          const rollup = await rollUpOnOffboard(tx, input.id);
          return { ok: true as const, rollup };
        },
      );
      pushSeatsAfterCommit(ctx);
      return result;
    }),

  reactivate: withPermission(P.user.deactivate)
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const person = await ctx.db.user.findFirst({ where: { id: input.id }, select: { deletedAt: true } });
      if (!person) throw new TRPCError({ code: 'NOT_FOUND', message: 'User not found' });
      const result = await withAudit(
        ctx.db,
        {
          action: auditActions.admin.userReactivate,
          entityType: 'User',
          entityId: input.id,
          actor: auditActor(ctx),
        },
        async (tx) => {
          // VeloExpense: a returning person takes a seat back (see assertSeatAvailableTx).
          if (person.deletedAt !== null) await assertSeatAvailableTx(tx);
          await tx.user.update({
            where: { id: input.id },
            data: { deletedAt: null, employeeStatus: 'ACTIVE' },
          });
          return { ok: true as const };
        },
      );
      if (person.deletedAt !== null) pushSeatsAfterCommit(ctx);
      return result;
    }),
});

// ── helpers ────────────────────────────────────────────────────────
/**
 * Build the OR clauses for "(firstName, lastName, id) > cursor" using
 * Prisma's nullable-aware comparisons. Null-handling intentionally
 * matches the orderBy NULLS LAST semantics.
 */
function tupleGreaterThan(c: DirectoryCursor): Prisma.UserWhereInput[] {
  const fn = c.firstName;
  const ln = c.lastName;
  return [
    fn === null
      ? // After null firstNames, no rows remain — empty set.
        { id: { equals: '00000000-0000-0000-0000-000000000000' as const } }
      : { firstName: { gt: fn } },
    {
      firstName: fn === null ? null : { equals: fn },
      OR: [
        ln === null
          ? { id: { equals: '00000000-0000-0000-0000-000000000000' as const } }
          : { lastName: { gt: ln } },
        {
          lastName: ln === null ? null : { equals: ln },
          id: { gt: c.id },
        },
      ],
    },
  ];
}

