/**
 * Does a key's scope list authorize a given operation?
 *
 * One function, and it is the entire authorization contribution of scopes. Everything else
 * about permission still comes from the acting user's role — a scope can only ever NARROW
 * what that person could already do.
 */

import { parseScope, READONLY_SUFFIX, type ScopeResource } from './scopes';

/** Whether an operation reads or writes. Decides if `.readonly` is enough. */
export type Access = 'read' | 'write';

export type ScopeDenial =
  | { readonly kind: 'no_scopes' }
  | { readonly kind: 'resource_not_granted'; readonly resource: ScopeResource }
  | { readonly kind: 'read_only'; readonly resource: ScopeResource };

/**
 * Check `held` against what an operation needs.
 *
 * Returns null when allowed, or the reason it is not — the reason matters, because
 * "your key has no scope for budgets" and "your key can only read budgets" send somebody
 * to two different places.
 *
 * An empty `held` denies everything. That is the ruled behaviour and it is the safe
 * direction: a key minted with no scopes chosen has been given nothing, not everything.
 */
export function denyReason(
  held: readonly string[],
  required: ScopeResource,
  access: Access,
): ScopeDenial | null {
  if (held.length === 0) return { kind: 'no_scopes' };

  let sawReadOnly = false;
  for (const scope of held) {
    const parsed = parseScope(scope);
    if (!parsed || parsed.resource !== required) continue;
    // The base scope covers both accesses, so it short-circuits.
    if (!parsed.readOnly) return null;
    sawReadOnly = true;
  }

  if (!sawReadOnly) return { kind: 'resource_not_granted', resource: required };
  // A read-only grant satisfies a read and nothing else.
  return access === 'read' ? null : { kind: 'read_only', resource: required };
}

/** Convenience predicate over `denyReason`. */
export function satisfies(
  held: readonly string[],
  required: ScopeResource,
  access: Access,
): boolean {
  return denyReason(held, required, access) === null;
}

/**
 * Resources this key can touch at all, read or write.
 *
 * Used to describe a key in the UI ("can read budgets, can write expense reports") rather
 * than to authorize anything — authorization is always `denyReason` against a specific
 * operation.
 */
export function grantedResources(
  held: readonly string[],
): ReadonlyArray<{ resource: ScopeResource; access: Access }> {
  const best = new Map<ScopeResource, Access>();
  for (const scope of held) {
    const parsed = parseScope(scope);
    if (!parsed) continue;
    const access: Access = parsed.readOnly ? 'read' : 'write';
    // Write outranks read when a key somehow holds both forms of one resource.
    if (best.get(parsed.resource) !== 'write') best.set(parsed.resource, access);
  }
  return [...best.entries()]
    .map(([resource, access]) => ({ resource, access }))
    .sort((a, b) => a.resource.localeCompare(b.resource));
}

/** Drop anything this build does not recognise. Used when validating a mint request. */
export function unknownScopes(requested: readonly string[]): readonly string[] {
  return requested.filter((s) => parseScope(s) === null);
}

export { READONLY_SUFFIX };
