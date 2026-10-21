/**
 * @expenseos/integrations-google — Google Workspace Admin SDK
 * Directory integration.
 *
 * w5-04 — ported from ExpenseOS `packages/integrations-google` (1e682dd6). ExpenseOS has two
 * consumers: its sign-in (`refreshUserFromDirectory`) and its daily worker job. VeloExpense
 * ports the daily job only (`worker/src/handlers/directory-sync.ts`), per tenant and update
 * only (d84); `refresh.ts` and `invite.ts` are not ported. Brought to ExpenseOS 67db2e33
 * (#582, directory sync v2): `probe.ts` and `settings.ts` are not ported either — the
 * tenant's connection and its Test already are `verifyDirectoryAccess` and
 * lib/directory/googleConnection.ts.
 *
 * Credentials are the tenant's (lib/directory/googleConnection.ts). Set
 * `GOOGLE_DIRECTORY_DISABLED=true` to short-circuit for offline /
 * non-Workspace dev.
 */

export {
  type ApplyOptions,
  type ApplyResult,
  applyDirectoryManager,
  applyDirectoryUserToDb,
  type FieldChange,
  GOOGLE_OWNED_FIELDS,
  GOOGLE_SOURCE_CODE,
  type GoogleOwnedField,
  googleSourceIdOf,
} from './apply';
export {
  type DirectoryClient,
  type DirectoryCredentials,
  GoogleDirectoryConfigError,
  GoogleDirectoryDisabledError,
  getDirectoryClient,
  isDirectoryDisabled,
  parseServiceAccountJson,
  verifyDirectoryAccess,
} from './client';
export { mapGoogleUserToDirectoryUser } from './mappers';
export {
  emptyCounts,
  type SyncAllCounts,
  type SyncAllOptions,
  type SyncAllResult,
  type SyncDb,
  type SyncItem,
  syncAllFromDirectory,
} from './syncAll';
export type { DirectoryUser, GoogleUser } from './types';
