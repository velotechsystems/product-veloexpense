/**
 * f50 — audit rows for a tenant's connections: the accounting ledger, Slack, and Google
 * Workspace.
 *
 * ExpenseOS writes one audit row when an administrator installs an integration, updates its
 * configuration, or removes it (`server/routers/platform.ts`, 1e682dd6), with
 * `details: { slug, code }` and the note "never log the config blob". VeloExpense's three
 * connection screens wrote none. This is ExpenseOS's rule, in one place, so the three cannot
 * drift: the row names the integration and WHICH fields changed — never a value. A secret
 * that changed is recorded as a field name; so is an address.
 */
import type { QueryRunner } from '@/lib/db/client';
import { type AuditActor, append } from '@/lib/audit/service';

export type ConnectionSlug = string;

export async function auditConnection(
  tx: QueryRunner,
  actor: AuditActor,
  event: 'installed' | 'updated' | 'removed' | 'authorised',
  connection: {
    /** The integration: an adapter's slug, or 'slack' / 'google-workspace' (ExpenseOS's slugs). */
    slug: ConnectionSlug;
    /** The ledger installation's code and id, where there is a row of that kind. */
    code?: string;
    installationId?: string;
    /** Field NAMES that changed, for an update. Never values. */
    changed?: string[];
  },
): Promise<void> {
  const action = (
    {
      installed: 'INTEGRATION_INSTALLED',
      updated: 'INTEGRATION_CONFIG_UPDATED',
      removed: 'INTEGRATION_REMOVED',
      authorised: 'INTEGRATION_AUTHORISED',
    } as const
  )[event];
  await append(tx, actor, {
    action,
    ...(connection.installationId
      ? { entityType: 'integration_installation', entityId: connection.installationId }
      : {}),
    details: {
      slug: connection.slug,
      ...(connection.code ? { code: connection.code } : {}),
      ...(connection.changed ? { changed: [...connection.changed].sort() } : {}),
    },
  });
}
