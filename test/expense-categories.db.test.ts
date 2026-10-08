/**
 * Wave 0 — ExpenseOS's expense-category router, ported, against a real database.
 *
 * `server/routers/expenseCategories.test.ts` is ExpenseOS's unit suite (a stub `db`, a
 * mocked `withAudit`). This one proves what only Postgres can:
 *
 *   · the ported `withAudit` writes into VeloExpense's per-tenant audit chain, and the
 *     chain still verifies — interleaved with rows VeloExpense's own `append` writes;
 *   · a procedure that is refused writes nothing, audit row included;
 *   · migration 0045's shape: the name is `{ en }` JSON, a category created without a
 *     code is given one, and the table refuses what the router would refuse;
 *   · tenancy: a tenant neither lists nor edits another's categories;
 *   · the kind guard on REAL filed line items (`_count.lineItems`);
 *   · the GL account picker offers only this tenant's active, postable accounts.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { TRPCError } from '@trpc/server';

vi.mock('@/auth', () => ({ auth: vi.fn(async () => null) }));
vi.mock('@/lib/tenant/request', () => ({ hostTenantSlug: async () => null }));

const { createOrganization } = await import('@/lib/onboarding/provision');
const { createCallerFactory } = await import('@/server/trpc');
const { appRouter } = await import('@/server/routers/_app');
const { db } = await import('@/lib/db/prisma');
const { withOrg } = await import('@/lib/tenant/context');
const { verifyChain } = await import('@/lib/audit/verify');
const { append } = await import('@/lib/audit/service');

const admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL });

let A: string;
let B: string;
let adminA: string;
let postable: string;
let heading: string;

const as = (email: string, organizationId: string) =>
  createCallerFactory(appRouter)({ session: null, db, rbac: null, caller: { email, organizationId } });

const codeOf = (p: Promise<unknown>) =>
  p.then(
    () => 'OK',
    (e: unknown) => (e instanceof TRPCError ? e.code : String(e)),
  );

const auditRows = async (org: string) =>
  (
    await admin.query(
      `SELECT action, entity_type, entity_id, actor_id, actor_role, details
         FROM audit_entry WHERE organization_id = $1 ORDER BY sequence`,
      [org],
    )
  ).rows;

const verified = (org: string) => withOrg(org, (tx) => verifyChain(tx));

const NEW = {
  label: { en: 'Client dinners' },
  itcGstHstRate: 50,
  itcQstRate: 50,
  pstRecoverable: false,
  requiresAttendees: true,
  kind: 'standard-with-tip' as const,
  active: true,
};

beforeAll(async () => {
  await admin.query('TRUNCATE invite, audit_entry, app_user, organization CASCADE');
  A = (await createOrganization({ name: 'Alpha Cat', slug: 'alpha-cat', adminEmail: 'boss@alpha.test', adminName: 'Boss' }))
    .organizationId;
  B = (await createOrganization({ name: 'Beta Cat', slug: 'beta-cat', adminEmail: 'boss@beta.test', adminName: 'Other' }))
    .organizationId;
  adminA = (await admin.query("SELECT id FROM app_user WHERE email = 'boss@alpha.test'")).rows[0].id;
  // VX4-1: the chart of accounts is visible only with the accounting module on (RLS on
  // gl_account), so a tenant without it has nothing to pick. Alpha has it; Beta does not.
  await admin.query(
    `INSERT INTO module_entitlement (organization_id, module_code, enabled) VALUES ($1, 'accounting', true)`,
    [A],
  );
  await admin.query(
    `INSERT INTO app_user (organization_id, email, display_name, role) VALUES ($1, 'emp@alpha.test', 'Emp', 'EMPLOYEE')`,
    [A],
  );
  heading = (
    await admin.query(
      `INSERT INTO gl_account (organization_id, number, name, type, is_postable)
       VALUES ($1, '6000', 'Travel & meals (heading)', 'expense', false) RETURNING id`,
      [A],
    )
  ).rows[0].id;
  postable = (
    await admin.query(
      `INSERT INTO gl_account (organization_id, parent_id, number, name, type)
       VALUES ($1, $2, '6100', 'Meals', 'expense') RETURNING id`,
      [A, heading],
    )
  ).rows[0].id;
  await admin.query(
    `INSERT INTO gl_account (organization_id, number, name, type, active)
     VALUES ($1, '6101', 'Meals (retired)', 'expense', false)`,
    [A],
  );
  await admin.query(
    `INSERT INTO gl_account (organization_id, number, name, type) VALUES ($1, '6102', 'Meals of Beta', 'expense')`,
    [B],
  );
});

afterAll(async () => {
  await admin.end();
});

describe('create', () => {
  it('writes the category and an audit row into the tenant’s chain, which still verifies', async () => {
    const created = await as('boss@alpha.test', A).expenseCategories.create({ ...NEW, glAccountId: postable });
    const row = (await admin.query('SELECT * FROM expense_category WHERE id = $1', [created.id])).rows[0];
    expect(row.label).toEqual({ en: 'Client dinners' });
    // ExpenseOS's create sends no code; VeloExpense mints one (migration 0045).
    expect(row.code).toMatch(/^c-[0-9a-f]{8}$/);
    expect(row).toMatchObject({
      organization_id: A,
      gl_account_id: postable,
      itc_gst_hst_rate: 50,
      requires_attendees: true,
      accepts_tip: true,
      is_mileage: false,
    });
    const audits = await auditRows(A);
    expect(audits.at(-1)).toMatchObject({
      action: 'EXPENSE_CATEGORY_CREATED',
      entity_type: 'ExpenseCategory',
      entity_id: created.id,
      actor_id: adminA,
      // The member's VeloExpense role, read from the row — not ExpenseOS's role label.
      actor_role: 'ADMIN',
      details: { label: { en: 'Client dinners' } },
    });
    expect(await verified(A)).toMatchObject({ ok: true });
  });

  it('appends after the last of this tenant’s rows, whichever writer wrote it', async () => {
    // VeloExpense's own writer, then the ported one, then VeloExpense's again.
    await withOrg(A, (tx) =>
      append(tx, { id: adminA, name: 'Boss', role: 'ADMIN' }, { action: 'MODULE_ENABLED', details: { module: 'x' } }),
    );
    await as('boss@alpha.test', A).expenseCategories.create({ ...NEW, label: { en: 'Parking' } });
    await withOrg(A, (tx) =>
      append(tx, { id: adminA, name: 'Boss', role: 'ADMIN' }, { action: 'MODULE_DISABLED', details: { module: 'x' } }),
    );
    expect(await verified(A)).toMatchObject({ ok: true });
  });

  it('appends after the previous row on its own chain, never another tenant’s', async () => {
    await as('boss@beta.test', B).expenseCategories.create({ ...NEW, label: { en: 'Beta only' } });
    expect(await verified(B)).toMatchObject({ ok: true });
    expect(await verified(A)).toMatchObject({ ok: true });
  });

  it('is refused for a non-postable account, writing neither the row nor an audit entry', async () => {
    const before = (await auditRows(A)).length;
    expect(
      await codeOf(as('boss@alpha.test', A).expenseCategories.create({ ...NEW, label: { en: 'Nope' }, glAccountId: heading })),
    ).not.toBe('OK');
    expect((await admin.query("SELECT 1 FROM expense_category WHERE label ->> 'en' = 'Nope'")).rowCount).toBe(0);
    expect((await auditRows(A)).length).toBe(before);
  });

  it('is refused for an employee', async () => {
    expect(await codeOf(as('emp@alpha.test', A).expenseCategories.create(NEW))).toBe('FORBIDDEN');
  });

  it('appends to the end of the manual order', async () => {
    const { categories } = await as('boss@alpha.test', A).expenseCategories.list();
    const orders = categories.map((c) => c.sortOrder);
    expect(orders).toEqual([...orders].sort((a, b) => a - b));
    expect(categories.at(-1)?.label).toEqual({ en: 'Parking' });
  });
});

describe('list', () => {
  it('lists only this tenant’s categories, with the GL account flattened', async () => {
    const { categories } = await as('boss@alpha.test', A).expenseCategories.list();
    expect(categories.some((c) => c.label.en === 'Beta only')).toBe(false);
    const dinners = categories.find((c) => c.label.en === 'Client dinners');
    expect(dinners).toMatchObject({
      glAccountNumber: '6100',
      glAccountName: 'Meals',
      _count: { lineItems: 0 },
    });
  });
});

describe('update', () => {
  const idOf = async (en: string) =>
    (await admin.query(`SELECT id FROM expense_category WHERE label ->> 'en' = $1`, [en])).rows[0].id as string;

  it('records only what changed, as from/to, and the chain verifies', async () => {
    const id = await idOf('Client dinners');
    await as('boss@alpha.test', A).expenseCategories.update({ id, label: { en: 'Team dinners' }, itcGstHstRate: 50 });
    expect((await auditRows(A)).at(-1)).toMatchObject({
      action: 'EXPENSE_CATEGORY_UPDATED',
      entity_id: id,
      details: {
        changed: { label: { from: { en: 'Client dinners' }, to: { en: 'Team dinners' } } },
        fields: ['label'],
        unchanged: false,
      },
    });
    expect(await verified(A)).toMatchObject({ ok: true });
  });

  it('cannot reach another tenant’s category', async () => {
    const id = await idOf('Beta only');
    expect(await codeOf(as('boss@alpha.test', A).expenseCategories.update({ id, active: false }))).toBe('NOT_FOUND');
    expect((await admin.query('SELECT active FROM expense_category WHERE id = $1', [id])).rows[0].active).toBe(true);
  });

  it('refuses crossing the mileage boundary once a line is filed, and writes nothing', async () => {
    const id = await idOf('Team dinners');
    const report = await admin.query(
      `INSERT INTO expense_report (organization_id, submitter_id, title, currency_code)
       VALUES ($1, $2, 'Lunch', 'CAD') RETURNING id`,
      [A, adminA],
    );
    const exp = await admin.query(
      `INSERT INTO expense (organization_id, report_id, merchant, txn_date, currency_code)
       VALUES ($1, $2, 'Diner', current_date, 'CAD') RETURNING id`,
      [A, report.rows[0].id],
    );
    await admin.query(
      `INSERT INTO expense_line_item (organization_id, expense_id, category_id, amount_minor) VALUES ($1, $2, $3, 1200)`,
      [A, exp.rows[0].id, id],
    );
    const before = (await auditRows(A)).length;
    expect(await codeOf(as('boss@alpha.test', A).expenseCategories.update({ id, kind: 'mileage' }))).toBe(
      'PRECONDITION_FAILED',
    );
    expect((await admin.query('SELECT is_mileage FROM expense_category WHERE id = $1', [id])).rows[0].is_mileage).toBe(
      false,
    );
    expect((await auditRows(A)).length).toBe(before);
    // A tip is not guarded: it changes what the editor offers, and restates nothing filed.
    expect(await codeOf(as('boss@alpha.test', A).expenseCategories.update({ id, kind: 'standard' }))).toBe('OK');
  });
});

describe('reorder', () => {
  it('writes each id’s position as its sort order, and ignores an id from another tenant', async () => {
    const { categories } = await as('boss@alpha.test', A).expenseCategories.list();
    const ids = categories.map((c) => c.id).reverse();
    const foreign = (await admin.query(`SELECT id FROM expense_category WHERE label ->> 'en' = 'Beta only'`)).rows[0]
      .id as string;
    const foreignOrder = (await admin.query('SELECT sort_order FROM expense_category WHERE id = $1', [foreign])).rows[0]
      .sort_order;
    await as('boss@alpha.test', A).expenseCategories.reorder({ ids: [...ids, foreign] });
    const after = await as('boss@alpha.test', A).expenseCategories.list();
    expect(after.categories.map((c) => c.id)).toEqual(ids);
    expect((await admin.query('SELECT sort_order FROM expense_category WHERE id = $1', [foreign])).rows[0].sort_order).toBe(
      foreignOrder,
    );
    expect(await verified(A)).toMatchObject({ ok: true });
  });
});

describe('the GL account picker', () => {
  it('offers this tenant’s active, postable accounts only', async () => {
    const rows = await as('emp@alpha.test', A).pickers.glAccounts.search({ q: 'meal' });
    expect(rows).toEqual([{ value: postable, label: '6100 · Meals' }]);
  });

  it('offers nothing to a tenant without the accounting module, whose chart is not visible', async () => {
    expect(await as('boss@beta.test', B).pickers.glAccounts.search({ q: 'meal' })).toEqual([]);
  });
});

describe('the table, without the router', () => {
  it('refuses what the router would refuse', async () => {
    const bad = (sql: string) =>
      withOrg(A, (tx) => tx.query(sql)).then(
        () => 'OK',
        (e: { code?: string }) => e.code,
      );
    // check_violation
    expect(await bad(`INSERT INTO expense_category (label) VALUES ('{"fr-CA":"Seulement"}')`)).toBe('23514');
    expect(await bad(`INSERT INTO expense_category (label, color) VALUES ('{"en":"X"}', 'red')`)).toBe('23514');
    expect(await bad(`INSERT INTO expense_category (label, itc_qst_rate) VALUES ('{"en":"X"}', 101)`)).toBe('23514');
    expect(
      await bad(`INSERT INTO expense_category (label, is_mileage, accepts_tip) VALUES ('{"en":"X"}', true, true)`),
    ).toBe('23514');
  });
});
