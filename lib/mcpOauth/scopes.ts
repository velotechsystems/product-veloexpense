/**
 * What an OAuth client may be granted: the personal key's scopes, and nothing more.
 *
 * VeloCRM's scopes are its two MCP roles (`mcp:read_only`, `mcp:ai_drafter`). VeloExpense
 * already has a scope vocabulary (@expenseos/api-scopes) and a fixed self-service policy for a
 * credential a person issues to an agent acting as them (`PERSONAL_KEY_POLICY`). A Claude
 * connector IS that credential, obtained by a different route, so it gets exactly that policy:
 * the same three scopes, each optionally narrowed to `.readonly`. OAuth must not widen any
 * tool's authority, and this is where that is true — a client asking for an admin scope gets
 * the scopes it may have and is told which it got (`scope` in the token response).
 */
import { PERSONAL_KEY_POLICY } from '@/server/lib/personalApiKey';

const READONLY = '.readonly';

/** Every scope string an OAuth grant may carry. */
export const OAUTH_SCOPES: readonly string[] = PERSONAL_KEY_POLICY.scopes.flatMap((s) => [
  s,
  `${s}${READONLY}`,
]);

const ALLOWED = new Set(OAUTH_SCOPES);

/** The scopes a grant gets when the client asks for none, or only for ones it may not have. */
export const DEFAULT_OAUTH_SCOPES: readonly string[] = [...PERSONAL_KEY_POLICY.scopes];

/**
 * Narrow a requested `scope` parameter (space-separated, RFC 6749 §3.3) to what may be granted.
 * Unknown and disallowed entries are dropped; if nothing is left, the default set.
 */
export function grantableScopes(requested: string | null | undefined): string[] {
  const out: string[] = [];
  for (const s of (requested ?? '').split(/\s+/)) {
    if (s && ALLOWED.has(s) && !out.includes(s)) out.push(s);
  }
  // A base scope already grants its read-only half; listing both only confuses the consent screen.
  const trimmed = out.filter((s) => !(s.endsWith(READONLY) && out.includes(s.slice(0, -READONLY.length))));
  return trimmed.length > 0 ? trimmed : [...DEFAULT_OAUTH_SCOPES];
}

/** Defence in depth for a stored or signed list: only allowed scopes survive. */
export function onlyAllowed(scopes: readonly string[]): string[] {
  return scopes.filter((s) => ALLOWED.has(s));
}

/** The resource half of a scope string, and whether it is the read-only variant. */
export function describeScope(scope: string): { resource: string; readonly: boolean } {
  return scope.endsWith(READONLY)
    ? { resource: scope.slice(0, -READONLY.length), readonly: true }
    : { resource: scope, readonly: false };
}
