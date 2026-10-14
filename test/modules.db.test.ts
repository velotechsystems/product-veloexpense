/**
 * VX4-1 — per-tenant module entitlements, against a real Postgres.
 *
 * Own org slugs ('mod-co', 'mod-co-2'). `INTEGRATIONS_ENABLE_STUB` is set before
 * the registry is imported, for the reason `integrations.db.test.ts` gives.
 *
 * ── The tests worth reading ─────────────────────────────────────────────────
 *
 * `absence means off` is the whole default, and it is the one a future
 * "convenience" change would break: somebody adds a `defaultOn` flag, every
 * tenant silently acquires a paid module, and no test objects.
 *
 * `a gated call refuses, and the SAME call succeeds once enabled` is the
 * both-outcomes assertion this project keeps learning it needs — AC-17 and AC-19
 * were both a double that could only produce one side.
 *
 * `one tenant's entitlement is not another's` is RLS doing its job, asserted here
 * rather than only in the isolation suite because this table decides what a
 * customer is paying for.
 */
process.env.INTEGRATIONS_ENABLE_STUB = '1';
process.env.SECRET_ENCRYPTION_KEY =
  process.env.SECRET_ENCRYPTION_KEY ?? Buffer.alloc(32, 5).toString('base64');

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { Pool } from 'pg';
import { withOrg } from '@/lib/tenant/context';
import {
  isModuleEnabled,
  listEntitlements,
  requireModule,
  setEntitlement,
} from '@/lib/modules/service';
import { listModules } from '@/lib/modules/registry';
import { ModuleDisabledError } from '@/lib/modules/errors';
import { installIntegration, resolveCapability } from '@/lib/integrations/service';
import { listAccounts, createAccount } from '@/lib/accounts/service';

const admin = new Pool({
  connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL,
});

let orgId: string;
let otherOrgId: string;
let actorId: string;

const ACTOR = () => ({ id: actorId, name: 'Mod Admin', role: 'ADMIN' });

/**
 * A module this build declares and cannot serve, CHOSEN FROM THE REGISTRY rather
 * than named.
 *
 * These three tests used to say `'budgets'`, which was true until VX4-5 part 3b
 * made Budgets available and then broke all three at once. What they are about is
 * the dormant-declaration property, not any particular module — so they now take
 * whichever module is dormant today, and the `toBeDefined` below is what stops
 * the whole block passing vacuously on the day none is.
 */
const UNAVAILABLE = listModules().find((m) => !m.available)?.code as string;

beforeAll(async () => {
  await admin.query('TRUNCATE app_user, organization CASCADE');
  const o = await admin.query(
    `INSERT INTO organization (slug, name)
     VALUES ('mod-co','Mod Co'), ('mod-co-2','Mod Co 2') RETURNING id, slug`,
  );
  orgId = o.rows.find((r) => r.slug === 'mod-co').id;
  otherOrgId = o.rows.find((r) => r.slug === 'mod-co-2').id;
  for (const [org, email] of [
    [orgId, 'a@mod.test'],
    [otherOrgId, 'b@mod.test'],
  ] as const) {
    const u = await withOrg(org, (tx) =>
      tx.query(
        `INSERT INTO app_user (organization_id, email, display_name, role_id)
         VALUES ($1, $2, 'Mod Admin', '019e3000-0000-7000-8000-000000000001') RETURNING id`,
        [org, email],
      ),
    );
    if (org === orgId) actorId = u.rows[0].id;
  }
});

beforeEach(async () => {
  await admin.query('DELETE FROM module_entitlement');
  await admin.query('DELETE FROM integration_installation');
  await admin.query('DELETE FROM gl_account');
});

afterAll(async () => {
  await admin.end();
});

describe('absence means off', () => {
  it('a tenant with no row does not have the module', async () => {
    expect(await withOrg(orgId, (tx) => isModuleEnabled(tx, 'accounting'))).toBe(false);
  });

  it('and the gate refuses, naming the module the way a screen does', async () => {
    const err = await withOrg(orgId, (tx) =>
      requireModule(tx, 'accounting').then(
        () => null,
        (e) => e as ModuleDisabledError,
      ),
    );
    expect(err).toBeInstanceOf(ModuleDisabledError);
    expect(err!.moduleCode).toBe('accounting');
    expect(err!.message).toContain('Accounting integrations');
    // The sentence has to tell somebody what to do about it.
    expect(err!.message).toMatch(/administrator/i);
  });

  it('an UNKNOWN module code is off, not an error, on the read path', async () => {
    // A row can outlive the code that served it — a downgrade, a renamed module.
    // The read must treat that as "off" rather than throwing somewhere unrelated.
    await admin.query(
      `INSERT INTO module_entitlement (organization_id, module_code, enabled)
       VALUES ($1, 'retired_module', true)`,
      [orgId],
    );
    expect(await withOrg(orgId, (tx) => isModuleEnabled(tx, 'retired_module'))).toBe(false);
  });

  it('a DECLARED BUT UNAVAILABLE module is off even with an enabled row', async () => {
    // The dormant-QuickBooks property. A row saying a tenant has a module this
    // build cannot serve does not make it servable, so the read refuses to
    // believe it.
    await admin.query(
      `INSERT INTO module_entitlement (organization_id, module_code, enabled)
       VALUES ($1, $2, true)`,
      [orgId, UNAVAILABLE],
    );
    expect(await withOrg(orgId, (tx) => isModuleEnabled(tx, UNAVAILABLE))).toBe(false);
  });
});

describe('turning a module on and off', () => {
  it('enables, stamps the transition, and audits it', async () => {
    await withOrg(orgId, (tx) => setEntitlement(tx, 'accounting', true, ACTOR()));
    expect(await withOrg(orgId, (tx) => isModuleEnabled(tx, 'accounting'))).toBe(true);

    const row = (
      await admin.query(
        `SELECT enabled, enabled_at, disabled_at, changed_by_id FROM module_entitlement
          WHERE organization_id = $1 AND module_code = 'accounting'`,
        [orgId],
      )
    ).rows[0];
    expect(row.enabled).toBe(true);
    expect(row.enabled_at).toBeInstanceOf(Date);
    expect(row.disabled_at).toBeNull();
    expect(row.changed_by_id).toBe(actorId);

    const audit = await admin.query(
      `SELECT action, details FROM audit_entry WHERE action = 'MODULE_ENABLED'`,
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].details).toMatchObject({ moduleCode: 'accounting' });
  });

  it('re-enabling does NOT move the date the entitlement started', async () => {
    // The billing question this column exists to answer is "since when", and an
    // idempotent toggle press must not rewrite the answer.
    await withOrg(orgId, (tx) => setEntitlement(tx, 'accounting', true, ACTOR()));
    const first = (
      await admin.query(`SELECT enabled_at FROM module_entitlement`)
    ).rows[0].enabled_at;
    await new Promise((r) => setTimeout(r, 15));
    await withOrg(orgId, (tx) => setEntitlement(tx, 'accounting', true, ACTOR()));
    const second = (
      await admin.query(`SELECT enabled_at FROM module_entitlement`)
    ).rows[0].enabled_at;
    expect(second.getTime()).toBe(first.getTime());
  });

  it('disabling keeps the row, and records when', async () => {
    await withOrg(orgId, (tx) => setEntitlement(tx, 'accounting', true, ACTOR()));
    await withOrg(orgId, (tx) => setEntitlement(tx, 'accounting', false, ACTOR()));
    const row = (await admin.query(`SELECT enabled, enabled_at, disabled_at FROM module_entitlement`))
      .rows[0];
    // The row SURVIVES — a deleted row answers no billing question.
    expect(row.enabled).toBe(false);
    expect(row.enabled_at).toBeInstanceOf(Date);
    expect(row.disabled_at).toBeInstanceOf(Date);
    expect(await withOrg(orgId, (tx) => isModuleEnabled(tx, 'accounting'))).toBe(false);
  });

  it('refuses to enable a module this build cannot serve', async () => {
    await expect(
      withOrg(orgId, (tx) => setEntitlement(tx, UNAVAILABLE, true, ACTOR())),
    ).rejects.toThrow(/not available in this build/);
    expect((await admin.query('SELECT count(*)::int AS n FROM module_entitlement')).rows[0].n).toBe(0);
  });

  it('this build still declares a module it cannot serve, or the three tests above prove nothing', () => {
    // The floor every generated assertion in this repo carries. `UNAVAILABLE`
    // being undefined would make the dormant-declaration tests assert things
    // about a module code of `undefined`, which is not a pass.
    expect(UNAVAILABLE).toBeDefined();
    expect(listModules().some((m) => !m.available)).toBe(true);
  });

  it('lists every declared module, available or not, with this tenant’s state', async () => {
    await withOrg(orgId, (tx) => setEntitlement(tx, 'accounting', true, ACTOR()));
    const rows = await withOrg(orgId, (tx) => listEntitlements(tx));
    expect(rows.length).toBeGreaterThan(4);
    const accounting = rows.find((r) => r.module.code === 'accounting')!;
    expect(accounting.enabled).toBe(true);
    expect(accounting.changedByName).toBe('Mod Admin');
    // An unavailable module is SHOWN, not hidden: a customer asking for Budgets is
    // a sales answer, and an empty list is not one.
    const dormant = rows.find((r) => r.module.code === UNAVAILABLE)!;
    expect(dormant.module.available).toBe(false);
    expect(dormant.enabled).toBe(false);
  });
});

describe('the gate, on real accounting calls', () => {
  it('refuses a WRITE while the module is off, and the same call works once on', async () => {
    // Both outcomes from one double, which is the assertion shape AC-17 and AC-19
    // were both missing.
    await expect(
      withOrg(orgId, (tx) => createAccount(tx, { number: '68100', name: 'Travel', type: 'expense' })),
    ).rejects.toBeInstanceOf(ModuleDisabledError);
    expect((await admin.query('SELECT count(*)::int AS n FROM gl_account')).rows[0].n).toBe(0);

    await withOrg(orgId, (tx) => setEntitlement(tx, 'accounting', true, ACTOR()));
    await withOrg(orgId, (tx) =>
      createAccount(tx, { number: '68100', name: 'Travel', type: 'expense' }),
    );
    expect((await admin.query('SELECT count(*)::int AS n FROM gl_account')).rows[0].n).toBe(1);
  });

  it('leaves the READS a screen needs in order to explain itself', async () => {
    // Deliberately ungated, and the registry says why: a gated read makes "the
    // module is off" indistinguishable from "the chart is empty", which is the
    // AC-22 mistake — the screen must be able to say WHY it has nothing.
    await expect(withOrg(orgId, (tx) => listAccounts(tx))).resolves.toEqual([]);
  });

  it('refuses the POSTING path, which is what stops a report reaching a ledger', async () => {
    await withOrg(orgId, (tx) => setEntitlement(tx, 'accounting', true, ACTOR()));
    await withOrg(orgId, (tx) =>
      installIntegration(
        tx,
        {
          slug: 'stub-ledger',
          code: 'main',
          label: 'Stub',
          config: { ledgerUrl: 'https://x.test', apiToken: 'tok' },
        },
        actorId,
      ),
    );
    // Connected and resolvable while the module is on…
    expect(
      await withOrg(orgId, (tx) => resolveCapability(tx, 'POST_EXPENSE_REPORT')),
    ).not.toBeNull();

    // …and refused the moment it is off, WITHOUT the installation being touched.
    await withOrg(orgId, (tx) => setEntitlement(tx, 'accounting', false, ACTOR()));
    await expect(
      withOrg(orgId, (tx) => resolveCapability(tx, 'POST_EXPENSE_REPORT')),
    ).rejects.toBeInstanceOf(ModuleDisabledError);
    const still = await admin.query('SELECT active FROM integration_installation');
    expect(still.rows[0].active).toBe(true);
  });
});

describe('tenancy', () => {
  it('one tenant’s entitlement is not another’s', async () => {
    await withOrg(orgId, (tx) => setEntitlement(tx, 'accounting', true, ACTOR()));
    expect(await withOrg(orgId, (tx) => isModuleEnabled(tx, 'accounting'))).toBe(true);
    // The other tenant has no row, so it has no module — and cannot see the one
    // next door.
    expect(await withOrg(otherOrgId, (tx) => isModuleEnabled(tx, 'accounting'))).toBe(false);
    const visible = await withOrg(otherOrgId, (tx) =>
      tx.query('SELECT count(*)::int AS n FROM module_entitlement'),
    );
    expect(visible.rows[0].n).toBe(0);
  });
});
