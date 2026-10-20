// @vitest-environment node
import { permissions as P } from '@expenseos/rbac';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { stubFn } from '@/test-utils/stubFn';
import { makeContext } from '../__test-helpers__/trpcCaller';

/**
 * The travel-request router — draft, price, submit, decide, and the budget-vs-actual read.
 *
 * Four rules here are the ones that decide whether an approval means anything:
 *
 *   · **The budget is rebuilt INSIDE the submit transaction.** What the approver decides
 *     on is what the server computed, never what the form sent — otherwise a client can
 *     submit a trip priced at whatever number it likes.
 *   · **Editing is closed once submitted.** `DRAFT` and `RETURNED` are the only editable
 *     states; without that check a traveller could re-price a trip after approval.
 *   · **Moving a place clears its resolved metro.** The airports were resolved FOR the
 *     old city, so keeping them prices the new city's trip with the old city's airports.
 *   · **Read access is the same reach as the list.** Every row `listOversight` returns
 *     must be openable, so `canRead` and the list have to agree — a mismatch produces
 *     rows that 403 when clicked.
 */

const withAuditCalls: Array<Record<string, unknown>> = [];
vi.mock('@expenseos/audit', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@expenseos/audit');
  return {
    ...actual,
    withAudit: vi.fn(
      async (db: unknown, envelope: Record<string, unknown>, fn: (tx: unknown) => unknown) => {
        withAuditCalls.push(envelope);
        return fn(db);
      },
    ),
  };
});
// VeloExpense: the session comes from `@/auth` (auth-kit).
vi.mock('@/auth', () => ({ auth: stubFn(async () => null) }));
vi.mock('@expenseos/rbac/server', () => ({
  resolveRbacUser: vi.fn(),
  invalidateRolePermissions: stubFn(async () => {}),
}));

const isModuleActive = stubFn(async () => true);
vi.mock('@expenseos/platform', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@expenseos/platform');
  return { ...actual, isModuleActive, activeModuleSlugs: stubFn(async () => ['travel']) };
});

const canDecide = stubFn(async () => false);
// The engine's own result shape — `status` is the INSTANCE's outcome after this task,
// which is what `decide` branches its notifications on, and the ids of any tasks the
// advance created.
const decideTask = stubFn(async () => ({
  status: 'RUNNING' as string,
  subjectId: '00000000-0000-7000-8000-000000000001',
  createdTaskIds: [] as string[],
  firedEffects: [] as unknown[],
}));
const startInstance = stubFn(async () => ({
  // `instanceId: null` is a legitimate outcome (no workflow matched), so the stub's
  // type has to admit it or no test can express that case.
  // VeloExpense (f61): `status` too — the NO_APPROVER check runs on a RUNNING start only.
  status: 'RUNNING' as string | undefined,
  instanceId: 'inst-1' as string | null,
  createdTaskIds: ['t1'],
  firedEffects: ['e1'] as unknown[],
}));
vi.mock('@expenseos/approvals/engine', () => ({ canDecide, decideTask, startInstance }));
// VeloExpense (f61): the NO_APPROVER rule is a db query over the engine's tasks; it has its own
// db suite (test/solo-founder.db.test.ts). Here it answers what each case needs.
const onlyRequesterCouldDecide = stubFn(async () => false);
vi.mock('@/lib/approvals/someoneElseCanDecide', () => ({ onlyRequesterCouldDecide }));

// Synchronous, and its return is written straight to travelBudgetLine — an array, not
// an object, or `repricePerDiem` throws on `.length`.
/**
 * The per-diem lookup, stubbed so these tests can assert it is NOT called.
 *
 * Nothing auto-builds a budget any more: it is reached only from `addLine`, once, for
 * the category the traveller picked. `create`, `update` and `submit` used to call it
 * and must not.
 */
const perDiemForCategory = stubFn(() => null as unknown);
vi.mock('@/server/lib/travelBudget', () => ({ perDiemForCategory }));

const findFlightOptions = stubFn(async () => ({
  options: [] as unknown[],
  found: 0,
  insight: null,
  reason: 'ok',
}));
const findStayOptions = stubFn(async () => ({
  options: [] as unknown[],
  found: 0,
  insight: null,
  reason: 'ok',
}));
vi.mock('@/server/lib/travelOptions', () => ({
  searchFlightOptions: findFlightOptions,
  searchStayOptions: findStayOptions,
}));
/**
 * The candidate cache, stubbed. `chooseLineOption` reads its amount from here and nowhere
 * else — the input has no amount field — so driving this stub IS the test of server
 * authority.
 */
const getCandidate = stubFn(async () => null as unknown);
const clearCandidates = stubFn(async () => {});
vi.mock('@/server/lib/travelOptionsCache', () => ({ getCandidate, clearCandidates }));

const buildReportFromTravel = stubFn(async () => ({ reportId: 'r1' }));
vi.mock('@/server/lib/travelToReport', () => ({ buildReportFromTravel }));

// Synchronous — it is pure arithmetic over the two line sets.
const travelVariance = stubFn(() => ({ rows: [], hasActuals: false }));
vi.mock('@/server/lib/travelVariance', () => ({ travelVariance }));

const executeWorkflowEffects = vi.fn();
vi.mock('@/server/lib/workflowEffects', () => ({ executeWorkflowEffects }));

const getMapsConfig = stubFn(async () => ({ apiKey: 'k' }) as unknown);
const searchCities = stubFn(async () => [{ placeId: 'p1', label: 'Toronto' }]);
vi.mock('@/server/platform/googleMaps', () => ({ getMapsConfig, searchCities }));

const getSerpApiConfig = stubFn(async () => ({ apiKey: 'sk' }) as unknown);
vi.mock('@/server/platform/serpapi', () => ({ getSerpApiConfig }));

const taskRecipientIds = stubFn(async () => [] as string[]);
vi.mock('@/server/approvals/notify', () => ({ taskRecipientIds }));

// VeloExpense (w6-01): ExpenseOS's `@expenseos/notifications` is VeloExpense's notification
// service, which records on a QueryRunner and returns the activity's id; the bridge from the
// Prisma transaction and the request's placeholders are stubbed beside it.
const recordActivity = stubFn(async () => 'a1');
const notifyRecipients = stubFn(async () => [] as string[]);
vi.mock('@/lib/notifications/service', () => ({ recordActivity, notifyRecipients }));
vi.mock('@/lib/db/prisma-pg-bridge', () => ({ queryRunnerOf: (db: unknown) => db }));
vi.mock('@/server/lib/subjectPayload', () => ({ subjectPayload: vi.fn(async () => ({})) }));

const U = (n: string) => `00000000-0000-7000-8000-00000000000${n}`;
const ME = U('9');
const REQ = U('1');
const CAT = U('5');
const GL = U('6');
const LINE = U('7');

const request = (over: Record<string, unknown> = {}) => ({
  id: REQ,
  submitterId: ME,
  status: 'DRAFT',
  tripType: 'ONE_WAY',
  departDate: new Date('2026-09-01T00:00:00Z'),
  returnDate: null,
  approvalInstanceId: null,
  destinationLabel: 'Toronto',
  destinationCity: 'Toronto',
  currency: { code: 'CAD' },
  // `id` and the two dimension ids are here for the POLICY loader, which scopes rules by
  // the submitter's department/level/entity/unit/role exactly as the expense side does.
  submitter: {
    id: ME,
    jobLevelId: null,
    departmentId: null,
    legalEntityId: null,
    businessUnitId: null,
    roleId: null,
  },
  destinationCountry: 'CA',
  budgetLines: [] as unknown[],
  ...over,
});

function makeDb(over: Record<string, unknown> = {}) {
  return {
    travelRequest: {
      findMany: stubFn(async () => [] as unknown[]),
      findUnique: stubFn(async () => request() as unknown),
      findUniqueOrThrow: stubFn(async () => request() as unknown),
      create: stubFn(async () => ({ id: REQ })),
      update: stubFn(async () => request()),
    },
    approvalTask: {
      findMany: stubFn(async () => [] as unknown[]),
      updateMany: stubFn(async () => ({ count: 0 })),
    },
    approvalInstance: {
      findUnique: stubFn(async () => null as unknown),
      update: stubFn(async () => ({ id: 'inst-1' })),
    },
    user: {
      findMany: stubFn(async () => [] as unknown[]),
      findUnique: stubFn(async () => ({ managerId: null, entity: null }) as unknown),
    },
    // VeloExpense (w6-01): the shared `currency` table is keyed by its ISO code; the router
    // reads `code` and the id it hands out IS the code.
    currency: { findMany: stubFn(async () => [{ code: 'CAD' }] as unknown[]) },
    // `repricePerDiem` is a real function in the router module, not a mock — it reads
    // these three and rewrites the budget lines.
    perDiemRate: { findMany: stubFn(async () => [] as unknown[]) },
    expenseReport: { findMany: stubFn(async () => [] as unknown[]) },
    expenseCategory: {
      findMany: stubFn(async () => [] as unknown[]),
    },
    // Travel's own taxonomy. A budget line codes to one of these, and the per-diem
    // rates it is derived FROM code to an expense category — so `expenseCategoryId`
    // is the crossing `repricePerDiem` makes, and an allowance whose expense category
    // maps to nothing produces no line.
    travelCategory: {
      findMany: stubFn(async () => [] as unknown[]),
      // Active by default: the refusal tests are the ones that override it, so a test
      // that forgets to cannot silently exercise the refusal path.
      findUnique: stubFn(
        async () =>
          ({
            id: CAT,
            active: true,
            glAccountId: GL,
            lineKind: 'STANDARD',
            expenseCategory: null,
          }) as unknown,
      ),
    },
    fxRate: { findMany: stubFn(async () => [] as unknown[]) },
    travelBudgetLine: {
      findMany: stubFn(async () => [] as unknown[]),
      findUnique: stubFn(async () => null as unknown),
      deleteMany: stubFn(async () => ({ count: 1 })),
      createMany: stubFn(async () => ({ count: 0 })),
      create: stubFn(async () => ({ id: LINE })),
      update: stubFn(async () => ({ id: LINE })),
      updateMany: stubFn(async () => ({ count: 1 })),
      delete: stubFn(async () => ({ id: LINE })),
      aggregate: stubFn(async () => ({ _max: { sortOrder: null as number | null } })),
    },
    /**
     * The policy engine's two tables, empty by default.
     *
     * No configured rule is the DEFAULT deployment, and the submit gate has to be
     * invisible there — which is what the `submit` cases below now also prove. A test
     * that wants a rule to fire overrides `policyRule.findMany`.
     */
    policyRule: { findMany: stubFn(async () => [] as unknown[]) },
    policyViolation: {
      findMany: stubFn(async () => [] as unknown[]),
      findUnique: stubFn(async () => null as unknown),
      deleteMany: stubFn(async () => ({ count: 0 })),
      createMany: stubFn(async () => ({ count: 0 })),
      update: stubFn(async () => ({ id: 'viol-1' })),
    },
    // `validateTravelRequest` swaps the violation set inside its own transaction.
    $transaction: stubFn(async (fn: (tx: unknown) => unknown) => fn(makeDbTx())),
    // VeloExpense (w6-01): every procedure runs inside the request's tenant transaction, so
    // the validator takes its row lock on this client (no nested `$transaction`), and the
    // notification fan-out wraps itself in a savepoint.
    $queryRaw: stubFn(async () => [{ id: 'tr-1' }] as unknown[]),
    $executeRaw: stubFn(async () => 0),
    ...over,
  };
}

/**
 * The transaction client the violation swap sees.
 *
 * Its own object rather than the outer `db`, so a test asserting on
 * `db.policyViolation.deleteMany` is asserting about a call the ROUTER made and not one
 * the validator made on the way past — the two were indistinguishable when both went
 * through one stub.
 */
function makeDbTx() {
  return {
    // The per-request row lock the validator takes before it touches the violations.
    $queryRaw: stubFn(async () => [{ id: 'tr-1' }] as unknown[]),
    policyViolation: {
      findMany: stubFn(async () => [] as unknown[]),
      deleteMany: stubFn(async () => ({ count: 0 })),
      createMany: stubFn(async () => ({ count: 0 })),
    },
  };
}

async function callerFor(db: unknown, permissions: readonly string[] = []) {
  const { createCallerFactory } = await import('@/server/trpc');
  const { travelRequestsRouter } = await import('./travelRequests');
  return createCallerFactory(travelRequestsRouter)(
    makeContext({ db, userId: ME, permissions, roleLabel: 'Employee' }),
  );
}

const TRIP = {
  purpose: 'Client visit in Toronto',
  destination: { label: 'Toronto, ON' },
  origin: { label: 'Montreal, QC' },
  tripType: 'ONE_WAY' as const,
  departDate: '2026-09-01T00:00:00Z',
  includeCar: false,
  currencyId: 'CAD', // VeloExpense (w6-01): a currency's id IS its ISO code.
};

beforeEach(() => {
  vi.clearAllMocks();
  withAuditCalls.length = 0;
  isModuleActive.mockResolvedValue(true);
  getMapsConfig.mockResolvedValue({ apiKey: 'k' });
  getSerpApiConfig.mockResolvedValue({ apiKey: 'sk' });
  searchCities.mockResolvedValue([{ placeId: 'p1', label: 'Toronto' }]);
  startInstance.mockResolvedValue({
    status: 'RUNNING',
    instanceId: 'inst-1',
    createdTaskIds: ['t1'],
    firedEffects: ['e1'],
  });
  onlyRequesterCouldDecide.mockResolvedValue(false);
  canDecide.mockResolvedValue(false);
  // Restored explicitly: `clearAllMocks` clears the call log but keeps the last
  // implementation, so one test's "the activity write failed" rejection would otherwise
  // silence the notification fan-out for every test declared after it.
  // VeloExpense (w6-01): the notification service returns the activity's id itself.
  recordActivity.mockResolvedValue('a1');
});

describe('the module gate', () => {
  it('refuses every procedure when travel is not installed', async () => {
    /**
     * The gate is the whole module boundary: an org that never turned Travel on must
     * not have a reachable travel API, however the client got the URL.
     */
    isModuleActive.mockResolvedValue(false);
    const c = await callerFor(makeDb(), [P.travel.request.createOwn, P.user.readAll]);
    for (const attempt of [
      c.listOwn(),
      c.listOversight(),
      c.get({ id: REQ }),
      c.myTasks(),
      c.formOptions(),
      c.create(TRIP),
    ]) {
      await expect(attempt).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
  });
});

describe('listOwn', () => {
  it('returns only the caller’s own requests', async () => {
    const db = makeDb();
    const c = await callerFor(db);
    await c.listOwn();
    expect(db.travelRequest.findMany.mock.calls[0]?.[0]?.where).toEqual({ submitterId: ME });
  });
});

describe('listOversight', () => {
  it('gives an admin everything, capped', async () => {
    const db = makeDb();
    const c = await callerFor(db, [P.user.readAll]);
    await c.listOversight();
    const args = db.travelRequest.findMany.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(args.where).toBeUndefined();
    expect(args.take).toBe(500);
    expect(db.approvalTask.findMany).not.toHaveBeenCalled();
  });

  it('gives a manager their reports’ trips plus anything they have a task on', async () => {
    /**
     * The reach has to match `canRead`, or the list shows rows that 403 when clicked.
     */
    const db = makeDb();
    db.user.findMany.mockResolvedValue([{ id: U('3') }]);
    db.approvalTask.findMany.mockResolvedValue([{ instance: { subjectId: U('4') } }]);
    const c = await callerFor(db);
    await c.listOversight();
    const where = db.travelRequest.findMany.mock.calls[0]?.[0]?.where as {
      OR: Record<string, unknown>[];
    };
    expect(where.OR).toEqual([{ submitterId: { in: [U('3')] } }, { id: { in: [U('4')] } }]);
  });

  it('de-duplicates a request the caller holds several tasks on', async () => {
    const db = makeDb();
    db.approvalTask.findMany.mockResolvedValue([
      { instance: { subjectId: U('4') } },
      { instance: { subjectId: U('4') } },
    ]);
    const c = await callerFor(db);
    await c.listOversight();
    const where = db.travelRequest.findMany.mock.calls[0]?.[0]?.where as {
      OR: [unknown, { id: { in: string[] } }];
    };
    expect(where.OR[1].id.in).toEqual([U('4')]);
  });

  it('looks only at travel tasks, not every approval task', async () => {
    const db = makeDb();
    const c = await callerFor(db);
    await c.listOversight();
    expect(db.approvalTask.findMany.mock.calls[0]?.[0]?.where).toMatchObject({
      instance: { subjectType: 'TRAVEL_REQUEST' },
    });
  });
});

describe('get', () => {
  it('lets the submitter read their own request', async () => {
    const db = makeDb();
    const c = await callerFor(db);
    await expect(c.get({ id: REQ })).resolves.toBeTruthy();
  });

  it('lets an admin read anybody’s', async () => {
    const db = makeDb();
    db.travelRequest.findUnique.mockResolvedValue(
      request({ submitterId: U('3'), approvalInstanceId: null }),
    );
    const c = await callerFor(db, [P.user.readAll]);
    await expect(c.get({ id: REQ })).resolves.toBeTruthy();
  });

  it('lets the submitter’s manager read it', async () => {
    const db = makeDb();
    db.travelRequest.findUnique.mockResolvedValue(request({ submitterId: U('3') }));
    db.user.findUnique.mockResolvedValue({ managerId: ME });
    const c = await callerFor(db);
    await expect(c.get({ id: REQ })).resolves.toBeTruthy();
  });

  it('lets somebody holding a task on it read it', async () => {
    const db = makeDb();
    db.travelRequest.findUnique.mockResolvedValue(
      request({ submitterId: U('3'), approvalInstanceId: 'inst-1' }),
    );
    db.user.findUnique.mockResolvedValue({ managerId: U('7') });
    db.approvalTask.findMany.mockResolvedValue([
      { id: 't1', status: 'PENDING', assigneeUserId: ME, decidedById: null },
    ]);
    const c = await callerFor(db);
    await expect(c.get({ id: REQ })).resolves.toBeTruthy();
  });

  it('lets somebody who already decided read it', async () => {
    // Otherwise an approver loses access to what they approved.
    const db = makeDb();
    db.travelRequest.findUnique.mockResolvedValue(
      request({ submitterId: U('3'), approvalInstanceId: 'inst-1' }),
    );
    db.user.findUnique.mockResolvedValue({ managerId: U('7') });
    db.approvalTask.findMany.mockResolvedValue([
      { id: 't1', status: 'APPROVED', assigneeUserId: U('8'), decidedById: ME },
    ]);
    const c = await callerFor(db);
    await expect(c.get({ id: REQ })).resolves.toBeTruthy();
  });

  it('lets a delegate who COULD decide read it', async () => {
    // Eligibility is resolved by the engine, not by the assignee column alone.
    const db = makeDb();
    db.travelRequest.findUnique.mockResolvedValue(
      request({ submitterId: U('3'), approvalInstanceId: 'inst-1' }),
    );
    db.user.findUnique.mockResolvedValue({ managerId: U('7') });
    db.approvalTask.findMany.mockResolvedValue([
      { id: 't1', status: 'PENDING', assigneeUserId: U('8'), decidedById: null },
    ]);
    canDecide.mockResolvedValue(true);
    const c = await callerFor(db);
    await expect(c.get({ id: REQ })).resolves.toBeTruthy();
  });

  it('refuses a stranger', async () => {
    const db = makeDb();
    db.travelRequest.findUnique.mockResolvedValue(
      request({ submitterId: U('3'), approvalInstanceId: 'inst-1' }),
    );
    db.user.findUnique.mockResolvedValue({ managerId: U('7') });
    db.approvalTask.findMany.mockResolvedValue([
      { id: 't1', status: 'PENDING', assigneeUserId: U('8'), decidedById: null },
    ]);
    const c = await callerFor(db);
    await expect(c.get({ id: REQ })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('refuses a stranger on an unsubmitted request', async () => {
    // No instance means no task to inherit access from.
    const db = makeDb();
    db.travelRequest.findUnique.mockResolvedValue(
      request({ submitterId: U('3'), approvalInstanceId: null }),
    );
    db.user.findUnique.mockResolvedValue({ managerId: U('7') });
    const c = await callerFor(db);
    await expect(c.get({ id: REQ })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('refuses a request that does not exist', async () => {
    const db = makeDb();
    db.travelRequest.findUnique.mockResolvedValue(null);
    const c = await callerFor(db, [P.user.readAll]);
    await expect(c.get({ id: REQ })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('timeline', () => {
  it('returns an empty trail for a request never submitted', async () => {
    // Not an error: a draft simply has no approval history yet.
    const db = makeDb();
    const c = await callerFor(db);
    await expect(c.timeline({ id: REQ })).resolves.toEqual({ instanceStatus: null, tasks: [] });
  });

  it('returns the instance status and per-step trail', async () => {
    const db = makeDb();
    db.travelRequest.findUnique.mockResolvedValue(request({ approvalInstanceId: 'inst-1' }));
    db.approvalInstance.findUnique.mockResolvedValue({
      status: 'RUNNING',
      tasks: [{ id: 't1', label: 'Manager', status: 'PENDING' }],
    });
    const c = await callerFor(db);
    await expect(c.timeline({ id: REQ })).resolves.toEqual({
      instanceStatus: 'RUNNING',
      tasks: [{ id: 't1', label: 'Manager', status: 'PENDING' }],
    });
  });

  it('tolerates an instance id pointing at nothing', async () => {
    const db = makeDb();
    db.travelRequest.findUnique.mockResolvedValue(request({ approvalInstanceId: 'gone' }));
    db.approvalInstance.findUnique.mockResolvedValue(null);
    const c = await callerFor(db);
    await expect(c.timeline({ id: REQ })).resolves.toEqual({ instanceStatus: null, tasks: [] });
  });

  it('refuses somebody who cannot read the request', async () => {
    const db = makeDb();
    db.travelRequest.findUnique.mockResolvedValue(
      request({ submitterId: U('3'), approvalInstanceId: null }),
    );
    db.user.findUnique.mockResolvedValue({ managerId: U('7') });
    const c = await callerFor(db);
    await expect(c.timeline({ id: REQ })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('myTasks', () => {
  it('returns only pending tasks assigned to the caller on running travel instances', async () => {
    const db = makeDb();
    const c = await callerFor(db);
    await c.myTasks();
    expect(db.approvalTask.findMany.mock.calls[0]?.[0]?.where).toEqual({
      status: 'PENDING',
      assigneeUserId: ME,
      instance: { status: 'RUNNING', subjectType: 'TRAVEL_REQUEST' },
    });
  });

  it('joins each task to its request', async () => {
    const db = makeDb();
    db.approvalTask.findMany.mockResolvedValue([
      { id: 't1', label: 'Manager', createdAt: new Date(), instance: { subjectId: REQ } },
    ]);
    db.travelRequest.findMany.mockResolvedValue([request()]);
    const c = await callerFor(db);
    const out = await c.myTasks();
    expect(out.items).toHaveLength(1);
    expect(out.items[0]).toMatchObject({ taskId: 't1', label: 'Manager' });
  });

  it('drops a task whose request has vanished rather than returning a null row', async () => {
    // A row with no request would render as an empty card in the inbox.
    const db = makeDb();
    db.approvalTask.findMany.mockResolvedValue([
      { id: 't1', label: 'Manager', createdAt: new Date(), instance: { subjectId: U('5') } },
    ]);
    db.travelRequest.findMany.mockResolvedValue([]);
    const c = await callerFor(db);
    expect((await c.myTasks()).items).toEqual([]);
  });
});

describe('searchDestinations', () => {
  it('needs the create permission', async () => {
    const c = await callerFor(makeDb(), []);
    await expect(
      c.searchDestinations({ query: 'toron', sessionToken: U('1') }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('returns cities when Maps is configured', async () => {
    const c = await callerFor(makeDb(), [P.travel.request.createOwn]);
    await expect(
      c.searchDestinations({ query: 'toron', sessionToken: U('1') }),
    ).resolves.toMatchObject({ available: true, items: [{ placeId: 'p1' }], error: null });
  });

  it('answers "unavailable" rather than erroring with no key', async () => {
    // The form falls back to a typed destination, which still prices from per-diem.
    getMapsConfig.mockResolvedValue(null);
    const c = await callerFor(makeDb(), [P.travel.request.createOwn]);
    await expect(c.searchDestinations({ query: 'toron', sessionToken: U('1') })).resolves.toEqual({
      available: false,
      items: [],
      error: null,
    });
    expect(searchCities).not.toHaveBeenCalled();
  });

  it('returns the reason on failure, not a silent empty list', async () => {
    // Already diagnosed once on the mileage form: an empty list made a rejected key
    // look like every city in North America having vanished.
    searchCities.mockRejectedValue(new Error('REQUEST_DENIED'));
    const c = await callerFor(makeDb(), [P.travel.request.createOwn]);
    const out = await c.searchDestinations({ query: 'toron', sessionToken: U('1') });
    expect(out).toMatchObject({ available: true, items: [] });
    expect(out.error).toContain('REQUEST_DENIED');
  });
});

describe('formOptions', () => {
  it('reports which optional integrations are usable', async () => {
    const c = await callerFor(makeDb(), [P.travel.request.createOwn]);
    await expect(c.formOptions()).resolves.toMatchObject({ placeLookup: true, pricing: true });
    getMapsConfig.mockResolvedValue(null);
    getSerpApiConfig.mockResolvedValue(null);
    await expect(c.formOptions()).resolves.toMatchObject({ placeLookup: false, pricing: false });
  });

  // VeloExpense (w6-01): the shared `currency` table has no `active` flag, so every row is
  // offered (as `expenses.currencies` does); the id is the code and the symbol the platform's.
  it('offers every currency, the id being its code', async () => {
    const db = makeDb();
    const c = await callerFor(db, [P.travel.request.createOwn]);
    const { currencies } = await c.formOptions();
    expect(db.currency.findMany.mock.calls[0]?.[0]?.where).toBeUndefined();
    expect(currencies).toEqual([{ id: 'CAD', code: 'CAD', symbol: '$' }]);
  });

  it('defaults to the traveller’s entity currency, matched by code', async () => {
    /**
     * The entity stores a CODE, and the form needs an id — so the default is resolved
     * by matching, not by assuming the lists line up.
     */
    const db = makeDb();
    // VeloExpense (w6-01): a currency's id IS its code.
    db.currency.findMany.mockResolvedValue([{ code: 'CAD' }, { code: 'USD' }]);
    db.user.findUnique.mockResolvedValue({ entity: { homeCurrency: { code: 'USD' } } });
    const c = await callerFor(db, [P.travel.request.createOwn]);
    expect((await c.formOptions()).defaultCurrencyId).toBe('USD');
  });

  it('falls back to the first currency when the entity has none', async () => {
    const db = makeDb();
    db.user.findUnique.mockResolvedValue({ entity: null });
    const c = await callerFor(db, [P.travel.request.createOwn]);
    expect((await c.formOptions()).defaultCurrencyId).toBe('CAD');
  });

  it('returns null when there are no currencies at all', async () => {
    const db = makeDb();
    db.currency.findMany.mockResolvedValue([]);
    const c = await callerFor(db, [P.travel.request.createOwn]);
    expect((await c.formOptions()).defaultCurrencyId).toBeNull();
  });
});

describe('create', () => {
  const c = () => callerFor(makeDb(), [P.travel.request.createOwn]);

  it('prices the draft immediately', async () => {
    /**
     * A new request has NO lines, and this is the assertion that it stays that way.
     *
     * It used to arrive pre-populated with a per-diem line for every category with a
     * rate at the destination, so a traveller's first job was deleting the ones their
     * trip did not involve — and a line they corrected came back on the next edit.
     */
    const db = makeDb();
    const caller = await callerFor(db, [P.travel.request.createOwn]);
    await caller.create(TRIP);
    expect(perDiemForCategory).not.toHaveBeenCalled();
    expect(db.travelBudgetLine.createMany).not.toHaveBeenCalled();
  });

  it('files the planned budget WITH the request, in order', async () => {
    /**
     * The trip and what it is for, in one act. The form used to post the trip alone, so
     * composing a request meant saving it, waiting for the drawer to reopen on the saved
     * record, and only then adding the budget — two screens and a round trip.
     *
     * `sortOrder` is positional, so the rows have to land in the order they were written.
     */
    const db = makeDb();
    const caller = await callerFor(db, [P.travel.request.createOwn]);
    await caller.create({
      ...TRIP,
      lines: [
        { categoryId: CAT, amountMinor: 145000n, notes: 'Direct flight' },
        { categoryId: CAT, notes: null },
      ],
    });
    const written = db.travelBudgetLine.create.mock.calls.map(
      (c) => c[0]?.data as Record<string, unknown>,
    );
    expect(written).toHaveLength(2);
    expect(written[0]).toMatchObject({ sortOrder: 0, notes: 'Direct flight' });
    expect(written[1]).toMatchObject({ sortOrder: 1, notes: null });
  });

  it('AWAITS each line’s insert — an un-awaited Prisma query is a no-op', async () => {
    /**
     * The bug the browser found. `insertBudgetLine` returns a `PrismaPromise`, which is
     * LAZY: the query is sent only when something awaits it. The loop in `create` called
     * it without `await`, so every line filed through the create drawer priced, audited
     * (`linesFiled: 1`) and then never reached the table — and this file was green
     * throughout, because a stub executes the moment it is called.
     *
     * So the stub here behaves like the real thing: a thenable that records itself only
     * when awaited. Without the `await`, `executed` stays empty.
     */
    const db = makeDb();
    const executed: number[] = [];
    db.travelBudgetLine.create.mockImplementation(
      (args: { data: { sortOrder: number } }) =>
        ({
          // biome-ignore lint/suspicious/noThenProperty: a PrismaPromise stand-in has to be a thenable — its laziness is the property under test.
          then(resolve: (value: unknown) => void) {
            executed.push(args.data.sortOrder);
            resolve({ id: LINE });
          },
        }) as never,
    );
    const caller = await callerFor(db, [P.travel.request.createOwn]);
    await caller.create({ ...TRIP, lines: [{ categoryId: CAT }, { categoryId: CAT }] });
    expect(executed).toEqual([0, 1]);
  });

  it('holds a filed line to the SAME rules as one added later', async () => {
    /**
     * The reason `create` calls the shared pricing path rather than writing rows itself: a
     * retired category produces a line whose actuals can never be filed under it, so
     * budget-vs-actual shows a permanent overrun on one side and a permanent underrun on
     * the other. Filing it at create time must not be the way round that.
     */
    const db = makeDb();
    db.travelCategory.findUnique.mockResolvedValue({
      id: CAT,
      active: false,
      glAccountId: GL,
      lineKind: 'STANDARD',
      expenseCategory: null,
    });
    const caller = await callerFor(db, [P.travel.request.createOwn]);
    await expect(caller.create({ ...TRIP, lines: [{ categoryId: CAT }] })).rejects.toThrow(
      /not available/,
    );
  });

  it('writes no lines when none were planned', async () => {
    const db = makeDb();
    const caller = await callerFor(db, [P.travel.request.createOwn]);
    await caller.create(TRIP);
    expect(db.travelBudgetLine.create).not.toHaveBeenCalled();
  });

  it('files the request against the caller', async () => {
    const db = makeDb();
    const caller = await callerFor(db, [P.travel.request.createOwn]);
    await caller.create(TRIP);
    expect(db.travelRequest.create.mock.calls[0]?.[0]?.data).toMatchObject({
      submitterId: ME,
      destinationLabel: 'Toronto, ON',
      originLabel: 'Montreal, QC',
    });
  });

  it('requires a return date for a round trip', async () => {
    await expect((await c()).create({ ...TRIP, tripType: 'ROUND_TRIP' })).rejects.toThrow(
      /round trip needs a return date/,
    );
  });

  it('refuses a return before the departure', async () => {
    await expect(
      (await c()).create({ ...TRIP, tripType: 'ROUND_TRIP', returnDate: '2026-08-01T00:00:00Z' }),
    ).rejects.toThrow(/before the departure date/);
  });

  it('accepts a round trip returning the same day', async () => {
    await expect(
      (await c()).create({ ...TRIP, tripType: 'ROUND_TRIP', returnDate: '2026-09-01T00:00:00Z' }),
    ).resolves.toBeTruthy();
  });

  it('rejects an unparseable departure date', async () => {
    await expect((await c()).create({ ...TRIP, departDate: 'not-a-date' })).rejects.toThrow();
  });

  it('requires a purpose of some substance', async () => {
    // Three characters minimum — "x" tells an approver nothing.
    await expect((await c()).create({ ...TRIP, purpose: 'ab' })).rejects.toThrow();
  });

  it('rejects a lower-case airport code', async () => {
    // IATA codes are three uppercase letters; accepting 'yyz' would miss the route.
    await expect(
      (await c()).create({ ...TRIP, destination: { label: 'Toronto', airport: 'yyz' } }),
    ).rejects.toThrow();
  });

  it('accepts a valid airport pin', async () => {
    await expect(
      (await c()).create({ ...TRIP, destination: { label: 'Toronto', airport: 'YYZ' } }),
    ).resolves.toBeTruthy();
  });

  it('defaults the trip type and car flag on CREATE', async () => {
    // The defaults belong to create only — that is why there are two schemas.
    const db = makeDb();
    const caller = await callerFor(db, [P.travel.request.createOwn]);
    await caller.create({
      purpose: 'Client visit in Toronto',
      destination: { label: 'Toronto, ON' },
      origin: { label: 'Montreal, QC' },
      departDate: '2026-09-01T00:00:00Z',
      returnDate: '2026-09-05T00:00:00Z',
      currencyId: 'CAD',
    } as never);
    expect(db.travelRequest.create.mock.calls[0]?.[0]?.data).toMatchObject({
      tripType: 'ROUND_TRIP',
      includeCar: false,
    });
  });

  it('audits the destination', async () => {
    const caller = await c();
    await caller.create(TRIP);
    expect(withAuditCalls[0]).toMatchObject({
      entityType: 'TravelRequest',
      details: { destination: 'Toronto, ON' },
    });
  });
});

describe('update', () => {
  const caller = (db: unknown) => callerFor(db, [P.travel.request.updateOwn]);

  it('404s a request that does not exist', async () => {
    const db = makeDb();
    db.travelRequest.findUnique.mockResolvedValue(null);
    await expect(
      (await caller(db)).update({ id: REQ, purpose: 'New purpose' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('refuses somebody else’s request', async () => {
    const db = makeDb();
    db.travelRequest.findUnique.mockResolvedValue(request({ submitterId: U('3') }));
    await expect(
      (await caller(db)).update({ id: REQ, purpose: 'New purpose' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('refuses to edit a submitted request', async () => {
    /**
     * Without this a traveller could re-price a trip after approval, and the approver's
     * decision would no longer describe what was approved.
     */
    for (const status of ['SUBMITTED', 'APPROVED', 'REJECTED', 'CANCELLED']) {
      const db = makeDb();
      db.travelRequest.findUnique.mockResolvedValue(request({ status }));
      await expect(
        (await caller(db)).update({ id: REQ, purpose: 'New purpose' }),
        status,
      ).rejects.toThrow(/can no longer be edited/);
    }
  });

  it('allows editing a returned request', async () => {
    // RETURNED is editable on purpose — that is the point of returning it.
    const db = makeDb();
    db.travelRequest.findUnique.mockResolvedValue(request({ status: 'RETURNED' }));
    await expect(
      (await caller(db)).update({ id: REQ, purpose: 'Corrected purpose' }),
    ).resolves.toBeTruthy();
  });

  it('patches only what arrived', async () => {
    const db = makeDb();
    const c = await caller(db);
    await c.update({ id: REQ, purpose: 'New purpose' });
    const data = db.travelRequest.update.mock.calls[0]?.[0]?.data as Record<string, unknown>;
    expect(data.purpose).toBe('New purpose');
    expect(data).not.toHaveProperty('includeCar');
    expect(data).not.toHaveProperty('currencyId');
  });

  it('clears the resolved metro when the destination moves', async () => {
    /**
     * The airports were resolved FOR the old city. Keeping them would price the new
     * city's trip using the old city's airports — a wrong number that looks right.
     */
    const db = makeDb();
    const c = await caller(db);
    await c.update({ id: REQ, destination: { label: 'Vancouver, BC' } });
    const data = db.travelRequest.update.mock.calls[0]?.[0]?.data as Record<string, unknown>;
    expect(data.destinationSerpId).toBeNull();
    expect(data.destinationAirports).toEqual([]);
  });

  it('clears the resolved metro when the origin moves', async () => {
    const db = makeDb();
    const c = await caller(db);
    await c.update({ id: REQ, origin: { label: 'Calgary, AB' } });
    const data = db.travelRequest.update.mock.calls[0]?.[0]?.data as Record<string, unknown>;
    expect(data.originSerpId).toBeNull();
    expect(data.originAirports).toEqual([]);
  });

  it('leaves the metro alone when the place did not move', async () => {
    const db = makeDb();
    const c = await caller(db);
    await c.update({ id: REQ, purpose: 'New purpose' });
    const data = db.travelRequest.update.mock.calls[0]?.[0]?.data as Record<string, unknown>;
    expect(data).not.toHaveProperty('destinationSerpId');
    expect(data).not.toHaveProperty('originSerpId');
  });

  it('keeps the stored dates when none arrived', async () => {
    const db = makeDb();
    const c = await caller(db);
    await c.update({ id: REQ, purpose: 'New purpose' });
    const data = db.travelRequest.update.mock.calls[0]?.[0]?.data as Record<string, Date>;
    expect(data.departDate).toEqual(new Date('2026-09-01T00:00:00Z'));
  });

  it('distinguishes clearing the return date from omitting it', async () => {
    // `null` means "make this a one-way"; absent means "leave it".
    const db = makeDb();
    db.travelRequest.findUnique.mockResolvedValue(
      request({ tripType: 'ROUND_TRIP', returnDate: new Date('2026-09-05T00:00:00Z') }),
    );
    const c = await caller(db);
    await c.update({ id: REQ, returnDate: null, tripType: 'ONE_WAY' });
    expect(
      (db.travelRequest.update.mock.calls[0]?.[0]?.data as Record<string, unknown>).returnDate,
    ).toBeNull();
  });

  it('re-validates the dates against the merged trip type', async () => {
    // Switching to a round trip without supplying a return date must fail.
    const db = makeDb();
    const c = await caller(db);
    await expect(c.update({ id: REQ, tripType: 'ROUND_TRIP' })).rejects.toThrow(
      /needs a return date/,
    );
  });

  it('does not invent a trip type the client never sent', async () => {
    /**
     * `z.object({...}).partial()` does NOT strip a `.default()` — it only makes the key
     * optional, and the default still fills in when the key is absent. Deriving the
     * patch schema from the defaulted create schema therefore made every edit arrive
     * with `tripType: 'ROUND_TRIP'`, so editing a ONE_WAY trip's purpose failed with
     * "A round trip needs a return date." The patch schema now carries no defaults.
     */
    const db = makeDb();
    db.travelRequest.findUnique.mockResolvedValue(
      request({ tripType: 'ONE_WAY', returnDate: null }),
    );
    const c = await caller(db);
    await expect(c.update({ id: REQ, purpose: 'Just fixing a typo' })).resolves.toBeTruthy();
    const data = db.travelRequest.update.mock.calls[0]?.[0]?.data as Record<string, unknown>;
    expect(data).not.toHaveProperty('tripType');
  });

  it('does not silently drop the rental car on an unrelated edit', async () => {
    /**
     * The subtler half of the same bug: `includeCar` defaulted to `false`, so the
     * handler's `input.includeCar !== undefined` guard was ALWAYS true and every edit
     * wrote `includeCar: false`. A traveller fixing a typo lost the car from the budget
     * and nothing said so.
     */
    const db = makeDb();
    db.travelRequest.findUnique.mockResolvedValue(request({ tripType: 'ONE_WAY' }));
    const c = await caller(db);
    await c.update({ id: REQ, purpose: 'Just fixing a typo' });
    const data = db.travelRequest.update.mock.calls[0]?.[0]?.data as Record<string, unknown>;
    expect(data).not.toHaveProperty('includeCar');
  });

  it('still applies an explicitly sent trip type and car flag', async () => {
    const db = makeDb();
    const c = await caller(db);
    await c.update({ id: REQ, tripType: 'ONE_WAY', includeCar: true });
    const data = db.travelRequest.update.mock.calls[0]?.[0]?.data as Record<string, unknown>;
    expect(data.tripType).toBe('ONE_WAY');
    expect(data.includeCar).toBe(true);
  });

  it('does NOT re-price the lines after an edit', async () => {
    /**
     * Moving the dates does change what an allowance would be, and the traveller can
     * see that — each line shows the amount it was created with. Re-pricing here is
     * what silently restored a figure somebody had deliberately corrected.
     */
    const db = makeDb();
    const c = await caller(db);
    await c.update({ id: REQ, purpose: 'New purpose' });
    expect(perDiemForCategory).not.toHaveBeenCalled();
    expect(db.travelBudgetLine.deleteMany).not.toHaveBeenCalled();
  });
});

/**
 * `quote` and `reprice` are both GONE.
 *
 * `reprice` rebuilt the whole per-diem budget, so it silently restored any figure the
 * traveller had corrected and could not tell a stale line from a deliberate one. `quote`
 * searched flights and lodging and auto-took the CHEAPEST of each — the one thing a per-line
 * picker exists to stop, and a traveller who pressed both got two airfare lines.
 *
 * Each line is priced when it is added, and each provider-backed line has its own picker.
 * `searchFlightOptions` / `searchStayOptions` / `chooseLineOption` are tested below.
 */

describe('submit', () => {
  const caller = (db: unknown) => callerFor(db, [P.travel.request.submitOwn]);

  it('rebuilds the budget inside the transaction before starting approvals', async () => {
    /**
     * Submit does NOT rebuild the budget, and the guarantee has moved rather than gone.
     *
     * It was "the budget is recomputed inside the submit transaction, so what the
     * approver decides on is what the server computed". It is now "every line's amount
     * was computed or validated by the server when the line was written, and a
     * client-supplied figure is stored as MANUAL" — which is the property that
     * mattered, and `addLine` is where it is asserted.
     *
     * Given up deliberately: a per-diem rate revised between composing the estimate and
     * submitting it is not picked up. An estimate states what the traveller asked for.
     */
    const db = makeDb();
    await (await caller(db)).submit({ id: REQ });
    expect(perDiemForCategory).not.toHaveBeenCalled();
    expect(startInstance).toHaveBeenCalled();
  });

  it('moves the request to SUBMITTED and stamps the time', async () => {
    const db = makeDb();
    await (await caller(db)).submit({ id: REQ });
    const data = db.travelRequest.update.mock.calls[0]?.[0]?.data as Record<string, unknown>;
    expect(data.status).toBe('SUBMITTED');
    expect(data.submittedAt).toBeInstanceOf(Date);
  });

  it('records the approval instance on the request', async () => {
    const db = makeDb();
    await (await caller(db)).submit({ id: REQ });
    expect(db.travelRequest.update.mock.calls[1]?.[0]?.data).toEqual({
      approvalInstanceId: 'inst-1',
    });
  });

  // VeloExpense (w6-01, d58): ExpenseOS submits a request no workflow governs and leaves it
  // with nobody to decide it; VeloExpense refuses the submit, which rolls back with it. Every
  // tenant is seeded a default travel flow (0077), so this is a flow an admin switched off.
  it('refuses when no workflow matched', async () => {
    startInstance.mockResolvedValue({ status: 'NO_WORKFLOW', instanceId: null, createdTaskIds: [], firedEffects: [] });
    const db = makeDb();
    await expect((await caller(db)).submit({ id: REQ })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringMatching(/No approval workflow covers this travel request/),
    });
    expect(executeWorkflowEffects).not.toHaveBeenCalled();
  });

  // VeloExpense (f61): a flow whose first approvals only the traveller could decide is refused,
  // as a report's is (NO_APPROVER, the 4 Oct 2026 rule). ExpenseOS submits it, and it waits on
  // nobody, because `canDecide` stops the traveller deciding their own trip.
  it('refuses a flow only the traveller could decide, and starts nothing after it', async () => {
    startInstance.mockResolvedValue({
      status: 'RUNNING',
      instanceId: 'inst-1',
      createdTaskIds: ['t1'],
      firedEffects: ['e1'],
    });
    onlyRequesterCouldDecide.mockResolvedValueOnce(true);
    const db = makeDb();
    await expect((await caller(db)).submit({ id: REQ })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringMatching(/Nobody else here can approve this travel request/),
    });
    expect(onlyRequesterCouldDecide).toHaveBeenCalledWith(expect.anything(), ME, ['t1']);
    expect(executeWorkflowEffects).not.toHaveBeenCalled();
    expect(recordActivity).not.toHaveBeenCalled();
  });

  it('submits when somebody else can decide (a manager, or another administrator)', async () => {
    startInstance.mockResolvedValue({
      status: 'RUNNING',
      instanceId: 'inst-1',
      createdTaskIds: ['t1'],
      firedEffects: [],
    });
    onlyRequesterCouldDecide.mockResolvedValueOnce(false);
    const db = makeDb();
    await (await caller(db)).submit({ id: REQ });
    expect(onlyRequesterCouldDecide).toHaveBeenCalledWith(expect.anything(), ME, ['t1']);
    const data = db.travelRequest.update.mock.calls[0]?.[0]?.data as Record<string, unknown>;
    expect(data.status).toBe('SUBMITTED');
  });

  it('does not ask who can decide when the flow decided on submit', async () => {
    startInstance.mockResolvedValue({
      status: 'APPROVED',
      instanceId: 'inst-1',
      createdTaskIds: [],
      firedEffects: [],
    });
    const db = makeDb();
    await (await caller(db)).submit({ id: REQ });
    expect(onlyRequesterCouldDecide).not.toHaveBeenCalled();
  });

  it('refuses somebody else’s request and an already-submitted one', async () => {
    const other = makeDb();
    other.travelRequest.findUnique.mockResolvedValue(request({ submitterId: U('3') }));
    await expect((await caller(other)).submit({ id: REQ })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });

    const done = makeDb();
    done.travelRequest.findUnique.mockResolvedValue(request({ status: 'SUBMITTED' }));
    await expect((await caller(done)).submit({ id: REQ })).rejects.toThrow(/already submitted/);
  });

  it('re-checks the dates at submit time', async () => {
    // The stored request can have become invalid — a round trip whose return was cleared.
    const db = makeDb();
    db.travelRequest.findUnique.mockResolvedValue(
      request({ tripType: 'ROUND_TRIP', returnDate: null }),
    );
    await expect((await caller(db)).submit({ id: REQ })).rejects.toThrow(/needs a return date/);
    expect(startInstance).not.toHaveBeenCalled();
  });

  it('notifies the approvers but never the submitter', async () => {
    // Being told your own request was submitted is noise.
    taskRecipientIds.mockResolvedValue([ME, U('3')]);
    const db = makeDb();
    await (await caller(db)).submit({ id: REQ });
    await new Promise((r) => setImmediate(r));
    expect(notifyRecipients).toHaveBeenCalledWith(expect.anything(), 'a1', [U('3')]);
  });

  it('runs the workflow effects the engine fired', async () => {
    const db = makeDb();
    await (await caller(db)).submit({ id: REQ });
    expect(executeWorkflowEffects).toHaveBeenCalledWith(expect.anything(), {
      subjectType: 'TRAVEL_REQUEST',
      subjectId: REQ,
      effectNodeIds: ['e1'],
      actorId: ME,
    });
  });

  it('still returns the request when the activity fan-out fails', async () => {
    /**
     * The notification is best-effort. A failure there must not undo a submitted
     * request — the approval has already started.
     */
    recordActivity.mockRejectedValue(new Error('redis down'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const db = makeDb();
    await expect((await caller(db)).submit({ id: REQ })).resolves.toBeTruthy();
    await new Promise((r) => setImmediate(r));
    expect(warn).toHaveBeenCalled();
  });
});

describe('cancel', () => {
  const caller = (db: unknown) => callerFor(db, [P.travel.request.updateOwn]);

  it('withdraws a draft', async () => {
    const db = makeDb();
    await (await caller(db)).cancel({ id: REQ });
    expect(db.travelRequest.update.mock.calls[0]?.[0]?.data).toEqual({ status: 'CANCELLED' });
  });

  it('refuses an approved or already-cancelled request', async () => {
    for (const status of ['APPROVED', 'CANCELLED']) {
      const db = makeDb();
      db.travelRequest.findUnique.mockResolvedValue(request({ status }));
      await expect((await caller(db)).cancel({ id: REQ }), status).rejects.toThrow(
        /cannot be withdrawn/,
      );
    }
  });

  it('refuses somebody else’s request', async () => {
    const db = makeDb();
    db.travelRequest.findUnique.mockResolvedValue(request({ submitterId: U('3') }));
    await expect((await caller(db)).cancel({ id: REQ })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('skips the pending tasks and closes the instance', async () => {
    /**
     * Leaving the tasks PENDING would keep the trip in every approver's inbox after
     * the traveller withdrew it.
     */
    const db = makeDb();
    db.travelRequest.findUnique.mockResolvedValue(
      request({ status: 'SUBMITTED', approvalInstanceId: 'inst-1' }),
    );
    await (await caller(db)).cancel({ id: REQ });
    expect(db.approvalTask.updateMany).toHaveBeenCalledWith({
      where: { instanceId: 'inst-1', status: 'PENDING' },
      data: { status: 'SKIPPED' },
    });
    const data = db.approvalInstance.update.mock.calls[0]?.[0]?.data as Record<string, unknown>;
    expect(data.status).toBe('CANCELLED');
    expect(data.completedAt).toBeInstanceOf(Date);
  });

  it('touches no approval state for a request never submitted', async () => {
    const db = makeDb();
    await (await caller(db)).cancel({ id: REQ });
    expect(db.approvalTask.updateMany).not.toHaveBeenCalled();
    expect(db.approvalInstance.update).not.toHaveBeenCalled();
  });
});

describe('variance', () => {
  it('is readable by anyone who can read the request', async () => {
    const db = makeDb();
    const c = await callerFor(db);
    await expect(c.variance({ id: REQ })).resolves.toBeTruthy();
  });

  it('refuses somebody who cannot', async () => {
    const db = makeDb();
    db.travelRequest.findUnique.mockResolvedValue(
      request({ submitterId: U('3'), approvalInstanceId: null }),
    );
    db.user.findUnique.mockResolvedValue({ managerId: U('7') });
    const c = await callerFor(db);
    await expect(c.variance({ id: REQ })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('compares on the EXPENSE category, crossing the travel mapping to get there', async () => {
    /**
     * An expense line item is coded to an expense category; a budget line to a travel
     * one. The expense side is the only key both have, so the budget side crosses
     * `TravelCategory.expenseCategoryId` — comparing travel ids against expense ids
     * would match nothing and report every trip as 100% unspent.
     */
    travelVariance.mockReturnValue({ rows: [], hasActuals: false });
    const db = makeDb();
    db.travelBudgetLine.findMany.mockResolvedValue([
      {
        amountMinor: 10_000n,
        category: { id: U('7'), label: { en: 'Airfare' }, icon: '✈️', expenseCategoryId: CAT },
      },
    ]);
    const c = await callerFor(db);
    await c.variance({ id: REQ });
    expect(travelVariance.mock.calls[0]?.[0]?.budgetLines).toEqual([
      { categoryId: CAT, amountMinor: 10_000n },
    ]);
  });

  it('reports a budget line that maps to nothing instead of dropping it', async () => {
    /**
     * Money nobody can reconcile is exactly what somebody needs to be told about.
     * Omitting it would make a trip read as on budget while a line of it had no
     * actuals it could ever be compared against.
     */
    travelVariance.mockReturnValue({ rows: [], hasActuals: false });
    const db = makeDb();
    db.travelBudgetLine.findMany.mockResolvedValue([
      {
        amountMinor: 15_000n,
        category: { id: U('8'), label: { en: 'Visa fees' }, icon: '🛂', expenseCategoryId: null },
      },
    ]);
    const c = await callerFor(db);
    const out = (await c.variance({ id: REQ })) as Record<string, unknown>;
    expect(out.unmappable).toEqual([
      { categoryId: U('8'), label: { en: 'Visa fees' }, icon: '🛂', amountMinor: 15_000n },
    ]);
    // And it is NOT handed to the comparison, which has no key for it.
    expect(travelVariance.mock.calls[0]?.[0]?.budgetLines).toEqual([]);
  });

  it('distinguishes "on budget" from "nothing filed yet"', async () => {
    /**
     * The two look identical if you only compare totals, and they mean opposite things
     * to somebody chasing a trip's paperwork.
     */
    travelVariance.mockReturnValue({ rows: [], hasActuals: false });
    const db = makeDb();
    const c = await callerFor(db);
    expect((await c.variance({ id: REQ })) as Record<string, unknown>).toMatchObject({
      hasActuals: false,
    });
  });
});

describe('buildReport', () => {
  it('needs the report-create permission', async () => {
    const c = await callerFor(makeDb(), []);
    await expect(c.buildReport({ id: REQ })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('builds a report from an approved trip', async () => {
    const db = makeDb();
    db.travelRequest.findUnique.mockResolvedValue(request({ status: 'APPROVED' }));
    const c = await callerFor(db, [P.expense.report.createOwn]);
    await expect(c.buildReport({ id: REQ })).resolves.toBeTruthy();
    expect(buildReportFromTravel).toHaveBeenCalled();
  });
});

// ── Per-diem repricing, in the request's own currency ─────────────────────────

// ── Deciding a travel task ────────────────────────────────────────────────────

describe('decide', () => {
  const task = (over: Record<string, unknown> = {}) => ({
    status: 'PENDING',
    instance: { subjectId: REQ, subjectType: 'TRAVEL_REQUEST' },
    ...over,
  });

  /** The base stub has no `approvalTask.findUnique` — the other procedures never read
   *  one. Spread rather than passed as an override so the property is typed here. */
  function decideDb() {
    return {
      ...makeDb(),
      approvalTask: {
        findUnique: stubFn(async () => task() as unknown),
        findMany: stubFn(async () => [] as unknown[]),
        updateMany: stubFn(async () => ({ count: 0 })),
      },
    };
  }

  const TASK = U('6');

  it('404s a task that does not exist', async () => {
    const db = decideDb();
    db.approvalTask.findUnique.mockResolvedValue(null);
    const c = await callerFor(db, []);
    await expect(c.decide({ taskId: TASK, approve: true })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('refuses a task that belongs to another kind of subject', async () => {
    /**
     * Task ids are global. Without this check, approving an EXPENSE_REPORT task through
     * the travel endpoint would audit it as a travel approval and hand the expense engine
     * a decision made under travel's eligibility rules.
     */
    const db = decideDb();
    db.approvalTask.findUnique.mockResolvedValue(
      task({ instance: { subjectId: REQ, subjectType: 'EXPENSE_REPORT' } }),
    );
    const c = await callerFor(db, []);
    await expect(c.decide({ taskId: TASK, approve: true })).rejects.toThrow(
      /Not a travel approval task/,
    );
  });

  it('refuses a task somebody already decided', async () => {
    /** Two approvers pressing at once is ordinary; the second must be told, not silently
     *  allowed to overwrite the first decision. */
    const db = decideDb();
    db.approvalTask.findUnique.mockResolvedValue(task({ status: 'APPROVED' }));
    const c = await callerFor(db, []);
    await expect(c.decide({ taskId: TASK, approve: true })).rejects.toThrow(/already decided/);
  });

  it('refuses somebody the engine says is not eligible', async () => {
    /** `canDecide` is also what blocks self-approval, via the engine's owner lookup — so
     *  the router never re-implements that rule. */
    canDecide.mockResolvedValue(false);
    const c = await callerFor(decideDb(), []);
    await expect(c.decide({ taskId: TASK, approve: true })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('reaches the engine’s override only for a travel decide.any holder, and audits it', async () => {
    canDecide.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    decideTask.mockResolvedValue({
      status: 'RUNNING',
      subjectId: REQ,
      createdTaskIds: [],
      firedEffects: [],
    });
    const c = await callerFor(decideDb(), [P.travel.request.decideAny]);
    await c.decide({ taskId: TASK, approve: true });
    expect(canDecide).toHaveBeenNthCalledWith(1, expect.anything(), TASK, ME, false);
    expect(canDecide).toHaveBeenNthCalledWith(2, expect.anything(), TASK, ME, true);
    expect(withAuditCalls[0]?.details).toMatchObject({ taskId: TASK, override: true });
  });

  it('refuses a directory-read holder the engine turned down — read.all is not an override', async () => {
    /**
     * `user.read.all` used to be the override on this path. AP Clerk and Card
     * Administrator hold it to pick a person, and neither is meant to approve anybody's
     * trip — the Card Administrator's role comment excludes "anything expense-report-side"
     * outright. The engine's refusal stands.
     */
    canDecide.mockResolvedValue(false);
    const c = await callerFor(decideDb(), [P.user.readAll]);
    await expect(c.decide({ taskId: TASK, approve: true })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(canDecide).not.toHaveBeenCalledWith(expect.anything(), TASK, ME, true);
    expect(decideTask).not.toHaveBeenCalled();
  });

  it('audits an approval and a rejection under different actions', async () => {
    canDecide.mockResolvedValue(true);
    decideTask.mockResolvedValue({
      status: 'RUNNING',
      subjectId: REQ,
      createdTaskIds: [],
      firedEffects: [],
    });
    const c = await callerFor(decideDb(), []);
    await c.decide({ taskId: TASK, approve: true, note: 'ok' });
    const approveAction = withAuditCalls[0]?.action;
    withAuditCalls.length = 0;
    await c.decide({ taskId: TASK, approve: false });
    expect(withAuditCalls[0]?.action).not.toBe(approveAction);
    // The subject is the REQUEST, not the task: that is what a reader looks up.
    expect(withAuditCalls[0]).toMatchObject({
      entityType: 'TravelRequest',
      entityId: REQ,
      details: { taskId: TASK, note: null, override: false },
    });
  });

  it('tells the traveller their trip was decided', async () => {
    canDecide.mockResolvedValue(true);
    decideTask.mockResolvedValue({
      status: 'APPROVED',
      subjectId: REQ,
      createdTaskIds: [],
      firedEffects: [],
    });
    const db = decideDb();
    db.travelRequest.findUnique.mockResolvedValue({ submitterId: U('7') });
    const c = await callerFor(db, []);
    await c.decide({ taskId: TASK, approve: true });
    // The fan-out is deliberately not awaited by the mutation — the decision is what the
    // caller waits for. One turn of the loop is what a test has to wait for instead.
    await new Promise((r) => setImmediate(r));
    expect(notifyRecipients.mock.calls[0]?.[2]).toEqual([U('7')]);
  });

  it('does not notify an approver who is also the traveller', async () => {
    /** An admin approving their own trip is a real path (the engine allows it for an
     *  admin); telling them about it is noise. */
    canDecide.mockResolvedValue(true);
    decideTask.mockResolvedValue({
      status: 'REJECTED',
      subjectId: REQ,
      createdTaskIds: [],
      firedEffects: [],
    });
    const db = decideDb();
    db.travelRequest.findUnique.mockResolvedValue({ submitterId: ME });
    const c = await callerFor(db, []);
    await c.decide({ taskId: TASK, approve: false });
    await new Promise((r) => setImmediate(r));
    expect(notifyRecipients).not.toHaveBeenCalled();
  });

  it('stays quiet while the chain is still running', async () => {
    /** A mid-chain approval is not an outcome yet; the traveller hears once. */
    canDecide.mockResolvedValue(true);
    decideTask.mockResolvedValue({
      status: 'RUNNING',
      subjectId: REQ,
      createdTaskIds: [],
      firedEffects: [],
    });
    const c = await callerFor(decideDb(), []);
    await c.decide({ taskId: TASK, approve: true });
    await new Promise((r) => setImmediate(r));
    expect(notifyRecipients).not.toHaveBeenCalled();
  });

  it('tells the next approvers when the chain moved on, but not the decider', async () => {
    canDecide.mockResolvedValue(true);
    decideTask.mockResolvedValue({
      status: 'RUNNING',
      subjectId: REQ,
      createdTaskIds: ['t2'],
      firedEffects: [],
    });
    taskRecipientIds.mockResolvedValue([U('7'), ME]);
    const c = await callerFor(decideDb(), []);
    await c.decide({ taskId: TASK, approve: true });
    await new Promise((r) => setImmediate(r));
    expect(notifyRecipients.mock.calls[0]?.[2]).toEqual([U('7')]);
  });

  it('runs the effects the engine fired', async () => {
    canDecide.mockResolvedValue(true);
    decideTask.mockResolvedValue({
      status: 'APPROVED',
      subjectId: REQ,
      createdTaskIds: [],
      firedEffects: ['e9'],
    });
    const c = await callerFor(decideDb(), []);
    await c.decide({ taskId: TASK, approve: true });
    expect(executeWorkflowEffects).toHaveBeenCalledWith(expect.anything(), {
      subjectType: 'TRAVEL_REQUEST',
      subjectId: REQ,
      effectNodeIds: ['e9'],
      actorId: ME,
    });
  });

  it('still answers when the notification fan-out fails', async () => {
    /**
     * The decision is committed and audited by then. Failing the call would tell the
     * approver their approval did not land, and they would press again.
     */
    canDecide.mockResolvedValue(true);
    decideTask.mockResolvedValue({
      status: 'APPROVED',
      subjectId: REQ,
      createdTaskIds: [],
      firedEffects: [],
    });
    recordActivity.mockRejectedValue(new Error('redis down'));
    const c = await callerFor(decideDb(), []);
    await expect(c.decide({ taskId: TASK, approve: true })).resolves.toMatchObject({
      status: 'APPROVED',
    });
  });
});

// ── Turning an approved trip into a report ────────────────────────────────────

describe('buildReport', () => {
  const caller = (db: unknown, extra: readonly string[] = []) =>
    callerFor(db, [P.expense.report.createOwn, ...extra]);

  it('404s a request that does not exist', async () => {
    const db = makeDb();
    db.travelRequest.findUnique.mockResolvedValue(null);
    await expect((await caller(db)).buildReport({ id: REQ })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('refuses somebody else’s trip', async () => {
    const db = makeDb();
    db.travelRequest.findUnique.mockResolvedValue({ submitterId: U('3'), status: 'APPROVED' });
    await expect((await caller(db)).buildReport({ id: REQ })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('lets an admin build it on the traveller’s behalf', async () => {
    const db = makeDb();
    db.travelRequest.findUnique.mockResolvedValue({ submitterId: U('3'), status: 'APPROVED' });
    await expect(
      (await caller(db, [P.user.readAll])).buildReport({ id: REQ }),
    ).resolves.toBeTruthy();
  });

  it('refuses a trip nobody has approved yet', async () => {
    /** The point of the skeleton is that its lines came from an approved budget. */
    const db = makeDb();
    db.travelRequest.findUnique.mockResolvedValue({ submitterId: ME, status: 'SUBMITTED' });
    await expect((await caller(db)).buildReport({ id: REQ })).rejects.toThrow(
      /Only an approved request/,
    );
  });

  it('names the one refusal worth naming: the report is already in approvals', async () => {
    /** A second copy of a report that is mid-chain is worse than saying no — two reports
     *  for one trip, one of them approved. */
    const db = makeDb();
    db.travelRequest.findUnique.mockResolvedValue({ submitterId: ME, status: 'APPROVED' });
    buildReportFromTravel.mockRejectedValue(new Error('This trip already has a submitted report.'));
    await expect((await caller(db)).buildReport({ id: REQ })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });

  it('lets any other failure through as itself', async () => {
    /** Translating everything to CONFLICT would tell a caller to stop retrying a fault
     *  that retrying would fix. */
    const db = makeDb();
    db.travelRequest.findUnique.mockResolvedValue({ submitterId: ME, status: 'APPROVED' });
    buildReportFromTravel.mockRejectedValue(new Error('connection terminated'));
    await expect((await caller(db)).buildReport({ id: REQ })).rejects.toThrow(
      /connection terminated/,
    );
  });
});

/**
 * Planned items — the part of a trip no provider can price.
 *
 * A budget assembled only from what SerpApi sells covers flights and hotels. The
 * conference fee, the department dinner and the rental car (which nothing on the
 * market quotes at all — there is no car engine) are real money the approver is being
 * asked to authorise, and until these existed there was nowhere to put them: they
 * arrived as a surprise on the expense report instead.
 *
 * They ride on `basis: MANUAL`, which the enum already carried and which both
 * re-pricing paths already exempt — so surviving a re-price is a property of the
 * existing code rather than something these mutations have to defend. No migration.
 */
/**
 * Lines: adding, editing, removing, reordering.
 *
 * The whole of what replaced the auto-built budget. Four properties matter here, and
 * every one of them is a thing that used to be wrong:
 *
 *   · the amount is DERIVED server-side, and a client-sent figure lands as MANUAL;
 *   · `kind` comes from the CATEGORY, never from the client;
 *   · a line belonging to another request cannot be touched by id;
 *   · a submitted request refuses all four.
 */
describe('categories', () => {
  it('offers the ACTIVE travel categories, and names the rental-car bucket', async () => {
    /**
     * The car code is returned rather than hardcoded in the client, because the drawer
     * has to recognise that bucket to say a car has to be planned by hand. Duplicating
     * the string in the UI is how the two drift apart on a seed rename.
     */
    const db = makeDb();
    db.travelCategory.findMany.mockResolvedValue([
      { id: CAT, code: 'travelMeals', lineKind: 'STANDARD' },
    ]);
    const c = await callerFor(db, [P.travel.request.updateOwn]);
    const out = await c.categories();
    // TRAVEL categories, not expense ones: fifteen things you can book a trip against,
    // not the thirty-one an accountant codes to.
    expect(db.travelCategory.findMany.mock.calls[0]?.[0]?.where).toEqual({ active: true });
    expect(db.expenseCategory.findMany).not.toHaveBeenCalled();
    // `lineKind` rides along — it decides which editor block the picked category opens,
    // and the drawer cannot know it otherwise.
    expect(out.items[0]?.lineKind).toBe('STANDARD');
    expect(out.carCode).toBe('travelCarRental');
  });
});

describe('addLine', () => {
  const caller = (db: unknown) => callerFor(db, [P.travel.request.updateOwn]);
  /** The EXPENSE category a per-diem rate is keyed on. */
  const EXP_CAT = U('4');
  const written = (db: ReturnType<typeof makeDb>) =>
    db.travelBudgetLine.create.mock.calls[0]?.[0]?.data as Record<string, unknown>;

  /**
   * Drive the lookup the router is handed, rather than stubbing it away.
   *
   * `perDiemForCategory` decides WHICH allowance applies — its arithmetic is covered in
   * `travelBudget.test.ts`. Converting the result into the request's currency is the
   * ROUTER's job, and the callback is where that decision is made, so a stub that
   * ignored it would leave the conversion untested.
   */
  function allowanceOf(dailyMinor: bigint, currencyId: string | null, days = 4) {
    perDiemForCategory.mockImplementation(
      (_args: unknown, convert: (amountMinor: bigint, currencyId: string | null) => bigint) => {
        const daily = convert(dailyMinor, currencyId);
        return {
          amountMinor: daily * BigInt(days),
          days,
          edgeDaysHalved: false,
          dailyRateMinor: daily,
        };
      },
    );
  }

  /** A db whose per-diem table answers for `EXP_CAT` at $75.00/day. */
  function perDiemDb(over: Record<string, unknown> = {}) {
    const db = makeDb();
    allowanceOf(7500n, null);
    db.travelCategory.findUnique.mockResolvedValue({
      id: CAT,
      active: true,
      lineKind: 'STANDARD',
      glAccountId: null,
      expenseCategoryId: EXP_CAT,
      expenseCategory: { glAccountId: GL },
      ...over,
    });
    db.perDiemRate.findMany.mockResolvedValue([
      {
        city: 'Toronto',
        categoryId: EXP_CAT,
        amountMinor: 7500n,
        firstLastDay: false,
        effectiveFrom: new Date('2020-01-01T00:00:00Z'),
        effectiveTo: null,
        jobLevelId: null,
        legalEntityId: null,
        businessUnitId: null,
        currencyId: null,
      },
    ]);
    db.currency.findMany.mockResolvedValue([{ code: 'CAD' }]);
    db.travelBudgetLine.aggregate.mockResolvedValue({ _max: { sortOrder: 2 } });
    return db;
  }

  it('derives the amount from the per-diem for the mapped expense category', async () => {
    // The behaviour the whole phase is for: picking "Meals" fills its own amount in.
    // A 4-day trip at $75.00/day.
    const db = perDiemDb();
    await (await caller(db)).addLine({ id: REQ, categoryId: CAT });
    expect(written(db).amountMinor).toBe(4n * 7500n);
    expect(written(db).basis).toBe('PER_DIEM');
    // Looked up under the MAPPED expense category, which is the only key the rates have.
    expect(perDiemForCategory.mock.calls[0]?.[0]?.expenseCategoryId).toBe(EXP_CAT);
  });

  it('converts an allowance quoted in another currency', async () => {
    // $100 USD at 1.35 → $135 CAD. The trip is priced in CAD, so this is what the
    // approver sees and what budget-vs-actual later compares against.
    const db = perDiemDb();
    db.fxRate.findMany.mockResolvedValue([{ base: 'USD', quote: 'CAD', rate: '1.35' }]);
    db.currency.findMany.mockResolvedValue([
      // VeloExpense (w6-01): a currency's id IS its code.
      { code: 'CAD' },
      { code: 'USD' },
    ]);
    allowanceOf(10_000n, 'USD');
    await (await caller(db)).addLine({ id: REQ, categoryId: CAT });
    expect(written(db).amountMinor).toBe(4n * 13_500n);
  });

  it('treats a rate with no currency as already in the request currency', async () => {
    // A per-diem row can be stored without one, meaning "the org policy currency" —
    // which is what a request defaults to. Dropping the allowance instead would
    // silently under-budget the trip by a whole line.
    const db = perDiemDb();
    db.fxRate.findMany.mockResolvedValue([]);
    allowanceOf(7500n, null);
    await (await caller(db)).addLine({ id: REQ, categoryId: CAT });
    expect(written(db).amountMinor).toBe(4n * 7500n);
  });

  it('takes a client amount as MANUAL, and it wins over the allowance', async () => {
    /**
     * The whole of "a manual edit overriding the amount takes precedence". There is no
     * re-price to undo it: restoring the allowance means adding a fresh line and
     * deleting this one.
     */
    const db = perDiemDb();
    await (await caller(db)).addLine({
      id: REQ,
      categoryId: CAT,
      amountMinor: 12_500n,
      // Required now: this replaces a derived allowance (GA-6).
      notes: 'Hotel restaurant, no cheaper option',
    });
    expect(written(db).amountMinor).toBe(12_500n);
    expect(written(db).basis).toBe('MANUAL');
  });

  it('refuses to raise a policy-derived amount with no reason given', async () => {
    /**
     * GA audit v2, GA-6. Overriding a derived per-diem produced an ordinary "Planned"
     * line: the $400 the policy worked out was gone, nothing recorded that a human had
     * replaced it, and no justification was asked for. In an expense product that is the
     * event an approver most needs flagged.
     *
     * The reason is required at THIS seam only. `notes` stays optional everywhere else —
     * it is the traveller's field, not an override form.
     */
    const db = perDiemDb();
    await expect(
      (await caller(db)).addLine({ id: REQ, categoryId: CAT, amountMinor: 12_500n }),
    ).rejects.toThrow(/needs a reason/i);
  });

  it('keeps what the policy derived, so an approver can see what was replaced', async () => {
    const db = perDiemDb();
    await (await caller(db)).addLine({
      id: REQ,
      categoryId: CAT,
      amountMinor: 12_500n,
      notes: 'Hotel restaurant, no cheaper option',
    });
    // The figure the traveller overrode, kept beside the one they chose.
    expect(written(db).derivedAmountMinor).not.toBeNull();
    expect(written(db).amountMinor).toBe(12_500n);
    expect(written(db).basis).toBe('MANUAL');
  });

  it('does not call a typed amount an override when nothing was derived', async () => {
    /**
     * A planned item the policy cannot price is not an override: there was no figure to
     * replace. `derivedAmountMinor` stays null and no reason is demanded — otherwise the
     * guard becomes a toll on every line the org has no rate for.
     */
    const db = perDiemDb({ expenseCategoryId: null, lineKind: 'STANDARD' });
    await (await caller(db)).addLine({ id: REQ, categoryId: CAT, amountMinor: 4_200n });
    expect(written(db).amountMinor).toBe(4_200n);
    expect(written(db).derivedAmountMinor ?? null).toBeNull();
  });

  it('never lets a client amount arrive wearing PER_DIEM or QUOTE', async () => {
    // The prototype in archive/ let the form post its own total. A typed figure is
    // labelled as one, always, so an approver can tell a market price from a guess.
    const db = perDiemDb();
    await (await caller(db)).addLine({
      id: REQ,
      categoryId: CAT,
      amountMinor: 999n,
      notes: 'why',
    });
    expect(written(db).basis).not.toBe('PER_DIEM');
    expect(written(db).basis).not.toBe('QUOTE');
  });

  it('derives a cap-priced kind as POLICY_CAP', async () => {
    // A daily cap × days is a policy MAXIMUM, not a prediction, and an approver
    // deciding on a total is entitled to know which they are reading.
    const db = perDiemDb({ lineKind: 'CAR_RENTAL' });
    await (await caller(db)).addLine({
      id: REQ,
      categoryId: CAT,
      payload: { days: 3, dailyCapMinor: '7500' },
    });
    expect(written(db).amountMinor).toBe(22_500n);
    expect(written(db).basis).toBe('POLICY_CAP');
  });

  it('prices a department meal from its attendees', async () => {
    const db = perDiemDb({ lineKind: 'DEPARTMENT_MEAL' });
    await (await caller(db)).addLine({
      id: REQ,
      categoryId: CAT,
      payload: {
        attendees: [{ name: 'Ada' }, { name: 'Grace' }],
        occurrencesPerDay: 1,
        days: 2,
        ratePerPersonMinor: '2500',
      },
    });
    expect(written(db).amountMinor).toBe(10_000n);
    expect(written(db).basis).toBe('PER_DIEM');
  });

  it('takes the KIND from the category, not from the client', async () => {
    const db = perDiemDb({ lineKind: 'LODGING' });
    await (await caller(db)).addLine({
      id: REQ,
      categoryId: CAT,
      payload: {
        checkIn: '2026-09-01',
        checkOut: '2026-09-04',
        nights: 3,
        capPerNightMinor: '20000',
      },
    });
    expect(written(db).kind).toBe('LODGING');
  });

  it('refuses a payload that does not fit the category’s kind', async () => {
    // Strict on write. A LODGING line holding airfare fields is a bug, not input to
    // be salvaged into something plausible.
    const db = perDiemDb({ lineKind: 'LODGING' });
    await expect(
      (await caller(db)).addLine({ id: REQ, categoryId: CAT, payload: { flightNumber: 'AC 412' } }),
    ).rejects.toThrow();
  });

  it('lands at zero and MANUAL when nothing can price it', async () => {
    /**
     * Not a refusal. An org with no rate for a cost still has to be able to record it,
     * which is the situation planned items existed for — the line exists and visibly
     * wants a number.
     */
    const db = perDiemDb({ expenseCategoryId: null, expenseCategory: null });
    perDiemForCategory.mockReturnValue(null);
    await (await caller(db)).addLine({ id: REQ, categoryId: CAT });
    expect(written(db).amountMinor).toBe(0n);
    expect(written(db).basis).toBe('MANUAL');
  });

  it('stamps the GL account, inheriting the mapped expense category’s', async () => {
    // Budget-vs-actual compares against transactions keyed on this account; resolving
    // it at read time would let an admin's later edit rewrite an approved estimate.
    const db = perDiemDb();
    await (await caller(db)).addLine({ id: REQ, categoryId: CAT });
    expect(written(db).glAccountId).toBe(GL);
  });

  it('appends to the end of the itinerary', async () => {
    const db = perDiemDb();
    await (await caller(db)).addLine({ id: REQ, categoryId: CAT });
    expect(written(db).sortOrder).toBe(3);
  });

  it('stores the traveller’s notes verbatim, trimmed', async () => {
    const db = perDiemDb();
    await (await caller(db)).addLine({ id: REQ, categoryId: CAT, notes: '  Team dinner  ' });
    expect(written(db).notes).toBe('Team dinner');
  });

  it('leaves notes NULL when the traveller typed nothing, even on a priced line', async () => {
    /**
     * There is no server-composed fallback any more, and that is the point: `notes` is
     * the traveller's field, so a policy rule requiring one can tell "they explained
     * this" from "the server described the arithmetic". A per-diem line used to arrive
     * carrying "Per diem · 3 days · Toronto" and would have satisfied such a rule
     * without anybody writing a word.
     */
    const db = perDiemDb();
    await (await caller(db)).addLine({ id: REQ, categoryId: CAT });
    expect(written(db).notes).toBeNull();
  });

  it('records the per-diem derivation in the payload, not as prose', async () => {
    // The facts the deleted sentence used to carry, now re-readable and localizable.
    const db = perDiemDb();
    await (await caller(db)).addLine({ id: REQ, categoryId: CAT });
    expect(written(db).payload).toMatchObject({
      perDiemDays: expect.any(Number),
      perDiemCity: 'Toronto',
    });
  });

  it('refuses a client-supplied per-diem derivation', async () => {
    /**
     * The forgery this strips. Those four fields assert that the server applied an
     * allowance; a client posting them alongside its own amount would produce a MANUAL
     * line that renders as a per-diem one.
     */
    const db = perDiemDb();
    await (await caller(db)).addLine({
      id: REQ,
      categoryId: CAT,
      amountMinor: 9_900n,
      payload: { perDiemDays: 99, perDiemCity: 'Nowhere', perDiemDailyMinor: '100' },
      notes: 'why',
    });
    expect(written(db).basis).toBe('MANUAL');
    expect(written(db).payload).toEqual({});
  });

  it('refuses a retired category', async () => {
    const db = perDiemDb({ active: false });
    await expect((await caller(db)).addLine({ id: REQ, categoryId: CAT })).rejects.toThrow(
      /not available/,
    );
  });

  it('refuses a category that does not exist', async () => {
    // The same refusal as a retired one: naming which would tell an outsider whether
    // an id exists.
    const db = perDiemDb();
    db.travelCategory.findUnique.mockResolvedValue(null);
    await expect((await caller(db)).addLine({ id: REQ, categoryId: CAT })).rejects.toThrow(
      /not available/,
    );
  });

  it('refuses a negative or absurd amount', async () => {
    const db = perDiemDb();
    await expect(
      (await caller(db)).addLine({ id: REQ, categoryId: CAT, amountMinor: -1n }),
    ).rejects.toThrow();
    await expect(
      (await caller(db)).addLine({ id: REQ, categoryId: CAT, amountMinor: 100_000_001n }),
    ).rejects.toThrow();
  });

  /**
   * `perDiemRate` — the allowance READ, with nothing written.
   *
   * It exists so the attendee editor can pre-fill the per-person box instead of showing a
   * blank one beside a total. "Three people, twice a day, four days" is only auditable if
   * the fourth number is on screen, and a traveller who cannot see the rate has no way to
   * tell an allowance they should question from one they should not.
   *
   * It had no coverage at all, and every one of its refusals returns the SAME shape as its
   * success — `{ ratePerPersonMinor: null }`, never a throw — because a category with no
   * allowance is not an error. The block just behaves as it always did, with an empty box
   * the traveller fills in. That makes a silently-wrong branch here invisible, which is
   * why each one is asserted separately.
   */
  describe('the per-person allowance it reads for the attendee editor', () => {
    it('returns the DAILY rate, not the trip total', async () => {
      /**
       * The block multiplies by heads AND by occurrences AND by days itself, so a figure
       * that already counted the days would multiply the trip length in twice: a 4-day
       * trip at $75/day would offer $300 per person per meal.
       */
      const db = perDiemDb();
      const out = await (await caller(db)).perDiemRate({ id: REQ, categoryId: CAT });
      expect(out).toEqual({ ratePerPersonMinor: '7500' });
    });

    it('reads it in the REQUEST’s currency', async () => {
      // Same conversion the write path does, and for the same reason: the per-person box
      // sits beside a total the approval tier is read in.
      const db = perDiemDb();
      db.fxRate.findMany.mockResolvedValue([{ base: 'USD', quote: 'CAD', rate: '1.35' }]);
      db.currency.findMany.mockResolvedValue([
        // VeloExpense (w6-01): a currency's id IS its code.
        { code: 'CAD' },
        { code: 'USD' },
      ]);
      allowanceOf(10_000n, 'USD');
      const out = await (await caller(db)).perDiemRate({ id: REQ, categoryId: CAT });
      expect(out).toEqual({ ratePerPersonMinor: '13500' });
    });

    it('answers null for a category that maps to no expense category', async () => {
      // Per-diem rates are keyed on the EXPENSE category. A travel category with no
      // mapping has no allowance to look up — not an error, just nothing to pre-fill.
      const db = perDiemDb({ expenseCategoryId: null });
      const out = await (await caller(db)).perDiemRate({ id: REQ, categoryId: CAT });
      expect(out).toEqual({ ratePerPersonMinor: null });
    });

    it('answers null for a retired category, and for one that does not exist', async () => {
      // Unlike `addLine`, which refuses both: this is a read that pre-fills a box, and
      // throwing would break a drawer that is otherwise working.
      const retired = perDiemDb({ active: false });
      await expect(
        (await caller(retired)).perDiemRate({ id: REQ, categoryId: CAT }),
      ).resolves.toEqual({ ratePerPersonMinor: null });

      const missing = perDiemDb();
      missing.travelCategory.findUnique.mockResolvedValue(null);
      await expect(
        (await caller(missing)).perDiemRate({ id: REQ, categoryId: CAT }),
      ).resolves.toEqual({ ratePerPersonMinor: null });
    });

    it('answers null when no rate covers the destination and the traveller’s tier', async () => {
      // The case the empty box is FOR. Zero is not an allowance — offering "$0.00 per
      // person" would read as a policy decision rather than as an absent rate.
      const db = perDiemDb();
      perDiemForCategory.mockReturnValue(null);
      await expect((await caller(db)).perDiemRate({ id: REQ, categoryId: CAT })).resolves.toEqual({
        ratePerPersonMinor: null,
      });

      allowanceOf(0n, null);
      await expect((await caller(db)).perDiemRate({ id: REQ, categoryId: CAT })).resolves.toEqual({
        ratePerPersonMinor: null,
      });
    });
  });

  /**
   * `previewLine` — what the policy WOULD derive, before the line exists.
   *
   * The create drawer has no saved request to read the trip off, so the destination, the
   * dates and the currency arrive as input and the tier comes from the caller's own row.
   * It walks the same `perDiemForCategory` as the write path — these cases assert the
   * INPUTS it is handed and the conversion it applies, not the arithmetic, which is the
   * lookup's own business and is covered in `travelBudget.test.ts`.
   */
  describe('the derivation it previews for a line that does not exist yet', () => {
    const TRIP = {
      destinationCity: 'Toronto',
      departDate: '2026-09-01T00:00:00.000Z',
      returnDate: '2026-09-04T00:00:00.000Z',
      currencyId: 'CAD',
    };
    const NOTHING = {
      derivedAmountMinor: null,
      basis: null,
      days: 0,
      dailyRateMinor: null,
      edgeDaysHalved: false,
      city: null,
    };

    it('derives for a mapped category, from the CALLER’s own tier', async () => {
      // No request row exists to read a submitter off: the person asking is the person
      // travelling, so the tier is theirs.
      const db = perDiemDb();
      db.user.findUnique.mockResolvedValue({
        jobLevelId: U('a'),
        legalEntityId: U('b'),
        businessUnitId: U('c'),
      });
      const out = await (await caller(db)).previewLine({ categoryId: CAT, ...TRIP });
      expect(out).toEqual({
        derivedAmountMinor: '30000',
        basis: 'PER_DIEM',
        days: 4,
        dailyRateMinor: '7500',
        edgeDaysHalved: false,
        city: 'Toronto',
      });
      expect(perDiemForCategory.mock.calls[0]?.[0]).toMatchObject({
        destinationCity: 'Toronto',
        departDate: new Date('2026-09-01T00:00:00.000Z'),
        returnDate: new Date('2026-09-04T00:00:00.000Z'),
        tier: { jobLevelId: U('a'), legalEntityId: U('b'), businessUnitId: U('c') },
        expenseCategoryId: EXP_CAT,
      });
      expect(db.user.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: ME } }),
      );
      expect(db.travelRequest.findUniqueOrThrow).not.toHaveBeenCalled();
    });

    it('answers nothing for a category mapped to no expense category', async () => {
      // Not an error: the box stays blank for the traveller to fill, as it always did.
      const db = perDiemDb({ expenseCategoryId: null });
      await expect((await caller(db)).previewLine({ categoryId: CAT, ...TRIP })).resolves.toEqual(
        NOTHING,
      );
      expect(perDiemForCategory).not.toHaveBeenCalled();
    });

    it('answers nothing for a retired category, and when no rate covers the trip', async () => {
      const retired = perDiemDb({ active: false });
      await expect(
        (await caller(retired)).previewLine({ categoryId: CAT, ...TRIP }),
      ).resolves.toEqual(NOTHING);

      const uncovered = perDiemDb();
      perDiemForCategory.mockReturnValue(null);
      await expect(
        (await caller(uncovered)).previewLine({ categoryId: CAT, ...TRIP }),
      ).resolves.toEqual({ ...NOTHING, city: null });
    });

    it('converts the allowance into the currency the request will be filed in', async () => {
      // The figure populated in the drawer has to be the figure the save will derive, and
      // the save derives in the request's currency.
      const db = perDiemDb();
      db.fxRate.findMany.mockResolvedValue([{ base: 'USD', quote: 'CAD', rate: '1.35' }]);
      db.currency.findMany.mockResolvedValue([
        // VeloExpense (w6-01): a currency's id IS its code.
        { code: 'CAD' },
        { code: 'USD' },
      ]);
      allowanceOf(10_000n, 'USD');
      const out = await (await caller(db)).previewLine({ categoryId: CAT, ...TRIP });
      expect(out.derivedAmountMinor).toBe(String(4n * 13_500n));
      expect(out.dailyRateMinor).toBe('13500');
    });

    it('prices nothing in a currency it does not know, rather than in the wrong one', async () => {
      const db = perDiemDb();
      await expect(
        // VeloExpense (w6-01): a currency is keyed by its code; 'XTS' is ISO's testing code,
        // which the reference table does not carry.
        (await caller(db)).previewLine({ categoryId: CAT, ...TRIP, currencyId: 'XTS' }),
      ).resolves.toEqual(NOTHING);
    });

    it('needs a departure date to price against, without a request', async () => {
      const db = perDiemDb();
      await expect(
        (await caller(db)).previewLine({ categoryId: CAT, ...TRIP, departDate: null }),
      ).resolves.toEqual(NOTHING);
    });

    it('reads a SAVED request’s trip instead, when given one', async () => {
      // The saved-request editor previews what `updateLine` will derive, so the facts have
      // to be the request's — its destination, its dates, its submitter's tier, its
      // currency — and not whatever the client sends alongside.
      const db = perDiemDb();
      db.travelRequest.findUniqueOrThrow.mockResolvedValue(
        request({
          destinationCity: 'Montreal',
          submitter: { jobLevelId: U('d'), legalEntityId: null, businessUnitId: null },
        }),
      );
      const out = await (await caller(db)).previewLine({
        categoryId: CAT,
        requestId: REQ,
        destinationCity: 'Somewhere else',
      });
      expect(out.derivedAmountMinor).toBe('30000');
      expect(out.city).toBe('Montreal');
      expect(perDiemForCategory.mock.calls[0]?.[0]).toMatchObject({
        destinationCity: 'Montreal',
        tier: { jobLevelId: U('d') },
      });
      expect(db.user.findUnique).not.toHaveBeenCalled();
    });

    it('refuses to read a request that is not the caller’s', async () => {
      // A lookup keyed on any id in the org would tell a stranger where somebody is
      // going and when.
      const db = perDiemDb();
      db.travelRequest.findUniqueOrThrow.mockResolvedValue(request({ submitterId: U('8') }));
      await expect(
        (await caller(db)).previewLine({ categoryId: CAT, requestId: REQ }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('needs the same permission as adding a line', async () => {
      const db = perDiemDb();
      await expect(
        (await callerFor(db, [])).previewLine({ categoryId: CAT, ...TRIP }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });
  });
});

describe('updateLine, removeLine and reorderLines', () => {
  const caller = (db: unknown) => callerFor(db, [P.travel.request.updateOwn]);
  const LINE_ID = U('9');

  function lineDb(over: Record<string, unknown> = {}) {
    const db = makeDb();
    db.travelBudgetLine.findUnique.mockResolvedValue({
      id: LINE_ID,
      travelRequestId: REQ,
      categoryId: CAT,
      payload: { days: 3, dailyCapMinor: '7500' },
      amountMinor: 22_500n,
      ...over,
    });
    db.travelCategory.findUnique.mockResolvedValue({
      id: CAT,
      active: true,
      lineKind: 'CAR_RENTAL',
      glAccountId: null,
      expenseCategoryId: null,
      expenseCategory: null,
    });
    return db;
  }
  const updated = (db: ReturnType<typeof makeDb>) =>
    db.travelBudgetLine.update.mock.calls[0]?.[0]?.data as Record<string, unknown>;

  it('overrides the amount to MANUAL and KEEPS the payload', async () => {
    // A department meal somebody rounded up still has to know who is going to it.
    const db = lineDb();
    await (await caller(db)).updateLine({
      id: REQ,
      lineId: LINE_ID,
      amountMinor: 30_000n,
      notes: 'Rounded up for the group booking',
    });
    expect(updated(db).amountMinor).toBe(30_000n);
    expect(updated(db).basis).toBe('MANUAL');
    // `toMatchObject`, not `toEqual`: the registry defaults the optional dates in, and
    // what this asserts is that the payload SURVIVES an amount-only override — not its
    // exact shape, which is the registry's business.
    expect(updated(db).payload).toMatchObject({ days: 3, dailyCapMinor: '7500' });
  });

  it('re-derives the amount when the payload changes', async () => {
    /**
     * Changing the days and leaving the total alone produces a line whose own fields
     * contradict its figure — which is worse than either number on its own, because
     * both look authoritative.
     */
    const db = lineDb();
    await (await caller(db)).updateLine({
      id: REQ,
      lineId: LINE_ID,
      payload: { days: 5, dailyCapMinor: '7500' },
    });
    expect(updated(db).amountMinor).toBe(37_500n);
    expect(updated(db).basis).toBe('POLICY_CAP');
  });

  it('keeps the stored payload when the edit does not mention it', async () => {
    // An amount-only edit must not have to resend fields it is not changing.
    const db = lineDb();
    await (await caller(db)).updateLine({ id: REQ, lineId: LINE_ID, notes: 'Rental' });
    expect(updated(db).amountMinor).toBe(22_500n);
  });

  /**
   * The note an override owes — on UPDATE, where the line may already carry one.
   *
   * `addLine` covers the refusal on create. Here the question is what satisfies it: notes
   * sent with the amount, or notes already stored on the line, because the requirement is
   * that the override is explained, not that it is re-explained on every edit.
   */
  describe('raising a policy-derived amount', () => {
    /** A per-diem line at $300.00 the policy derived, with whatever notes it carries. */
    function derivedLineDb(notes: string | null) {
      const db = lineDb({ payload: {}, amountMinor: 30_000n, notes });
      db.travelCategory.findUnique.mockResolvedValue({
        id: CAT,
        active: true,
        lineKind: 'STANDARD',
        glAccountId: null,
        expenseCategoryId: U('4'),
        expenseCategory: { glAccountId: GL },
      });
      perDiemForCategory.mockReturnValue({
        amountMinor: 30_000n,
        days: 4,
        edgeDaysHalved: false,
        dailyRateMinor: 7500n,
      });
      return db;
    }

    it('refuses with no reason given, and writes nothing', async () => {
      const db = derivedLineDb(null);
      await expect(
        (await caller(db)).updateLine({ id: REQ, lineId: LINE_ID, amountMinor: 45_000n }),
      ).rejects.toThrow(/needs a reason/i);
      expect(db.travelBudgetLine.update).not.toHaveBeenCalled();
    });

    it('is satisfied by notes already stored on the line', async () => {
      // A traveller raising an amount on a line they have already explained should not
      // have to retype the explanation to get past the guard.
      const db = derivedLineDb('Hotel restaurant, no cheaper option');
      await (await caller(db)).updateLine({ id: REQ, lineId: LINE_ID, amountMinor: 45_000n });
      expect(updated(db)).toMatchObject({
        amountMinor: 45_000n,
        basis: 'MANUAL',
        derivedAmountMinor: 30_000n,
      });
      // The stored note is left alone: nothing was sent about it.
      expect(updated(db)).not.toHaveProperty('notes');
    });

    it('is satisfied by notes sent WITH the amount', async () => {
      const db = derivedLineDb(null);
      await (await caller(db)).updateLine({
        id: REQ,
        lineId: LINE_ID,
        amountMinor: 45_000n,
        notes: 'Client dinner ran over the allowance',
      });
      expect(updated(db)).toMatchObject({
        amountMinor: 45_000n,
        derivedAmountMinor: 30_000n,
        notes: 'Client dinner ran over the allowance',
      });
    });

    it('refuses when the same write clears the note that would have satisfied it', async () => {
      // "I withdraw what I wrote" is expressible — but not in the write that needs it.
      const db = derivedLineDb('Was explained');
      await expect(
        (await caller(db)).updateLine({
          id: REQ,
          lineId: LINE_ID,
          amountMinor: 45_000n,
          notes: '',
        }),
      ).rejects.toThrow(/needs a reason/i);
    });

    it('asks for nothing on a line the policy never priced', async () => {
      // A typed figure on an unpriced line displaces nothing; the guard must not become a
      // toll on every planned item. (A cap × days IS a derivation — the default `lineDb`
      // car line would rightly be refused — so this is a STANDARD line mapped to nothing.)
      const db = lineDb({ payload: {}, notes: null });
      db.travelCategory.findUnique.mockResolvedValue({
        id: CAT,
        active: true,
        lineKind: 'STANDARD',
        glAccountId: null,
        expenseCategoryId: null,
        expenseCategory: null,
      });
      await (await caller(db)).updateLine({ id: REQ, lineId: LINE_ID, amountMinor: 45_000n });
      expect(updated(db)).toMatchObject({ amountMinor: 45_000n, basis: 'MANUAL' });
      expect(updated(db)).not.toHaveProperty('derivedAmountMinor');
    });
  });

  it('refuses a line belonging to another request', async () => {
    // Without the ownership check this is an endpoint for editing any line in the org
    // by id.
    const db = lineDb({ travelRequestId: U('8') });
    await expect(
      (await caller(db)).updateLine({ id: REQ, lineId: LINE_ID, amountMinor: 1n }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('removes ANY line, not only a MANUAL one', async () => {
    /**
     * The old `removePlannedItem` refused anything else, because a re-price was the
     * only way a quoted or per-diem line could change and deleting one left a hole
     * nothing would refill. Nothing re-prices now.
     */
    const db = lineDb({ amountMinor: 74_200n });
    await (await caller(db)).removeLine({ id: REQ, lineId: LINE_ID });
    expect(db.travelBudgetLine.delete).toHaveBeenCalledWith({ where: { id: LINE_ID } });
  });

  it('refuses to remove a line belonging to another request', async () => {
    const db = lineDb({ travelRequestId: U('8') });
    await expect((await caller(db)).removeLine({ id: REQ, lineId: LINE_ID })).rejects.toMatchObject(
      { code: 'NOT_FOUND' },
    );
  });

  it('writes each id’s position as its sortOrder, scoped to the request', async () => {
    const db = makeDb();
    const other = U('a');
    await (await caller(db)).reorderLines({ id: REQ, lineIds: [other, LINE_ID] });
    const calls = db.travelBudgetLine.updateMany.mock.calls;
    // Scoped: `updateMany` on a foreign id is a no-op rather than a way to reorder
    // somebody else's estimate.
    expect(calls[0]?.[0]).toEqual({
      where: { id: other, travelRequestId: REQ },
      data: { sortOrder: 0 },
    });
    expect(calls[1]?.[0]).toEqual({
      where: { id: LINE_ID, travelRequestId: REQ },
      data: { sortOrder: 1 },
    });
  });

  it('refuses all four on a submitted request', async () => {
    for (const status of ['SUBMITTED', 'APPROVED'] as const) {
      const db = lineDb();
      db.travelRequest.findUnique.mockResolvedValue(request({ status }));
      const c = await caller(db);
      await expect(c.addLine({ id: REQ, categoryId: CAT })).rejects.toThrow(/no longer be edited/);
      await expect(c.updateLine({ id: REQ, lineId: LINE_ID, amountMinor: 1n })).rejects.toThrow(
        /no longer be edited/,
      );
      await expect(c.removeLine({ id: REQ, lineId: LINE_ID })).rejects.toThrow(
        /no longer be edited/,
      );
      await expect(c.reorderLines({ id: REQ, lineIds: [LINE_ID] })).rejects.toThrow(
        /no longer be edited/,
      );
    }
  });

  it('refuses all four on somebody else’s request', async () => {
    const db = lineDb();
    db.travelRequest.findUnique.mockResolvedValue(request({ submitterId: U('3') }));
    const c = await caller(db);
    await expect(c.addLine({ id: REQ, categoryId: CAT })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(c.removeLine({ id: REQ, lineId: LINE_ID })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });
});

/**
 * The option pickers.
 *
 * One property matters more than all the others here: the amount on a chosen line comes
 * from the STORED candidate, never from the client. A picker that accepted "here is the
 * option I picked, and here is what it cost" would be the archived prototype's
 * posted-total bug wearing a new shape, which is why a search writes rows before
 * anything can be chosen.
 */
describe('searchFlightOptions and searchStayOptions', () => {
  const caller = (db: unknown) => callerFor(db, [P.travel.request.updateOwn]);

  it('hands the search to the library with the request as the route', async () => {
    // The route comes from the REQUEST, not the caller. A search with its own origin
    // would price a journey the request does not describe.
    const db = makeDb();
    findFlightOptions.mockResolvedValue({ options: [], found: 0, insight: null, reason: 'ok' });
    await (await caller(db)).searchFlightOptions({ id: REQ, travelClass: 'BUSINESS' });
    expect(findFlightOptions.mock.calls[0]?.[2]).toBe(REQ);
    expect(findFlightOptions.mock.calls[0]?.[3]).toMatchObject({ travelClass: 'BUSINESS' });
  });

  it('defaults to a round trip in economy', async () => {
    const db = makeDb();
    findFlightOptions.mockResolvedValue({ options: [], found: 0, insight: null, reason: 'ok' });
    await (await caller(db)).searchFlightOptions({ id: REQ });
    expect(findFlightOptions.mock.calls[0]?.[3]).toMatchObject({
      tripType: 'ROUND_TRIP',
      travelClass: 'ECONOMY',
      deepSearch: false,
    });
  });

  it('passes the SerpApi config through, including its absence', async () => {
    // Null is a first-class answer: an org with no plan gets `no-plan` rather than an
    // error, because travel has to work without a paid provider.
    getSerpApiConfig.mockResolvedValue(null);
    const db = makeDb();
    findFlightOptions.mockResolvedValue({
      options: [],
      found: 0,
      insight: null,
      reason: 'no-plan',
    });
    const out = await (await caller(db)).searchFlightOptions({ id: REQ });
    expect(findFlightOptions.mock.calls[0]?.[1]).toBeNull();
    expect(out.reason).toBe('no-plan');
  });

  it('does NOT apply the lodging cap unless asked', async () => {
    /**
     * A cap is a WARNING threshold on a quoted stay, not a hard filter. Using it as one
     * by default can hide every hotel in an expensive city, which reads as "no results"
     * rather than "everything here is over policy".
     */
    const db = makeDb();
    findStayOptions.mockResolvedValue({ options: [], found: 0, insight: null, reason: 'ok' });
    await (await caller(db)).searchStayOptions({
      id: REQ,
      checkIn: '2026-09-01',
      checkOut: '2026-09-04',
    });
    expect(findStayOptions.mock.calls[0]?.[3]?.capPerNightMinor).toBeNull();
  });

  it('refuses a search on a submitted request', async () => {
    // A search SPENDS. Doing it for a request nobody can edit spends a credit on an
    // answer that cannot be used.
    const db = makeDb();
    db.travelRequest.findUnique.mockResolvedValue(request({ status: 'SUBMITTED' }));
    await expect((await caller(db)).searchFlightOptions({ id: REQ })).rejects.toThrow(
      /no longer be edited/,
    );
    expect(findFlightOptions).not.toHaveBeenCalled();
  });

  it('refuses a search on somebody else’s request', async () => {
    const db = makeDb();
    db.travelRequest.findUnique.mockResolvedValue(request({ submitterId: U('3') }));
    await expect((await caller(db)).searchFlightOptions({ id: REQ })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(findFlightOptions).not.toHaveBeenCalled();
  });

  it('rejects a malformed date rather than paying to find out', async () => {
    const db = makeDb();
    await expect(
      (await caller(db)).searchStayOptions({
        id: REQ,
        checkIn: '2026-9-1',
        checkOut: '2026-09-04',
      }),
    ).rejects.toThrow();
    expect(findStayOptions).not.toHaveBeenCalled();
  });
});

describe('chooseLineOption', () => {
  const caller = (db: unknown) => callerFor(db, [P.travel.request.updateOwn]);
  const LINE_ID = U('9');
  const CANDIDATE_ID = U('a');

  /** A cached FLIGHT candidate: the option, the search that produced it, and the amount in
   *  both currencies — converted for the line, and as the provider quoted it. */
  const FLIGHT_CANDIDATE = {
    amountMinor: '50000',
    providerAmountMinor: '50000',
    providerCurrency: 'CAD',
    option: {
      priceMinor: '50000',
      currency: 'CAD',
      legs: [
        {
          from: 'YUL',
          to: 'YYZ',
          departsAt: '2026-09-01 08:05',
          arrivesAt: '2026-09-01 09:20',
          airline: 'Air Canada',
          flightNumber: 'AC 412',
          durationMinutes: 75,
        },
      ],
      stops: 0,
      airlines: ['Air Canada'],
      bookingToken: 'tok',
    },
    search: {
      fromLabel: 'Montréal',
      toLabel: 'Toronto',
      tripType: 'ONE_WAY',
      travelClass: 'BUSINESS',
      maxStops: null,
      outboundDate: '2026-09-01',
      returnDate: null,
      pricedAt: '2026-09-01',
    },
  };

  function chooseDb(
    over: { line?: Record<string, unknown>; candidate?: Record<string, unknown> | null } = {},
  ) {
    const db = makeDb();
    db.travelBudgetLine.findUnique.mockResolvedValue({
      id: LINE_ID,
      travelRequestId: REQ,
      categoryId: CAT,
      kind: 'AIRFARE',
      ...over.line,
    });
    getCandidate.mockResolvedValue(
      over.candidate === null ? null : { ...FLIGHT_CANDIDATE, ...over.candidate },
    );
    db.currency.findMany.mockResolvedValue([{ code: 'CAD' }]);
    return db;
  }
  const updated = (db: ReturnType<typeof makeDb>) =>
    db.travelBudgetLine.update.mock.calls[0]?.[0]?.data as Record<string, unknown>;

  /**
   * A provider response with fields missing, and the line it still has to produce.
   *
   * `buildChosenPayload` is one long chain of `??` fallbacks, and every one of them exists
   * because SerpApi's shape is not a contract we control. A response that drops `airlines`,
   * or returns a stay with no name, or an itinerary with no legs, must produce a VALID
   * payload the registry accepts — not a throw inside a mutation, and not a payload the
   * drawer then cannot read.
   *
   * Grouped here rather than spread through the cases above because the fallbacks are the
   * behaviour: what a pick does with a complete response is already covered.
   */
  describe('a sparse provider response', () => {
    it('builds an airfare payload from an itinerary with no legs at all', async () => {
      const db = chooseDb({
        candidate: { option: {}, search: { travelClass: 'ECONOMY', outboundDate: '2026-09-01' } },
      });
      await (await caller(db)).chooseLineOption({
        id: REQ,
        lineId: LINE_ID,
        candidateId: CANDIDATE_ID,
      });
      // An em dash for each end, rather than "undefined" or a throw — the route is
      // unknown, and saying so is better than pretending or failing.
      expect(updated(db).payload).toMatchObject({
        fromLabel: '—',
        toLabel: '—',
        legs: [],
        travelClass: 'ECONOMY',
      });
    });

    it('reads the route off the LEGS when the search did not name it', async () => {
      const db = chooseDb({
        candidate: {
          option: { legs: [{ from: 'YUL', to: 'CDG' }] },
          search: { outboundDate: '2026-09-01' },
        },
      });
      await (await caller(db)).chooseLineOption({
        id: REQ,
        lineId: LINE_ID,
        candidateId: CANDIDATE_ID,
      });
      expect(updated(db).payload).toMatchObject({ fromLabel: 'YUL', toLabel: 'CDG' });
    });

    it('defaults an unstated trip shape to ONE_WAY and the cabin to ECONOMY', async () => {
      /**
       * ONE_WAY is the safe default: it describes exactly the legs that came back. Guessing
       * ROUND_TRIP would put a return journey on a line that has no return leg.
       */
      const db = chooseDb({ candidate: { option: {}, search: {} } });
      await (await caller(db)).chooseLineOption({
        id: REQ,
        lineId: LINE_ID,
        candidateId: CANDIDATE_ID,
      });
      expect(updated(db).payload).toMatchObject({
        tripType: 'ONE_WAY',
        travelClass: 'ECONOMY',
      });
    });

    it('stores no booking token when the provider offered none', async () => {
      // Null rather than absent-and-undefined: the field is retained so a later phase can
      // offer "book this" without a second search, and a missing one has to read as
      // "cannot", not as "not looked at".
      const db = chooseDb({ candidate: { option: { legs: [] }, search: {} } });
      await (await caller(db)).chooseLineOption({
        id: REQ,
        lineId: LINE_ID,
        candidateId: CANDIDATE_ID,
      });
      expect(updated(db).payload).toMatchObject({ bookingToken: null, pricedAt: null });
    });

    it('builds a lodging payload from a stay with nothing but a price', async () => {
      const db = chooseDb({
        line: { kind: 'LODGING' },
        candidate: { option: {}, search: {} },
      });
      await (await caller(db)).chooseLineOption({
        id: REQ,
        lineId: LINE_ID,
        candidateId: CANDIDATE_ID,
      });
      expect(updated(db).payload).toMatchObject({
        // Zero nights, not NaN. The amount came from the provider either way, and a
        // nights-times-rate derivation must not be reachable from a missing number.
        nights: 0,
        propertyName: null,
        propertyToken: null,
        nightlyMinor: null,
        starClass: null,
        rating: null,
        city: null,
      });
    });

    it('keeps a lodging stay’s stars and rating when they ARE there', async () => {
      // The discriminating half: the nulls above have to be absence, not a broken read.
      const db = chooseDb({
        line: { kind: 'LODGING' },
        candidate: {
          option: { name: 'The Savoy', starClass: 5, rating: 8.9, nightlyMinor: '32000' },
          search: { nights: 3, city: 'London', checkIn: '2026-09-01', checkOut: '2026-09-04' },
        },
      });
      await (await caller(db)).chooseLineOption({
        id: REQ,
        lineId: LINE_ID,
        candidateId: CANDIDATE_ID,
      });
      expect(updated(db).payload).toMatchObject({
        propertyName: 'The Savoy',
        starClass: 5,
        rating: 8.9,
        nights: 3,
        city: 'London',
      });
    });

    it('ignores a non-numeric night count rather than storing it', async () => {
      const db = chooseDb({
        line: { kind: 'LODGING' },
        candidate: { option: {}, search: { nights: 'three' } },
      });
      await (await caller(db)).chooseLineOption({
        id: REQ,
        lineId: LINE_ID,
        candidateId: CANDIDATE_ID,
      });
      expect(updated(db).payload).toMatchObject({ nights: 0 });
    });
  });

  it('takes the amount from the CACHED candidate and marks the line QUOTE', async () => {
    const db = chooseDb();
    await (await caller(db)).chooseLineOption({
      id: REQ,
      lineId: LINE_ID,
      candidateId: CANDIDATE_ID,
    });
    expect(updated(db).amountMinor).toBe(50_000n);
    expect(updated(db).basis).toBe('QUOTE');
    // And the payload carries what the provider quoted before FX — the one thing the
    // dropped `TravelQuote` row held that the line did not.
    expect(updated(db).payload).toMatchObject({
      providerAmountMinor: '50000',
      providerCurrency: 'CAD',
    });
  });

  it('takes the CONVERTED figure the search cached, not the provider’s', async () => {
    /**
     * The conversion happens when the SEARCH runs, so the figure a traveller was shown is
     * the figure that lands. Converting at pick time instead would let an FX table that
     * moved in between silently restate the price they agreed to.
     */
    const db = chooseDb({
      candidate: { amountMinor: '67500', providerAmountMinor: '50000', providerCurrency: 'USD' },
    });
    await (await caller(db)).chooseLineOption({
      id: REQ,
      lineId: LINE_ID,
      candidateId: CANDIDATE_ID,
    });
    expect(updated(db).amountMinor).toBe(67_500n);
    expect(updated(db).payload).toMatchObject({ providerCurrency: 'USD' });
  });

  it('rebuilds the payload from the candidate, keeping the flight number and the cabin', async () => {
    /**
     * The flight number is the single most useful thing on the line months later — the
     * one field somebody can check against a boarding pass. The cabin comes from the
     * SEARCH half of the envelope: a `FlightOption` does not carry it, so a line built
     * from the option alone would lose that the fare was business class.
     */
    const db = chooseDb();
    await (await caller(db)).chooseLineOption({
      id: REQ,
      lineId: LINE_ID,
      candidateId: CANDIDATE_ID,
    });
    const payload = updated(db).payload as Record<string, unknown>;
    expect(payload.travelClass).toBe('BUSINESS');
    expect((payload.legs as { flightNumber: string }[])[0]?.flightNumber).toBe('AC 412');
  });

  it('leaves the traveller’s detail alone', async () => {
    /**
     * The case the `detail` repurpose was really for. Picking a flight used to overwrite
     * the line's detail with "YUL→LHR · AC 412"; that field now holds the answer to "why
     * this fare and not the cheaper one on the other carrier", which is exactly the
     * question the picker's summary cannot answer and the approver is asking. The route
     * and the flight numbers are in the payload, so nothing is lost by not restating them.
     */
    const db = chooseDb();
    await (await caller(db)).chooseLineOption({
      id: REQ,
      lineId: LINE_ID,
      candidateId: CANDIDATE_ID,
    });
    expect('detail' in updated(db)).toBe(false);
  });

  it('looks the candidate up UNDER this request, so a foreign id is not found', async () => {
    // The cache key includes the request id and the kind, which is what stops an id from
    // one request being redeemed against another.
    const db = chooseDb();
    await (await caller(db)).chooseLineOption({
      id: REQ,
      lineId: LINE_ID,
      candidateId: CANDIDATE_ID,
    });
    expect(getCandidate).toHaveBeenCalledWith(REQ, 'FLIGHT', CANDIDATE_ID);
  });

  it('refuses a line belonging to another request', async () => {
    const db = chooseDb({ line: { travelRequestId: U('8') } });
    await expect(
      (await caller(db)).chooseLineOption({ id: REQ, lineId: LINE_ID, candidateId: CANDIDATE_ID }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('asks for a STAY candidate on a lodging line, never a flight', async () => {
    /**
     * The kind is part of the cache key, so a flight id offered to a lodging line is simply
     * not found — the mismatch cannot produce an airfare payload in a block with no field
     * to read it.
     */
    const db = chooseDb({ line: { kind: 'LODGING' }, candidate: null });
    await expect(
      (await caller(db)).chooseLineOption({ id: REQ, lineId: LINE_ID, candidateId: CANDIDATE_ID }),
    ).rejects.toThrow(/no longer available|Search again/i);
    expect(getCandidate).toHaveBeenCalledWith(REQ, 'STAY', CANDIDATE_ID);
  });

  it('refuses a searched option on a line that cannot take one', async () => {
    const db = chooseDb({ line: { kind: 'DEPARTMENT_MEAL' } });
    await expect(
      (await caller(db)).chooseLineOption({ id: REQ, lineId: LINE_ID, candidateId: CANDIDATE_ID }),
    ).rejects.toThrow(/airfare or lodging/);
  });

  it('refuses on a submitted request', async () => {
    const db = chooseDb();
    db.travelRequest.findUnique.mockResolvedValue(request({ status: 'APPROVED' }));
    await expect(
      (await caller(db)).chooseLineOption({ id: REQ, lineId: LINE_ID, candidateId: CANDIDATE_ID }),
    ).rejects.toThrow(/no longer be edited/);
  });
});

// ── The policy gate ───────────────────────────────────────────────────────────

/**
 * The submit gate and the two procedures that feed it.
 *
 * `validateTravelRequest` is the real function against the fake db, not a mock: what these
 * cover is the ROUTER's decisions — who may run it, what a refusal looks like, and which
 * severities stop a submit — and stubbing the validator would leave exactly those
 * untested while looking thorough.
 */
describe('policy', () => {
  const LINE_ID = U('7');
  const VIOL = U('8');
  /** Somebody else. NOT `U('9')` — that is `ME`, and the first draft of these cases used
   *  it, so the two ownership refusals were asserting nothing. */
  const SOMEBODY_ELSE = U('b');
  /** `submitOwn` alongside `updateOwn`: the gate lives on submit. */
  const caller = (db: unknown) =>
    callerFor(db, [P.travel.request.updateOwn, P.travel.request.submitOwn]);

  /** A db whose policy tables return one enabled travel rule and one violation. */
  const policyDb = (
    over: { rules?: unknown[]; violation?: Record<string, unknown> | null; lines?: unknown[] } = {},
  ) => {
    const line = {
      id: LINE_ID,
      categoryId: CAT,
      kind: 'STANDARD',
      payload: {},
      amountMinor: 500_000n,
      basis: 'MANUAL',
      notes: null,
      category: { code: 'travelMeals' },
    };
    const db = makeDb({
      travelRequest: {
        findMany: stubFn(async () => [] as unknown[]),
        findUnique: stubFn(async () => request({ budgetLines: over.lines ?? [line] }) as unknown),
        findUniqueOrThrow: stubFn(
          async () => request({ budgetLines: over.lines ?? [line] }) as unknown,
        ),
        create: stubFn(async () => ({ id: REQ })),
        update: stubFn(async () => request()),
      },
      policyRule: { findMany: stubFn(async () => over.rules ?? []) },
      policyViolation: {
        findMany: stubFn(async () => [] as unknown[]),
        findUnique: stubFn(async () => (over.violation ?? null) as unknown),
        deleteMany: stubFn(async () => ({ count: 0 })),
        createMany: stubFn(async () => ({ count: 0 })),
        update: stubFn(async () => ({ id: 'viol-1' })),
      },
    });
    return db;
  };

  /** A rule that BLOCKS any line the traveller has not explained. */
  const DETAIL_RULE = {
    id: 'rule-detail',
    kindCode: 'TRAVEL_LINE_DETAIL_REQUIRED',
    scope: 'TRAVEL_REQUEST',
    severity: 'BLOCK',
    condition: null,
    params: { thresholdMinor: '0' },
    messageKey: 'travelLineDetailRequired',
    categoryId: null,
  };

  describe('validate', () => {
    it('runs the engine and reports the counts', async () => {
      const db = policyDb({ rules: [DETAIL_RULE] });
      const res = await (await caller(db)).validate({ id: REQ });
      expect(res.counts.block).toBe(1);
      expect(res.violations[0].message).toBe('travelLineDetailRequired');
    });

    it('says nothing when no travel rule is configured', async () => {
      // The default deployment. The gate has to be invisible there, or every existing
      // request becomes unsubmittable the day this ships.
      const db = policyDb();
      const res = await (await caller(db)).validate({ id: REQ });
      expect(res.violations).toEqual([]);
      expect(res.counts).toMatchObject({ block: 0, warning: 0, unjustifiedWarning: 0 });
    });

    it('404s somebody else’s request', async () => {
      const db = policyDb();
      (db.travelRequest.findUnique as ReturnType<typeof stubFn>).mockResolvedValue({
        submitterId: SOMEBODY_ELSE,
      });
      await expect((await caller(db)).validate({ id: REQ })).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    });

    it('404s a request that does not exist', async () => {
      const db = policyDb();
      (db.travelRequest.findUnique as ReturnType<typeof stubFn>).mockResolvedValue(null);
      await expect((await caller(db)).validate({ id: REQ })).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    });
  });

  describe('submit', () => {
    it('refuses while a BLOCK stands, and leaves the status alone', async () => {
      const db = policyDb({ rules: [DETAIL_RULE] });
      await expect((await caller(db)).submit({ id: REQ })).rejects.toMatchObject({
        code: 'PRECONDITION_FAILED',
      });
      // The gate runs BEFORE the status flip, which is the whole of it being a gate.
      expect(db.travelRequest.update).not.toHaveBeenCalled();
    });

    it('refuses on an unjustified WARNING too', async () => {
      /**
       * The branch a block-only gate would miss. A WARNING is allowed, but an
       * unjustified one blocks submit — that is what forces the traveller to write the
       * explanation the approver then reads.
       */
      const db = policyDb({ rules: [{ ...DETAIL_RULE, severity: 'WARNING' }] });
      await expect((await caller(db)).submit({ id: REQ })).rejects.toMatchObject({
        code: 'PRECONDITION_FAILED',
      });
      expect(db.travelRequest.update).not.toHaveBeenCalled();
    });

    it('carries the violation list on the refusal, so the drawer can name the blockers', async () => {
      // Rather than "something is wrong", which is what the previous budget gate said by
      // disabling a button with no sentence beside it.
      const db = policyDb({ rules: [DETAIL_RULE] });
      await expect((await caller(db)).submit({ id: REQ })).rejects.toMatchObject({
        cause: { counts: { block: 1 } },
      });
    });

    it('goes through once the line carries an explanation', async () => {
      const db = policyDb({
        rules: [DETAIL_RULE],
        lines: [
          {
            id: LINE_ID,
            categoryId: CAT,
            kind: 'STANDARD',
            payload: {},
            amountMinor: 500_000n,
            basis: 'MANUAL',
            notes: 'Team offsite, whole department',
            category: { code: 'travelMeals' },
          },
        ],
      });
      await expect((await caller(db)).submit({ id: REQ })).resolves.toBeTruthy();
      expect(db.travelRequest.update).toHaveBeenCalled();
    });
  });

  describe('justifyViolation', () => {
    const WARNING_VIOLATION = {
      id: VIOL,
      severity: 'WARNING',
      travelRequest: { id: REQ, submitterId: ME, status: 'DRAFT' },
    };

    it('stores a trimmed note', async () => {
      const db = policyDb({ violation: WARNING_VIOLATION });
      await (await caller(db)).justifyViolation({ violationId: VIOL, note: '  Redeye  ' });
      expect(
        (db.policyViolation.update as ReturnType<typeof stubFn>).mock.calls[0]?.[0]?.data,
      ).toMatchObject({ resolveNote: 'Redeye', resolvedBy: ME });
    });

    it('CLEARS the justification on a blank note', async () => {
      /**
       * Blank clears rather than cancels. An explanation the traveller no longer stands
       * behind must stop unblocking their submit — so the empty box has to reach the
       * server rather than being read as "never mind".
       */
      const db = policyDb({ violation: WARNING_VIOLATION });
      await (await caller(db)).justifyViolation({ violationId: VIOL, note: '   ' });
      expect(
        (db.policyViolation.update as ReturnType<typeof stubFn>).mock.calls[0]?.[0]?.data,
      ).toMatchObject({ resolveNote: null, resolvedAt: null, resolvedBy: null });
    });

    it('refuses a BLOCK, which must be fixed', async () => {
      const db = policyDb({
        violation: { ...WARNING_VIOLATION, severity: 'BLOCK' },
      });
      await expect(
        (await caller(db)).justifyViolation({ violationId: VIOL, note: 'because' }),
      ).rejects.toThrow(/must be fixed, not justified/);
    });

    it('refuses once the request is no longer editable', async () => {
      const db = policyDb({
        violation: {
          ...WARNING_VIOLATION,
          travelRequest: { id: REQ, submitterId: ME, status: 'SUBMITTED' },
        },
      });
      await expect(
        (await caller(db)).justifyViolation({ violationId: VIOL, note: 'because' }),
      ).rejects.toThrow(/no longer be edited/);
    });

    it('404s an EXPENSE violation, which belongs to the other procedure', async () => {
      // `travelRequest` is null on one. Without this check the travel router would be an
      // endpoint for justifying a warning on somebody's expense report.
      const db = policyDb({ violation: { id: VIOL, severity: 'WARNING', travelRequest: null } });
      await expect(
        (await caller(db)).justifyViolation({ violationId: VIOL, note: 'because' }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('404s somebody else’s violation', async () => {
      const db = policyDb({
        violation: {
          ...WARNING_VIOLATION,
          travelRequest: { id: REQ, submitterId: SOMEBODY_ELSE, status: 'DRAFT' },
        },
      });
      await expect(
        (await caller(db)).justifyViolation({ violationId: VIOL, note: 'because' }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('404s a violation that does not exist', async () => {
      const db = policyDb({ violation: null });
      await expect(
        (await caller(db)).justifyViolation({ violationId: VIOL, note: 'because' }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });
  });
});
