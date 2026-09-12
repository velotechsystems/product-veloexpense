/**
 * VX5-21 — the plan ceiling over `module_entitlement`, against a real Postgres.
 *
 * Own org slugs ('ceil-co', 'ceil-co-2'), for the reason every other db test in
 * this suite owns its own: a shared fixture that one file truncates is a
 * cross-file ordering dependency nobody can see from either file.
 *
 * ── WHAT THIS FILE IS REALLY ASSERTING ─────────────────────────────────────
 *
 * That the plan and the entitlement row are ANDed, in both directions, and that
 * the ABSENCE of a plan is permissive while the absence of an entitlement row is
 * not. Those two absences point opposite ways and the reason is in
 * `lib/billing/plan-entitlement.ts`'s header; this is where the behaviour is
 * pinned rather than described.
 *
 * The deploy-day test is `a tenant with NO subscription keeps its modules`. Most
 * tenants have no mirror — this product stopped starting its own trials at 0039,
 * and every tenant created before 0037 has no row — so a reader that treated a
 * missing subscription as an empty plan would take the entire customer base's
 * paid modules offline the moment it shipped, and no other test here would have
 * noticed.
 */
process.env.INTEGRATIONS_ENABLE_STUB = '1';
process.env.SECRET_ENCRYPTION_KEY =
  process.env.SECRET_ENCRYPTION_KEY ?? Buffer.alloc(32, 5).toString('base64');

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { Pool } from 'pg';
import { withOrg } from '@/lib/tenant/context';
import { isModuleEnabled, requireModule, setEntitlement } from '@/lib/modules/service';
import { ModuleDisabledError } from '@/lib/modules/errors';
import { planFor } from '@/lib/billing/service';
import { planPermitsModule } from '@/lib/billing/plan-entitlement';
import { scanAllTenants } from '@/lib/fraud/scan';
import { evaluateAllTenants } from '@/lib/fraud/evaluate';

const admin = new Pool({
  connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL,
});

let orgId: string;
let otherOrgId: string;
let actorId: string;
const ACTOR = () => ({ id: actorId, name: 'Ceiling Admin', role: 'ADMIN' });

/** Write a mirrored subscription for one tenant, with the two blobs. */
async function mirror(
  org: string,
  features: unknown,
  limits: unknown,
  status = 'ACTIVE',
): Promise<void> {
  await admin.query(
    `INSERT INTO subscription
       (organization_id, plan_code, plan_name, status, read_only, features, limits, mirrored_at)
     VALUES ($1, 'business', 'Business', $2, false, $3, $4, clock_timestamp())`,
    [org, status, JSON.stringify(features), JSON.stringify(limits)],
  );
}

beforeAll(async () => {
  await admin.query('TRUNCATE app_user, organization CASCADE');
  const o = await admin.query(
    `INSERT INTO organization (slug, name)
     VALUES ('ceil-co','Ceiling Co'), ('ceil-co-2','Ceiling Co 2') RETURNING id, slug`,
  );
  orgId = o.rows.find((r) => r.slug === 'ceil-co').id;
  otherOrgId = o.rows.find((r) => r.slug === 'ceil-co-2').id;
  const u = await admin.query(
    `INSERT INTO app_user (organization_id, email, display_name)
     VALUES ($1, 'a@ceil.test', 'Ceiling Admin') RETURNING id`,
    [orgId],
  );
  actorId = u.rows[0].id;
});

beforeEach(async () => {
  await admin.query('DELETE FROM subscription');
  await admin.query('DELETE FROM module_entitlement');
});

afterAll(async () => {
  await admin.end();
});

describe('the plan ceiling and the entitlement row are ANDed', () => {
  it('a tenant with NO subscription keeps its modules — the deploy-day case', async () => {
    await withOrg(orgId, async (tx) => {
      await setEntitlement(tx, 'accounting', true, ACTOR());
      expect(await isModuleEnabled(tx, 'accounting')).toBe(true);
      // …and the projection it got is the permissive one, not an empty object.
      expect((await planFor(tx)).modules).toBeNull();
    });
  });

  it('a plan that omits `modules` is still ungated', async () => {
    await mirror(orgId, { sso: true }, { maxUsers: 25 });
    await withOrg(orgId, async (tx) => {
      await setEntitlement(tx, 'accounting', true, ACTOR());
      expect(await isModuleEnabled(tx, 'accounting')).toBe(true);
    });
  });

  it('a plan that LISTS modules grants those and refuses the rest', async () => {
    await mirror(orgId, { modules: ['accounting'] }, {});
    await withOrg(orgId, async (tx) => {
      await setEntitlement(tx, 'accounting', true, ACTOR());
      expect(await isModuleEnabled(tx, 'accounting')).toBe(true);
      expect(await isModuleEnabled(tx, 'budgets')).toBe(false);
    });
  });

  it('an EMPTY module list grants nothing, even with the row switched on', async () => {
    // Written before the ceiling existed, so the row says yes and the plan says
    // no. This is the downgrade case, and it is the one a sync would get wrong.
    await withOrg(orgId, async (tx) => {
      await setEntitlement(tx, 'accounting', true, ACTOR());
    });
    await mirror(orgId, { modules: [] }, {});
    await withOrg(orgId, async (tx) => {
      expect(await isModuleEnabled(tx, 'accounting')).toBe(false);
    });
  });

  it('the plan does not ENABLE a module the tenant never switched on', async () => {
    // The other direction, and the one that proves it is an AND rather than the
    // plan simply winning. A plan listing a module is permission, not a grant.
    await mirror(orgId, { modules: ['accounting', 'budgets'] }, {});
    await withOrg(orgId, async (tx) => {
      expect(await isModuleEnabled(tx, 'accounting')).toBe(false); // no row
      await setEntitlement(tx, 'accounting', true, ACTOR());
      expect(await isModuleEnabled(tx, 'accounting')).toBe(true);
    });
  });

  it('a downgrade is REVERSIBLE without touching the entitlement row', async () => {
    // The property that made ANDing the right choice over a destructive sync: the
    // tenant's own position survives the downgrade, so the upgrade restores it.
    await withOrg(orgId, async (tx) => {
      await setEntitlement(tx, 'accounting', true, ACTOR());
    });
    await mirror(orgId, { modules: [] }, {});
    await withOrg(orgId, async (tx) => {
      expect(await isModuleEnabled(tx, 'accounting')).toBe(false);
    });

    await admin.query('DELETE FROM subscription');
    await mirror(orgId, { modules: ['accounting'] }, {});
    await withOrg(orgId, async (tx) => {
      expect(await isModuleEnabled(tx, 'accounting')).toBe(true);
      // The row was never rewritten — nobody has "changed" it since the grant.
      const r = await tx.query(
        `SELECT enabled, disabled_at FROM module_entitlement
          WHERE organization_id = $1 AND module_code = 'accounting'`,
        [orgId],
      );
      expect(r.rows[0].enabled).toBe(true);
      expect(r.rows[0].disabled_at).toBeNull();
    });
  });

  it('requireModule refuses, with the module error, when only the plan says no', async () => {
    await withOrg(orgId, async (tx) => {
      await setEntitlement(tx, 'accounting', true, ACTOR());
    });
    await mirror(orgId, { modules: [] }, {});
    await withOrg(orgId, async (tx) => {
      await expect(requireModule(tx, 'accounting')).rejects.toBeInstanceOf(ModuleDisabledError);
    });
  });
});

describe('setEntitlement refuses to record something the plan contradicts', () => {
  it('refuses to enable a module outside the plan, with a message naming it', async () => {
    await mirror(orgId, { modules: ['analytics'] }, {});
    await withOrg(orgId, async (tx) => {
      await expect(setEntitlement(tx, 'accounting', true, ACTOR())).rejects.toThrow(/plan/i);
    });
  });

  it('still allows DISABLING one outside the plan', async () => {
    // Turning something off is never the operation that needs a ceiling, and
    // refusing it would strand a row nobody could clear.
    await withOrg(orgId, async (tx) => {
      await setEntitlement(tx, 'accounting', true, ACTOR());
    });
    await mirror(orgId, { modules: [] }, {});
    await withOrg(orgId, async (tx) => {
      await expect(setEntitlement(tx, 'accounting', false, ACTOR())).resolves.toBeUndefined();
    });
  });
});

describe('the projection is per tenant', () => {
  it('one tenant’s plan does not decide another’s', async () => {
    await mirror(orgId, { modules: [] }, {});
    await mirror(otherOrgId, { modules: ['accounting'] }, {});

    // Both rows exist; RLS is what keeps each tenant reading its own.
    const a = await withOrg(orgId, async (tx) => (await planFor(tx)).modules);
    const b = await withOrg(otherOrgId, async (tx) => (await planFor(tx)).modules);
    expect(a).toEqual([]);
    expect(b).toEqual(['accounting']);
    expect(a).not.toEqual(b); // refuse to pass if the fixture ever makes them equal
  });
});

describe('a CANCELLED subscription is not a live plan', () => {
  it('falls back to UNGATED rather than to the cancelled row’s blobs', async () => {
    // `liveSubscription` excludes cancelled rows. The hazard is the same one
    // VX5-11's test caught for the write gate: a customer who left looked like a
    // customer nobody bills. Here it would mean their old ceiling kept applying.
    await mirror(orgId, { modules: [] }, {}, 'CANCELLED');
    await withOrg(orgId, async (tx) => {
      await setEntitlement(tx, 'accounting', true, ACTOR());
      expect(planPermitsModule(await planFor(tx), 'accounting')).toBe(true);
      expect(await isModuleEnabled(tx, 'accounting')).toBe(true);
    });
  });
});

describe('the cross-tenant sweeps SKIP a downgraded tenant rather than failing it', () => {
  /**
   * `organizationsWithModule` runs under `withPlatformRead`, where no tenant
   * context exists, so it selects on `module_entitlement` alone and cannot apply
   * the plan ceiling. Re-implementing the ceiling in SQL there would be a second
   * copy of a rule this project keeps only one copy of.
   *
   * So the sweep selects a superset and re-asks per tenant. What matters is that
   * the extra tenants are COUNTED, not FAILED: a downgraded tenant is a normal
   * state, and a normal state reported as an error every hour is how an error
   * report stops being read. Same argument the platform seats route makes for
   * answering "no subscription" with a 200.
   */
  beforeEach(async () => {
    await withOrg(orgId, async (tx) => {
      await setEntitlement(tx, 'compliance', true, ACTOR());
    });
  });

  it('scanAllTenants skips, and records nothing in failed', async () => {
    await mirror(orgId, { modules: [] }, {});
    const out = await scanAllTenants();
    expect(out.skipped).toBe(1);
    expect(out.organizations).toBe(0);
    expect(out.failed).toEqual([]);
  });

  it('evaluateAllTenants skips, and records nothing in failed', async () => {
    await mirror(orgId, { modules: [] }, {});
    const out = await evaluateAllTenants();
    expect(out.skipped).toBe(1);
    expect(out.organizations).toBe(0);
    expect(out.failed).toEqual([]);
  });

  it('and still RUNS for a tenant whose plan includes it — not a blanket skip', async () => {
    // Without this the two above would pass against a sweep that skipped
    // everything, which is the vacuity this project has been bitten by before.
    await mirror(orgId, { modules: ['compliance'] }, {});
    const out = await scanAllTenants();
    expect(out.skipped).toBe(0);
    expect(out.organizations).toBe(1);
    expect(out.failed).toEqual([]);
  });
});
