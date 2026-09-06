/**
 * VX5-5 — the mismatch guard, against a real database.
 *
 * The claim being tested is the one the whole design rests on: **the host never
 * decides which tenant is read.** It has to agree, and a request where it does
 * not is refused BEFORE any row — not redirected, and not quietly served from
 * the session's own tenant at somebody else's address.
 *
 * `withCurrentOrg` reads the session through `auth()`, which needs a request
 * context this file does not have. So the guard's logic is exercised through the
 * same statement it uses, with the two inputs supplied directly; the wiring —
 * that the middleware really does stamp the header and the layout really does
 * render the refusal — is `e2e/host-tenancy.spec.ts`'s job, on a real browser
 * against real subdomains.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { Pool } from 'pg';
import { withOrg } from '@/lib/tenant/context';
import { createOrganization } from '@/lib/onboarding/provision';
import { HostMismatchError, candidateSlugFromHost } from '@/lib/tenant/host';
import { originForTenant } from '@/lib/notifications/email';

const admin = new Pool({
  connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL,
});

let acme: string;
let globex: string;

beforeEach(async () => {
  await admin.query('TRUNCATE invite, audit_entry, app_user, organization CASCADE');
  acme = (
    await createOrganization({ name: 'Acme', slug: 'acme', adminEmail: 'f@acme.test' })
  ).organizationId;
  globex = (
    await createOrganization({ name: 'Globex', slug: 'globex', adminEmail: 'f@globex.test' })
  ).organizationId;
});

afterAll(async () => {
  await admin.end();
});

/** The comparison `withCurrentOrg` makes, with the session supplied directly. */
const APEX = 'veloexpense.app';

async function decide(sessionOrgId: string, host: string): Promise<'ALLOWED' | HostMismatchError> {
  const hostSlug = candidateSlugFromHost(host, APEX);
  return withOrg(sessionOrgId, async (tx) => {
    if (hostSlug === null) return 'ALLOWED';
    const r = await tx.query('SELECT slug FROM organization WHERE id = $1', [sessionOrgId]);
    const sessionSlug = (r.rows[0]?.slug as string | undefined) ?? '';
    return sessionSlug === hostSlug ? 'ALLOWED' : new HostMismatchError(hostSlug, sessionSlug);
  });
}

describe('a tenant address and the session that arrives at it', () => {
  it('agrees, and the request proceeds', async () => {
    expect(await decide(acme, 'acme.veloexpense.app')).toBe('ALLOWED');
    expect(await decide(acme, 'acme.veloexpense.app:3000')).toBe('ALLOWED');
    expect(await decide(globex, 'globex.veloexpense.app')).toBe('ALLOWED');
  });

  it('REFUSES another tenant’s address, rather than serving your own data there', async () => {
    const refused = await decide(acme, 'globex.veloexpense.app');
    expect(refused).toBeInstanceOf(HostMismatchError);
    expect((refused as HostMismatchError).hostSlug).toBe('globex');
    expect((refused as HostMismatchError).sessionSlug).toBe('acme');
    // A catalogued message, so the refusal is a sentence rather than the generic.
    expect((refused as HostMismatchError).userMessage).toEqual({ code: 'WRONG_TENANT_HOST' });
  });

  it('refuses a tenant address that names NOBODY, rather than falling back', async () => {
    // `typo.veloexpense.app` is not an organization. The safe answer is still a
    // refusal: a made-up address must not quietly serve the session's own tenant,
    // or every hostname would be a valid address for everybody.
    const refused = await decide(acme, 'typo.veloexpense.app');
    expect(refused).toBeInstanceOf(HostMismatchError);
    expect((refused as HostMismatchError).hostSlug).toBe('typo');
  });

  it('allows the apex, which is where signup and the generic sign-in live', async () => {
    for (const host of ['veloexpense.app', 'localhost:3000', '127.0.0.1', 'www.veloexpense.app']) {
      expect(await decide(acme, host), host).toBe('ALLOWED');
    }
  });

  /* The message names NEITHER organization. The reader is signed in to one of
   * them, so naming that one would be safe — but this renders on a host somebody
   * else typed, and confirming that `acme` is a customer of ours to whoever
   * typed it is an oracle the page has no reason to be. */
  it('says nothing about either organization in the sentence a person reads', async () => {
    const { renderUserMessage } = await import('@/lib/i18n/catalog/errors');
    const { DEFAULT_LOCALE } = await import('@/lib/i18n/locales');
    const text = renderUserMessage('WRONG_TENANT_HOST', DEFAULT_LOCALE);
    expect(text).not.toContain('acme');
    expect(text).not.toContain('globex');
    expect(text.length).toBeGreaterThan(20);
  });
});

describe('the origin a tenant’s email links to', () => {
  const withEnv = async <T>(env: Record<string, string | undefined>, fn: () => T): Promise<T> => {
    const before: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(env)) {
      before[k] = process.env[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try {
      return fn();
    } finally {
      for (const [k, v] of Object.entries(before)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  };

  it('is the tenant’s subdomain when the deployment serves them', async () => {
    const origin = await withEnv(
      { APP_URL: 'https://veloexpense.app', AUTH_COOKIE_DOMAIN: '.veloexpense.app' },
      () => originForTenant('acme'),
    );
    expect(origin).toBe('https://acme.veloexpense.app');
  });

  it('keeps the scheme and port, which is what makes it testable at all', async () => {
    const origin = await withEnv(
      { APP_URL: 'http://velo.test:3000', AUTH_COOKIE_DOMAIN: 'velo.test' },
      () => originForTenant('demo'),
    );
    expect(origin).toBe('http://demo.velo.test:3000');
  });

  /* GATED ON THE COOKIE DOMAIN, not on a flag of its own. A deployment that has
   * not set it cannot hold a session on a subdomain at all — the cookie is
   * host-only — so mailing somebody a subdomain link would send them somewhere
   * that provably does not work. One flag, two behaviours that must move
   * together. */
  it('stays on the apex when the deployment cannot hold a session on a subdomain', async () => {
    const origin = await withEnv(
      { APP_URL: 'https://veloexpense.app', AUTH_COOKIE_DOMAIN: undefined },
      () => originForTenant('acme'),
    );
    expect(origin).toBe('https://veloexpense.app');
  });

  it('refuses to invent a host when the apex and the cookie domain disagree', async () => {
    const origin = await withEnv(
      { APP_URL: 'https://app.example.com', AUTH_COOKIE_DOMAIN: '.veloexpense.app' },
      () => originForTenant('acme'),
    );
    // `acme.veloexpense.app` would resolve to nothing here — somebody has
    // configured the two against each other, and the apex is the honest answer.
    expect(origin).toBe('https://app.example.com');
  });

  it('is null when there is no origin at all, as NT-14 requires', async () => {
    const origin = await withEnv(
      { APP_URL: undefined, AUTH_URL: undefined, NEXTAUTH_URL: undefined, AUTH_COOKIE_DOMAIN: 'velo.test' },
      () => originForTenant('acme'),
    );
    expect(origin).toBeNull();
  });
});
