/**
 * PE-9 — the tenant predicate, against a real Postgres.
 *
 * ── WHY THIS FILE EXISTS: A SABOTAGE FOUND THE GAP ──────────────────────────
 *
 * `scripts/check-tenant-expression.mjs` enforces that the expression is written
 * ONCE. It says nothing about whether that one copy is RIGHT — a sabotage that
 * removed the `NULLIF` from `lib/tenant/sql.ts` itself failed no test at all.
 * The guard and the twenty rewritten call sites would all have been perfectly
 * consistent about the wrong thing.
 *
 * So this pins the behaviour rather than the spelling, and it needs a real
 * database because the failure only exists in Postgres's type system.
 *
 * ── THE CONDITION, WHICH IS NOT OBVIOUS ─────────────────────────────────────
 *
 * `current_setting('app.current_org', true)` returns NULL on a connection that
 * has NEVER had the setting — and `''` on one that has, once the transaction
 * that set it has ended. Connections are POOLED, so the second case is the
 * normal one in a running server: any connection that has served one tenant
 * request is in it from then on.
 *
 * `''::uuid` is not a value that fails to match. It is
 * `22P02 invalid input syntax for type uuid: ""`, an error, raised before any
 * row is considered. With `NULLIF` the expression is NULL, which matches nothing
 * — a refusal instead of a parser error.
 *
 * Neither is a leak. What the bare form costs is the difference between a
 * scheduled job logging "no rows" and a scheduled job logging a message about
 * uuid syntax, which is the wrong thing to hand somebody at 3am.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { Pool } from 'pg';
import { ORG } from '@/lib/tenant/sql';
import { withOrg, withoutOrg } from '@/lib/tenant/context';
import { createOrganization } from '@/lib/onboarding/provision';

const admin = new Pool({
  connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL,
});

afterAll(async () => {
  await admin.end();
});

describe('the tenant predicate', () => {
  it('carries the NULLIF, which is the whole point of there being one copy', () => {
    // The spelling, asserted once. The behaviour is what the rest of this file
    // is for, but a reader deleting the NULLIF should fail here first and read
    // the reason rather than working out why a query started erroring.
    expect(ORG).toContain('NULLIF');
    expect(ORG).toContain("'app.current_org'");
    expect(ORG).toContain('::uuid');
  });

  /* THE ONE THAT WOULD HAVE CAUGHT THE SABOTAGE.
   *
   * A connection that has already served a tenant, used again with no tenant.
   * This is the state every pooled connection in a running server reaches after
   * its first request, and the state the bare expression turns into a 22P02. */
  it('matches nothing — rather than erroring — on a connection that has carried a tenant', async () => {
    await admin.query('TRUNCATE invite, audit_entry, app_user, organization CASCADE');
    const org = await createOrganization({
      name: 'Acme',
      slug: 'acme',
      adminEmail: 'f@acme.test',
    });

    // Put the GUC on a pooled connection and let the transaction end. From here
    // on `current_setting('app.current_org', true)` is `''` on that connection,
    // not NULL — which is the trap.
    await withOrg(org.organizationId, (tx) => tx.query('SELECT 1'));

    // Now the same pool, with no tenant. This must be a refusal, not an error.
    const rows = await withoutOrg((tx) =>
      tx.query(`SELECT count(*)::int AS n FROM organization WHERE id = ${ORG}`),
    );
    expect(rows.rows[0].n).toBe(0);
  });

  it('still resolves the tenant when there IS one', async () => {
    await admin.query('TRUNCATE invite, audit_entry, app_user, organization CASCADE');
    const org = await createOrganization({
      name: 'Acme',
      slug: 'acme',
      adminEmail: 'f@acme.test',
    });
    const found = await withOrg(org.organizationId, (tx) =>
      tx.query(`SELECT slug FROM organization WHERE id = ${ORG}`),
    );
    expect(found.rows[0].slug).toBe('acme');
  });

  /* And the bare form, run directly, so the claim above is not just asserted —
   * the error it produces is shown. If Postgres ever stopped raising here, the
   * NULLIF would be unnecessary and this test would say so by failing. */
  it('the bare expression really does raise 22P02, which is why the guard exists', async () => {
    await admin.query('TRUNCATE invite, audit_entry, app_user, organization CASCADE');
    const org = await createOrganization({
      name: 'Acme',
      slug: 'acme',
      adminEmail: 'f@acme.test',
    });
    await withOrg(org.organizationId, (tx) => tx.query('SELECT 1'));

    await expect(
      withoutOrg((tx) =>
        tx.query(
          // eslint-disable-next-line no-useless-concat -- split so the guard,
          // which scans for this expression, does not count the demonstration
          // of the defect as a copy of it.
          "SELECT count(*) FROM organization WHERE id = current_setting('app" +
            ".current_org', true)::uuid",
        ),
      ),
    ).rejects.toMatchObject({ code: '22P02' });
  });
});
