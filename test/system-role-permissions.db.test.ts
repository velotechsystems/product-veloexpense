import { SYSTEM_ROLE_IDS, SYSTEM_ROLE_KINDS, SYSTEM_ROLE_LABELS, SYSTEM_ROLE_PERMISSIONS } from '@expenseos/rbac';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * A system role must hold at least what the registry says it holds.
 *
 * `SYSTEM_ROLE_PERMISSIONS` is CODE — the definition of what "System Administrator" means.
 * The Role row is DATA, and since #454 the seed is create-only, so a row keeps whatever
 * list it was born with and a permission added to the registry afterwards never reaches
 * it. Nothing failed when that happened. It was found weeks later, from a 403.
 *
 * This is the guard. Add a permission to a system role in the registry, ship no migration
 * to deliver it, and this fails — loudly, in CI, on the change that introduced it.
 *
 * ONE-DIRECTIONAL on purpose. It asserts the row holds AT LEAST the registry set, never
 * exactly it: `roles.ts` lets an admin add permissions to a system role, and a test that
 * demanded equality would fail an environment where somebody had legitimately done so.
 *
 * VeloExpense (w4-10a, d73): ExpenseOS's guard (packages/db/src/systemRolePermissions.db.test.ts,
 * 550b2945), over VeloExpense's two sources of system-role rows:
 *   · EVERY organization's rows, not ExpenseOS's one set — each tenant holds its own;
 *   · a NEW organization's rows, which come from `seed_system_roles` (0068) through the
 *     trigger on `organization`. That function carries the lists as they were when it was
 *     last replaced, so a registry addition owes a migration that updates the rows AND
 *     replaces the function; a fresh organization is how this file notices the second half.
 * The organization is created and dropped here, over the admin connection.
 */

const ADMIN_URL = process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL;

describe.skipIf(!ADMIN_URL)('system roles hold what the registry defines', () => {
  const admin = new Pool({ connectionString: ADMIN_URL });
  let freshOrg: string;

  beforeAll(async () => {
    freshOrg = (
      await admin.query(
        `INSERT INTO organization (slug, name) VALUES ($1, 'System roles probe') RETURNING id`,
        [`sysroles-${process.pid}-${Date.now()}`],
      )
    ).rows[0].id as string;
  });

  afterAll(async () => {
    await admin.query('DELETE FROM organization WHERE id = $1', [freshOrg]);
    await admin.end();
  });

  for (const kind of SYSTEM_ROLE_KINDS) {
    it(`${kind} is not missing any registry permission, in any organization`, async () => {
      const { rows } = await admin.query<{ organization_id: string; permissions: string[] }>(
        `SELECT o.id AS organization_id, r.permissions
           FROM organization o
           LEFT JOIN role r ON r.organization_id = o.id AND r.id = $1`,
        [SYSTEM_ROLE_IDS[kind]],
      );
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row.permissions, `the ${kind} system role should be seeded in ${row.organization_id}`).not.toBeNull();
        const held = new Set(row.permissions ?? []);
        const missing = SYSTEM_ROLE_PERMISSIONS[kind].filter((p) => !held.has(p));
        expect(
          missing,
          `${kind} in ${row.organization_id === freshOrg ? 'a NEW organization' : row.organization_id} ` +
            `is missing ${missing.length} registry permission(s): ${missing.join(', ')}. ` +
            'A Role row never gains one on its own — deliver it with a migration that updates ' +
            "every tenant's rows and replaces seed_system_roles (0068).",
        ).toEqual([]);
      }
    });
  }

  it('gives a new organization every system role, active and marked system, with its label', async () => {
    const { rows } = await admin.query<{ id: string; label: Record<string, string>; is_system: boolean; active: boolean }>(
      `SELECT id, label, is_system, active FROM role WHERE organization_id = $1 ORDER BY id`,
      [freshOrg],
    );
    expect(rows.map((r) => r.id).sort()).toEqual(SYSTEM_ROLE_KINDS.map((k) => SYSTEM_ROLE_IDS[k]).sort());
    for (const kind of SYSTEM_ROLE_KINDS) {
      const row = rows.find((r) => r.id === SYSTEM_ROLE_IDS[kind]);
      expect(row).toMatchObject({ is_system: true, active: true, label: SYSTEM_ROLE_LABELS[kind] });
    }
  });
});
