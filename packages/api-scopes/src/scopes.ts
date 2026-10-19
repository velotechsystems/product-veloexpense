/**
 * The API scope vocabulary.
 *
 * **Static and code-owned, by decision.** Scopes are treated like the list of countries
 * or currencies: they change rarely, they are not user data, and a rename is a migration
 * that rewrites the `scopes` array on every stored key. That is a deliberate cost — the
 * alternative (a `Scope` table with foreign keys) would put a code-owned registry into the
 * database and cut against how `@expenseos/platform` keeps module specs in code.
 *
 * The shape follows Google Workspace's:
 *
 *     <surface>.<module>.<resource>            → read AND write
 *     <surface>.<module>.<resource>.readonly   → read only
 *
 * So `expense_management.expense_report` can submit one and
 * `expense_management.expense_report.readonly` can only look at it. There is no separate
 * "may this key write" flag anywhere — holding the base scope IS the write grant, which
 * means there are never two sources of truth to disagree.
 *
 * ## Renaming a scope
 *
 * Renaming or removing an entry below is a BREAKING change to every key that holds it: a
 * stored scope string that no longer appears here authorizes nothing, silently. Any rename
 * therefore ships with a data migration that rewrites `ApiKey.scopes`, in the same commit.
 */

/** The read-only suffix. Not a scope on its own. */
export const READONLY_SUFFIX = '.readonly' as const;

/**
 * Every resource an API key can be scoped to.
 *
 * Kept deliberately coarse — one entry per resource a caller reasons about, not one per
 * procedure. A scope list somebody has to read before granting is a scope list nobody
 * reads before granting.
 */
export const SCOPE_RESOURCES = [
  'expense_management.expense_report',
  'expense_management.expense_approval',
  'travel.travel_request',
  /**
   * Deciding a trip is a different authority from filing one, exactly as
   * `expense_approval` is from `expense_report`.
   *
   * Without this, `decide_travel_request` would sit under `travel.travel_request` — which
   * the self-service personal key grants — and a key issued to file trips could approve
   * them. The expense side has been safe from that since it split the two; travel and
   * cards were only safe because no approval tool existed yet.
   */
  'travel.travel_approval',
  'vcc.virtual_card',
  /** Same split, same reason: requesting a card and approving one are not one authority. */
  'vcc.virtual_card_approval',
  'finance.budget',
  'collaboration.discussion',
  'admin.expense_management.expense_category',
  'admin.people.user',
  'admin.security.api_key',
] as const;

export type ScopeResource = (typeof SCOPE_RESOURCES)[number];

/** Every grantable scope string: each resource, plus its read-only variant. */
export const ALL_SCOPES: readonly string[] = SCOPE_RESOURCES.flatMap((r) => [
  r,
  `${r}${READONLY_SUFFIX}`,
]);

const RESOURCE_SET = new Set<string>(SCOPE_RESOURCES);
const SCOPE_SET = new Set<string>(ALL_SCOPES);

/** Is this a scope string this build knows about? */
export function isScope(value: string): boolean {
  return SCOPE_SET.has(value);
}

/** Is this a resource (i.e. a scope without the read-only suffix)? */
export function isScopeResource(value: string): value is ScopeResource {
  return RESOURCE_SET.has(value);
}

/**
 * Split a scope string into its resource and whether it is read-only.
 *
 * Returns null for anything not in the registry — including a well-formed-looking string
 * for a resource that does not exist. Guessing would let a typo grant nothing while
 * looking like it granted something.
 */
export function parseScope(scope: string): { resource: ScopeResource; readOnly: boolean } | null {
  if (scope.endsWith(READONLY_SUFFIX)) {
    const resource = scope.slice(0, -READONLY_SUFFIX.length);
    return isScopeResource(resource) ? { resource, readOnly: true } : null;
  }
  return isScopeResource(scope) ? { resource: scope, readOnly: false } : null;
}
