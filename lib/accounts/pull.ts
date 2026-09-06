/**
 * VX3-5 — pull a chart of accounts from the connected ledger and reconcile it.
 *
 * Findings: GAP-AUDIT AC-12, AC-14. The strategy was settled when VX3-1 chose the
 * schema: ONE table with a `source` column, matched by ACCOUNT NUMBER, and a
 * template row is ADOPTED rather than duplicated.
 *
 * ── Why matching on number, and why adoption ────────────────────────────────
 *
 * A tenant instantiates a starter template on day one, files expenses against it
 * for a month, then connects a real ledger. If the pull landed in a separate cache
 * — which is how ExpenseOS does it, seven `NetSuite*` cache tables keyed
 * `netsuiteId @unique` — every category mapping made in that month would need
 * re-pointing at the moment of connection. So a pulled account whose NUMBER
 * matches an existing row stamps that row's `external_id` and turns it PULLED.
 * Categories keep pointing at the same row throughout, and nothing an employee
 * did stops meaning what it meant.
 *
 * The template's numbers came verbatim from VeloLedger's own starter chart
 * (`0014`), so for a VeloLedger tenant this match is nearly total by construction.
 * That was the point of taking them verbatim.
 *
 * ── Nothing is deactivated, created-and-hidden, or resolved silently ────────
 *
 * Three outcomes, and all three are REPORTED:
 *
 *   ADOPTED  — matched by number; the local row gains an external id.
 *   ADDED    — the ledger has an account we did not; created as PULLED.
 *   ORPHANED — we have a PULLED account the ledger no longer reports. NOT
 *              deactivated. ExpenseOS deactivates exactly these ("rows no longer
 *              present upstream are marked isActive = false") and the
 *              never-hard-deleted half of that is right — but a tenant whose
 *              ledger stops reporting an account it has been coding to for a year
 *              should be told, not have its categories quietly unmapped by a job.
 *
 * A LOCAL-ONLY account (a template row the ledger does not have) is also reported
 * and left alone. It is usable: `is_postable` and the category mapping do not
 * depend on the ledger knowing about it, and a tenant may well have a category the
 * ledger's chart does not cover yet.
 */
import type { QueryRunner } from '@/lib/db/client';
import type { UserMessage } from '@/lib/errors/domain';
import type { UserMessageCode } from '@/lib/i18n/catalog/errors';
import { DomainError } from '@/lib/errors/domain';
import type { RemoteAccount } from '@/lib/integrations/contract';
import { requireCapability } from '@/lib/integrations/service';
import { requireModule } from '@/lib/modules/service';
import { ORG } from '@/lib/tenant/sql';


export interface PullOutcome {
  adopted: string[];
  added: string[];
  /** PULLED locally, absent from this pull. Reported, never acted on. */
  orphaned: string[];
  /** Local rows the ledger does not report. Also fine, also reported. */
  localOnly: string[];
  /** Rows the ledger reports twice under one number — refused before any write. */
  duplicates: string[];
  pulledAt: Date;
}

export class PullError extends DomainError {
  constructor(
    message: string,
    readonly code: 'DUPLICATE_NUMBERS' | 'EMPTY' | 'NOT_CONNECTED',
    readonly detail: string[] = [],
    userMessage: UserMessageCode | UserMessage | null = null,
  ) {
    super(message, userMessage);
    this.name = 'PullError';
  }
}

/**
 * Fetch and reconcile.
 *
 * The FETCH happens outside any transaction — an HTTP call to somebody else's
 * service must not hold one open — and the reconcile happens inside one, so a
 * half-applied chart is not a state anybody can observe.
 */
export async function pullChartOfAccounts(
  tx: QueryRunner,
  remote: RemoteAccount[],
  installationId: string,
): Promise<PullOutcome> {
  // VX4-1: the gate, before any read or write. GAP-AUDIT MT-3 is why it lives
  // here and not at the edge.
  await requireModule(tx, 'accounting');

  if (remote.length === 0) {
    // Refused rather than treated as "the ledger has no accounts". An empty
    // response is far more often a wrong entity id or a permission problem than a
    // genuinely empty chart, and acting on it would report every local account as
    // orphaned in one go.
    throw new PullError(
      'the ledger reported no accounts at all — check the configured entity before ' +
        'treating that as correct',
      'EMPTY',
      [],
      'LEDGER_REPORTED_NOTHING',
    );
  }

  // A ledger reporting one number twice is refused BEFORE any write. Picking a
  // winner silently is how a tenant ends up coding to the account it did not mean.
  const seen = new Set<string>();
  const duplicates: string[] = [];
  for (const account of remote) {
    if (seen.has(account.number)) duplicates.push(account.number);
    seen.add(account.number);
  }
  if (duplicates.length > 0) {
    throw new PullError(
      `the ledger reports these account numbers more than once, so the chart cannot ` +
        `be reconciled: ${[...new Set(duplicates)].join(', ')}`,
      'DUPLICATE_NUMBERS',
      [...new Set(duplicates)],
      {
        code: 'LEDGER_DUPLICATE_NUMBERS',
        params: { numbers: [...new Set(duplicates)].join(', ') },
      },
    );
  }

  const existing = await tx.query(
    'SELECT id, number, source, external_id, installation_id FROM gl_account',
  );
  const byNumber = new Map(
    existing.rows.map((row) => [
      row.number as string,
      {
        id: row.id as string,
        source: row.source as string,
        externalId: row.external_id as string | null,
        installationId: row.installation_id as string | null,
      },
    ]),
  );

  const pulledAt = new Date();
  const adopted: string[] = [];
  const added: string[] = [];

  for (const account of remote) {
    const local = byNumber.get(account.number);
    if (local) {
      // ADOPT. `name` is refreshed from the ledger because the ledger is
      // authoritative about what an account is CALLED; `is_postable` is NOT
      // touched here — it is derived from our own tree in `service.ts`, and the
      // ledger's idea of a rollup is not necessarily ours.
      await tx.query(
        `UPDATE gl_account
            SET name = $2, type = $3, sub_type = $4,
                source = 'PULLED', external_id = $5, installation_id = $6,
                last_seen_at = $7, updated_at = clock_timestamp()
          WHERE id = $1`,
        [
          local.id,
          account.name,
          account.type,
          account.subType ?? null,
          account.externalId,
          installationId,
          pulledAt,
        ],
      );
      adopted.push(account.number);
      continue;
    }
    // ADD. Parentless for now; parents are resolved in a second pass below, for
    // the same reason `instantiateTemplate` needs two — a tree cannot be inserted
    // in one pass without making the input's order load-bearing.
    await tx.query(
      `INSERT INTO gl_account
           (organization_id, number, name, type, sub_type, is_postable, active,
            source, external_id, installation_id, last_seen_at)
       VALUES (${ORG}, $1, $2, $3, $4, true, $5, 'PULLED', $6, $7, $8)`,
      [
        account.number,
        account.name,
        account.type,
        account.subType ?? null,
        account.active,
        account.externalId,
        installationId,
        pulledAt,
      ],
    );
    added.push(account.number);
  }

  // Parents, by number, within this tenant. Comma-join with every predicate in
  // WHERE: an UPDATE's target cannot be referenced from a JOIN condition inside
  // FROM. `0014` and the seed learned that the hard way.
  for (const account of remote) {
    if (!account.parentNumber) continue;
    await tx.query(
      `UPDATE gl_account g
          SET parent_id = p.id, updated_at = clock_timestamp()
        FROM gl_account p
       WHERE g.number = $1
         AND p.number = $2
         AND p.organization_id = g.organization_id
         AND g.id <> p.id`,
      [account.number, account.parentNumber],
    );
  }

  // An account with children is a rollup, and nothing may post to a rollup. The
  // derivation is ours, not the ledger's — same rule as the importer, and the
  // reason VeloLedger had to backfill the flag in its own `0028`.
  await tx.query(
    `UPDATE gl_account g
        SET is_postable = NOT EXISTS (
              SELECT 1 FROM gl_account c WHERE c.parent_id = g.id
            ),
            updated_at = clock_timestamp()
      WHERE g.is_postable <> NOT EXISTS (
              SELECT 1 FROM gl_account c WHERE c.parent_id = g.id
            )`,
  );

  const remoteNumbers = new Set(remote.map((a) => a.number));
  const orphaned: string[] = [];
  const localOnly: string[] = [];
  for (const [number, local] of byNumber) {
    if (remoteNumbers.has(number)) continue;
    if (local.source === 'PULLED') orphaned.push(number);
    else localOnly.push(number);
  }

  return {
    adopted,
    added,
    orphaned: orphaned.sort(),
    localOnly: localOnly.sort(),
    duplicates: [],
    pulledAt,
  };
}

/**
 * Ask the connected ledger for its chart, then reconcile.
 *
 * Two transactions with the HTTP call between them, same structure as the post
 * dispatcher: resolve the adapter and its credentials, close the transaction, call
 * out, open a new one to write.
 */
export async function pullFromLedger(
  withOrgTx: <T>(fn: (tx: QueryRunner) => Promise<T>) => Promise<T>,
): Promise<PullOutcome> {
  const resolved = await withOrgTx(async (tx) =>
    requireCapability(tx, 'PULL_CHART_OF_ACCOUNTS'),
  );
  // Outside any transaction.
  const remote = await resolved.adapter.pullChartOfAccounts!(resolved.config);
  return withOrgTx((tx) => pullChartOfAccounts(tx, remote, resolved.installationId));
}
