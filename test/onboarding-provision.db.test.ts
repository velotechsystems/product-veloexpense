/**
 * VX5-1 — creating an organization, against a real Postgres.
 *
 * This suite CANNOT use the usual `withOrg` fixture, and that is the point of the
 * ticket: the thing under test is the one write that has no tenant to start in.
 * What has to be proved here is exactly what a mock could not:
 *
 *   1. It is ATOMIC. A failure after the organization insert leaves NO
 *      organization — not an empty tenant nobody can enter, invite into, or
 *      delete, whose slug is taken forever.
 *   2. The `app_user` insert really is a tenant-scoped write under FORCE RLS,
 *      succeeding only because the GUC was set mid-transaction to the org it
 *      belongs to.
 *   3. `0034`'s constraint refuses a bad slug even when the code path is
 *      bypassed — which is the whole argument for it being in the schema.
 *   4. The audit chain's genesis row is the tenant coming into being.
 *
 * Own org slugs (`prov-*`), and this file TRUNCATEs like every other db suite.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { Pool } from 'pg';
import { createOrganization, ProvisionError, takenSlugs } from '@/lib/onboarding/provision';
import { withOrg } from '@/lib/tenant/context';
import { verifyChain } from '@/lib/audit/verify';

const admin = new Pool({
  connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL,
});

const NEW = {
  name: 'Provision Co',
  slug: 'prov-co',
  adminEmail: 'ada@prov.test',
  adminName: 'Ada Admin',
};

beforeEach(async () => {
  await admin.query('TRUNCATE app_user, organization CASCADE');
});

afterAll(async () => {
  await admin.query('TRUNCATE app_user, organization CASCADE');
  await admin.end();
});

const orgRow = async (slug: string) =>
  (await admin.query('SELECT * FROM organization WHERE slug = $1', [slug])).rows[0];

describe('createOrganization', () => {
  it('creates the tenant and its first administrator in one go', async () => {
    const result = await createOrganization(NEW);

    const org = await orgRow('prov-co');
    expect(org.name).toBe('Provision Co');
    expect(org.status).toBe('active');
    expect(result.organizationId).toBe(org.id);

    const users = await admin.query('SELECT * FROM app_user WHERE organization_id = $1', [org.id]);
    expect(users.rows).toHaveLength(1);
    expect(users.rows[0].email).toBe('ada@prov.test');
    expect(users.rows[0].display_name).toBe('Ada Admin');
    // ADMIN by construction, not by argument: an organization whose first user is
    // an EMPLOYEE is one nobody can administer, invite into or configure.
    // w4-10b: System Administrator, the tenant's own row (0068).
    expect(users.rows[0].role_id).toBe('019e3000-0000-7000-8000-000000000001');
    expect(result.adminUserId).toBe(users.rows[0].id);
  });

  /* w6-00 (d88) — and travel works from the moment the module is switched on: its own
   * category list, mapped onto the starter expense categories where they match, and a
   * published travel approval flow (0077's `seed_travel_defaults`, the copy the migration
   * used for the tenants that predate it). */
  it("gives the tenant travel's categories and its travel approval flow", async () => {
    const { organizationId } = await createOrganization(NEW);
    const travel = await withOrg(organizationId, async (tx) => ({
      categories: (
        await tx.query(
          `SELECT tc.code, tc.line_kind, ec.code AS expense_code
             FROM travel_category tc LEFT JOIN expense_category ec ON ec.id = tc.expense_category_id
            ORDER BY tc.sort_order`,
        )
      ).rows,
      flow: (
        await tx.query(
          `SELECT w.subject_type, w.is_default, v.status, v.graph
             FROM approval_workflow w JOIN approval_workflow_version v ON v.id = w.current_version_id
            WHERE w.key = 'travel-request-default'`,
        )
      ).rows,
    }));
    expect(travel.categories).toHaveLength(15);
    expect(travel.categories.slice(0, 3)).toEqual([
      { code: 'travelAirfare', line_kind: 'AIRFARE', expense_code: 'travel_air' },
      { code: 'travelHotel', line_kind: 'LODGING', expense_code: 'travel_lodging' },
      { code: 'travelMeals', line_kind: 'STANDARD', expense_code: 'meals' },
    ]);
    // A code with no counterpart among the starter six stays unmapped rather than guessed.
    expect(travel.categories.find((c) => c.code === 'travelMileage')?.expense_code).toBeNull();
    expect(travel.flow).toHaveLength(1);
    expect(travel.flow[0]).toMatchObject({ subject_type: 'TRAVEL_REQUEST', is_default: true, status: 'PUBLISHED' });
    expect(travel.flow[0].graph.nodes[1].approver).toEqual({
      kind: 'manager',
      fallback: { kind: 'role', roleId: '019e3000-0000-7000-8000-000000000001' },
    });
  });

  /**
   * THE REASON THIS IS ONE TRANSACTION, and the test that says so.
   *
   * The obvious shape — `withoutOrg` to insert the organization, then `withOrg`
   * to insert the administrator — leaves an ORGANIZATION WITH NO USERS whenever
   * the second one fails. Nobody can sign into it (`resolveSsoUser` finds no
   * row), nobody can be invited into it (that needs an administrator), and its
   * slug is taken forever.
   *
   * THE FAULT IS INJECTED IN THE DATABASE, which is where such a failure would
   * actually come from. The first version of this test tried to force it with a
   * 300-character email and did not fail at all — `app_user.email` is unbounded
   * `text` — so it asserted a rollback that never happened, and passed. A
   * temporary CHECK is the honest version: the organization insert succeeds, the
   * administrator insert does not, and what is left behind is the whole subject.
   */
  it('leaves NO organization behind when the administrator cannot be written', async () => {
    await admin.query(
      `ALTER TABLE app_user ADD CONSTRAINT app_user_provision_fault
         CHECK (email <> 'doomed@prov.test')`,
    );
    try {
      const before = await admin.query('SELECT count(*)::int AS n FROM organization');
      await expect(
        createOrganization({ ...NEW, slug: 'prov-two', adminEmail: 'doomed@prov.test' }),
      ).rejects.toMatchObject({ constraint: 'app_user_provision_fault' });

      const after = await admin.query('SELECT count(*)::int AS n FROM organization');
      expect(after.rows[0].n).toBe(before.rows[0].n);
      expect(await orgRow('prov-two')).toBeUndefined();
      // And no orphan audit row either — the genesis append is inside the same
      // transaction, so a rolled-back tenant leaves no trace of having existed.
      const audit = await admin.query('SELECT count(*)::int AS n FROM audit_entry');
      expect(audit.rows[0].n).toBe(0);
    } finally {
      await admin.query('ALTER TABLE app_user DROP CONSTRAINT app_user_provision_fault');
    }
  });

  it('the slug it could not keep is free for the next person', async () => {
    // The consequence of the rollback that a customer actually feels: a failed
    // signup must not burn the name.
    await admin.query(
      `ALTER TABLE app_user ADD CONSTRAINT app_user_provision_fault
         CHECK (email <> 'doomed@prov.test')`,
    );
    try {
      await expect(
        createOrganization({ ...NEW, slug: 'prov-free', adminEmail: 'doomed@prov.test' }),
      ).rejects.toBeTruthy();
    } finally {
      await admin.query('ALTER TABLE app_user DROP CONSTRAINT app_user_provision_fault');
    }
    const second = await createOrganization({ ...NEW, slug: 'prov-free' });
    expect(second.slug).toBe('prov-free');
  });

  it('refuses a slug somebody already has, by name rather than by error class', async () => {
    await createOrganization(NEW);
    const err = await createOrganization({ ...NEW, adminEmail: 'b@prov.test' }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ProvisionError);
    expect((err as ProvisionError).code).toBe('SLUG_TAKEN');
    // Only one organization, and it is the first one.
    const all = await admin.query('SELECT slug FROM organization');
    expect(all.rows).toHaveLength(1);
  });

  it('refuses a reserved slug and a malformed one differently', async () => {
    const reserved = await createOrganization({ ...NEW, slug: 'www' }).catch((e: unknown) => e);
    expect((reserved as ProvisionError).code).toBe('RESERVED');
    const shape = await createOrganization({ ...NEW, slug: 'Not A Slug' }).catch((e: unknown) => e);
    expect((shape as ProvisionError).code).toBe('SHAPE');
    expect(await admin.query('SELECT 1 FROM organization')).toMatchObject({ rowCount: 0 });
  });

  it('refuses an empty name and an empty email', async () => {
    expect(
      ((await createOrganization({ ...NEW, name: '   ' }).catch((e) => e)) as ProvisionError).code,
    ).toBe('NAME_REQUIRED');
    expect(
      ((await createOrganization({ ...NEW, adminEmail: ' ' }).catch((e) => e)) as ProvisionError)
        .code,
    ).toBe('EMAIL_REQUIRED');
  });
});

/**
 * `0034` — the constraint, exercised where the code path cannot reach it.
 *
 * This is the argument for the shape being in the schema rather than in the
 * signup form: the same column is written by the seed, by a test fixture and, in
 * Phase 5, by provisioning. A rule enforced at one of those is a rule the others
 * can break.
 */
describe('the slug shape is enforced by the database, not only by the form', () => {
  it('refuses a hostname-illegal slug written directly', async () => {
    for (const bad of ['Acme', 'acme_ltd', '-acme', 'acme-', 'a'.repeat(64)]) {
      await expect(
        admin.query("INSERT INTO organization (slug, name) VALUES ($1, 'X')", [bad]),
        bad,
      ).rejects.toMatchObject({ constraint: 'organization_slug_shape' });
    }
  });

  it('accepts the shapes the seed and every suite already use', async () => {
    for (const ok of ['demo', 'second', 'blank', 'prov-co', '3m']) {
      await expect(
        admin.query("INSERT INTO organization (slug, name) VALUES ($1, 'X')", [ok]),
      ).resolves.toBeTruthy();
    }
  });
});

describe('the tenant that was just created behaves like any other', () => {
  it('is reachable through withOrg, and its user is inside it', async () => {
    const { organizationId, adminUserId } = await createOrganization(NEW);
    const seen = await withOrg(organizationId, (tx) => tx.query('SELECT id, role_id FROM app_user'));
    expect(seen.rows).toHaveLength(1);
    expect(seen.rows[0].id).toBe(adminUserId);
  });

  /**
   * The property that says the mid-transaction `set_config` did the right thing:
   * the administrator row is inside the tenant, so ANOTHER tenant's context
   * cannot see it. If the insert had somehow escaped RLS, this would still find
   * one row.
   */
  it('cannot be seen from another tenant', async () => {
    const { organizationId } = await createOrganization(NEW);
    const other = await createOrganization({
      name: 'Other Co',
      slug: 'prov-other',
      adminEmail: 'b@prov.test',
    });
    expect(other.organizationId).not.toBe(organizationId);
    const seen = await withOrg(other.organizationId, (tx) =>
      tx.query('SELECT id FROM app_user WHERE organization_id = $1', [organizationId]),
    );
    expect(seen.rows).toHaveLength(0);
  });

  it('starts an audit chain whose genesis row is its own creation', async () => {
    const { organizationId, adminUserId } = await createOrganization(NEW);
    const entries = await admin.query(
      'SELECT action, actor_id, actor_role, entity_id, details, prev_hash FROM audit_entry WHERE organization_id = $1 ORDER BY sequence',
      [organizationId],
    );
    expect(entries.rows).toHaveLength(1);
    const genesis = entries.rows[0];
    expect(genesis.action).toBe('ORGANIZATION_CREATED');
    expect(genesis.prev_hash).toBeNull();
    expect(genesis.actor_id).toBe(adminUserId);
    expect(genesis.actor_role).toBe('System Administrator'); // w4-10b (d74)
    expect(genesis.entity_id).toBe(organizationId);
    expect(genesis.details).toMatchObject({ slug: 'prov-co', name: 'Provision Co' });

    const verified = await withOrg(organizationId, (tx) => verifyChain(tx));
    expect(verified.ok, JSON.stringify(verified)).toBe(true);
  });
});

describe('takenSlugs', () => {
  it('reports what a suggestion has to route around', async () => {
    await createOrganization(NEW);
    await createOrganization({ ...NEW, slug: 'prov-co-2', adminEmail: 'b@prov.test' });
    const taken = await takenSlugs('prov-co');
    expect(taken.has('prov-co')).toBe(true);
    expect(taken.has('prov-co-2')).toBe(true);
    expect(taken.has('prov-co-3')).toBe(false);
  });
});
