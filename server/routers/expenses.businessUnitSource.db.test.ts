// @vitest-environment node
/* eslint-disable @typescript-eslint/no-explicit-any -- VeloExpense: ExpenseOS's suite reads its rows untyped (`db: any`); Biome allows it there. */
import { permissions as P } from '@expenseos/rbac';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTenantHarness, type TenantHarness } from '../__test-helpers__/tenantHarness';

/**
 * `dimensionOptions` under each business unit source, against a real database.
 *
 * The source is read off the stored NetSuite config on every call, and `dimensionOptions`
 * is the only place the client learns it (NFR-16). So what is pinned here is the
 * discriminated union — one `businessUnits` shape per source, with the source beside it —
 * and that the answer follows the stored config from one call to the next rather than
 * being remembered.
 *
 * VeloExpense: ExpenseOS's `expenses.businessUnitSource.db.test.ts`, its one case that
 * holds without NetSuite: "reads EXPENSEOS where NetSuite is not configured". VeloExpense
 * has no NetSuite config, so the other four — a config naming a source, the NETSUITE rows,
 * following the config between calls — have nothing to read. The harness is VeloExpense's
 * (`createTenantHarness`: the suite's own tenant and business units, under RLS).
 */

// VeloExpense: Auth.js and the host's tenant, in place of ExpenseOS's auth and RBAC
// resolver; there is no `loadNetSuiteConfig` to mock.
vi.mock('@/auth', () => ({ auth: vi.fn(async () => null) }));
vi.mock('@/lib/tenant/request', () => ({ hostTenantSlug: async () => null }));

describe.skipIf(!process.env.DATABASE_URL)('dimensionOptions by business unit source', () => {
  let h: TenantHarness;
  let db: any;
  let options: () => Promise<any>;

  beforeAll(async () => {
    h = await createTenantHarness({ slug: 'bu-source', name: 'BU Source' });
    db = h.db;
    const caller = h.makeCaller([P.expense.report.readOwn], h.people[0].id);
    options = () => caller.dimensionOptions();
    // VeloExpense: this suite's own business units — two active, one deactivated, which
    // the list must leave out (ExpenseOS reads seeded ones).
    await db.businessUnit.create({ data: { label: { en: 'Source A' } } });
    await db.businessUnit.create({ data: { label: { en: 'Source B' } } });
    await db.businessUnit.create({ data: { label: { en: 'Source retired' }, active: false } });
  });

  afterAll(async () => {
    // VeloExpense: the next suite truncates the tenants; only the pool is ours to close.
    await h?.end();
  });

  /** Exactly today's admin shape: the active admin business units, `{ id, label }`. */
  const adminRows = () =>
    db.businessUnit.findMany({ where: { active: true }, select: { id: true, label: true } });

  it('reads EXPENSEOS where NetSuite is not configured, and lists the admin business units', async () => {
    const out = await options();
    expect(out.businessUnitSource).toBe('EXPENSEOS');
    expect(out.businessUnits).toEqual(await adminRows());
    expect(out.businessUnits.length).toBeGreaterThan(0);
  });
});
