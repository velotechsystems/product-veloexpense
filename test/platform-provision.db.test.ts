/**
 * VX5-20 part 2 — the platform standing a tenant up, against a real Postgres.
 *
 * What has to be proved here is what a mock of `createOrganization` could not:
 *
 *   1. Idempotency is a CONSTRAINT, not a check. `0040`'s UNIQUE index refuses a
 *      second tenant for one Account even when the read-then-write check is
 *      bypassed entirely — which is the whole argument for the migration.
 *   2. Two concurrent provisions for one Account yield ONE tenant, because that
 *      is the case a check cannot cover and the case an orchestrator retry
 *      actually produces.
 *   3. A platform-provisioned tenant is a COMPLETE tenant — admin, starter
 *      categories, genesis audit row — because it goes through the same
 *      `createOrganization` self-serve signup uses rather than a second path.
 *   4. `account_id` is stamped in the INSERT, so there is no window in which the
 *      tenant exists and the platform cannot find it.
 *   5. It does NOT adopt an existing tenant that happens to share an admin
 *      email. That is the account-takeover primitive the header refuses.
 *
 * Own org slugs (`plat-*`), and this file TRUNCATEs like every other db suite.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { Pool } from 'pg';
import { createOrganization } from '@/lib/onboarding/provision';
import {
  PlatformProvisionError,
  provisionTenant,
  type PlatformProvisionInput,
  type PlatformProvisionResult,
} from '@/lib/platform/provision';
import { withOrg } from '@/lib/tenant/context';
import { verifyChain } from '@/lib/audit/verify';

const admin = new Pool({
  connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL,
});

const ACCOUNT = '3f1c9b52-0000-4000-8000-0000000000a1';
const OTHER_ACCOUNT = '3f1c9b52-0000-4000-8000-0000000000a2';

function payload(over: Partial<PlatformProvisionInput> = {}): PlatformProvisionInput {
  return {
    accountId: ACCOUNT,
    plan: 'veloexpense-team-monthly',
    adminEmail: 'ada@plat.test',
    adminName: 'Ada Admin',
    companyName: 'Platform Co',
    slug: 'plat-co',
    ...over,
  };
}

beforeEach(async () => {
  await admin.query('TRUNCATE app_user, organization CASCADE');
});

afterAll(async () => {
  await admin.query('TRUNCATE app_user, organization CASCADE');
  await admin.end();
});

describe('provisionTenant', () => {
  it('creates a tenant and stamps the Account on it', async () => {
    const result = await provisionTenant(payload());

    expect(result.status).toBe('provisioned');
    expect(result.slug).toBe('plat-co');

    const org = await admin.query(
      'SELECT slug, name, status, account_id FROM organization WHERE id = $1',
      [result.tenantId],
    );
    expect(org.rows[0]).toMatchObject({
      slug: 'plat-co',
      name: 'Platform Co',
      status: 'active',
      account_id: ACCOUNT,
    });
  });

  it('hands over a tenant that can actually be used', async () => {
    // The reason this delegates to `createOrganization` rather than writing its
    // own inserts: a second path is a second place that decides what a new
    // tenant arrives holding, and VX5-4 already decided.
    const { tenantId } = await provisionTenant(payload());

    const rows = await withOrg(tenantId, async (tx) => {
      const admins = await tx.query(`SELECT email, role FROM app_user`);
      const cats = await tx.query(`SELECT count(*)::int AS n FROM expense_category`);
      return { admins: admins.rows, categories: cats.rows[0].n as number };
    });

    expect(rows.admins).toEqual([{ email: 'ada@plat.test', role: 'ADMIN' }]);
    expect(rows.categories).toBeGreaterThan(0);
  });

  it('writes a genesis audit row naming the Account, and the chain verifies', async () => {
    const { tenantId } = await provisionTenant(payload());

    const { entries, ok } = await withOrg(tenantId, async (tx) => {
      const r = await tx.query(
        `SELECT action, details FROM audit_entry ORDER BY sequence ASC`,
      );
      return {
        entries: r.rows as { action: string; details: Record<string, unknown> }[],
        ok: (await verifyChain(tx)).ok,
      };
    });

    expect(ok).toBe(true);
    expect(entries[0].action).toBe('ORGANIZATION_CREATED');
    // An auditor asking "where did this tenant come from" gets the answer on the
    // row that says where everything came from, with no second action and no join.
    expect(entries[0].details.account_id).toBe(ACCOUNT);
  });

  it('leaves account_id NULL for a self-serve signup', async () => {
    // The absence is meaningful: `entitlements.ts` falls back to the email
    // domain and `seats.ts` skips. An invented account id would look answered.
    const { organizationId } = await createOrganization({
      name: 'Front Door Co',
      slug: 'plat-frontdoor',
      adminEmail: 'self@plat.test',
    });
    const r = await admin.query('SELECT account_id FROM organization WHERE id = $1', [
      organizationId,
    ]);
    expect(r.rows[0].account_id).toBeNull();
  });
});

describe('idempotency', () => {
  it('a retry returns the same tenant and does not create a second', async () => {
    const first = await provisionTenant(payload());
    const second = await provisionTenant(payload());

    expect(second.status).toBe('already_exists');
    expect(second.tenantId).toBe(first.tenantId);
    expect(second.slug).toBe(first.slug);

    const n = await admin.query('SELECT count(*)::int AS n FROM organization');
    expect(n.rows[0].n).toBe(1);
  });

  it('is idempotent on the ACCOUNT, not on the idempotency key or the slug', async () => {
    // Two different requests for one Account — different company name, different
    // requested slug, different admin — still yield one tenant. If this ever
    // returns `provisioned` twice, idempotency has been re-keyed onto something
    // the platform controls per-call, and the Account owns two tenants.
    const first = await provisionTenant(payload());
    const second = await provisionTenant(
      payload({ companyName: 'Renamed Co', slug: 'plat-renamed', adminEmail: 'bob@plat.test' }),
    );

    expect(second.status).toBe('already_exists');
    expect(second.tenantId).toBe(first.tenantId);
    // And the existing tenant is NOT mutated by the second call's fields — a
    // provision is not an update, and treating it as one would let a replayed
    // message rename a live tenant.
    const org = await admin.query('SELECT name, slug FROM organization WHERE id = $1', [
      first.tenantId,
    ]);
    expect(org.rows[0]).toMatchObject({ name: 'Platform Co', slug: 'plat-co' });
  });

  it('the UNIQUE index refuses a second tenant for one Account even with the check bypassed', async () => {
    // The migration's own test. `provisionTenant` would never do this; a future
    // caller, a data fix, or a bug that skips the SELECT would, and the database
    // is what has to say no.
    await provisionTenant(payload());
    await expect(
      admin.query(
        `INSERT INTO organization (slug, name, status, account_id)
         VALUES ('plat-sneak', 'Sneak Co', 'active', $1)`,
        [ACCOUNT],
      ),
    ).rejects.toMatchObject({ code: '23505', constraint: 'organization_by_account_idx' });
  });

  /**
   * TWO CONCURRENT PROVISIONS RESOLVE THROUGH TWO DIFFERENT CONSTRAINTS, and
   * separating them is not pedantry — a single test covered only one of the two
   * branches that absorb the race, and it looked like it covered both.
   *
   * Both calls read `takenSlugs` before either inserts. So:
   *
   *   · SAME requested slug → both pick the same candidate, and the loser trips
   *     the SLUG UNIQUE first. `createOrganization` turns that into
   *     `SLUG_TAKEN`, which is indistinguishable from somebody else's tenant
   *     taking the name — hence the re-check of the Account before reporting it.
   *   · DIFFERENT requested slugs → no slug conflict, and the loser trips
   *     `0040`'s ACCOUNT unique index as 23505.
   *
   * The first test was written with the same payload twice and passed with the
   * account-conflict branch stubbed out to `false`, which is how the gap was
   * found: the sabotage came back green, so the assertion was not measuring what
   * its name claimed.
   */
  it('two concurrent provisions with the SAME slug yield one tenant (the slug constraint absorbs it)', async () => {
    const results = await Promise.allSettled([
      provisionTenant(payload()),
      provisionTenant(payload()),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    expect(fulfilled).toHaveLength(2);

    const values = fulfilled.map(
      (r) => (r as PromiseFulfilledResult<PlatformProvisionResult>).value,
    );
    const ids = new Set(values.map((v) => v.tenantId));
    expect(ids.size).toBe(1);
    expect(values.filter((v) => v.status === 'provisioned')).toHaveLength(1);
    expect(values.filter((v) => v.status === 'already_exists')).toHaveLength(1);

    const n = await admin.query('SELECT count(*)::int AS n FROM organization');
    expect(n.rows[0].n).toBe(1);
  });

  it('two concurrent provisions with DIFFERENT slugs yield one tenant (the account index absorbs it)', async () => {
    // This is the one that exercises `0040`. Different slugs mean neither call
    // trips the slug constraint, so the loser reaches the ACCOUNT unique index —
    // the only thing standing between an orchestrator retry and one Account
    // owning two tenants.
    const results = await Promise.allSettled([
      provisionTenant(payload({ slug: 'plat-alpha' })),
      provisionTenant(payload({ slug: 'plat-beta' })),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    expect(fulfilled, JSON.stringify(results)).toHaveLength(2);

    const values = fulfilled.map(
      (r) => (r as PromiseFulfilledResult<PlatformProvisionResult>).value,
    );
    expect(new Set(values.map((v) => v.tenantId)).size).toBe(1);
    expect(values.filter((v) => v.status === 'provisioned')).toHaveLength(1);
    expect(values.filter((v) => v.status === 'already_exists')).toHaveLength(1);

    // Both winners report the SAME slug — whichever one actually landed. A caller
    // that recorded its own request would be holding a hostname nobody serves.
    expect(new Set(values.map((v) => v.slug)).size).toBe(1);

    const n = await admin.query('SELECT count(*)::int AS n FROM organization');
    expect(n.rows[0].n).toBe(1);
  });

  it('never adopts an existing tenant that shares the admin email', async () => {
    // Matching on email would be the obvious "helpful" link and it is an
    // account-takeover primitive: anybody who can make the platform provision
    // with a chosen adminEmail would acquire that tenant's data.
    const self = await createOrganization({
      name: 'Front Door Co',
      slug: 'plat-frontdoor',
      adminEmail: 'ada@plat.test',
    });

    const result = await provisionTenant(payload({ adminEmail: 'ada@plat.test' }));

    expect(result.status).toBe('provisioned');
    expect(result.tenantId).not.toBe(self.organizationId);
    const r = await admin.query('SELECT account_id FROM organization WHERE id = $1', [
      self.organizationId,
    ]);
    expect(r.rows[0].account_id).toBeNull();
  });
});

describe('the slug resolves rather than refusing', () => {
  it('takes the next free slug when the requested one is in use', async () => {
    await createOrganization({
      name: 'Squatter',
      slug: 'plat-co',
      adminEmail: 'squat@plat.test',
    });

    const result = await provisionTenant(payload());

    // The platform records the truth rather than its request. VeloLedger returns
    // 400 here, which leaves the orchestrator guessing at a free name it cannot
    // see.
    expect(result.status).toBe('provisioned');
    expect(result.slug).toBe('plat-co-2');
  });

  it('normalises a slug the way signup does', async () => {
    const result = await provisionTenant(payload({ slug: 'Plat Co Ltd.' }));
    expect(result.slug).toBe('plat-co-ltd');
  });

  it('refuses a RESERVED slug instead of renaming it', async () => {
    // A collision is resolved; a caller bug is reported. Quietly provisioning
    // `admin-2` for a request for `admin` would hide the bug in the orchestrator.
    await expect(provisionTenant(payload({ slug: 'admin' }))).rejects.toBeInstanceOf(
      PlatformProvisionError,
    );
    await expect(provisionTenant(payload({ slug: 'admin' }))).rejects.toMatchObject({
      code: 'SLUG_UNUSABLE',
    });
    const n = await admin.query('SELECT count(*)::int AS n FROM organization');
    expect(n.rows[0].n).toBe(0);
  });

  it('refuses a slug that normalises to nothing', async () => {
    await expect(provisionTenant(payload({ slug: '---' }))).rejects.toMatchObject({
      code: 'SLUG_UNUSABLE',
    });
  });
});

describe('input the platform got wrong', () => {
  it('refuses a missing company name with the code createOrganization already has', async () => {
    await expect(provisionTenant(payload({ companyName: '   ' }))).rejects.toMatchObject({
      code: 'NAME_REQUIRED',
    });
  });

  it('refuses a missing admin email', async () => {
    await expect(provisionTenant(payload({ adminEmail: '  ' }))).rejects.toMatchObject({
      code: 'EMAIL_REQUIRED',
    });
  });

  it('two accounts can both be provisioned', async () => {
    const a = await provisionTenant(payload());
    const b = await provisionTenant(
      payload({ accountId: OTHER_ACCOUNT, slug: 'plat-two', companyName: 'Two Co' }),
    );
    expect(a.tenantId).not.toBe(b.tenantId);
    expect(b.status).toBe('provisioned');
  });
});
