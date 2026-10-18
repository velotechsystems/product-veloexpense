// w5-04 — ported from ExpenseOS `packages/integrations-google/src/syncAll.ts` (1e682dd6).
// VeloExpense, each marked below:
//   · the credentials are the TENANT's, passed in (`null` = not connected, which is
//     `disabled`, as ExpenseOS's missing environment is on dev) — see ./client.ts;
//   · update only (d84): ExpenseOS's `created` counter is `notFound` here — Directory users
//     VeloExpense does not have, left alone — plus `held` and `offboarded` (./apply.ts);
//   · each person is applied in its own tenant transaction (`db.$transaction`), so one
//     person's failure rolls back that person only, as ExpenseOS's per-user try/catch intends;
//   · the customer is always `my_customer` unless the caller says otherwise: it resolves to
//     the impersonated admin's own Workspace, which per tenant is the right one. ExpenseOS's
//     GOOGLE_WORKSPACE_CUSTOMER_ID override was platform-wide, so it is not read.
import { titleToJobLevelCode } from '@expenseos/db';
import type { TenantDb } from '@/lib/db/prisma';
import { applyDirectoryUserToDb } from './apply';
import {
  type DirectoryClient,
  type DirectoryCredentials,
  GoogleDirectoryConfigError,
  GoogleDirectoryDisabledError,
  getDirectoryClient,
  isDirectoryDisabled,
} from './client';
import { mapGoogleUserToDirectoryUser } from './mappers';
import type { GoogleUser } from './types';

/** VeloExpense: anything that runs a function on a tenant transaction — the worker's `db`. */
export interface SyncDb {
  $transaction<T>(fn: (tx: TenantDb) => Promise<T>): Promise<T>;
}

export interface SyncAllOptions {
  /**
   * Customer ID. Defaults to `'my_customer'` which resolves to the
   * customer associated with the impersonated admin account.
   * (VeloExpense: no env override — see the header.)
   */
  customer?: string;
  /** Page size (1-500). Default 500 = fewest API calls. */
  pageSize?: number;
  /**
   * Per-user callback. Useful for progress logging in long syncs.
   * Receives the per-page counters after each user is processed.
   */
  onUser?: (event: {
    email: string;
    // VeloExpense: `not-found` and `held` where ExpenseOS has `created` (see the header).
    outcome: 'updated' | 'not-found' | 'held' | 'error';
    error?: string;
  }) => void;
  /** VeloExpense: the client, for a test; otherwise built from the credentials. */
  client?: DirectoryClient;
  /** VeloExpense: passed to `applyDirectoryUserToDb`, for a test. */
  now?: Date;
}

export interface SyncAllResult {
  status: 'completed' | 'disabled' | 'error';
  scanned: number;
  updated: number;
  /** VeloExpense: in Directory, not in VeloExpense, left alone (ExpenseOS's `created`). */
  notFound: number;
  /** VeloExpense: offboardings refused — today only the tenant's last active admin. */
  held: number;
  /** VeloExpense: the people this run offboarded, by id — for the summary audit row. */
  offboarded: string[];
  errors: number;
  /**
   * Distinct employee titles no rule in `titleToJobLevelCode` recognized, with
   * how many people hold each — most common first.
   *
   * These people end up with NO job level, which is not cosmetic: a
   * `managerChain` approval node walks up the requester's chain looking for
   * someone at or above its tier, and an unlevelled person is invisible to that
   * walk. Enough of them in one chain and tiered approvals route past everyone
   * who should have seen them. Surfaced here rather than logged and forgotten
   * so the mapping can be extended against real data.
   */
  unmappedTitles: { title: string; count: number }[];
  /**
   * VeloExpense: level codes a title DID map to that this tenant has no job level for, with
   * how many people — most common first. ExpenseOS has one ladder with every code; a
   * VeloExpense tenant builds its own (0050), so a recognized title can still land nowhere,
   * and the person is just as invisible to a `managerChain` walk.
   */
  missingJobLevels: { code: string; count: number }[];
  /** Set when `status === 'error'` (init / config failure before any user). */
  message?: string;
}

/** Sort an unmapped-title tally into the result shape, most common first. */
function tallyToList(tally: Map<string, number>): { title: string; count: number }[] {
  return [...tally.entries()]
    .map(([title, count]) => ({ title, count }))
    .sort((a, b) => b.count - a.count || a.title.localeCompare(b.title));
}

/** VeloExpense: the same, for missing level codes. */
function codesToList(tally: Map<string, number>): { code: string; count: number }[] {
  return tallyToList(tally).map(({ title, count }) => ({ code: title, count }));
}

/**
 * Page through the entire Workspace Directory and reconcile every
 * user into the DB. Idempotent: rows that already match Directory
 * land in the `updated` counter even when nothing changed; rows that
 * weren't in the DB yet land in `notFound` (VeloExpense: and stay out).
 *
 * Failures on individual users are caught — they increment `errors`
 * and the sync continues. A fatal init / config failure returns
 * `status: 'error'` with no per-user work attempted.
 */
export async function syncAllFromDirectory(
  db: SyncDb,
  // VeloExpense: the tenant's stored credentials; `null` when it has not connected.
  credentials: DirectoryCredentials | null,
  options: SyncAllOptions = {},
): Promise<SyncAllResult> {
  const empty = { scanned: 0, updated: 0, notFound: 0, held: 0, offboarded: [] as string[], errors: 0 };
  // VeloExpense: not connected is `disabled` too — the tenant never turned it on.
  if (isDirectoryDisabled() || (credentials === null && !options.client)) {
    return { status: 'disabled', ...empty, unmappedTitles: [], missingJobLevels: [] };
  }

  let client: DirectoryClient;
  try {
    client = options.client ?? getDirectoryClient(credentials);
  } catch (e) {
    if (e instanceof GoogleDirectoryDisabledError) {
      return { status: 'disabled', ...empty, unmappedTitles: [], missingJobLevels: [] };
    }
    const message =
      e instanceof GoogleDirectoryConfigError ? e.message : `init failed: ${String(e)}`;
    return { status: 'error', ...empty, unmappedTitles: [], missingJobLevels: [], message };
  }

  const customer = options.customer ?? 'my_customer';
  const pageSize = Math.min(Math.max(options.pageSize ?? 500, 1), 500);

  let scanned = 0;
  let updated = 0;
  let notFound = 0;
  let held = 0;
  const offboarded: string[] = [];
  let errors = 0;
  const unmapped = new Map<string, number>();
  const missingLevels = new Map<string, number>();
  let pageToken: string | undefined;

  do {
    let response: { data: { users?: GoogleUser[]; nextPageToken?: string } };
    try {
      response = await client.users.list({
        customer,
        maxResults: pageSize,
        pageToken,
        projection: 'full',
        orderBy: 'email',
      });
    } catch (e) {
      return {
        status: 'error',
        scanned,
        updated,
        notFound,
        held,
        offboarded,
        errors,
        unmappedTitles: tallyToList(unmapped),
        missingJobLevels: codesToList(missingLevels),
        message: `directory.users.list failed: ${e instanceof Error ? e.message : String(e)}`,
      };
    }

    const users = response.data.users ?? [];
    for (const raw of users) {
      scanned += 1;
      const mapped = mapGoogleUserToDirectoryUser(raw);
      if (!mapped.email) {
        errors += 1;
        options.onUser?.({ email: '(unknown)', outcome: 'error', error: 'missing primaryEmail' });
        continue;
      }
      // Tally titles the level mapping doesn't recognize (see SyncAllResult).
      if (mapped.title && !titleToJobLevelCode(mapped.title)) {
        const key = mapped.title.trim();
        unmapped.set(key, (unmapped.get(key) ?? 0) + 1);
      }
      try {
        // VeloExpense: one person, one tenant transaction (see the header).
        const result = await db.$transaction((tx) =>
          applyDirectoryUserToDb(tx, mapped, { now: options.now }),
        );
        if (result.outcome === 'not-found') {
          notFound += 1;
          options.onUser?.({ email: mapped.email, outcome: 'not-found' });
        } else if (result.outcome === 'held') {
          held += 1;
          options.onUser?.({ email: mapped.email, outcome: 'held' });
        } else {
          updated += 1;
          if (result.offboarded) offboarded.push(result.userId);
          if (result.missingLevelCode) {
            missingLevels.set(result.missingLevelCode, (missingLevels.get(result.missingLevelCode) ?? 0) + 1);
          }
          options.onUser?.({ email: mapped.email, outcome: 'updated' });
        }
      } catch (e) {
        errors += 1;
        const message = e instanceof Error ? e.message : String(e);
        options.onUser?.({ email: mapped.email, outcome: 'error', error: message });
      }
    }

    pageToken = response.data.nextPageToken ?? undefined;
  } while (pageToken);

  return {
    status: 'completed',
    scanned,
    updated,
    notFound,
    held,
    offboarded,
    errors,
    unmappedTitles: tallyToList(unmapped),
    missingJobLevels: codesToList(missingLevels),
  };
}
