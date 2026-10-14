/**
 * w4-09 — the identity band's chips (`app/(app)/dashboard/IdentityChips.tsx`) read the
 * reader's role and department through `getIdentityProfile`, VeloExpense's stand-in for
 * ExpenseOS's `users.get`. The chips' own suite mocks that read; this proves the read
 * against a real database:
 *
 *   · the role label is VeloExpense's system-role label, in both locales, from `app_user.role`;
 *   · the department is the reader's own, with its label, or `null` without one;
 *   · it reads only the reader's tenant: another tenant's id is NOT FOUND there (RLS), and
 *     the chips catch that throw and fall back to the session.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';

vi.mock('server-only', () => ({}));

const { createOrganization } = await import('@/lib/onboarding/provision');
const { getIdentityProfile } = await import('@/app/(app)/dashboard/identityProfile');

const admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL });

let A: string;
let B: string;
let bossId: string;
let empId: string;
let otherId: string;

beforeAll(async () => {
  await admin.query('TRUNCATE invite, audit_entry, app_user, organization CASCADE');
  A = (await createOrganization({ name: 'ID A', slug: 'id-a', adminEmail: 'boss@id-a.test', adminName: 'Boss' }))
    .organizationId;
  B = (await createOrganization({ name: 'ID B', slug: 'id-b', adminEmail: 'boss@id-b.test', adminName: 'Other' }))
    .organizationId;
  bossId = (await admin.query(`SELECT id FROM app_user WHERE email = 'boss@id-a.test'`)).rows[0].id;
  otherId = (await admin.query(`SELECT id FROM app_user WHERE email = 'boss@id-b.test'`)).rows[0].id;
  const dept = (
    await admin.query(
      `INSERT INTO department (organization_id, label) VALUES ($1, '{"en":"Finance","fr-CA":"Finances"}') RETURNING id`,
      [A],
    )
  ).rows[0].id;
  empId = (
    await admin.query(
      `INSERT INTO app_user (organization_id, email, display_name, role, department_id)
       VALUES ($1, 'emp@id-a.test', 'Emp', 'EMPLOYEE', $2) RETURNING id`,
      [A, dept],
    )
  ).rows[0].id;
});

afterAll(async () => {
  await admin.end();
});

describe('getIdentityProfile', () => {
  it('reads the role label in both locales, and the department with its label', async () => {
    const me = await getIdentityProfile({ id: empId, organizationId: A });
    expect(me.role.label).toEqual({ en: 'Employee', 'fr-CA': 'Employé' });
    expect(me.department).toMatchObject({ label: { en: 'Finance', 'fr-CA': 'Finances' } });
  });

  it('answers no department for a reader without one', async () => {
    const me = await getIdentityProfile({ id: bossId, organizationId: A });
    expect(me.role.label.en).toBe('System Administrator');
    expect(me.department).toBeNull();
  });

  it('reads only the reader’s tenant', async () => {
    await expect(getIdentityProfile({ id: otherId, organizationId: A })).rejects.toThrow();
    await expect(getIdentityProfile({ id: otherId, organizationId: B })).resolves.toMatchObject({
      department: null,
    });
  });
});
