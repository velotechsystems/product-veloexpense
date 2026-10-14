// Ported from ExpenseOS `apps/web/src/server/routers/roles.db.test.ts` (1e682dd6), w4-10c (d74). Each
// adaptation is marked "VeloExpense:".
// @vitest-environment node
import { permissions as P } from '@expenseos/rbac';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';

/**
 * Deleting a role, and what must stop it.
 *
 * `Role` is the only lookup in the schema with a hard delete — every other one is
 * soft-deleted ("we never hard-delete lookup rows"). That makes it the only place
 * the new `PolicyRule.roleId` foreign key can actually fire, and the reason this
 * file exists.
 *
 * The FK is RESTRICT on purpose. `SetNull` would be the dangerous choice: a null
 * scope means "applies to everyone", so blanking a rule's role would silently widen
 * a policy from one role to the whole company. Restrict makes the database refuse
 * — but a raw constraint violation reaches an admin as a 500 with no explanation,
 * so the router has to refuse first, with a sentence naming the count.
 *
 * Gated on DATABASE_URL like every `*.db.test.ts`.
 */

/*
 * VeloExpense: roles are per tenant (d73), so the test makes two tenants and calls the app
 * router as a request does (`caller`, by email and organization), which runs every read under
 * the tenant's RLS — ExpenseOS's shared test client and `makeContext` have no tenant. Roles
 * and rules are inserted with the admin pool, scoped to the tenant. The caller's permissions
 * are those of System Administrator, which holds the three below, so `ADMIN_PERMS` is kept as
 * documentation of what the calls need. Added: a role with a live invitation is refused
 * (0069 puts a role on invitations); another tenant's role is NOT_FOUND, not deletable.
 */
vi.mock('@/auth', () => ({ auth: vi.fn(async () => null) }));
vi.mock('@/lib/tenant/request', () => ({ hostTenantSlug: async () => null }));
vi.mock('@expenseos/rbac/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@expenseos/rbac/server')>()),
  // A successful delete drops the role's cached permission set. Stubbed rather than
  // reaching Redis, which a db test has no business needing.
  invalidateRolePermissions: vi.fn(async () => {}),
}));

const ADMIN_PERMS = [P.admin.role.list, P.admin.role.create, P.admin.role.delete] as const;

describe.skipIf(!process.env.DATABASE_URL)('roles.delete guards (integration)', () => {
  // VeloExpense: the admin pool and two tenants stand in for ExpenseOS's shared test client.
  const admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL });
  let A: string;
  let B: string;
  let bossId: string;
  // VeloExpense: the app router's `roles`, called as the tenant's admin (see the header).
  let caller: (perms?: readonly string[]) => ReturnType<
    typeof import('@/server/routers/_app').appRouter.createCaller
  >['roles'];
  const roleCount = async (id: string) =>
    (await admin.query(`SELECT count(*)::int AS n FROM role WHERE id = $1`, [id])).rows[0].n as number;
  const roleIds: string[] = [];
  const ruleIds: string[] = [];

  /** A deletable role: not a system role, nobody assigned. */
  // VeloExpense: inserted in a tenant (A unless named).
  const makeRole = async (name: string, organizationId = A) => {
    const r = (
      await admin.query(
        `INSERT INTO role (organization_id, label, permissions, is_system) VALUES ($1, $2, $3, false) RETURNING id`,
        [organizationId, { en: name, 'fr-CA': name }, [P.expense.report.readOwn]],
      )
    ).rows[0] as { id: string };
    roleIds.push(r.id);
    return r.id;
  };

  /** A v2 policy-rule instance scoped to one role. */
  // VeloExpense: VeloExpense's kind for a per-transaction limit is PREDICATE_LINE (0066).
  const makeRuleFor = async (roleId: string) => {
    const rule = (
      await admin.query(
        `INSERT INTO policy_rule (organization_id, kind_code, scope, severity, condition, params, message_key, effective_from, role_id)
         VALUES ($1, 'PREDICATE_LINE', 'LINE', 'WARNING', '{"all":[{"field":"lineAmount","op":"gt","value":10000}]}', '{}',
                 'perTransactionLimit', '2026-01-01', $2) RETURNING id`,
        [A, roleId],
      )
    ).rows[0] as { id: string };
    ruleIds.push(rule.id);
    return rule.id;
  };

  beforeAll(async () => {
    const { createOrganization } = await import('@/lib/onboarding/provision');
    const { createCallerFactory } = await import('@/server/trpc');
    const { appRouter } = await import('@/server/routers/_app');
    const { db } = await import('@/lib/db/prisma');
    await admin.query('TRUNCATE invite, audit_entry, app_user, organization CASCADE');
    A = (await createOrganization({ name: 'Roles A', slug: 'roledel-a', adminEmail: 'boss@roledel-a.test', adminName: 'Boss' }))
      .organizationId;
    B = (await createOrganization({ name: 'Roles B', slug: 'roledel-b', adminEmail: 'boss@roledel-b.test', adminName: 'Other' }))
      .organizationId;
    bossId = (await admin.query(`SELECT id FROM app_user WHERE email = 'boss@roledel-a.test'`)).rows[0].id;
    // VeloExpense: the founding admin is the actor; their role (System Administrator) holds
    // every permission in `perms`, which is therefore not injected.
    caller = () =>
      createCallerFactory(appRouter)({
        session: null,
        db,
        rbac: null,
        caller: { email: 'boss@roledel-a.test', organizationId: A },
      }).roles;
  });

  afterAll(async () => {
    await admin.query(`DELETE FROM policy_rule WHERE id = ANY($1::uuid[])`, [ruleIds]).catch(() => {});
    await admin.query(`DELETE FROM role WHERE id = ANY($1::uuid[])`, [roleIds]).catch(() => {});
    await admin.end();
  });

  it('refuses to delete a role a policy rule is scoped to, and says how many', async () => {
    const roleId = await makeRole(`QA scoped role ${Date.now()}`);
    await makeRuleFor(roleId);

    // The message has to be actionable: without this guard the FK refuses and the
    // admin gets a 500 that names nothing.
    await expect(caller(ADMIN_PERMS).delete({ id: roleId })).rejects.toThrow(/1 policy rule\b/);

    // And the role is still there — refusing must not half-delete.
    expect(await roleCount(roleId)).toBe(1);
  });

  it('counts every scoped rule, including disabled ones', async () => {
    // The constraint does not care whether a rule is enabled, and a disabled rule
    // is one somebody means to switch back on.
    const roleId = await makeRole(`QA multi-rule role ${Date.now()}`);
    await makeRuleFor(roleId);
    const second = await makeRuleFor(roleId);
    await admin.query(`UPDATE policy_rule SET enabled = false WHERE id = $1`, [second]);

    await expect(caller(ADMIN_PERMS).delete({ id: roleId })).rejects.toThrow(/2 policy rules\b/);
  });

  it('deletes the role once nothing is scoped to it', async () => {
    const roleId = await makeRole(`QA freeable role ${Date.now()}`);
    const ruleId = await makeRuleFor(roleId);
    await expect(caller(ADMIN_PERMS).delete({ id: roleId })).rejects.toThrow();

    await admin.query(`DELETE FROM policy_rule WHERE id = $1`, [ruleId]);
    await caller(ADMIN_PERMS).delete({ id: roleId });
    expect(await roleCount(roleId)).toBe(0);
  });

  it('still refuses a system role', async () => {
    // The pre-existing guard, kept honest alongside the new one.
    const system = (await admin.query(`SELECT id FROM role WHERE organization_id = $1 AND is_system LIMIT 1`, [A])).rows[0];
    if (!system) return;
    await expect(caller(ADMIN_PERMS).delete({ id: system.id })).rejects.toThrow(/system role/i);
  });

  // VeloExpense: 0069 puts a role on invitations.
  it('refuses a role somebody has a live invitation to, and forgets it on one that is over', async () => {
    const roleId = await makeRole(`QA invited role ${Date.now()}`);
    const invite = (
      await admin.query(
        `INSERT INTO invite (organization_id, email, token_hash, invited_by_id, expires_at, role_id)
         VALUES ($1, 'invited@roledel-a.test', repeat('ab', 32), $2, now() + interval '7 days', $3) RETURNING id`,
        [A, bossId, roleId],
      )
    ).rows[0].id as string;
    await expect(caller(ADMIN_PERMS).delete({ id: roleId })).rejects.toThrow(/1 pending invitation\b/);
    expect(await roleCount(roleId)).toBe(1);

    await admin.query(`UPDATE invite SET revoked_at = now() WHERE id = $1`, [invite]);
    await caller(ADMIN_PERMS).delete({ id: roleId });
    expect(await roleCount(roleId)).toBe(0);
    const row = (await admin.query(`SELECT role_id FROM invite WHERE id = $1`, [invite])).rows[0];
    expect(row).toEqual({ role_id: null });
  });

  // VeloExpense: roles are per tenant (d73).
  it("cannot see or delete another tenant's role", async () => {
    const theirs = await makeRole(`QA other tenant ${Date.now()}`, B);
    await expect(caller(ADMIN_PERMS).delete({ id: theirs })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await roleCount(theirs)).toBe(1);
  });

  // VeloExpense: French is switched off (`ENABLED_LOCALES`), so an English name alone is a
  // role — created in the caller's tenant, and audited there.
  it('creates a role from an English name alone, in the caller’s tenant', async () => {
    const name = `QA English only ${Date.now()}`;
    const { id } = await caller(ADMIN_PERMS).create({ label: { en: name }, permissions: [P.expense.report.readOwn] });
    roleIds.push(id);
    const row = (await admin.query(`SELECT organization_id, label FROM role WHERE id = $1`, [id])).rows[0];
    expect(row).toEqual({ organization_id: A, label: { en: name } });
    const audit = await admin.query(
      `SELECT organization_id, action, actor_role FROM audit_entry WHERE entity_id = $1`,
      [id],
    );
    expect(audit.rows).toEqual([{ organization_id: A, action: 'ROLE_CREATED', actor_role: 'System Administrator' }]);
  });

  // VeloExpense (w4-10e): the grant ceiling. A custom role that may edit roles cannot make
  // itself (or anything else) an administrator.
  it('refuses a role editor adding what they do not hold, to their own role included', async () => {
    const { createCallerFactory } = await import('@/server/trpc');
    const { appRouter } = await import('@/server/routers/_app');
    const { db } = await import('@/lib/db/prisma');
    const editorRole = await makeRole(`QA role editor ${Date.now()}`);
    await admin.query(`UPDATE role SET permissions = $2 WHERE id = $1`, [
      editorRole,
      [P.admin.role.list, P.admin.role.update, P.expense.report.readOwn],
    ]);
    const editor = (
      await admin.query(
        `INSERT INTO app_user (organization_id, email, display_name, role_id)
         VALUES ($1, 'editor@roledel-a.test', 'Editor', $2) RETURNING id`,
        [A, editorRole],
      )
    ).rows[0].id as string;
    try {
      const roles = createCallerFactory(appRouter)({
        session: null,
        db,
        rbac: null,
        caller: { email: 'editor@roledel-a.test', organizationId: A },
      }).roles;
      await expect(
        roles.update({
          id: editorRole,
          patch: { permissions: [P.admin.role.list, P.admin.role.update, P.expense.report.readOwn, P.admin.appSettings.update] },
        }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      const row = (await admin.query(`SELECT permissions FROM role WHERE id = $1`, [editorRole])).rows[0];
      expect(row.permissions).not.toContain(P.admin.appSettings.update);
      // Renaming their own role is fine.
      await roles.update({ id: editorRole, patch: { label: { en: 'QA renamed editor' } } });
    } finally {
      // The rename is audited with the editor as actor, so they stay; back to Employee, so
      // their role can be cleaned up with the others.
      await admin.query(`UPDATE app_user SET role_id = '019e3000-0000-7000-8000-000000000004' WHERE id = $1`, [editor]);
    }
  });
});
