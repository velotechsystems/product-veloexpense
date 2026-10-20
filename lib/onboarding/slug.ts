/**
 * VX5-1 — turning what somebody typed into a hostname.
 *
 * The slug is not decoration. `resolveSsoUser` already matches on it (an
 * org-slug SSO login has existed since VX0-7), and VX5-5 makes it a SUBDOMAIN.
 * So this is the one field on the signup form whose value ends up in a
 * certificate.
 *
 * `0034` holds the SHAPE — a DNS label — because that is a permanent fact and it
 * has to hold for the seed and for an importer too. This file holds the two
 * things a constraint should not: what a human's typing becomes, and which names
 * the platform keeps for itself.
 */

/**
 * Names a tenant may not have, because the platform needs them.
 *
 * NOT a CHECK constraint, deliberately — see `0034`'s header. The shape of a
 * hostname never changes; this list changes the first time somebody adds a
 * marketing subdomain, and each change should not be a migration.
 *
 * Three groups, and the third is the one that gets forgotten:
 *   1. What the platform serves itself — the marketing site, the app, the API.
 *   2. Infrastructure names that resolve whether we mean them to or not.
 *   3. Names that would let a tenant IMPERSONATE the platform. `security`,
 *      `billing` and `support` are here for that reason and not because
 *      anything is served there: a person who receives mail from
 *      `billing.veloexpense.com` has no way to know it is a customer's tenant.
 */
export const RESERVED_SLUGS: readonly string[] = [
  // 1. ours
  'www', 'app', 'api', 'admin', 'login', 'auth', 'signup', 'status', 'docs', 'help',
  // mcp-oauth: `mcp.<apex>` is the Claude connector's host (lib/mcpOauth/host.ts).
  'mcp', 'oauth',
  'static', 'assets', 'cdn', 'files', 'public',
  // 2. infrastructure
  'mail', 'smtp', 'imap', 'ns', 'ns1', 'ns2', 'mx', 'ftp', 'vpn', 'test', 'staging',
  'dev', 'demo-internal', 'localhost',
  // 3. impersonation
  'security', 'billing', 'support', 'account', 'accounts', 'payments', 'invoice',
  'velotech', 'veloexpense', 'velotechsystems',
];

/** `0034`'s constraint, in TypeScript, so a form can refuse before the database does. */
const DNS_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

export type SlugRefusal = 'EMPTY' | 'SHAPE' | 'RESERVED';

/**
 * Is this slug usable? Returns the reason it is not, so a caller can say
 * something specific — "that name is taken" and "that name is not allowed" are
 * different sentences and a boolean makes them the same one.
 */
export function checkSlug(slug: string): SlugRefusal | null {
  if (slug.trim() === '') return 'EMPTY';
  if (!DNS_LABEL.test(slug)) return 'SHAPE';
  if (RESERVED_SLUGS.includes(slug)) return 'RESERVED';
  return null;
}

/**
 * A DNS label from a company name.
 *
 * Deliberately lossy and deliberately not clever. "Acme Ltd." becomes
 * `acme-ltd`; "Société Générale" becomes `soci-t-g-n-rale` — which is ugly, and
 * is a suggestion the person can overwrite rather than the value they are stuck
 * with. The alternative was transliteration, which is a table of language
 * decisions this product has no business making from a company name: whether
 * "ö" is "o" or "oe" depends on whose company it is.
 *
 * Returns '' when nothing usable survives (a name in a non-Latin script), and
 * the caller asks the person to type one — which is the honest outcome, not a
 * fallback like `org-4f2a` that nobody recognises as theirs.
 */
export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize('NFKD')
    // Strip combining marks, so "café" is `cafe` rather than `caf-`. This much
    // Unicode is safe: it is removing accents from letters that keep their
    // identity, not deciding that "ß" is "ss".
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)
    // The slice can leave a trailing hyphen, which is not a valid label.
    .replace(/-+$/g, '');
  return DNS_LABEL.test(slug) ? slug : '';
}

/**
 * `acme`, then `acme-2`, `acme-3`… against a set of slugs already taken.
 *
 * The caller supplies the taken set from a query rather than this function
 * hitting the database: the UNIQUE constraint is what actually decides, and a
 * function that checked would invite a caller to trust its answer across the gap
 * between the check and the insert. This is for SUGGESTING a free one; losing
 * the race is still handled at the insert, by the constraint.
 */
export function nextFreeSlug(base: string, taken: ReadonlySet<string>): string {
  if (base === '') return '';
  if (!taken.has(base) && checkSlug(base) === null) return base;
  for (let n = 2; n < 1000; n += 1) {
    const suffix = `-${n}`;
    const candidate = `${base.slice(0, 63 - suffix.length).replace(/-+$/g, '')}${suffix}`;
    if (!taken.has(candidate) && checkSlug(candidate) === null) return candidate;
  }
  return '';
}
