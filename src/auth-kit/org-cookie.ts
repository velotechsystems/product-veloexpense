/**
 * Tenant resolution for OAuth: providers return an email, not an org, so the
 * login page stores the org slug in a short-lived cookie BEFORE redirecting to
 * Google/Microsoft; the signIn callback reads it to resolve (org, email).
 * HttpOnly + Secure + Lax, 10-minute TTL — it only needs to survive the
 * round-trip to the provider.
 */

const TTL_SECONDS = 600;

export const orgCookieName = (productKey: string): string => `${productKey}.sso-org`;

/** Serialized Set-Cookie value (framework-agnostic; apps set it via their response API). */
export function orgCookieValue(productKey: string, orgSlug: string): string {
  const slug = orgSlug.trim().toLowerCase();
  return `${orgCookieName(productKey)}=${encodeURIComponent(slug)}; Path=/; Max-Age=${TTL_SECONDS}; HttpOnly; Secure; SameSite=Lax`;
}

export function clearOrgCookieValue(productKey: string): string {
  return `${orgCookieName(productKey)}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

/** Parse the slug out of a Cookie header (server-side use in callbacks). */
export function readOrgSlug(productKey: string, cookieHeader: string | null | undefined): string | null {
  if (!cookieHeader) return null;
  const name = orgCookieName(productKey);
  for (const part of cookieHeader.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) {
      const v = decodeURIComponent(rest.join('=')).trim().toLowerCase();
      return /^[a-z0-9][a-z0-9-]{0,62}$/.test(v) ? v : null;
    }
  }
  return null;
}
