/**
 * Normalized shape of a Google Workspace Directory user as ExpenseOS
 * consumes it. Mappers translate the raw Admin SDK response into this
 * type so the rest of the package — and downstream callers — don't
 * depend on Google's nested AttributeValue-ish schema.
 *
 * w5-04 — ported from ExpenseOS `packages/integrations-google/src/types.ts` (1e682dd6).
 * VeloExpense: `DirectoryUser` only. ExpenseOS's `RefreshResult`, `AddUserResult` and
 * `DirectoryLookup` belong to its on-login refresh and its add-by-email, which VeloExpense
 * does not port (d84: the sync updates people VeloExpense already has, and nothing else).
 *
 * ExpenseOS 67db2e33 (#582, directory sync v2): `googleId` and `deleted` are new, and
 * department, business unit, legal entity, employee id and home currency are gone — Google
 * no longer writes them.
 */
export interface DirectoryUser {
  /** The Directory user id — the same value as the OIDC `sub` Google sign-in reports. Stored
   *  as the person's `google` external id and matched before email. */
  googleId: string;
  /** Primary email, lowercased. */
  email: string;
  firstName: string | null;
  lastName: string | null;
  avatarUrl: string | null;
  /** organizations[].title — free-text employee title. Resolved to a JobLevel
   *  on apply (see titleToJobLevelCode); job level drives `managerChain`
   *  approver selection, so an unmapped title leaves the ladder incomplete. */
  title: string | null;
  /** ISO-3166-1 alpha-2 from addresses[].countryCode. */
  country: string | null;
  employeeStatus: 'ACTIVE' | 'ON_LEAVE' | 'DEACTIVATED' | 'TERMINATED';
  /** When the account was archived or deleted; null otherwise. */
  terminationDate: Date | null;
  /** relations[?type=manager].value, lowercased. */
  managerEmail: string | null;
  /** The account was deleted in Google (listed only with `showDeleted`). */
  deleted: boolean;
}

/**
 * VeloExpense: the part of the Admin SDK's `admin_directory_v1.Schema$User` the mapper reads.
 * ExpenseOS imports the type from `googleapis`; VeloExpense calls the Directory API with
 * `fetch` (see ./client.ts) and does not take the dependency, so the shape is stated here.
 */
export interface GoogleUser {
  /** #582: the Directory user id. */
  id?: string | null;
  primaryEmail?: string | null;
  name?: { givenName?: string | null; familyName?: string | null } | null;
  thumbnailPhotoUrl?: string | null;
  organizations?: unknown;
  locations?: unknown;
  addresses?: unknown;
  externalIds?: unknown;
  relations?: unknown;
  archived?: boolean | null;
  suspended?: boolean | null;
  deletionTime?: string | null;
}
