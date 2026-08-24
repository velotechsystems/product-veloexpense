/**
 * Bridge: auth session -> tenant context. Every server action / route handler /
 * tRPC procedure that touches tenant data calls withCurrentOrg(), which reads
 * organizationId off the authenticated session and runs the work inside
 * withOrg() so Postgres RLS is scoped correctly.
 */
import { auth } from '@/auth';
import { withOrg } from '@/lib/tenant/context';
import type { QueryRunner } from '@/lib/db/client';

export async function currentOrgId(): Promise<string> {
  const session = await auth();
  const orgId = (session?.user as { organizationId?: string } | undefined)?.organizationId;
  if (!orgId) throw new Error('unauthenticated: no organization in session');
  return orgId;
}

export async function withCurrentOrg<T>(fn: (tx: QueryRunner) => Promise<T>): Promise<T> {
  return withOrg(await currentOrgId(), fn);
}
