/**
 * VX4-9 — the admin gate: the predicate, and what a refusal tells a person.
 *
 * Own org slug ('gate-co'); the DB suites share one database and each TRUNCATEs
 * (vitest.config.ts, fileParallelism: false).
 *
 * ── WHAT IS AND IS NOT TESTABLE HERE ────────────────────────────────────────
 *
 * `asAdmin`, `asAdminPage` and `asMember` all begin with `auth()`, and this
 * project mocks nothing — no suite in `test/` calls `vi.mock`, on purpose. So
 * the wrappers themselves are covered where a session actually exists:
 * `e2e/crawl.spec.ts` loads all fifteen admin pages as an ADMIN, a MANAGER and
 * an EMPLOYEE and asserts a 403 with the refusal screen for the last two.
 *
 * What is testable — and is the half no browser test can reach — is underneath:
 *
 *   · the PREDICATE, including the clause that is easy to lose (`deleted_at`).
 *   · that each refusal carries reader copy, so `errorParam` emits a sentence
 *     rather than logging the diagnostic and showing "something went wrong on
 *     our side". That generic was what a manager got from every admin FORM
 *     before this ticket, and it is not visible from the page crawl at all: a
 *     refused person never sees the form, so only a direct test gets here.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { withOrg } from '@/lib/tenant/context';
import { ForbiddenError, isActiveAdmin, requireActor } from '@/lib/auth/actor';
import { errorParam, userMessageOf } from '@/lib/errors/domain';
import { renderUserMessage } from '@/lib/i18n/catalog/errors';
import { getEmployeeByEmail, type EmployeeRow } from '@/lib/employees/service';

const admin = new Pool({
  connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL,
});

let orgId: string;

const EMAILS = {
  admin: 'boss@gate.test',
  deletedAdmin: 'exboss@gate.test',
  manager: 'manager@gate.test',
  employee: 'staff@gate.test',
} as const;

const rowFor = (email: string) =>
  withOrg(orgId, async (tx) => {
    // w4-10b: the row as the gate reads it — with its role's permissions (lib/employees/service).
    return (await getEmployeeByEmail(tx, email)) as EmployeeRow;
  });

beforeAll(async () => {
  await admin.query('TRUNCATE app_user, organization CASCADE');
  const o = await admin.query(
    "INSERT INTO organization (slug, name) VALUES ('gate-co','Gate Co') RETURNING id",
  );
  orgId = o.rows[0].id;
  await withOrg(orgId, async (tx) => {
    for (const [email, role] of [
      [EMAILS.admin, 'ADMIN'],
      [EMAILS.deletedAdmin, 'ADMIN'],
      [EMAILS.manager, 'MANAGER'],
      [EMAILS.employee, 'EMPLOYEE'],
    ] as const) {
      await tx.query(
        `INSERT INTO app_user (organization_id, email, display_name, role_id)
         VALUES ($1, $2, $3, $4)`,
        [orgId, email, email.split('@')[0], role === 'ADMIN' ? '019e3000-0000-7000-8000-000000000001' : '019e3000-0000-7000-8000-000000000004'],
      );
    }
    // Soft-deleted, which is how this product deactivates somebody (VX1-2): the
    // row stays and keeps its role.
    await tx.query('UPDATE app_user SET deleted_at = now() WHERE email = $1', [
      EMAILS.deletedAdmin,
    ]);
  });
});

afterAll(async () => {
  await admin.end();
});

describe('the admin predicate', () => {
  it('admits an active ADMIN and nobody else', async () => {
    expect(isActiveAdmin(await rowFor(EMAILS.admin))).toBe(true);
    expect(isActiveAdmin(await rowFor(EMAILS.manager))).toBe(false);
    expect(isActiveAdmin(await rowFor(EMAILS.employee))).toBe(false);
  });

  /**
   * The clause worth its own test. Deactivating an administrator does not clear
   * their role, so a predicate on `role` alone would remove them from the
   * directory and leave them administering the tenant. Read from a real row
   * rather than a hand-built object precisely because `deleted_at` is a column
   * a hand-built object is free to forget.
   */
  it('refuses a DEACTIVATED admin, whose row still holds System Administrator', async () => {
    const row = await rowFor(EMAILS.deletedAdmin);
    // w4-10b: the role still grants the admin permission; only `deleted_at` refuses.
    expect(row.role_label).toBe('System Administrator');
    expect(row.role_permissions).toContain('admin.appSettings.update');
    expect(row.deleted_at).not.toBeNull();
    expect(isActiveAdmin(row)).toBe(false);
  });
});

describe('the admin predicate is a permission, not a role name (w4-10b, d74)', () => {
  /**
   * VeloExpense's own admin screens ask for `admin.appSettings.update` — the permission the
   * menu already showed them for. So the predicate follows the ROLE ROW: a custom role given
   * the permission opens them, and System Administrator without it does not.
   */
  it('admits a custom role that carries the admin permission', async () => {
    const custom = (
      await withOrg(orgId, (tx) =>
        tx.query(
          `INSERT INTO role (label, permissions) VALUES ('{"en":"Office Manager"}', ARRAY['admin.appSettings.update'])
           RETURNING id`,
        ),
      )
    ).rows[0].id as string;
    await withOrg(orgId, (tx) =>
      tx.query(`UPDATE app_user SET role_id = $1 WHERE email = $2`, [custom, EMAILS.employee]),
    );
    try {
      expect(isActiveAdmin(await rowFor(EMAILS.employee))).toBe(true);
      // And not while the role is deactivated: a deactivated role grants nothing.
      await withOrg(orgId, (tx) => tx.query(`UPDATE role SET active = false WHERE id = $1`, [custom]));
      expect(isActiveAdmin(await rowFor(EMAILS.employee))).toBe(false);
    } finally {
      await withOrg(orgId, async (tx) => {
        await tx.query(`UPDATE app_user SET role_id = '019e3000-0000-7000-8000-000000000004' WHERE email = $1`, [
          EMAILS.employee,
        ]);
        await tx.query(`DELETE FROM role WHERE id = $1`, [custom]);
      });
    }
  });

  it('refuses System Administrator once the permission is taken off it', async () => {
    const ADMIN_ID = '019e3000-0000-7000-8000-000000000001';
    await withOrg(orgId, (tx) =>
      tx.query(`UPDATE role SET permissions = array_remove(permissions, 'admin.appSettings.update') WHERE id = $1`, [
        ADMIN_ID,
      ]),
    );
    try {
      expect(isActiveAdmin(await rowFor(EMAILS.admin))).toBe(false);
    } finally {
      await withOrg(orgId, (tx) =>
        tx.query(`UPDATE role SET permissions = array_append(permissions, 'admin.appSettings.update') WHERE id = $1`, [
          ADMIN_ID,
        ]),
      );
    }
    expect(isActiveAdmin(await rowFor(EMAILS.admin))).toBe(true);
  });
});

describe('requireActor — the membership half', () => {
  it('returns the row for a member', async () => {
    const actor = await withOrg(orgId, (tx) => requireActor(tx, EMAILS.manager));
    expect(actor.email).toBe(EMAILS.manager);
    // w4-10b: MANAGER was Employee's stand-in; the role is the row now.
    expect(actor.role_label).toBe('Employee');
  });

  it('refuses somebody with no row in this tenant, and says so readably', async () => {
    const err = await withOrg(orgId, (tx) =>
      requireActor(tx, 'nobody@gate.test').then(
        () => null,
        (e: unknown) => e,
      ),
    );
    expect(err).toBeInstanceOf(ForbiddenError);
    expect((err as ForbiddenError).code).toBe('NOT_A_MEMBER');
    // The diagnostic is unchanged — tests and logs still read it.
    expect((err as ForbiddenError).message).toContain('no employee record');
    // And the person now gets a sentence instead of the generic.
    expect(userMessageOf(err)).toEqual({ code: 'NOT_A_MEMBER_HERE' });
  });

  it('refuses a deactivated account with a DIFFERENT code and sentence', async () => {
    const err = await withOrg(orgId, (tx) =>
      requireActor(tx, EMAILS.deletedAdmin).then(
        () => null,
        (e: unknown) => e,
      ),
    );
    expect(err).toBeInstanceOf(ForbiddenError);
    expect((err as ForbiddenError).code).toBe('DEACTIVATED');
    expect(userMessageOf(err)).toEqual({ code: 'ACCOUNT_DEACTIVATED' });
  });
});

describe('what a refused person is told', () => {
  /**
   * The write path's half of VX4-9, and the reason `ForbiddenError` carries a
   * message code at all. Before this ticket the fifteen copies threw a bare
   * `Error('forbidden: admin role required')`; `errorParam` refuses to put a
   * bare Error on a screen (IL-11, correctly), so it logged it and emitted
   * `UNEXPECTED` — telling a manager who submitted an admin form that the
   * product had broken.
   */
  it.each([
    ['ADMIN_ONLY', new ForbiddenError('admin role required', 'NOT_AN_ADMIN', 'ADMIN_ONLY')],
    [
      'NOT_A_MEMBER_HERE',
      new ForbiddenError('no employee record', 'NOT_A_MEMBER', 'NOT_A_MEMBER_HERE'),
    ],
    ['SIGN_IN_REQUIRED', new ForbiddenError('unauthenticated', 'UNAUTHENTICATED', 'SIGN_IN_REQUIRED')],
  ])('%s reaches the screen as itself, not as the generic', (code, err) => {
    expect(errorParam(err, 'test')).toBe(code);
    const sentence = renderUserMessage(code as never, 'en-CA');
    expect(sentence).toBeTruthy();
    expect(sentence).not.toMatch(/something went wrong/i);
    // No identifier in reader copy — part 2c's rule, restated as an assertion
    // because these three are new sentences.
    expect(sentence).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/i);
  });

  /**
   * A bare Error still becomes the generic, and that is correct — asserted so
   * that the fix cannot be misread as "any thrown string is now shown".
   */
  it('leaves a bare Error as the generic', () => {
    expect(errorParam(new Error('forbidden: admin role required'), 'test')).toBe('UNEXPECTED');
  });
});
