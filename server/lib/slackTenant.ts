/**
 * w5-02b — which tenant a Slack request is for, from the address it was sent to.
 *
 * VeloExpense-built (ExpenseOS has one Slack app and one tenant). Each tenant connects its
 * own Slack app (decided 17 Oct 2026), and that app's Event Subscriptions Request URL is the
 * tenant's own address, `https://<tenant>.<apex>/api/slack/events` — so the Host names the
 * tenant, as the inbound-mail address does (d47). Its signing secret is then THAT tenant's,
 * so a request signed by one tenant's app cannot be replayed at another's address.
 *
 * Null for a host that is not a tenant address, or names no active tenant. `organization`
 * has no tenant column, so it is read without a tenant scope, as the inbound-mail route reads
 * it; nothing else is.
 */
import { withoutOrg } from '@/lib/tenant/context';
import { candidateSlugFromHost } from '@/lib/tenant/host';

export async function slackTenantFor(host: string | null): Promise<string | null> {
  const slug = candidateSlugFromHost(host);
  if (!slug) return null;
  const res = await withoutOrg((tx) =>
    tx.query(`SELECT id FROM organization WHERE slug = $1 AND status <> 'suspended'`, [slug]),
  );
  const id = res.rows[0]?.id;
  return id ? String(id) : null;
}
