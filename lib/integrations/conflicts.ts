/**
 * VX3-9b / AC-22 — is another ACTIVE installation already doing this adapter's job?
 *
 * ── Why this is a module of its own ─────────────────────────────────────────
 *
 * `service.ts` and `oauth.ts` both need the answer, and `service.ts` already
 * imports `oauth.ts` (for `freshAuthConfig`). Putting the helper in `service.ts`
 * would make `oauth.ts` import it back, which is the exact cycle `errors.ts` was
 * extracted to break. A leaf both can import costs nothing.
 *
 * ── What it is for ─────────────────────────────────────────────────────────
 *
 * `0016` guarantees one ACTIVE installation per integration:
 *
 *     CREATE UNIQUE INDEX integration_installation_one_active_idx
 *         ON integration_installation (organization_id, integration_slug) WHERE active;
 *
 * That stops two VeloLedger connections. It does NOT stop a VeloLedger and a
 * QuickBooks, both declaring `POST_EXPENSE_REPORT` — and `resolveCapability` read
 * the active rows with no ORDER BY and returned the first one whose adapter had
 * the capability. So which ledger a tenant's approved reports were drafted into
 * was physical heap order, which moves whenever a row is updated.
 *
 * Which is AC-3, the finding this audit opened against ExpenseOS, in its words:
 * "theirs resolves with `take: 1` and no ordering, so two active installations of
 * one type resolve arbitrarily and nothing detects that state." VeloExpense fixed
 * it per vendor and reproduced it per capability. `0016`'s comment — "only one of
 * them may be ACTIVE" — is true of two connections to one product and false of two
 * products.
 *
 * Nothing could reach the state in a deployed build yet: VeloLedger is the only
 * adapter declaring a capability, because QuickBooks is dormant until its platform
 * credentials are set. It would have become reachable on the day a QBO client was
 * onboarded — the same shape as AC-21, a control that reads as done and is not.
 *
 * The refusal lives in three places for three different audiences:
 *   · `resolveCapability` — the safety net. It cannot guess, so it refuses.
 *   · `installIntegration` — the admin, before the state exists.
 *   · `beginAuthorisation` — the same admin, before their browser is sent to a far
 *     end to consent to something this end will not accept.
 */
import type { QueryRunner } from '@/lib/db/client';
import type { AccountingAdapter, Capability } from '@/lib/integrations/contract';
import { adapterFor } from '@/lib/integrations/registry';

export interface CapabilityRival {
  /** The installation already doing the job. */
  id: string;
  /** What the admin named it, which is what they will recognise. */
  label: string;
  slug: string;
  /** The capabilities the two adapters both claim. */
  overlap: Capability[];
}

/** Human wording for one capability: POST_EXPENSE_REPORT -> "post expense report". */
export function capabilityWords(capability: Capability): string {
  return capability.toLowerCase().replace(/_/g, ' ');
}

/**
 * The first ACTIVE installation in this tenant whose adapter claims a capability
 * `adapter` also claims, or null.
 *
 * `excludeId` is the row being connected or authorised: reactivating the same
 * installation is not a conflict with itself (AC-20 made reconnect reuse the row,
 * so this matters).
 *
 * An adapter with no capabilities can never conflict — which is what keeps
 * QuickBooks installable while dormant, and is the property VX3-8 relies on.
 *
 * A RIVAL IS A DIFFERENT PRODUCT. An active installation of the SAME adapter is
 * not a capability conflict, it is the one-active case `0016`'s partial index
 * already owns, and it has its own message: "X is already connected. Disconnect it
 * first, or edit the existing connection." The first version of this guard did not
 * make that distinction, and every "already connected" turned into "two ledgers
 * would compete with each other", which is both wrong and less useful — two tests
 * caught it.
 */
export async function findCapabilityRival(
  tx: QueryRunner,
  adapter: AccountingAdapter,
  excludeId?: string,
): Promise<CapabilityRival | null> {
  if (adapter.capabilities.length === 0) return null;

  const r = await tx.query(
    `SELECT id, integration_slug, label FROM integration_installation
      WHERE active
        AND integration_slug <> $2
        AND ($1::uuid IS NULL OR id <> $1::uuid)
      ORDER BY connected_at`,
    [excludeId ?? null, adapter.slug],
  );
  for (const row of r.rows) {
    const rival = adapterFor(row.integration_slug as string);
    if (!rival) continue;
    const overlap = rival.capabilities.filter((c) => adapter.capabilities.includes(c));
    if (overlap.length === 0) continue;
    return {
      id: row.id as string,
      label: row.label as string,
      slug: row.integration_slug as string,
      overlap,
    };
  }
  return null;
}

/** The sentence an admin reads. Names the connection they already have, because
 *  "a conflict exists" is not something anybody can act on. */
export function rivalMessage(adapter: AccountingAdapter, rival: CapabilityRival): string {
  const jobs = rival.overlap.map(capabilityWords).join(' and ');
  return (
    `"${rival.label}" is already connected and can ${jobs}, so connecting ` +
    `${adapter.name} as well would leave no single answer to which one an approved ` +
    `report goes to. Disconnect "${rival.label}" first if you are switching.`
  );
}
