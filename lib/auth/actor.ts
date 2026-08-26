/**
 * VX1-10 — who is asking.
 *
 * One place to resolve the acting employee inside a tenant transaction. The
 * house rule is that authorization reads `app_user.role` from the DATABASE, not
 * from the session token: a token is minted at sign-in and outlives any change
 * to the user's role or status, so trusting it means a demoted or deactivated
 * account keeps its old powers until it signs out.
 */
import type { QueryRunner } from '@/lib/db/client';
import { getEmployeeByEmail, type EmployeeRole, type EmployeeRow } from '@/lib/employees/service';

/** The minimum an access predicate needs. EmployeeRow satisfies it. */
export interface Actor {
  id: string;
  role: EmployeeRole;
}

export class ForbiddenError extends Error {
  constructor(message = 'forbidden') {
    super(message);
    this.name = 'ForbiddenError';
  }
}

export async function requireActor(tx: QueryRunner, email: string): Promise<EmployeeRow> {
  const actor = await getEmployeeByEmail(tx, email);
  if (!actor) throw new ForbiddenError('forbidden: no employee record in this organization');
  if (actor.deleted_at !== null) throw new ForbiddenError('forbidden: this account is deactivated');
  return actor;
}
