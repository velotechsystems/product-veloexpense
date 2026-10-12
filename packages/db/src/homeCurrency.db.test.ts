// @vitest-environment node
/* eslint-disable @typescript-eslint/no-explicit-any -- the harness reads rows untyped. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTenantHarness, type TenantHarness } from '../../../server/__test-helpers__/tenantHarness';

/**
 * VeloExpense (f29): ONE home-currency rule, for the currency a report started from receipts
 * opens in (`resolveIntakeCurrencyId`) and the currency a reader's totals are converted into
 * (`readerCurrencyCode`). Found on dev: a person with no legal entity got USD reports read
 * in CAD, so every total said "no exchange rate".
 *
 * Gated on DATABASE_URL; the hermetic CI run skips it.
 */

vi.mock('@/auth', () => ({ auth: vi.fn(async () => null) }));
vi.mock('@/lib/tenant/request', () => ({ hostTenantSlug: async () => null }));

describe.skipIf(!process.env.DATABASE_URL)('homeCurrencyCode (integration)', () => {
  let h: TenantHarness;
  let personId: string;
  const run = <T>(fn: (db: any) => Promise<T>) => fn(h.db);

  let n = 0;
  const addEntity = async (code: string, opts: { active?: boolean; ageDays?: number } = {}) =>
    (
      await h.admin.query(
        `INSERT INTO legal_entity (organization_id, label, currency_code, active, created_at)
         VALUES ($1, $2, $3, $4, now() - make_interval(days => $5)) RETURNING id`,
        [h.orgId, JSON.stringify({ en: `Entity ${code} ${++n}` }), code, opts.active ?? true, opts.ageDays ?? 0],
      )
    ).rows[0].id as string;

  beforeAll(async () => {
    h = await createTenantHarness({
      slug: 'home-currency',
      name: 'Home Currency',
      people: [{ email: 'nobody@home-currency.example', name: 'No Entity' }],
    });
    personId = h.people[1].id;
  });

  beforeEach(async () => {
    await h.admin.query(`UPDATE app_user SET legal_entity_id = NULL WHERE organization_id = $1`, [h.orgId]);
    await h.admin.query(`DELETE FROM legal_entity WHERE organization_id = $1`, [h.orgId]);
  });

  afterAll(async () => {
    await h?.end();
  });

  it('is CAD only when the tenant has no legal entity with a currency', async () => {
    const { homeCurrencyCode, resolveIntakeCurrencyId } = await import('@expenseos/db');
    const { readerCurrencyCode } = await import('@/server/lib/readerCurrency');
    expect(await run((db) => homeCurrencyCode(db, personId))).toBe('CAD');
    expect(await run((db) => resolveIntakeCurrencyId(db, { userId: personId }))).toBe('CAD');
    expect(await run((db) => readerCurrencyCode(db, personId))).toBe('CAD');
  });

  it("falls back to the tenant's main (oldest active) entity, for both questions alike", async () => {
    // The test database carries CAD and USD only, so USD is the answer that proves the rule.
    await addEntity('CAD', { active: false, ageDays: 30 }); // inactive: never the main one
    await addEntity('USD', { ageDays: 20 }); // the oldest ACTIVE one
    await addEntity('CAD', { ageDays: 10 });
    const { resolveIntakeCurrencyId } = await import('@expenseos/db');
    const { readerCurrencyCode } = await import('@/server/lib/readerCurrency');
    // The bug was these two disagreeing: USD to start a report, CAD to read it.
    expect(await run((db) => resolveIntakeCurrencyId(db, { userId: personId }))).toBe('USD');
    expect(await run((db) => readerCurrencyCode(db, personId))).toBe('USD');
  });

  it("uses the person's own entity first, as before", async () => {
    await addEntity('USD', { ageDays: 20 });
    const own = await addEntity('CAD', { ageDays: 1 });
    await h.admin.query(`UPDATE app_user SET legal_entity_id = $1 WHERE id = $2`, [own, personId]);
    const { resolveIntakeCurrencyId } = await import('@expenseos/db');
    const { readerCurrencyCode } = await import('@/server/lib/readerCurrency');
    expect(await run((db) => resolveIntakeCurrencyId(db, { userId: personId }))).toBe('CAD');
    expect(await run((db) => readerCurrencyCode(db, personId))).toBe('CAD');
  });

  it('still honours an explicit choice', async () => {
    await addEntity('CAD');
    const { resolveIntakeCurrencyId } = await import('@expenseos/db');
    expect(await run((db) => resolveIntakeCurrencyId(db, { userId: personId, requested: 'usd' }))).toBe('USD');
  });
});
