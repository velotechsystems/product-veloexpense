/**
 * Absolute links to a report, for a caller that is not in the browser.
 *
 * The chat panel navigates with the router and needs none of this. An MCP client does: it may
 * be Claude Desktop with no filesystem access, which can create a report through
 * `start_expense_report_from_receipts` but cannot PUT the bytes anywhere. Handing back a link
 * turns a dead end into one click.
 *
 * **No token, and no new credential.** The link carries a report id and authorization is the
 * session — the workbench already gates on being the submitter, so a leaked link is a 404 for
 * anybody else. A bearer upload token would be a new secret to mint, expire, revoke and audit,
 * for a page the person can already reach by signing in.
 *
 * VeloExpense: ExpenseOS's module (Wave 2, w2-09), on VeloExpense's origin and routes —
 *   · the origin is VeloExpense's `originForTenant` (the tenant's own subdomain where the
 *     deployment serves them, else `appOrigin()`, read per call rather than at module load:
 *     lib/notifications/email.ts says why);
 *   · VeloExpense's routes carry no locale prefix — a person's language is their preference,
 *     not the URL — so there is no locale to choose here.
 */
import { appOrigin, originForTenant } from '@/lib/notifications/email';

/**
 * A link to one report, optionally asking the page to prompt for receipts.
 *
 * Returns null when no app URL is configured. Null rather than a relative path: a relative
 * link in an MCP client's answer is unusable, and a half-built absolute one ("/expenses/…"
 * with no host) looks like a bug in the product rather than a missing environment variable.
 */
export function reportUrl(
  reportId: string,
  opts: { tenantSlug?: string | null; promptUpload?: boolean } = {},
): string | null {
  const origin = opts.tenantSlug ? originForTenant(opts.tenantSlug) : appOrigin();
  if (!origin) return null;
  const query = opts.promptUpload ? '?upload=1' : '';
  return `${origin}/expenses/${reportId}${query}`;
}
