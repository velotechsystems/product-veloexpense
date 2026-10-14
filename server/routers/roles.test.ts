// @vitest-environment node
import { permissions as P } from '@expenseos/rbac';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { stubFn } from '@/test-utils/stubFn';
import { makeContext } from '../__test-helpers__/trpcCaller';

/**
 * The Role Builder's router — custom roles, and the guards that stop one from breaking
 * the permission model.
 *
 * Every rule here exists to prevent an irreversible or invisible loss of access:
 *
 *   · **A system role cannot be deactivated or deleted.** They are the seeded floor of
 *     the permission model; removing one would leave users pointing at nothing.
 *   · **Removing a permission is refused when it is the LAST grant of it** and somebody
 *     still holds it. Otherwise an edit to one role silently strips a capability from
 *     the whole org, and nothing on screen says which.
 *   · **A role in use cannot be deleted** — neither by users nor by policy rules. A
 *     policy rule with a dangling `roleId` would silently widen from one role to
 *     everyone, because a null scope means "applies to all".
 *   · **The cached permission set is dropped on every change**, or an edited role keeps
 *     answering with its old permissions until the cache expires.
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
// VeloExpense: ExpenseOS's tests are bilingual, so they run with French switched ON here
// (VeloExpense ships with it off, `ENABLED_LOCALES`; roles.db.test.ts saves an English-only label).
vi.mock('@expenseos/i18n/locales', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ENABLED_LOCALES: ['en', 'fr-CA'],
}));
// VeloExpense: the session comes from `@/auth` (auth-kit).
vi.mock('@/auth', () => ({ auth: stubFn(async () => null) }));

const invalidateRolePermissions = stubFn(async () => {});
vi.mock('@expenseos/rbac/server', () => ({
  resolveRbacUser: vi.fn(),
  invalidateRolePermissions,
}));

const U = (n: string) => `00000000-0000-7000-8000-00000000000${n}`;
const ME = U('9');
const ROLE = U('1');

const roleRow = (over: Record<string, unknown> = {}) => ({
  id: ROLE,
  isSystem: false,
  permissions: [P.expense.report.readOwn],
  label: { en: 'Reviewer', 'fr-CA': 'Réviseur' },
  description: null,
  active: true,
  externalIds: [],
  ...over,
});

function makeDb(over: Record<string, unknown> = {}) {
  return {
    role: {
      findMany: stubFn(async () => [] as unknown[]),
      // VeloExpense: by id within the tenant (RLS), so findFirst — the key is (organization, id).
      findFirst: stubFn(async () => roleRow() as unknown),
      findFirstOrThrow: stubFn(async () => roleRow() as unknown),
      create: stubFn(async () => roleRow()),
      update: stubFn(async () => roleRow()),
      delete: stubFn(async () => roleRow()),
      count: stubFn(async () => 1),
    },
    user: { count: stubFn(async () => 0) },
    policyRule: { count: stubFn(async () => 0) },
    roleExternalId: {
      deleteMany: stubFn(async () => ({ count: 0 })),
      createMany: stubFn(async () => ({ count: 0 })),
      create: stubFn(async () => ({ id: U('6') })),
      upsert: stubFn(async () => ({ id: U('6') })),
    },
    // External ids are written through their per-source table, so the source row is
    // upserted first.
    // VeloExpense: a source is the tenant's own, found or created rather than upserted.
    externalIdSource: {
      findFirst: stubFn(async () => ({ id: U('5') }) as unknown),
      create: stubFn(async () => ({ id: U('5') })),
    },
    // VeloExpense: the live-invitation count before a delete.
    $queryRaw: stubFn(async () => [{ invited: 0 }]),
    ...over,
  };
}

// VeloExpense: roles are per tenant (d73); the caller's organization keys writes and the cache.
const ORG = U('8');

async function callerFor(db: unknown, permissions: readonly string[]) {
  const { createCallerFactory } = await import('@/server/trpc');
  const { rolesRouter } = await import('./roles');
  const ctx = makeContext({ db, userId: ME, permissions, roleLabel: 'Admin' });
  // VeloExpense: makeContext has no tenant; the session carries one in VeloExpense.
  (ctx.session!.user as { organizationId?: string }).organizationId = ORG;
  return createCallerFactory(rolesRouter)(ctx);
}

const LIST = [P.admin.role.list] as const;
const CREATE = [P.admin.role.create] as const;
const UPDATE = [P.admin.role.update] as const;
const DELETE = [P.admin.role.delete] as const;

beforeEach(() => {
  vi.clearAllMocks();
  withAuditCalls.length = 0;
});

describe('permission gates', () => {
  it('separates list, create, update and delete', async () => {
    const db = makeDb();
    const lister = await callerFor(db, LIST);
    await expect(lister.list()).resolves.toBeTruthy();
    await expect(lister.permissionCatalog()).resolves.toBeTruthy();
    await expect(
      lister.create({ label: { en: 'X', 'fr-CA': 'X' }, permissions: [] } as never),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      lister.update({ id: ROLE, patch: { active: false } } as never),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(lister.delete({ id: ROLE })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('refuses a caller with nothing', async () => {
    const c = await callerFor(makeDb(), []);
    await expect(c.list()).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('list', () => {
  it('hides inactive roles by default', async () => {
    const db = makeDb();
    const c = await callerFor(db, LIST);
    await c.list();
    expect(db.role.findMany.mock.calls[0]?.[0]?.where).toEqual({ active: true });
  });

  it('includes them on request', async () => {
    const db = makeDb();
    const c = await callerFor(db, LIST);
    await c.list({ includeInactive: true });
    expect(db.role.findMany.mock.calls[0]?.[0]?.where).toEqual({});
  });

  it('searches the English label path', async () => {
    // The label is a locale-keyed Json column, so a plain contains would not match.
    const db = makeDb();
    const c = await callerFor(db, LIST);
    await c.list({ search: 'review' });
    expect(db.role.findMany.mock.calls[0]?.[0]?.where).toMatchObject({
      label: { path: ['en'], string_contains: 'review' },
    });
  });

  it('puts system roles first, then a stable order', async () => {
    // A list that reorders between runs makes the Role Builder feel broken.
    const db = makeDb();
    const c = await callerFor(db, LIST);
    await c.list();
    expect(db.role.findMany.mock.calls[0]?.[0]?.orderBy).toEqual([
      { isSystem: 'desc' },
      { id: 'asc' },
    ]);
  });

  it('flattens the user count onto each row', async () => {
    /**
     * The count comes from `_count` in the same query rather than a follow-up groupBy —
     * and it is what the delete guard's warning is built from, so it has to be present.
     */
    const db = makeDb();
    db.role.findMany.mockResolvedValue([{ ...roleRow(), _count: { users: 7 } }]);
    const c = await callerFor(db, LIST);
    const out = await c.list();
    expect(out.items[0]?.userCount).toBe(7);
    expect(out.items[0]).not.toHaveProperty('_count');
  });
});

describe('permissionCatalog', () => {
  it('returns the code-owned registry', async () => {
    // Permissions never change at runtime, which is why the client may cache it.
    const c = await callerFor(makeDb(), LIST);
    const out = await c.permissionCatalog();
    expect(Array.isArray(out.permissions)).toBe(true);
    expect(out.permissions.length).toBeGreaterThan(0);
  });
});

describe('create', () => {
  it('creates an active custom role', async () => {
    const db = makeDb();
    const c = await callerFor(db, CREATE);
    await expect(
      c.create({
        label: { en: 'Reviewer', 'fr-CA': 'Réviseur' },
        permissions: [P.expense.report.readOwn],
      } as never),
    ).resolves.toBeTruthy();
    expect(db.role.create.mock.calls[0]?.[0]?.data).toMatchObject({ active: true });
  });

  it('rejects a permission that is not in the registry', async () => {
    /**
     * The registry is the whole point: a typo'd permission string would sit in the role
     * forever, granting nothing and looking granted.
     */
    const c = await callerFor(makeDb(), CREATE);
    await expect(
      c.create({
        label: { en: 'X', 'fr-CA': 'X' },
        permissions: ['expense.report.readEverything'],
      } as never),
    ).rejects.toThrow();
  });

  it('requires a label in every shipped locale', async () => {
    // Every list and search path keys on the English one, and FR-CA is a product
    // requirement rather than an optional extra.
    const c = await callerFor(makeDb(), CREATE);
    await expect(c.create({ label: {}, permissions: [] } as never)).rejects.toThrow();
    // …and both locales, not just English.
    await expect(
      c.create({ label: { en: 'Only English' }, permissions: [] } as never),
    ).rejects.toThrow();
  });

  it('never writes externalIds onto the Role row itself', async () => {
    // They live in their own alias table; leaving them in the payload would be an
    // unknown Prisma column.
    const db = makeDb();
    const c = await callerFor(db, CREATE);
    await c.create({
      label: { en: 'Reviewer', 'fr-CA': 'Réviseur' },
      permissions: [],
      externalIds: { netsuite: 'R-1' },
    } as never);
    expect(db.role.create.mock.calls[0]?.[0]?.data).not.toHaveProperty('externalIds');
  });
});

describe('update', () => {
  it('404s a role that does not exist', async () => {
    const db = makeDb();
    db.role.findFirst.mockResolvedValue(null);
    const c = await callerFor(db, UPDATE);
    await expect(c.update({ id: ROLE, patch: { active: false } } as never)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('refuses to deactivate a system role', async () => {
    /**
     * System roles are the seeded floor of the permission model — deactivating one
     * leaves every user assigned to it pointing at an inactive role.
     */
    const db = makeDb();
    db.role.findFirst.mockResolvedValue(roleRow({ isSystem: true }));
    const c = await callerFor(db, UPDATE);
    await expect(c.update({ id: ROLE, patch: { active: false } } as never)).rejects.toThrow();
  });

  it('allows editing a system role in other ways', async () => {
    const db = makeDb();
    db.role.findFirst.mockResolvedValue(roleRow({ isSystem: true }));
    const c = await callerFor(db, UPDATE);
    await expect(
      c.update({ id: ROLE, patch: { description: { en: 'Updated' } } } as never),
    ).resolves.toBeTruthy();
  });

  it('refuses removing the LAST grant of a permission somebody holds', async () => {
    /**
     * The invisible-loss guard. Without it, an edit to one role silently strips a
     * capability from the whole org, and nothing on screen says which capability or who
     * lost it.
     */
    const db = makeDb();
    db.role.findFirst.mockResolvedValue(roleRow({ permissions: [P.expense.report.readAll] }));
    db.role.count.mockResolvedValue(0);
    db.user.count.mockResolvedValue(3);
    const c = await callerFor(db, UPDATE);
    await expect(c.update({ id: ROLE, patch: { permissions: [] } } as never)).rejects.toThrow();
  });

  it('allows the removal when another role still grants it', async () => {
    const db = makeDb();
    db.role.findFirst.mockResolvedValue(roleRow({ permissions: [P.expense.report.readAll] }));
    db.role.count.mockResolvedValue(1);
    const c = await callerFor(db, UPDATE);
    await expect(c.update({ id: ROLE, patch: { permissions: [] } } as never)).resolves.toBeTruthy();
    // No need to ask who holds it once another role grants it.
    expect(db.user.count).not.toHaveBeenCalled();
  });

  it('allows the removal when nobody holds the permission anyway', async () => {
    const db = makeDb();
    db.role.findFirst.mockResolvedValue(roleRow({ permissions: [P.expense.report.readAll] }));
    db.role.count.mockResolvedValue(0);
    db.user.count.mockResolvedValue(0);
    const c = await callerFor(db, UPDATE);
    await expect(c.update({ id: ROLE, patch: { permissions: [] } } as never)).resolves.toBeTruthy();
  });

  it('treats a deactivation as removing every permission', async () => {
    // Switching a role off takes away everything it granted, so the same guard applies.
    const db = makeDb();
    db.role.findFirst.mockResolvedValue(roleRow({ permissions: [P.expense.report.readAll] }));
    db.role.count.mockResolvedValue(0);
    db.user.count.mockResolvedValue(2);
    const c = await callerFor(db, UPDATE);
    await expect(c.update({ id: ROLE, patch: { active: false } } as never)).rejects.toThrow();
  });

  it('drops the cached permission set when the permissions change', async () => {
    /**
     * The lookup is Redis-cached by roleId, so an edit that skips the invalidation
     * leaves every holder answering with the old permissions until the 5-minute TTL.
     */
    const db = makeDb();
    db.role.count.mockResolvedValue(1);
    const c = await callerFor(db, UPDATE);
    await c.update({ id: ROLE, patch: { permissions: [] } } as never);
    // VeloExpense: the cache is keyed by organization too.
    expect(invalidateRolePermissions).toHaveBeenCalledWith(ORG, ROLE);
  });

  it('drops it on a deactivation too', async () => {
    const db = makeDb();
    db.role.findFirst.mockResolvedValue(roleRow({ permissions: [] }));
    const c = await callerFor(db, UPDATE);
    await c.update({ id: ROLE, patch: { active: false } } as never);
    // VeloExpense: the cache is keyed by organization too.
    expect(invalidateRolePermissions).toHaveBeenCalledWith(ORG, ROLE);
  });

  it('leaves the cache alone for a rename', async () => {
    /**
     * Deliberately narrow: a label or description edit changes nothing about what the
     * role grants, so invalidating there would stampede the cache on cosmetic edits.
     */
    const db = makeDb();
    const c = await callerFor(db, UPDATE);
    await c.update({ id: ROLE, patch: { description: { en: 'Updated' } } } as never);
    expect(invalidateRolePermissions).not.toHaveBeenCalled();
  });

  it('survives a cache that is unreachable, and says the narrowing is not in force', async () => {
    /**
     * A Redis blip must not fail a write that already landed — but it must not be silent
     * either. The entry survives and keeps authorizing the OLD permission set until the
     * TTL expires, so this revocation is not in effect yet. The comment here used to say
     * "next-request resolve will repopulate", which describes a cache MISS; a failed DEL
     * is the opposite, and that wording is what makes "I revoked it and it still worked"
     * impossible to explain.
     */
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    invalidateRolePermissions.mockRejectedValue(new Error('redis down'));
    const db = makeDb();
    db.role.count.mockResolvedValue(1);
    const c = await callerFor(db, UPDATE);
    await expect(c.update({ id: ROLE, patch: { permissions: [] } } as never)).resolves.toBeTruthy();
    expect(err).toHaveBeenCalled();
    // The role id, so the log line names which revocation is late.
    expect(String(err.mock.calls[0]?.[0])).toContain(ROLE);
    err.mockRestore();
  });

  it('rejects an empty patch', async () => {
    // Otherwise it audits a no-op as a change.
    const c = await callerFor(makeDb(), UPDATE);
    await expect(c.update({ id: ROLE, patch: {} } as never)).rejects.toThrow();
  });

  it('rejects an unknown patch key rather than ignoring it', async () => {
    const c = await callerFor(makeDb(), UPDATE);
    await expect(c.update({ id: ROLE, patch: { isSystem: true } } as never)).rejects.toThrow();
  });
});

describe('delete', () => {
  it('404s a role that does not exist', async () => {
    const db = makeDb();
    db.role.findFirst.mockResolvedValue(null);
    const c = await callerFor(db, DELETE);
    await expect(c.delete({ id: ROLE })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('refuses to delete a system role', async () => {
    const db = makeDb();
    db.role.findFirst.mockResolvedValue(roleRow({ isSystem: true }));
    const c = await callerFor(db, DELETE);
    await expect(c.delete({ id: ROLE })).rejects.toThrow(/Cannot delete a system role/);
  });

  it('refuses to delete a role somebody is assigned', async () => {
    // `Role` is the one lookup with a hard delete, so this is the only thing standing
    // between an assigned role and a dangling FK.
    const db = makeDb();
    db.user.count.mockResolvedValue(4);
    const c = await callerFor(db, DELETE);
    await expect(c.delete({ id: ROLE })).rejects.toThrow();
    expect(db.role.delete).not.toHaveBeenCalled();
  });

  it('refuses to delete a role a policy rule scopes to', async () => {
    /**
     * The FK is RESTRICT rather than SetNull on purpose: a null scope means "applies to
     * everyone", so blanking a rule's role would silently widen a policy from one role
     * to the whole company. The router refuses first so an admin gets a sentence
     * instead of a constraint violation.
     */
    const db = makeDb();
    db.policyRule.count.mockResolvedValue(2);
    const c = await callerFor(db, DELETE);
    await expect(c.delete({ id: ROLE })).rejects.toThrow();
    expect(db.role.delete).not.toHaveBeenCalled();
  });

  it('counts every rule, enabled or not', async () => {
    // The database constraint does not care whether a rule is switched on.
    const db = makeDb();
    const c = await callerFor(db, DELETE);
    await c.delete({ id: ROLE });
    expect(db.policyRule.count.mock.calls[0]?.[0]?.where).toEqual({ roleId: ROLE });
  });

  it('deletes an unused custom role and drops its cache entry', async () => {
    const db = makeDb();
    const c = await callerFor(db, DELETE);
    await expect(c.delete({ id: ROLE })).resolves.toEqual({ ok: true });
    // VeloExpense: the compound key, with the caller's organization.
    expect(db.role.delete).toHaveBeenCalledWith({
      where: { organizationId_id: { organizationId: ORG, id: ROLE } },
    });
  });
});
