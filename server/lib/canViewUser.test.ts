// @vitest-environment node
import { permissions as P } from '@expenseos/rbac';
import { describe, expect, it, vi } from 'vitest';
import { canViewUser } from './canViewUser';

/**
 * Who may open somebody else's profile.
 *
 * Three answers, and the order matters: an admin never touches the database, a person can
 * always see themselves, and everybody else is a question about the reporting chain —
 * answered DOWNWARD and transitively, so a director sees their directors' reports too.
 *
 * The chain walk is a recursive CTE rather than a loop of queries, which is what makes
 * "anywhere below me" one round-trip instead of one per level. The depth cap is not
 * decoration: a cycle in `managerId` (two people managing each other, which the schema
 * permits) would otherwise recurse until the connection died.
 */

const rbac = (over: Record<string, unknown> = {}) =>
  ({ id: 'me', permissions: [] as string[], ...over }) as never;

function fakeDb(visible: boolean | undefined) {
  const queryRaw = vi.fn(async () => (visible === undefined ? [] : [{ visible }]));
  return { db: { $queryRaw: queryRaw } as never, queryRaw };
}

describe('canViewUser', () => {
  it('lets an admin through without asking the database', async () => {
    /** The reach is unconditional, so a chain walk would be a query whose answer cannot
     *  change the outcome — on a page that renders a list of them. */
    const { db, queryRaw } = fakeDb(false);
    await expect(canViewUser(db, rbac({ permissions: [P.user.readAll] }), 'other')).resolves.toBe(
      true,
    );
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it('lets anybody see their own profile, without asking either', async () => {
    const { db, queryRaw } = fakeDb(false);
    await expect(canViewUser(db, rbac(), 'me')).resolves.toBe(true);
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it('lets a manager see somebody in their chain', async () => {
    const { db } = fakeDb(true);
    await expect(canViewUser(db, rbac(), 'report')).resolves.toBe(true);
  });

  it('refuses somebody outside it', async () => {
    const { db } = fakeDb(false);
    await expect(canViewUser(db, rbac(), 'stranger')).resolves.toBe(false);
  });

  it('refuses when the query comes back with no row at all', async () => {
    /** `EXISTS` always returns one row, so an empty result means something else went
     *  wrong — and the safe reading of "I do not know" is no. */
    const { db } = fakeDb(undefined);
    await expect(canViewUser(db, rbac(), 'stranger')).resolves.toBe(false);
  });

  it('refuses a truthy value that is not the boolean true', async () => {
    /** `$queryRaw` returns whatever the driver produced; a strict comparison is what
     *  stops a `'f'` or a `1` from reading as permission. */
    const db = { $queryRaw: vi.fn(async () => [{ visible: 'f' }]) } as never;
    await expect(canViewUser(db, rbac(), 'stranger')).resolves.toBe(false);
  });
});
