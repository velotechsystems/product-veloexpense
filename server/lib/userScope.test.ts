// @vitest-environment node
import { permissions as P, type RbacUser } from '@expenseos/rbac';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canViewUser } from './canViewUser';
import { resolveScopedIds } from './userScope';

/**
 * Who a caller may see in the directory.
 *
 * Both functions walk the manager tree DOWNWARD with a recursive CTE, in one round-trip
 * rather than N queries per level, and both cap the depth. The cap is a data defence, not
 * a product limit: a cycle in `managerId` — two people managing each other, which an
 * import can produce — would otherwise recurse until the database gave up, on a query
 * that runs on every directory read.
 *
 * The scope semantics are the part worth pinning, because they are easy to get subtly
 * wrong in a way that leaks:
 *
 *   · **`all` returns NO restriction (null), not every id.** The permission to use it is
 *     enforced at the router boundary; returning a list here would silently become the
 *     restriction and grow with the org.
 *   · **`indirect` starts at depth 2** — reports of reports — and `chain` at depth 1, so
 *     they are one filter apart rather than two queries.
 *   · **The caller is never in their own `chain`.** Depth 0 is excluded, so "everyone
 *     below me" does not quietly include me.
 */

const h = vi.hoisted(() => ({ rows: [] as unknown[], queries: [] as unknown[] }));

const db = () =>
  ({
    user: { findMany: vi.fn(async () => h.rows) },
    $queryRaw: vi.fn(async (...args: unknown[]) => {
      h.queries.push(args);
      return h.rows;
    }),
  }) as never;

const caller = (permissions: string[] = []): RbacUser =>
  ({ id: 'u-1', permissions }) as unknown as RbacUser;

/** The interpolated values of the last raw query. */
const lastValues = () => (h.queries[h.queries.length - 1] as unknown[]).slice(1);

beforeEach(() => {
  h.rows = [];
  h.queries = [];
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('resolving a scope to ids', () => {
  it('returns no restriction at all for the whole org', async () => {
    /**
     * `null` rather than a list of every id: the permission for this scope is checked at
     * the router, and materialising the org here would turn an unrestricted read into a
     * list that grows with headcount.
     */
    await expect(resolveScopedIds(db(), 'u-1', 'all')).resolves.toBeNull();
  });

  it('resolves self to exactly the caller, with no query', async () => {
    const client = db();
    await expect(resolveScopedIds(client, 'u-1', 'self')).resolves.toEqual(['u-1']);
    expect(h.queries).toHaveLength(0);
  });

  it('resolves direct reports with a plain query, not a recursion', async () => {
    // One level needs no CTE, and the planner does better with the simple form.
    h.rows = [{ id: 'u-2' }, { id: 'u-3' }];
    await expect(resolveScopedIds(db(), 'u-1', 'direct')).resolves.toEqual(['u-2', 'u-3']);
    expect(h.queries).toHaveLength(0);
  });

  it('excludes somebody who has left from the direct reports', async () => {
    /**
     * A soft-deleted user still carries a managerId, so without the filter a departed
     * report stays in their manager's directory forever.
     */
    const client = db();
    await resolveScopedIds(client, 'u-1', 'direct');
    const where = (client as unknown as { user: { findMany: { mock: { calls: unknown[][] } } } })
      .user.findMany.mock.calls[0][0] as { where: Record<string, unknown> };
    expect(where.where).toMatchObject({ managerId: 'u-1', deletedAt: null });
  });

  it('walks the whole tree for a chain', async () => {
    h.rows = [{ id: 'u-2' }, { id: 'u-3' }, { id: 'u-4' }];
    await expect(resolveScopedIds(db(), 'u-1', 'chain')).resolves.toEqual(['u-2', 'u-3', 'u-4']);
    expect(h.queries).toHaveLength(1);
  });

  it('starts a chain below the caller, not at them', async () => {
    /**
     * Depth 0 is the caller. "Everybody below me" that included me would put the caller
     * into every scoped list and quietly widen "my team" by one.
     */
    await resolveScopedIds(db(), 'u-1', 'chain');
    expect(lastValues()).toContain(1);
  });

  it('starts indirect two levels down, so it excludes the direct reports', async () => {
    // The one-line difference the CTE's depth column exists for.
    await resolveScopedIds(db(), 'u-1', 'indirect');
    expect(lastValues()).toContain(2);
  });

  it('caps the depth, because managerId can contain a cycle', async () => {
    /**
     * Two people managing each other is a state an import can produce, and without the
     * cap this query — which runs on every directory read — would recurse until the
     * database gave up.
     */
    await resolveScopedIds(db(), 'u-1', 'chain');
    expect(lastValues()).toContain(20);
  });

  it('returns an empty list for a manager of nobody', async () => {
    // Not null: "nobody" is a restriction, and null means "no restriction".
    h.rows = [];
    await expect(resolveScopedIds(db(), 'u-1', 'chain')).resolves.toEqual([]);
  });
});

describe('whether one person may see another', () => {
  it('admits an admin without asking the database', async () => {
    /**
     * The permission is the whole answer, and this runs on every profile read — a CTE
     * per admin page-view would be pure waste.
     */
    const client = db();
    await expect(canViewUser(client, caller([P.user.readAll]), 'u-9')).resolves.toBe(true);
    expect(h.queries).toHaveLength(0);
  });

  it('admits somebody looking at themselves', async () => {
    const client = db();
    await expect(canViewUser(client, caller(), 'u-1')).resolves.toBe(true);
    expect(h.queries).toHaveLength(0);
  });

  it('admits a manager looking down their own chain', async () => {
    h.rows = [{ visible: true }];
    await expect(canViewUser(db(), caller(), 'u-4')).resolves.toBe(true);
  });

  it('refuses somebody outside the chain', async () => {
    // A peer in another department: no permission, not self, not below them.
    h.rows = [{ visible: false }];
    await expect(canViewUser(db(), caller(), 'u-9')).resolves.toBe(false);
  });

  it('refuses rather than throwing when the query answers nothing', async () => {
    /**
     * Defensive, and in the safe direction: an empty result must not read as visible.
     */
    h.rows = [];
    await expect(canViewUser(db(), caller(), 'u-9')).resolves.toBe(false);
  });

  it('asks about the right two people', async () => {
    h.rows = [{ visible: true }];
    await canViewUser(db(), caller(), 'u-4');
    expect(lastValues()).toEqual(['u-1', 'u-4']);
  });

  it('caps its depth too', async () => {
    // Same cycle defence, on the same shape of query.
    h.rows = [{ visible: true }];
    await canViewUser(db(), caller(), 'u-4');
    const sql = (h.queries[0] as Array<{ raw?: string[] }>)[0];
    expect(JSON.stringify(sql)).toContain('20');
  });
});
