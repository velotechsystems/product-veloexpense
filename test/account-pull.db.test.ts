/**
 * VX3-5 — pulling a chart of accounts and reconciling it. Own org slug ('pull-co').
 *
 * ── The tests worth reading ─────────────────────────────────────────────────
 *
 * `adopts a template row rather than duplicating it` is the whole strategy, and
 * the reason VX3-1 took VeloLedger's account numbers verbatim: a tenant that has
 * been coding expenses against a starter template for a month must not have every
 * category mapping re-pointed the moment it connects a ledger.
 *
 * `an empty response is refused` and `duplicate numbers are refused before any
 * write` are the two ways a pull could quietly wreck a chart. The first would
 * report every local account as orphaned at once; the second would silently pick a
 * winner for an account somebody codes expenses to.
 *
 * `orphans are reported, not deactivated` is the deliberate divergence from
 * ExpenseOS, which marks them `isActive = false` from a background job.
 */
process.env.INTEGRATIONS_ENABLE_STUB = '1';
process.env.SECRET_ENCRYPTION_KEY =
  process.env.SECRET_ENCRYPTION_KEY ?? Buffer.alloc(32, 11).toString('base64');

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { Pool } from 'pg';
import { withOrg } from '@/lib/tenant/context';
import * as accounts from '@/lib/accounts/service';
import { pullChartOfAccounts, pullFromLedger, PullError } from '@/lib/accounts/pull';
import * as integrations from '@/lib/integrations/service';
import { stubControl } from '@/lib/integrations/stub';
import type { RemoteAccount } from '@/lib/integrations/contract';

const admin = new Pool({
  connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL,
});

let orgId: string;
let userId: string;
let installationId: string;
const stub = stubControl();

function remote(over: Partial<RemoteAccount> & { number: string }): RemoteAccount {
  return {
    externalId: `ext-${over.number}`,
    name: `Account ${over.number}`,
    type: 'expense',
    subType: 'opex',
    parentNumber: null,
    active: true,
    ...over,
  };
}

beforeAll(async () => {
  await admin.query('TRUNCATE app_user, organization CASCADE');
  const o = await admin.query(
    "INSERT INTO organization (slug, name) VALUES ('pull-co','Pull Co') RETURNING id",
  );
  orgId = o.rows[0].id;
  const u = await admin.query(
    "INSERT INTO app_user (organization_id, email, display_name) VALUES ($1,'a@pull.test','Ada') RETURNING id",
    [orgId],
  );
  userId = u.rows[0].id;

  // VX4-1: ABSENCE MEANS OFF, so a suite that exercises accounting has to entitle
  // its tenants — the same row `scripts/seed.mjs` writes for the demo orgs. Every
  // org this file created, because the TRUNCATE above means these are the only ones.
  await admin.query(
    `INSERT INTO module_entitlement (organization_id, module_code, enabled)
     SELECT id, 'accounting', true FROM organization
     ON CONFLICT (organization_id, module_code) DO NOTHING`,
  );
});

beforeEach(async () => {
  await admin.query('DELETE FROM gl_account');
  await admin.query('DELETE FROM integration_installation');
  stub.reset();
  const installed = await withOrg(orgId, (tx) =>
    integrations.installIntegration(
      tx,
      {
        slug: 'stub-ledger',
        code: 'main',
        label: 'Stub',
        config: { ledgerUrl: 'https://ledger.test', apiToken: 'tok' },
      },
      userId,
    ),
  );
  installationId = installed.id;
});

afterAll(async () => {
  await admin.query('TRUNCATE app_user, organization CASCADE');
  await admin.end();
});

const pull = (rows: RemoteAccount[]) =>
  withOrg(orgId, (tx) => pullChartOfAccounts(tx, rows, installationId));

describe('reconciling', () => {
  it('adds accounts the tenant does not have', async () => {
    const outcome = await pull([remote({ number: '68100' }), remote({ number: '67100' })]);
    expect(outcome.added.sort()).toEqual(['67100', '68100']);
    expect(outcome.adopted).toEqual([]);
    const all = await withOrg(orgId, (tx) => accounts.listAccounts(tx));
    expect(all.map((a) => a.number)).toEqual(['67100', '68100']);
    expect(all.every((a) => a.source === 'PULLED')).toBe(true);
    expect(all.every((a) => a.external_id !== null)).toBe(true);
  });

  it('ADOPTS a template row rather than duplicating it, keeping category mappings', async () => {
    // The whole point. A tenant instantiates the starter template, maps a category,
    // files expenses for a month, then connects a ledger.
    await withOrg(orgId, (tx) => accounts.instantiateTemplate(tx, 'na-expense-claims'));
    const before = await withOrg(orgId, (tx) => accounts.listAccounts(tx));
    const travel = before.find((a) => a.number === '68100')!;
    const catId = await withOrg(orgId, async (tx) => {
      const r = await tx.query(
        `INSERT INTO expense_category (organization_id, code, label, gl_account_id)
         VALUES ($1,'travel','{"en":"Travel"}',$2) RETURNING id`,
        [orgId, travel.id],
      );
      return r.rows[0].id as string;
    });

    const outcome = await pull([remote({ number: '68100', name: 'Travel (ledger name)' })]);
    expect(outcome.adopted).toEqual(['68100']);
    expect(outcome.added).toEqual([]);

    const after = await withOrg(orgId, (tx) => accounts.listAccounts(tx, { includeInactive: true }));
    const adoptedRow = after.find((a) => a.number === '68100')!;
    // SAME ROW — the id is unchanged, which is what keeps the mapping intact.
    expect(adoptedRow.id).toBe(travel.id);
    expect(adoptedRow.source).toBe('PULLED');
    expect(adoptedRow.external_id).toBe('ext-68100');
    // The ledger is authoritative about what an account is CALLED.
    expect(adoptedRow.name).toBe('Travel (ledger name)');
    // And the category still points at it.
    const mappings = await withOrg(orgId, (tx) => accounts.listCategoryMappings(tx));
    expect(mappings.find((m) => m.id === catId)?.gl_account_id).toBe(travel.id);
  });

  it('builds the tree and derives is_postable from it, not from the ledger', async () => {
    const outcome = await pull([
      remote({ number: '68000', name: 'Travel M&E' }),
      remote({ number: '68100', name: 'Travel', parentNumber: '68000' }),
    ]);
    expect(outcome.added.sort()).toEqual(['68000', '68100']);
    const all = await withOrg(orgId, (tx) => accounts.listAccounts(tx));
    const rollup = all.find((a) => a.number === '68000')!;
    const leaf = all.find((a) => a.number === '68100')!;
    expect(leaf.parent_id).toBe(rollup.id);
    // The ledger said both were active and said nothing about postability; the
    // rollup is derived from having a child, which is our rule (VeloLedger 0028).
    expect(rollup.is_postable).toBe(false);
    expect(leaf.is_postable).toBe(true);
  });

  it('carries the ledger\'s active flag onto a NEW account', async () => {
    await pull([remote({ number: '69999', active: false })]);
    const all = await withOrg(orgId, (tx) => accounts.listAccounts(tx, { includeInactive: true }));
    expect(all.find((a) => a.number === '69999')?.active).toBe(false);
  });

  it('REPORTS orphans rather than deactivating them', async () => {
    // ExpenseOS marks these isActive = false from a background job. A tenant whose
    // ledger stops reporting an account it has been coding to for a year should be
    // told, not have its categories quietly unmapped.
    await pull([remote({ number: '68100' }), remote({ number: '67100' })]);
    const outcome = await pull([remote({ number: '68100' })]);
    expect(outcome.orphaned).toEqual(['67100']);
    const all = await withOrg(orgId, (tx) => accounts.listAccounts(tx, { includeInactive: true }));
    expect(all.find((a) => a.number === '67100')?.active).toBe(true);
  });

  it('reports a local-only account and leaves it usable', async () => {
    await withOrg(orgId, (tx) =>
      accounts.createAccount(tx, { number: '99000', name: 'Ours alone', type: 'expense' }),
    );
    const outcome = await pull([remote({ number: '68100' })]);
    expect(outcome.localOnly).toEqual(['99000']);
    expect(outcome.orphaned).toEqual([]);
    const postable = await withOrg(orgId, (tx) => accounts.listPostableAccounts(tx));
    expect(postable.map((a) => a.number)).toContain('99000');
  });

  it('stamps last_seen_at on everything it saw, and only that', async () => {
    await withOrg(orgId, (tx) =>
      accounts.createAccount(tx, { number: '99000', name: 'Ours alone', type: 'expense' }),
    );
    await pull([remote({ number: '68100' })]);
    const rows = await admin.query(
      'SELECT number, last_seen_at FROM gl_account ORDER BY number',
    );
    const map = Object.fromEntries(rows.rows.map((r) => [r.number, r.last_seen_at]));
    expect(map['68100']).toBeInstanceOf(Date);
    expect(map['99000']).toBeNull();
  });

  it('is idempotent — a second identical pull changes nothing', async () => {
    await pull([remote({ number: '68100' }), remote({ number: '67100' })]);
    const outcome = await pull([remote({ number: '68100' }), remote({ number: '67100' })]);
    expect(outcome.added).toEqual([]);
    expect(outcome.adopted.sort()).toEqual(['67100', '68100']);
    expect(outcome.orphaned).toEqual([]);
    const all = await withOrg(orgId, (tx) => accounts.listAccounts(tx));
    expect(all).toHaveLength(2);
  });
});

describe('refusals', () => {
  it('refuses an EMPTY response instead of orphaning everything', async () => {
    await pull([remote({ number: '68100' })]);
    await expect(pull([])).rejects.toMatchObject({ code: 'EMPTY' });
    const all = await withOrg(orgId, (tx) => accounts.listAccounts(tx));
    expect(all).toHaveLength(1);
  });

  it('refuses duplicate numbers BEFORE any write', async () => {
    let err: PullError | null = null;
    try {
      await pull([
        remote({ number: '68100', name: 'One' }),
        remote({ number: '68100', name: 'Two' }),
      ]);
    } catch (e) {
      err = e as PullError;
    }
    expect(err?.code).toBe('DUPLICATE_NUMBERS');
    expect(err?.detail).toEqual(['68100']);
    // Nothing was written — a partial chart is worse than none.
    const all = await withOrg(orgId, (tx) => accounts.listAccounts(tx));
    expect(all).toEqual([]);
  });
});

describe('through the adapter', () => {
  it('pulls what the connected ledger reports', async () => {
    stub.setAccounts([
      remote({ number: '68000', name: 'Travel M&E' }),
      remote({ number: '68100', name: 'Travel', parentNumber: '68000' }),
    ]);
    const outcome = await pullFromLedger((fn) => withOrg(orgId, fn));
    expect(outcome.added.sort()).toEqual(['68000', '68100']);
    const all = await withOrg(orgId, (tx) => accounts.listAccounts(tx));
    expect(all.map((a) => a.number)).toEqual(['68000', '68100']);
    expect(all.every((a) => a.installation_id === installationId)).toBe(true);
  });

  it('refuses when nothing that can pull is connected', async () => {
    await admin.query('UPDATE integration_installation SET active = false');
    await expect(pullFromLedger((fn) => withOrg(orgId, fn))).rejects.toMatchObject({
      code: 'NO_CAPABILITY',
    });
  });
});
