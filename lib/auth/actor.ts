/**
 * VX1-10 — who is asking.
 *
 * One place to resolve the acting employee inside a tenant transaction. The
 * house rule is that authorization reads the person's role from the DATABASE, not
 * from the session token: a token is minted at sign-in and outlives any change
 * to the user's role or status, so trusting it means a demoted or deactivated
 * account keeps its old powers until it signs out.
 */
import type { QueryRunner } from '@/lib/db/client';
import { DomainError } from '@/lib/errors/domain';
import type { UserMessageCode } from '@/lib/i18n/catalog/errors';
import { permissions as P } from '@expenseos/rbac';
import { getEmployeeByEmail, type EmployeeRow } from '@/lib/employees/service';

/** The minimum an access predicate needs. EmployeeRow satisfies it. */
export interface Actor {
  id: string;
  /** w4-10b: the person's role's permissions (none while it is deactivated). */
  role_permissions: readonly string[];
}

/**
 * w4-10b (d74): what VeloExpense's own admin screens — and the "an admin sees everything"
 * clauses beside them — require, now that the text role ADMIN is gone (0069). The one
 * permission the menu already shows those screens for (`app/(app)/veloexpenseNav.ts`), so
 * the menu and the screens cannot disagree. System Administrator is the role that holds it,
 * as ADMIN was; a custom role that is given it gets them too.
 */
export const VELOEXPENSE_ADMIN_PERMISSION: string = P.admin.appSettings.update;

/** Whether the actor's role carries VeloExpense's admin permission. */
export function holdsAdminPermission(actor: Actor): boolean {
  return actor.role_permissions.includes(VELOEXPENSE_ADMIN_PERMISSION);
}

/**
 * WHY a refusal is one class and not one per surface (VX4-9).
 *
 * VX4-9 started to add a second `ForbiddenError` in `lib/auth/admin-guard.ts`,
 * for the admin gate, and stopped: two classes of the same name, both
 * `DomainError`, differing only in which file imported them, is a bug waiting
 * for its first `instanceof`. There is one refusal class for the whole auth
 * layer, and the `code` says which refusal it was.
 */
export type AuthRefusal =
  /** No session, or a session with no email. */
  | 'UNAUTHENTICATED'
  /** Signed in, but no `app_user` row in THIS tenant. */
  | 'NOT_A_MEMBER'
  /** A row that exists and is soft-deleted. */
  | 'DEACTIVATED'
  /** A member, but not an active administrator. */
  | 'NOT_AN_ADMIN'
  /** A member, but this record is somebody else's. */
  | 'NOT_YOURS';

export class ForbiddenError extends DomainError {
  constructor(
    message = 'forbidden',
    readonly code: AuthRefusal = 'NOT_YOURS',
    userMessage: UserMessageCode | null = null,
  ) {
    super(message, userMessage);
    this.name = 'ForbiddenError';
  }
}

/**
 * The acting employee, or a refusal a person can read.
 *
 * VX4-9 gave both throws a `userMessage`. They had none, so `errorParam` showed
 * the generic "something went wrong on our side" (correctly — a bare diagnostic
 * must never reach a screen, IL-11) to somebody whose invite had been withdrawn
 * or whose account had been deactivated. Nothing about the ACCESS DECISION
 * changed here; the predicate is the same two clauses it has been since VX1-10.
 * What changed is that the refusal now reads as a refusal.
 */
/**
 * THE ADMIN PREDICATE, written once (VX4-9).
 *
 * `deleted_at !== null` is as load-bearing as the role: `app_user` rows are
 * soft-deleted (VX1-2), so a deactivated administrator keeps their row and their
 * role. `requireActor` already refuses a soft-deleted row before the admin gate
 * calls this, so the clause is doubled on purpose — this is a pure predicate on
 * a row, and a caller that gets its row from somewhere other than `requireActor`
 * (a test, a cron, Phase 5's provisioning) must not be the one place the check is
 * missing. Two cheap boolean tests are not the cost worth saving.
 *
 * It is HERE rather than in `lib/auth/admin-guard.ts` because that module
 * imports `@/auth`, and next-auth's runtime cannot be loaded under vitest. The
 * gate's wrappers are covered by `e2e/crawl.spec.ts`; this line is covered by
 * `test/admin-gate.db.test.ts`, against a real soft-deleted row.
 */
export function isActiveAdmin(actor: EmployeeRow): boolean {
  return holdsAdminPermission(actor) && actor.deleted_at === null;
}

export async function requireActor(tx: QueryRunner, email: string): Promise<EmployeeRow> {
  const actor = await getEmployeeByEmail(tx, email);
  if (!actor) {
    throw new ForbiddenError(
      'forbidden: no employee record in this organization',
      'NOT_A_MEMBER',
      'NOT_A_MEMBER_HERE',
    );
  }
  if (actor.deleted_at !== null) {
    throw new ForbiddenError(
      'forbidden: this account is deactivated',
      'DEACTIVATED',
      'ACCOUNT_DEACTIVATED',
    );
  }
  return actor;
}
