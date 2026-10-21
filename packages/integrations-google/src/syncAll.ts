// w5-04 — ported from ExpenseOS `packages/integrations-google/src/syncAll.ts` (1e682dd6), and
// brought to ExpenseOS 67db2e33 (#582, directory sync v2): every account, live and deleted,
// both listings read in full before anything is written; pass 1 applies every account
// without its manager, pass 2 resolves managers once everybody is matched; one run-report
// item per account that was changed, linked, refused or failed.
//
// VeloExpense, each marked below:
//   · the credentials are the TENANT's, passed in (`null` = not connected, which is
//     `disabled`, as ExpenseOS's missing settings are) — see ./client.ts. ExpenseOS's
//     `loadDirectorySettings` (its integration installation, with environment fallback) is
//     VeloExpense's `google_directory_connection` (0076, lib/directory/googleConnection.ts);
//   · update only (d84): ExpenseOS's `created` counter is `notFound` here — Directory users
//     VeloExpense does not have, left alone — plus `held` and the people `offboarded`
//     (./apply.ts);
//   · each person is applied in its own tenant transaction (`db.$transaction`), so one
//     person's failure rolls back that person only, as ExpenseOS's per-user try/catch intends;
//   · the customer is always `my_customer` unless the caller says otherwise: it resolves to
//     the impersonated admin's own Workspace, which per tenant is the right one;
//   · a recognised title this tenant has no job level for is reported as a missing level
//     code (`missingJobLevels`), next to ExpenseOS's unmapped titles.
import type { TenantDb } from '@/lib/db/prisma';
import {
  type ApplyResult,
  applyDirectoryManager,
  applyDirectoryUserToDb,
  type FieldChange,
  googleSourceIdOf,
} from './apply';
import {
  type DirectoryClient,
  type DirectoryCredentials,
  GoogleDirectoryConfigError,
  GoogleDirectoryDisabledError,
  getDirectoryClient,
  isDirectoryDisabled,
} from './client';
import { mapGoogleUserToDirectoryUser } from './mappers';
import type { DirectoryUser, GoogleUser } from './types';

/** VeloExpense: anything that runs a function on a tenant transaction — the worker's `db`. */
export interface SyncDb {
  $transaction<T>(fn: (tx: TenantDb) => Promise<T>): Promise<T>;
}

export interface SyncAllOptions {
  /** Customer ID. Defaults to `'my_customer'` (the impersonated admin's own Workspace). */
  customer?: string;
  /** Page size (1-500). Default 500 = fewest API calls. */
  pageSize?: number;
  /** Called after each person is processed — the caller heart-beats its run with it. */
  onProgress?: (processed: number) => Promise<void> | void;
  /** VeloExpense: the client, for a test; otherwise built from the credentials. */
  client?: DirectoryClient;
  /** VeloExpense: passed to `applyDirectoryUserToDb`, for a test. */
  now?: Date;
}

/** What happened to one Directory account, for the run report. */
export interface SyncItem {
  outcome: 'UPDATED' | 'LINKED' | 'CONFLICT' | 'SKIPPED' | 'ERROR';
  userId: string | null;
  googleId: string;
  email: string;
  fields: Record<string, FieldChange>;
  message?: string;
}

export interface SyncAllCounts {
  /** Accounts listed by Google (live + deleted). */
  scanned: number;
  active: number;
  deleted: number;
  updated: number;
  unchanged: number;
  /** VeloExpense: in Directory, not here, left alone (ExpenseOS's `created`, d84). */
  notFound: number;
  /** VeloExpense: offboardings refused — the tenant's last active admin. */
  held: number;
  /** Existing people linked to their Google account this run. */
  linked: number;
  /** …of which re-linked from a Google account that no longer exists. */
  relinked: number;
  conflicts: number;
  skipped: number;
  errors: number;
  /** People whose Google manager is nobody here (manager left unchanged). */
  managersUnresolved: number;
  /** Titles no job-level rule recognises, with how many people hold each. */
  unmappedTitles: { title: string; count: number }[];
  /**
   * VeloExpense: level codes a title DID map to that this tenant has no job level for, with
   * how many people — most common first. A VeloExpense tenant builds its own ladder (0050),
   * so a recognised title can still land nowhere.
   */
  missingJobLevels: { code: string; count: number }[];
}

export interface SyncAllResult {
  status: 'completed' | 'disabled' | 'error';
  counts: SyncAllCounts;
  /** Every account that was changed, linked, refused or failed — not the unchanged. */
  items: SyncItem[];
  /** VeloExpense: the people this run offboarded, by id — for the summary audit row. */
  offboarded: string[];
  /** Why the run was disabled or failed. */
  message?: string;
}

export const emptyCounts = (): SyncAllCounts => ({
  scanned: 0,
  active: 0,
  deleted: 0,
  updated: 0,
  unchanged: 0,
  notFound: 0,
  held: 0,
  linked: 0,
  relinked: 0,
  conflicts: 0,
  skipped: 0,
  errors: 0,
  managersUnresolved: 0,
  unmappedTitles: [],
  missingJobLevels: [],
});

/** Sort a tally into the result shape, most common first. */
function tallyToList(tally: Map<string, number>): { title: string; count: number }[] {
  return [...tally.entries()]
    .map(([title, count]) => ({ title, count }))
    .sort((a, b) => b.count - a.count || a.title.localeCompare(b.title));
}

/** Page through one `users.list` listing to the end. */
async function listAll(
  client: DirectoryClient,
  params: { customer: string; pageSize: number; showDeleted: boolean },
): Promise<GoogleUser[]> {
  const out: GoogleUser[] = [];
  let pageToken: string | undefined;
  do {
    const response = await client.users.list({
      customer: params.customer,
      maxResults: params.pageSize,
      pageToken,
      projection: 'full',
      orderBy: 'email',
      ...(params.showDeleted ? { showDeleted: 'true' as const } : {}),
    });
    out.push(...(response.data.users ?? []));
    pageToken = response.data.nextPageToken ?? undefined;
  } while (pageToken);
  return out;
}

/**
 * Reconcile the whole Workspace directory into this tenant — every account, whatever its
 * status: live accounts (active, suspended, archived) and accounts deleted in Google, which
 * Google still lists for about 20 days.
 *
 * Both listings are read in full BEFORE anything is written. The set of live Google ids is
 * what decides a re-link (a person whose old account was deleted and whose address was
 * re-issued) versus a conflict (two live accounts claiming one person), and a deleted account
 * may share an address with a live one — so neither can be judged one page at a time.
 *
 * Pass 1 applies every account without its manager; pass 2 resolves managers once every
 * person is matched. A failure on one person is recorded and the run continues; a failure to
 * LIST the directory fails the run before anything is written.
 */
export async function syncAllFromDirectory(
  db: SyncDb,
  // VeloExpense: the tenant's stored credentials; `null` when it has not connected.
  credentials: DirectoryCredentials | null,
  options: SyncAllOptions = {},
): Promise<SyncAllResult> {
  const none = (status: SyncAllResult['status'], message?: string): SyncAllResult => ({
    status,
    counts: emptyCounts(),
    items: [],
    offboarded: [],
    ...(message ? { message } : {}),
  });
  // VeloExpense: not connected is `disabled` too — the tenant never turned it on.
  if (isDirectoryDisabled()) {
    return none('disabled', 'Directory sync is switched off for this environment (GOOGLE_DIRECTORY_DISABLED).');
  }
  if (credentials === null && !options.client) {
    return none('disabled', 'Google Workspace is not connected.');
  }

  let client: DirectoryClient;
  try {
    client = options.client ?? getDirectoryClient(credentials);
  } catch (e) {
    if (e instanceof GoogleDirectoryDisabledError) return none('disabled', e.message);
    const message =
      e instanceof GoogleDirectoryConfigError ? e.message : `init failed: ${String(e)}`;
    return none('error', message);
  }

  const customer = options.customer ?? 'my_customer';
  const pageSize = Math.min(Math.max(options.pageSize ?? 500, 1), 500);
  let live: GoogleUser[];
  let gone: GoogleUser[];
  try {
    live = await listAll(client, { customer, pageSize, showDeleted: false });
    gone = await listAll(client, { customer, pageSize, showDeleted: true });
  } catch (e) {
    return none(
      'error',
      `directory.users.list failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  const activeAccounts = live.map((raw) => mapGoogleUserToDirectoryUser(raw));
  const activeIds = new Set(activeAccounts.map((u) => u.googleId).filter(Boolean));
  const activeEmails = new Set(activeAccounts.map((u) => u.email).filter(Boolean));
  // Google can list an account in both views mid-restore; the live one wins.
  const deletedAccounts = gone
    .map((raw) => mapGoogleUserToDirectoryUser(raw, { deleted: true }))
    .filter((u) => !activeIds.has(u.googleId));

  const counts = emptyCounts();
  counts.active = activeAccounts.length;
  counts.deleted = deletedAccounts.length;
  counts.scanned = activeAccounts.length + deletedAccounts.length;
  const items: SyncItem[] = [];
  const offboarded: string[] = [];
  const itemByUser = new Map<string, SyncItem>();
  const managers: { userId: string; managerEmail: string | null; account: DirectoryUser }[] = [];
  const unmapped = new Map<string, number>();
  const missingLevels = new Map<string, number>();
  const googleSourceId = await db.$transaction((tx) => googleSourceIdOf(tx));

  let processed = 0;
  const all = [
    ...activeAccounts.map((account) => ({ account, deleted: false })),
    ...deletedAccounts.map((account) => ({ account, deleted: true })),
  ];
  for (const { account, deleted } of all) {
    processed += 1;
    if (!account.email || !account.googleId) {
      counts.errors += 1;
      items.push({
        outcome: 'ERROR',
        userId: null,
        googleId: account.googleId,
        email: account.email || '(unknown)',
        fields: {},
        message: 'Google returned an account with no id or primary email.',
      });
      continue;
    }
    let result: ApplyResult;
    try {
      // VeloExpense: one person, one tenant transaction (see the header).
      result = await db.$transaction((tx) =>
        applyDirectoryUserToDb(tx, account, {
          resolveManager: false,
          activeGoogleIds: activeIds,
          googleSourceId,
          // A deleted account matches by email only while no live account holds that
          // address — otherwise it would terminate whoever owns it now.
          allowEmailMatch: !deleted || !activeEmails.has(account.email),
          now: options.now,
        }),
      );
    } catch (e) {
      counts.errors += 1;
      items.push({
        outcome: 'ERROR',
        userId: null,
        googleId: account.googleId,
        email: account.email,
        fields: {},
        message: e instanceof Error ? e.message : String(e),
      });
      continue;
    }
    if (result.titleUnmapped && account.title) {
      unmapped.set(account.title, (unmapped.get(account.title) ?? 0) + 1);
    }
    if (result.missingLevelCode) {
      missingLevels.set(result.missingLevelCode, (missingLevels.get(result.missingLevelCode) ?? 0) + 1);
    }
    if (result.offboarded && result.userId) offboarded.push(result.userId);
    const item = toItem(account, result);
    if (item) {
      items.push(item);
      if (item.userId) itemByUser.set(item.userId, item);
    }
    tally(counts, result);
    // Not for a deleted account: Google drops its manager relation, and clearing a leaver's
    // manager would strand the open reports the offboarding roll-up moves TO that manager.
    // The last manager Google gave while the account was live stands.
    if (
      !deleted &&
      result.userId &&
      (result.outcome === 'updated' || result.outcome === 'unchanged')
    ) {
      managers.push({ userId: result.userId, managerEmail: account.managerEmail, account });
    }
    if (processed % 50 === 0) await options.onProgress?.(processed);
  }

  // ── Pass 2: managers, now that every person is matched ────────────
  for (const { userId, managerEmail, account } of managers) {
    try {
      const out = await db.$transaction((tx) => applyDirectoryManager(tx, userId, managerEmail));
      if (out.unresolved) {
        counts.managersUnresolved += 1;
        continue;
      }
      if (!out.change) continue;
      let item = itemByUser.get(userId);
      if (!item) {
        item = {
          outcome: 'UPDATED',
          userId,
          googleId: account.googleId,
          email: account.email,
          fields: {},
        };
        items.push(item);
        itemByUser.set(userId, item);
        counts.unchanged -= 1;
        counts.updated += 1;
      } else if (item.outcome === 'SKIPPED') {
        // Pass 1 found nothing to change but had a note; the manager is a change.
        item.outcome = 'UPDATED';
        counts.unchanged -= 1;
        counts.updated += 1;
      } else if (item.outcome === 'LINKED') {
        item.outcome = 'UPDATED';
      }
      item.fields.managerId = out.change;
    } catch (e) {
      counts.errors += 1;
      items.push({
        outcome: 'ERROR',
        userId,
        googleId: account.googleId,
        email: account.email,
        fields: {},
        message: `manager: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }
  await options.onProgress?.(processed);

  counts.unmappedTitles = tallyToList(unmapped);
  counts.missingJobLevels = tallyToList(missingLevels).map(({ title, count }) => ({
    code: title,
    count,
  }));
  return { status: 'completed', counts, items, offboarded };
}

function tally(counts: SyncAllCounts, result: ApplyResult): void {
  if (result.outcome === 'updated') counts.updated += 1;
  else if (result.outcome === 'unchanged') counts.unchanged += 1;
  else if (result.outcome === 'conflict') counts.conflicts += 1;
  else if (result.outcome === 'skipped') counts.skipped += 1;
  else if (result.outcome === 'not-found') counts.notFound += 1;
  else if (result.outcome === 'held') counts.held += 1;
  if (result.linked) counts.linked += 1;
  if (result.relinked) counts.relinked += 1;
}

/** The run-report row for one account; null when nothing happened worth recording. */
function toItem(account: DirectoryUser, result: ApplyResult): SyncItem | null {
  const base = {
    userId: result.userId,
    googleId: account.googleId,
    email: account.email,
    fields: { ...result.changes } as Record<string, FieldChange>,
    ...(result.message ? { message: result.message } : {}),
  };
  switch (result.outcome) {
    case 'conflict':
      return { ...base, outcome: 'CONFLICT' };
    // VeloExpense: an account nobody here has is noise, not news (d84) — counted, no item.
    case 'not-found':
      return null;
    // VeloExpense: a held offboarding is refused work — recorded as a skip with its reason.
    case 'held':
      return { ...base, outcome: 'SKIPPED' };
    case 'skipped':
      // A deleted account nobody here ever had is noise, not news.
      return account.deleted && !result.userId ? null : { ...base, outcome: 'SKIPPED' };
    case 'updated': {
      const onlyLinked = Object.keys(result.changes).length === 0;
      return {
        ...base,
        outcome: onlyLinked ? 'LINKED' : 'UPDATED',
        ...(result.relinked
          ? {
              message: [base.message, 'Re-linked from a Google account that no longer exists.']
                .filter(Boolean)
                .join(' '),
            }
          : {}),
      };
    }
    case 'unchanged':
      // Unchanged, but something is worth a look (email kept, unresolved title/manager…).
      return result.message ? { ...base, outcome: 'SKIPPED' } : null;
  }
}
