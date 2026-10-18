import { SYSTEM_ROLE_IDS } from '@expenseos/rbac';
import { titleToJobLevelCode } from '@expenseos/db';
import type { TenantDb } from '@/lib/db/prisma';
import type { DirectoryUser } from './types';

/**
 * Apply a mapped Directory user to the database. Shared by the
 * on-login `refreshUserFromDirectory` and the background
 * `syncAllFromDirectory` so both paths produce identical writes.
 * (VeloExpense: only the background sync is ported.)
 *
 * Behavior:
 *   - Looks up the User by email.
 *   - Resolves the manager email to managerId — resolved, never created.
 *   - Writes Directory-canonical fields onto the User row. Null/empty
 *     values for the "skippable" fields (firstName, lastName, avatar,
 *     department, BU, entity, country) are NOT written
 *     so we don't blank out existing data Directory hasn't populated
 *     this run.
 *   - homeCurrency is never written — Directory doesn't supply it.
 *
 * Idempotent. Safe to call repeatedly with the same DirectoryUser.
 *
 * w5-04 — ported from ExpenseOS `packages/integrations-google/src/apply.ts` (1e682dd6).
 * VeloExpense, each marked below:
 *   · UPDATE ONLY (d84). ExpenseOS creates a placeholder user (Employee role, ACTIVE) for
 *     every Directory address it does not have. VeloExpense never does: a person joins a
 *     tenant by invitation and takes a paid seat, and a nightly job minting seats from a
 *     Workspace is the wrong place for that decision. A Directory user VeloExpense does not
 *     have is `not-found`, and nothing is written.
 *   · STATUS MOVES ONE WAY. ExpenseOS writes `employeeStatus` and `terminationDate` on every
 *     sync, nulls included. VeloExpense lets Directory OFFBOARD somebody — suspended →
 *     DEACTIVATED, archived → TERMINATED, with `deleted_at` stamped as `users.deactivate`
 *     does, because `deleted_at` is what sign-in, every request and the seat meter read
 *     (0071) — and never the reverse: an ACTIVE account in Directory does not reactivate
 *     anybody (that takes a seat back, which `users.reactivate` caps) and does not clear
 *     ON_LEAVE, which Directory cannot express at all (ExpenseOS's mapper never returns it,
 *     so its sync resets an on-leave person to ACTIVE every night).
 *   · NOT THE LAST ADMIN. A Directory offboarding of the tenant's last active System
 *     Administrator is HELD — reported, not written — as `users.deactivate` refuses it: a
 *     tenant nobody can administer cannot fix the sync that locked it out.
 *   · No pins. ExpenseOS's `applyPins` holds fields a reviewer adopted from NetSuite;
 *     VeloExpense has no NetSuite and no `UserSyncDiscrepancy`.
 *   · Email matches case-insensitively. ExpenseOS's email column is unique; VeloExpense's
 *     is unique per tenant as written (0001), so `Ada@x` and `ada@x` could both exist, and
 *     a match on both is refused rather than guessed.
 *   · Runs on the caller's transaction (`TenantDb`), one person per transaction, so an
 *     offboarding's status and `deleted_at` land together.
 */
export type ApplyResult =
  | {
      outcome: 'updated';
      userId: string;
      offboarded: boolean;
      /** VeloExpense: the title mapped to a level code this tenant has no level for. */
      missingLevelCode?: string;
    }
  /** VeloExpense: Directory has this person and VeloExpense does not. Nothing written. */
  | { outcome: 'not-found' }
  /** VeloExpense: Directory offboarded the tenant's last active admin. Nothing written. */
  | { outcome: 'held'; userId: string; reason: 'last-admin' };

const LEAVER = new Set<DirectoryUser['employeeStatus']>(['DEACTIVATED', 'TERMINATED']);

export async function applyDirectoryUserToDb(
  db: TenantDb,
  mapped: DirectoryUser,
  // VeloExpense: injectable, so a test can fix the offboarding time.
  opts: { now?: Date } = {},
): Promise<ApplyResult> {
  if (!mapped.email) {
    throw new Error('applyDirectoryUserToDb: DirectoryUser.email is required');
  }

  // ── Find the User row by email (VeloExpense: never create) ────────
  const matches = await db.user.findMany({
    where: { email: { equals: mapped.email, mode: 'insensitive' } },
    select: { id: true, roleId: true, employeeStatus: true, deletedAt: true },
    take: 2,
  });
  if (matches.length === 0) return { outcome: 'not-found' };
  if (matches.length > 1) {
    throw new Error('more than one person here has this email in different letter cases');
  }
  const existing = matches[0];
  const userId = existing.id;

  /**
   * Resolve a Directory string to its lookup row by English label — and NEVER create one.
   *
   * It used to create on a miss. That is the same mistake the seed's department resolver
   * made, and it cost 27 duplicate departments holding 358 users. Google is the worst place
   * to make it from: its department names are bare leaves, 15 of them exist nowhere else
   * (`IT`, `IT Testing`, `Technology Department IT`, `Web Development`, `Logistics
   * Center`…), and every sign-in would mint one — quietly undoing the merge that removed
   * them.
   *
   * A miss now returns `undefined`, which Prisma reads as "don't change", so the person
   * keeps whatever ExpenseOS already had. Google's spelling is reported for correction at
   * source instead of being taken as fact.
   */
  async function orgId(
    kind: 'department' | 'businessUnit' | 'legalEntity',
    value: string | null | undefined,
  ): Promise<string | undefined> {
    if (!value) return undefined;
    const where = { label: { path: ['en'], equals: value } } as const;
    if (kind === 'department') {
      return (await db.department.findFirst({ where, select: { id: true } }))?.id;
    }
    if (kind === 'businessUnit') {
      const byLabel = await db.businessUnit.findFirst({ where, select: { id: true } });
      if (byLabel) return byLabel.id;
      /**
       * Then by external id, because Directory does not speak our labels.
       *
       * A business unit arrives as a BUILDING ("Logistic Centre - Edmonton") and a legal
       * entity as ADP's payroll company name ("EDEALER INC.", or the Quebec entity truncated
       * to "LES ENCHERES D'AUTOM" at twenty characters). Neither is what the row is called
       * here, and neither is going to be: Google follows ADP, and ADP is the source of truth
       * — so the translation belongs on this side, as data on the row it identifies, not as a
       * correction pushed back at the system that is right.
       */
      const alias = await db.businessUnitExternalId.findFirst({
        where: { sourceValue: value },
        select: { businessUnitId: true },
      });
      return alias?.businessUnitId;
    }
    const byLabel = await db.legalEntity.findFirst({ where, select: { id: true } });
    if (byLabel) return byLabel.id;
    const alias = await db.legalEntityExternalId.findFirst({
      where: { sourceValue: value },
      select: { legalEntityId: true },
    });
    return alias?.legalEntityId;
  }
  // VeloExpense: in order, not `Promise.all` — they share one transaction's connection.
  const departmentId = await orgId('department', mapped.department);
  const businessUnitId = await orgId('businessUnit', mapped.businessUnit);
  const legalEntityId = await orgId('legalEntity', mapped.entity);

  // Employee title → job level. Unlike the org lookups above, an unrecognized
  // title creates NOTHING: job level drives `managerChain` approver selection,
  // so inventing a rung would hand someone approval authority. An unmapped
  // title leaves the existing level untouched and is surfaced by the sync
  // summary instead (see syncAllFromDirectory).
  let jobLevelId: string | undefined;
  const levelCode = titleToJobLevelCode(mapped.title);
  if (levelCode) {
    // VeloExpense: `code` is unique per tenant (0050), so `findFirst` under the tenant's RLS.
    const level = await db.jobLevel.findFirst({
      where: { code: levelCode },
      select: { id: true },
    });
    jobLevelId = level?.id;
  }
  // VeloExpense: a tenant's ladder is its own, so a code it lacks is reported, not invented.
  const missingLevelCode = levelCode && !jobLevelId ? levelCode : undefined;

  // ── Resolve manager email → managerId ─────────────────────────────
  let managerId: string | null | undefined;
  if (mapped.managerEmail) {
    /**
     * Resolved, never created. This used to upsert a PLACEHOLDER user for whatever address
     * Directory named — so an address that had just been merged away, or an alias left
     * behind by somebody who has gone, came straight back as a new person. That is the
     * double-import this has to stop.
     */
    const managers = await db.user.findMany({
      where: { email: { equals: mapped.managerEmail, mode: 'insensitive' } },
      select: { id: true },
      take: 2,
    });
    // VeloExpense: one match only (see the header), and never the person themselves.
    managerId = managers.length === 1 && managers[0].id !== userId ? managers[0].id : undefined;
  } else {
    // Directory returned NO manager relation. Google Workspace frequently
    // leaves `relations[type=manager]` unpopulated, so absence is ambiguous —
    // it does NOT reliably mean "this person has no manager". Treat it as
    // "don't change" (undefined) rather than clearing the link, otherwise every
    // sync (on-login + daily) would wipe manager assignments established by the
    // seed / admin and break direct-reports + team queries. (Same philosophy as
    // roles: sync never destroys locally-managed org data on absent signal.)
    managerId = undefined;
  }

  // ── Status (VeloExpense: one way — see the header) ────────────────
  let employeeStatus: string | undefined;
  let terminationDate: Date | null | undefined;
  let deletedAt: Date | undefined;
  let offboarded = false;
  if (LEAVER.has(mapped.employeeStatus)) {
    if (existing.deletedAt === null) {
      if (existing.roleId === SYSTEM_ROLE_IDS.admin) {
        const others = await db.user.count({
          where: {
            roleId: SYSTEM_ROLE_IDS.admin,
            employeeStatus: 'ACTIVE',
            deletedAt: null,
            id: { not: userId },
          },
        });
        if (others < 1) return { outcome: 'held', userId, reason: 'last-admin' };
      }
      deletedAt = opts.now ?? new Date();
      offboarded = true;
    }
    employeeStatus = mapped.employeeStatus;
    terminationDate = mapped.terminationDate ?? undefined;
  }

  // ── Compose the write ────────────────────────────────────────────
  // Prisma treats `undefined` as "don't change" and `null` as
  // "set to null". Skippable fields use `?? undefined` so absent
  // Directory data doesn't overwrite existing rows.
  //
  // Directory REMAINS authoritative for these. It is currently wrong for a lot of people —
  // 101 carry a department that disagrees with the ledger and 98 carry a stale name — but
  // the answer to that is to correct Directory, not to teach ExpenseOS to ignore it. Making
  // the sync gap-fill only would hide the divergence instead of closing it, and the two
  // systems would drift apart quietly from then on.
  await db.user.update({
    where: { id: userId },
    data: {
      firstName: mapped.firstName ?? undefined,
      lastName: mapped.lastName ?? undefined,
      avatarUrl: mapped.avatarUrl ?? undefined,
      departmentId,
      businessUnitId,
      legalEntityId,
      jobLevelId,
      country: mapped.country ?? undefined,
      employeeStatus,
      terminationDate,
      deletedAt,
      managerId,
    },
  });

  return { outcome: 'updated', userId, offboarded, ...(missingLevelCode ? { missingLevelCode } : {}) };
}
