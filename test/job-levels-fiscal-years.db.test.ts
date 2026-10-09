/**
 * Wave 1 — ExpenseOS's job-level and fiscal-year routers (`appSettings.jobLevels`,
 * `appSettings.fiscalYears`), ported, against a real database (migration 0050).
 *
 * Proves what only Postgres can:
 *
 *   · job levels: the ladder order is assigned on create, External IDs round-trip, a
 *     level somebody holds cannot be deleted, and an unheld one can;
 *   · fiscal years: the dates are calendar days (`date`) and come back as the same UTC
 *     midnights ExpenseOS's screen sends; "one current year" holds through create,
 *     update, `setCurrent` and `advanceCurrent`, and the table guarantees it too; the
 *     current year cannot be deleted;
 *   · audit rows under the registry's names, and a chain that verifies;
 *   · tenancy and permissions.
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

const admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL });

let A: string;
let B: string;

const as = (email: string, organizationId: string) =>
  createCallerFactory(appRouter)({ session: null, db, rbac: null, caller: { email, organizationId } });
const boss = () => as('boss@alpha.test', A);

const codeOf = (p: Promise<unknown>) =>
  p.then(
    () => 'OK',
    (e: unknown) => (e instanceof TRPCError ? e.code : String(e)),
  );

/** What FiscalYearsAdmin sends: the picked day at UTC midnight. */
const day = (d: string) => new Date(`${d}T00:00:00Z`);
const isoDay = (d: Date) => d.toISOString().slice(0, 10);

beforeAll(async () => {
  await admin.query('TRUNCATE invite, audit_entry, app_user, organization CASCADE');
  A = (await createOrganization({ name: 'Alpha JF', slug: 'alpha-jf', adminEmail: 'boss@alpha.test', adminName: 'Boss' }))
    .organizationId;
  B = (await createOrganization({ name: 'Beta JF', slug: 'beta-jf', adminEmail: 'boss@beta.test', adminName: 'Other' }))
    .organizationId;
  await admin.query(
    `INSERT INTO app_user (organization_id, email, display_name, role) VALUES ($1, 'emp@alpha.test', 'Emp', 'EMPLOYEE')`,
    [A],
  );
});

afterAll(async () => {
  await admin.end();
});

describe('job levels', () => {
  it('orders the ladder on create, round-trips External IDs, and audits into a chain that verifies', async () => {
    const c = boss();
    const ic = await c.appSettings.jobLevels.create({
      code: 'IC1',
      track: 'INDIVIDUAL_CONTRIBUTOR',
      label: { en: 'Engineer' },
      externalIds: { hris: 'L1' },
    });
    const mgr = await c.appSettings.jobLevels.create({ code: 'M1', track: 'MANAGER', label: { en: 'Manager' } });
    expect(mgr.sortOrder).toBe(ic.sortOrder + 1);

    const list = await c.appSettings.jobLevels.list();
    expect(list.map((r) => r.code)).toEqual(['IC1', 'M1']);
    expect(list[0]).toMatchObject({ label: { en: 'Engineer' }, externalIds: { hris: 'L1' }, active: true });

    const renamed = await c.appSettings.jobLevels.update({
      id: ic.id,
      patch: { label: { en: 'Software Engineer' }, externalIds: {} },
    });
    expect(renamed.label).toEqual({ en: 'Software Engineer' });
    expect((await c.appSettings.jobLevels.list())[0].externalIds).toEqual({});

    const audit = (
      await admin.query(`SELECT action, entity_type FROM audit_entry WHERE entity_id = $1 ORDER BY sequence`, [ic.id])
    ).rows;
    expect(audit).toEqual([
      { action: 'JOB_LEVEL_CREATED', entity_type: 'JobLevel' },
      { action: 'JOB_LEVEL_UPDATED', entity_type: 'JobLevel' },
    ]);
    expect((await withOrg(A, (tx) => verifyChain(tx))).ok).toBe(true);
  });

  it('refuses a malformed code and an unknown track; the table refuses them too', async () => {
    const c = boss();
    expect(
      await codeOf(c.appSettings.jobLevels.create({ code: 'has space', track: 'MANAGER', label: { en: 'X' } })),
    ).toBe('BAD_REQUEST');
    expect(
      await codeOf(
        c.appSettings.jobLevels.create({ code: 'X1', track: 'INTERN' as never, label: { en: 'X' } }),
      ),
    ).toBe('BAD_REQUEST');
    await expect(
      admin.query(
        `INSERT INTO job_level (organization_id, code, track, label, sort_order) VALUES ($1, 'X1', 'INTERN', '{"en":"X"}', 1)`,
        [A],
      ),
    ).rejects.toThrow(/job_level_track/);
  });

  it('refuses to delete a level somebody holds, and deletes one nobody does', async () => {
    const c = boss();
    const held = await c.appSettings.jobLevels.create({ code: 'E1', track: 'EXECUTIVE', label: { en: 'VP' } });
    await admin.query(`UPDATE app_user SET job_level_id = $1 WHERE email = 'emp@alpha.test'`, [held.id]);
    expect(await codeOf(c.appSettings.jobLevels.delete({ id: held.id }))).toBe('BAD_REQUEST');
    expect((await admin.query('SELECT count(*)::int AS n FROM job_level WHERE id = $1', [held.id])).rows[0].n).toBe(1);

    await admin.query(`UPDATE app_user SET job_level_id = NULL WHERE email = 'emp@alpha.test'`);
    expect(await c.appSettings.jobLevels.delete({ id: held.id })).toEqual({ ok: true });
    expect((await admin.query('SELECT count(*)::int AS n FROM job_level WHERE id = $1', [held.id])).rows[0].n).toBe(0);
    expect(
      (await admin.query(`SELECT action FROM audit_entry WHERE entity_id = $1 ORDER BY sequence`, [held.id])).rows.map(
        (r) => r.action,
      ),
    ).toEqual(['JOB_LEVEL_CREATED', 'JOB_LEVEL_DELETED']);
  });
});

describe('fiscal years', () => {
  it('stores calendar days and returns the same UTC midnights the screen sent', async () => {
    const c = boss();
    const fy = await c.appSettings.fiscalYears.create({
      label: { en: 'FY2025' },
      startDate: day('2025-04-01'),
      endDate: day('2026-03-31'),
      externalIds: { ledger: 'FY25' },
    });
    expect(isoDay(fy.startDate)).toBe('2025-04-01');
    expect(fy.endDate.toISOString()).toBe('2026-03-31T00:00:00.000Z');
    const row = (
      await admin.query(`SELECT start_date::text AS s, end_date::text AS e FROM fiscal_year WHERE id = $1`, [fy.id])
    ).rows[0];
    expect(row).toEqual({ s: '2025-04-01', e: '2026-03-31' });
    expect((await c.appSettings.fiscalYears.list()).find((r) => r.id === fy.id)?.externalIds).toEqual({
      ledger: 'FY25',
    });
  });

  it('refuses an end on or before the start; the table refuses it too', async () => {
    const c = boss();
    expect(
      await codeOf(
        c.appSettings.fiscalYears.create({ label: { en: 'Bad' }, startDate: day('2030-01-01'), endDate: day('2030-01-01') }),
      ),
    ).toBe('BAD_REQUEST');
    await expect(
      admin.query(
        `INSERT INTO fiscal_year (organization_id, label, start_date, end_date) VALUES ($1, '{"en":"Bad"}', '2030-02-01', '2030-01-01')`,
        [A],
      ),
    ).rejects.toThrow(/fiscal_year_dates/);
  });

  it('keeps exactly one current year through create, update and setCurrent', async () => {
    const c = boss();
    const currentIds = async () =>
      (await admin.query('SELECT id FROM fiscal_year WHERE organization_id = $1 AND is_current', [A])).rows.map(
        (r) => r.id,
      );
    const y27 = await c.appSettings.fiscalYears.create({
      label: { en: 'FY2027' },
      startDate: day('2027-01-01'),
      endDate: day('2027-12-31'),
      isCurrent: true,
    });
    expect(await currentIds()).toEqual([y27.id]);

    const y28 = await c.appSettings.fiscalYears.create({
      label: { en: 'FY2028' },
      startDate: day('2028-01-01'),
      endDate: day('2028-12-31'),
      isCurrent: true,
    });
    expect(await currentIds()).toEqual([y28.id]);

    await c.appSettings.fiscalYears.update({ id: y27.id, patch: { isCurrent: true } });
    expect(await currentIds()).toEqual([y27.id]);

    await c.appSettings.fiscalYears.setCurrent({ id: y28.id });
    expect(await currentIds()).toEqual([y28.id]);
    expect((await c.appSettings.fiscalYears.current())?.id).toBe(y28.id);

    // The table holds it even for a writer that skips the router's flip.
    await expect(admin.query('UPDATE fiscal_year SET is_current = true WHERE id = $1', [y27.id])).rejects.toThrow(
      /fiscal_year_one_current/,
    );
    // …and only within a tenant: another tenant keeps a current year of its own.
    const beta = await as('boss@beta.test', B).appSettings.fiscalYears.create({
      label: { en: 'Beta FY' },
      startDate: day('2028-01-01'),
      endDate: day('2028-12-31'),
      isCurrent: true,
    });
    expect(beta.isCurrent).toBe(true);
    expect(await currentIds()).toEqual([y28.id]);
  });

  it('refuses to delete the current year, and deletes another', async () => {
    const c = boss();
    const current = await c.appSettings.fiscalYears.current();
    expect(current).not.toBeNull();
    expect(await codeOf(c.appSettings.fiscalYears.delete({ id: current!.id }))).toBe('BAD_REQUEST');

    const spare = await c.appSettings.fiscalYears.create({
      label: { en: 'Spare' },
      startDate: day('2040-01-01'),
      endDate: day('2040-12-31'),
    });
    expect(await c.appSettings.fiscalYears.delete({ id: spare.id })).toEqual({ ok: true });
    expect(
      (await admin.query(`SELECT action FROM audit_entry WHERE entity_id = $1 ORDER BY sequence`, [spare.id])).rows.map(
        (r) => r.action,
      ),
    ).toEqual(['FISCAL_YEAR_CREATED', 'FISCAL_YEAR_DELETED']);
  });

  it('advanceCurrent moves "current" to the year covering today, once', async () => {
    const c = boss();
    const today = new Date();
    const y = today.getUTCFullYear();
    // A year that covers today, not current; the current one (FY2028) does not cover it.
    const covering = await c.appSettings.fiscalYears.create({
      label: { en: 'Today’s year' },
      startDate: day(`${y - 1}-07-01`) < today && today < day(`${y}-07-01`) ? day(`${y - 1}-07-01`) : day(`${y}-07-01`),
      endDate: day(`${y - 1}-07-01`) < today && today < day(`${y}-07-01`) ? day(`${y}-06-30`) : day(`${y + 1}-06-30`),
    });
    const first = await c.appSettings.fiscalYears.advanceCurrent();
    expect(first).toEqual({ ok: true, changed: true, currentId: covering.id });
    expect((await c.appSettings.fiscalYears.current())?.id).toBe(covering.id);

    const again = await c.appSettings.fiscalYears.advanceCurrent();
    expect(again).toEqual({ ok: true, changed: false, currentId: covering.id });
    expect(
      (
        await admin.query(
          `SELECT details FROM audit_entry WHERE entity_id = $1 AND action = 'FISCAL_YEAR_SET_CURRENT'`,
          [covering.id],
        )
      ).rows,
    ).toEqual([{ details: { via: 'advanceCurrent' } }]);
    expect((await withOrg(A, (tx) => verifyChain(tx))).ok).toBe(true);
  });
});

describe('tenancy and permissions', () => {
  it('lists only the tenant’s own levels and years, and cannot touch another tenant’s', async () => {
    const betaLevel = await as('boss@beta.test', B).appSettings.jobLevels.create({
      code: 'IC1',
      track: 'INDIVIDUAL_CONTRIBUTOR',
      label: { en: 'Beta engineer' },
    });
    const alphaLevels = await boss().appSettings.jobLevels.list();
    expect(alphaLevels.map((r) => r.id)).not.toContain(betaLevel.id);
    // The same code in another tenant is fine: codes are unique per tenant.
    expect(alphaLevels.map((r) => r.code)).toContain('IC1');

    const betaYear = (await as('boss@beta.test', B).appSettings.fiscalYears.list())[0] as { id: string };
    expect((await boss().appSettings.fiscalYears.list()).map((r) => r.id)).not.toContain(betaYear.id);

    // VeloExpense: RLS hides the row, so each write answers NOT_FOUND (ExpenseOS: a 500).
    const alphaCurrent = (await boss().appSettings.fiscalYears.current())?.id;
    expect(
      await codeOf(boss().appSettings.jobLevels.update({ id: betaLevel.id, patch: { label: { en: 'Stolen' } } })),
    ).toBe('NOT_FOUND');
    expect(await codeOf(boss().appSettings.jobLevels.delete({ id: betaLevel.id }))).toBe('NOT_FOUND');
    expect(await codeOf(boss().appSettings.fiscalYears.update({ id: betaYear.id, patch: { closed: true } }))).toBe(
      'NOT_FOUND',
    );
    expect(await codeOf(boss().appSettings.fiscalYears.setCurrent({ id: betaYear.id }))).toBe('NOT_FOUND');
    expect(await codeOf(boss().appSettings.fiscalYears.delete({ id: betaYear.id }))).toBe('NOT_FOUND');
    // The refused setCurrent rolled back its flip: Alpha keeps the year it had.
    expect((await boss().appSettings.fiscalYears.current())?.id).toBe(alphaCurrent);
    expect(
      (await admin.query(`SELECT label ->> 'en' AS en FROM job_level WHERE id = $1`, [betaLevel.id])).rows[0].en,
    ).toBe('Beta engineer');
  });

  it('VeloExpense: answers a duplicate code with CONFLICT, and a patched end before the stored start with BAD_REQUEST', async () => {
    expect(
      await codeOf(boss().appSettings.jobLevels.create({ code: 'IC1', track: 'MANAGER', label: { en: 'Dup' } })),
    ).toBe('CONFLICT');
    const later = await boss().appSettings.fiscalYears.create({
      label: { en: 'Later' },
      startDate: day('2050-01-01'),
      endDate: day('2050-12-31'),
    });
    expect(
      await codeOf(boss().appSettings.fiscalYears.update({ id: later.id, patch: { endDate: day('2049-06-30') } })),
    ).toBe('BAD_REQUEST');
  });

  it('refuses an employee', async () => {
    const emp = as('emp@alpha.test', A);
    expect(await codeOf(emp.appSettings.jobLevels.list())).toBe('FORBIDDEN');
    expect(await codeOf(emp.appSettings.fiscalYears.list())).toBe('FORBIDDEN');
    expect(await codeOf(emp.appSettings.fiscalYears.advanceCurrent())).toBe('FORBIDDEN');
  });
});
