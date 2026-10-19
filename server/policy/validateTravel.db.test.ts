// Ported from ExpenseOS `apps/web/src/server/policy/validateTravel.db.test.ts` (1e682dd6), w6-01 (d88).
// Each adaptation is marked "VeloExpense (w6-01):".
// @vitest-environment node
/* eslint-disable @typescript-eslint/no-explicit-any -- VeloExpense (w6-01): ExpenseOS's suite holds its db and caller untyped (`any`); Biome allows it there. */
import { permissions as P } from '@expenseos/rbac';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTenantHarness, type TenantHarness } from '../__test-helpers__/tenantHarness';

/**
 * The travel policy engine, against a real database.
 *
 * A db test rather than a unit test with a fake, because three of the four things worth
 * proving here are properties of POSTGRES:
 *
 *   · a travel violation lands in `travelLineId`, not `lineItemId`. The
 *     `PolicyViolation_one_subject` CHECK is what makes the wrong column unstorable, and
 *     a mock cannot refuse a write;
 *   · `reportId` going nullable did not break the expense side, which every other db
 *     test here exercises anyway;
 *   · the submit gate actually refuses, through the real router, with the real rule row.
 *
 * Gated on DATABASE_URL, like every other `.db.test.ts` in this tree.
 */

/**
 * The travel router is module-gated, and the gate is mocked true rather than the real
 * `ModuleInstallation` row being flipped — the same call `fraudFlags.db.test.ts` makes,
 * and for the reason recorded there: the db suite runs concurrently, so a shared row
 * saved and restored by two files means whichever finishes first turns the module off
 * under the other. The gate was never what this file is testing.
 */
vi.mock('@expenseos/platform', () => ({ isModuleActive: async () => true }));
// VeloExpense (w6-01): VeloExpense's auth and tenant-host modules, as the other ported suites.
vi.mock('@/auth', () => ({ auth: vi.fn(async () => null) }));
vi.mock('@/lib/tenant/request', () => ({ hostTenantSlug: async () => null }));
vi.mock('@expenseos/jobs', () => ({ enqueue: vi.fn(async () => {}) }));

/*
 * VeloExpense (w6-01): its own tenant through the shared harness (`tenantHarness`), in place
 * of ExpenseOS's seeded single-tenant test client. `db` is the harness's tenant-scoped
 * client; `validateTravelRequest` runs in one tenant transaction, as a request does (the
 * orchestrator expects to be inside one, like `validateReport`); the tenant's travel
 * categories come from `createOrganization` (0077's `seed_travel_defaults`). The harness
 * tenant has no job levels, so the one the cases need is created here, and a currency is
 * its ISO code.
 */

const TRAVEL_PERMS = [
  P.travel.request.createOwn,
  P.travel.request.updateOwn,
  P.travel.request.submitOwn,
] as const;

describe.skipIf(!process.env.DATABASE_URL)('travel policy engine (integration)', () => {
  let h: TenantHarness;
  let db: any;
  let validateTravelRequest: (opts: { db?: unknown; travelRequestId: string; t: (k: string) => string }) => Promise<any>;
  let travel: any;
  let userId: string;
  let jobLevelId: string;
  let currencyId: string;
  let airfareCategoryId: string;
  let requestId: string;
  let lineId: string;
  let ruleId: string | null = null;

  beforeAll(async () => {
    h = await createTenantHarness({ slug: 'travel-policy', name: 'Travel Policy Co' });
    db = h.db;
    const validate = (await import('./validateTravel')).validateTravelRequest;
    // VeloExpense (w6-01): in one tenant transaction; the cases' own `db` argument is the
    // harness client and is not needed here.
    validateTravelRequest = (opts) =>
      db.$transaction((tx: any) => validate({ db: tx, travelRequestId: opts.travelRequestId, t: opts.t }));
    const { travelRequestsRouter } = await import('@/server/routers/travelRequests');

    // VeloExpense (w6-01): the harness tenant has no ladder; one level is enough.
    const level = await db.jobLevel.create({
      data: { code: 'L1', track: 'INDIVIDUAL_CONTRIBUTOR', label: { en: 'Level 1' }, sortOrder: 1 },
      select: { id: true },
    });
    jobLevelId = level.id;
    // A submitter WITH a job level, so the allow-list has something to match. The
    // "no level" case is a unit test — it needs no database to be true.
    userId = h.people[0].id;
    await db.user.update({ where: { id: userId }, data: { jobLevelId } });

    // VeloExpense (w6-01): a currency is its ISO code.
    currencyId = 'CAD';
    airfareCategoryId = (
      await db.travelCategory.findFirstOrThrow({
        where: { lineKind: 'AIRFARE' },
        select: { id: true },
      })
    ).id;

    travel = h.makeCaller(TRAVEL_PERMS, userId, travelRequestsRouter);

    const req = await db.travelRequest.create({
      data: {
        submitterId: userId,
        purpose: 'policy engine integration',
        destinationLabel: 'London',
        destinationCity: 'London',
        tripType: 'ONE_WAY',
        departDate: new Date('2026-11-02T00:00:00Z'),
        currencyId,
      },
      select: { id: true },
    });
    requestId = req.id;
    const line = await db.travelBudgetLine.create({
      data: {
        travelRequestId: requestId,
        categoryId: airfareCategoryId,
        kind: 'AIRFARE',
        payload: { travelClass: 'BUSINESS', fromLabel: 'YUL', toLabel: 'LHR', legs: [] },
        amountMinor: 480_000n,
        basis: 'QUOTE',
      },
      select: { id: true },
    });
    lineId = line.id;
  });

  afterAll(async () => {
    if (db && ruleId) await db.policyRule.delete({ where: { id: ruleId } }).catch(() => {});
    if (db && requestId) {
      await db.travelRequest.delete({ where: { id: requestId } }).catch(() => {});
    }
    await h?.end();
  });

  /** A cabin rule that blocks BUSINESS for everyone (empty allow-list). */
  const armBlockingRule = async () => {
    const rule = await db.policyRule.create({
      data: {
        kindCode: 'TRAVEL_CABIN_CLASS',
        scope: 'TRAVEL_REQUEST',
        severity: 'BLOCK',
        params: { cabin: 'BUSINESS', allowedJobLevelIds: [] },
        messageKey: 'travelCabinClass',
        effectiveFrom: new Date('2020-01-01T00:00:00Z'),
      },
      select: { id: true },
    });
    ruleId = rule.id;
    return rule.id;
  };

  beforeEach(async () => {
    if (ruleId) {
      await db.policyRule.delete({ where: { id: ruleId } }).catch(() => {});
      ruleId = null;
    }
    await db.policyViolation.deleteMany({ where: { travelRequestId: requestId } });
  });

  it('raises nothing when no travel rule is configured', async () => {
    // The default deployment. The gate has to be invisible here, or every existing
    // travel request becomes unsubmittable the moment this ships.
    const res = await validateTravelRequest({
      db,
      travelRequestId: requestId,
      t: (k: string) => k,
    });
    expect(res.violations).toEqual([]);
    expect(res.counts).toMatchObject({ block: 0, warning: 0, unjustifiedWarning: 0 });
  });

  it('writes a travel violation into travelLineId, leaving the expense anchors null', async () => {
    /**
     * The whole reason the CHECK exists. A row carrying both a report and a travel
     * request — or a travel request plus an expense line — is refused by Postgres, so
     * getting the column wrong is a failed write rather than a violation that renders
     * against the wrong subject forever.
     */
    await armBlockingRule();
    const res = await validateTravelRequest({
      db,
      travelRequestId: requestId,
      t: (k: string) => k,
    });
    expect(res.counts.block).toBe(1);

    const rows = await db.policyViolation.findMany({ where: { travelRequestId: requestId } });
    expect(rows).toHaveLength(1);
    expect(rows[0].travelLineId).toBe(lineId);
    expect(rows[0].reportId).toBeNull();
    expect(rows[0].lineItemId).toBeNull();
    expect(rows[0].expenseId).toBeNull();
    expect(rows[0].message).toBe('travelCabinClass');
  });

  it('refuses a row that names both subjects', async () => {
    // Proving the constraint is live, not merely written — a CHECK added with the wrong
    // parenthesisation would accept everything and this file would still pass without it.
    await expect(
      db.policyViolation.create({
        data: {
          travelRequestId: requestId,
          reportId: requestId, // any uuid; the CHECK fires before the FK
          ruleCode: 'x',
          severity: 'INFO',
          message: 'm',
        },
      }),
    ).rejects.toThrow();
  });

  it('is idempotent — a second run replaces rather than accumulates', async () => {
    await armBlockingRule();
    await validateTravelRequest({ db, travelRequestId: requestId, t: (k: string) => k });
    await validateTravelRequest({ db, travelRequestId: requestId, t: (k: string) => k });
    expect(await db.policyViolation.count({ where: { travelRequestId: requestId } })).toBe(1);
  });

  it('deletes the violation with its line, rather than stranding it', async () => {
    /**
     * The cascade, which is why `travelLineId` is a real FK and not an id inside `data`.
     * A violation left pointing at a deleted line would keep blocking a submit with a
     * sentence about a flight that is no longer on the trip.
     */
    await armBlockingRule();
    const line = await db.travelBudgetLine.create({
      data: {
        travelRequestId: requestId,
        categoryId: airfareCategoryId,
        kind: 'AIRFARE',
        payload: { travelClass: 'BUSINESS', fromLabel: 'YUL', toLabel: 'CDG', legs: [] },
        amountMinor: 500_000n,
        basis: 'QUOTE',
      },
      select: { id: true },
    });
    await validateTravelRequest({ db, travelRequestId: requestId, t: (k: string) => k });
    expect(await db.policyViolation.count({ where: { travelLineId: line.id } })).toBe(1);

    await db.travelBudgetLine.delete({ where: { id: line.id } });
    expect(await db.policyViolation.count({ where: { travelLineId: line.id } })).toBe(0);
    // The other line's violation is untouched.
    expect(await db.policyViolation.count({ where: { travelLineId: lineId } })).toBe(1);
  });

  it('carries a justification forward across a re-validate', async () => {
    // A WARNING the traveller has already explained must not have its note wiped by an
    // edit elsewhere on the trip — the note is what unblocks their submit.
    const rule = await db.policyRule.create({
      data: {
        kindCode: 'TRAVEL_CABIN_CLASS',
        scope: 'TRAVEL_REQUEST',
        severity: 'WARNING',
        params: { cabin: 'BUSINESS', allowedJobLevelIds: [] },
        messageKey: 'travelCabinClass',
        effectiveFrom: new Date('2020-01-01T00:00:00Z'),
      },
      select: { id: true },
    });
    ruleId = rule.id;

    const first = await validateTravelRequest({
      db,
      travelRequestId: requestId,
      t: (k: string) => k,
    });
    expect(first.counts.unjustifiedWarning).toBe(1);

    const row = await db.policyViolation.findFirstOrThrow({
      where: { travelRequestId: requestId },
    });
    await travel.justifyViolation({
      violationId: row.id,
      note: 'Redeye, client meeting on landing',
    });

    const second = await validateTravelRequest({
      db,
      travelRequestId: requestId,
      t: (k: string) => k,
    });
    expect(second.counts.warning).toBe(1);
    expect(second.counts.unjustifiedWarning).toBe(0);
    const after = await db.policyViolation.findFirstOrThrow({
      where: { travelRequestId: requestId },
    });
    expect(after.resolveNote).toBe('Redeye, client meeting on landing');
  });

  it('refuses to submit while a BLOCK stands, and refuses to justify it', async () => {
    await armBlockingRule();
    await expect(travel.submit({ id: requestId })).rejects.toThrow(/unresolved policy violations/i);
    // Still a draft — the gate runs before the status flip.
    const after = await db.travelRequest.findUniqueOrThrow({
      where: { id: requestId },
      select: { status: true },
    });
    expect(after.status).toBe('DRAFT');

    // VeloExpense (w6-01): the refused submit rolled its own validation back with it (one
    // tenant transaction per procedure — see the router's submit), so the BLOCK is stored by
    // validating on its own, as the drawer's `validate` call does, before justifying it.
    await validateTravelRequest({ db, travelRequestId: requestId, t: (k: string) => k });
    const row = await db.policyViolation.findFirstOrThrow({
      where: { travelRequestId: requestId },
    });
    await expect(travel.justifyViolation({ violationId: row.id })).rejects.toThrow(
      /must be fixed, not justified/i,
    );
  });

  it('submits once the offending line is gone', async () => {
    /**
     * The other half of the gate, and the one that proves it is a gate rather than a
     * wall: fixing the estimate lets the request through. Economy on the same route.
     */
    await armBlockingRule();
    await db.travelBudgetLine.update({
      where: { id: lineId },
      data: { payload: { travelClass: 'ECONOMY', fromLabel: 'YUL', toLabel: 'LHR', legs: [] } },
    });
    await expect(travel.submit({ id: requestId })).resolves.toMatchObject({
      status: expect.stringMatching(/SUBMITTED|APPROVED/),
    });
    // Put it back for the remaining cases' sake — this file shares one request.
    await db.travelRequest.update({
      where: { id: requestId },
      data: { status: 'DRAFT', submittedAt: null, approvalInstanceId: null },
    });
    await db.travelBudgetLine.update({
      where: { id: lineId },
      data: { payload: { travelClass: 'BUSINESS', fromLabel: 'YUL', toLabel: 'LHR', legs: [] } },
    });
  });
});
