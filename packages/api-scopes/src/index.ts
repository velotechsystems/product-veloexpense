/**
 * @expenseos/api-scopes — the static scope vocabulary for API keys, and the one rule that
 * decides whether a key's scopes authorize an operation.
 *
 * No database, no Prisma, no I/O. A scope list is data; this package is the grammar.
 */

export {
  type Access,
  denyReason,
  grantedResources,
  type ScopeDenial,
  satisfies,
  unknownScopes,
} from './satisfy';
export {
  ALL_SCOPES,
  isScope,
  isScopeResource,
  parseScope,
  READONLY_SUFFIX,
  SCOPE_RESOURCES,
  type ScopeResource,
} from './scopes';
