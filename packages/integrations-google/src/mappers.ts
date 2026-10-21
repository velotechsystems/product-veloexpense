// w5-04 — ported from ExpenseOS `packages/integrations-google/src/mappers.ts` (1e682dd6), and
// brought to ExpenseOS 67db2e33 (#582, directory sync v2).
// VeloExpense: `GoogleUser` is stated in ./types rather than imported from `googleapis` (see
// ./client.ts).
import type { DirectoryUser, GoogleUser } from './types';

interface Org {
  primary?: boolean | null;
  title?: string | null;
}
interface Address {
  primary?: boolean | null;
  countryCode?: string | null;
}
interface Relation {
  type?: string | null;
  value?: string | null;
}

/**
 * Pick the primary entry from a list, falling back to the first
 * element when no entry is flagged `primary: true`.
 */
function preferPrimary<T extends { primary?: boolean | null }>(
  list: T[] | undefined | null,
): T | undefined {
  if (!list || list.length === 0) return undefined;
  return list.find((x) => x.primary === true) ?? list[0];
}

/** An empty or whitespace-only string carries no value. */
function text(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/**
 * Translate the raw Directory API user payload into the normalized DirectoryUser.
 *
 * Only the fields Google OWNS are read: name, photo, title (→ job level), email, manager,
 * status, termination date and country. Department, business unit and legal entity are not:
 * VeloExpense owns them, so reading Google's cost centre or building here would only invite
 * a second writer.
 *
 * `deleted` is the caller's to say: a deleted account looks like any other in the payload,
 * and is told apart only by having been listed with `showDeleted`.
 */
export function mapGoogleUserToDirectoryUser(
  user: GoogleUser,
  options: { deleted?: boolean } = {},
): DirectoryUser {
  const deleted = options.deleted === true;
  const email = (user.primaryEmail ?? '').trim().toLowerCase();

  const primaryOrg = preferPrimary((user.organizations ?? []) as Org[]);
  const primaryAddress = preferPrimary((user.addresses ?? []) as Address[]);
  const country = text(primaryAddress?.countryCode)?.toUpperCase() ?? null;

  let employeeStatus: DirectoryUser['employeeStatus'] = 'ACTIVE';
  if (deleted || user.archived) employeeStatus = 'TERMINATED';
  else if (user.suspended) employeeStatus = 'DEACTIVATED';

  const terminationDate =
    (deleted || user.archived) && user.deletionTime ? new Date(user.deletionTime) : null;

  const managerRelation = ((user.relations ?? []) as Relation[]).find((r) => r.type === 'manager');
  const managerEmail = text(managerRelation?.value)?.toLowerCase() ?? null;

  return {
    googleId: text(user.id) ?? '',
    email,
    firstName: text(user.name?.givenName),
    lastName: text(user.name?.familyName),
    avatarUrl: text(user.thumbnailPhotoUrl),
    title: text(primaryOrg?.title),
    country,
    employeeStatus,
    terminationDate,
    managerEmail,
    deleted,
  };
}
