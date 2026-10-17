/**
 * VX1-2 — employees & org service (Module 2).
 *
 * Same shape as lib/expenses/service.ts: pure functions over a tenant
 * QueryRunner. The caller (a server action) has already opened the transaction
 * via withCurrentOrg(), so app.current_org is set and RLS scopes every row —
 * including the joined department / business_unit / legal_entity / manager rows,
 * which are tenant tables too. No query here filters by organization_id by hand;
 * that is RLS's job.
 *
 * ExpenseOS is the behavioral spec, re-implemented tenant-scoped: list, get,
 * getDirectReports, manager-chain resolve, create, update, deactivate.
 */
import { COUNTRY_CODES } from '@/lib/countries';
import type { QueryRunner } from '@/lib/db/client';
import type { UserMessage } from '@/lib/errors/domain';
import type { UserMessageCode } from '@/lib/i18n/catalog/errors';
import { DomainError } from '@/lib/errors/domain';
import { ORG } from '@/lib/tenant/sql';
import { assertSeatAvailable } from '@/lib/billing/caps';
import { permissions as P, SYSTEM_ROLE_IDS } from '@expenseos/rbac';
import {
  aboveGrantorSample,
  assignableRole,
  DEFAULT_ROLE_ID,
  listRoleOptions,
  permissionsAboveGrantor,
} from '@/lib/roles/service';


/** Max levels walked when resolving a manager chain (also the cycle backstop). */
/**
 * How far any manager-chain walk may climb. Exported because VX2-2's resolver
 * needs the SAME bound — a second copy is how the four-copies drift in
 * GAP-AUDIT AP-12 starts. ExpenseOS uses 20 here too, independently.
 */
export const MAX_CHAIN_DEPTH = 20;

/** ExpenseOS's EmployeeStatus; People 1 (0072) added TERMINATED to the column's CHECK. */
export type EmployeeStatus = 'ACTIVE' | 'ON_LEAVE' | 'DEACTIVATED' | 'TERMINATED';

/**
 * What THIS screen's form offers. TERMINATED (0072) is left out on purpose: this service
 * stamps `deleted_at` only for DEACTIVATED (w4-10f), so offering TERMINATED here would let
 * a terminated person keep signing in. ExpenseOS's offboarding writes it, with People 3.
 */
export const EMPLOYEE_STATUSES: EmployeeStatus[] = ['ACTIVE', 'ON_LEAVE', 'DEACTIVATED'];

/** Every value the column holds (0072's CHECK), which the copy catalogue must cover. */
export const ALL_EMPLOYEE_STATUSES: EmployeeStatus[] = [...EMPLOYEE_STATUSES, 'TERMINATED'];

export interface EmployeeRow {
  id: string;
  email: string;
  display_name: string | null;
  title: string | null;
  /**
   * w4-10b (d73, d74): the person's role — the tenant's `role` row (0068) — with its English
   * label and, for the access predicates (`lib/auth/actor.ts`), its permissions: none while
   * the role is deactivated, as ExpenseOS's loader answers. Replaces the text role (0069).
   */
  role_id: string;
  role_label: string;
  role_permissions: string[];
  employee_status: EmployeeStatus;
  manager_id: string | null;
  manager_name: string | null;
  manager_email: string | null;
  department_id: string | null;
  department_name: string | null;
  business_unit_id: string | null;
  business_unit_name: string | null;
  legal_entity_id: string | null;
  legal_entity_name: string | null;
  /** w2-10: ISO-3166-1 alpha-2 — ExpenseOS's `User.country`, read by mileage pricing. */
  country: string | null;
  /** People 1 (0072): may this person sign in at all. `requireActor` refuses without it. */
  has_access: boolean;
  deleted_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface EmployeeListFilter {
  /** Matches email, display name or title (case-insensitive substring). */
  search?: string | null;
  departmentId?: string | null;
  businessUnitId?: string | null;
  status?: EmployeeStatus | null;
  /** Deactivated employees are hidden unless this is true. */
  includeDeactivated?: boolean;
  limit?: number;
  offset?: number;
}

export interface NewEmployee {
  email: string;
  displayName?: string | null;
  title?: string | null;
  /** The tenant's role (0068). Absent on a new person means the database default, Employee. */
  roleId?: string;
  managerId?: string | null;
  departmentId?: string | null;
  businessUnitId?: string | null;
  legalEntityId?: string | null;
  /**
   * w2-10: ISO-3166-1 alpha-2. On a NEW person, absent means "their legal entity's
   * country" — what 0055 backfilled everybody with, so a person added later is priced the
   * same way as one who was here before it. An explicit null leaves it empty.
   */
  country?: string | null;
  employeeStatus?: EmployeeStatus;
}

export type EmployeePatch = Partial<NewEmployee>;

/** Thrown for rule violations the UI should surface as a message, not a 500. */
export class EmployeeError extends DomainError {
  constructor(
    message: string,
    readonly code:
      | 'EMAIL_TAKEN'
      | 'NOT_FOUND'
      | 'MANAGER_NOT_FOUND'
      | 'MANAGER_CYCLE'
      | 'SELF_DEACTIVATE'
      | 'HAS_DIRECT_REPORTS'
      | 'INVALID_ROLE'
      | 'INVALID_STATUS'
      | 'INVALID_COUNTRY'
      // w4-10d: ExpenseOS's three role-change guards (`users.setRole`).
      | 'LAST_ADMIN'
      | 'ROLE_SELF_LOCKOUT'
      | 'ROLE_ABOVE_GRANTOR',
    userMessage: UserMessageCode | UserMessage | null = null,
  ) {
    super(message, userMessage);
    this.name = 'EmployeeError';
  }
}

// Split into columns / FROM so listEmployees can inject its COUNT(*) OVER()
// window column without splicing text after the JOINs.
const EMPLOYEE_COLUMNS = `
  u.id, u.email, u.display_name, u.title,
  u.role_id, r.label ->> 'en' AS role_label,
  CASE WHEN r.active THEN r.permissions ELSE ARRAY[]::text[] END AS role_permissions,
  u.employee_status,
  u.manager_id, m.display_name AS manager_name, m.email AS manager_email,
  u.department_id, d.label ->> 'en' AS department_name,
  u.business_unit_id, bu.label ->> 'en' AS business_unit_name,
  u.legal_entity_id, le.label ->> 'en' AS legal_entity_name,
  u.country,
  u.has_access,
  u.deleted_at, u.created_at, u.updated_at`;

const EMPLOYEE_FROM = `
  FROM app_user u
  JOIN      role          r  ON r.organization_id = u.organization_id AND r.id = u.role_id
  LEFT JOIN app_user      m  ON m.id  = u.manager_id
  LEFT JOIN department    d  ON d.id  = u.department_id
  LEFT JOIN business_unit bu ON bu.id = u.business_unit_id
  LEFT JOIN legal_entity  le ON le.id = u.legal_entity_id`;

const SELECT_EMPLOYEE = `SELECT ${EMPLOYEE_COLUMNS} ${EMPLOYEE_FROM}`;

/* ── reads ─────────────────────────────────────────────────────────────────── */

/** Directory listing. Returns the page plus the unpaged total for the pager. */
export async function listEmployees(
  tx: QueryRunner,
  filter: EmployeeListFilter = {},
): Promise<{ employees: EmployeeRow[]; total: number }> {
  const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
  const offset = Math.max(filter.offset ?? 0, 0);
  const search = filter.search?.trim() ? filter.search.trim() : null;

  const r = await tx.query(
    `SELECT ${EMPLOYEE_COLUMNS}, COUNT(*) OVER() AS total_count
     ${EMPLOYEE_FROM}
      WHERE ($1::boolean OR u.deleted_at IS NULL)
        AND ($2::text IS NULL OR u.employee_status = $2::text)
        AND ($3::uuid IS NULL OR u.department_id = $3::uuid)
        AND ($4::uuid IS NULL OR u.business_unit_id = $4::uuid)
        AND ($5::text IS NULL OR u.email ILIKE '%' || $5 || '%'
                              OR u.display_name ILIKE '%' || $5 || '%'
                              OR u.title ILIKE '%' || $5 || '%')
      ORDER BY COALESCE(u.display_name, u.email)
      LIMIT $6 OFFSET $7`,
    [
      filter.includeDeactivated ?? false,
      filter.status ?? null,
      filter.departmentId ?? null,
      filter.businessUnitId ?? null,
      search,
      limit,
      offset,
    ],
  );
  const total = r.rows.length > 0 ? Number(r.rows[0].total_count) : 0;
  return { employees: r.rows as EmployeeRow[], total };
}

/**
 * A record id that is not a uuid is NOT FOUND, not a crash.
 *
 * VX5-3 found this by deleting `/admin/employees/new`: the path then fell
 * through to `/admin/employees/[employeeId]` with `employeeId = 'new'`, Postgres
 * answered `invalid input syntax for type uuid`, and the page rendered a 500.
 * The static route had been hiding it, but the defect was general — any
 * hand-edited or stale id in that URL did the same thing, and had since VX1-2.
 *
 * That is VX4-9's lesson arriving from a different direction: a refusal that
 * looks like a crash buries the 500s that mean something, and monitoring cannot
 * tell "somebody followed a dead bookmark" from "the database is down".
 *
 * The guard is HERE and not on the page, for MT-3's reason — a gate at the edge
 * is a gate the next caller forgets. `getEmployee` is where every caller already
 * looks, and they all already handle `null`.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function getEmployee(tx: QueryRunner, employeeId: string): Promise<EmployeeRow | null> {
  if (!UUID.test(employeeId)) return null;
  const r = await tx.query(`${SELECT_EMPLOYEE} WHERE u.id = $1`, [employeeId]);
  return (r.rows[0] as EmployeeRow) ?? null;
}

/** Used by the server-action layer to resolve the acting user from the session. */
export async function getEmployeeByEmail(tx: QueryRunner, email: string): Promise<EmployeeRow | null> {
  const r = await tx.query(`${SELECT_EMPLOYEE} WHERE lower(u.email) = lower($1) LIMIT 1`, [email]);
  return (r.rows[0] as EmployeeRow) ?? null;
}

/** Direct reports of one employee (active by default). */
export async function getDirectReports(
  tx: QueryRunner,
  managerId: string,
  opts: { includeDeactivated?: boolean } = {},
): Promise<EmployeeRow[]> {
  const r = await tx.query(
    `${SELECT_EMPLOYEE}
      WHERE u.manager_id = $1 AND ($2::boolean OR u.deleted_at IS NULL)
      ORDER BY COALESCE(u.display_name, u.email)`,
    [managerId, opts.includeDeactivated ?? false],
  );
  return r.rows as EmployeeRow[];
}

/**
 * The manager chain above an employee, nearest manager first. Cycle-safe: the
 * recursive CTE carries the visited path and stops if it would revisit a node,
 * and is depth-capped regardless. The employee themselves is not included.
 */
export async function getManagerChain(
  tx: QueryRunner,
  employeeId: string,
  maxDepth: number = MAX_CHAIN_DEPTH,
): Promise<Array<Pick<EmployeeRow, 'id' | 'email' | 'display_name' | 'title' | 'role_id'> & { depth: number }>> {
  const r = await tx.query(
    `WITH RECURSIVE chain AS (
         SELECT u.id, u.manager_id, 0 AS depth, ARRAY[u.id] AS path
           FROM app_user u
          WHERE u.id = $1
         UNION ALL
         SELECT m.id, m.manager_id, c.depth + 1, c.path || m.id
           FROM chain c
           JOIN app_user m ON m.id = c.manager_id
          WHERE c.depth < $2 AND NOT (m.id = ANY(c.path))
     )
     SELECT u.id, u.email, u.display_name, u.title, u.role_id, c.depth
       FROM chain c JOIN app_user u ON u.id = c.id
      WHERE c.depth > 0
      ORDER BY c.depth`,
    [employeeId, maxDepth],
  );
  return r.rows;
}

/* ── writes ────────────────────────────────────────────────────────────────── */

/** w4-10b: a role somebody can be given — this tenant's, and active (`lib/roles/service.ts`). */
async function assertRole(tx: QueryRunner, roleId: string | null | undefined) {
  if (roleId == null) return;
  if (!(await assignableRole(tx, roleId))) {
    throw new EmployeeError(`invalid role: ${roleId}`, 'INVALID_ROLE', 'ROLE_UNKNOWN');
  }
}

/**
 * w4-10d — the permission that opens VeloExpense's admin screens, the employee form among
 * them: `VELOEXPENSE_ADMIN_PERMISSION` in lib/auth/actor.ts (d74), named here from the
 * registry because actor.ts imports this module. test/employees.db.test.ts pins the two equal.
 */
export const EMPLOYEE_FORM_PERMISSION: string = P.admin.appSettings.update;

/**
 * w4-10d — how many OTHER people hold System Administrator and are active: ExpenseOS's
 * last-admin count (`users.setRole`), over VeloExpense's columns.
 */
async function otherActiveAdmins(tx: QueryRunner, employeeId: string): Promise<number> {
  const r = await tx.query(
    `SELECT count(*)::int AS n FROM app_user
      WHERE role_id = $1::uuid AND employee_status = 'ACTIVE' AND deleted_at IS NULL AND id <> $2`,
    [SYSTEM_ROLE_IDS.admin, employeeId],
  );
  return r.rows[0].n as number;
}

/** w4-10d: refuse when this person is the tenant's last active System Administrator. */
async function assertNotLastAdmin(tx: QueryRunner, employee: EmployeeRow) {
  if (employee.role_id !== SYSTEM_ROLE_IDS.admin) return;
  if ((await otherActiveAdmins(tx, employee.id)) < 1) {
    throw new EmployeeError('Cannot demote the last active admin', 'LAST_ADMIN', 'LAST_ADMIN');
  }
}

/**
 * w4-10d — ExpenseOS's three guards on a role change (`users.setRole`, 1e682dd6), in its
 * order. VeloExpense has no users router yet (the People screen is not ported), so they sit
 * where VeloExpense changes a role: the employee form's update.
 *
 *   · last admin: "if demoting from the admin system role … refuse if the org would be left
 *     with zero active users" holding it;
 *   · self-lockout: the caller cannot change their own role to one without the permission
 *     that let them make the change — ExpenseOS's `user.setRole`; VeloExpense: the employee
 *     form's permission, `EMPLOYEE_FORM_PERMISSION`;
 *   · grant ceiling: no role carrying permissions the caller does not hold
 *     (`permissionsAboveGrantor`, lib/roles/service.ts).
 */
async function assertRoleChange(
  tx: QueryRunner,
  current: EmployeeRow,
  role: { id: string; permissions: readonly string[] },
  actor: EmployeeRow,
) {
  if (current.role_id === SYSTEM_ROLE_IDS.admin && role.id !== SYSTEM_ROLE_IDS.admin) {
    await assertNotLastAdmin(tx, current);
  }
  if (current.id === actor.id && !role.permissions.includes(EMPLOYEE_FORM_PERMISSION)) {
    throw new EmployeeError(
      'Cannot change your own role to one without the permission to manage employees',
      'ROLE_SELF_LOCKOUT',
      'ROLE_SELF_LOCKOUT',
    );
  }
  const escalating = permissionsAboveGrantor(role, actor.role_permissions);
  if (escalating.length > 0) {
    const sample = aboveGrantorSample(escalating);
    throw new EmployeeError(
      `Cannot assign a role with permissions you do not hold: ${sample}`,
      'ROLE_ABOVE_GRANTOR',
      { code: 'ROLE_ABOVE_GRANTOR', params: { permissions: sample } },
    );
  }
}

/** w2-10: an assigned ISO-3166-1 alpha-2 code, or nothing. The table's CHECK holds the
 *  shape; this holds the list, and says so in a sentence rather than as a 500. */
function assertCountry(country: string | null | undefined) {
  if (country != null && !(COUNTRY_CODES as readonly string[]).includes(country)) {
    throw new EmployeeError(`invalid country: ${country}`, 'INVALID_COUNTRY', 'COUNTRY_UNKNOWN');
  }
}

function assertStatus(status: string | null | undefined) {
  if (status != null && !EMPLOYEE_STATUSES.includes(status as EmployeeStatus)) {
    throw new EmployeeError(`invalid employee status: ${status}`, 'INVALID_STATUS',
      'EMPLOYEE_STATUS_UNKNOWN',
    );
  }
}

/**
 * A manager must resolve inside the tenant. RLS already makes a manager in
 * another org invisible, so a plain SELECT is the whole check — it returns no
 * row, and we reject.
 */
async function assertManagerInOrg(tx: QueryRunner, managerId: string) {
  const r = await tx.query('SELECT id FROM app_user WHERE id = $1 AND deleted_at IS NULL', [managerId]);
  if (r.rows.length === 0) {
    throw new EmployeeError('manager not found in this organization', 'MANAGER_NOT_FOUND',
      'MANAGER_NOT_IN_ORG',
    );
  }
}

/** True if making `managerId` the manager of `employeeId` would close a loop. */
async function wouldCycle(tx: QueryRunner, employeeId: string, managerId: string): Promise<boolean> {
  if (employeeId === managerId) return true;
  const chain = await getManagerChain(tx, managerId);
  return chain.some((link) => link.id === employeeId);
}

export async function createEmployee(tx: QueryRunner, input: NewEmployee): Promise<EmployeeRow> {
  await assertRole(tx, input.roleId);
  assertStatus(input.employeeStatus);
  if (input.managerId) await assertManagerInOrg(tx, input.managerId);

  const existing = await tx.query('SELECT id FROM app_user WHERE lower(email) = lower($1)', [input.email]);
  if (existing.rows.length > 0) {
    throw new EmployeeError('an employee with that email already exists', 'EMAIL_TAKEN',
      'EMAIL_TAKEN',
    );
  }

  // The plan's seat cap, if one is in force — `lib/billing/caps.ts`. Here and not
  // in the invite code, because this is the one insert every way into a tenant
  // reaches.
  await assertSeatAvailable(tx);

  assertCountry(input.country);
  const r = await tx.query(
    `INSERT INTO app_user
       (organization_id, email, display_name, title, role_id, employee_status,
        manager_id, department_id, business_unit_id, legal_entity_id, country)
     VALUES (${ORG}, $1, $2, $3,
             -- w4-10b: absent = the column's default, the tenant's Employee role (0069).
             COALESCE($4::uuid, '${DEFAULT_ROLE_ID}'::uuid),
             $5, $6, $7, $8, $9,
             -- w2-10: absent = the legal entity's country (see NewEmployee.country).
             CASE WHEN $10::boolean THEN $11::text
                  ELSE (SELECT country FROM legal_entity WHERE id = $9::uuid) END)
     RETURNING id`,
    [
      input.email,
      input.displayName ?? null,
      input.title ?? null,
      input.roleId ?? null,
      input.employeeStatus ?? 'ACTIVE',
      input.managerId ?? null,
      input.departmentId ?? null,
      input.businessUnitId ?? null,
      input.legalEntityId ?? null,
      'country' in input,
      input.country ?? null,
    ],
  );
  return (await getEmployee(tx, r.rows[0].id))!;
}

/**
 * Patch semantics: only keys present on `patch` are written, and an explicit
 * null clears the column (COALESCE-style patching cannot express "unset the
 * manager", which the directory needs).
 */
export async function updateEmployee(
  tx: QueryRunner,
  employeeId: string,
  patch: EmployeePatch,
  /** w4-10d: who makes the change — required to change a role (ExpenseOS's guards read it). */
  opts: { actor?: EmployeeRow } = {},
): Promise<EmployeeRow> {
  const current = await getEmployee(tx, employeeId);
  if (!current) throw new EmployeeError('employee not found', 'NOT_FOUND');

  // An unchanged role is not re-checked: a person may still hold a role that has since been
  // deactivated, and saving their record should not be refused for it.
  if (patch.roleId != null && patch.roleId !== current.role_id) {
    await assertRole(tx, patch.roleId);
    // w4-10d: a role change names who makes it, so ExpenseOS's guards always run — a caller
    // that cannot say is a bug, not a change to let through.
    if (!opts.actor) throw new Error('updateEmployee: a role change needs the acting employee');
    const role = await assignableRole(tx, patch.roleId);
    await assertRoleChange(tx, current, role!, opts.actor);
  }
  // w4-10f: DEACTIVATED through the form IS a deactivation — before this, it changed the
  // label and nothing else: `deleted_at` stayed null, and sign-in, `requireActor`, the admin
  // gate and the seat meter all read `deleted_at`, so a person shown as deactivated kept
  // signing in and acting. It now takes `deactivateEmployee`'s guards (not yourself; nobody
  // reporting to them, since the form cannot say where they go; not the last admin, w4-10d)
  // and stamps `deleted_at` below. (0071 stamps the rows written before this.)
  const deactivating = patch.employeeStatus === 'DEACTIVATED' && current.deleted_at === null;
  if (deactivating) {
    if (opts.actor && opts.actor.id === employeeId) {
      throw new EmployeeError('you cannot deactivate your own account', 'SELF_DEACTIVATE',
        'DEACTIVATE_SELF',
      );
    }
    await assertNotLastAdmin(tx, current);
    const reports = await getDirectReports(tx, employeeId);
    if (reports.length > 0) {
      throw new EmployeeError(
        `${reports.length} direct report(s) still report to this employee — choose a new manager first`,
        'HAS_DIRECT_REPORTS',
        { code: 'EMPLOYEE_HAS_REPORTS', params: { count: reports.length } },
      );
    }
  }
  assertStatus(patch.employeeStatus);
  assertCountry(patch.country);

  if (patch.managerId) {
    await assertManagerInOrg(tx, patch.managerId);
    if (await wouldCycle(tx, employeeId, patch.managerId)) {
      throw new EmployeeError('that manager would create a reporting cycle', 'MANAGER_CYCLE',
      'MANAGER_CYCLE',
    );
    }
  }

  if (patch.email && patch.email.toLowerCase() !== current.email.toLowerCase()) {
    const taken = await tx.query('SELECT id FROM app_user WHERE lower(email) = lower($1) AND id <> $2', [
      patch.email,
      employeeId,
    ]);
    if (taken.rows.length > 0) {
      throw new EmployeeError('an employee with that email already exists', 'EMAIL_TAKEN',
      'EMAIL_TAKEN',
    );
    }
  }

  const values: unknown[] = [employeeId];
  const sets: string[] = [];
  const put = (column: string, value: unknown) => {
    values.push(value);
    sets.push(`${column} = $${values.length}`);
  };

  if ('email' in patch) put('email', patch.email);
  if ('displayName' in patch) put('display_name', patch.displayName ?? null);
  if ('title' in patch) put('title', patch.title ?? null);
  if (patch.roleId !== undefined) put('role_id', patch.roleId);
  if ('managerId' in patch) put('manager_id', patch.managerId ?? null);
  if ('departmentId' in patch) put('department_id', patch.departmentId ?? null);
  if ('businessUnitId' in patch) put('business_unit_id', patch.businessUnitId ?? null);
  if ('legalEntityId' in patch) put('legal_entity_id', patch.legalEntityId ?? null);
  // w2-10: the person's own. Changing the legal entity does not move it (0055).
  if ('country' in patch) put('country', patch.country ?? null);
  if ('employeeStatus' in patch && patch.employeeStatus !== undefined) {
    // Reactivating a DEACTIVATED person takes a seat back — the meter counts
    // `deleted_at IS NULL` — so it is capped like a new one. Without this, a cap
    // enforced only on creation is walked round by deactivating and reactivating.
    // w4-10f: ON LEAVE is a member too (they sign in, and the meter counts them), so moving
    // a deactivated person to it is a reactivation as much as ACTIVE is.
    const reactivating = patch.employeeStatus !== 'DEACTIVATED' && current.deleted_at !== null;
    if (reactivating) await assertSeatAvailable(tx);
    put('employee_status', patch.employeeStatus);
    // w4-10f: the status and the soft-delete stamp move together — DEACTIVATED stamps it
    // (keeping an earlier stamp), any other status clears it.
    if (deactivating) sets.push('deleted_at = COALESCE(deleted_at, now())');
    if (reactivating) sets.push('deleted_at = NULL');
  }

  if (sets.length === 0) return current;

  await tx.query(`UPDATE app_user SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`, values);
  return (await getEmployee(tx, employeeId))!;
}

/**
 * Soft-deactivate. Two guards, both deliberate:
 *   - an admin cannot deactivate themselves (locks nobody out of the directory);
 *   - an employee with direct reports cannot be deactivated without saying where
 *     those reports go — `reassignReportsTo` (or null to clear their manager),
 *     so the org chart is never left pointing at a deactivated node by accident.
 */
export async function deactivateEmployee(
  tx: QueryRunner,
  employeeId: string,
  opts: { actingEmployeeId?: string; reassignReportsTo?: string | null } = {},
): Promise<EmployeeRow> {
  const employee = await getEmployee(tx, employeeId);
  if (!employee) throw new EmployeeError('employee not found', 'NOT_FOUND');
  if (opts.actingEmployeeId && opts.actingEmployeeId === employeeId) {
    throw new EmployeeError('you cannot deactivate your own account', 'SELF_DEACTIVATE',
      'DEACTIVATE_SELF',
    );
  }
  // w4-10d (VeloExpense): nor the tenant's last active System Administrator — see updateEmployee.
  if (employee.deleted_at === null) await assertNotLastAdmin(tx, employee);

  const reports = await getDirectReports(tx, employeeId);
  if (reports.length > 0) {
    if (opts.reassignReportsTo === undefined) {
      throw new EmployeeError(
        `${reports.length} direct report(s) still report to this employee — choose a new manager first`,
        'HAS_DIRECT_REPORTS',
        { code: 'EMPLOYEE_HAS_REPORTS', params: { count: reports.length } },
      );
    }
    if (opts.reassignReportsTo) {
      await assertManagerInOrg(tx, opts.reassignReportsTo);
      for (const report of reports) {
        if (await wouldCycle(tx, report.id, opts.reassignReportsTo)) {
          throw new EmployeeError('that reassignment would create a reporting cycle', 'MANAGER_CYCLE',
      'REASSIGNMENT_CYCLE',
    );
        }
      }
    }
    await tx.query('UPDATE app_user SET manager_id = $2, updated_at = now() WHERE manager_id = $1', [
      employeeId,
      opts.reassignReportsTo ?? null,
    ]);
  }

  await tx.query(
    `UPDATE app_user
        SET employee_status = 'DEACTIVATED', deleted_at = COALESCE(deleted_at, now()), updated_at = now()
      WHERE id = $1`,
    [employeeId],
  );
  return (await getEmployee(tx, employeeId))!;
}

/* ── org reference lookups (for the directory's pickers) ───────────────────── */

/** Every department with whether it is active — callers offer `activeChoices` (see
 *  `listBusinessUnits`). The name is the English one (`label`, migration 0049). */
export async function listDepartments(tx: QueryRunner) {
  const r = await tx.query(
    `SELECT id, label ->> 'en' AS name, parent_department_id, active
       FROM department
      ORDER BY lower(label ->> 'en')`,
  );
  return r.rows as Array<{
    id: string;
    name: string;
    parent_department_id: string | null;
    active: boolean;
  }>;
}

/**
 * Every business unit, with whether it is active. Since the Wave 1 port a unit is
 * deactivated rather than deleted (ExpenseOS's soft delete), and a deactivated one must
 * not be OFFERED — but a record already pointing at one must keep showing it, or the
 * form's select would fall back to "none" and a save would silently unassign it. So the
 * callers offer `active || id === current` (`activeChoices`).
 *
 * The name is the English one (`label` is `{ en, fr-CA }` JSON since migration 0047).
 */
export async function listBusinessUnits(tx: QueryRunner) {
  const r = await tx.query(
    `SELECT id, label ->> 'en' AS name, active
       FROM business_unit
      ORDER BY lower(label ->> 'en')`,
  );
  return r.rows as Array<{ id: string; name: string; active: boolean }>;
}


export { activeChoices } from './active-choices';

/** Every legal entity with whether it is active — callers offer `activeChoices` (see
 *  `listBusinessUnits`). The name is the English one (`label`, migration 0048). */
export async function listLegalEntities(tx: QueryRunner) {
  const r = await tx.query(
    `SELECT id, label ->> 'en' AS name, country, currency_code, active
       FROM legal_entity
      ORDER BY lower(label ->> 'en')`,
  );
  return r.rows as Array<{
    id: string;
    name: string;
    country: string | null;
    currency_code: string | null;
    active: boolean;
  }>;
}

/** Everything the employee form needs to render its pickers, in one round trip. */
export async function getDirectoryOptions(tx: QueryRunner) {
  // Sequential on purpose: tx is one pooled connection inside a transaction.
  const departments = await listDepartments(tx);
  const businessUnits = await listBusinessUnits(tx);
  const legalEntities = await listLegalEntities(tx);
  const managers = await tx.query(
    `SELECT id, email, display_name FROM app_user
      WHERE deleted_at IS NULL ORDER BY COALESCE(display_name, email)`,
  );
  // w4-10b: the roles a person can be given (the tenant's role rows, 0068).
  const roles = await listRoleOptions(tx);
  return {
    departments,
    businessUnits,
    legalEntities,
    managers: managers.rows as Array<{ id: string; email: string; display_name: string | null }>,
    roles,
  };
}
