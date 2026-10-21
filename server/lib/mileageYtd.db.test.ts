// @vitest-environment node
/* eslint-disable @typescript-eslint/no-explicit-any -- VeloExpense: ExpenseOS's suite reads its rows untyped (`db: any`); Biome allows it there. */
import { permissions as P } from '@expenseos/rbac';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTenantHarness, type TenantHarness } from '../__test-helpers__/tenantHarness';

/**
 * The year-to-date mileage basis with a carried-over opening balance (Concur), against a
 * real database.
 *
 * `ytdBasis` = the balance in the upload in force for the person/country/year, converted to
 * the rule's unit, PLUS ExpenseOS mileage dated strictly AFTER that upload's period end (or
 * the whole year when there is no upload), never counting REJECTED reports.
 *
 * Its own country code, rule and people, so no other suite's rates, balances or lines can
 * move the figures.
 *
 * Ported from ExpenseOS 67db2e33 (#589). VeloExpense: the suite's own tenant
 * (`createTenantHarness`) in place of ExpenseOS's seeded test client, so the rows need no
 * clean-up; its own mileage category; the currency is its ISO code; every call runs under RLS.
 */

vi.mock('@/auth', () => ({ auth: vi.fn(async () => null) }));
vi.mock('@/lib/tenant/request', () => ({ hostTenantSlug: async () => null }));

const COUNTRY = 'XB';
const RW = [
  P.expense.report.readOwn,
  P.expense.report.updateOwn,
  P.expense.report.createOwn,
] as const;
const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

describe.skipIf(!process.env.DATABASE_URL)('mileage YTD basis with opening balances', () => {
  let h: TenantHarness;
  let db: any;
  let ytdBasis: typeof import('@/server/lib/mileage').ytdBasis;
  let convertScaled: typeof import('@/server/lib/mileage').convertScaled;
  let roleId: string;
  let importerId: string;
  let currencyId: string;
  let mileageCategoryId: string;
  let ruleId: string;
  const userIds: string[] = [];
  const reportIds: string[] = [];
  const importIds: string[] = [];

  const newUser = async (country: string | null = COUNTRY) => {
    const u = await db.user.create({
      data: {
        email: `mileage-ytd-${Date.now()}-${userIds.length}@example.invalid`,
        firstName: 'Ytd',
        lastName: `Basis${userIds.length}`,
        roleId,
        country,
      },
      select: { id: true },
    });
    userIds.push(u.id);
    return u.id as string;
  };

  const newImport = async (opts: {
    year?: number;
    asOf: string;
    superseded?: boolean;
    balances: { userId: string; distance: string; unit?: 'KM' | 'MI'; country?: string }[];
  }) => {
    const imp = await db.mileageBalanceImport.create({
      data: {
        source: 'concur-ytd-test',
        year: opts.year ?? 2026,
        asOf: day(opts.asOf),
        filename: 'ytd.xlsx',
        importedById: importerId,
        supersededAt: opts.superseded ? new Date() : null,
        balances: {
          create: opts.balances.map((b) => ({
            userId: b.userId,
            country: b.country ?? COUNTRY,
            unit: b.unit ?? 'KM',
            distance: b.distance,
            sourceName: 'Basis, Ytd',
          })),
        },
      },
      select: { id: true },
    });
    importIds.push(imp.id);
    return imp.id as string;
  };

  /** One report + expense + mileage line, written straight to the table. */
  const newLine = async (
    userId: string,
    date: string,
    distance: string,
    opts: { status?: string; unit?: 'KM' | 'MI'; rateId?: string } = {},
  ) => {
    const report = await db.expenseReport.create({
      data: {
        title: 'ytd fixture',
        submitterId: userId,
        currencyId,
        status: opts.status ?? 'DRAFT',
        expenses: {
          create: [{ ownerId: userId, date: day(date), amountMinor: 0n, currencyId }],
        },
      },
      select: { id: true, expenses: { select: { id: true } } },
    });
    reportIds.push(report.id);
    await db.expenseLineItem.create({
      data: {
        expenseId: report.expenses[0].id,
        categoryId: mileageCategoryId,
        kind: 'MILEAGE',
        amountMinor: 0n,
        mileageDistance: distance,
        mileageUnit: opts.unit ?? 'KM',
        mileageRateId: opts.rateId ?? ruleId,
      },
    });
    return report.expenses[0].id as string;
  };

  const basis = (
    userId: string,
    opts: { on?: string; unit?: 'KM' | 'MI'; country?: string } = {},
  ) =>
    ytdBasis(db, {
      userId,
      country: opts.country ?? COUNTRY,
      on: day(opts.on ?? '2026-08-15'),
      unit: opts.unit ?? 'KM',
    });

  beforeAll(async () => {
    h = await createTenantHarness({ slug: 'mileage-ytd', name: 'Mileage YTD' });
    db = h.db;
    ({ ytdBasis, convertScaled } = await import('@/server/lib/mileage'));

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
        data: { label: { en: 'Mileage YTD' }, isMileage: true },
        select: { id: true },
      })
    ).id;

    await db.mileageRate.deleteMany({ where: { country: COUNTRY } });
    // The 2026 CRA shape the feature was built for: 73¢ to 5,000 km, 67¢ after.
    ruleId = (
      await db.mileageRate.create({
        data: {
          country: COUNTRY,
          unit: 'KM',
          effectiveFrom: day('2026-01-01'),
          tiers: {
            create: [
              { fromDistance: '0', rateMinor: 73n },
              { fromDistance: '5000', rateMinor: 67n },
            ],
          },
        },
        select: { id: true },
      })
    ).id;
  });

  afterAll(async () => {
    if (!db) return;
    await db.expenseReport.deleteMany({ where: { id: { in: reportIds } } }).catch(() => {});
    await db.mileageBalanceImport.deleteMany({ where: { id: { in: importIds } } }).catch(() => {});
    await db.mileageRate.deleteMany({ where: { country: COUNTRY } }).catch(() => {});
    await db.user
      .updateMany({ where: { id: { in: userIds } }, data: { deletedAt: new Date() } })
      .catch(() => {});
    await h.end();
  });

  it('carries the balance alone when nothing was claimed here', async () => {
    const u = await newUser();
    await newImport({ asOf: '2026-06-30', balances: [{ userId: u, distance: '1234.5' }] });
    const b = await basis(u);
    expect(b.carriedScaled).toBe(1234_50n);
    expect(b.totalScaled).toBe(1234_50n);
    expect(b.carriedThrough?.toISOString()).toBe('2026-06-30T00:00:00.000Z');
  });

  it('adds lines dated after the period end, and not those on or before it', async () => {
    const u = await newUser();
    await newImport({ asOf: '2026-06-30', balances: [{ userId: u, distance: '1000' }] });
    await newLine(u, '2026-02-10', '400'); // covered by the balance
    await newLine(u, '2026-06-30', '300'); // on the period end: covered too
    await newLine(u, '2026-07-01', '120'); // after
    await newLine(u, '2026-11-30', '30.25'); // after
    const b = await basis(u);
    expect(b.carriedScaled).toBe(1000_00n);
    expect(b.totalScaled).toBe(1150_25n);
  });

  it('ignores a superseded upload in favour of the one in force', async () => {
    const u = await newUser();
    await newImport({
      asOf: '2026-05-31',
      superseded: true,
      balances: [{ userId: u, distance: '3000' }],
    });
    await newImport({ asOf: '2026-07-31', balances: [{ userId: u, distance: '3500' }] });
    await newLine(u, '2026-07-15', '50'); // before the in-force period end
    await newLine(u, '2026-08-05', '10');
    const b = await basis(u);
    expect(b.carriedScaled).toBe(3500_00n);
    expect(b.carriedThrough?.toISOString()).toBe('2026-07-31T00:00:00.000Z');
    expect(b.totalScaled).toBe(3510_00n);
  });

  it('with only a superseded upload, nothing is carried and the whole year counts', async () => {
    const u = await newUser();
    await newImport({
      asOf: '2026-05-31',
      superseded: true,
      balances: [{ userId: u, distance: '3000' }],
    });
    await newLine(u, '2026-02-01', '40');
    const b = await basis(u);
    expect(b).toEqual({ totalScaled: 40_00n, carriedScaled: 0n, carriedThrough: null });
  });

  it('ignores a balance for another year or another country', async () => {
    const u = await newUser();
    await newImport({ year: 2025, asOf: '2025-12-31', balances: [{ userId: u, distance: '900' }] });
    await newImport({
      asOf: '2026-06-30',
      balances: [{ userId: u, distance: '700', country: 'XC' }],
    });
    await newLine(u, '2026-03-01', '25');
    const b = await basis(u);
    expect(b).toEqual({ totalScaled: 25_00n, carriedScaled: 0n, carriedThrough: null });

    // …and the 2025 balance is the basis in 2025 — the year comes from `on`.
    const in2025 = await basis(u, { on: '2025-09-01' });
    expect(in2025.carriedScaled).toBe(900_00n);
    // …and the XC balance belongs to XC.
    const inXc = await basis(u, { country: 'XC' });
    expect(inXc.carriedScaled).toBe(700_00n);
  });

  it('converts a balance kept in miles into kilometres, and the reverse', async () => {
    const u = await newUser();
    await newImport({ asOf: '2026-04-30', balances: [{ userId: u, distance: '100', unit: 'MI' }] });
    const km = await basis(u, { unit: 'KM' });
    expect(km.carriedScaled).toBe(convertScaled(100_00n, 'MI', 'KM'));
    expect(km.carriedScaled).toBe(160_93n);

    const v = await newUser();
    await newImport({ asOf: '2026-04-30', balances: [{ userId: v, distance: '160.93' }] });
    const mi = await basis(v, { unit: 'MI' });
    expect(mi.carriedScaled).toBe(convertScaled(160_93n, 'KM', 'MI'));
  });

  it('never counts mileage on a REJECTED report', async () => {
    const u = await newUser();
    await newImport({ asOf: '2026-06-30', balances: [{ userId: u, distance: '100' }] });
    await newLine(u, '2026-07-10', '80', { status: 'REJECTED' });
    await newLine(u, '2026-07-11', '20', { status: 'SUBMITTED' });
    await newLine(u, '2026-07-12', '5', { status: 'APPROVED' });
    const b = await basis(u);
    expect(b.totalScaled).toBe(125_00n);
  });

  it('with no upload, counts the whole calendar year only (unchanged behaviour)', async () => {
    const u = await newUser();
    await newLine(u, '2025-12-31', '999'); // last year
    await newLine(u, '2026-01-01', '10');
    await newLine(u, '2026-12-31', '20');
    await newLine(u, '2026-05-05', '15', { status: 'REJECTED' });
    const b = await basis(u);
    expect(b).toEqual({ totalScaled: 30_00n, carriedScaled: 0n, carriedThrough: null });
  });

  describe('through the expense editor', () => {
    let caller: any;
    let travellerId: string;
    let expenseId: string;

    beforeAll(async () => {
      travellerId = await newUser();
      await newImport({
        asOf: '2026-06-30',
        balances: [{ userId: travellerId, distance: '4900' }],
      });
      caller = h.makeCaller(RW, travellerId);
      const reportId = (await caller.create({ title: 'Carried over', currency: 'CAD' })).id;
      reportIds.push(reportId);
      expenseId = (await caller.createExpense({ reportId })).id;
      await caller.updateExpense({ expenseId, date: '2026-07-15' });
    });

    it('previews the carried-over part of the basis and the date it runs through', async () => {
      const preview = await caller.mileagePreview({
        expenseId,
        categoryId: mileageCategoryId,
        mileageDistance: '200',
        mileageUnit: 'KM',
      });
      expect(preview).toMatchObject({
        ok: true,
        unit: 'KM',
        distance: '200.00',
        ytdBefore: '4900.00',
        carriedOver: '4900.00',
        amountMinor: '14000',
      });
      expect(new Date(preview.carriedThrough).toISOString()).toBe('2026-06-30T00:00:00.000Z');
    });

    it('splits the first claim after the upload across the 5,000 km band: 73¢ then 67¢', async () => {
      const line = await caller.lineItemCreate({
        expenseId,
        categoryId: mileageCategoryId,
        mileageDistance: '200',
        mileageUnit: 'KM',
      });
      const stored = await db.expenseLineItem.findUniqueOrThrow({ where: { id: line.id } });
      // 100 km × 73¢ + 100 km × 67¢.
      expect(stored.amountMinor).toBe(14_000n);
      expect(stored.mileageYtdBefore.toString()).toBe('4900');
      const breakdown = stored.mileageBreakdown as { rateMinor: string | number }[];
      expect(breakdown.map((s) => Number(s.rateMinor))).toEqual([73, 67]);
    });

    it('previews nothing carried over for someone with no upload', async () => {
      const otherId = await newUser();
      const other = h.makeCaller(RW, otherId);
      const reportId = (await other.create({ title: 'No balance', currency: 'CAD' })).id;
      reportIds.push(reportId);
      const otherExpense = (await other.createExpense({ reportId })).id;
      await other.updateExpense({ expenseId: otherExpense, date: '2026-07-15' });
      const preview = await other.mileagePreview({
        expenseId: otherExpense,
        categoryId: mileageCategoryId,
        mileageDistance: '10',
        mileageUnit: 'KM',
      });
      expect(preview).toMatchObject({
        ok: true,
        ytdBefore: '0.00',
        carriedOver: '0.00',
        carriedThrough: null,
        amountMinor: '730',
      });
    });
  });
});
