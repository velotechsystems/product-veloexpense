// @vitest-environment node
/* eslint-disable @typescript-eslint/no-explicit-any -- VeloExpense: ExpenseOS's suite reads its rows untyped (`db: any`); Biome allows it there. */
import { permissions as P } from '@expenseos/rbac';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTenantHarness, type TenantHarness } from '../__test-helpers__/tenantHarness';

/**
 * `mileageRoute.lineRoutePath` — a saved line's path, asked for each time its small map is
 * shown, and never written anywhere (spec FR-3, NFR-8, NFR-9; security C5, C6).
 *
 * Against a real database because the promise IS the absence of a write: the row's
 * `md5("mileageRoute"::text)`, its whole text and its `updatedAt` are compared before and
 * after, and the audit log is counted. Google is a recorder (`computeRoutes` mocked; the
 * error class and the redaction stay real), and the per-person limit is the REAL
 * fixed-window `throttle` against an in-memory counter.
 *
 * Its own country code and traveller, so no other suite's rates or lines move the figures.
 *
 * Ported from ExpenseOS 67db2e33 (#594). VeloExpense: the suite's own tenant
 * (`createTenantHarness`), its own categories, its people inserted through the superuser
 * pool; the row snapshot and the audit count read VeloExpense's tables through that pool.
 */

vi.mock('@/auth', () => ({ auth: vi.fn(async () => null) }));
vi.mock('@/lib/tenant/request', () => ({ hostTenantSlug: async () => null }));
vi.mock('@expenseos/jobs', () => ({ enqueue: vi.fn(async () => {}) }));

/** What Google was asked, what it answers next, and whether lookup is configured. */
const maps = vi.hoisted(() => ({
  calls: [] as unknown[][],
  answer: null as null | ((placeIds: string[]) => Promise<unknown[]>),
  configured: true,
}));
vi.mock('@/server/platform/googleMaps', async () => {
  const actual = await vi.importActual<typeof import('@/server/platform/googleMaps')>(
    '@/server/platform/googleMaps',
  );
  return {
    ...actual,
    getMapsConfig: async () => (maps.configured ? { apiKey: 'k-test' } : null),
    computeRoutes: async (_cfg: unknown, placeIds: string[], ...rest: unknown[]) => {
      maps.calls.push([placeIds, ...rest]);
      return maps.answer ? maps.answer(placeIds) : [];
    },
  };
});

const limiter = vi.hoisted(() => ({
  counts: new Map<string, number>(),
  calls: [] as unknown[][],
}));
vi.mock('@/server/lib/rateLimit', async () => {
  const actual =
    await vi.importActual<typeof import('@/server/lib/rateLimit')>('@/server/lib/rateLimit');
  // Counted under the caller's own key (`mileage-routes:<user>`), without the limiter's
  // database-scoped prefix, so a test can start the hour part-spent.
  const own = (key: string) => key.slice(Math.max(0, key.indexOf('mileage-routes:')));
  const counter = {
    async incr(key: string) {
      const next = (limiter.counts.get(own(key)) ?? 0) + 1;
      limiter.counts.set(own(key), next);
      return next;
    },
    async expire() {
      return 1;
    },
    async ttl() {
      return 1800;
    },
  };
  return {
    ...actual,
    throttle: async (key: string, cfg: { max: number; windowSec: number }) => {
      limiter.calls.push([key, cfg]);
      return actual.throttle(key, cfg, counter);
    },
  };
});

const RW = [
  P.expense.report.readOwn,
  P.expense.report.updateOwn,
  P.expense.report.createOwn,
] as const;
const COUNTRY = 'XP';

const TORONTO = { description: '100 King St W, Toronto', placeId: 'place-toronto' };
const OTTAWA = { description: '111 Wellington St, Ottawa', placeId: 'place-ottawa' };

/** The route as filed: 412 km, Google's second of three. */
const FILED = {
  stops: [TORONTO, OTTAWA],
  legs: [{ fromPlaceId: 'place-toronto', toPlaceId: 'place-ottawa', meters: 412_000 }],
  routeLabel: 'Hwy 401',
  routeIndex: 1,
  routeCount: 3,
};

/** A route option as `computeRoutes` returns it. */
const option = (km: number, encodedPolyline: string | null) => ({
  index: 0,
  label: `${km} km`,
  totalMeters: km * 1000,
  durationSeconds: 3600,
  legs: [{ fromPlaceId: 'place-toronto', toPlaceId: 'place-ottawa', meters: km * 1000 }],
  encodedPolyline,
});
/** 398, 415 and 440 km against a claim of 412 km — 415 is drawn. */
const THREE = [option(398, 'routeAaa'), option(415, 'routeBbb'), option(440, 'routeCcc')];

describe.skipIf(!process.env.DATABASE_URL)('mileageRoute.lineRoutePath', () => {
  let h: TenantHarness;
  let db: any;
  let expenses: any;
  let path: (lineItemId: string) => Promise<any>;
  let GoogleMapsHttpError: typeof import('@/server/platform/googleMaps').GoogleMapsHttpError;
  let travellerId: string;
  let strangerId: string;
  let reportId: string;
  let expenseId: string;
  let mileageCategoryId: string;
  let otherCategoryId: string;
  let createRoutesCaller: (userId: string) => any;

  beforeAll(async () => {
    h = await createTenantHarness({ slug: 'route-path', name: 'Route Path' });
    db = h.db;
    const { mileageRouteRouter } = await import('@/server/routers/mileageRoute');
    ({ GoogleMapsHttpError } = await import('@/server/platform/googleMaps'));
    createRoutesCaller = (userId: string) => h.makeCaller(RW, userId, mileageRouteRouter);

    const person = async (tag: string) =>
      (
        await h.admin.query(
          `INSERT INTO app_user (organization_id, email, display_name, first_name, last_name, country)
           VALUES ($1, $2, $3, 'Path', $4, $5) RETURNING id`,
          [h.orgId, `route-path-${tag}-${Date.now()}@example.invalid`, `Path ${tag}`, tag, COUNTRY],
        )
      ).rows[0].id as string;
    travellerId = await person('traveller');
    strangerId = await person('stranger');

    await db.mileageRate.create({
      data: {
        country: COUNTRY,
        unit: 'KM',
        effectiveFrom: new Date('2026-01-01T00:00:00Z'),
        tiers: { create: [{ fromDistance: '0', rateMinor: 50n }] },
      },
    });

    expenses = h.makeCaller(RW, travellerId);
    reportId = (await expenses.create({ title: 'Line maps', currency: 'CAD' })).id;
    expenseId = (await expenses.createExpense({ reportId })).id;
    await expenses.updateExpense({ expenseId, date: '2026-03-10' });
    // VeloExpense: this suite's own categories (ExpenseOS reads seeded ones).
    mileageCategoryId = (
      await db.expenseCategory.create({
        data: { label: { en: 'Mileage on a map' }, isMileage: true },
        select: { id: true },
      })
    ).id;
    otherCategoryId = (
      await db.expenseCategory.create({
        data: { label: { en: 'Not mileage' }, isMileage: false },
        select: { id: true },
      })
    ).id;

    const routes = createRoutesCaller(travellerId);
    path = (lineItemId: string) => routes.lineRoutePath({ lineItemId });
  });

  afterAll(async () => {
    // VeloExpense: the next suite truncates the tenants; only the pool is ours to close.
    await h?.end();
  });

  beforeEach(() => {
    maps.calls.length = 0;
    maps.answer = async () => THREE;
    maps.configured = true;
    limiter.counts.clear();
    limiter.calls.length = 0;
  });

  /** A 412 km line filed through the real create, with this route. */
  async function filedLine(route: unknown = FILED) {
    const { id } = await expenses.lineItemCreate({
      expenseId,
      categoryId: mileageCategoryId,
      mileageDistance: '412',
      mileageUnit: 'KM',
      mileageRoute: route,
    });
    return id as string;
  }

  /** A filed line whose route is then written straight to the column, as given. */
  async function seededLine(route: unknown) {
    const id = await filedLine(null);
    await db.expenseLineItem.update({ where: { id }, data: { mileageRoute: route } });
    return id;
  }

  /** Everything about the line as PostgreSQL holds it, and the route's version. */
  async function snapshot(id: string) {
    // VeloExpense: through the superuser pool, VeloExpense's table and column names.
    const [row] = (
      await h.admin.query(
        `SELECT to_jsonb(li)::text AS "line",
                md5(li.mileage_route::text) AS "version",
                li.updated_at AS "updatedAt",
                to_jsonb(e)::text AS "expense",
                to_jsonb(r)::text AS "report"
           FROM expense_line_item li
           JOIN expense e ON e.id = li.expense_id
           JOIN expense_report r ON r.id = e.report_id
          WHERE li.id = $1`,
        [id],
      )
    ).rows;
    return row as {
      line: string;
      version: string | null;
      updatedAt: Date;
      expense: string;
      report: string;
    };
  }

  /** Every audit row about this line, the expense or the report. */
  const auditCount = async (id: string) =>
    Number(
      (
        await h.admin.query(
          'SELECT count(*)::int AS n FROM audit_entry WHERE entity_id = ANY($1::uuid[])',
          [[id, expenseId, reportId]],
        )
      ).rows[0].n,
    );

  // ── FR-3: the path is drawn, and nothing is written ────────────────────────────────

  it('answers the route closest to the claim, and writes nothing: same md5, same updatedAt, no audit row', async () => {
    const id = await filedLine();
    const before = await snapshot(id);
    const auditBefore = await auditCount(id);

    await expect(path(id)).resolves.toEqual({ encodedPolyline: 'routeBbb' });

    // ONE Google call from the stored stops alone, and ONE count.
    expect(maps.calls).toEqual([[['place-toronto', 'place-ottawa'], []]]);
    expect(limiter.calls).toEqual([
      [`mileage-routes:${travellerId}`, { max: 300, windowSec: 3600 }],
    ]);

    const after = await snapshot(id);
    expect(after.version).toBe(before.version);
    expect(after.line).toBe(before.line);
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
    expect(after.expense).toBe(before.expense);
    expect(after.report).toBe(before.report);
    expect(await auditCount(id)).toBe(auditBefore);
  });

  it('asks again on every view: nothing is kept between two calls', async () => {
    const id = await filedLine();
    await path(id);
    await path(id);
    expect(maps.calls).toHaveLength(2);
    expect(limiter.calls).toHaveLength(2);
  });

  it('routes the stored stops only, whatever else the stored route carries', async () => {
    const id = await seededLine({
      ...FILED,
      encodedPolyline: 'storedPath',
      passThrough: [{ lat: 44.9, lng: -76.2, leg: 0 }],
      routeFetchedAt: '2026-09-01T10:00:00.000Z',
    });
    const before = await snapshot(id);
    await expect(path(id)).resolves.toEqual({ encodedPolyline: 'routeBbb' });
    expect(maps.calls).toEqual([[['place-toronto', 'place-ottawa'], []]]);
    expect((await snapshot(id)).version).toBe(before.version);
  });

  it('routes through the stored via place IDs, so the map is the route that was filed', async () => {
    const via = [
      { placeId: 'road-kingston', leg: 0 },
      { placeId: 'road-brockville', leg: 0 },
    ];
    const id = await seededLine({ ...FILED, via });
    const before = await snapshot(id);
    // With a via Google answers the one route there is; it is drawn.
    maps.answer = async () => [option(450, 'routeVia')];
    await expect(path(id)).resolves.toEqual({ encodedPolyline: 'routeVia' });
    expect(maps.calls).toEqual([[['place-toronto', 'place-ottawa'], via]]);
    expect(limiter.calls).toHaveLength(1);
    expect((await snapshot(id)).version).toBe(before.version);
  });

  it('answers null when Routes refuses a stored via place ID — counted, nothing written', async () => {
    const id = await seededLine({ ...FILED, via: [{ placeId: 'road-kingston', leg: 0 }] });
    const before = await snapshot(id);
    maps.answer = async () => {
      throw new GoogleMapsHttpError('Google Maps 400: Invalid waypoint', 400, 'INVALID_ARGUMENT');
    };
    await expect(path(id)).resolves.toEqual({ encodedPolyline: null });
    expect(limiter.calls).toHaveLength(1);
    expect((await snapshot(id)).line).toBe(before.line);
  });

  it('with no claim, draws Google’s first route', async () => {
    const id = await filedLine();
    await db.expenseLineItem.update({
      where: { id },
      data: { mileageDistance: null, mileageDistanceOverride: null },
    });
    await expect(path(id)).resolves.toEqual({ encodedPolyline: 'routeAaa' });
  });

  // ── Nothing to route: no call, no count ────────────────────────────────────────────

  it.each([
    ['a line with no route', null],
    ['a stop without a place ID', { ...FILED, stops: [{ description: 'Toronto' }, OTTAWA] }],
    ['a route with one stop', { ...FILED, stops: [TORONTO], legs: [] }],
    ['a via point off the route', { ...FILED, via: [{ placeId: 'road-x', leg: 1 }] }],
    ['a via point with no place ID', { ...FILED, via: [{ leg: 0 }] }],
    ['a via that is not a list', { ...FILED, via: 'road-x' }],
  ])('answers null for %s, with no Google call and no count', async (_label, route) => {
    const id = await seededLine(route);
    await expect(path(id)).resolves.toEqual({ encodedPolyline: null });
    expect(maps.calls).toHaveLength(0);
    expect(limiter.calls).toHaveLength(0);
  });

  it('answers null for a line that is not a mileage line, with no call and no count', async () => {
    const { id } = await expenses.lineItemCreate({
      expenseId,
      categoryId: otherCategoryId,
      amountMinor: '1000',
    });
    await db.expenseLineItem.update({ where: { id }, data: { mileageRoute: FILED } });
    await expect(path(id)).resolves.toEqual({ encodedPolyline: null });
    expect(maps.calls).toHaveLength(0);
    expect(limiter.calls).toHaveLength(0);
  });

  // ── Refusals before any count (C5, C6) ─────────────────────────────────────────────

  it('is NOT_FOUND for somebody who does not write the line, before any count', async () => {
    const id = await filedLine();
    const stranger = createRoutesCaller(strangerId);
    await expect(stranger.lineRoutePath({ lineItemId: id })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(
      stranger.lineRoutePath({ lineItemId: '00000000-0000-7000-8000-00000000dead' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(maps.calls).toHaveLength(0);
    expect(limiter.calls).toHaveLength(0);
  });

  it('refuses a submitted report as not editable, before any count', async () => {
    const id = await filedLine();
    await db.expenseReport.update({ where: { id: reportId }, data: { status: 'SUBMITTED' } });
    try {
      await expect(path(id)).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        message: 'Report is not editable.',
      });
    } finally {
      await db.expenseReport.update({ where: { id: reportId }, data: { status: 'DRAFT' } });
    }
    expect(maps.calls).toHaveLength(0);
    expect(limiter.calls).toHaveLength(0);
  });

  it('refuses when lookup is not configured, before any count', async () => {
    const id = await filedLine();
    maps.configured = false;
    await expect(path(id)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(maps.calls).toHaveLength(0);
    expect(limiter.calls).toHaveLength(0);
  });

  it('refuses any key besides the line id', async () => {
    const id = await filedLine();
    const routes = createRoutesCaller(travellerId);
    await expect(
      routes.lineRoutePath({ lineItemId: id, placeIds: ['a', 'b'] }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(maps.calls).toHaveLength(0);
  });

  // ── Google's answers ───────────────────────────────────────────────────────────────

  it.each([
    ['zero routes', async () => []],
    ['routes with no drawn path', async () => [option(398, null), option(415, null)]],
    [
      'Google’s NOT_FOUND on a place',
      async () => {
        throw new GoogleMapsHttpError('Google Maps 404: Place not found', 404, 'NOT_FOUND');
      },
    ],
  ])('answers null on %s — counted, and nothing written', async (_label, answer) => {
    const id = await filedLine();
    const before = await snapshot(id);
    maps.answer = answer as never;
    await expect(path(id)).resolves.toEqual({ encodedPolyline: null });
    expect(limiter.calls).toHaveLength(1);
    expect((await snapshot(id)).line).toBe(before.line);
  });

  it.each([
    ['a 403', () => new GoogleMapsHttpError('Google Maps 403: denied', 403, 'PERMISSION_DENIED')],
    ['a 429', () => new GoogleMapsHttpError('Google Maps 429: quota', 429, 'RESOURCE_EXHAUSTED')],
    ['a timeout', () => new DOMException('This operation was aborted', 'AbortError')],
  ])('reports %s redacted, with no cause, and writes nothing', async (_label, failure) => {
    const id = await filedLine();
    const before = await snapshot(id);
    const auditBefore = await auditCount(id);
    maps.answer = async () => {
      throw failure();
    };
    const err = await path(id).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
    expect((err as { cause?: unknown }).cause).toBeUndefined();
    expect((await snapshot(id)).line).toBe(before.line);
    expect(await auditCount(id)).toBe(auditBefore);
  });

  // ── NFR-8: the line map shares the lookup budget ───────────────────────────────────

  it('allows the 300th lookup in the hour and refuses the 301st with no Google call', async () => {
    const id = await filedLine();
    limiter.counts.set(`mileage-routes:${travellerId}`, 299);
    await expect(path(id)).resolves.toEqual({ encodedPolyline: 'routeBbb' });
    expect(maps.calls).toHaveLength(1);

    await expect(path(id)).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
    expect(maps.calls).toHaveLength(1);
  });
});
