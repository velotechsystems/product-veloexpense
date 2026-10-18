/**
 * @expenseos/integrations-google — Google Workspace Admin SDK
 * Directory integration.
 *
 * w5-04 — ported from ExpenseOS `packages/integrations-google` (1e682dd6). ExpenseOS has two
 * consumers: its sign-in (`refreshUserFromDirectory`) and its daily worker job. VeloExpense
 * ports the daily job only (`worker/src/handlers/directory-sync.ts`), per tenant and update
 * only (d84); `refresh.ts` and `invite.ts` are not ported.
 *
 * Credentials are the tenant's (lib/directory/googleConnection.ts). Set
 * `GOOGLE_DIRECTORY_DISABLED=true` to short-circuit for offline /
 * non-Workspace dev.
 */

export { type ApplyResult, applyDirectoryUserToDb } from './apply';
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
export { type SyncAllOptions, type SyncAllResult, type SyncDb, syncAllFromDirectory } from './syncAll';
export type { DirectoryUser, GoogleUser } from './types';
