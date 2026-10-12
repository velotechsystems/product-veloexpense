import { describe, expect, it, vi } from 'vitest';
import { taskRecipientIds } from './notify';

/**
 * Who gets told about a newly-parked approval task.
 *
 * The interesting case is the UNASSIGNED one, because "unassigned" now covers two
 * different pools and used to cover only one. A `filter` approver's pool has always
 * been notified. A relative approver that resolved to nobody was notified to NOBODY
 * — and once a node can name a role as its no-manager fallback, that silence would
 * be most of the way back to the dead end the fallback exists to close: the task is
 * claimable by the role, and the role never hears about it.
 *
 * Stubbed rather than db-backed on purpose — the question here is which branch runs
 * and what `where` it builds, and a real Postgres would answer that no better while
 * making the file serial.
 */

// VeloExpense: a system role VeloExpense's roles stand for (ExpenseOS's test uses the retired
// Manager role's id, which no VeloExpense role maps to).
const ROLE = '019e3000-0000-7000-8000-000000000001';

function dbWith(node: unknown, assigneeUserId: string | null = null) {
  // Typed with its argument so the assertions below can read the `where` it was built
  // with — a zero-arg mock records the call but types `calls[0]` as an empty tuple.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- VeloExpense: ExpenseOS's typed mock (Biome allows it).
  const findMany = vi.fn(async (_args: { where?: Record<string, unknown> }) => [
    { id: 'holder-1' },
    { id: 'holder-2' },
  ]);
  return {
    db: {
      approvalTask: {
        findUnique: vi.fn(async () => ({
          assigneeUserId,
          nodeId: 'n1',
          instance: {
            effectiveGraph: {
              nodes: [{ id: 'start', type: 'start' }, node, { id: 'ok', type: 'approved' }],
              edges: [
                { id: 'e1', source: 'start', target: 'n1' },
                { id: 'e2', source: 'n1', target: 'ok' },
              ],
            },
            workflowVersion: { graph: null },
          },
        })),
      },
      user: { findMany },
      jobLevel: { findUnique: vi.fn(async () => ({ sortOrder: 0 })) },
      // Hand-rolled stub, not a PrismaClient — the module only touches these three.
    } as never,
    findMany,
  };
}

describe('approval task recipients', () => {
  it('notifies the active holders of a role fallback', async () => {
    const { db, findMany } = dbWith({
      id: 'n1',
      type: 'approval',
      approver: { kind: 'manager', fallback: { kind: 'role', roleId: ROLE } },
    });
    expect(await taskRecipientIds(db, ['t1'])).toEqual(['holder-1', 'holder-2']);
    expect(findMany.mock.calls[0]?.[0]?.where).toMatchObject({
      // VeloExpense: the text role standing for the system role (admin → ADMIN).
      role: { in: ['ADMIN'] },
      deletedAt: null,
      employeeStatus: 'ACTIVE',
    });
  });

  it('notifies the ASSIGNEE and nobody else when the fallback resolved to a person', async () => {
    // A user fallback assigns, so the role branch must not also fan out — the point
    // of naming a person is that exactly one queue lights up.
    const { db, findMany } = dbWith(
      {
        id: 'n1',
        type: 'approval',
        approver: { kind: 'manager', fallback: { kind: 'user', userId: 'cfo-1' } },
      },
      'cfo-1',
    );
    expect(await taskRecipientIds(db, ['t1'])).toEqual(['cfo-1']);
    expect(findMany).not.toHaveBeenCalled();
  });

  it('tells nobody when a relative approver has no fallback at all', async () => {
    /**
     * Unchanged, and deliberate. With no fallback the claimants are "every holder of
     * the subject's approve permission", which for an expense report is every line
     * manager in the company — mailing all of them about one report would be worse
     * than the queue-only visibility they have today.
     */
    const { db, findMany } = dbWith({
      id: 'n1',
      type: 'approval',
      approver: { kind: 'manager' },
    });
    expect(await taskRecipientIds(db, ['t1'])).toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });

  it('still fans out to a filter approver’s pool', async () => {
    // The path that already existed; a regression here would silence every pool node.
    const { db, findMany } = dbWith({
      id: 'n1',
      type: 'approval',
      approver: {
        kind: 'filter',
        match: { field: 'departmentId', op: 'eq', value: 'dept-1' },
      },
    });
    expect(await taskRecipientIds(db, ['t1'])).toEqual(['holder-1', 'holder-2']);
    expect(findMany.mock.calls[0]?.[0]?.where).toMatchObject({ departmentId: 'dept-1' });
  });
});
