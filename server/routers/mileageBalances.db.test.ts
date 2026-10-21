// @vitest-environment node
/* eslint-disable @typescript-eslint/no-explicit-any -- VeloExpense: ExpenseOS's suite reads its rows untyped (`db: any`); Biome allows it there. */
import { permissions as P } from '@expenseos/rbac';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTenantHarness, type TenantHarness } from '../__test-helpers__/tenantHarness';
import { makeContext } from '../__test-helpers__/trpcCaller';

/**
 * Mileage opening balances (Concur year-to-date uploads), against a real database.
 *
 * What is pinned:
 *   · `preview` matches names, reads the previous upload, detects car allowances and flags
 *     odd rows — and writes nothing;
 *   · `commit` refuses what it must, supersedes the upload in force, keeps the CA
 *     car-allowance rules in step with the file, re-prices DRAFT/RETURNED mileage of
 *     everybody whose basis moved (never a SUBMITTED report), recomputes totals and leaves
 *     one audit row;
 *   · the read endpoints' shapes.
 *
 * The router is hard-wired to CA (the file is Canadian) and its country-default bands, so the
 * suite uses the seeded CA rule (72¢ to 5,000 km, 66¢ after) and its own people, named with a
 * random suffix so the matcher — which looks at every user — cannot meet anybody else.
 * Every car-allowance scenario starts from no CA allowance rule for these people.
 *
 * Ported from ExpenseOS 67db2e33 (#589, #596). VeloExpense: each describe runs on its own
 * tenant (`createTenantHarness`) in place of ExpenseOS's seeded test client, so the CA
 * country default (72¢ to 5,000 km, 66¢ after) is created here rather than read from the
 * seed; its own mileage category; the currency is its ISO code; the audit row is
 * VeloExpense's `audit_entry` (`MILEAGE_BALANCES_IMPORTED`, ExpenseOS's
 * `config.mileageBalanceImport.update`); every call runs under RLS.
 */

vi.mock('@/auth', () => ({ auth: vi.fn(async () => null) }));
vi.mock('@/lib/tenant/request', () => ({ hostTenantSlug: async () => null }));

/** VeloExpense: the upload's audit row, read off `audit_entry` (ExpenseOS: `db.audit`). */
const auditRows = async (h: TenantHarness, entityId: string) =>
  (
    await h.admin.query(
      `SELECT action, entity_type AS "entityType", entity_id AS "entityId", actor_id AS "actorId", details
         FROM audit_entry WHERE action = 'MILEAGE_BALANCES_IMPORTED' AND entity_id = $1
        ORDER BY sequence`,
      [entityId],
    )
  ).rows;

const ADMIN = [P.config.mileageUpdate, P.config.policyRead] as const;
const RW = [
  P.expense.report.readOwn,
  P.expense.report.updateOwn,
  P.expense.report.createOwn,
] as const;
const YEAR = 2026;

const letters = (n: number) =>
  Array.from({ length: n }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join(
    '',
  );
/** One letters-only token, so it survives `nameTokens` intact. */
const S = `Qx${letters(6)}`;

const todayUtc = () => {
  const n = new Date();
  return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate()));
};

describe.skipIf(!process.env.DATABASE_URL)('mileage opening balances (integration)', () => {
  let h: TenantHarness;
  let db: any;
  let mileageBalancesRouter: typeof import('@/server/routers/mileageBalances').mileageBalancesRouter;
  let admin: any;
  let adminId: string;
  let roleId: string;
  let mileageCategoryId: string;
  const userIds: string[] = [];
  const reportIds: string[] = [];
  const u: Record<'A' | 'B' | 'C' | 'D' | 'E' | 'T1' | 'T2', string> = {} as never;

  const newUser = async (firstName: string, lastName: string, country: string | null = 'CA') => {
    const created = await db.user.create({
      data: {
        email: `mileage-bal-${S.toLowerCase()}-${userIds.length}@example.invalid`,
        firstName,
        lastName,
        roleId,
        country,
      },
      select: { id: true },
    });
    userIds.push(created.id);
    return created.id as string;
  };

  /** A report owned by `userId` with one mileage expense on `date`. */
  const mileageExpense = async (userId: string, date: string, km: string) => {
    const caller = h.makeCaller(RW, userId);
    const reportId = (await caller.create({ title: `Mileage ${date}`, currency: 'CAD' })).id;
    reportIds.push(reportId);
    const expenseId = (await caller.createExpense({ reportId })).id;
    await caller.updateExpense({ expenseId, date });
    const line = await caller.lineItemCreate({
      expenseId,
      categoryId: mileageCategoryId,
      mileageDistance: km,
      mileageUnit: 'KM',
    });
    return { reportId: reportId as string, expenseId: expenseId as string, lineId: line.id };
  };

  const lineAmount = async (lineId: string) =>
    (await db.expenseLineItem.findUniqueOrThrow({ where: { id: lineId } })).amountMinor;

  /** CA allowance rules naming any of this suite's people, oldest first. */
  const allowanceRules = () =>
    db.mileageRate.findMany({
      where: { country: 'CA', subjects: { some: { userId: { in: userIds } } } },
      orderBy: [{ effectiveFrom: 'asc' }, { createdAt: 'asc' }],
      select: {
        id: true,
        effectiveFrom: true,
        effectiveTo: true,
        supersededById: true,
        tiers: { select: { fromDistance: true, rateMinor: true } },
        subjects: { select: { userId: true } },
      },
    });

  const resetAllowancesAndImports = async () => {
    await db.mileageRate.deleteMany({
      where: { country: 'CA', subjects: { some: { userId: { in: userIds } } } },
    });
    await db.mileageBalanceImport.deleteMany({ where: { source: 'concur', year: YEAR } });
  };

  const row = (name: string, userId: string, distance: string, paidRate: string | null) => ({
    name,
    userId,
    distance,
    paidRate,
  });
  const commit = (asOf: string, rows: ReturnType<typeof row>[], filename = `ytd-${asOf}.xlsx`) =>
    admin.commit({ source: 'concur', year: YEAR, asOf, filename, rows });

  const names = () => ({
    A: `COTE${S.toUpperCase()}, Helene`,
    B: `Bravo${S}, Bob`,
    C: `Charlie${S}, Cat`,
    D: `Delta${S}, Dan`,
    E: `Unknown${S}, Bobby`,
    T: `Twin${S}, Sam`,
  });

  beforeAll(async () => {
    h = await createTenantHarness({ slug: 'mileage-bal', name: 'Mileage Balances' });
    db = h.db;
    ({ mileageBalancesRouter } = await import('@/server/routers/mileageBalances'));

    const template = await db.user.findFirstOrThrow({
      where: { id: h.people[0].id },
      select: { id: true, roleId: true, firstName: true, lastName: true, email: true },
    });
    adminId = template.id;
    roleId = template.roleId;
    // VeloExpense: this suite's own mileage category (ExpenseOS reads a seeded one).
    mileageCategoryId = (
      await db.expenseCategory.create({
        data: { label: { en: 'Mileage balances' }, isMileage: true },
        select: { id: true },
      })
    ).id;
    // VeloExpense: the CA country default ExpenseOS's seed carries — 72¢ to 5,000 km, 66¢
    // after — created for this tenant, in force
    // from 2026-01-01 as the seeded one is.
    await db.mileageRate.create({
      data: {
        country: 'CA',
        unit: 'KM',
        effectiveFrom: new Date('2026-01-01T00:00:00Z'),
        tiers: {
          create: [
            { fromDistance: '0', rateMinor: 72n },
            { fromDistance: '5000', rateMinor: 66n },
          ],
        },
      },
    });
    admin = h.makeCaller(ADMIN, adminId, mileageBalancesRouter);

    // Residue from an earlier, interrupted run of this suite.
    const stale = await db.user.findMany({
      where: { email: { startsWith: 'mileage-bal-' } },
      select: { id: true },
    });
    await db.mileageRate.deleteMany({
      where: {
        country: 'CA',
        subjects: { some: { userId: { in: stale.map((s: { id: string }) => s.id) } } },
      },
    });
    await db.mileageBalanceImport.deleteMany({ where: { source: 'concur', year: YEAR } });

    u.A = await newUser('Hélène', `Côté${S}`);
    u.B = await newUser('Bob', `Bravo${S}`);
    u.C = await newUser('Cat', `Charlie${S}`);
    u.D = await newUser('Dan', `Delta${S}`, null); // no country: the balance is CA
    u.E = await newUser('Robert', `Echo${S}`);
    u.T1 = await newUser('Sam', `Twin${S}`);
    u.T2 = await newUser('Sam', `Twin${S}`);
  });

  afterAll(async () => {
    if (!db) return;
    await db.expenseReport.deleteMany({ where: { id: { in: reportIds } } }).catch(() => {});
    await resetAllowancesAndImports().catch(() => {});
    await db.user
      .updateMany({ where: { id: { in: userIds } }, data: { deletedAt: new Date() } })
      .catch(() => {});
    await h.end();
  });

  describe('permissions', () => {
    it('refuses preview and commit without mileage-update, and reads without policy-read', async () => {
      const nobody = h.makeCaller([], adminId, mileageBalancesRouter);
      const file = {
        source: 'concur',
        year: YEAR,
        asOf: '2026-06-30',
        filename: 'x.xlsx',
      } as const;
      await expect(
        nobody.preview({
          ...file,
          rows: [{ name: 'A, B', distance: '1', paidRate: null, amount: null }],
        }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(
        nobody.commit({ ...file, rows: [row('A, B', adminId, '1', null)] }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(nobody.imports({ source: 'concur', year: YEAR })).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
      await expect(nobody.importDetail({ id: adminId })).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
      await expect(nobody.forUser({ userId: adminId })).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });

      // Read-only access can read but not write.
      const reader = h.makeCaller([P.config.policyRead], adminId, mileageBalancesRouter);
      await expect(reader.imports({ source: 'concur', year: YEAR })).resolves.toEqual([]);
      await expect(
        reader.commit({ ...file, rows: [row('A, B', adminId, '1', null)] }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });
  });

  describe('an upload, then the next one', () => {
    let aDraft: { expenseId: string; lineId: string; reportId: string };
    let aSubmitted: { expenseId: string; lineId: string; reportId: string };
    let cDraft: { expenseId: string; lineId: string; reportId: string };
    let eDraft: { expenseId: string; lineId: string; reportId: string };
    let firstId: string;
    let secondId: string;

    beforeAll(async () => {
      await resetAllowancesAndImports();
      // Priced before any upload: every one at the 72¢ first band.
      aSubmitted = await mileageExpense(u.A, '2026-03-01', '100');
      await db.expenseReport.update({
        where: { id: aSubmitted.reportId },
        data: { status: 'SUBMITTED' },
      });
      aDraft = await mileageExpense(u.A, '2026-08-01', '100');
      cDraft = await mileageExpense(u.C, '2026-08-15', '100');
      eDraft = await mileageExpense(u.E, '2026-09-01', '100');
      // E's draft sits on a RETURNED report: that is re-priced too.
      await db.expenseReport.update({
        where: { id: eDraft.reportId },
        data: { status: 'RETURNED' },
      });
    });

    it('starts from the standard price', async () => {
      expect(await lineAmount(aSubmitted.lineId)).toBe(7200n);
      expect(await lineAmount(aDraft.lineId)).toBe(7200n);
      expect(await lineAmount(cDraft.lineId)).toBe(7200n);
      expect(await lineAmount(eDraft.lineId)).toBe(7200n);
    });

    it('previews matches, car allowances and flags, and writes nothing', async () => {
      const n = names();
      const before = await db.mileageBalanceImport.count({ where: { source: 'concur' } });
      const preview = await admin.preview({
        source: 'concur',
        year: YEAR,
        asOf: '2026-06-30',
        filename: 'ytd-june.xlsx',
        rows: [
          // Accents/case ignored; 4,950 km × 72¢, in the right band — clean.
          { name: n.A, distance: '4950', paidRate: '0.72', amount: '3564.00' },
          // Paid a rate the CA default does not have → car allowance; amount = 6,000 × 61¢.
          { name: n.B, distance: '6000', paidRate: '0.61', amount: '3660.00' },
          // Car allowance whose amount is nowhere near distance × rate.
          { name: n.C, distance: '3000', paidRate: '0.61', amount: '100.00' },
          // Car allowance, no amount reported.
          { name: n.D, distance: '1000', paidRate: '0.55', amount: null },
          // Nobody by that name yet.
          { name: n.E, distance: '5000', paidRate: '0.66', amount: '3600.00' },
          // Two people share the name; paid the first band while past 5,000 km.
          { name: n.T, distance: '6000', paidRate: '0.72', amount: '4260.00' },
          // One word: never matched.
          { name: `Nobody${S}`, distance: '10', paidRate: null, amount: null },
          // Standard rate, banded amount off by more than 10%.
          { name: `Nobody${S}, Zed`, distance: '1000', paidRate: '0.72', amount: '500.00' },
        ],
      });
      expect(await db.mileageBalanceImport.count({ where: { source: 'concur' } })).toBe(before);

      expect(preview.current).toBeNull();
      expect(preview.stale).toBe(false);
      const [a, b, c, d, e, t, one, off] = preview.rows;
      expect(a).toMatchObject({
        match: { status: 'matched', userId: u.A },
        carAllowance: false,
        previousDistance: null,
        flags: [],
      });
      expect(b).toMatchObject({
        match: { status: 'matched', userId: u.B },
        carAllowance: true,
        flags: [],
      });
      expect(c).toMatchObject({ carAllowance: true, flags: ['amount'] });
      expect(d).toMatchObject({
        match: { status: 'matched', userId: u.D },
        carAllowance: true,
        flags: [],
      });
      expect(e).toMatchObject({ match: { status: 'unmatched' }, carAllowance: false, flags: [] });
      expect(t.match.status).toBe('ambiguous');
      expect([...t.match.candidateIds].sort()).toEqual([u.T1, u.T2].sort());
      expect(t.flags).toEqual(['rateBand']);
      expect(t.previousDistance).toBeNull();
      expect(one).toMatchObject({ match: { status: 'unmatched' }, carAllowance: false, flags: [] });
      expect(off).toMatchObject({ carAllowance: false, flags: ['amount'] });
      // The row as sent is echoed back.
      expect(a).toMatchObject({ name: n.A, distance: '4950', paidRate: '0.72', amount: '3564.00' });

      // People referenced by the rows (matched + ambiguous candidates), and nobody else.
      const people = new Map(preview.people.map((p: any) => [p.id, p]));
      expect([...people.keys()].sort()).toEqual([u.A, u.B, u.C, u.D, u.T1, u.T2].sort());
      expect(people.get(u.A)).toMatchObject({ name: `Hélène Côté${S}`, deactivated: false });
    });

    it('commits the first upload: balances, car allowances from 1 January, drafts re-priced', async () => {
      const n = names();
      const result = await commit('2026-06-30', [
        row(n.A, u.A, '4950', '0.72'),
        row(n.B, u.B, '6000', '0.61'),
        row(n.C, u.C, '3000', '0.61'),
        row(n.D, u.D, '1000', '0.55'),
        // Resolved by hand to E: remembered next time.
        row(n.E, u.E, '5000', '0.66'),
      ]);
      firstId = result.id;
      expect(result).toMatchObject({ people: 5, moved: 5, dropped: 0 });
      expect(result.carAllowances).toEqual([
        { rateMinor: 55, people: 1, action: 'created' },
        { rateMinor: 61, people: 2, action: 'created' },
      ]);
      // A's and E's drafts and C's draft; never A's submitted report.
      expect(result.repricedLines).toBe(3);

      const imp = await db.mileageBalanceImport.findUniqueOrThrow({
        where: { id: firstId },
        include: { balances: true },
      });
      expect(imp).toMatchObject({
        source: 'concur',
        year: YEAR,
        importedById: adminId,
        supersededAt: null,
      });
      expect(imp.asOf.toISOString()).toBe('2026-06-30T00:00:00.000Z');
      const d = imp.balances.find((b: any) => b.userId === u.D);
      // No country on the person: CA, in kilometres, with the name as written.
      expect(d).toMatchObject({ country: 'CA', unit: 'KM', sourceName: n.D });
      expect(d.distance.toString()).toBe('1000');
      expect(d.paidRate.toString()).toBe('0.55');

      const rules = await allowanceRules();
      expect(rules).toHaveLength(2);
      for (const r of rules) {
        expect(r.effectiveFrom.toISOString()).toBe('2026-01-01T00:00:00.000Z');
        expect(r.effectiveTo).toBeNull();
        expect(r.tiers).toHaveLength(1);
        expect(r.tiers[0].fromDistance.toString()).toBe('0');
      }
      const byRate = new Map(rules.map((r: any) => [Number(r.tiers[0].rateMinor), r]));
      expect((byRate.get(55) as any).subjects.map((s: any) => s.userId)).toEqual([u.D]);
      expect((byRate.get(61) as any).subjects.map((s: any) => s.userId).sort()).toEqual(
        [u.B, u.C].sort(),
      );
    });

    it('re-priced the drafts against the carried-over basis, and left the submitted one alone', async () => {
      // A: 4,950 km carried → 50 km × 72¢ + 50 km × 66¢.
      expect(await lineAmount(aDraft.lineId)).toBe(6900n);
      const aLine = await db.expenseLineItem.findUniqueOrThrow({ where: { id: aDraft.lineId } });
      expect(aLine.mileageYtdBefore.toString()).toBe('4950');
      // C: on the 61¢ car allowance from 1 January.
      expect(await lineAmount(cDraft.lineId)).toBe(6100n);
      // E: 5,000 km carried → all in the second band. RETURNED is re-priced.
      expect(await lineAmount(eDraft.lineId)).toBe(6600n);
      // Submitted keeps the price it was submitted with.
      expect(await lineAmount(aSubmitted.lineId)).toBe(7200n);

      // Totals recomputed after the transaction.
      const expense = await db.expense.findUniqueOrThrow({ where: { id: aDraft.expenseId } });
      expect(expense.amountMinor).toBe(6900n);
      const report = await db.expenseReport.findUniqueOrThrow({ where: { id: aDraft.reportId } });
      expect(report.totalMinor).toBe(6900n);
    });

    it('leaves one audit row for the upload', async () => {
      const rows = await auditRows(h, firstId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ entityType: 'MileageBalanceImport', actorId: adminId });
      expect(rows[0].details).toMatchObject({
        source: 'concur',
        year: YEAR,
        asOf: '2026-06-30',
        filename: 'ytd-2026-06-30.xlsx',
        people: 5,
        supersedes: null,
        // People whose carried-over distance changed (all five are new here).
        balancesChanged: 5,
        dropped: 0,
      });
    });

    it('previews the next file against the one in force: remembered names, previous distance, stale', async () => {
      const n = names();
      const file = { source: 'concur', year: YEAR, filename: 'ytd-july.xlsx' } as const;
      const rows = [
        { name: n.E, distance: '5100', paidRate: '0.66', amount: null },
        // Spelled differently from last time, so not remembered: matched on the name.
        { name: `Cote${S}, Hélène Marie`, distance: '5200', paidRate: '0.66', amount: null },
        // Spelled exactly as last time: remembered.
        { name: n.A, distance: '5200', paidRate: '0.66', amount: null },
      ];
      const preview = await admin.preview({ ...file, asOf: '2026-07-31', rows });
      expect(preview.rows[0].match).toEqual({ status: 'remembered', userId: u.E });
      expect(preview.rows[0].previousDistance).toBe('5000');
      expect(preview.rows[1].match).toEqual({ status: 'matched', userId: u.A });
      expect(preview.rows[1].previousDistance).toBe('4950');
      expect(preview.rows[2].match).toEqual({ status: 'remembered', userId: u.A });
      expect(preview.stale).toBe(false);
      expect(preview.current.id).toBe(firstId);
      expect(new Date(preview.current.asOf).toISOString()).toBe('2026-06-30T00:00:00.000Z');
      expect(preview.current.balances).toHaveLength(5);
      // People in the upload in force are listed too, so the screen can show who drops out.
      expect(preview.people.map((p: any) => p.id).sort()).toEqual([u.A, u.B, u.C, u.D, u.E].sort());

      // Same day as the upload in force is fine; earlier is stale.
      expect((await admin.preview({ ...file, asOf: '2026-06-30', rows })).stale).toBe(false);
      expect((await admin.preview({ ...file, asOf: '2026-05-31', rows })).stale).toBe(true);
    });

    it('refuses a duplicate person, a stale file, the wrong year and a missing person — writing nothing', async () => {
      const n = names();
      const before = await db.mileageBalanceImport.count({ where: { source: 'concur' } });
      await expect(
        commit('2026-07-31', [row(n.A, u.A, '1', null), row('Again, A', u.A, '2', null)]),
      ).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        message: expect.stringMatching(/Again, A: that person already has a row/),
      });
      await expect(commit('2026-05-31', [row(n.A, u.A, '1', null)])).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        message: expect.stringMatching(
          /ends 2026-05-31, before the upload in force \(2026-06-30\)/,
        ),
      });
      await expect(commit('2027-01-05', [row(n.A, u.A, '1', null)])).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        message: expect.stringMatching(/period ends in 2027, not 2026/),
      });
      await expect(
        commit('2026-07-31', [row('Ghost, G', '019f0000-0000-7000-8000-00000000dead', '1', null)]),
      ).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        message: expect.stringMatching(/no longer exists/),
      });
      expect(await db.mileageBalanceImport.count({ where: { source: 'concur' } })).toBe(before);
    });

    it('commits the next upload: supersedes the first, allowances unchanged, a dropped person re-priced', async () => {
      const n = names();
      const result = await commit('2026-07-31', [
        row(n.A, u.A, '4950.00', '0.72'), // same distance, written differently
        row(n.B, u.B, '6100', '0.61'),
        row(n.C, u.C, '3000', '0.61'),
        row(n.D, u.D, '1000', '0.55'),
        // E is no longer in the file.
      ]);
      secondId = result.id;
      expect(result.carAllowances).toEqual([
        { rateMinor: 55, people: 1, action: 'unchanged' },
        { rateMinor: 61, people: 2, action: 'unchanged' },
      ]);
      expect(result.dropped).toBe(1);
      // B changed, E dropped, and every allowance holder (B, C, D) is re-evaluated.
      expect(result.moved).toBe(4);

      const first = await db.mileageBalanceImport.findUniqueOrThrow({ where: { id: firstId } });
      expect(first.supersededAt).not.toBeNull();
      expect(first.supersededById).toBe(secondId);
      expect((await allowanceRules()).every((r: any) => r.effectiveTo === null)).toBe(true);

      // E has no balance any more: the whole year counts from zero again.
      expect(await lineAmount(eDraft.lineId)).toBe(7200n);
      // A did not move and keeps the carried-over price.
      expect(await lineAmount(aDraft.lineId)).toBe(6900n);
      const [audit] = await auditRows(h, secondId);
      expect(audit.details).toMatchObject({ supersedes: firstId, dropped: 1, people: 4 });
    });

    it('lists the uploads newest first, with who imported them', async () => {
      const list = await admin.imports({ source: 'concur', year: YEAR });
      expect(list.map((r: any) => r.id)).toEqual([secondId, firstId]);
      expect(list[0]).toMatchObject({
        inForce: true,
        supersededAt: null,
        people: 4,
        filename: 'ytd-2026-07-31.xlsx',
      });
      expect(list[1]).toMatchObject({ inForce: false, people: 5 });
      expect(list[1].supersededAt).not.toBeNull();
      expect(typeof list[0].importedBy).toBe('string');
      expect(list[0].importedBy.length).toBeGreaterThan(0);
      expect(await admin.imports({ source: 'concur', year: 2001 })).toEqual([]);
    });

    it('details one upload, by name as written', async () => {
      const detail = await admin.importDetail({ id: firstId });
      expect(detail).toHaveLength(5);
      // Ordered by the name as written — by the database's collation, which may or may not
      // fold case ("COTE…" vs "Charlie…"), so either ordering is accepted.
      const got = detail.map((d: any) => d.sourceName);
      expect([[...got].sort(), [...got].sort((x, y) => x.localeCompare(y))]).toContainEqual(got);
      const a = detail.find((d: any) => d.user.id === u.A);
      expect(a).toMatchObject({
        sourceName: names().A,
        distance: '4950',
        unit: 'KM',
        paidRate: '0.72',
        user: { id: u.A, name: `Hélène Côté${S}` },
      });
      expect(a.user.email).toMatch(/@example\.invalid$/);
      expect(await admin.importDetail({ id: '019f0000-0000-7000-8000-00000000beef' })).toEqual([]);
    });

    it("reads a person's balance in force, and nothing once they are dropped", async () => {
      const a = await admin.forUser({ userId: u.A });
      expect(a).toHaveLength(1);
      expect(a[0]).toMatchObject({
        source: 'concur',
        year: YEAR,
        country: 'CA',
        distance: '4950',
        unit: 'KM',
      });
      expect(new Date(a[0].asOf).toISOString()).toBe('2026-07-31T00:00:00.000Z');
      expect(await admin.forUser({ userId: u.E })).toEqual([]);
    });
  });

  describe('car allowances', () => {
    const n = () => names();
    beforeEach(async () => {
      await resetAllowancesAndImports();
    });

    const byRate = async () => {
      const rules = await allowanceRules();
      return rules.map((r: any) => ({
        rate: Number(r.tiers[0].rateMinor),
        from: r.effectiveFrom.toISOString().slice(0, 10),
        to: r.effectiveTo?.toISOString().slice(0, 10) ?? null,
        people: r.subjects.map((s: any) => s.userId).sort(),
        id: r.id,
        supersededById: r.supersededById,
      }));
    };
    const today = () => todayUtc().toISOString().slice(0, 10);

    it('replaces a rule from today when its people change, releasing whoever left', async () => {
      await commit('2026-06-30', [
        row(n().B, u.B, '6000', '0.61'),
        row(n().C, u.C, '3000', '0.61'),
      ]);
      const result = await commit('2026-07-31', [
        row(n().B, u.B, '6100', '0.61'),
        row(n().C, u.C, '3000', '0.72'), // back on the standard rate
      ]);
      expect(result.carAllowances).toEqual([{ rateMinor: 61, people: 1, action: 'replaced' }]);
      const rules = await byRate();
      expect(rules).toHaveLength(2);
      const [old, next] = rules;
      expect(old).toMatchObject({ rate: 61, from: '2026-01-01', to: today() });
      expect(old.people).toEqual([u.B, u.C].sort());
      expect(next).toMatchObject({ rate: 61, from: today(), to: null, people: [u.B] });
      expect(old.supersededById).toBe(next.id);
      // B (changed + allowance) and C (released) both moved.
      expect(result.moved).toBe(2);
    });

    it('skips a rule that only started today rather than replacing it the same day', async () => {
      await commit('2026-06-30', [
        row(n().B, u.B, '6000', '0.61'),
        row(n().C, u.C, '3000', '0.61'),
      ]);
      // C moves to the standard rate → the 61¢ group is replaced today. (A person the file
      // merely leaves out keeps their allowance, so it has to be an explicit move.)
      await commit('2026-07-31', [
        row(n().B, u.B, '6000', '0.61'),
        row(n().C, u.C, '3000', '0.72'),
      ]);
      const before = await byRate();
      const result = await commit('2026-08-31', [
        row(n().B, u.B, '6000', '0.61'),
        row(n().D, u.D, '100', '0.61'), // D joins
      ]);
      expect(result.carAllowances).toEqual([{ rateMinor: 61, people: 2, action: 'skipped' }]);
      expect(await byRate()).toEqual(before);
    });

    it('keeps the allowance of a person the file does not mention', async () => {
      // A new hire on a hand-made allowance, who never used Concur, must not lose it.
      await commit('2026-06-30', [
        row(n().B, u.B, '6000', '0.61'),
        row(n().C, u.C, '3000', '0.61'),
      ]);
      const result = await commit('2026-07-31', [row(n().B, u.B, '6000', '0.61')]);
      expect(result.carAllowances).toEqual([{ rateMinor: 61, people: 2, action: 'unchanged' }]);
    });

    it('closes a rule nobody is paid at any more, with no successor', async () => {
      await commit('2026-06-30', [row(n().D, u.D, '1000', '0.55')]);
      const result = await commit('2026-07-31', [row(n().D, u.D, '1000', '0.72')]);
      expect(result.carAllowances).toEqual([{ rateMinor: 55, people: 0, action: 'closed' }]);
      const [rule] = await byRate();
      expect(rule).toMatchObject({
        rate: 55,
        from: '2026-01-01',
        to: today(),
        supersededById: null,
      });
    });

    it('treats a hand-made flat rule at the same rate as the same group', async () => {
      await db.mileageRate.create({
        data: {
          country: 'CA',
          unit: 'KM',
          effectiveFrom: new Date(Date.UTC(YEAR, 0, 1)),
          tiers: { create: [{ fromDistance: '0', rateMinor: 61n }] },
          subjects: { create: [{ userId: u.B }] },
        },
      });
      const result = await commit('2026-06-30', [row(n().B, u.B, '6000', '0.61')]);
      expect(result.carAllowances).toEqual([{ rateMinor: 61, people: 1, action: 'unchanged' }]);
      expect(await byRate()).toHaveLength(1);
    });

    it('ignores a banded (multi-tier) allowance rule', async () => {
      await db.mileageRate.create({
        data: {
          country: 'CA',
          unit: 'KM',
          effectiveFrom: new Date(Date.UTC(YEAR, 0, 1)),
          tiers: {
            create: [
              { fromDistance: '0', rateMinor: 80n },
              { fromDistance: '5000', rateMinor: 70n },
            ],
          },
          subjects: { create: [{ userId: u.D }] },
        },
      });
      const result = await commit('2026-06-30', [row(n().A, u.A, '10', '0.72')]);
      expect(result.carAllowances).toEqual([]);
      const [rule] = await byRate();
      expect(rule.to).toBeNull();
    });

    it('moves a person between two existing allowance rates', async () => {
      await commit('2026-06-30', [
        row(n().B, u.B, '6000', '0.61'),
        row(n().C, u.C, '3000', '0.61'),
        row(n().D, u.D, '1000', '0.55'),
      ]);
      const result = await commit('2026-07-31', [
        row(n().B, u.B, '6000', '0.61'),
        row(n().C, u.C, '3000', '0.55'), // C moves 61 → 55
        row(n().D, u.D, '1000', '0.55'),
      ]);
      expect(result.carAllowances).toEqual([
        { rateMinor: 55, people: 2, action: 'replaced' },
        { rateMinor: 61, people: 1, action: 'replaced' },
      ]);
      const open = (await byRate()).filter((r: any) => r.to === null);
      expect(open.map((r: any) => [r.rate, r.from, r.people])).toEqual(
        expect.arrayContaining([
          [55, today(), [u.C, u.D].sort()],
          [61, today(), [u.B]],
        ]),
      );
      expect(open).toHaveLength(2);
    });

    it('moves a person to a new rate without restarting the old group from 1 January', async () => {
      await commit('2026-06-30', [
        row(n().B, u.B, '6000', '0.61'),
        row(n().C, u.C, '3000', '0.61'),
      ]);
      const result = await commit('2026-07-31', [
        row(n().B, u.B, '6000', '0.58'), // B moves to a rate nobody had
        row(n().C, u.C, '3000', '0.61'),
      ]);
      const rules = await byRate();
      const open = rules.filter((r: any) => r.to === null);
      expect(open.find((r: any) => r.rate === 58)).toMatchObject({ from: today(), people: [u.B] });
      // C stays on 61¢ without a gap — and without a second 61¢ rule overlapping the old one.
      const c61 = rules.filter((r: any) => r.rate === 61 && r.people.includes(u.C));
      const overlapping = c61.filter(
        (r: any) => r.from < today() && (r.to === null || r.to >= today()),
      );
      expect(overlapping).toHaveLength(1);
      expect(result.carAllowances.find((s: any) => s.rateMinor === 61)?.action).toBe('replaced');
    });

    it('finds no car allowance when no country default is in force on the period end', async () => {
      // The seeded CA default starts 2026-01-01: nothing to compare a 2025 rate against.
      const file = {
        source: 'concur',
        year: 2025,
        asOf: '2025-12-31',
        filename: 'ytd-2025.xlsx',
      } as const;
      const preview = await admin.preview({
        ...file,
        rows: [{ name: n().B, distance: '6000', paidRate: '0.61', amount: '3660.00' }],
      });
      expect(preview.rows[0]).toMatchObject({ carAllowance: false, flags: [] });
      const result = await admin.commit({ ...file, rows: [row(n().B, u.B, '6000', '0.61')] });
      expect(result.carAllowances).toEqual([]);
      expect(await byRate()).toEqual([]);
      await db.mileageBalanceImport.deleteMany({ where: { id: result.id } });
    });
  });
});

/**
 * `ytdForUser` — where one person stands in the mileage bands, per country.
 *
 * Its own countries (user-assigned ISO codes nobody else uses), its own import `source`, its
 * own people and its own reports, written straight to the tables with an explicit status. Every
 * case runs in a fixed past year, where the reference date is 31 December and the clock cannot
 * move a figure; only the default-year case touches the current year, and dates it from the
 * clock.
 *
 *   QP — the country default, km: 73¢ to 5,000 km, 67¢ after (plus one car allowance)
 *   QM — the country default, miles: 70¢ to 3,000 mi, 60¢ after
 *   QN — a rule that ended on 30 June: nothing in force on 31 December
 *   QR — a rule that ended on 30 November, replaced from 1 December
 *   QT — a rule with no tiers
 */
describe.skipIf(!process.env.DATABASE_URL)('ytdForUser', () => {
  const PAST = 2025;
  const SOURCE = 'concur-ytdforuser-test';
  const COUNTRIES = ['QP', 'QM', 'QN', 'QR', 'QT'];
  const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
  const READ_OWN = P.expense.report.readOwn;
  const POLICY_READ = P.config.policyRead;

  let h: TenantHarness;
  let db: any;
  let createCallerFactory: typeof import('@/server/trpc').createCallerFactory;
  let mileageBalancesRouter: typeof import('@/server/routers/mileageBalances').mileageBalancesRouter;
  let STATUS_BUCKET: typeof import('@/server/routers/mileageBalances').STATUS_BUCKET;
  let ytdBasis: typeof import('@/server/lib/mileage').ytdBasis;
  let unscale: typeof import('@/server/lib/mileage').unscale;
  let ExpenseReportStatus: typeof import('@expenseos/db').ExpenseReportStatus;
  let roleId: string;
  let importerId: string;
  let currencyId: string;
  let mileageCategoryId: string;
  const userIds: string[] = [];
  const reportIds: string[] = [];
  const importIds: string[] = [];
  const rule: Record<'QP' | 'QM' | 'QN' | 'QRold' | 'QRnew' | 'QT', string> = {} as never;

  const newUser = async () => {
    const u = await db.user.create({
      data: {
        email: `mileage-ytdfor-${Date.now()}-${userIds.length}@example.invalid`,
        firstName: 'Ytd',
        lastName: `ForUser${userIds.length}`,
        roleId,
        country: 'QP',
      },
      select: { id: true },
    });
    userIds.push(u.id);
    return u.id as string;
  };

  const newRule = async (
    country: string,
    opts: {
      unit?: 'KM' | 'MI';
      from?: string;
      to?: string;
      tiers: [string, bigint][];
      subjects?: string[];
    },
  ) =>
    (
      await db.mileageRate.create({
        data: {
          country,
          unit: opts.unit ?? 'KM',
          effectiveFrom: day(opts.from ?? `${PAST}-01-01`),
          effectiveTo: opts.to ? day(opts.to) : null,
          tiers: {
            create: opts.tiers.map(([fromDistance, rateMinor]) => ({ fromDistance, rateMinor })),
          },
          ...(opts.subjects
            ? { subjects: { create: opts.subjects.map((userId) => ({ userId })) } }
            : {}),
        },
        select: { id: true },
      })
    ).id as string;

  const newImport = async (opts: {
    asOf: string;
    superseded?: boolean;
    balances: { userId: string; distance: string; unit?: 'KM' | 'MI'; country?: string }[];
  }) => {
    const imp = await db.mileageBalanceImport.create({
      data: {
        source: SOURCE,
        year: PAST,
        asOf: day(opts.asOf),
        filename: 'ytd.xlsx',
        importedById: importerId,
        supersededAt: opts.superseded ? new Date() : null,
        balances: {
          create: opts.balances.map((b) => ({
            userId: b.userId,
            country: b.country ?? 'QP',
            unit: b.unit ?? 'KM',
            distance: b.distance,
            sourceName: 'ForUser, Ytd',
          })),
        },
      },
      select: { id: true },
    });
    importIds.push(imp.id);
  };

  /** One report + expense + mileage line, written straight to the tables. */
  const newLine = async (
    userId: string,
    date: string,
    distance: string,
    opts: {
      status?: string;
      unit?: 'KM' | 'MI' | null;
      rateId?: string;
      override?: string;
    } = {},
  ) => {
    const report = await db.expenseReport.create({
      data: {
        title: 'ytdForUser fixture',
        submitterId: userId,
        currencyId,
        // VeloExpense: a REIMBURSED report carries its payment stamp (0013's CHECK), a
        // column the Prisma view does not describe: written as APPROVED, then stamped below.
        status: opts.status === 'REIMBURSED' ? 'APPROVED' : (opts.status ?? 'DRAFT'),
        expenses: {
          create: [{ ownerId: userId, date: day(date), amountMinor: 0n, currencyId }],
        },
      },
      select: { id: true, expenses: { select: { id: true } } },
    });
    reportIds.push(report.id);
    if (opts.status === 'REIMBURSED') {
      await h.admin.query(
        `UPDATE expense_report SET status = 'REIMBURSED', reimbursed_at = now(), reimbursed_by_id = submitter_id WHERE id = $1`,
        [report.id],
      );
    }
    await db.expenseLineItem.create({
      data: {
        expenseId: report.expenses[0].id,
        categoryId: mileageCategoryId,
        kind: 'MILEAGE',
        amountMinor: 0n,
        mileageDistance: distance,
        mileageDistanceOverride: opts.override ?? null,
        mileageUnit: opts.unit === undefined ? 'KM' : opts.unit,
        mileageRateId: opts.rateId ?? rule.QP,
      },
    });
  };

  // VeloExpense: the harness's caller, which runs each call in the tenant's scope; a db
  // override (the gate cases' `untouchable`) is injected as ExpenseOS injects it.
  const callerFor = (callerId: string, permissions: readonly string[], dbOverride?: unknown) =>
    dbOverride
      ? createCallerFactory(mileageBalancesRouter)(
          makeContext({ db: dbOverride, userId: callerId, permissions }),
        )
      : h.makeCaller(permissions, callerId, mileageBalancesRouter);
  /** The person's rows for the fixed past year, read by a policy reader. */
  const rowsOf = (userId: string) =>
    callerFor(importerId, [POLICY_READ]).ytdForUser({ userId, year: PAST });
  /** A db that fails the test on ANY access: the gate must refuse before reading. */
  const untouchable = new Proxy(
    {},
    {
      get(_t, prop) {
        throw new Error(`the gate let a read through: ctx.db.${String(prop)}`);
      },
    },
  );

  // People, by scenario.
  const u: Record<
    | 'parity'
    | 'crossing'
    | 'exact'
    | 'carriedPast'
    | 'allowance'
    | 'two'
    | 'noRuleBalance'
    | 'noRuleLine'
    | 'noRuleNoUnit'
    | 'past'
    | 'tierless'
    | 'zeroBalance'
    | 'zeroBalanceLine'
    | 'carriedOnly'
    | 'zeroLine',
    string
  > = {} as never;

  beforeAll(async () => {
    h = await createTenantHarness({ slug: 'mileage-ytdfor', name: 'Mileage YTD for a person' });
    db = h.db;
    ({ createCallerFactory } = await import('@/server/trpc'));
    ({ mileageBalancesRouter, STATUS_BUCKET } = await import('@/server/routers/mileageBalances'));
    ({ ytdBasis, unscale } = await import('@/server/lib/mileage'));
    ({ ExpenseReportStatus } = await import('@expenseos/db'));

    const template = await db.user.findFirstOrThrow({
      where: { id: h.people[0].id },
      select: { id: true, roleId: true },
    });
    roleId = template.roleId;
    importerId = template.id;
    // VeloExpense: a currency is keyed by its ISO code.
    currencyId = 'CAD';
    // VeloExpense: this suite's own mileage category (ExpenseOS reads a seeded one).
    mileageCategoryId = (
      await db.expenseCategory.create({
        data: { label: { en: 'Mileage YTD for a person' }, isMileage: true },
        select: { id: true },
      })
    ).id;

    // Residue from an earlier, interrupted run.
    await db.mileageRate.deleteMany({ where: { country: { in: COUNTRIES } } });
    await db.mileageBalanceImport.deleteMany({ where: { source: SOURCE } });

    for (const k of Object.keys({
      parity: 1,
      crossing: 1,
      exact: 1,
      carriedPast: 1,
      allowance: 1,
      two: 1,
      noRuleBalance: 1,
      noRuleLine: 1,
      noRuleNoUnit: 1,
      past: 1,
      tierless: 1,
      zeroBalance: 1,
      zeroBalanceLine: 1,
      carriedOnly: 1,
      zeroLine: 1,
    }) as (keyof typeof u)[]) {
      u[k] = await newUser();
    }

    // Open-ended from the start of the past year, so also in force today (the default-year case).
    rule.QP = await newRule('QP', {
      tiers: [
        ['0', 73n],
        ['5000', 67n],
      ],
    });
    rule.QM = await newRule('QM', {
      unit: 'MI',
      tiers: [
        ['0', 70n],
        ['3000', 60n],
      ],
    });
    rule.QN = await newRule('QN', { to: `${PAST}-06-30`, tiers: [['0', 50n]] });
    rule.QRold = await newRule('QR', {
      to: `${PAST}-11-30`,
      tiers: [
        ['0', 50n],
        ['1000', 40n],
      ],
    });
    rule.QRnew = await newRule('QR', {
      from: `${PAST}-12-01`,
      tiers: [
        ['0', 55n],
        ['2000', 45n],
      ],
    });
    rule.QT = await newRule('QT', { tiers: [] });
  });

  afterAll(async () => {
    if (!db) return;
    await db.expenseReport.deleteMany({ where: { id: { in: reportIds } } }).catch(() => {});
    await db.mileageBalanceImport.deleteMany({ where: { id: { in: importIds } } }).catch(() => {});
    await db.mileageRate.deleteMany({ where: { country: { in: COUNTRIES } } }).catch(() => {});
    await db.user
      .updateMany({ where: { id: { in: userIds } }, data: { deletedAt: new Date() } })
      .catch(() => {});
    await h.end();
  });

  describe('the gate (security, 7 cases)', () => {
    beforeAll(async () => {
      await newLine(u.parity, `${PAST}-02-01`, '1', { status: 'APPROVED' });
    });

    it('1. self with read-own only reads their rows', async () => {
      const rows = await callerFor(u.parity, [READ_OWN]).ytdForUser({
        userId: u.parity,
        year: PAST,
      });
      expect(rows.map((r: any) => r.country)).toEqual(['QP']);
    });

    it('2. self with policy-read only reads their rows', async () => {
      const rows = await callerFor(u.parity, [POLICY_READ]).ytdForUser({
        userId: u.parity,
        year: PAST,
      });
      expect(rows.map((r: any) => r.country)).toEqual(['QP']);
    });

    it('3. self with neither is refused, naming read-own, before anything is read', async () => {
      await expect(
        callerFor(u.parity, [], untouchable).ytdForUser({ userId: u.parity, year: PAST }),
      ).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: 'Missing permission: expense.report.read.own',
      });
    });

    it('4. another person with read-own only is refused, naming policy-read, before anything is read', async () => {
      await expect(
        callerFor(u.crossing, [READ_OWN], untouchable).ytdForUser({ userId: u.parity, year: PAST }),
      ).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: 'Missing permission: config.policy.read',
      });
    });

    it('5. another person with policy-read only reads the rows', async () => {
      const rows = await callerFor(u.crossing, [POLICY_READ]).ytdForUser({
        userId: u.parity,
        year: PAST,
      });
      expect(rows.map((r: any) => r.country)).toEqual(['QP']);
    });

    it('6. an unknown person reads as [] for a policy reader, never NOT_FOUND', async () => {
      await expect(
        callerFor(u.crossing, [POLICY_READ]).ytdForUser({
          userId: '00000000-0000-7000-8000-00000000dead',
          year: PAST,
        }),
      ).resolves.toEqual([]);
    });

    it('7. identity is the rbac id: a session naming the target does not make it "self"', async () => {
      const ctx = makeContext({ db: untouchable, userId: u.parity, permissions: [READ_OWN] });
      const forged = { ...ctx, rbac: { ...ctx.rbac, id: u.crossing } } as typeof ctx;
      await expect(
        createCallerFactory(mileageBalancesRouter)(forged).ytdForUser({
          userId: u.parity,
          year: PAST,
        }),
      ).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: 'Missing permission: config.policy.read',
      });
    });
  });

  describe('the year', () => {
    it('refuses a year that has not started, and one outside 2000–2100', async () => {
      const next = new Date().getUTCFullYear() + 1;
      await expect(
        callerFor(u.parity, [READ_OWN]).ytdForUser({ userId: u.parity, year: next }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      await expect(
        callerFor(u.parity, [READ_OWN]).ytdForUser({ userId: u.parity, year: 1999 }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    });

    it('defaults to the current UTC calendar year', async () => {
      const someone = await newUser();
      const today = new Date().toISOString().slice(0, 10);
      await newLine(someone, today, '12.5', { status: 'APPROVED' });
      const rows = await callerFor(someone, [READ_OWN]).ytdForUser({ userId: someone });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ country: 'QP', total: '12.50', bandIndex: 0 });
      // The same person in the past year has nothing.
      await expect(
        callerFor(someone, [READ_OWN]).ytdForUser({ userId: someone, year: PAST }),
      ).resolves.toEqual([]);
    });
  });

  describe('the basis (parity with the engine) and the pending split', () => {
    beforeAll(async () => {
      const p = u.parity;
      // The gate cases already gave this person a 1 km APPROVED line on 1 Feb, before the
      // carry-over's period end: covered by the carry-over, so not counted.
      await newImport({
        asOf: `${PAST}-05-31`,
        superseded: true,
        balances: [{ userId: p, distance: '9999' }],
      });
      await newImport({ asOf: `${PAST}-06-30`, balances: [{ userId: p, distance: '1000' }] });
      // On the period end: covered by the carry-over, so in neither the total nor `pending`.
      await newLine(p, `${PAST}-06-30`, '111', { status: 'SUBMITTED' });
      await newLine(p, `${PAST}-07-01`, '200', { status: 'APPROVED' });
      await newLine(p, `${PAST}-07-02`, '300', { status: 'REIMBURSED', override: '250' });
      await newLine(p, `${PAST}-07-03`, '100', { status: 'DRAFT', unit: 'MI' }); // 160.93 km
      await newLine(p, `${PAST}-07-04`, '10', { status: 'SUBMITTED' });
      await newLine(p, `${PAST}-07-05`, '20', { status: 'RETURNED' });
      await newLine(p, `${PAST}-07-06`, '500', { status: 'REJECTED' });
      await newLine(p, `${PAST + 1}-01-02`, '400', { status: 'APPROVED' }); // next year
    });

    it('B3: total is exactly what ytdBasis prices from, and carried + claimed = total', async () => {
      const [row] = await rowsOf(u.parity);
      const basis = await ytdBasis(db, {
        userId: u.parity,
        country: 'QP',
        on: day(`${PAST}-12-31`),
        unit: 'KM',
      });
      expect(row.total).toBe(unscale(basis.totalScaled));
      expect(row.carried).toBe(unscale(basis.carriedScaled));
      expect(row.carriedThrough).toEqual(basis.carriedThrough);
      // 1000 carried + 200 + 250 (the override) + 160.93 (100 mi) + 10 + 20.
      expect(row).toMatchObject({
        country: 'QP',
        unit: 'KM',
        carried: '1000.00',
        claimed: '640.93',
        total: '1640.93',
        carriedThrough: day(`${PAST}-06-30`),
      });
      const scaled = (s: string) => BigInt(s.replace('.', ''));
      expect(scaled(row.carried) + scaled(row.claimed)).toBe(scaled(row.total));
    });

    it('B3: the line read behind pending and crossedAt sums to exactly what ytdBasis claims', async () => {
      // The same edges, every counted line pending: `pending` is then the line read's whole
      // sum, and has to equal the engine's `claimed` to the hundredth.
      const p = await newUser();
      await newImport({
        asOf: `${PAST}-05-31`,
        superseded: true,
        balances: [{ userId: p, distance: '777' }],
      });
      await newImport({ asOf: `${PAST}-06-30`, balances: [{ userId: p, distance: '500' }] });
      await newLine(p, `${PAST}-06-30`, '111', { status: 'DRAFT' });
      await newLine(p, `${PAST}-07-01`, '300', { status: 'SUBMITTED', override: '250' });
      await newLine(p, `${PAST}-07-02`, '100', { status: 'RETURNED', unit: 'MI' });
      await newLine(p, `${PAST}-07-03`, '33.33', { status: 'DRAFT', unit: 'MI' });
      await newLine(p, `${PAST}-07-04`, '500', { status: 'REJECTED' });
      await newLine(p, `${PAST + 1}-01-02`, '400', { status: 'DRAFT' });
      const [row] = await rowsOf(p);
      const basis = await ytdBasis(db, {
        userId: p,
        country: 'QP',
        on: day(`${PAST}-12-31`),
        unit: 'KM',
      });
      expect(row.claimed).toBe(unscale(basis.totalScaled - basis.carriedScaled));
      expect(row.pending).toBe(row.claimed);
      // 250 + 160.93 (100 mi) + 53.64 (33.33 mi).
      expect(row.claimed).toBe('464.57');
    });

    it('B4: pending is the DRAFT, SUBMITTED and RETURNED lines; REJECTED is in nothing', async () => {
      const [row] = await rowsOf(u.parity);
      // 160.93 (DRAFT) + 10 (SUBMITTED) + 20 (RETURNED); APPROVED/REIMBURSED are claimed only,
      // and the SUBMITTED line on the period end is covered by the carry-over.
      expect(row.pending).toBe('190.93');
      const scaled = (s: string) => BigInt(s.replace('.', ''));
      expect(scaled(row.pending)).toBeLessThanOrEqual(scaled(row.claimed));
    });

    it('serves the rule and the band, and nothing that names a line, a report, a person or a GL', async () => {
      const [row] = await rowsOf(u.parity);
      expect(Object.keys(row).sort()).toEqual(
        [
          'bandFrom',
          'bandIndex',
          'carried',
          'carriedThrough',
          'claimed',
          'country',
          'crossedAt',
          'nextBoundary',
          'pending',
          'remaining',
          'rule',
          'total',
          'unit',
        ].sort(),
      );
      expect(row.rule).toEqual({
        ruleId: rule.QP,
        isCarAllowance: false,
        tiers: [
          { fromDistance: '0.00', rateMinor: '73' },
          { fromDistance: '5000.00', rateMinor: '67' },
        ],
      });
      expect(row).toMatchObject({
        bandIndex: 0,
        bandFrom: '0.00',
        nextBoundary: '5000.00',
        remaining: '3359.07',
        crossedAt: null,
      });
    });

    it('classifies every report status, and only REJECTED is left out', () => {
      for (const status of Object.values(ExpenseReportStatus)) {
        expect(STATUS_BUCKET[status as keyof typeof STATUS_BUCKET], status).toBeDefined();
      }
      expect(STATUS_BUCKET).toEqual({
        DRAFT: 'pending',
        SUBMITTED: 'pending',
        RETURNED: 'pending',
        APPROVED: 'approved',
        REIMBURSED: 'approved',
        REJECTED: 'excluded',
      });
    });
  });

  describe('crossing a boundary', () => {
    it('B5: crossedAt is the line that took the total past 5,000, in date order, not entry order', async () => {
      const p = u.crossing;
      await newImport({ asOf: `${PAST}-01-31`, balances: [{ userId: p, distance: '4900' }] });
      // Entered latest-first: in id order the 1 Oct line would be the one to cross (4,900 +
      // 120), so a walk in entry order — or in reverse date order — names the wrong day.
      // Covered by the carry-over: it must not cross the boundary on 15 January.
      await newLine(p, `${PAST}-01-15`, '200', { status: 'APPROVED' });
      await newLine(p, `${PAST}-10-01`, '120', { status: 'APPROVED' });
      await newLine(p, `${PAST}-09-12`, '100', { status: 'APPROVED' });
      await newLine(p, `${PAST}-03-10`, '50', { status: 'APPROVED' });
      const [row] = await rowsOf(p);
      expect(row).toMatchObject({
        total: '5170.00',
        bandIndex: 1,
        bandFrom: '5000.00',
        nextBoundary: null,
        remaining: null,
        crossedAt: day(`${PAST}-09-12`),
      });
    });

    it('B6: landing exactly on 5,000.00 is the second band, crossed on that day', async () => {
      const p = u.exact;
      await newImport({ asOf: `${PAST}-01-31`, balances: [{ userId: p, distance: '4900' }] });
      await newLine(p, `${PAST}-08-05`, '100', { status: 'SUBMITTED' });
      const [row] = await rowsOf(p);
      expect(row).toMatchObject({
        total: '5000.00',
        bandIndex: 1,
        bandFrom: '5000.00',
        crossedAt: day(`${PAST}-08-05`),
      });
    });

    it('B7: the carry-over alone past the boundary has no crossing date', async () => {
      const p = u.carriedPast;
      await newImport({ asOf: `${PAST}-06-30`, balances: [{ userId: p, distance: '5100' }] });
      await newLine(p, `${PAST}-07-10`, '10', { status: 'APPROVED' });
      const [row] = await rowsOf(p);
      expect(row).toMatchObject({
        carried: '5100.00',
        total: '5110.00',
        bandIndex: 1,
        crossedAt: null,
        carriedThrough: day(`${PAST}-06-30`),
      });
    });
  });

  it('B9: a car allowance is a single rate with no boundary', async () => {
    const p = u.allowance;
    const allowanceId = await newRule('QP', { tiers: [['0', 61n]], subjects: [p] });
    await newLine(p, `${PAST}-03-01`, '6100', { status: 'APPROVED', rateId: allowanceId });
    const [row] = await rowsOf(p);
    expect(row).toMatchObject({
      country: 'QP',
      total: '6100.00',
      rule: {
        ruleId: allowanceId,
        isCarAllowance: true,
        tiers: [{ fromDistance: '0.00', rateMinor: '61' }],
      },
      bandIndex: 0,
      bandFrom: '0.00',
      nextBoundary: null,
      remaining: null,
      crossedAt: null,
    });
  });

  it('B10: two countries are two rows, sorted by country, each in its own unit, never pooled', async () => {
    const p = u.two;
    await newImport({ asOf: `${PAST}-02-28`, balances: [{ userId: p, distance: '300' }] });
    await newLine(p, `${PAST}-04-01`, '120', { status: 'APPROVED', unit: 'MI', rateId: rule.QM });
    const rows = await rowsOf(p);
    expect(rows.map((r: any) => [r.country, r.unit, r.total])).toEqual([
      ['QM', 'MI', '120.00'],
      ['QP', 'KM', '300.00'],
    ]);
    expect(rows[0]).toMatchObject({ bandIndex: 0, nextBoundary: '3000.00', remaining: '2880.00' });
  });

  describe('B11: no rule in force on the reference date', () => {
    const noBand = {
      rule: null,
      bandIndex: null,
      bandFrom: null,
      nextBoundary: null,
      remaining: null,
      crossedAt: null,
    };

    it('keeps the basis, reads it in the balance unit before the latest line unit', async () => {
      const p = u.noRuleBalance;
      await newImport({
        asOf: `${PAST}-03-31`,
        balances: [{ userId: p, distance: '100', unit: 'MI', country: 'QN' }],
      });
      await newLine(p, `${PAST}-05-01`, '20', { status: 'APPROVED', unit: 'KM', rateId: rule.QN });
      const [row] = await rowsOf(p);
      // 100 mi carried + 20 km (12.43 mi).
      expect(row).toMatchObject({ country: 'QN', unit: 'MI', total: '112.43', ...noBand });
    });

    it('without a balance, reads it in the latest line unit', async () => {
      const p = u.noRuleLine;
      await newLine(p, `${PAST}-02-01`, '10', { status: 'APPROVED', unit: 'KM', rateId: rule.QN });
      await newLine(p, `${PAST}-05-01`, '30', { status: 'APPROVED', unit: 'MI', rateId: rule.QN });
      const [row] = await rowsOf(p);
      // 10 km (6.21 mi) + 30 mi.
      expect(row).toMatchObject({ country: 'QN', unit: 'MI', total: '36.21', ...noBand });
    });

    it('with neither a balance nor a line unit, reads it in km', async () => {
      const p = u.noRuleNoUnit;
      await newLine(p, `${PAST}-05-01`, '10', { status: 'APPROVED', unit: null, rateId: rule.QN });
      const [row] = await rowsOf(p);
      expect(row).toMatchObject({ country: 'QN', unit: 'KM', total: '10.00', ...noBand });
    });
  });

  it('B12: a past year resolves the rule in force on its 31 December', async () => {
    const p = u.past;
    await newLine(p, `${PAST}-03-01`, '100', { status: 'APPROVED', rateId: rule.QRold });
    const [row] = await rowsOf(p);
    expect(row).toMatchObject({
      country: 'QR',
      total: '100.00',
      rule: {
        ruleId: rule.QRnew,
        isCarAllowance: false,
        tiers: [
          { fromDistance: '0.00', rateMinor: '55' },
          { fromDistance: '2000.00', rateMinor: '45' },
        ],
      },
      bandIndex: 0,
      nextBoundary: '2000.00',
      remaining: '1900.00',
    });
  });

  it('B19: a rule with no tiers is served as no rule', async () => {
    const p = u.tierless;
    await newLine(p, `${PAST}-04-01`, '42', { status: 'APPROVED', rateId: rule.QT });
    const [row] = await rowsOf(p);
    expect(row).toMatchObject({
      country: 'QT',
      unit: 'KM',
      total: '42.00',
      rule: null,
      bandIndex: null,
      bandFrom: null,
      nextBoundary: null,
      remaining: null,
      crossedAt: null,
    });
  });

  describe('B20: rows that are all zero', () => {
    it('a balance of 0 and no line is no row: [] is the only empty shape', async () => {
      await newImport({
        asOf: `${PAST}-06-30`,
        balances: [{ userId: u.zeroBalance, distance: '0' }],
      });
      await expect(rowsOf(u.zeroBalance)).resolves.toEqual([]);
    });

    it('a balance of 0 plus a line is a row', async () => {
      await newImport({
        asOf: `${PAST}-06-30`,
        balances: [{ userId: u.zeroBalanceLine, distance: '0' }],
      });
      await newLine(u.zeroBalanceLine, `${PAST}-08-01`, '15', { status: 'APPROVED' });
      const rows = await rowsOf(u.zeroBalanceLine);
      expect(rows.map((r: any) => [r.carried, r.total])).toEqual([['0.00', '15.00']]);
    });

    it('a carry-over with no line is a row', async () => {
      await newImport({
        asOf: `${PAST}-06-30`,
        balances: [{ userId: u.carriedOnly, distance: '250' }],
      });
      const rows = await rowsOf(u.carriedOnly);
      expect(rows.map((r: any) => [r.carried, r.claimed, r.total])).toEqual([
        ['250.00', '0.00', '250.00'],
      ]);
    });

    it('a line of zero distance is a row of 0: lines are information', async () => {
      await newLine(u.zeroLine, `${PAST}-08-01`, '0', { status: 'DRAFT' });
      const rows = await rowsOf(u.zeroLine);
      expect(rows.map((r: any) => [r.total, r.pending, r.bandIndex])).toEqual([
        ['0.00', '0.00', 0],
      ]);
    });
  });
});
