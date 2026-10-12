// @vitest-environment node
import { permissions as P } from '@expenseos/rbac';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { stubFn } from '@/test-utils/stubFn';
import { makeContext } from '../__test-helpers__/trpcCaller';

/**
 * The approval-workflow builder — draft/publish versioning over a routing graph.
 *
 * The versioning is the whole design, and three rules hold it together:
 *
 *   · **There is at most one DRAFT per workflow.** Saving twice edits the same draft
 *     rather than stacking a second one; two drafts and nothing says which publishes.
 *   · **Publishing archives the version it replaces.** A workflow keeps exactly one
 *     PUBLISHED version, so an instance started yesterday can still be read against
 *     the graph it actually ran on.
 *   · **A graph is validated BEFORE it is persisted.** A structurally broken graph
 *     saved as a draft is a landmine — it publishes fine and then fails when the first
 *     report hits it, with the failure surfacing as a stuck approval rather than as a
 *     builder error.
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

const validateGraph = stubFn(() => [] as { message: string }[]);
const simulateWorkflow = stubFn(async () => ({ steps: [] }));
vi.mock('@expenseos/approvals', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@expenseos/approvals');
  return { ...actual, validateGraph };
});
vi.mock('@expenseos/approvals/engine', () => ({ simulateWorkflow }));

const U = (n: string) => `00000000-0000-7000-8000-00000000000${n}`;
const ME = U('9');
const WF = U('1');

/**
 * The smallest graph `graphSchema` accepts: a `start` wired to an `approved` terminal.
 * Node types are a discriminated union — there is no `end`, the terminals are
 * `approved` / `rejected` — and an edge carries `id` / `source` / `target`, not
 * `from` / `to`.
 */
const GRAPH = {
  nodes: [
    { id: 'start', type: 'start' as const },
    { id: 'approved', type: 'approved' as const },
  ],
  edges: [{ id: 'e1', source: 'start', target: 'approved' }],
};

/** The unconditional predicate — "this workflow governs every subject of its type".
 *  `matchCondition` is a predicate object, never null. */
const MATCH_ALL = { always: true } as const;

const workflow = (over: Record<string, unknown> = {}) => ({
  id: WF,
  key: 'vcc-default',
  name: 'Card requests',
  description: null,
  subjectType: 'VIRTUAL_CARD_REQUEST',
  isDefault: true,
  priority: 0,
  active: true,
  currentVersionId: null,
  versions: [] as unknown[],
  ...over,
});

function makeDb(over: Record<string, unknown> = {}) {
  const db = makeDbRaw(over);
  db.approvalWorkflow.findFirst.mockImplementation(async (...a: unknown[]) =>
    (db.approvalWorkflow.findUnique as (...x: unknown[]) => Promise<unknown>)(...a),
  );
  return db;
}

function makeDbRaw(over: Record<string, unknown> = {}) {
  return {
    approvalWorkflow: {
      findMany: stubFn(async () => [] as unknown[]),
      findUnique: stubFn(async () => null as unknown),
      // VeloExpense: the key is unique within the tenant, so `create` looks it up with
      // `findFirst` (RLS-scoped). The fake answers both from the same mock.
      findFirst: stubFn(async () => null as unknown),
      create: stubFn(async () => ({ id: WF })),
      update: stubFn(async () => ({ id: WF })),
    },
    approvalWorkflowVersion: {
      findFirst: stubFn(async () => null as unknown),
      findUnique: stubFn(async () => null as unknown),
      create: stubFn(async () => ({ id: 'v1', version: 1, status: 'DRAFT' })),
      update: stubFn(async () => ({ id: 'v1', version: 1, status: 'DRAFT' })),
      aggregate: stubFn(async () => ({ _max: { version: null as number | null } })),
    },
    role: { findMany: stubFn(async () => [] as unknown[]) },
    user: { findMany: stubFn(async () => [] as unknown[]) },
    jobLevel: { findMany: stubFn(async () => [] as unknown[]) },
    businessUnit: { findMany: stubFn(async () => [] as unknown[]) },
    department: { findMany: stubFn(async () => [] as unknown[]) },
    legalEntity: { findMany: stubFn(async () => [] as unknown[]) },
    expenseCategory: { findMany: stubFn(async () => [] as unknown[]) },
    currency: { findMany: stubFn(async () => [] as unknown[]) },
    $transaction: vi.fn(async (ops: unknown) =>
      Array.isArray(ops) ? ops : (ops as (tx: unknown) => unknown)(undefined),
    ),
    ...over,
  };
}

async function callerFor(db: unknown, permissions: readonly string[]) {
  const { createCallerFactory } = await import('@/server/trpc');
  const { approvalWorkflowsRouter } = await import('./approvalWorkflows');
  return createCallerFactory(approvalWorkflowsRouter)(
    makeContext({ db, userId: ME, permissions, roleLabel: 'Admin' }),
  );
}

const VIEW = [P.admin.approvalWorkflow.view] as const;
const MANAGE = [P.admin.approvalWorkflow.manage] as const;

beforeEach(() => {
  vi.clearAllMocks();
  withAuditCalls.length = 0;
  validateGraph.mockReturnValue([]);
});

describe('permission gates', () => {
  it('separates viewing from managing', async () => {
    const db = makeDb();
    const viewer = await callerFor(db, VIEW);
    await expect(viewer.list()).resolves.toBeTruthy();
    await expect(viewer.options()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(viewer.create({ key: 'new-wf', name: 'New' } as never)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(viewer.publish({ workflowId: WF })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('refuses a caller with nothing', async () => {
    const c = await callerFor(makeDb(), []);
    await expect(c.list()).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('list', () => {
  it('orders by subject, then defaults last, then priority', async () => {
    /**
     * The order IS the routing precedence the engine walks — the default has to sort
     * last so a specific workflow wins, and higher priority first within a subject.
     */
    const db = makeDb();
    const c = await callerFor(db, VIEW);
    await c.list();
    expect(db.approvalWorkflow.findMany.mock.calls[0]?.[0]?.orderBy).toEqual([
      { subjectType: 'asc' },
      { isDefault: 'asc' },
      { priority: 'desc' },
    ]);
  });

  it('lists versions newest first', async () => {
    const db = makeDb();
    const c = await callerFor(db, VIEW);
    await c.list();
    const select = db.approvalWorkflow.findMany.mock.calls[0]?.[0]?.select as {
      versions: { orderBy: unknown };
    };
    expect(select.versions.orderBy).toEqual({ version: 'desc' });
  });
});

describe('get', () => {
  it('404s a workflow that does not exist', async () => {
    const db = makeDb();
    const c = await callerFor(db, VIEW);
    await expect(c.get({ id: WF })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('separates the editable draft from the live version', async () => {
    /**
     * The builder edits the draft while the engine runs the published one, so the two
     * have to arrive distinguished — conflating them is how an unpublished edit starts
     * routing real reports.
     */
    const db = makeDb();
    db.approvalWorkflow.findUnique.mockResolvedValue(
      workflow({
        currentVersionId: 'v1',
        versions: [
          { id: 'v2', version: 2, status: 'DRAFT' },
          { id: 'v1', version: 1, status: 'PUBLISHED' },
        ],
      }),
    );
    const c = await callerFor(db, VIEW);
    const out = await c.get({ id: WF });
    expect(out.draft).toMatchObject({ id: 'v2', status: 'DRAFT' });
    expect(out.published).toMatchObject({ id: 'v1', status: 'PUBLISHED' });
  });

  it('reports no draft when there is none', async () => {
    const db = makeDb();
    db.approvalWorkflow.findUnique.mockResolvedValue(
      workflow({
        currentVersionId: 'v1',
        versions: [{ id: 'v1', version: 1, status: 'PUBLISHED' }],
      }),
    );
    const c = await callerFor(db, VIEW);
    expect((await c.get({ id: WF })).draft).toBeNull();
  });

  it('reports no published version for a never-published workflow', async () => {
    const db = makeDb();
    db.approvalWorkflow.findUnique.mockResolvedValue(
      workflow({ versions: [{ id: 'v1', version: 1, status: 'DRAFT' }] }),
    );
    const c = await callerFor(db, VIEW);
    const out = await c.get({ id: WF });
    expect(out.published).toBeNull();
    expect(out.draft).toMatchObject({ id: 'v1' });
  });

  it('reports null when the current version id points at nothing', async () => {
    // A dangling pointer must not throw the builder.
    const db = makeDb();
    db.approvalWorkflow.findUnique.mockResolvedValue(
      workflow({ currentVersionId: 'gone', versions: [] }),
    );
    const c = await callerFor(db, VIEW);
    expect((await c.get({ id: WF })).published).toBeNull();
  });
});

describe('create', () => {
  it('refuses a key already in use', async () => {
    // The key is how a workflow is referenced; a duplicate makes routing ambiguous.
    const db = makeDb();
    db.approvalWorkflow.findUnique.mockResolvedValue({ id: U('4') });
    const c = await callerFor(db, MANAGE);
    await expect(c.create({ key: 'vcc-default', name: 'Dupe' } as never)).rejects.toThrow(
      /already in use/,
    );
    expect(db.approvalWorkflow.create).not.toHaveBeenCalled();
  });

  it('creates with sensible defaults', async () => {
    const db = makeDb();
    const c = await callerFor(db, MANAGE);
    await c.create({ key: 'new-wf', name: 'New workflow' } as never);
    expect(db.approvalWorkflow.create.mock.calls[0]?.[0]?.data).toMatchObject({
      key: 'new-wf',
      // VeloExpense: EXPENSE_REPORT is the default (ExpenseOS: VIRTUAL_CARD_REQUEST).
      subjectType: 'EXPENSE_REPORT',
      priority: 0,
      isDefault: false,
    });
  });

  it('constrains the key to a slug', async () => {
    /**
     * The key appears in URLs and in seed data, so spaces and capitals would make the
     * same workflow reachable under several spellings.
     */
    const c = await callerFor(makeDb(), MANAGE);
    for (const key of ['Has Capitals', 'has spaces', 'has_underscore', 'a', 'x'.repeat(65)]) {
      await expect(c.create({ key, name: 'X' } as never), key).rejects.toThrow();
    }
  });

  it('bounds the priority', async () => {
    const c = await callerFor(makeDb(), MANAGE);
    await expect(c.create({ key: 'new-wf', name: 'X', priority: 1001 } as never)).rejects.toThrow();
    await expect(c.create({ key: 'new-wf', name: 'X', priority: -1 } as never)).rejects.toThrow();
  });
});

describe('reorder', () => {
  it('turns list position into descending priority', async () => {
    /**
     * The builder hands back the order the admin dragged things into; priority is
     * derived from it so the top of the list is the highest priority. Deriving it the
     * other way round silently inverts every routing decision.
     */
    const db = makeDb();
    const c = await callerFor(db, MANAGE);
    await c.reorder({ ids: [U('1'), U('2'), U('3')] });
    const priorities = db.approvalWorkflow.update.mock.calls.map(
      (call) => (call[0] as { data: { priority: number } }).data.priority,
    );
    expect(priorities).toEqual([3, 2, 1]);
  });

  it('writes them in one transaction', async () => {
    // A partial reorder leaves two workflows at the same priority.
    const db = makeDb();
    const c = await callerFor(db, MANAGE);
    await c.reorder({ ids: [U('1'), U('2')] });
    expect(db.$transaction).toHaveBeenCalledOnce();
  });

  it('requires at least one id', async () => {
    const c = await callerFor(makeDb(), MANAGE);
    await expect(c.reorder({ ids: [] })).rejects.toThrow();
  });
});

describe('saveDraft', () => {
  const save = (db: unknown) =>
    callerFor(db, MANAGE).then((c) =>
      c.saveDraft({ workflowId: WF, graph: GRAPH, matchCondition: MATCH_ALL } as never),
    );

  it('refuses a structurally invalid graph before persisting anything', async () => {
    /**
     * A broken graph saved as a draft is a landmine: it publishes fine and then fails
     * when the first report hits it, surfacing as a stuck approval rather than as a
     * builder error.
     */
    validateGraph.mockReturnValue([{ message: 'start node has no outgoing edge' }]);
    const db = makeDb();
    await expect(save(db)).rejects.toThrow(/Invalid workflow graph/);
    expect(db.approvalWorkflowVersion.create).not.toHaveBeenCalled();
    expect(db.approvalWorkflowVersion.update).not.toHaveBeenCalled();
  });

  it('names every problem it found', async () => {
    // One error at a time makes fixing a graph a guessing game.
    validateGraph.mockReturnValue([{ message: 'no start' }, { message: 'orphan node' }]);
    const db = makeDb();
    await expect(save(db)).rejects.toThrow(/no start; orphan node/);
  });

  it('creates the first draft at version 1', async () => {
    const db = makeDb();
    await save(db);
    expect(db.approvalWorkflowVersion.create.mock.calls[0]?.[0]?.data).toMatchObject({
      version: 1,
      status: 'DRAFT',
    });
  });

  it('numbers a new draft after the highest existing version', async () => {
    // Versions are the audit trail for what an instance ran on, so they never reuse.
    const db = makeDb();
    db.approvalWorkflowVersion.aggregate.mockResolvedValue({ _max: { version: 4 } });
    await save(db);
    expect(db.approvalWorkflowVersion.create.mock.calls[0]?.[0]?.data).toMatchObject({
      version: 5,
    });
  });

  it('edits the existing draft rather than stacking a second one', async () => {
    /**
     * At most one DRAFT per workflow. Two drafts and nothing says which one publishes.
     */
    const db = makeDb();
    db.approvalWorkflowVersion.findFirst.mockResolvedValue({ id: 'v2' });
    await save(db);
    expect(db.approvalWorkflowVersion.update).toHaveBeenCalledOnce();
    expect(db.approvalWorkflowVersion.create).not.toHaveBeenCalled();
  });

  it('looks for the draft by status, not by being newest', async () => {
    const db = makeDb();
    await save(db);
    expect(db.approvalWorkflowVersion.findFirst.mock.calls[0]?.[0]?.where).toEqual({
      workflowId: WF,
      status: 'DRAFT',
    });
  });
});

describe('publish', () => {
  it('refuses when there is no draft', async () => {
    // Publishing nothing would archive the live version and leave the workflow with
    // no published graph at all.
    const db = makeDb();
    const c = await callerFor(db, MANAGE);
    await expect(c.publish({ workflowId: WF })).rejects.toThrow(/No draft to publish/);
  });

  it('re-validates the stored graph rather than trusting the draft', async () => {
    /**
     * `saveDraft` validated it, but a draft can be months old and the node schema can
     * have moved under it. Re-checking at publish is the difference between a builder
     * error and a stuck approval on the first report that hits it.
     */
    validateGraph.mockReturnValue([{ message: 'orphan node' }]);
    const db = makeDb();
    db.approvalWorkflowVersion.findFirst.mockResolvedValue({ id: 'v1', version: 1, graph: GRAPH });
    db.approvalWorkflow.findUnique.mockResolvedValue({ currentVersionId: null });
    const c = await callerFor(db, MANAGE);
    await expect(c.publish({ workflowId: WF })).rejects.toThrow(/Invalid workflow graph/);
    expect(db.approvalWorkflowVersion.update).not.toHaveBeenCalled();
  });

  it('archives the version it replaces', async () => {
    /**
     * Exactly one PUBLISHED version per workflow — the previous one becomes ARCHIVED
     * rather than being deleted, so an instance started yesterday can still be read
     * against the graph it actually ran on.
     */
    const db = makeDb();
    db.approvalWorkflowVersion.findFirst.mockResolvedValue({ id: 'v2', version: 2, graph: GRAPH });
    db.approvalWorkflow.findUnique.mockResolvedValue({ currentVersionId: 'v1' });
    const c = await callerFor(db, MANAGE);
    await c.publish({ workflowId: WF });
    const archived = db.approvalWorkflowVersion.update.mock.calls.find(
      (call) => (call[0] as { data: { status?: string } }).data.status === 'ARCHIVED',
    );
    expect(archived).toBeTruthy();
  });

  it('archives nothing on a first publish', async () => {
    const db = makeDb();
    db.approvalWorkflowVersion.findFirst.mockResolvedValue({ id: 'v1', version: 1, graph: GRAPH });
    db.approvalWorkflow.findUnique.mockResolvedValue({ currentVersionId: null });
    const c = await callerFor(db, MANAGE);
    await c.publish({ workflowId: WF });
    const archived = db.approvalWorkflowVersion.update.mock.calls.filter(
      (call) => (call[0] as { data: { status?: string } }).data.status === 'ARCHIVED',
    );
    expect(archived).toHaveLength(0);
  });

  it('stamps who published it and when', async () => {
    // The publish is the moment the graph starts binding real approvals.
    const db = makeDb();
    db.approvalWorkflowVersion.findFirst.mockResolvedValue({ id: 'v1', version: 1, graph: GRAPH });
    db.approvalWorkflow.findUnique.mockResolvedValue({ currentVersionId: null });
    const c = await callerFor(db, MANAGE);
    await c.publish({ workflowId: WF });
    const published = db.approvalWorkflowVersion.update.mock.calls.find(
      (call) => (call[0] as { data: { status?: string } }).data.status === 'PUBLISHED',
    )?.[0] as { data: { publishedAt: Date; publishedBy: string } };
    expect(published.data.publishedAt).toBeInstanceOf(Date);
    expect(published.data.publishedBy).toBe(ME);
  });
});

describe('setMeta', () => {
  it('patches only what arrived', async () => {
    const db = makeDb();
    const c = await callerFor(db, MANAGE);
    await c.setMeta({ id: WF, name: 'Renamed' } as never);
    const data = db.approvalWorkflow.update.mock.calls[0]?.[0]?.data as Record<string, unknown>;
    expect(data.name).toBe('Renamed');
    expect(data).not.toHaveProperty('priority');
  });

  it('bounds the priority here too', async () => {
    const c = await callerFor(makeDb(), MANAGE);
    await expect(c.setMeta({ id: WF, priority: 1001 } as never)).rejects.toThrow();
  });
});

describe('simulate', () => {
  /**
   * "Which workflow would this pick, and who would it ask?" — the whole reason an admin
   * can build a routing graph without a real request to test it on.
   *
   * The procedure itself is a translation layer, and translation layers fail quietly: the
   * engine's fact set is uniformly nullable, the form's is uniformly optional, and a fact
   * that arrives as `undefined` instead of `null` reads to the engine as "no such fact"
   * rather than "not stated" on some predicates. So both directions are pinned — every
   * field carried through, and every field absent — rather than one happy path.
   */
  const FACTS = [
    'amount',
    'currency',
    'departmentId',
    'jobLevelId',
    'legalEntityId',
    'businessUnitId',
    'requiresApproval',
    'hasPolicyViolation',
    'overPerDiem',
    'lineCount',
    'maxLineAmount',
    'perDiemOverageMinor',
    'overBudget',
    'budgetOverageMinor',
  ];

  it('states every fact the form did not fill as null, never as missing', async () => {
    const c = await callerFor(makeDb(), MANAGE);
    await c.simulate({});
    const [, subjectType, facts] = simulateWorkflow.mock.calls[0] as [
      unknown,
      string,
      Record<string, unknown>,
    ];
    // The default subject is the one the module shipped first, so the panel opens on
    // something rather than on an empty simulation.
    // VeloExpense: EXPENSE_REPORT (ExpenseOS: VIRTUAL_CARD_REQUEST, not a subject here).
    expect(subjectType).toBe('EXPENSE_REPORT');
    for (const key of FACTS) expect(facts[key], key).toBeNull();
    // The one exception, and it has to be: a predicate over categories asks whether a
    // category is in the set, and `null` is not a set.
    expect(facts.categoryIds).toEqual([]);
  });

  it('carries every fact the form did fill', async () => {
    const c = await callerFor(makeDb(), MANAGE);
    await c.simulate({
      subjectType: 'EXPENSE_REPORT',
      amount: 250_000,
      // VeloExpense: a currency is its ISO code.
      currencyId: 'CAD',
      departmentId: U('3'),
      jobLevelId: U('4'),
      legalEntityId: U('5'),
      businessUnitId: U('6'),
      categoryIds: [U('7')],
      requiresApproval: 'true',
      hasPolicyViolation: 'false',
      overPerDiem: 'true',
      lineCount: 12,
      maxLineAmount: 90_000,
      perDiemOverageMinor: 1500,
      overBudget: 'true',
      budgetOverageMinor: 4000,
    } as never);
    const [, subjectType, facts] = simulateWorkflow.mock.calls[0] as [
      unknown,
      string,
      Record<string, unknown>,
    ];
    expect(subjectType).toBe('EXPENSE_REPORT');
    expect(facts).toEqual({
      amount: 250_000,
      // Renamed on the way through: the form knows it as a currency id, the engine's
      // fact is just `currency`.
      currency: 'CAD',
      departmentId: U('3'),
      jobLevelId: U('4'),
      legalEntityId: U('5'),
      businessUnitId: U('6'),
      categoryIds: [U('7')],
      // Booleans as strings, matching how the engine emits them — a real boolean here
      // would never equal the graph's stored comparison value.
      requiresApproval: 'true',
      hasPolicyViolation: 'false',
      overPerDiem: 'true',
      lineCount: 12,
      maxLineAmount: 90_000,
      perDiemOverageMinor: 1500,
      overBudget: 'true',
      budgetOverageMinor: 4000,
    });
  });

  it('is a manager’s tool, not a viewer’s', async () => {
    /** It reveals who would be asked to approve what — an org chart by another route. */
    const c = await callerFor(makeDb(), VIEW);
    await expect(c.simulate({})).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('refuses a negative amount and a fractional line count', async () => {
    const c = await callerFor(makeDb(), MANAGE);
    await expect(c.simulate({ amount: -1 })).rejects.toThrow();
    await expect(c.simulate({ lineCount: 1.5 })).rejects.toThrow();
  });
});
