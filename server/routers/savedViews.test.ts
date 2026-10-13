// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { stubFn } from '@/test-utils/stubFn';
import { makeContext } from '../__test-helpers__/trpcCaller';

/**
 * Saved views — a small per-user router with one sharp rule.
 *
 * **Saved views: exactly one default per user per resource.** Every write path that can
 * set `pinned` has to clear the previous default first, or a user ends up with two
 * defaults and the list page opens on whichever the ordering happens to surface. There
 * are three such paths — create, update, togglePinned — and they each need the clear.
 *
 * Ported from ExpenseOS's `savedViewsDelegations.test.ts` (550b2945) with w4-08: its saved-
 * views half. VeloExpense: the delegations half waits for ExpenseOS's delegations router,
 * which is not ported (VeloExpense keeps its own delegations, /approvals/delegations). The
 * tenancy, the audit chain and the one-default index are proven against the database in
 * test/saved-views.db.test.ts.
 */

const withAuditCalls: Array<Record<string, unknown>> = [];
vi.mock('@expenseos/audit', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@expenseos/audit');
  return {
    ...actual,
    withAudit: vi.fn(
      async (
        db: unknown,
        envelope: Record<string, unknown>,
        fn: (tx: unknown) => unknown,
        resolveEntityId?: (r: unknown) => unknown,
      ) => {
        const idx = withAuditCalls.push(envelope) - 1;
        const result = await fn(db);
        // Mirror the real writer: a create's entity id comes from what the body inserted.
        if (resolveEntityId)
          withAuditCalls[idx] = { ...envelope, entityId: resolveEntityId(result) };
        return result;
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

const U = (n: string) => `00000000-0000-7000-8000-00000000000${n}`;
const ME = U('9');
const VIEW = U('1');

const STATE = { filters: [] };

function viewDb(over: Record<string, unknown> = {}) {
  return {
    savedView: {
      findMany: stubFn(async () => [] as unknown[]),
      findFirst: stubFn(async () => ({ id: VIEW, resource: 'people', pinned: false }) as unknown),
      create: stubFn(async () => ({ id: VIEW })),
      update: stubFn(async () => ({ id: VIEW })),
      updateMany: stubFn(async () => ({ count: 0 })),
    },
    ...over,
  };
}

async function views(db: unknown, permissions: readonly string[] = []) {
  const { createCallerFactory } = await import('@/server/trpc');
  const { savedViewsRouter } = await import('./savedViews');
  return createCallerFactory(savedViewsRouter)(makeContext({ db, userId: ME, permissions }));
}

beforeEach(() => {
  vi.clearAllMocks();
  withAuditCalls.length = 0;
});

describe('savedViews.list', () => {
  it('returns only the caller’s own, undeleted views for one resource', async () => {
    const db = viewDb();
    const c = await views(db);
    await c.list({ resource: 'people' } as never);
    expect(db.savedView.findMany.mock.calls[0]?.[0]?.where).toEqual({
      ownerId: ME,
      resource: 'people',
      deletedAt: null,
    });
  });

  it('puts the default first', async () => {
    // The list page opens on the default, so it has to be findable without scanning.
    const db = viewDb();
    const c = await views(db);
    await c.list({ resource: 'people' } as never);
    expect(db.savedView.findMany.mock.calls[0]?.[0]?.orderBy).toEqual([
      { pinned: 'desc' },
      { name: 'asc' },
    ]);
  });

  it('rejects an unknown resource', async () => {
    const c = await views(viewDb());
    await expect(c.list({ resource: 'not-a-resource' } as never)).rejects.toThrow();
  });
});

describe('savedViews.create', () => {
  it('files the view against the caller', async () => {
    const db = viewDb();
    const c = await views(db);
    await c.create({ resource: 'people', name: 'My view', state: STATE } as never);
    expect(db.savedView.create.mock.calls[0]?.[0]?.data).toMatchObject({
      ownerId: ME,
      resource: 'people',
      name: 'My view',
      pinned: false,
    });
  });

  it('clears the previous default when creating a new one', async () => {
    /**
     * One default per user per resource. Without the clear the user has two, and the
     * list page opens on whichever the ordering happens to surface first.
     */
    const db = viewDb();
    const c = await views(db);
    await c.create({
      resource: 'people',
      name: 'New default',
      state: STATE,
      pinned: true,
    } as never);
    expect(db.savedView.updateMany).toHaveBeenCalledWith({
      where: { ownerId: ME, resource: 'people', pinned: true, deletedAt: null },
      data: { pinned: false },
    });
  });

  it('clears nothing when the new view is not a default', async () => {
    const db = viewDb();
    const c = await views(db);
    await c.create({ resource: 'people', name: 'Just a view', state: STATE } as never);
    expect(db.savedView.updateMany).not.toHaveBeenCalled();
  });

  it('trims and bounds the name', async () => {
    const db = viewDb();
    const c = await views(db);
    await c.create({ resource: 'people', name: '  Trimmed  ', state: STATE } as never);
    expect((db.savedView.create.mock.calls[0]?.[0]?.data as { name: string }).name).toBe('Trimmed');
    await expect(
      c.create({ resource: 'people', name: '   ', state: STATE } as never),
    ).rejects.toThrow();
    await expect(
      c.create({ resource: 'people', name: 'x'.repeat(81), state: STATE } as never),
    ).rejects.toThrow();
  });

  it('caps the filter count in the stored state', async () => {
    // The state is stored as Json and replayed into a query; an unbounded clause list
    // is a stored pathological query.
    const c = await views(viewDb());
    const many = Array.from({ length: 51 }, (_, i) => ({
      id: `f${i}`,
      field: 'name',
      op: 'contains',
      value: 'x',
    }));
    await expect(
      c.create({ resource: 'people', name: 'Too many', state: { filters: many } } as never),
    ).rejects.toThrow();
  });
});

describe('savedViews.update', () => {
  it('404s a view the caller does not own', async () => {
    /**
     * The lookup is scoped by ownerId, so somebody else's view is simply not found —
     * which is also the right answer for a deleted one.
     */
    const db = viewDb();
    db.savedView.findFirst.mockResolvedValue(null);
    const c = await views(db);
    await expect(c.update({ id: VIEW, name: 'Mine now' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('scopes the lookup to the caller and undeleted rows', async () => {
    const db = viewDb();
    const c = await views(db);
    await c.update({ id: VIEW, name: 'Renamed' });
    expect(db.savedView.findFirst.mock.calls[0]?.[0]?.where).toEqual({
      id: VIEW,
      ownerId: ME,
      deletedAt: null,
    });
  });

  it('patches only what arrived', async () => {
    const db = viewDb();
    const c = await views(db);
    await c.update({ id: VIEW, name: 'Renamed' });
    expect(db.savedView.update.mock.calls[0]?.[0]?.data).toEqual({ name: 'Renamed' });
  });

  it('clears the previous default when promoting a view', async () => {
    const db = viewDb();
    const c = await views(db);
    await c.update({ id: VIEW, pinned: true });
    expect(db.savedView.updateMany.mock.calls[0]?.[0]?.where).toMatchObject({
      ownerId: ME,
      resource: 'people',
      pinned: true,
      id: { not: VIEW },
    });
  });

  it('does not re-clear when the view was already the default', async () => {
    // Nothing changed, so the exclusive-default sweep is pointless work.
    const db = viewDb();
    db.savedView.findFirst.mockResolvedValue({ id: VIEW, resource: 'people', pinned: true });
    const c = await views(db);
    await c.update({ id: VIEW, pinned: true });
    expect(db.savedView.updateMany).not.toHaveBeenCalled();
  });

  it('clears nothing when demoting', async () => {
    const db = viewDb();
    db.savedView.findFirst.mockResolvedValue({ id: VIEW, resource: 'people', pinned: true });
    const c = await views(db);
    await c.update({ id: VIEW, pinned: false });
    expect(db.savedView.updateMany).not.toHaveBeenCalled();
    expect(db.savedView.update.mock.calls[0]?.[0]?.data).toEqual({ pinned: false });
  });

  it('audits which fields changed', async () => {
    const db = viewDb();
    const c = await views(db);
    await c.update({ id: VIEW, name: 'Renamed', pinned: true });
    expect(withAuditCalls[0]?.details).toEqual({ changedFields: ['name', 'pinned'] });
  });
});

describe('savedViews.delete', () => {
  it('404s a view the caller does not own', async () => {
    const db = viewDb();
    db.savedView.findFirst.mockResolvedValue(null);
    const c = await views(db);
    await expect(c.delete({ id: VIEW })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('soft-deletes rather than removing the row', async () => {
    // Views are referenced from audit rows and from a user's URL state.
    const db = viewDb();
    db.savedView.findFirst.mockResolvedValue({ id: VIEW, name: 'V', resource: 'people' });
    const c = await views(db);
    await expect(c.delete({ id: VIEW })).resolves.toEqual({ ok: true });
    expect(
      (db.savedView.update.mock.calls[0]?.[0]?.data as { deletedAt: Date }).deletedAt,
    ).toBeInstanceOf(Date);
  });

  it('records what was deleted', async () => {
    const db = viewDb();
    db.savedView.findFirst.mockResolvedValue({ id: VIEW, name: 'Q3 review', resource: 'people' });
    const c = await views(db);
    await c.delete({ id: VIEW });
    expect(withAuditCalls[0]?.details).toEqual({ name: 'Q3 review', resource: 'people' });
  });
});

describe('savedViews.togglePinned', () => {
  it('404s a view the caller does not own', async () => {
    const db = viewDb();
    db.savedView.findFirst.mockResolvedValue(null);
    const c = await views(db);
    await expect(c.togglePinned({ id: VIEW })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('promotes and clears the previous default', async () => {
    const db = viewDb();
    const c = await views(db);
    await c.togglePinned({ id: VIEW });
    expect(db.savedView.updateMany.mock.calls[0]?.[0]?.where).toMatchObject({
      id: { not: VIEW },
    });
    expect(db.savedView.update.mock.calls[0]?.[0]?.data).toEqual({ pinned: true });
  });

  it('demotes without touching anything else', async () => {
    const db = viewDb();
    db.savedView.findFirst.mockResolvedValue({ id: VIEW, resource: 'people', pinned: true });
    const c = await views(db);
    await c.togglePinned({ id: VIEW });
    expect(db.savedView.updateMany).not.toHaveBeenCalled();
    expect(db.savedView.update.mock.calls[0]?.[0]?.data).toEqual({ pinned: false });
  });

  it('records the direction it moved', async () => {
    const db = viewDb();
    const c = await views(db);
    await c.togglePinned({ id: VIEW });
    expect(withAuditCalls[0]?.details).toEqual({ changedFields: ['pinned'], pinned: true });
  });
});

