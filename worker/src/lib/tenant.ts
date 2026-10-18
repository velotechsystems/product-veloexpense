import { enqueue, type JobMap } from '@expenseos/jobs';
import { withTenantStatements } from '@/lib/db/prisma';
import { withoutOrg } from '@/lib/tenant/context';

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

/**
 * VeloExpense (w3-05): run a scheduled job once per tenant.
 *
 * ExpenseOS's recurring jobs sweep every tenant in one run, through its one client. Here a
 * run is one tenant's (`inTenant`), so the schedule's own run — the one with no
 * `organizationId` — does nothing but queue one job per tenant that can use the product,
 * each naming its tenant. A suspended organization is skipped: nobody can act on a reminder
 * about it. `organization` has no tenant column, so it is read without one (`withoutOrg`).
 *
 * Returns how many jobs it queued.
 */
export async function fanOutToTenants<
  N extends
    | 'expense.receiptChase'
    | 'approval.sweepExpired'
    | 'notification.prune'
    | 'audit.purge'
    | 'integration.google.directorySync',
>(
  job: N,
  data: Omit<JobMap[N], 'organizationId'>,
): Promise<number> {
  const orgs = await withoutOrg((tx) =>
    tx.query(`SELECT id FROM organization WHERE status <> 'suspended' ORDER BY id`),
  );
  for (const row of orgs.rows) {
    await enqueue(job, { ...data, organizationId: String(row.id) } as JobMap[N]);
  }
  console.log(`[${job}] queued for ${orgs.rows.length} tenant(s)`);
  return orgs.rows.length;
}
