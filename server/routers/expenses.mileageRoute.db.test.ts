// @vitest-environment node
/* eslint-disable @typescript-eslint/no-explicit-any -- VeloExpense: ExpenseOS's suite reads its rows untyped (`db: any`); Biome allows it there. */
import { permissions as P } from '@expenseos/rbac';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTenantHarness, type TenantHarness } from '../__test-helpers__/tenantHarness';

/**
 * A mileage line's route is checked on write and stored as the checked result only — and
 * nothing Google drew is stored or served: a route is its stops, legs, label, position,
 * count and `via` (pass-through points as place IDs), and no other key.
 *
 * `lineItemCreate` / `lineItemUpdate` parse the route with the shared write schema
 * (`lib/mileageRouteSchema.ts`): a body that fails is BAD_REQUEST and nothing is written,
 * a key the schema does not name never reaches the database, and an empty label is stored
 * as no key at all. On top of that, every write and the writer's read pass through one
 * allow-list (`storedRoute`, `server/lib/mileageRouteView.ts`), so a drawn path, dragged
 * lat/lng points or a fetch stamp — sent by an older client, or left on a row stored
 * before the rule — is neither stored nor served, to the writer or anyone else.
 *
 * Against a real database because "nothing is written" and "the stored JSON" are the
 * behaviour. Its own country code and its own traveller, so no other suite's rates or
 * lines can change the figures.
 *
 * Ported from ExpenseOS 67db2e33 (#591, #594). VeloExpense: the suite's own tenant
 * (`createTenantHarness`), its own mileage category, its people inserted through the
 * superuser pool; every call runs under RLS. VeloExpense has no per-person home currency
 * (d92): a person is "paid in USD" through a USD legal entity, the link the shared currency
 * rule reads. The audit rows are VeloExpense's `audit_entry`.
 */

vi.mock('@/auth', () => ({ auth: vi.fn(async () => null) }));
vi.mock('@/lib/tenant/request', () => ({ hostTenantSlug: async () => null }));
vi.mock('@expenseos/jobs', () => ({ enqueue: vi.fn(async () => {}) }));

const RW = [
  P.expense.report.readOwn,
  P.expense.report.updateOwn,
  P.expense.report.createOwn,
] as const;
const COUNTRY = 'XM';

/** A route the editor wrote before routes were chosen: a picked stop, a hand-typed
 *  one, an untouched empty one — and legs from an earlier lookup. */
const PRE_CHANGE_ROUTE = {
  stops: [
    { description: 'Head office', placeId: 'place-office' },
    { description: 'Client site' },
    { description: '' },
  ],
  legs: [{ fromPlaceId: 'place-office', toPlaceId: 'place-client', meters: 20_000 }],
};

const CHOSEN_ROUTE = {
  stops: [
    { description: '100 King St W, Toronto', placeId: 'place-toronto' },
    { description: '111 Wellington St, Ottawa', placeId: 'place-ottawa' },
  ],
  legs: [{ fromPlaceId: 'place-toronto', toPlaceId: 'place-ottawa', meters: 450_000 }],
  routeLabel: 'Hwy 401',
  routeIndex: 1,
  routeCount: 3,
};

const POLYLINE = 'a~l~Fjk~uOwHJy@P';
/** Digits that must never appear anywhere. */
const POINT_DIGITS = '43.65321';
const POINTS = [{ lat: 43.6532101, lng: -79.3831843, leg: 0 }];
const STAMP = '2026-10-01T12:00:00.000Z';
const VIA = [{ placeId: 'place-kingston', leg: 0 }];

/** The chosen route with the three keys a drawn route used to be stored with. */
const withDrawing = (over: Record<string, unknown> = {}) => ({
  ...CHOSEN_ROUTE,
  encodedPolyline: POLYLINE,
  passThrough: POINTS,
  routeFetchedAt: STAMP,
  ...over,
});

/** Find a line by id anywhere in a read's answer, whatever its nesting. */
function findLine(value: unknown, id: string): any {
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = findLine(item, id);
      if (hit) return hit;
    }
    return null;
  }
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if (obj.id === id && 'mileageRoute' in obj) return obj;
    for (const inner of Object.values(obj)) {
      const hit = findLine(inner, id);
      if (hit) return hit;
    }
  }
  return null;
}

const expectNoGeometry = (value: unknown) => {
  const wire = JSON.stringify(value);
  for (const text of [
    'encodedPolyline',
    'passThrough',
    'routeFetchedAt',
    '"lat"',
    '"lng"',
    POINT_DIGITS,
    POLYLINE,
  ]) {
    expect(wire).not.toContain(text);
  }
};

describe.skipIf(!process.env.DATABASE_URL)('the stored route on a mileage line', () => {
  let h: TenantHarness;
  let db: any;
  let caller: any;
  let travellerId: string;
  let managerId: string;
  let apId: string;
  let reportId: string;
  let expenseId: string;
  let mileageCategoryId: string;
  let usdEntityId: string;
  let cadEntityId: string;

  /** A person in the suite's tenant, inserted as the superuser (VeloExpense). */
  const person = async (
    tag: string,
    extra: { country?: string; managerId?: string; legalEntityId?: string } = {},
  ) =>
    (
      await h.admin.query(
        `INSERT INTO app_user
           (organization_id, email, display_name, first_name, last_name, country, manager_id,
            legal_entity_id)
         VALUES ($1, $2, $3, 'Route', $4, $5, $6, $7) RETURNING id`,
        [
          h.orgId,
          `mileage-route-${tag}-${Date.now()}@example.invalid`,
          `Route ${tag}`,
          tag,
          extra.country ?? null,
          extra.managerId ?? null,
          extra.legalEntityId ?? null,
        ],
      )
    ).rows[0].id as string;
  const entity = async (label: string, currency: string) =>
    (
      await h.admin.query(
        `INSERT INTO legal_entity (organization_id, label, currency_code)
         VALUES ($1, $2::jsonb, $3) RETURNING id`,
        [h.orgId, JSON.stringify({ en: label }), currency],
      )
    ).rows[0].id as string;

  beforeAll(async () => {
    h = await createTenantHarness({ slug: 'mileage-route', name: 'Mileage Route' });
    db = h.db;
    // CAD first: the tenant's MAIN entity (its oldest with a currency) is the currency floor
    // for a person with no entity of their own, and that floor must be CAD here.
    cadEntityId = await entity('Route CAD Ltd.', 'CAD');
    usdEntityId = await entity('Route USD Inc.', 'USD');
    managerId = await person('manager');
    apId = await person('ap');
    travellerId = await person('chooser', { country: COUNTRY, managerId });

    // 50¢/km all year; one rate change from July, for the date-move test.
    for (const [from, to, rateMinor] of [
      ['2026-01-01', '2026-06-30', 50],
      ['2026-07-01', null, 80],
    ] as const) {
      await db.mileageRate.create({
        data: {
          country: COUNTRY,
          unit: 'KM',
          effectiveFrom: new Date(`${from}T00:00:00Z`),
          effectiveTo: to ? new Date(`${to}T23:59:59Z`) : null,
          tiers: { create: [{ fromDistance: '0', rateMinor: BigInt(rateMinor) }] },
        },
      });
    }

    caller = h.makeCaller(RW, travellerId);
    reportId = (await caller.create({ title: 'Routes on file', currency: 'CAD' })).id;
    expenseId = (await caller.createExpense({ reportId })).id;
    await caller.updateExpense({ expenseId, date: '2026-03-10' });
    // VeloExpense: this suite's own mileage category (ExpenseOS reads a seeded one).
    mileageCategoryId = (
      await db.expenseCategory.create({
        data: { label: { en: 'Mileage on a route' }, isMileage: true },
        select: { id: true },
      })
    ).id;
  });

  afterAll(async () => {
    // VeloExpense: the next suite truncates the tenants; only the pool is ours to close.
    await h?.end();
  });

  const addLine = (mileageRoute: unknown) =>
    caller.lineItemCreate({
      expenseId,
      categoryId: mileageCategoryId,
      mileageDistance: '450',
      mileageUnit: 'KM',
      mileageRoute,
    });
  /** A line whose route is written straight to the column — as a write from before the
   *  stored-geometry rule left it, or as an unchecked old write did. */
  const seededLine = async (route: unknown) => {
    const { id } = await addLine(null);
    await db.expenseLineItem.update({ where: { id }, data: { mileageRoute: route } });
    return id as string;
  };
  const storedRoute = async (id: string) =>
    (await db.expenseLineItem.findUniqueOrThrow({ where: { id } })).mileageRoute;
  const lineCount = () => db.expenseLineItem.count({ where: { expenseId } });
  const writerLine = async (id: string) => findLine(await caller.report({ reportId }), id);
  const withStatus = async (status: string, run: () => Promise<void>) => {
    await db.expenseReport.update({ where: { id: reportId }, data: { status } });
    try {
      await run();
    } finally {
      await db.expenseReport.update({ where: { id: reportId }, data: { status: 'DRAFT' } });
    }
  };

  describe('the route itself', () => {
    it('stores the chosen route and reads it back with its label, position and count', async () => {
      const { id } = await addLine(CHOSEN_ROUTE);
      expect(await storedRoute(id)).toEqual(CHOSEN_ROUTE);

      // The writer's read returns the route as stored; the pricing is untouched by it.
      const line = await writerLine(id);
      expect(line.mileageRoute).toMatchObject({
        routeLabel: 'Hwy 401',
        routeIndex: 1,
        routeCount: 3,
      });
      expect(line.amountMinor).toBe('22500'); // 450 km × 50¢
      await caller.lineItemRemove({ id });
    });

    it('stores only what the schema names: no stop coordinates, no empty label', async () => {
      const { id } = await addLine({
        ...CHOSEN_ROUTE,
        stops: CHOSEN_ROUTE.stops.map((s) => ({ ...s, lat: 45.4, lng: -75.7 })),
        routeLabel: '   ',
        drawnPath: 'a~l~Fjk~uOwHJy@P',
      });
      const stored = await storedRoute(id);
      const { routeLabel: _dropped, ...withoutLabel } = CHOSEN_ROUTE;
      expect(stored).toEqual(withoutLabel);
      expect(Object.hasOwn(stored, 'routeLabel')).toBe(false);
      const json = JSON.stringify(stored);
      for (const key of ['drawnPath', 'lat', 'lng', 'routeLabel']) {
        expect(json).not.toContain(`"${key}"`);
      }
      await caller.lineItemRemove({ id });
    });

    it('refuses an invalid route on create, and adds no line', async () => {
      const before = await lineCount();
      for (const bad of [
        { stops: [{ description: 'Only one stop' }] },
        { ...CHOSEN_ROUTE, routeIndex: 3 },
        { ...CHOSEN_ROUTE, routeLabel: 'x'.repeat(121) },
        { ...CHOSEN_ROUTE, legs: [{ distance: '4.20' }] },
        'not a route',
        // Stops plus via points past the shared 25: 2 + 24 = 26.
        {
          ...CHOSEN_ROUTE,
          via: Array.from({ length: 24 }, (_, i) => ({ placeId: `road-${i}`, leg: 0 })),
        },
        // A via point on a leg this route does not have.
        { ...CHOSEN_ROUTE, via: [{ placeId: 'road-x', leg: 1 }] },
        // Via points out of route order, on a three-stop route.
        {
          stops: [...CHOSEN_ROUTE.stops, { description: 'Montreal', placeId: 'place-mtl' }],
          via: [
            { placeId: 'road-b', leg: 1 },
            { placeId: 'road-a', leg: 0 },
          ],
        },
        // A via place ID with a control character.
        { ...CHOSEN_ROUTE, via: [{ placeId: 'road\u0000x', leg: 0 }] },
      ]) {
        await expect(addLine(bad)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      }
      expect(await lineCount()).toBe(before);
    });

    it('refuses an invalid route on update, and leaves the line exactly as it was', async () => {
      const { id } = await addLine(CHOSEN_ROUTE);
      const before = await db.expenseLineItem.findUniqueOrThrow({ where: { id } });
      await expect(
        caller.lineItemUpdate({
          id,
          mileageDistance: '10',
          mileageRoute: { ...CHOSEN_ROUTE, routeCount: 0 },
        }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      const after = await db.expenseLineItem.findUniqueOrThrow({ where: { id } });
      expect(after).toEqual(before);
      await caller.lineItemRemove({ id });
    });

    it('saves a route stored before this change again, unchanged', async () => {
      const id = await seededLine(PRE_CHANGE_ROUTE);

      // The editor re-sends the route it was given with every commit.
      await caller.lineItemUpdate({ id, mileageDistance: '21', mileageRoute: PRE_CHANGE_ROUTE });
      expect(await storedRoute(id)).toEqual(PRE_CHANGE_ROUTE);

      // An edit that never mentions the route keeps it; an explicit null clears it.
      await caller.lineItemUpdate({ id, mileageDistance: '22', mileageUnit: 'KM' });
      expect(await storedRoute(id)).toEqual(PRE_CHANGE_ROUTE);
      await caller.lineItemUpdate({ id, mileageDistance: '22', mileageRoute: null });
      expect(await storedRoute(id)).toBeNull();
      await caller.lineItemRemove({ id });
    });

    it('reprices an old line whose route would fail the schema when the date moves', async () => {
      // The check is on the procedures' input, not inside pricing: a date move carries the
      // stored route over as it is, so an unchecked old row never blocks it.
      const legacy = { stops: [{ description: 'Somewhere' }], legs: [{ distance: '4.20' }] };
      const id = await seededLine(legacy);

      await caller.updateExpense({ expenseId, date: '2026-08-15' });
      const line = await db.expenseLineItem.findUniqueOrThrow({ where: { id } });
      expect(line.amountMinor).toBe(36000n); // 450 km × 80¢
      expect(line.mileageRoute).toEqual(legacy);

      await caller.updateExpense({ expenseId, date: '2026-03-10' });
      await caller.lineItemRemove({ id });
    });
  });

  /**
   * FR-11: the unit a NEW line opens and prices in is the expense OWNER's — miles for a US
   * country or a USD home currency (theirs, else their entity's) — and never the reader's,
   * the report's currency or a saved line's. The server still stores every line in its
   * mileage rule's unit.
   */
  describe("the unit a new line opens in: the expense owner's (FR-11)", () => {
    const unitOf = async (who: any, rid: string, eid: string) =>
      (await who.report({ reportId: rid })).expenses.find((e: any) => e.id === eid)
        ?.mileageDefaultUnit;
    /** The traveller paid in USD for the length of `run`, then as they were (no entity).
     *  VeloExpense (d92): through a USD legal entity — there is no per-person currency. */
    const paidInUsd = async (run: () => Promise<void>) => {
      await h.admin.query('UPDATE app_user SET legal_entity_id = $2 WHERE id = $1', [
        travellerId,
        usdEntityId,
      ]);
      try {
        await run();
      } finally {
        await h.admin.query('UPDATE app_user SET legal_entity_id = NULL WHERE id = $1', [
          travellerId,
        ]);
      }
    };

    it('is kilometres for an owner with no US country and no USD currency', async () => {
      expect(await unitOf(caller, reportId, expenseId)).toBe('KM');
    });

    it('is miles for an owner paid in USD, on a CAD report and a kilometre rule', async () => {
      await paidInUsd(async () => {
        expect(await unitOf(caller, reportId, expenseId)).toBe('MI');
      });
    });

    it('a line opened in miles on a kilometre rule is stored in kilometres, priced on them', async () => {
      await paidInUsd(async () => {
        const { id } = await caller.lineItemCreate({
          expenseId,
          categoryId: mileageCategoryId,
          mileageDistance: '10',
          mileageUnit: 'MI',
        });
        const row = await db.expenseLineItem.findUniqueOrThrow({ where: { id } });
        // 10 mi = 16.09 km, in the RULE's unit; 16.09 km × 50¢ = 804.5 → 805 (half-up).
        expect(row.mileageUnit).toBe('KM');
        expect(row.mileageDistance.toString()).toBe('16.09');
        expect(row.amountMinor).toBe(805n);
        await caller.lineItemRemove({ id });
      });
    });

    it('a saved kilometre line stays in kilometres when the owner now opens in miles', async () => {
      const { id } = await caller.lineItemCreate({
        expenseId,
        categoryId: mileageCategoryId,
        mileageDistance: '12',
        mileageUnit: 'KM',
      });
      await paidInUsd(async () => {
        const screen = await caller.report({ reportId });
        const expense = screen.expenses.find((e: any) => e.id === expenseId);
        expect(expense.mileageDefaultUnit).toBe('MI');
        const line = expense.lineItems.find((li: any) => li.id === id);
        expect(line.mileageUnit).toBe('KM');
        expect(line.mileageDistance).toBe('12');
        // Nothing was re-defaulted on the way: the stored row is unchanged.
        const row = await db.expenseLineItem.findUniqueOrThrow({ where: { id } });
        expect(row.mileageUnit).toBe('KM');
      });
      await caller.lineItemRemove({ id });
    });

    it("follows each expense's owner — a CA delegate reading a US owner's expense sees miles", async () => {
      // VeloExpense (d92): a person's currency is their legal entity's.
      const delegateId = await person('ca-delegate', { country: 'CA', legalEntityId: cadEntityId });
      const usOwner = await person('us-owner', { country: 'US', legalEntityId: cadEntityId });
      const usdOwner = await person('usd-owner', { legalEntityId: usdEntityId });
      const caOwner = await person('ca-owner', { country: 'CA', legalEntityId: cadEntityId });
      const delegate = h.makeCaller(RW, delegateId);
      // A USD report: the report's own currency never decides the unit.
      const rid = (await delegate.create({ title: 'Filed for others', currency: 'USD' })).id;
      try {
        const expenseFor = async (ownerId: string) => {
          const { id } = await delegate.createExpense({ reportId: rid });
          // A fresh blank each time: `createExpense` reuses an empty one, so give it a merchant.
          await db.expense.update({ where: { id }, data: { ownerId, merchant: ownerId } });
          return id as string;
        };
        const forUs = await expenseFor(usOwner);
        const forUsd = await expenseFor(usdOwner);
        const forCa = await expenseFor(caOwner);
        const screen = await delegate.report({ reportId: rid });
        const unit = (eid: string) =>
          screen.expenses.find((e: any) => e.id === eid)?.mileageDefaultUnit;
        expect(unit(forUs)).toBe('MI');
        expect(unit(forUsd)).toBe('MI');
        expect(unit(forCa)).toBe('KM');
      } finally {
        await db.expenseReport.delete({ where: { id: rid } }).catch(() => {});
      }
    });
  });

  describe('nothing Google drew is stored or served', () => {
    it('stores a route with via points as exactly the allowed keys', async () => {
      const route = { ...CHOSEN_ROUTE, via: VIA };
      const { id } = await addLine(route);
      const stored = await storedRoute(id);
      expect(stored).toEqual(route);
      expect(Object.keys(stored).sort()).toEqual(
        ['legs', 'routeCount', 'routeIndex', 'routeLabel', 'stops', 'via'].sort(),
      );
      expectNoGeometry(stored);
      // The writer is served it as stored; `via` never changes the price.
      const line = await writerLine(id);
      expect(line.mileageRoute).toEqual(route);
      expect(line.amountMinor).toBe('22500');
      await caller.lineItemRemove({ id });
    });

    it('saves 25 stops plus via in all, and refuses 26 on the via path', async () => {
      const route = (via: number) => ({
        ...CHOSEN_ROUTE,
        via: Array.from({ length: via }, (_, i) => ({ placeId: `road-${i}`, leg: 0 })),
      });
      const { id } = await addLine(route(23));
      expect((await storedRoute(id)).via).toHaveLength(23);
      const err = await addLine(route(24)).catch((e: unknown) => e);
      expect(err).toMatchObject({ code: 'BAD_REQUEST' });
      expect(JSON.stringify(err)).toContain('via');
      await caller.lineItemRemove({ id });
    });

    it('stores a line saved with no via without a via key, never [] or null', async () => {
      for (const via of [undefined, []]) {
        const { id } = await addLine({ ...CHOSEN_ROUTE, ...(via ? { via } : {}) });
        const stored = await storedRoute(id);
        expect(stored).toEqual(CHOSEN_ROUTE);
        expect(Object.hasOwn(stored, 'via')).toBe(false);
        await caller.lineItemRemove({ id });
      }
    });

    it('saves a route sent with the three old keys, and stores none of them', async () => {
      const { id } = await addLine(withDrawing({ via: VIA }));
      expect(await storedRoute(id)).toEqual({ ...CHOSEN_ROUTE, via: VIA });

      await caller.lineItemUpdate({ id, mileageDistance: '450', mileageRoute: withDrawing() });
      expect(await storedRoute(id)).toEqual(CHOSEN_ROUTE);
      await caller.lineItemRemove({ id });
    });

    it('serves a row that still carries the old keys without them, on every status', async () => {
      const id = await seededLine(withDrawing({ via: VIA }));
      for (const status of ['DRAFT', 'SUBMITTED', 'RETURNED']) {
        await withStatus(status, async () => {
          const line = await writerLine(id);
          expectNoGeometry(line);
          expect(line.mileageRoute).toEqual({ ...CHOSEN_ROUTE, via: VIA });
        });
      }
      await caller.lineItemRemove({ id });
    });

    it('saves such a row again without them: an edit, a carry-over and a reprice', async () => {
      const expected = { ...CHOSEN_ROUTE, via: VIA };

      // The editor re-sends what it was served.
      const resent = await seededLine(withDrawing({ via: VIA }));
      const served = (await writerLine(resent)).mileageRoute;
      await caller.lineItemUpdate({ id: resent, mileageDistance: '451', mileageRoute: served });
      expect(await storedRoute(resent)).toEqual(expected);

      // An edit that never mentions the route carries the stored one over.
      const carried = await seededLine(withDrawing({ via: VIA }));
      await caller.lineItemUpdate({ id: carried, mileageDistance: '451', mileageUnit: 'KM' });
      expect(await storedRoute(carried)).toEqual(expected);

      // A date move reprices every mileage line on the expense.
      const repriced = await seededLine(withDrawing({ via: VIA }));
      await caller.updateExpense({ expenseId, date: '2026-08-15' });
      expect(await storedRoute(repriced)).toEqual(expected);
      await caller.updateExpense({ expenseId, date: '2026-03-10' });

      for (const id of [resent, carried, repriced]) await caller.lineItemRemove({ id });
    });

    it('Change route accepted unchanged leaves the stored JSON equal (spec FR-4)', async () => {
      // The workspace as the browser runs it: reopened from what the writer is served, routed
      // once with a fresh answer that differs from the stored one, one point placed and one
      // not, then Use this route unchanged.
      const ws = await import('@/app/(app)/expenses/_workbench/routeWorkspace');
      const route = {
        ...CHOSEN_ROUTE,
        via: [...VIA, { placeId: 'road-unresolved', leg: 0 }],
      };
      const { id } = await addLine(route);
      const version = async () =>
        (
          // VeloExpense: the column through the superuser pool (snake_case names).
          await h.admin.query(
            'SELECT md5(mileage_route::text) AS version FROM expense_line_item WHERE id = $1',
            [id],
          )
        ).rows[0]?.version as string | undefined;
      const before = await version();

      const served = (await writerLine(id)).mileageRoute;
      const entry = ws.storedRouteEntry(served);
      if (!entry) throw new Error('the served route cannot be reopened');
      let state = ws.seedState({ kind: 'previous', entry }, ['r0', 'r1']);
      state = ws.workspaceReducer(state, {
        type: 'request',
        token: 1,
        key: ws.requestKey(state) as string,
      });
      state = ws.workspaceReducer(state, {
        type: 'answer',
        token: 1,
        routes: [
          {
            index: 0,
            label: 'A fresher name',
            totalMeters: 452_317,
            distance: '452.32',
            durationSeconds: 15_000,
            legs: [{ fromPlaceId: 'place-toronto', toPlaceId: 'place-ottawa', meters: 452_317 }],
            encodedPolyline: POLYLINE,
          },
        ],
      });
      state = ws.workspaceReducer(state, {
        type: 'located',
        ticket: state.locating?.ticket ?? -1,
        results: [
          { placeId: 'place-kingston', location: { lat: 44.2312, lng: -76.486 } },
          { placeId: 'road-unresolved', location: null },
        ],
      });
      const payload = ws.acceptPayload(state, 'KM');
      if (!payload) throw new Error('nothing to accept');
      expectNoGeometry(payload);

      await caller.lineItemUpdate({ id, categoryId: mileageCategoryId, ...payload });
      // Equal JSONB values: PostgreSQL keeps no key order, so this is "byte-identical".
      expect(await version()).toBe(before);
      expect(await storedRoute(id)).toEqual(route);
      await caller.lineItemRemove({ id });
    });

    it('puts no map state on the line: there is no routeGeometry field', async () => {
      const id = await seededLine(withDrawing());
      expect(await writerLine(id)).not.toHaveProperty('routeGeometry');
      await caller.lineItemRemove({ id });
    });

    it('serves no geometry to the manager or to an approver, on any read', async () => {
      const id = await seededLine(withDrawing({ via: VIA }));
      const { expenseApprovalsRouter } = await import('@/server/routers/expenseApprovals');
      const managerExpenses = h.makeCaller(RW, managerId);
      const managerApprovals = h.makeCaller(RW, managerId, expenseApprovalsRouter);
      const apApprovals = h.makeCaller(
        [P.expense.report.reimburse],
        apId,
        expenseApprovalsRouter,
      );

      const managerScreen = await managerExpenses.report({ reportId });
      expectNoGeometry(managerScreen);
      for (const read of [managerApprovals, apApprovals]) {
        const drawer = await read.report({ reportId });
        expectNoGeometry(drawer);
        expect(findLine(drawer, id).mileageRoute).toEqual({
          stops: CHOSEN_ROUTE.stops.map((s) => ({ description: s.description })),
          routeLabel: 'Hwy 401',
          routeCount: 3,
        });
      }
      await caller.lineItemRemove({ id });
    });

    it('keeps addresses, place ids, legs and geometry out of the audit trail', async () => {
      const route = withDrawing({ via: VIA });
      const { id } = await addLine(route);
      await caller.lineItemUpdate({ id, mileageDistance: '451', mileageRoute: route });
      // VeloExpense: `audit_entry` (ExpenseOS: `db.audit`).
      const rows = (
        await h.admin.query(
          'SELECT action, details FROM audit_entry WHERE entity_id = ANY($1::uuid[])',
          [[expenseId, id]],
        )
      ).rows;
      expect(rows.length).toBeGreaterThanOrEqual(2);
      const details = JSON.stringify(rows.map((r: { details: unknown }) => r.details));
      for (const secret of [
        'King St',
        'Wellington',
        'place-toronto',
        'place-ottawa',
        'place-kingston',
        'Hwy 401',
        '450000',
        POLYLINE,
        POINT_DIGITS,
        '79.38318',
        STAMP,
      ]) {
        expect(details).not.toContain(secret);
      }
      await caller.lineItemRemove({ id });
    });
  });
});
