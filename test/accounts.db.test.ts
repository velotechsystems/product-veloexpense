/**
 * VX3-1 — the chart of accounts, against a real Postgres.
 *
 * Own org slug ('coa-co') because the DB suites share one database and each
 * TRUNCATEs (vitest.config.ts, fileParallelism: false).
 *
 * ── The tests worth reading ─────────────────────────────────────────────────
 *
 * `instantiate` proves the two-pass insert actually builds a TREE. It is the test
 * that caught a real bug: the second pass was written as
 * `FROM coa_template_account a JOIN gl_account p ON p.organization_id =
 * g.organization_id`, and an UPDATE's target table cannot be referenced from a
 * JOIN condition inside FROM. Postgres says "invalid reference to FROM-clause
 * entry for table g". It typechecked, it linted, and it would have left every
 * account parentless.
 *
 * `adding a child demotes its parent` is the one that keeps VeloLedger's `0028`
 * lesson from having to be re-learned here. Their fix was a BACKFILL after a
 * posted line vanished from the income statement; the flag is derived here so it
 * cannot drift in the first place.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { Pool } from 'pg';
import { withOrg } from '@/lib/tenant/context';
import * as accounts from '@/lib/accounts/service';

const ADMIN_URL = process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL;
if (!ADMIN_URL) {
  throw new Error('accounts.db.test.ts needs ADMIN_DATABASE_URL (or DATABASE_URL).');
}
const admin = new Pool({ connectionString: ADMIN_URL });

const TEMPLATE = 'na-expense-claims';
let orgId: string;

beforeAll(async () => {
  await admin.query('TRUNCATE organization CASCADE');
});

beforeEach(async () => {
  await admin.query('TRUNCATE organization CASCADE');
  const org = await admin.query(
    "INSERT INTO organization (slug, name) VALUES ('coa-co','CoA Co') RETURNING id",
  );
  orgId = org.rows[0].id;

  // VX4-1: ABSENCE MEANS OFF, so a suite that exercises accounting has to entitle
  // its tenant — the same row `scripts/seed.mjs` writes for the demo orgs. In the
  // beforeEACH and not the beforeAll, because this file recreates its org for
  // every test and a beforeAll row would be truncated away before the first one.
  await admin.query(
    `INSERT INTO module_entitlement (organization_id, module_code, enabled)
     VALUES ($1, 'accounting', true)`,
    [orgId],
  );
});

afterAll(async () => {
  await admin.query('TRUNCATE organization CASCADE');
  await admin.end();
});

async function category(code: string) {
  return withOrg(orgId, async (tx) => {
    const r = await tx.query(
      `INSERT INTO expense_category (organization_id, code, label)
       VALUES ($1, $2, jsonb_build_object('en', $2::text)) RETURNING id`,
      [orgId, code],
    );
    return r.rows[0].id as string;
  });
}

describe('starter templates', () => {
  it('lists the shipped template with its account count', async () => {
    const list = await withOrg(orgId, (tx) => accounts.listTemplates(tx));
    const starter = list.find((t) => t.key === TEMPLATE);
    expect(starter).toBeDefined();
    // Pinned: 0014 seeds exactly 28. If a row is added to the template this test
    // fails, which is the point — the starter chart is content, and content that
    // changes silently is how a tenant ends up with an account nobody chose.
    expect(starter?.account_count).toBe(28);
  });

  it('instantiates the template as a tree, not a flat list', async () => {
    const { created } = await withOrg(orgId, (tx) =>
      accounts.instantiateTemplate(tx, TEMPLATE),
    );
    expect(created).toBe(28);

    const all = await withOrg(orgId, (tx) => accounts.listAccounts(tx));
    expect(all).toHaveLength(28);
    // Exactly one root. Everything else resolved a parent — the assertion the
    // FROM-clause bug would have failed, with 28 roots.
    expect(all.filter((a) => a.parent_id === null).map((a) => a.number)).toEqual(['60000']);
    expect(all.filter((a) => a.parent_number !== null)).toHaveLength(27);

    // 8 rollups, 20 leaves, and the rollups are the ones with children.
    const rollups = all.filter((a) => !a.is_postable).map((a) => a.number);
    expect(rollups).toHaveLength(8);
    const parents = new Set(all.map((a) => a.parent_number).filter(Boolean));
    expect(new Set(rollups)).toEqual(parents);
  });

  it('numbers and names come from VeloLedger, verbatim', async () => {
    // The provenance IS the feature: VX3-4 posts to VeloLedger by matching on
    // account number, so a "tidied" number here silently breaks the adapter.
    await withOrg(orgId, (tx) => accounts.instantiateTemplate(tx, TEMPLATE));
    const all = await withOrg(orgId, (tx) => accounts.listAccounts(tx));
    const byNumber = Object.fromEntries(all.map((a) => [a.number, a.name]));
    expect(byNumber['68100']).toBe('Travel (100% deductible)');
    expect(byNumber['68200']).toBe('Meals and Entertainment (50% deductible)');
    expect(byNumber['67100']).toBe('Office Supplies');
    expect(byNumber['66100']).toBe('Software Subscriptions (internal)');
  });

  it('refuses to instantiate over an existing chart', async () => {
    await withOrg(orgId, (tx) => accounts.instantiateTemplate(tx, TEMPLATE));
    await expect(
      withOrg(orgId, (tx) => accounts.instantiateTemplate(tx, TEMPLATE)),
    ).rejects.toMatchObject({ code: 'ALREADY_POPULATED' });
  });

  it('refuses an unknown template', async () => {
    await expect(
      withOrg(orgId, (tx) => accounts.instantiateTemplate(tx, 'no-such-template')),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('editing the chart', () => {
  beforeEach(async () => {
    await withOrg(orgId, (tx) => accounts.instantiateTemplate(tx, TEMPLATE));
  });

  it('adding a child demotes its parent to a rollup', async () => {
    // 67100 Office Supplies is a leaf. Give it a child and it stops being
    // postable — derived in the same transaction, which is what VeloLedger's 0028
    // had to backfill after the fact.
    const before = await withOrg(orgId, (tx) => accounts.listAccounts(tx));
    expect(before.find((a) => a.number === '67100')?.is_postable).toBe(true);

    await withOrg(orgId, (tx) =>
      accounts.createAccount(tx, {
        number: '67110',
        name: 'Kitchen supplies',
        type: 'expense',
        parentNumber: '67100',
      }),
    );

    const after = await withOrg(orgId, (tx) => accounts.listAccounts(tx));
    expect(after.find((a) => a.number === '67100')?.is_postable).toBe(false);
    expect(after.find((a) => a.number === '67110')?.is_postable).toBe(true);
  });

  it('refuses to demote a parent that something is already coded to', async () => {
    const catId = await category('office');
    const office = (await withOrg(orgId, (tx) => accounts.listAccounts(tx))).find(
      (a) => a.number === '67100',
    )!;
    await withOrg(orgId, (tx) => accounts.setCategoryAccount(tx, catId, office.id));

    await expect(
      withOrg(orgId, (tx) =>
        accounts.createAccount(tx, {
          number: '67110',
          name: 'Kitchen supplies',
          type: 'expense',
          parentNumber: '67100',
        }),
      ),
    ).rejects.toMatchObject({ code: 'IN_USE' });

    // And nothing changed: the refusal is not a partial write.
    const after = await withOrg(orgId, (tx) => accounts.listAccounts(tx));
    expect(after.find((a) => a.number === '67100')?.is_postable).toBe(true);
    expect(after.find((a) => a.number === '67110')).toBeUndefined();
  });

  it('refuses a duplicate account number', async () => {
    await expect(
      withOrg(orgId, (tx) =>
        accounts.createAccount(tx, { number: '68100', name: 'Travel again', type: 'expense' }),
      ),
    ).rejects.toMatchObject({ code: 'DUPLICATE_NUMBER' });
  });

  it('deactivating keeps existing mappings and blocks new ones', async () => {
    const catId = await category('travel');
    const travel = (await withOrg(orgId, (tx) => accounts.listAccounts(tx))).find(
      (a) => a.number === '68100',
    )!;
    await withOrg(orgId, (tx) => accounts.setCategoryAccount(tx, catId, travel.id));
    await withOrg(orgId, (tx) => accounts.deactivateAccount(tx, travel.id));

    // The existing mapping survives — an admin can still see what it was.
    const mappings = await withOrg(orgId, (tx) => accounts.listCategoryMappings(tx));
    expect(mappings.find((m) => m.code === 'travel')?.gl_account_id).toBe(travel.id);

    // A NEW coding to it is refused by the trigger.
    const other = await category('other');
    await expect(
      withOrg(orgId, (tx) => accounts.setCategoryAccount(tx, other, travel.id)),
    ).rejects.toMatchObject({ code: 'NOT_POSTABLE' });
  });

  it('refuses to delete an account in use, and allows deleting an unused one', async () => {
    const catId = await category('travel');
    const all = await withOrg(orgId, (tx) => accounts.listAccounts(tx));
    const travel = all.find((a) => a.number === '68100')!;
    const printing = all.find((a) => a.number === '67500')!;
    await withOrg(orgId, (tx) => accounts.setCategoryAccount(tx, catId, travel.id));

    await expect(
      withOrg(orgId, (tx) => accounts.removeAccount(tx, travel.id)),
    ).rejects.toMatchObject({ code: 'IN_USE' });
    await withOrg(orgId, (tx) => accounts.removeAccount(tx, printing.id));

    const after = await withOrg(orgId, (tx) => accounts.listAccounts(tx));
    expect(after.map((a) => a.number)).not.toContain('67500');
  });

  it('refuses to delete a rollup with children', async () => {
    const rollup = (await withOrg(orgId, (tx) => accounts.listAccounts(tx))).find(
      (a) => a.number === '68000',
    )!;
    await expect(
      withOrg(orgId, (tx) => accounts.removeAccount(tx, rollup.id)),
    ).rejects.toMatchObject({ code: 'IN_USE' });
  });

  it('only postable accounts are offered for coding', async () => {
    const postable = await withOrg(orgId, (tx) => accounts.listPostableAccounts(tx));
    expect(postable).toHaveLength(20);
    expect(postable.map((a) => a.number)).not.toContain('60000');
    expect(postable.map((a) => a.number)).toContain('68100');
  });

  it('refuses to code a category to a rollup', async () => {
    const catId = await category('travel');
    const rollup = (await withOrg(orgId, (tx) => accounts.listAccounts(tx))).find(
      (a) => a.number === '68000',
    )!;
    await expect(
      withOrg(orgId, (tx) => accounts.setCategoryAccount(tx, catId, rollup.id)),
    ).rejects.toMatchObject({ code: 'NOT_POSTABLE' });
  });

  it('clears a mapping with null', async () => {
    const catId = await category('travel');
    const travel = (await withOrg(orgId, (tx) => accounts.listAccounts(tx))).find(
      (a) => a.number === '68100',
    )!;
    await withOrg(orgId, (tx) => accounts.setCategoryAccount(tx, catId, travel.id));
    await withOrg(orgId, (tx) => accounts.setCategoryAccount(tx, catId, null));
    const mappings = await withOrg(orgId, (tx) => accounts.listCategoryMappings(tx));
    expect(mappings.find((m) => m.code === 'travel')?.gl_account_id).toBeNull();
  });

  it('reports usage counts, which is what makes deactivate-vs-delete decidable', async () => {
    const catId = await category('travel');
    const travel = (await withOrg(orgId, (tx) => accounts.listAccounts(tx))).find(
      (a) => a.number === '68100',
    )!;
    await withOrg(orgId, (tx) => accounts.setCategoryAccount(tx, catId, travel.id));
    const after = await withOrg(orgId, (tx) => accounts.listAccounts(tx));
    expect(after.find((a) => a.number === '68100')?.category_count).toBe(1);
    expect(after.find((a) => a.number === '67500')?.category_count).toBe(0);
  });
});

describe('CSV import', () => {
  it('imports a small tree and derives the rollup', async () => {
    const csv = [
      'number,name,type,parent_number',
      '60000,Operating Expenses,expense,',
      '68000,Travel M&E,expense,60000',
      '68100,Travel,expense,68000',
    ].join('\n');
    const { created } = await withOrg(orgId, (tx) => accounts.importFromCsv(tx, csv));
    expect(created).toBe(3);
    const all = await withOrg(orgId, (tx) => accounts.listAccounts(tx));
    expect(all.map((a) => `${a.number}:${a.is_postable}`)).toEqual([
      '60000:false',
      '68000:false',
      '68100:true',
    ]);
    expect(all.find((a) => a.number === '68100')?.parent_number).toBe('68000');
    expect(all.every((a) => a.source === 'IMPORT')).toBe(true);
  });

  it('imports nothing at all when one row is bad', async () => {
    const csv = ['number,name,type', '68100,Travel,expense', '68200,,expense'].join('\n');
    await expect(
      withOrg(orgId, (tx) => accounts.importFromCsv(tx, csv)),
    ).rejects.toMatchObject({ code: 'INVALID_CSV' });
    const all = await withOrg(orgId, (tx) => accounts.listAccounts(tx));
    expect(all).toEqual([]);
  });

  it('carries the line-numbered errors so a screen can list them', async () => {
    const csv = ['number,name,type', '68100,Travel,nonsense'].join('\n');
    const err = await withOrg(orgId, (tx) => accounts.importFromCsv(tx, csv)).catch((e) => e);
    expect(err.errors[0]).toMatchObject({ lineNumber: 2, field: 'type' });
  });

  it('refuses an import over an existing chart', async () => {
    await withOrg(orgId, (tx) => accounts.instantiateTemplate(tx, TEMPLATE));
    await expect(
      withOrg(orgId, (tx) => accounts.importFromCsv(tx, 'number,name,type\n1,A,expense')),
    ).rejects.toMatchObject({ code: 'ALREADY_POPULATED' });
  });
});
