// @vitest-environment node
/* eslint-disable @typescript-eslint/no-explicit-any -- the harness reads rows untyped (`db: any`). */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';
import { permissions as P } from '@expenseos/rbac';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createTenantHarness,
  type TenantHarness,
} from '@/server/__test-helpers__/tenantHarness';

/**
 * Migration 0083 (`mileage_route_no_stored_geometry`) against a real Postgres.
 *
 * Ported from ExpenseOS 67db2e33 `packages/db/src/mileageRouteGeometryMigration.db.test.ts`
 * (#594). The migration IS its SQL, so what matters is what a database shows:
 *
 *   · **The three keys go, the claim stays.** A route loses `encodedPolyline`,
 *     `passThrough` and `routeFetchedAt` and keeps every other key as equal JSONB values.
 *   · **Nothing else on the row moves**, `updated_at` included.
 *   · **Idempotent.** A second run changes nothing.
 *   · **Only object routes are touched.** An array that merely names the keys, a scalar,
 *     JSON null and SQL NULL are left exactly as they are.
 *
 * VeloExpense differences:
 *   · No `SystemFlag` case: VeloExpense never had ExpenseOS's `mileageRouteGeometry` flag.
 *   · The run happens as the APP role (`DATABASE_URL`, not the superuser), which FORCE
 *     row-level security applies to — the same constraint the migration login has on RDS
 *     (tracker f08). A plain UPDATE there with no tenant set changes no row, which this
 *     suite shows; the migration's per-tenant loop is what reaches the rows.
 *   · The suite's own tenant (`createTenantHarness`), its own mileage category and rate;
 *     lines are filed through the real `lineItemCreate`, then the column is written with
 *     the fixture through the superuser pool, as an old row could hold it.
 */

vi.mock('@/auth', () => ({ auth: vi.fn(async () => null) }));
vi.mock('@/lib/tenant/request', () => ({ hostTenantSlug: async () => null }));
vi.mock('@expenseos/jobs', () => ({ enqueue: vi.fn(async () => {}) }));
vi.mock('@/server/platform/googleMaps', async () => {
  const actual = await vi.importActual<typeof import('@/server/platform/googleMaps')>(
    '@/server/platform/googleMaps',
  );
  return { ...actual, getMapsConfig: async () => null };
});

const MIGRATION = readFileSync(
  join(__dirname, '..', 'prisma', 'migrations', '0083_mileage_route_no_stored_geometry', 'migration.sql'),
  'utf8',
);
/** The SQL without its commentary. */
const SQL = MIGRATION.split('\n')
  .filter((line) => !line.trimStart().startsWith('--'))
  .join('\n')
  .trim();
const KEYS = "ARRAY['encodedPolyline', 'passThrough', 'routeFetchedAt']";

describe('0083_mileage_route_no_stored_geometry: the statement', () => {
  it('is one DO block that sets the tenant for each organization and clears it after', () => {
    expect(SQL).toMatch(/^DO \$\$/);
    expect(SQL).toMatch(/FOR org IN SELECT id FROM organization LOOP/);
    expect(SQL).toMatch(/set_config\('app\.current_org', org::text, true\)/);
    expect(SQL).toMatch(/set_config\('app\.current_org', '', true\)/);
  });

  it('guards the update on an object route, scopes it to the tenant, names exactly the three keys', () => {
    expect(SQL).toMatch(/jsonb_typeof\(mileage_route\) = 'object'/);
    expect(SQL).toMatch(/WHERE organization_id = org/);
    expect(SQL.split(KEYS)).toHaveLength(3);
    expect(SQL).not.toMatch(/updated_at/);
  });

  it('touches no flag table (VeloExpense never had one)', () => {
    expect(SQL).not.toMatch(/SystemFlag|system_flag/i);
  });
});

const RW = [P.expense.report.readOwn, P.expense.report.updateOwn, P.expense.report.createOwn] as const;
const COUNTRY = 'XG';

describe.skipIf(!process.env.DATABASE_URL)('0083_mileage_route_no_stored_geometry (db)', () => {
  let h: TenantHarness;
  let app: Pool;
  let ids: string[];
  let before: Map<string, { rest: string; route: unknown; isNull: boolean }>;
  let afterFirst: Map<string, { rest: string; route: unknown; isNull: boolean }>;
  let afterSecond: Map<string, { rest: string; route: unknown; isNull: boolean }>;
  let plainUpdateCount: number;

  /** The claim keys a stored route keeps. Fixture values. */
  const claim = {
    stops: [
      { placeId: 'pl-a', description: 'A street' },
      { placeId: 'pl-b', description: 'B street' },
    ],
    legs: [{ fromPlaceId: 'pl-a', toPlaceId: 'pl-b', meters: 412_000 }],
    routeLabel: 'via Hwy 401',
    routeIndex: 1,
    routeCount: 3,
  };
  const via = [{ placeId: 'pl-via', leg: 0 }];
  const drawn = {
    encodedPolyline: '_p~iF~ps|U_ulLnnqC_mqNvxq`@',
    passThrough: [{ lat: 43.6532101, lng: -79.3831843, leg: 0 }],
    routeFetchedAt: '2026-10-01T12:00:00.000Z',
  };
  const SQL_NULL = Symbol('sql-null');

  /** label, route as written, route expected after the migration. */
  const CASES: Array<[string, unknown, unknown]> = [
    ['all three keys and via', { ...claim, ...drawn, via }, { ...claim, via }],
    ['all three keys, no via', { ...claim, ...drawn }, claim],
    ['only the path', { ...claim, encodedPolyline: drawn.encodedPolyline }, claim],
    ['only the points', { ...claim, passThrough: drawn.passThrough }, claim],
    ['only the stamp', { ...claim, routeFetchedAt: drawn.routeFetchedAt }, claim],
    ['none of the keys', { ...claim, via }, { ...claim, via }],
    [
      'an array that merely names the keys',
      ['encodedPolyline', 'passThrough', 'routeFetchedAt'],
      ['encodedPolyline', 'passThrough', 'routeFetchedAt'],
    ],
    ['a scalar string that is a key name', 'encodedPolyline', 'encodedPolyline'],
    ['a scalar number', 5, 5],
    ['JSON null', null, null],
    ['SQL NULL', SQL_NULL, null],
  ];

  async function snapshot(lineIds: string[]) {
    const rows = (
      await h.admin.query(
        `SELECT li.id::text AS id,
                (to_jsonb(li) - 'mileage_route')::text AS rest,
                li.mileage_route AS route,
                li.mileage_route IS NULL AS "isNull"
           FROM expense_line_item li
          WHERE li.id = ANY($1::uuid[])`,
        [lineIds],
      )
    ).rows as Array<{ id: string; rest: string; route: unknown; isNull: boolean }>;
    return new Map(rows.map((r) => [r.id, r]));
  }

  beforeAll(async () => {
    h = await createTenantHarness({ slug: 'route-geometry-mig', name: 'Route Geometry Migration' });
    app = new Pool({ connectionString: process.env.DATABASE_URL });
    const travellerId = (
      await h.admin.query(
        `INSERT INTO app_user (organization_id, email, display_name, first_name, last_name, country)
         VALUES ($1, $2, 'Geo Traveller', 'Geo', 'Traveller', $3) RETURNING id`,
        [h.orgId, `route-geometry-${Date.now()}@example.invalid`, COUNTRY],
      )
    ).rows[0].id as string;
    await h.db.mileageRate.create({
      data: {
        country: COUNTRY,
        unit: 'KM',
        effectiveFrom: new Date('2026-01-01T00:00:00Z'),
        tiers: { create: [{ fromDistance: '0', rateMinor: 60n }] },
      },
    });
    const categoryId = (
      await h.db.expenseCategory.create({
        data: { label: { en: 'Mileage, migration' }, isMileage: true },
        select: { id: true },
      })
    ).id as string;

    // One line per case, each on its own expense, all on one draft report.
    const expenses = h.makeCaller(RW, travellerId);
    const reportId = (await expenses.create({ title: 'Route geometry', currency: 'CAD' })).id;
    ids = [];
    for (let i = 0; i < CASES.length; i++) {
      const expenseId = (await expenses.createExpense({ reportId })).id;
      await expenses.updateExpense({ expenseId, date: '2026-03-10' });
      const { id } = await expenses.lineItemCreate({
        expenseId,
        categoryId,
        mileageDistance: '412',
        mileageUnit: 'KM',
      });
      ids.push(id as string);
    }
    // The fixture routes, written as an old row could hold them (superuser: RLS aside).
    for (const [i, [, written]] of CASES.entries()) {
      await h.admin.query(
        written === SQL_NULL
          ? 'UPDATE expense_line_item SET mileage_route = NULL WHERE id = $1'
          : 'UPDATE expense_line_item SET mileage_route = $2::jsonb WHERE id = $1',
        written === SQL_NULL ? [ids[i]] : [ids[i], JSON.stringify(written)],
      );
    }
    // Back-date updated_at so a bump would show.
    await h.admin.query(
      `UPDATE expense_line_item SET updated_at = '2026-03-10T09:00:00Z' WHERE id = ANY($1::uuid[])`,
      [ids],
    );

    before = await snapshot(ids);

    // The app role, with no tenant set, sees no row (FORCE RLS): a plain UPDATE does nothing.
    plainUpdateCount = (
      await app.query(
        `UPDATE expense_line_item
            SET mileage_route = mileage_route - ${KEYS}
          WHERE jsonb_typeof(mileage_route) = 'object'
            AND mileage_route ?| ${KEYS}`,
      )
    ).rowCount ?? 0;

    await app.query(MIGRATION);
    afterFirst = await snapshot(ids);
    await app.query(MIGRATION);
    afterSecond = await snapshot(ids);
  });

  afterAll(async () => {
    await app?.end();
    await h?.end();
  });

  it('a plain UPDATE with no tenant set changes no row: why the migration loops per tenant (f08)', () => {
    expect(plainUpdateCount).toBe(0);
    for (const [i, [, written]] of CASES.entries()) {
      if (written === SQL_NULL) continue;
      expect(before.get(ids[i] as string)?.route).toEqual(written);
    }
  });

  it.each(CASES.map(([label, , expected], i) => [label, expected, i] as const))(
    'leaves %s as expected',
    (_label, expected, i) => {
      expect(afterFirst.get(ids[i] as string)?.route).toEqual(expected);
    },
  );

  it('keeps SQL NULL a SQL NULL, and JSON null a JSON null', () => {
    const at = (label: string) => ids[CASES.findIndex(([l]) => l === label)] as string;
    expect(afterFirst.get(at('SQL NULL'))?.isNull).toBe(true);
    expect(afterFirst.get(at('JSON null'))?.isNull).toBe(false);
  });

  it('leaves every other column byte-identical, updated_at included', () => {
    for (const id of ids) expect(afterFirst.get(id)?.rest, id).toBe(before.get(id)?.rest);
  });

  it('is idempotent: a second run changes nothing', () => {
    for (const id of ids) {
      expect(afterSecond.get(id)?.rest).toBe(afterFirst.get(id)?.rest);
      expect(afterSecond.get(id)?.route).toEqual(afterFirst.get(id)?.route);
    }
  });

  it('leaves no coordinate, path or stamp on any route', () => {
    const text = JSON.stringify([...afterFirst.values()].map((r) => r.route));
    for (const leftover of [drawn.encodedPolyline, '43.65321', drawn.routeFetchedAt]) {
      expect(text).not.toContain(leftover);
    }
  });

  it('leaves the session with no tenant set', async () => {
    const c = await app.connect();
    try {
      await c.query(MIGRATION);
      const { rows } = await c.query(`SELECT current_setting('app.current_org', true) AS org`);
      expect(rows[0].org ?? '').toBe('');
    } finally {
      c.release();
    }
  });
});
