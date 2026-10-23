import { SYSTEM_ROLE_IDS } from '@expenseos/rbac';
import { titleToJobLevelCode } from '@expenseos/db';
import { isCountryCode } from '@/lib/countries';
import type { TenantDb } from '@/lib/db/prisma';
import type { DirectoryUser } from './types';

/**
 * w5-04 — ported from ExpenseOS `packages/integrations-google/src/apply.ts` (1e682dd6), and
 * brought to ExpenseOS 67db2e33 (#582, directory sync v2): match by the `google` external id
 * before email, write exactly the fields Google owns (a blank in Google clears ours), never
 * touch department, business unit or legal entity, resolve managers in a second pass.
 *
 * VeloExpense, each marked below:
 *   · NEVER CREATES (d84). ExpenseOS creates a person (employee role, no access) for every
 *     Directory account nobody here matches. VeloExpense never does: a person joins a tenant by
 *     invitation and takes a paid seat, and a nightly job minting seats from a Workspace is the
 *     wrong place for that decision. An account nobody matches is `not-found`, and nothing is
 *     written. ExpenseOS's `allowCreate` option is therefore gone.
 *   · STATUS MOVES ONE WAY (d85). ExpenseOS's #582 makes employment status and termination
 *     date Google-owned in both directions. VeloExpense lets Directory OFFBOARD somebody —
 *     suspended → DEACTIVATED, archived or deleted → TERMINATED, with `deleted_at` stamped as
 *     `users.deactivate` does, because `deleted_at` is what sign-in, every request and the
 *     seat meter read (0071) — and never the reverse: an ACTIVE account does not reactivate
 *     anybody (that takes a seat back, which `users.reactivate` caps) and does not clear
 *     ON_LEAVE, which Directory cannot express. So status and termination date are written
 *     only on an offboarding, and Google's blank does not clear them.
 *   · NOT THE LAST ADMIN. A Directory offboarding of the tenant's last active System
 *     Administrator is HELD — reported, nothing written — as `users.deactivate` refuses it.
 *   · Per tenant: the `google` external-id source is the tenant's own (`external_id_source` is
 *     unique per tenant, 0072), job levels are the tenant's ladder (a recognised title with no
 *     level here is reported as a missing level code), and every read runs on the caller's
 *     tenant transaction.
 *   · Email matches case-insensitively, and a match on two people (VeloExpense's email is
 *     unique per tenant as written, 0001, so `Ada@x` and `ada@x` can both exist) is refused
 *     rather than guessed.
 *   · A country that is not an assigned ISO-3166-1 alpha-2 code is left unchanged and reported
 *     (f75: the same `isCountryCode` as `users.update`): `app_user.country` is held to two
 *     letters by a CHECK (0055), and one bad value would otherwise fail the person.
 */

/** The external-id source a person's Google Directory id is stored under. */
export const GOOGLE_SOURCE_CODE = 'google';

/** The fields Google owns, and the only ones this writes (VeloExpense: status one way). */
export const GOOGLE_OWNED_FIELDS = [
  'firstName',
  'lastName',
  'avatarUrl',
  'jobLevelId',
  'email',
  'managerId',
  'employeeStatus',
  'terminationDate',
  'country',
] as const;
export type GoogleOwnedField = (typeof GOOGLE_OWNED_FIELDS)[number];

/** One field's change, as recorded in the run report. Dates as ISO strings. */
export interface FieldChange {
  from: string | null;
  to: string | null;
}

export interface ApplyOptions {
  /**
   * Resolve and write the manager now. The nightly sync passes false and resolves every
   * manager in a second pass once all people are matched — otherwise a manager listed later
   * than their report is not found on the first night.
   */
  resolveManager?: boolean;
  /** Fall back to an email match. False for a deleted account whose address is live again. */
  allowEmailMatch?: boolean;
  /**
   * Google ids that are live in this run. A person found by email who is linked to a
   * DIFFERENT Google id is re-linked only when that id is not live — the old account was
   * deleted and the address re-issued. Two live accounts claiming one person is a conflict.
   * Unknown means never re-link.
   */
  activeGoogleIds?: ReadonlySet<string>;
  /** The `google` source id, when the caller already resolved it. */
  googleSourceId?: string;
  /** VeloExpense: injectable, so a test can fix the offboarding time. */
  now?: Date;
}

/**
 * VeloExpense: ExpenseOS's outcomes without `created` (d84), plus `not-found` (nobody here
 * matches; nothing written) and `held` (Directory offboarded the tenant's last active admin;
 * nothing written).
 */
export type ApplyOutcome = 'updated' | 'unchanged' | 'conflict' | 'skipped' | 'not-found' | 'held';

export interface ApplyResult {
  outcome: ApplyOutcome;
  userId: string | null;
  /** The `google` external id was written onto an existing person. */
  linked: boolean;
  /** …replacing a link to a Google account that no longer exists. */
  relinked: boolean;
  changes: Partial<Record<GoogleOwnedField, FieldChange>>;
  /** Why a conflict/skip happened, or a note on a partial apply (email kept, …). */
  message?: string;
  /** Google named a manager nobody here has. Left unchanged. */
  managerUnresolved?: boolean;
  /** Google's title maps to no job level rule. Left unchanged. */
  titleUnmapped?: boolean;
  /** VeloExpense: the title mapped to a level code this tenant has no level for. Left unchanged. */
  missingLevelCode?: string;
  /** Google's new primary email belongs to another person here. Email left unchanged. */
  emailConflict?: boolean;
  /** VeloExpense: this apply offboarded the person (status + `deleted_at`, d85). */
  offboarded?: boolean;
}

/** The tenant's `google` external-id source, created if the tenant has none yet. */
export async function googleSourceIdOf(db: TenantDb): Promise<string> {
  // VeloExpense: unique per tenant (0072) — find, else create, under the tenant's RLS.
  const found = await db.externalIdSource.findFirst({
    where: { code: GOOGLE_SOURCE_CODE },
    select: { id: true },
  });
  if (found) return found.id;
  const row = await db.externalIdSource.create({
    data: {
      code: GOOGLE_SOURCE_CODE,
      label: { en: 'Google Workspace', 'fr-CA': 'Google Workspace' },
    },
    select: { id: true },
  });
  return row.id;
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);
const LEAVER = new Set<DirectoryUser['employeeStatus']>(['DEACTIVATED', 'TERMINATED']);

const empty = (outcome: ApplyOutcome, userId: string | null, message?: string): ApplyResult => ({
  outcome,
  userId,
  linked: false,
  relinked: false,
  changes: {},
  ...(message ? { message } : {}),
});

/**
 * Apply one Directory account to VeloExpense.
 *
 * MATCH: the person holding this account's `google` external id; else the person with this
 * email (case-insensitive); else nobody — `not-found` (VeloExpense: never created, d84). A
 * match by email is linked to the account. A person already linked to a different, still-live
 * Google account is a CONFLICT and nothing is written.
 *
 * WRITE: exactly the fields Google owns. Blank in Google CLEARS ours — Google is the source
 * of truth for them. What Google names but VeloExpense cannot resolve (a manager nobody here
 * has, a title with no job level) is left unchanged and reported, because guessing would
 * invent an org chart. Department, business unit and legal entity are never touched.
 *
 * Idempotent: a second call with the same account changes nothing and reports `unchanged`.
 */
export async function applyDirectoryUserToDb(
  db: TenantDb,
  mapped: DirectoryUser,
  options: ApplyOptions = {},
): Promise<ApplyResult> {
  if (!mapped.email) throw new Error('applyDirectoryUserToDb: DirectoryUser.email is required');
  if (!mapped.googleId) {
    throw new Error('applyDirectoryUserToDb: DirectoryUser.googleId is required');
  }
  const resolveManager = options.resolveManager ?? true;
  const allowEmailMatch = options.allowEmailMatch ?? true;
  const sourceId = options.googleSourceId ?? (await googleSourceIdOf(db));

  // ── Match ─────────────────────────────────────────────────────────
  let userId: string | null = null;
  let linked = false;
  let relinked = false;

  const byLink = await db.userExternalId.findFirst({
    where: { sourceId, sourceValue: mapped.googleId },
    select: { userId: true },
  });
  if (byLink) {
    userId = byLink.userId;
  } else if (allowEmailMatch) {
    // VeloExpense: one match only (see the header).
    const byEmail = await db.user.findMany({
      where: { email: { equals: mapped.email, mode: 'insensitive' } },
      select: {
        id: true,
        externalIds: { where: { sourceId }, select: { id: true, sourceValue: true } },
      },
      take: 2,
    });
    if (byEmail.length > 1) {
      return empty(
        'conflict',
        null,
        `More than one person here has ${mapped.email} in different letter cases; refusing to guess.`,
      );
    }
    const person = byEmail[0];
    if (person) {
      const other = person.externalIds.find((x) => x.sourceValue !== mapped.googleId);
      if (other) {
        const stillLive = options.activeGoogleIds
          ? options.activeGoogleIds.has(other.sourceValue)
          : true;
        if (stillLive) {
          return empty(
            'conflict',
            person.id,
            `This person is linked to another Google account (${other.sourceValue}) that still exists; refusing to re-link them to ${mapped.googleId}.`,
          );
        }
        await db.userExternalId.deleteMany({ where: { userId: person.id, sourceId } });
        relinked = true;
      }
      userId = person.id;
      await db.userExternalId.create({
        data: { sourceId, sourceValue: mapped.googleId, userId },
      });
      linked = true;
    }
  }

  if (!userId) {
    // VeloExpense: never create (d84).
    return mapped.deleted
      ? empty('skipped', null, 'Deleted in Google and never known here.')
      : empty('not-found', null, 'Not a person here; people join by invitation.');
  }

  const result = await writeOwnedFields(db, userId, mapped, resolveManager, options.now);
  if (result.held) {
    return {
      ...empty(
        'held',
        userId,
        'Google offboarded the last active administrator here; held, not written.',
      ),
      linked,
      relinked,
    };
  }
  const changed = Object.keys(result.changes).length > 0;
  return {
    ...result,
    outcome: changed || linked ? 'updated' : 'unchanged',
    userId,
    linked,
    relinked,
  };
}

type OwnedRow = {
  email: string;
  firstName: string | null;
  lastName: string | null;
  avatarUrl: string | null;
  jobLevelId: string | null;
  managerId: string | null;
  employeeStatus: DirectoryUser['employeeStatus'];
  terminationDate: Date | null;
  country: string | null;
};

/** Compute and write the Google-owned fields that differ. */
async function writeOwnedFields(
  db: TenantDb,
  userId: string,
  mapped: DirectoryUser,
  resolveManager: boolean,
  now: Date | undefined,
): Promise<
  Pick<
    ApplyResult,
    | 'changes'
    | 'message'
    | 'managerUnresolved'
    | 'titleUnmapped'
    | 'missingLevelCode'
    | 'emailConflict'
    | 'offboarded'
  > & { held?: true }
> {
  const row = await db.user.findUniqueOrThrow({
    where: { id: userId },
    select: {
      email: true,
      firstName: true,
      lastName: true,
      avatarUrl: true,
      jobLevelId: true,
      managerId: true,
      employeeStatus: true,
      terminationDate: true,
      country: true,
      roleId: true,
      deletedAt: true,
    },
  });
  const { roleId, deletedAt: currentDeletedAt, ...owned } = row;
  const current = owned as OwnedRow;

  const desired: Partial<OwnedRow> = {
    firstName: mapped.firstName,
    lastName: mapped.lastName,
    avatarUrl: mapped.avatarUrl,
  };
  const notes: string[] = [];
  let titleUnmapped = false;
  let missingLevelCode: string | undefined;
  let managerUnresolved = false;
  let emailConflict = false;

  // VeloExpense: ISO-2 only (see the header).
  if (mapped.country === null || isCountryCode(mapped.country)) desired.country = mapped.country;
  else notes.push(`Country "${mapped.country}" is not a country code; left unchanged.`);

  // ── Status (VeloExpense: one way, d85) ────────────────────────────
  let deletedAt: Date | undefined;
  let offboarded = false;
  if (LEAVER.has(mapped.employeeStatus)) {
    if (currentDeletedAt === null) {
      if (roleId === SYSTEM_ROLE_IDS.admin) {
        const others = await db.user.count({
          where: {
            roleId: SYSTEM_ROLE_IDS.admin,
            employeeStatus: 'ACTIVE',
            deletedAt: null,
            id: { not: userId },
          },
        });
        if (others < 1) return { changes: {}, held: true };
      }
      deletedAt = now ?? new Date();
      offboarded = true;
    }
    desired.employeeStatus = mapped.employeeStatus;
    if (mapped.terminationDate) desired.terminationDate = mapped.terminationDate;
  }

  // Job level: no title clears it; a title with no level leaves it, because inventing or
  // dropping a rung changes who approves this person's spend.
  if (!mapped.title) {
    desired.jobLevelId = null;
  } else {
    const code = titleToJobLevelCode(mapped.title);
    // VeloExpense: `code` is unique per tenant (0050), so `findFirst` under the tenant's RLS.
    const level = code
      ? await db.jobLevel.findFirst({ where: { code }, select: { id: true } })
      : null;
    if (level) desired.jobLevelId = level.id;
    else if (code) missingLevelCode = code;
    else titleUnmapped = true;
  }

  // Email: Google's primary wins, unless another person here already holds it.
  if (mapped.email !== current.email) {
    const holder = await db.user.findFirst({
      where: { email: { equals: mapped.email, mode: 'insensitive' }, id: { not: userId } },
      select: { id: true },
    });
    if (holder) {
      emailConflict = true;
      notes.push(`Kept ${current.email}: ${mapped.email} belongs to another person here.`);
    } else {
      desired.email = mapped.email;
    }
  }

  if (resolveManager) {
    const manager = await resolveManagerId(db, userId, mapped.managerEmail);
    if (manager.unresolved) managerUnresolved = true;
    else desired.managerId = manager.managerId;
  }

  const changes: Partial<Record<GoogleOwnedField, FieldChange>> = {};
  const data: Record<string, unknown> = {};
  for (const [field, to] of Object.entries(desired) as [keyof OwnedRow, unknown][]) {
    const from = current[field];
    const same =
      from instanceof Date || to instanceof Date
        ? iso((from as Date | null) ?? null) === iso((to as Date | null) ?? null)
        : (from ?? null) === (to ?? null);
    if (same) continue;
    data[field] = to;
    changes[field as GoogleOwnedField] = {
      from: from instanceof Date ? iso(from) : ((from as string | null) ?? null),
      to: to instanceof Date ? iso(to) : ((to as string | null) ?? null),
    };
  }
  if (deletedAt) data.deletedAt = deletedAt;
  if (Object.keys(data).length > 0) {
    await db.user.update({ where: { id: userId }, data });
  }

  if (managerUnresolved) notes.push(`Manager ${mapped.managerEmail} is not a person here.`);
  if (titleUnmapped) notes.push(`Title "${mapped.title}" maps to no job level.`);
  if (missingLevelCode) {
    notes.push(`Title "${mapped.title}" maps to ${missingLevelCode}, which has no job level here.`);
  }
  return {
    changes,
    ...(notes.length ? { message: notes.join(' ') } : {}),
    ...(managerUnresolved ? { managerUnresolved } : {}),
    ...(titleUnmapped ? { titleUnmapped } : {}),
    ...(missingLevelCode ? { missingLevelCode } : {}),
    ...(emailConflict ? { emailConflict } : {}),
    ...(offboarded ? { offboarded } : {}),
  };
}

/**
 * Resolve a Directory manager email to a person here. No manager in Google clears ours; a
 * manager nobody here has is `unresolved` (left unchanged); somebody named as their own
 * manager is ignored as unresolved rather than written as a one-person cycle.
 * (VeloExpense: two people matching the address in different cases is unresolved too.)
 */
async function resolveManagerId(
  db: TenantDb,
  userId: string,
  managerEmail: string | null,
): Promise<{ managerId: string | null; unresolved: false } | { unresolved: true }> {
  if (!managerEmail) return { managerId: null, unresolved: false };
  const managers = await db.user.findMany({
    where: { email: { equals: managerEmail, mode: 'insensitive' } },
    select: { id: true },
    take: 2,
  });
  if (managers.length !== 1 || managers[0].id === userId) return { unresolved: true };
  return { managerId: managers[0].id, unresolved: false };
}

/**
 * The nightly sync's second pass: write one person's manager once everybody is matched.
 * Returns the change, if any, and whether the manager could not be resolved.
 */
export async function applyDirectoryManager(
  db: TenantDb,
  userId: string,
  managerEmail: string | null,
): Promise<{ change?: FieldChange; unresolved: boolean }> {
  const resolved = await resolveManagerId(db, userId, managerEmail);
  if (resolved.unresolved) return { unresolved: true };
  const current = await db.user.findUniqueOrThrow({
    where: { id: userId },
    select: { managerId: true },
  });
  if ((current.managerId ?? null) === resolved.managerId) return { unresolved: false };
  await db.user.update({ where: { id: userId }, data: { managerId: resolved.managerId } });
  return { change: { from: current.managerId, to: resolved.managerId }, unresolved: false };
}
