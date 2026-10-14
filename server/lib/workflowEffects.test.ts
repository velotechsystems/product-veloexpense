import { beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * VeloExpense (w4-00c-1): ExpenseOS's suite, on the port. The plumbing the tests follow:
 *   · the effects run inside the caller's transaction and are AWAITED, under a savepoint
 *     (see the module header) — so the two "fire-and-forget" cases are restated for that,
 *     marked, and `settle()` still drains whatever is left;
 *   · notifications are VeloExpense's service: an activity is `{ eventType }`, and its id
 *     comes back as a string;
 *   · the card-request case is skipped (d50).
 */

/**
 * The side-effects a workflow run emits — Notify and Action nodes.
 *
 * These are pass-through effects: the engine decides WHICH nodes fired, this executes them
 * outside the decision transaction, and the caller `void`s it. That shape is deliberate and
 * it sets what the tests have to hold:
 *
 *   · **Fire-and-forget cannot mean fire-and-crash.** The decision has already committed.
 *     An unresolvable target or a bad hook must not reject into a floating promise, which
 *     in Node is an unhandled rejection and, depending on the runtime, the process.
 *   · **The effects run against the instance's FROZEN graph**, not the workflow's current
 *     version. A node id from a run started last month means what it meant then — the
 *     definition may have been edited since.
 *   · **Nobody is notified about their own action.** The decider pressing approve does not
 *     need an email telling them the thing they just did happened.
 *   · **`setField` writes coalesce into one metadata patch** and merge rather than replace,
 *     because two Action nodes on one path would otherwise have the second erase the first.
 */

const h = vi.hoisted(() => ({
  instance: null as unknown,
  graphValid: true,
  users: [] as Array<{ id: string; managerId?: string | null }>,
  requesterId: 'req-1' as string | null,
  activities: [] as Array<Record<string, unknown>>,
  notified: [] as Array<{ activityId: string; recipients: string[] }>,
  audits: [] as Array<Record<string, unknown>>,
  reportRow: { metadata: null as unknown } as { metadata: unknown } | null,
  cardRow: { metadata: null as unknown } as { metadata: unknown } | null,
  reportUpdates: [] as Array<Record<string, unknown>>,
  cardUpdates: [] as Array<Record<string, unknown>>,
  notifyError: null as Error | null,
}));

vi.mock('@expenseos/approvals', () => ({
  graphSchema: {
    safeParse: (g: unknown) =>
      h.graphValid
        ? { success: true as const, data: g as { nodes: Array<{ id: string }> } }
        : { success: false as const, error: new Error('bad graph') },
  },
}));
vi.mock('@expenseos/approvals/engine', () => ({
  loadRequesterId: async () => h.requesterId,
}));
vi.mock('@expenseos/audit', () => ({
  auditActions: { workflow: { actionFired: 'workflow.action.fired' } },
  withAudit: async (_db: unknown, entry: Record<string, unknown>, fn: () => Promise<unknown>) => {
    h.audits.push(entry);
    return fn();
  },
}));
// VeloExpense: the notification service, on the caller's transaction.
vi.mock('@/lib/notifications/service', () => ({
  recordActivity: async (_db: unknown, entry: Record<string, unknown>) => {
    h.activities.push(entry);
    return `act-${h.activities.length}`;
  },
  notifyRecipients: async (_db: unknown, activityId: string, recipients: string[]) => {
    if (h.notifyError) throw h.notifyError;
    h.notified.push({ activityId, recipients });
  },
  reportPayload: () => ({ report: 'R' }),
}));
vi.mock('@/lib/db/prisma-pg-bridge', () => ({ queryRunnerOf: (db: unknown) => db }));

import { executeWorkflowEffects } from './workflowEffects';

const savepoints: string[] = [];
const db = {
  // VeloExpense: the savepoint around the fan-out.
  $executeRaw: async (strings: TemplateStringsArray) => {
    savepoints.push(strings.join('').trim());
    return 0;
  },
  approvalInstance: { findFirst: async () => h.instance },
  user: {
    findMany: async () => h.users,
    findUnique: async () => h.users[0] ?? null,
  },
  expenseReport: {
    findUnique: async () => h.reportRow,
    update: async (args: Record<string, unknown>) => {
      h.reportUpdates.push(args);
      return {};
    },
  },
  virtualCardRequest: {
    findUnique: async () => h.cardRow,
    update: async (args: Record<string, unknown>) => {
      h.cardUpdates.push(args);
      return {};
    },
  },
} as never;

/** The effects are a floating promise by design; drain the microtask queue. */
const settle = () => new Promise((r) => setImmediate(r));

const withGraph = (nodes: unknown[], effectiveGraph = true) => {
  h.instance = effectiveGraph
    ? { effectiveGraph: { nodes }, workflowVersion: { graph: { nodes: [] } } }
    : { effectiveGraph: null, workflowVersion: { graph: { nodes } } };
};

beforeEach(() => {
  h.instance = null;
  h.graphValid = true;
  h.users = [];
  h.requesterId = 'req-1';
  h.activities = [];
  h.notified = [];
  h.audits = [];
  h.reportRow = { metadata: null };
  h.cardRow = { metadata: null };
  h.reportUpdates = [];
  h.cardUpdates = [];
  h.notifyError = null;
  savepoints.length = 0;
});

describe('nothing to do', () => {
  it('returns without touching the database when no effect fired', async () => {
    /** The common case on every decision. A query per decision to learn there is nothing
     *  to do is a query per decision. */
    const spy = vi.fn(async () => h.instance);
    // A whole stub rather than a spread: `db` is cast to `never` for the real signature,
    // and `never` cannot be spread.
    executeWorkflowEffects({ approvalInstance: { findFirst: spy } } as never, {
      subjectType: 'EXPENSE_REPORT' as never,
      subjectId: 'r-1',
      effectNodeIds: [],
    });
    await settle();
    expect(spy).not.toHaveBeenCalled();
  });

  it('gives up quietly when the subject has no instance', async () => {
    h.instance = null;
    executeWorkflowEffects(db, {
      subjectType: 'EXPENSE_REPORT' as never,
      subjectId: 'r-1',
      effectNodeIds: ['n-1'],
    });
    await settle();
    expect(h.activities).toHaveLength(0);
  });

  it('gives up quietly on a graph that no longer parses', async () => {
    /** A graph edited into an invalid shape must not take down the fan-out for a decision
     *  that has already committed. */
    h.graphValid = false;
    withGraph([{ id: 'n-1', type: 'notify', target: { kind: 'requester' } }]);
    executeWorkflowEffects(db, {
      subjectType: 'EXPENSE_REPORT' as never,
      subjectId: 'r-1',
      effectNodeIds: ['n-1'],
    });
    await settle();
    expect(h.activities).toHaveLength(0);
  });

  it('ignores a fired node id the graph does not contain', async () => {
    withGraph([{ id: 'other', type: 'notify', target: { kind: 'requester' } }]);
    executeWorkflowEffects(db, {
      subjectType: 'EXPENSE_REPORT' as never,
      subjectId: 'r-1',
      effectNodeIds: ['n-missing'],
    });
    await settle();
    expect(h.activities).toHaveLength(0);
  });
});

describe('the graph it reads', () => {
  it('prefers the instance’s frozen graph over the workflow version', async () => {
    /**
     * A node id from a run started last month means what it meant THEN. Reading the live
     * version would apply an edited definition to a decision made under the old one.
     */
    h.instance = {
      effectiveGraph: {
        nodes: [{ id: 'n-1', type: 'notify', target: { kind: 'user', userId: 'frozen' } }],
      },
      workflowVersion: {
        graph: { nodes: [{ id: 'n-1', type: 'notify', target: { kind: 'user', userId: 'live' } }] },
      },
    };
    executeWorkflowEffects(db, {
      subjectType: 'EXPENSE_REPORT' as never,
      subjectId: 'r-1',
      effectNodeIds: ['n-1'],
    });
    await settle();
    expect(h.notified[0].recipients).toEqual(['frozen']);
  });

  it('falls back to the version’s graph when the instance froze none', async () => {
    withGraph([{ id: 'n-1', type: 'notify', target: { kind: 'user', userId: 'u-9' } }], false);
    executeWorkflowEffects(db, {
      subjectType: 'EXPENSE_REPORT' as never,
      subjectId: 'r-1',
      effectNodeIds: ['n-1'],
    });
    await settle();
    expect(h.notified[0].recipients).toEqual(['u-9']);
  });
});

describe('notify targets', () => {
  const fire = async (target: unknown, actorId?: string | null) => {
    withGraph([{ id: 'n-1', type: 'notify', target }]);
    executeWorkflowEffects(db, {
      subjectType: 'EXPENSE_REPORT' as never,
      subjectId: 'r-1',
      effectNodeIds: ['n-1'],
      actorId,
    });
    await settle();
  };

  it('notifies a named user', async () => {
    await fire({ kind: 'user', userId: 'u-1' });
    expect(h.notified[0].recipients).toEqual(['u-1']);
  });

  it('notifies everyone holding a role, skipping deleted accounts', async () => {
    /** A departed employee's row survives (audit pins it), so a role fan-out that ignored
     *  `deletedAt` would mail people who have left. */
    h.users = [{ id: 'u-1' }, { id: 'u-2' }];
    await fire({ kind: 'role', roleId: 'role-ap' });
    expect(h.notified[0].recipients).toEqual(['u-1', 'u-2']);
  });

  it('notifies the requester the engine resolves, whatever the subject is', async () => {
    h.requesterId = 'req-7';
    await fire({ kind: 'requester' });
    expect(h.notified[0].recipients).toEqual(['req-7']);
  });

  it('notifies the requester’s manager', async () => {
    h.requesterId = 'req-1';
    h.users = [{ id: 'req-1', managerId: 'mgr-1' }];
    await fire({ kind: 'manager' });
    expect(h.notified[0].recipients).toEqual(['mgr-1']);
  });

  it('says nothing when the requester has no manager', async () => {
    /** A CEO's report has nobody above them; a notify node aimed at "manager" is then a
     *  no-op rather than an error, because the workflow author's intent still holds. */
    h.requesterId = 'req-1';
    h.users = [{ id: 'req-1', managerId: null }];
    await fire({ kind: 'manager' });
    expect(h.notified).toHaveLength(0);
  });

  it('says nothing when there is no requester to anchor a manager lookup', async () => {
    h.requesterId = null;
    await fire({ kind: 'manager' });
    expect(h.notified).toHaveLength(0);
  });

  it('says nothing for a requester the engine cannot name', async () => {
    h.requesterId = null;
    await fire({ kind: 'requester' });
    expect(h.notified).toHaveLength(0);
  });

  it('never notifies the person who took the action', async () => {
    /** They pressed the button. An email telling them what they just did reads as a bug,
     *  and it is the fastest way to get a channel muted. */
    h.users = [{ id: 'u-1' }, { id: 'actor' }];
    await fire({ kind: 'role', roleId: 'role-ap' }, 'actor');
    expect(h.notified[0].recipients).toEqual(['u-1']);
  });

  it('records no activity at all when the only recipient was the actor', async () => {
    /** An activity row with nobody to tell is a timeline entry saying a notification was
     *  sent when none was. */
    h.users = [{ id: 'actor' }];
    await fire({ kind: 'role', roleId: 'role-ap' }, 'actor');
    expect(h.activities).toHaveLength(0);
  });

  it('attributes the activity to the actor, so the timeline says who caused it', async () => {
    await fire({ kind: 'user', userId: 'u-1' }, 'actor');
    expect(h.activities[0]).toMatchObject({
      subjectType: 'EXPENSE_REPORT',
      subjectId: 'r-1',
      // VeloExpense: the service's field is `eventType`.
      eventType: 'NOTIFY',
      actorId: 'actor',
    });
  });

  it('records a null actor for an effect nobody triggered', async () => {
    await fire({ kind: 'user', userId: 'u-1' });
    expect(h.activities[0]).toMatchObject({ actorId: null });
  });
});

describe('action nodes', () => {
  const fireActions = async (actions: unknown[], subjectType = 'EXPENSE_REPORT') => {
    withGraph([{ id: 'n-1', type: 'action', actions }]);
    executeWorkflowEffects(db, {
      subjectType: subjectType as never,
      subjectId: 'r-1',
      effectNodeIds: ['n-1'],
      actorId: 'actor',
    });
    await settle();
  };

  it('writes a setField into the subject’s metadata', async () => {
    await fireActions([{ kind: 'setField', key: 'flagged', value: true }]);
    expect(h.reportUpdates[0]).toMatchObject({
      where: { id: 'r-1' },
      data: { metadata: { flagged: true } },
    });
  });

  it('merges into existing metadata rather than replacing it', async () => {
    /** The column is a shared map. A replace would silently drop whatever another node —
     *  or another feature — had written. */
    h.reportRow = { metadata: { existing: 'keep' } };
    await fireActions([{ kind: 'setField', key: 'flagged', value: true }]);
    expect((h.reportUpdates[0] as { data: { metadata: unknown } }).data.metadata).toEqual({
      existing: 'keep',
      flagged: true,
    });
  });

  it('coalesces every setField in the run into one write', async () => {
    /** Two Action nodes on one path, written one at a time, is a read-modify-write race
     *  against itself: the second read predates the first write. */
    withGraph([
      { id: 'n-1', type: 'action', actions: [{ kind: 'setField', key: 'a', value: '1' }] },
      { id: 'n-2', type: 'action', actions: [{ kind: 'setField', key: 'b', value: '2' }] },
    ]);
    executeWorkflowEffects(db, {
      subjectType: 'EXPENSE_REPORT' as never,
      subjectId: 'r-1',
      effectNodeIds: ['n-1', 'n-2'],
    });
    await settle();
    expect(h.reportUpdates).toHaveLength(1);
    expect((h.reportUpdates[0] as { data: { metadata: unknown } }).data.metadata).toEqual({
      a: '1',
      b: '2',
    });
  });

  it('tolerates metadata that is not an object', async () => {
    // A column written by hand, or by an older shape. Spreading a string would produce
    // numeric keys; the guard is what keeps the patch clean.
    h.reportRow = { metadata: 'not-an-object' };
    await fireActions([{ kind: 'setField', key: 'flagged', value: true }]);
    expect((h.reportUpdates[0] as { data: { metadata: unknown } }).data.metadata).toEqual({
      flagged: true,
    });
  });

  // VeloExpense: no card-request subject (d50).
  it.skip('writes card-request metadata on a card-request subject', async () => {
    await fireActions([{ kind: 'setField', key: 'flagged', value: true }], 'VIRTUAL_CARD_REQUEST');
    expect(h.cardUpdates).toHaveLength(1);
    expect(h.reportUpdates).toHaveLength(0);
  });

  it('writes nothing for a subject type with no metadata column', async () => {
    /** A travel request has no map to patch. Silently skipping beats throwing inside a
     *  floating promise. */
    await fireActions([{ kind: 'setField', key: 'flagged', value: true }], 'TRAVEL_REQUEST');
    expect(h.reportUpdates).toHaveLength(0);
    expect(h.cardUpdates).toHaveLength(0);
  });

  it('writes nothing when the subject has since been deleted', async () => {
    h.reportRow = null;
    await fireActions([{ kind: 'setField', key: 'flagged', value: true }]);
    expect(h.reportUpdates).toHaveLength(0);
  });

  it('runs a registered integration hook, audited to the engine', async () => {
    /** The actor is the system — the engine fired it — with the deciding user in the
     *  details, because claiming the decider performed the integration would be false. */
    await fireActions([{ kind: 'integration', hook: 'audit.log' }]);
    expect(h.audits[0]).toMatchObject({
      action: 'workflow.action.fired',
      entityType: 'EXPENSE_REPORT',
      entityId: 'r-1',
      actor: { kind: 'system', jobName: 'workflow.action' },
    });
    expect(h.audits[0].details).toMatchObject({
      hook: 'audit.log',
      nodeId: 'n-1',
      triggeredBy: 'actor',
    });
  });

  it('logs and moves on for a hook nobody registered', async () => {
    /** A workflow authored against a hook that has not shipped yet — or was removed — must
     *  not break the rest of the run. */
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await fireActions([
      { kind: 'integration', hook: 'netsuite.postOnApproval' },
      { kind: 'setField', key: 'flagged', value: true },
    ]);
    expect(String(warn.mock.calls[0]?.[0])).toContain('unknown action hook');
    expect(h.reportUpdates).toHaveLength(1);
    warn.mockRestore();
  });
});

describe('failure is contained', () => {
  // VeloExpense: awaited, so the failure is held to "resolves, and rolls back to the
  // savepoint" rather than "never rejects a floating promise".
  it('swallows a fan-out failure instead of rejecting into a floating promise', async () => {
    /**
     * The caller `void`s this after the decision commits. An unhandled rejection here is
     * a process-level event for a notification that did not send — the decision itself is
     * already safe on disk.
     */
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    h.notifyError = new Error('notifications down');
    withGraph([{ id: 'n-1', type: 'notify', target: { kind: 'user', userId: 'u-1' } }]);
    await expect(
      executeWorkflowEffects(db, {
        subjectType: 'EXPENSE_REPORT' as never,
        subjectId: 'r-1',
        effectNodeIds: ['n-1'],
      }),
    ).resolves.toBeUndefined();
    await settle();
    expect(String(warn.mock.calls.at(-1)?.[0])).toContain('effect execution failed');
    expect(savepoints).toEqual(['SAVEPOINT workflow_effects', 'ROLLBACK TO SAVEPOINT workflow_effects']);
    warn.mockRestore();
  });

  // VeloExpense: the opposite by design — the caller awaits it, inside its transaction.
  it.skip('returns synchronously — the caller never waits on it', async () => {});

  it('runs inside the caller’s transaction, under a savepoint it releases (VeloExpense)', async () => {
    withGraph([{ id: 'n-1', type: 'notify', target: { kind: 'user', userId: 'u-1' } }]);
    await executeWorkflowEffects(db, {
      subjectType: 'EXPENSE_REPORT' as never,
      subjectId: 'r-1',
      effectNodeIds: ['n-1'],
    });
    // Already done when the await returns: no settling needed.
    expect(h.notified[0].recipients).toEqual(['u-1']);
    expect(savepoints).toEqual(['SAVEPOINT workflow_effects', 'RELEASE SAVEPOINT workflow_effects']);
  });
});
