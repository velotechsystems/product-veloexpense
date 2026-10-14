/**
 * w4-10b (d73, d74) — the tenant's roles, as VeloExpense's own screens need them: the role
 * pickers on the employee and invite forms, and the check that a role being handed out is
 * one of this tenant's and active.
 *
 * The roles themselves are ExpenseOS's (`role`, 0068): the six system roles every tenant
 * holds, plus — with the Role Builder (w4-10c) — any the tenant builds. RLS confines every
 * read to the caller's organization; the explicit `organization_id = current org` is the
 * same filter, written down so the query reads true on its own. Labels are read whole and
 * the English one taken here.
 */
import type { QueryRunner } from '@/lib/db/client';
import { SYSTEM_ROLE_IDS } from '@expenseos/rbac';
import { ORG } from '@/lib/tenant/sql';

/** The tenant's Employee role — the default role (0069), ExpenseOS's SYSTEM_ROLE_IDS.employee. */
export const DEFAULT_ROLE_ID = '019e3000-0000-7000-8000-000000000004';

export interface RoleOption {
  id: string;
  /** The English label: VeloExpense is English-only for now (fr-CA is carried, switched off). */
  name: string;
  active: boolean;
}

/** A row as a picker option: the English label (the label is `{ en, fr-CA }`, 0068). */
function option(row: { id: string; label: Record<string, string> | null; active: boolean }): RoleOption {
  return { id: row.id, name: row.label?.en ?? '', active: row.active };
}

/** System roles first, in the order of their fixed ids; every other role by name. */
function sortedByName(rows: RoleOption[]): RoleOption[] {
  const system = new Set(Object.values(SYSTEM_ROLE_IDS));
  const sys = rows.filter((r) => system.has(r.id));
  const custom = rows.filter((r) => !system.has(r.id)).sort((a, b) => a.name.localeCompare(b.name));
  return [...sys, ...custom];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Every role in the tenant, system roles first, then by name — for a picker. */
export async function listRoleOptions(tx: QueryRunner): Promise<RoleOption[]> {
  const r = await tx.query(
    `SELECT id, label, active FROM role WHERE organization_id = ${ORG} ORDER BY is_system DESC, id`,
  );
  return sortedByName(r.rows.map(option));
}

/**
 * The role if it is this tenant's AND active, else null. A deactivated role grants nothing
 * (ExpenseOS's loader), so handing one out would lock the person out in a way the screen
 * does not show. Anything that is not a UUID is no role at all.
 */
export async function assignableRole(tx: QueryRunner, roleId: string): Promise<RoleOption | null> {
  if (!UUID.test(roleId)) return null;
  const r = await tx.query(
    `SELECT id, label, active FROM role WHERE organization_id = ${ORG} AND id = $1::uuid AND active`,
    [roleId],
  );
  return r.rows[0] ? option(r.rows[0]) : null;
}
