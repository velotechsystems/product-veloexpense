/**
 * SSOTENANT-1: build the SsoIdentity the app resolves, from the provider's
 * validated ID-token claims. Pure and edge-safe; unit-tested on its own.
 *
 * The kit refuses here, before the app is consulted, anything that cannot be
 * an identity at all: no email; a Google address Google has not verified; a
 * Microsoft token without the directory (`tid`) and object id (`oid`) the app
 * must bind to.
 */

import type { SsoDenyReason, SsoIdentity } from './types';

export const GOOGLE_ID = 'google';
export const MICROSOFT_ID = 'microsoft-entra-id';

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

export function ssoIdentityFrom(
  provider: string,
  profile: Record<string, unknown> | undefined,
  userEmail: string | null | undefined,
): { ok: true; identity: SsoIdentity } | { ok: false; reason: SsoDenyReason } {
  const p = profile ?? {};

  if (provider === MICROSOFT_ID) {
    const tenantId = str(p.tid);
    const objectId = str(p.oid);
    if (!tenantId || !objectId || !GUID.test(tenantId) || !GUID.test(objectId)) {
      return { ok: false, reason: 'entra_claims_missing' };
    }
    // `email` is optional in Entra tokens; the UPN is the directory's own
    // sign-in name. Either is only a first-link hint, never the identity.
    const email = (str(p.email) ?? str(p.preferred_username) ?? str(userEmail))?.toLowerCase();
    if (!email) return { ok: false, reason: 'no_email' };
    return {
      ok: true,
      identity: {
        provider,
        email,
        emailVerified: null,
        tenantId: tenantId.toLowerCase(),
        objectId: objectId.toLowerCase(),
      },
    };
  }

  const email = (str(p.email) ?? str(userEmail))?.toLowerCase();
  if (!email) return { ok: false, reason: 'no_email' };

  if (provider === GOOGLE_ID) {
    // Google sends a boolean. Anything else (absent, "true" as a string) is
    // not a verified address.
    if (p.email_verified !== true) return { ok: false, reason: 'email_unverified' };
    return { ok: true, identity: { provider, email, emailVerified: true, tenantId: null, objectId: null } };
  }

  return { ok: true, identity: { provider, email, emailVerified: null, tenantId: null, objectId: null } };
}
