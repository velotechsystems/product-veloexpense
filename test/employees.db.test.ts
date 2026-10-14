/**
 * VX1-2 — employees & org service DB test. Exercises lib/employees/service
 * directly over a tenant transaction (withOrg), so no auth session is needed.
 *
 * Covers the directory read path, manager-chain resolution, the cycle and
 * cross-tenant guards, and the deactivation rules. Tenant isolation of app_user
 * itself is proven by test/rls-isolation.test.ts (no new tenant table lands in
 * this ticket — 0004 only adds columns/constraints to app_user).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { withOrg } from '@/lib/tenant/context';
import * as svc from '@/lib/employees/service';

const admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL });

let orgA: string;
let orgB: string;
let deptId: string;
let ceo: svc.EmployeeRow;
let manager: svc.EmployeeRow;
let report: svc.EmployeeRow;
let otherOrgEmployeeId: string;

beforeAll(async () => {
  await admin.query('TRUNCATE app_user, organization CASCADE');
  const a = await admin.query("INSERT INTO organization (slug, name) VALUES ('vx12-acme','Acme') RETURNING id");
  const b = await admin.query("INSERT INTO organization (slug, name) VALUES ('vx12-globex','Globex') RETURNING id");
  orgA = a.rows[0].id;
  orgB = b.rows[0].id;

  await withOrg(orgA, async (tx) => {
    const d = await tx.query(
      "INSERT INTO department (organization_id, label) VALUES ($1,'{\"en\":\"Finance\"}') RETURNING id",
      [orgA],
    );
    deptId = d.rows[0].id;

    ceo = await svc.createEmployee(tx, {
      email: 'ceo@acme.test',
      displayName: 'Casey CEO',
      title: 'Chief Executive',
      roleId: '019e3000-0000-7000-8000-000000000001', // w4-10b: System Administrator
    });
    manager = await svc.createEmployee(tx, {
      email: 'manager@acme.test',
      displayName: 'Morgan Manager',
      title: 'Finance Manager',
      managerId: ceo.id,
      departmentId: deptId,
    });
    report = await svc.createEmployee(tx, {
      email: 'employee@acme.test',
      displayName: 'Robin Report',
      title: 'Analyst',
      managerId: manager.id,
      departmentId: deptId,
    });
  });

  await withOrg(orgB, async (tx) => {
    const other = await svc.createEmployee(tx, { email: 'someone@globex.test', displayName: 'Other Org' });
    otherOrgEmployeeId = other.id;
  });
});

afterAll(async () => {
  await admin.end();
});

describe('employee directory', () => {
  it('lists employees in the tenant with their joined org data', async () => {
    const { employees, total } = await withOrg(orgA, (tx) => svc.listEmployees(tx));
    expect(total).toBe(3);
    expect(employees.map((e) => e.email)).toEqual([
      'ceo@acme.test',
      'manager@acme.test',
      'employee@acme.test',
    ]);
    const robin = employees.find((e) => e.email === 'employee@acme.test')!;
    expect(robin.manager_name).toBe('Morgan Manager');
    expect(robin.department_name).toBe('Finance');
    expect(robin.role_label).toBe('Employee');
  });

  it('searches by name, email and title', async () => {
    const byName = await withOrg(orgA, (tx) => svc.listEmployees(tx, { search: 'morgan' }));
    expect(byName.employees.map((e) => e.email)).toEqual(['manager@acme.test']);
    const byTitle = await withOrg(orgA, (tx) => svc.listEmployees(tx, { search: 'analyst' }));
    expect(byTitle.employees.map((e) => e.email)).toEqual(['employee@acme.test']);
  });

  it('another tenant sees only its own employees', async () => {
    const { employees, total } = await withOrg(orgB, (tx) => svc.listEmployees(tx));
    expect(total).toBe(1);
    expect(employees[0].email).toBe('someone@globex.test');
  });

  it('the same email may exist in two different tenants', async () => {
    const created = await withOrg(orgB, (tx) => svc.createEmployee(tx, { email: 'ceo@acme.test' }));
    expect(created.email).toBe('ceo@acme.test');
    await withOrg(orgB, (tx) => tx.query('DELETE FROM app_user WHERE id = $1', [created.id]));
  });

  it('rejects a duplicate email inside one tenant', async () => {
    await expect(
      withOrg(orgA, (tx) => svc.createEmployee(tx, { email: 'CEO@acme.test' })),
    ).rejects.toMatchObject({ code: 'EMAIL_TAKEN' });
  });
});

describe('reporting structure', () => {
  it('resolves direct reports', async () => {
    const reports = await withOrg(orgA, (tx) => svc.getDirectReports(tx, manager.id));
    expect(reports.map((r) => r.email)).toEqual(['employee@acme.test']);
  });

  it('resolves the manager chain nearest-first', async () => {
    const chain = await withOrg(orgA, (tx) => svc.getManagerChain(tx, report.id));
    expect(chain.map((c) => c.email)).toEqual(['manager@acme.test', 'ceo@acme.test']);
    expect(chain.map((c) => c.depth)).toEqual([1, 2]);
  });

  it('rejects a manager from another tenant', async () => {
    await expect(
      withOrg(orgA, (tx) => svc.updateEmployee(tx, report.id, { managerId: otherOrgEmployeeId })),
    ).rejects.toMatchObject({ code: 'MANAGER_NOT_FOUND' });
  });

  it('rejects a manager assignment that would create a cycle', async () => {
    await expect(
      withOrg(orgA, (tx) => svc.updateEmployee(tx, ceo.id, { managerId: report.id })),
    ).rejects.toMatchObject({ code: 'MANAGER_CYCLE' });
  });

  it('clears a manager when the patch sets it to null', async () => {
    const cleared = await withOrg(orgA, async (tx) => {
      const updated = await svc.updateEmployee(tx, report.id, { managerId: null });
      await svc.updateEmployee(tx, report.id, { managerId: manager.id }); // restore
      return updated;
    });
    expect(cleared.manager_id).toBeNull();
  });
});

describe('deactivation', () => {
  it('refuses to deactivate an employee who still has direct reports', async () => {
    await expect(
      withOrg(orgA, (tx) => svc.deactivateEmployee(tx, manager.id)),
    ).rejects.toMatchObject({ code: 'HAS_DIRECT_REPORTS' });
  });

  it('refuses to let an admin deactivate themselves', async () => {
    await expect(
      withOrg(orgA, (tx) => svc.deactivateEmployee(tx, ceo.id, { actingEmployeeId: ceo.id })),
    ).rejects.toMatchObject({ code: 'SELF_DEACTIVATE' });
  });

  it('deactivates and reassigns reports, then hides the row from the directory', async () => {
    const result = await withOrg(orgA, async (tx) => {
      const deactivated = await svc.deactivateEmployee(tx, manager.id, {
        actingEmployeeId: ceo.id,
        reassignReportsTo: ceo.id,
      });
      const reassigned = await svc.getEmployee(tx, report.id);
      const visible = await svc.listEmployees(tx);
      const withDeactivated = await svc.listEmployees(tx, { includeDeactivated: true });
      return {
        status: deactivated.employee_status,
        deletedAt: deactivated.deleted_at,
        newManagerId: reassigned!.manager_id,
        visible: visible.employees.map((e) => e.email),
        all: withDeactivated.total,
      };
    });

    expect(result.status).toBe('DEACTIVATED');
    expect(result.deletedAt).not.toBeNull();
    expect(result.newManagerId).toBe(ceo.id);
    expect(result.visible).toEqual(['ceo@acme.test', 'employee@acme.test']);
    expect(result.all).toBe(3);
  });

  it('reactivating through update clears the soft-delete stamp', async () => {
    const reactivated = await withOrg(orgA, (tx) =>
      svc.updateEmployee(tx, manager.id, { employeeStatus: 'ACTIVE' }),
    );
    expect(reactivated.employee_status).toBe('ACTIVE');
    expect(reactivated.deleted_at).toBeNull();
  });
});

describe('the role a person is given (w4-10b)', () => {
  const EXECUTIVE = '019e3000-0000-7000-8000-000000000007';

  it('is one of this tenant’s active roles, or nothing at all', async () => {
    const onlyB = (
      await withOrg(orgB, (tx) => tx.query(`INSERT INTO role (label) VALUES ('{"en":"B only"}') RETURNING id`))
    ).rows[0].id as string;
    for (const roleId of ['not-a-role', '019e3000-0000-7000-8000-0000000000ff', onlyB]) {
      await expect(
        withOrg(orgA, (tx) => svc.createEmployee(tx, { email: `x-${roleId}@acme.test`, roleId })),
      ).rejects.toMatchObject({ code: 'INVALID_ROLE' });
    }
    await withOrg(orgA, (tx) => tx.query(`UPDATE role SET active = false WHERE id = $1`, [EXECUTIVE]));
    try {
      await expect(
        withOrg(orgA, (tx) => svc.createEmployee(tx, { email: 'exec@acme.test', roleId: EXECUTIVE })),
      ).rejects.toMatchObject({ code: 'INVALID_ROLE' });
    } finally {
      await withOrg(orgA, (tx) => tx.query(`UPDATE role SET active = true WHERE id = $1`, [EXECUTIVE]));
    }
  });

  it('defaults to Employee, and an unchanged role is kept on save even once deactivated', async () => {
    const person = await withOrg(orgA, (tx) => svc.createEmployee(tx, { email: 'role-default@acme.test' }));
    expect(person.role_label).toBe('Employee');

    const exec = await withOrg(orgA, (tx) =>
      svc.updateEmployee(tx, person.id, { roleId: EXECUTIVE }, { actor: ceo }),
    );
    expect(exec.role_label).toBe('Executive');

    await withOrg(orgA, (tx) => tx.query(`UPDATE role SET active = false WHERE id = $1`, [EXECUTIVE]));
    try {
      const saved = await withOrg(orgA, (tx) =>
        svc.updateEmployee(tx, person.id, { roleId: EXECUTIVE, title: 'Chief of Staff' }),
      );
      expect(saved.role_id).toBe(EXECUTIVE);
      // …and a deactivated role grants nothing.
      expect(saved.role_permissions).toEqual([]);
    } finally {
      await withOrg(orgA, (tx) => tx.query(`UPDATE role SET active = true WHERE id = $1`, [EXECUTIVE]));
    }
  });
});

/**
 * w4-10d — ExpenseOS's role-change guards (`users.setRole`), on the employee form's update,
 * and the last-admin count on deactivation (VeloExpense). The CEO is the tenant's only
 * System Administrator here.
 */
describe('changing a role (w4-10d)', () => {
  const ADMIN = '019e3000-0000-7000-8000-000000000001';
  const EXECUTIVE = '019e3000-0000-7000-8000-000000000007';
  const refusal = (p: Promise<unknown>) =>
    p.then(
      () => 'OK',
      (e: { code?: string }) => e.code ?? String(e),
    );
  /** The person as they are now, with their role's permissions (the acting side of a change). */
  const fresh = (email: string) => withOrg(orgA, (tx) => svc.getEmployeeByEmail(tx, email));

  it('names the employee form’s permission as the admin screens do (lib/auth/actor.ts)', async () => {
    const { VELOEXPENSE_ADMIN_PERMISSION } = await import('@/lib/auth/actor');
    expect(svc.EMPLOYEE_FORM_PERMISSION).toBe(VELOEXPENSE_ADMIN_PERMISSION);
  });

  it('needs to know who is changing it', async () => {
    await expect(withOrg(orgA, (tx) => svc.updateEmployee(tx, report.id, { roleId: EXECUTIVE }))).rejects.toThrow(
      /acting employee/,
    );
  });

  it('will not demote the last active System Administrator, nor deactivate them', async () => {
    const boss = (await fresh('ceo@acme.test'))!;
    const deputy = await withOrg(orgA, (tx) => svc.createEmployee(tx, { email: 'deputy@acme.test', roleId: ADMIN }));
    const deputyRow = (await fresh('deputy@acme.test'))!;
    // With a second admin, the deputy can step down…
    expect(await refusal(withOrg(orgA, (tx) => svc.updateEmployee(tx, deputy.id, { roleId: EXECUTIVE }, { actor: boss })))).toBe('OK');
    // …but now the CEO is the last one: no demotion, by anyone, themselves included.
    expect(
      await refusal(withOrg(orgA, (tx) => svc.updateEmployee(tx, boss.id, { roleId: EXECUTIVE }, { actor: boss }))),
    ).toBe('LAST_ADMIN');
    // Nor deactivation through the form's status, or through deactivate.
    expect(
      await refusal(withOrg(orgA, (tx) => svc.updateEmployee(tx, boss.id, { employeeStatus: 'DEACTIVATED' }, { actor: deputyRow }))),
    ).toBe('LAST_ADMIN');
    expect(
      await refusal(withOrg(orgA, (tx) => svc.deactivateEmployee(tx, boss.id, { actingEmployeeId: deputy.id, reassignReportsTo: null }))),
    ).toBe('LAST_ADMIN');
    expect((await fresh('ceo@acme.test'))!.role_id).toBe(ADMIN);
    await admin.query(`DELETE FROM app_user WHERE email = 'deputy@acme.test'`);
  });

  it('will not let somebody give themselves a role without the employee form’s permission', async () => {
    const boss = (await fresh('ceo@acme.test'))!;
    await withOrg(orgA, (tx) => svc.createEmployee(tx, { email: 'second-admin@acme.test', roleId: ADMIN }));
    try {
      expect(
        await refusal(withOrg(orgA, (tx) => svc.updateEmployee(tx, boss.id, { roleId: EXECUTIVE }, { actor: boss }))),
      ).toBe('ROLE_SELF_LOCKOUT');
    } finally {
      await admin.query(`DELETE FROM app_user WHERE email = 'second-admin@acme.test'`);
    }
  });

  it('will not hand out a role granting more than the giver holds', async () => {
    // A custom role that opens the admin screens but holds little else.
    const narrow = (
      await withOrg(orgA, (tx) =>
        tx.query(`INSERT INTO role (label, permissions) VALUES ('{"en":"People admin"}', $1) RETURNING id`, [
          [svc.EMPLOYEE_FORM_PERMISSION],
        ]),
      )
    ).rows[0].id as string;
    const boss = (await fresh('ceo@acme.test'))!;
    await withOrg(orgA, (tx) => svc.updateEmployee(tx, manager.id, { roleId: narrow }, { actor: boss }));
    const peopleAdmin = (await fresh('manager@acme.test'))!;
    try {
      expect(
        await refusal(withOrg(orgA, (tx) => svc.updateEmployee(tx, report.id, { roleId: ADMIN }, { actor: peopleAdmin }))),
      ).toBe('ROLE_ABOVE_GRANTOR');
      // Their own role, or one within it, is fine.
      expect(
        await refusal(withOrg(orgA, (tx) => svc.updateEmployee(tx, report.id, { roleId: narrow }, { actor: peopleAdmin }))),
      ).toBe('OK');
      expect((await fresh('employee@acme.test'))!.role_id).toBe(narrow);
    } finally {
      await admin.query(`UPDATE app_user SET role_id = '019e3000-0000-7000-8000-000000000004' WHERE id = ANY($1::uuid[])`, [
        [manager.id, report.id],
      ]);
      await admin.query(`DELETE FROM role WHERE id = $1`, [narrow]);
    }
  });
});

/**
 * w4-10f — "Deactivated" on the employee form is a deactivation. It used to change the label
 * only: `deleted_at` stayed null, and sign-in, `requireActor` and the seat meter all read
 * `deleted_at`, so the person kept signing in. 0071 stamps the rows written before the fix.
 */
describe('setting the status on the form (w4-10f)', () => {
  const fresh = (email: string) => withOrg(orgA, (tx) => svc.getEmployeeByEmail(tx, email));

  it('deactivates for real: stamped, and refused at the door', async () => {
    const boss = (await fresh('ceo@acme.test'))!;
    const p = await withOrg(orgA, (tx) => svc.createEmployee(tx, { email: 'leaver@acme.test' }));
    const after = await withOrg(orgA, (tx) =>
      svc.updateEmployee(tx, p.id, { employeeStatus: 'DEACTIVATED' }, { actor: boss }),
    );
    expect(after.employee_status).toBe('DEACTIVATED');
    expect(after.deleted_at).not.toBeNull();
    const { requireActor } = await import('@/lib/auth/actor');
    await expect(withOrg(orgA, (tx) => requireActor(tx, 'leaver@acme.test'))).rejects.toMatchObject({
      code: 'DEACTIVATED',
    });

    // ON LEAVE brings them back as much as ACTIVE does: a member again, with a seat.
    const back = await withOrg(orgA, (tx) =>
      svc.updateEmployee(tx, p.id, { employeeStatus: 'ON_LEAVE' }, { actor: boss }),
    );
    expect(back).toMatchObject({ employee_status: 'ON_LEAVE', deleted_at: null });
  });

  it('takes the Deactivate button’s guards: not yourself, and nobody still reporting to them', async () => {
    const boss = (await fresh('ceo@acme.test'))!;
    const self = (await fresh('employee@acme.test'))!;
    await expect(
      withOrg(orgA, (tx) => svc.updateEmployee(tx, self.id, { employeeStatus: 'DEACTIVATED' }, { actor: self })),
    ).rejects.toMatchObject({ code: 'SELF_DEACTIVATE' });
    // A lead with somebody reporting to them: the form cannot say where that person goes.
    const lead = await withOrg(orgA, (tx) => svc.createEmployee(tx, { email: 'lead@acme.test' }));
    await withOrg(orgA, (tx) => svc.createEmployee(tx, { email: 'led@acme.test', managerId: lead.id }));
    await expect(
      withOrg(orgA, (tx) => svc.updateEmployee(tx, lead.id, { employeeStatus: 'DEACTIVATED' }, { actor: boss })),
    ).rejects.toMatchObject({ code: 'HAS_DIRECT_REPORTS' });
    expect((await fresh('lead@acme.test'))!.deleted_at).toBeNull();
  });

  it('0071 stamps the people the form "deactivated" before this fix, and only them', async () => {
    const { readFileSync } = await import('node:fs');
    const sql = readFileSync('prisma/migrations/0071_employee_status_deleted_at/migration.sql', 'utf8');
    const stuck = await withOrg(orgA, (tx) => svc.createEmployee(tx, { email: 'stuck@acme.test' }));
    await admin.query(
      `UPDATE app_user SET employee_status = 'DEACTIVATED', updated_at = '2026-10-01T12:00:00Z' WHERE id = $1`,
      [stuck.id],
    );
    await admin.query(sql);
    const rows = (
      await admin.query(
        `SELECT email, deleted_at FROM app_user WHERE email IN ('stuck@acme.test', 'employee@acme.test') ORDER BY email`,
      )
    ).rows;
    expect(rows).toEqual([
      { email: 'employee@acme.test', deleted_at: null },
      { email: 'stuck@acme.test', deleted_at: new Date('2026-10-01T12:00:00Z') },
    ]);
  });
});

