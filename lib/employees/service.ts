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
import type { QueryRunner } from '@/lib/db/client';
import type { UserMessage } from '@/lib/errors/domain';
import type { UserMessageCode } from '@/lib/i18n/catalog/errors';
import { DomainError } from '@/lib/errors/domain';
import { ORG } from '@/lib/tenant/sql';


/** Max levels walked when resolving a manager chain (also the cycle backstop). */
/**
 * How far any manager-chain walk may climb. Exported because VX2-2's resolver
 * needs the SAME bound — a second copy is how the four-copies drift in
 * GAP-AUDIT AP-12 starts. ExpenseOS uses 20 here too, independently.
 */
export const MAX_CHAIN_DEPTH = 20;

export type EmployeeRole = 'EMPLOYEE' | 'MANAGER' | 'ADMIN';
export type EmployeeStatus = 'ACTIVE' | 'ON_LEAVE' | 'DEACTIVATED';

export const EMPLOYEE_ROLES: EmployeeRole[] = ['EMPLOYEE', 'MANAGER', 'ADMIN'];
export const EMPLOYEE_STATUSES: EmployeeStatus[] = ['ACTIVE', 'ON_LEAVE', 'DEACTIVATED'];

export interface EmployeeRow {
  id: string;
  email: string;
  display_name: string | null;
  title: string | null;
  role: EmployeeRole;
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
  role?: EmployeeRole;
  managerId?: string | null;
  departmentId?: string | null;
  businessUnitId?: string | null;
  legalEntityId?: string | null;
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
      | 'INVALID_STATUS',
    userMessage: UserMessageCode | UserMessage | null = null,
  ) {
    super(message, userMessage);
    this.name = 'EmployeeError';
  }
}

// Split into columns / FROM so listEmployees can inject its COUNT(*) OVER()
// window column without splicing text after the JOINs.
const EMPLOYEE_COLUMNS = `
  u.id, u.email, u.display_name, u.title, u.role, u.employee_status,
  u.manager_id, m.display_name AS manager_name, m.email AS manager_email,
  u.department_id, d.name AS department_name,
  u.business_unit_id, bu.name AS business_unit_name,
  u.legal_entity_id, le.name AS legal_entity_name,
  u.deleted_at, u.created_at, u.updated_at`;

const EMPLOYEE_FROM = `
  FROM app_user u
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
): Promise<Array<Pick<EmployeeRow, 'id' | 'email' | 'display_name' | 'title' | 'role'> & { depth: number }>> {
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
     SELECT u.id, u.email, u.display_name, u.title, u.role, c.depth
       FROM chain c JOIN app_user u ON u.id = c.id
      WHERE c.depth > 0
      ORDER BY c.depth`,
    [employeeId, maxDepth],
  );
  return r.rows;
}

/* ── writes ────────────────────────────────────────────────────────────────── */

function assertRole(role: string | null | undefined) {
  if (role != null && !EMPLOYEE_ROLES.includes(role as EmployeeRole)) {
    throw new EmployeeError(`invalid role: ${role}`, 'INVALID_ROLE',
      'ROLE_UNKNOWN',
    );
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
  assertRole(input.role);
  assertStatus(input.employeeStatus);
  if (input.managerId) await assertManagerInOrg(tx, input.managerId);

  const existing = await tx.query('SELECT id FROM app_user WHERE lower(email) = lower($1)', [input.email]);
  if (existing.rows.length > 0) {
    throw new EmployeeError('an employee with that email already exists', 'EMAIL_TAKEN',
      'EMAIL_TAKEN',
    );
  }

  const r = await tx.query(
    `INSERT INTO app_user
       (organization_id, email, display_name, title, role, employee_status,
        manager_id, department_id, business_unit_id, legal_entity_id)
     VALUES (${ORG}, $1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id`,
    [
      input.email,
      input.displayName ?? null,
      input.title ?? null,
      input.role ?? 'EMPLOYEE',
      input.employeeStatus ?? 'ACTIVE',
      input.managerId ?? null,
      input.departmentId ?? null,
      input.businessUnitId ?? null,
      input.legalEntityId ?? null,
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
): Promise<EmployeeRow> {
  const current = await getEmployee(tx, employeeId);
  if (!current) throw new EmployeeError('employee not found', 'NOT_FOUND');

  assertRole(patch.role);
  assertStatus(patch.employeeStatus);

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
  if ('role' in patch) put('role', patch.role);
  if ('managerId' in patch) put('manager_id', patch.managerId ?? null);
  if ('departmentId' in patch) put('department_id', patch.departmentId ?? null);
  if ('businessUnitId' in patch) put('business_unit_id', patch.businessUnitId ?? null);
  if ('legalEntityId' in patch) put('legal_entity_id', patch.legalEntityId ?? null);
  if ('employeeStatus' in patch) {
    put('employee_status', patch.employeeStatus);
    // Reactivating clears the soft-delete stamp; anything else leaves it alone.
    if (patch.employeeStatus === 'ACTIVE') sets.push('deleted_at = NULL');
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

export async function listDepartments(tx: QueryRunner) {
  const r = await tx.query('SELECT id, name, parent_department_id FROM department ORDER BY name');
  return r.rows as Array<{ id: string; name: string; parent_department_id: string | null }>;
}

export async function listBusinessUnits(tx: QueryRunner) {
  const r = await tx.query('SELECT id, name FROM business_unit ORDER BY name');
  return r.rows as Array<{ id: string; name: string }>;
}

export async function listLegalEntities(tx: QueryRunner) {
  const r = await tx.query('SELECT id, name, country, currency_code FROM legal_entity ORDER BY name');
  return r.rows as Array<{ id: string; name: string; country: string | null; currency_code: string | null }>;
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
  return {
    departments,
    businessUnits,
    legalEntities,
    managers: managers.rows as Array<{ id: string; email: string; display_name: string | null }>,
  };
}
