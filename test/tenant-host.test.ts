/**
 * VX5-5 — the host parser. Pure, so this needs no database and no server.
 *
 * The parser's answer is a CANDIDATE, never a fact — `lib/tenant/request.ts`
 * asks the database whether it names a real organization. So what is asserted
 * here is the shape of the guess and, more importantly, the cases where it must
 * refuse to guess at all.
 *
 * The apex is passed explicitly to every case below. The first design took none
 * and read the first label of any multi-label host; the e2e refuted it on its
 * first run, because `velo.test`'s own first label was then a tenant called
 * `velo` and the apex refused every signed-in request. `lib/tenant/host.ts`'s
 * header has the correction.
 */
import { describe, it, expect } from 'vitest';
import { candidateSlugFromHost, tenantApex } from '@/lib/tenant/host';
import { RESERVED_SLUGS, checkSlug } from '@/lib/onboarding/slug';

const APEX = 'veloexpense.app';

describe('reading a tenant out of a Host header', () => {
  it('takes the first label of a multi-label host', () => {
    expect(candidateSlugFromHost('acme.veloexpense.app', APEX)).toBe('acme');
    expect(candidateSlugFromHost('acme.veloexpense.app:3000', APEX)).toBe('acme');
    expect(candidateSlugFromHost('ACME.VeloExpense.App', APEX)).toBe('acme');
    expect(candidateSlugFromHost('  acme.veloexpense.app  ', APEX)).toBe('acme');
    // A different apex, which is the whole point of it being configured.
    expect(candidateSlugFromHost('demo.velo.test:3000', 'velo.test')).toBe('demo');
    // EXACTLY one label under the apex. A deeper name is not a tenant of ours —
    // reading `acme` out of `acme.staging.veloexpense.app` would mean a staging
    // host silently answering for a production tenant.
    expect(candidateSlugFromHost('acme.staging.veloexpense.app', APEX)).toBeNull();
    expect(candidateSlugFromHost('acme.staging.veloexpense.app', 'staging.veloexpense.app')).toBe('acme');
  });

  it('refuses an apex, which is what makes the marketing site not a tenant', () => {
    expect(candidateSlugFromHost('veloexpense.app', APEX)).toBeNull();
    expect(candidateSlugFromHost('veloexpense.app:3000', APEX)).toBeNull();
    expect(candidateSlugFromHost('velo.test', 'velo.test')).toBeNull();
    // THE CASE THE E2E FOUND. An apex whose own first label is not reserved must
    // still be the apex — `expenses` here is not a customer.
    expect(candidateSlugFromHost('expenses.velotech.ai', 'expenses.velotech.ai')).toBeNull();
  });

  it('refuses an address, so a health check is never a tenant', () => {
    for (const host of ['127.0.0.1', '127.0.0.1:3000', '10.0.1.42', '[::1]:3000', '::1']) {
      expect(candidateSlugFromHost(host, APEX), host).toBeNull();
    }
  });

  it('refuses nothing at all', () => {
    for (const host of [null, undefined, '', '   ', ':3000']) {
      expect(candidateSlugFromHost(host, APEX), String(host)).toBeNull();
    }
  });

  it('refuses a first label that is not a DNS label', () => {
    for (const host of [
      '-acme.veloexpense.app',
      'acme-.veloexpense.app',
      'ac me.veloexpense.app',
      'ac_me.veloexpense.app',
      `${'a'.repeat(64)}.veloexpense.app`,
    ]) {
      expect(candidateSlugFromHost(host, APEX), host).toBeNull();
    }
  });

  /* THE ONE THAT KEEPS THE APEX SAFE. Our own hostnames start with labels a
   * customer must never be able to own, or `veloexpense.app` itself would be
   * read as a tenant called `veloexpense`. */
  it('refuses the labels our own addresses start with', () => {
    for (const label of ['www', 'app', 'api', 'localhost', 'veloexpense', 'velotech']) {
      expect(candidateSlugFromHost(`${label}.veloexpense.app`, APEX), label).toBeNull();
    }
  });

  /* The list in `lib/tenant/host.ts` is a DUPLICATE — that module cannot import
   * from `lib/onboarding/slug.ts`, which pulls `pg` into the edge bundle. A
   * duplicate this codebase has been bitten by three times (UD-9), so it is
   * pinned: every label it refuses must be one no customer could hold anyway. A
   * label refused here but AVAILABLE as a slug would be a tenant that could
   * never be reached at its own address. */
  it('never refuses a label a customer could actually own', () => {
    for (const label of ['www', 'app', 'api', 'localhost', 'veloexpense', 'velotech']) {
      expect(RESERVED_SLUGS, `${label} must be reserved in slug.ts too`).toContain(label);
      expect(checkSlug(label), `${label} must be unusable as a slug`).toBe('RESERVED');
    }
  });

  /* And the converse is deliberately NOT asserted: `slug.ts` reserves many more
   * labels than this module refuses (`billing`, `support`, `mail`…). Those are
   * about impersonation and infrastructure, not about our own hostnames, and a
   * host that starts with one of them simply resolves to no organization —
   * which is the same outcome by a shorter route. */
  it('leaves other reserved slugs to the database', () => {
    expect(candidateSlugFromHost('billing.veloexpense.app', APEX)).toBe('billing');
    expect(candidateSlugFromHost('support.veloexpense.app', APEX)).toBe('support');
  });

  /* NO APEX, NO TENANT HOSTS. A deployment that has not set `AUTH_COOKIE_DOMAIN`
   * cannot hold a session on a subdomain at all — the cookie is host-only — so
   * the honest answer is that no host names a tenant. This is also what keeps
   * every existing deployment and the rest of the e2e suite behaving exactly as
   * before: on `localhost` with the variable unset, nothing changes. */
  it('names no tenant at all when the deployment serves none', () => {
    for (const host of ['acme.veloexpense.app', 'demo.localhost:3000', 'anything.at.all']) {
      expect(candidateSlugFromHost(host, ''), host).toBeNull();
    }
  });

  it('reads the apex from the one variable that makes subdomains work', () => {
    const before = process.env.AUTH_COOKIE_DOMAIN;
    try {
      delete process.env.AUTH_COOKIE_DOMAIN;
      expect(tenantApex()).toBe('');
      expect(candidateSlugFromHost('acme.veloexpense.app')).toBeNull();

      process.env.AUTH_COOKIE_DOMAIN = '.VeloExpense.app';
      // Leading dot stripped and lowercased — a cookie domain is written with the
      // dot and a host is not.
      expect(tenantApex()).toBe('veloexpense.app');
      expect(candidateSlugFromHost('acme.veloexpense.app')).toBe('acme');
    } finally {
      if (before === undefined) delete process.env.AUTH_COOKIE_DOMAIN;
      else process.env.AUTH_COOKIE_DOMAIN = before;
    }
  });
});
