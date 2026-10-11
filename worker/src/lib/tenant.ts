import { withTenantStatements } from '@/lib/db/prisma';

/**
 * VeloExpense: run a job as the tenant its payload names.
 *
 * ExpenseOS's worker reads and writes every tenant through one database client. VeloExpense's
 * never does: the worker connects as `veloapp`, every tenant table is FORCE ROW LEVEL SECURITY,
 * and a job's statements run in its tenant's scope, one at a time (`withTenantStatements`,
 * lib/db/prisma.ts — why one at a time is said there). The tenant comes from the payload,
 * where the web app put it when it enqueued the job (`organizationId`, packages/jobs).
 *
 * A payload without one is refused, loudly: running it unscoped is impossible (`db` throws
 * outside a scope), and guessing a tenant is the one thing this must never do.
 */
export async function inTenant<T>(data: unknown, run: () => Promise<T>): Promise<T> {
  const organizationId = (data as { organizationId?: unknown } | null)?.organizationId;
  if (typeof organizationId !== 'string' || organizationId.length === 0) {
    throw new Error('job payload names no organizationId; refusing to run it outside a tenant');
  }
  return withTenantStatements(organizationId, run);
}
