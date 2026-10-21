// @vitest-environment node
/* eslint-disable @typescript-eslint/no-explicit-any -- VeloExpense: ExpenseOS's suite reads its rows untyped (`db: any`); Biome allows it there. */
import { permissions as P } from '@expenseos/rbac';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTenantHarness, type TenantHarness } from '../__test-helpers__/tenantHarness';

/**
 * `mileageRoute.recentRoutes` — the "Previous routes" dropdown's read (FR-2).
 *
 * What it has to get right, each against a real database because the behaviour IS the
 * query: only the signed-in person's own lines (by `Expense.ownerId`, never the report's
 * submitter), every report status, newest trip first with the line id as the last word,
 * duplicates removed BEFORE the count of five is reached — across pages, so one
 * well-worn commute cannot crowd out everything else — and only routes that carry a
 * measured chain of legs.
 *
 * Each scenario has its own traveller, so no scenario's lines can appear in another's
 * answer, and every row is created through the tracking client and removed afterwards.
 *
 * Ported from ExpenseOS 67db2e33 (#591). VeloExpense: the suite's own tenant
 * (`createTenantHarness`, truncated by the next suite rather than cleaned row by row), its
 * own categories, its people inserted through the superuser pool, and a REIMBURSED report
 * stamped through that pool to satisfy 0013's CHECKs.
 */

vi.mock('@/auth', () => ({ auth: vi.fn(async () => null) }));
vi.mock('@/lib/tenant/request', () => ({ hostTenantSlug: async () => null }));
vi.mock('@expenseos/jobs', () => ({ enqueue: vi.fn(async () => {}) }));

type Status = 'DRAFT' | 'SUBMITTED' | 'APPROVED' | 'REJECTED' | 'RETURNED' | 'REIMBURSED';

interface Stored {
  stops: { placeId?: string; description: string }[];
  legs?: { fromPlaceId: string; toPlaceId: string; meters: number }[];
  routeLabel?: string;
  routeIndex?: number;
  routeCount?: number;
  via?: { placeId: string; leg: number }[];
}

/** A measured route through `places`, every leg `meters` long. */
function route(places: string[], meters = 10_000, extra: Partial<Stored> = {}): Stored {
  return {
    stops: places.map((p) => ({ placeId: p, description: `${p} street` })),
    legs: places
      .slice(1)
      .map((p, i) => ({ fromPlaceId: places[i] as string, toPlaceId: p, meters })),
    ...extra,
  };
}

interface RecentRoutesCaller {
  recentRoutes: () => Promise<{
    routes: Array<Stored & { distance: { KM: string; MI: string } }>;
  }>;
}

describe.skipIf(!process.env.DATABASE_URL)('mileageRoute.recentRoutes', () => {
  let h: TenantHarness;
  let db: any;
  let createCaller: (userId: string, permissions: readonly string[]) => RecentRoutesCaller;
  const currencyId = 'CAD';
  let mileageCategoryId: string;
  let otherCategoryId: string;
  let seq = 0;

  beforeAll(async () => {
    h = await createTenantHarness({ slug: 'recent-routes', name: 'Recent Routes' });
    db = h.db;
    const { mileageRouteRouter } = await import('@/server/routers/mileageRoute');
    createCaller = (userId, permissions) => h.makeCaller(permissions, userId, mileageRouteRouter);
    // VeloExpense: this suite's own categories (ExpenseOS reads seeded ones).
    mileageCategoryId = (
      await db.expenseCategory.create({
        data: { label: { en: 'Recent mileage' }, isMileage: true },
        select: { id: true },
      })
    ).id;
    otherCategoryId = (
      await db.expenseCategory.create({
        data: { label: { en: 'Recent other' }, isMileage: false },
        select: { id: true },
      })
    ).id;
  });

  afterAll(async () => {
    // VeloExpense: the next suite truncates the tenants; only the pool is ours to close.
    await h?.end();
  });

  async function person(): Promise<string> {
    seq += 1;
    return (
      await h.admin.query(
        `INSERT INTO app_user (organization_id, email, display_name, first_name, last_name)
         VALUES ($1, $2, $3, 'Recent', $4) RETURNING id`,
        [h.orgId, `recent-routes-${Date.now()}-${seq}@example.invalid`, `Recent ${seq}`, `Routes ${seq}`],
      )
    ).rows[0].id as string;
  }

  async function report(submitterId: string, status: Status = 'DRAFT'): Promise<string> {
    // VeloExpense: a REIMBURSED report carries its payment stamp (0013's CHECKs), which the
    // Prisma model does not name, so it is written through the superuser pool.
    const id = (
      await db.expenseReport.create({
        data: {
          title: 'Recent routes',
          currencyId,
          submitterId,
          status: status === 'REIMBURSED' ? 'APPROVED' : status,
        },
        select: { id: true },
      })
    ).id as string;
    if (status === 'REIMBURSED') {
      await h.admin.query(
        `UPDATE expense_report SET status = 'REIMBURSED', reimbursed_at = now(), reimbursed_by_id = $2
          WHERE id = $1`,
        [id, submitterId],
      );
    }
    return id;
  }

  /**
   * One mileage line per entry, each on its own expense, so the expense date orders them.
   * `Prisma.DbNull`-style values are passed through as `stored: null` (SQL NULL) or the
   * `'json-null'` marker (the JSON `null` a cleared route is written as).
   */
  async function lines(
    entries: Array<{
      ownerId: string;
      reportId: string;
      date: string;
      stored: Stored | null | 'json-null' | unknown;
      kind?: 'MILEAGE' | 'STANDARD';
      createdAt?: Date;
      id?: string;
    }>,
  ): Promise<void> {
    const { Prisma } = await import('@expenseos/db');
    const expenses = await db.expense.createManyAndReturn({
      data: entries.map((e) => ({
        ownerId: e.ownerId,
        reportId: e.reportId,
        date: new Date(`${e.date}T12:00:00Z`),
        amountMinor: 0n,
        currencyId,
      })),
      select: { id: true },
    });
    await db.expenseLineItem.createManyAndReturn({
      data: entries.map((e, i) => ({
        ...(e.id ? { id: e.id } : {}),
        expenseId: expenses[i].id,
        kind: e.kind ?? 'MILEAGE',
        categoryId: (e.kind ?? 'MILEAGE') === 'MILEAGE' ? mileageCategoryId : otherCategoryId,
        amountMinor: 0n,
        mileageDistance: '1.00',
        mileageUnit: 'KM',
        mileageRoute:
          e.stored === null
            ? Prisma.DbNull
            : e.stored === 'json-null'
              ? Prisma.JsonNull
              : (e.stored as object),
        ...(e.createdAt ? { createdAt: e.createdAt } : {}),
      })),
      select: { id: true },
    });
  }

  const callerFor = (
    userId: string,
    permissions: readonly string[] = [P.expense.report.updateOwn],
  ) => createCaller(userId, permissions);

  /** The first place id of each returned route — enough to name it in an assertion. */
  const firsts = (out: { routes: Stored[] }) => out.routes.map((r) => r.stops[0]?.placeId);

  it('returns exactly 5, de-duplicated, newest trip first, and only the caller’s', async () => {
    const me = await person();
    const someoneElse = await person();
    const mine = await report(me);
    const theirs = await report(someoneElse);

    await lines([
      // Seven distinct routes, r1 the oldest trip and r7 the newest.
      ...[1, 2, 3, 4, 5, 6, 7].map((n) => ({
        ownerId: me,
        reportId: mine,
        date: `2026-03-${String(n + 10).padStart(2, '0')}`,
        stored: route([`r${n}-a`, `r${n}-b`]),
      })),
      // Older copies of r7 and r6: the same places in the same order are one route.
      { ownerId: me, reportId: mine, date: '2026-02-01', stored: route(['r7-a', 'r7-b'], 99) },
      { ownerId: me, reportId: mine, date: '2026-02-02', stored: route(['r6-a', 'r6-b'], 99) },
      // A newer copy of r5 makes r5 the newest trip; it is listed once, from that copy.
      {
        ownerId: me,
        reportId: mine,
        date: '2026-04-30',
        stored: route(['r5-a', 'r5-b'], 12_345, { routeLabel: 'via the newest copy' }),
      },
      // The same places the other way round are a different route.
      { ownerId: me, reportId: mine, date: '2026-01-01', stored: route(['r7-b', 'r7-a']) },
      // Somebody else's routes, newer than all of mine, never come back.
      ...[1, 2, 3].map((n) => ({
        ownerId: someoneElse,
        reportId: theirs,
        date: `2026-05-0${n}`,
        stored: route([`theirs${n}-a`, `theirs${n}-b`]),
      })),
    ]);

    const out = await callerFor(me).recentRoutes();
    expect(out.routes).toHaveLength(5);
    expect(firsts(out)).toEqual(['r5-a', 'r7-a', 'r6-a', 'r4-a', 'r3-a']);
    expect(out.routes[0]).toMatchObject({ routeLabel: 'via the newest copy' });
    expect(out.routes[0]?.distance).toEqual({ KM: '12.35', MI: '7.67' });
    expect(JSON.stringify(out)).not.toContain('theirs');

    // And the other person, asking, gets only theirs.
    expect(firsts(await callerFor(someoneElse).recentRoutes())).toEqual([
      'theirs3-a',
      'theirs2-a',
      'theirs1-a',
    ]);
  });

  it('keys on the expense owner, never on who submitted the report', async () => {
    const me = await person();
    const colleague = await person();
    // My expense on a report the colleague submitted: my trip.
    const theirReport = await report(colleague);
    // The colleague's expense on a report I submitted: their trip.
    const myReport = await report(me);
    await lines([
      {
        ownerId: me,
        reportId: theirReport,
        date: '2026-03-01',
        stored: route(['mine-a', 'mine-b']),
      },
      {
        ownerId: colleague,
        reportId: myReport,
        date: '2026-03-02',
        stored: route(['colleague-a', 'colleague-b']),
      },
    ]);

    expect(firsts(await callerFor(me).recentRoutes())).toEqual(['mine-a']);
    expect(firsts(await callerFor(colleague).recentRoutes())).toEqual(['colleague-a']);
  });

  it('pages past 60 repeats of one route to still find 5 distinct', async () => {
    const me = await person();
    const r = await report(me);
    const day = (n: number) =>
      new Date(Date.UTC(2026, 5, 1) + n * 86_400_000).toISOString().slice(0, 10);
    await lines([
      // 60 trips on the same commute, the newest — more than a whole page of 50.
      ...Array.from({ length: 60 }, (_, i) => ({
        ownerId: me,
        reportId: r,
        date: day(100 + i),
        stored: route(['home', 'office']),
      })),
      // Six older, distinct routes behind them.
      ...[1, 2, 3, 4, 5, 6].map((n) => ({
        ownerId: me,
        reportId: r,
        date: day(50 - n),
        stored: route([`older${n}-a`, `older${n}-b`]),
      })),
    ]);

    const out = await callerFor(me).recentRoutes();
    expect(firsts(out)).toEqual(['home', 'older1-a', 'older2-a', 'older3-a', 'older4-a']);
  });

  it('skips lines that have no measured route to reuse', async () => {
    const me = await person();
    const r = await report(me);
    const good = route(['good-a', 'good-b']);
    await lines([
      // A stop with no place id (hand-typed), beside legs.
      {
        ownerId: me,
        reportId: r,
        date: '2026-03-10',
        stored: {
          stops: [{ placeId: 'typed-a', description: 'A' }, { description: 'Typed B' }],
          legs: [{ fromPlaceId: 'typed-a', toPlaceId: 'typed-b', meters: 1 }],
        },
      },
      // No legs at all.
      { ownerId: me, reportId: r, date: '2026-03-09', stored: { stops: good.stops } },
      // A leg count other than stops − 1.
      {
        ownerId: me,
        reportId: r,
        date: '2026-03-08',
        stored: {
          ...route(['count-a', 'count-b', 'count-c']),
          legs: route(['count-a', 'count-b']).legs,
        },
      },
      // Legs that do not chain through these stops.
      {
        ownerId: me,
        reportId: r,
        date: '2026-03-07',
        stored: { stops: route(['chain-a', 'chain-b']).stops, legs: route(['x', 'y']).legs },
      },
      // Not a route object at all; a cleared route (JSON null); no route (SQL NULL).
      { ownerId: me, reportId: r, date: '2026-03-06', stored: ['not', 'a', 'route'] },
      { ownerId: me, reportId: r, date: '2026-03-05', stored: 'json-null' },
      { ownerId: me, reportId: r, date: '2026-03-04', stored: null },
      // A route Save would now refuse (an index outside the count offered).
      {
        ownerId: me,
        reportId: r,
        date: '2026-03-03',
        stored: route(['refused-a', 'refused-b'], 1, { routeIndex: 2, routeCount: 1 }),
      },
      // A route left on a line that is not a mileage line.
      {
        ownerId: me,
        reportId: r,
        date: '2026-03-02',
        stored: route(['standard-a', 'standard-b']),
        kind: 'STANDARD',
      },
      // The one eligible line, the oldest of them all.
      { ownerId: me, reportId: r, date: '2026-01-01', stored: good },
    ]);

    expect(firsts(await callerFor(me).recentRoutes())).toEqual(['good-a']);
  });

  it('includes lines on REJECTED and RETURNED reports — every status counts', async () => {
    const me = await person();
    const statuses: Status[] = ['DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'RETURNED'];
    for (const [i, status] of statuses.entries()) {
      await lines([
        {
          ownerId: me,
          reportId: await report(me, status),
          date: `2026-03-1${i}`,
          stored: route([`${status.toLowerCase()}-a`, `${status.toLowerCase()}-b`]),
        },
      ]);
    }

    expect(firsts(await callerFor(me).recentRoutes())).toEqual([
      'returned-a',
      'rejected-a',
      'approved-a',
      'submitted-a',
      'draft-a',
    ]);
  });

  it('builds each entry field by field, omitting a label, index or count that was never stored', async () => {
    const me = await person();
    const r = await report(me);
    await lines([
      // A route chosen in the picker: label, position and count.
      {
        ownerId: me,
        reportId: r,
        date: '2026-03-02',
        stored: {
          ...route(['chosen-a', 'chosen-b', 'chosen-c'], 5_000),
          routeLabel: 'via Hwy 401',
          routeIndex: 1,
          routeCount: 3,
          // A key the contract does not name never reaches the browser.
          encodedPolyline: 'abc',
        },
      },
      // A route stored before routes were chosen: stops and legs only.
      {
        ownerId: me,
        reportId: r,
        date: '2026-03-01',
        stored: route(['legacy-a', 'legacy-b'], 16_093.44),
      },
    ]);

    const out = await callerFor(me).recentRoutes();
    expect(out.routes).toEqual([
      {
        stops: [
          { placeId: 'chosen-a', description: 'chosen-a street' },
          { placeId: 'chosen-b', description: 'chosen-b street' },
          { placeId: 'chosen-c', description: 'chosen-c street' },
        ],
        legs: [
          { fromPlaceId: 'chosen-a', toPlaceId: 'chosen-b', meters: 5_000 },
          { fromPlaceId: 'chosen-b', toPlaceId: 'chosen-c', meters: 5_000 },
        ],
        routeLabel: 'via Hwy 401',
        routeIndex: 1,
        routeCount: 3,
        // The legs' total, not the line's `mileageDistance` ('1.00' on every test line).
        distance: { KM: '10.00', MI: '6.21' },
      },
      {
        stops: [
          { placeId: 'legacy-a', description: 'legacy-a street' },
          { placeId: 'legacy-b', description: 'legacy-b street' },
        ],
        legs: [{ fromPlaceId: 'legacy-a', toPlaceId: 'legacy-b', meters: 16_093.44 }],
        distance: { KM: '16.09', MI: '10.00' },
      },
    ]);
    expect(Object.keys(out.routes[1] ?? {})).toEqual(['stops', 'legs', 'distance']);
  });

  /**
   * A previous route carries the points it passes through (FR-4), so a pick reopens the
   * exact route. The same stops through different points are different roads and
   * different distances, so they are different entries; the same stops through the same
   * points on the same legs are one.
   */
  it('carries `via`, and tells apart the same stops through different points', async () => {
    const me = await person();
    const r = await report(me);
    const stops = ['home', 'mid', 'office'];
    const viaA = [{ placeId: 'ChIJroad-a', leg: 0 }];
    await lines([
      // Newest: home → mid → office through a point on the first leg.
      {
        ownerId: me,
        reportId: r,
        date: '2026-03-06',
        stored: route(stops, 11_000, { via: viaA }),
      },
      // An older copy through the same point on the same leg: the same route.
      {
        ownerId: me,
        reportId: r,
        date: '2026-03-05',
        stored: route(stops, 99, { via: [{ placeId: 'ChIJroad-a', leg: 0 }] }),
      },
      // The same point on the other leg: a different route.
      {
        ownerId: me,
        reportId: r,
        date: '2026-03-04',
        stored: route(stops, 12_000, { via: [{ placeId: 'ChIJroad-a', leg: 1 }] }),
      },
      // Two points, the first of them the newest route's: a different route.
      {
        ownerId: me,
        reportId: r,
        date: '2026-03-03',
        stored: route(stops, 13_000, {
          via: [
            { placeId: 'ChIJroad-a', leg: 0 },
            { placeId: 'ChIJroad-b', leg: 1 },
          ],
        }),
      },
      // The same stops with no point at all: a different route, and no `via` key.
      { ownerId: me, reportId: r, date: '2026-03-02', stored: route(stops, 14_000) },
      // An older copy of that, stored with an empty `via`: the same route as no `via`.
      { ownerId: me, reportId: r, date: '2026-03-01', stored: route(stops, 99, { via: [] }) },
    ]);

    const out = await callerFor(me).recentRoutes();
    expect(out.routes.map((x) => x.legs?.[0]?.meters)).toEqual([11_000, 12_000, 13_000, 14_000]);
    expect(out.routes.map((x) => x.via)).toEqual([
      viaA,
      [{ placeId: 'ChIJroad-a', leg: 1 }],
      [
        { placeId: 'ChIJroad-a', leg: 0 },
        { placeId: 'ChIJroad-b', leg: 1 },
      ],
      undefined,
    ]);
    expect(Object.keys(out.routes[0] ?? {})).toEqual(['stops', 'legs', 'via', 'distance']);
    expect(Object.keys(out.routes[3] ?? {})).toEqual(['stops', 'legs', 'distance']);
  });

  it('rebuilds each `via` point by name: a key a point was stored with never reaches the browser', async () => {
    const me = await person();
    const r = await report(me);
    await lines([
      {
        ownerId: me,
        reportId: r,
        date: '2026-03-01',
        stored: route(['pt-a', 'pt-b'], 10_000, {
          via: [{ placeId: 'ChIJroad-c', leg: 0, lat: 43.6532101, lng: -79.3831843 }],
        } as unknown as Partial<Stored>),
      },
    ]);
    const out = await callerFor(me).recentRoutes();
    expect(out.routes[0]?.via).toEqual([{ placeId: 'ChIJroad-c', leg: 0 }]);
    expect(JSON.stringify(out)).not.toContain('43.65321');
  });

  it('breaks a tie on date and creation time by line id, highest first', async () => {
    const me = await person();
    const r = await report(me);
    const at = new Date('2026-03-01T09:00:00.000Z');
    await lines([
      {
        ownerId: me,
        reportId: r,
        date: '2026-03-01',
        createdAt: at,
        id: '01950000-0000-7000-8000-00000000a001',
        stored: route(['low-a', 'low-b']),
      },
      {
        ownerId: me,
        reportId: r,
        date: '2026-03-01',
        createdAt: at,
        id: '01950000-0000-7000-8000-00000000a002',
        stored: route(['high-a', 'high-b']),
      },
    ]);

    expect(firsts(await callerFor(me).recentRoutes())).toEqual(['high-a', 'low-a']);
  });

  it('answers an empty list to somebody with no mileage lines', async () => {
    await expect(callerFor(await person()).recentRoutes()).resolves.toEqual({ routes: [] });
  });

  it('is refused without the permission to edit one’s own expenses', async () => {
    const me = await person();
    await expect(callerFor(me, [P.expense.report.readOwn]).recentRoutes()).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  /**
   * A previous route carries no drawn path: a row that still holds one from before the
   * stored-geometry rule is offered by its stops and legs alone, and the points it was
   * dragged through decide nothing about whether it is listed.
   */
  it('offers a route from a row that still holds a drawn path, without the path', async () => {
    const me = await person();
    const r = await report(me);
    await lines([
      {
        ownerId: me,
        reportId: r,
        date: '2026-03-02',
        stored: route(['kept-a', 'kept-b'], 10_000, {
          encodedPolyline: 'old~path',
          // Off this route's only leg: Save would refuse it, so it must not decide the listing.
          passThrough: [{ lat: 43.6532101, lng: -79.3831843, leg: 3 }],
          routeFetchedAt: new Date().toISOString(),
        } as Partial<Stored>),
      },
    ]);
    const out = await callerFor(me).recentRoutes();
    expect(firsts(out)).toEqual(['kept-a']);
    expect(Object.keys(out.routes[0] ?? {})).toEqual(['stops', 'legs', 'distance']);
    const wire = JSON.stringify(out);
    for (const text of [
      'encodedPolyline',
      'passThrough',
      'routeFetchedAt',
      'old~path',
      '43.65321',
    ]) {
      expect(wire).not.toContain(text);
    }
  });
});
