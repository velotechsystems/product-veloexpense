/**
 * w5-04 — the tenant's Google Workspace connection: save it, test it, read it for a sync,
 * record what the sync did, disconnect it.
 *
 * VeloExpense-built, not ported. ExpenseOS reads one Workspace's key and admin address from
 * its environment (`packages/integrations-google/src/client.ts`, 1e682dd6) and has no screen
 * for them. VeloExpense gives each tenant its own (d84) in `google_directory_connection`
 * (0076), so this is the small store `slackConnection.ts` is for Slack, with its three rules:
 *
 *   · the key is NEVER returned to a screen — the view says that one is set, and the
 *     service account's address (which is not secret, and which the admin needs to grant
 *     domain-wide delegation);
 *   · a blank key on a save means "unchanged", so changing the admin address does not mean
 *     pasting the key again;
 *   · DISCONNECT DELETES the row, key and all.
 *
 * Every function runs on the caller's tenant transaction; the table is under RLS.
 */
import { parseServiceAccountJson } from '@expenseos/integrations-google';
import type { DirectoryCredentials, SyncAllResult } from '@expenseos/integrations-google';
import type { QueryRunner } from '@/lib/db/client';
import { DomainError } from '@/lib/errors/domain';
import { decryptSecret, encryptSecret } from '@/lib/crypto/secrets';

type Code =
  | 'DIRECTORY_KEY_REQUIRED'
  | 'DIRECTORY_KEY_INVALID'
  | 'DIRECTORY_ADMIN_EMAIL_INVALID'
  | 'DIRECTORY_NOT_CONNECTED';

export class DirectoryConnectionError extends DomainError {
  constructor(message: string, userMessage: Code) {
    super(message, userMessage);
    this.name = 'DirectoryConnectionError';
  }
}

/** The last sync, as the screen shows it: the summary audit row's details. */
export interface DirectorySyncSummary {
  status: 'completed' | 'error';
  trigger: string;
  scanned: number;
  updated: number;
  notFound: number;
  held: number;
  offboarded: number;
  errors: number;
  unmappedTitles: { title: string; count: number }[];
  missingJobLevels: { code: string; count: number }[];
  message?: string;
}

/** What the admin screen may know. No key, in any form. */
export interface DirectoryConnectionView {
  connected: boolean;
  clientEmail: string | null;
  impersonateEmail: string | null;
  connectedAt: Date | null;
  connectedByName: string | null;
  lastTestAt: Date | null;
  lastTestOk: boolean | null;
  lastTestError: string | null;
  lastSyncAt: Date | null;
  lastSync: DirectorySyncSummary | null;
}

const NOT_CONNECTED: DirectoryConnectionView = {
  connected: false,
  clientEmail: null,
  impersonateEmail: null,
  connectedAt: null,
  connectedByName: null,
  lastTestAt: null,
  lastTestOk: null,
  lastTestError: null,
  lastSyncAt: null,
  lastSync: null,
};

export async function getDirectoryConnection(tx: QueryRunner): Promise<DirectoryConnectionView> {
  const r = await tx.query(
    `SELECT g.client_email, g.impersonate_email, g.connected_at,
            g.last_test_at, g.last_test_ok, g.last_test_error,
            g.last_sync_at, g.last_sync_summary,
            COALESCE(u.display_name, u.email) AS connected_by_name
       FROM google_directory_connection g
       LEFT JOIN app_user u ON u.id = g.connected_by_id`,
  );
  const row = r.rows[0];
  if (!row) return NOT_CONNECTED;
  return {
    connected: true,
    clientEmail: row.client_email as string,
    impersonateEmail: row.impersonate_email as string,
    connectedAt: row.connected_at as Date,
    connectedByName: (row.connected_by_name as string | null) ?? null,
    lastTestAt: (row.last_test_at as Date | null) ?? null,
    lastTestOk: (row.last_test_ok as boolean | null) ?? null,
    lastTestError: (row.last_test_error as string | null) ?? null,
    lastSyncAt: (row.last_sync_at as Date | null) ?? null,
    lastSync: (row.last_sync_summary as DirectorySyncSummary | null) ?? null,
  };
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Connect, or change the key or the admin address.
 *
 * The key is required to connect, and is checked as it is saved — valid JSON with a
 * `client_email` and a `private_key` — so a bad paste is refused on the form, not by the
 * night's sync. Whether Google ACCEPTS it is what Test is for. A changed key or admin
 * clears the last test, which was about the old ones.
 */
export async function saveDirectoryConnection(
  tx: QueryRunner,
  actorId: string,
  input: { serviceAccountJson: string; impersonateEmail: string },
): Promise<void> {
  const rawKey = input.serviceAccountJson.trim();
  const admin = input.impersonateEmail.trim().toLowerCase();
  if (!EMAIL.test(admin)) {
    throw new DirectoryConnectionError(
      'the admin to impersonate is not an email address',
      'DIRECTORY_ADMIN_EMAIL_INVALID',
    );
  }
  let clientEmail: string | null = null;
  if (rawKey) {
    try {
      clientEmail = parseServiceAccountJson(rawKey).client_email;
    } catch {
      // The parser's sentence names the field, never the value; the screen's says what to do.
      throw new DirectoryConnectionError('the pasted key is not a service-account key file', 'DIRECTORY_KEY_INVALID');
    }
  }
  const existing = await tx.query(`SELECT impersonate_email FROM google_directory_connection`);

  if (existing.rows.length === 0) {
    if (!rawKey || !clientEmail) {
      throw new DirectoryConnectionError(
        'connecting Google Workspace needs a service-account key',
        'DIRECTORY_KEY_REQUIRED',
      );
    }
    await tx.query(
      `INSERT INTO google_directory_connection
         (service_account_json, client_email, impersonate_email, connected_by_id)
       VALUES ($1, $2, $3, $4)`,
      [encryptSecret(rawKey), clientEmail, admin, actorId],
    );
    return;
  }

  const adminChanged = existing.rows[0].impersonate_email !== admin;
  if (!rawKey && !adminChanged) return;
  await tx.query(
    `UPDATE google_directory_connection
        SET service_account_json = COALESCE($1, service_account_json),
            client_email         = COALESCE($2, client_email),
            impersonate_email    = $3,
            last_test_at = NULL, last_test_ok = NULL, last_test_error = NULL,
            updated_at = clock_timestamp()`,
    [rawKey ? encryptSecret(rawKey) : null, clientEmail, admin],
  );
}

/**
 * The stored credentials, decrypted — for a sync or a test. `null` when the tenant has not
 * connected. A key that cannot be decrypted (the server's key changed) is an answer, not a
 * crash: it comes back as `unreadable`, with the reason, and never the ciphertext.
 */
export async function directoryCredentials(
  tx: QueryRunner,
): Promise<
  | { state: 'ok'; credentials: DirectoryCredentials }
  | { state: 'not-connected' }
  | { state: 'unreadable'; message: string }
> {
  const r = await tx.query(
    `SELECT service_account_json, impersonate_email FROM google_directory_connection`,
  );
  const row = r.rows[0];
  if (!row) return { state: 'not-connected' };
  try {
    return {
      state: 'ok',
      credentials: {
        serviceAccountJson: decryptSecret(row.service_account_json as string),
        impersonateEmail: row.impersonate_email as string,
      },
    };
  } catch (e) {
    return {
      state: 'unreadable',
      message:
        'The stored key cannot be decrypted — SECRET_ENCRYPTION_KEY has changed since it was saved. ' +
        `Paste the key file again. (${e instanceof Error ? e.name : 'error'})`,
    };
  }
}

export async function recordDirectoryTest(
  tx: QueryRunner,
  result: { ok: boolean; message: string },
): Promise<void> {
  await tx.query(
    `UPDATE google_directory_connection
        SET last_test_at = clock_timestamp(), last_test_ok = $1, last_test_error = $2,
            updated_at = clock_timestamp()`,
    [result.ok, result.ok ? null : result.message],
  );
}

/** What a run did, on the row, for the screen. A `disabled` run records nothing. */
export async function recordDirectorySync(
  tx: QueryRunner,
  trigger: string,
  result: SyncAllResult,
  at: Date,
): Promise<void> {
  if (result.status === 'disabled') return;
  const summary: DirectorySyncSummary = {
    status: result.status,
    trigger,
    scanned: result.scanned,
    updated: result.updated,
    notFound: result.notFound,
    held: result.held,
    offboarded: result.offboarded.length,
    errors: result.errors,
    // The screen shows the commonest; the full tally is the audit row's.
    unmappedTitles: result.unmappedTitles.slice(0, 25),
    missingJobLevels: result.missingJobLevels.slice(0, 25),
    ...(result.message ? { message: result.message } : {}),
  };
  await tx.query(
    `UPDATE google_directory_connection
        SET last_sync_at = $1, last_sync_status = $2, last_sync_summary = $3::jsonb,
            updated_at = clock_timestamp()`,
    [at, result.status, JSON.stringify(summary)],
  );
}

/** Delete the connection and its key. */
export async function disconnectDirectory(tx: QueryRunner): Promise<void> {
  await tx.query(`DELETE FROM google_directory_connection`);
}
