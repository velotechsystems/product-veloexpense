/**
 * VX4-1 — the gate.
 *
 * ── Where the check lives, and why not at the edge ──────────────────────────
 *
 * GAP-AUDIT MT-3 is the defect this shape exists to avoid. ExpenseOS enforces
 * modules with tRPC middleware and a server-component guard — both at the EDGE —
 * and the result is that 10 of 40 routers carry the middleware, several routers
 * whose PAGES are gated are not gated themselves, and `analytics.dashboard` is a
 * bare procedure behind a gated page. A direct call reaches the data with the
 * module switched off. That is AC-5's shape one more time: a capability taxonomy
 * that means nothing because the gate lives somewhere a caller can skip.
 *
 * So `requireModule` is called from the SERVICE layer — beside the writes, inside
 * the tenant transaction — where a page, a server action, a job and a future MCP
 * tool all pass through it. And because a gate at every entry point is a gate
 * somebody eventually forgets, `lib/modules/registry.ts` lists which exports must
 * carry it and `scripts/check-module-gates.mjs` fails the build when one does not.
 * That guard is the load-bearing half of this design: the same relationship the
 * RLS-coverage guard has with the RLS policies.
 *
 * ── What this is NOT, yet ───────────────────────────────────────────────────
 *
 * It is not enforced by the database. The stronger version extends each gated
 * table's RLS policy with `AND EXISTS (… module_entitlement … enabled)`, which no
 * code path could bypass because no code path supplies the predicate. It is the
 * right end state and it is deliberately not in this PR: a policy-level refusal
 * is SILENT — a disabled module would render as an empty chart of accounts rather
 * than as a sentence explaining why — so it belongs beside the screen work that
 * can say so, and it wants its own migration and its own test. Written down here
 * rather than left as a good intention: VX4-1 part 2.
 */
import type { QueryRunner } from '@/lib/db/client';
import { append as auditAppend, type AuditActor } from '@/lib/audit/service';
import { ModuleDisabledError } from '@/lib/modules/errors';
import { withPlatformRead } from '@/lib/tenant/context';
import { listModules, moduleFor, type ModuleDefinition } from '@/lib/modules/registry';
import { requeueWaitingPosts } from '@/lib/integrations/post-outbox';
import { ORG } from '@/lib/tenant/sql';
import { planFor } from '@/lib/billing/service';
import { planPermitsModule } from '@/lib/billing/plan-entitlement';

export { ModuleDisabledError, isModuleDisabled } from '@/lib/modules/errors';


export interface EntitlementView {
  module: ModuleDefinition;
  enabled: boolean;
  enabledAt: Date | null;
  disabledAt: Date | null;
  changedByName: string | null;
}

/**
 * Is this module on for the CURRENT tenant?
 *
 * ABSENCE MEANS OFF. A tenant with no row does not have the module — see the
 * migration's header on why the default is fail-closed rather than a `defaultOn`
 * flag in the registry. A module this build does not have is also off, which
 * matters for a downgrade: a row can outlive the code that served it.
 */
export async function isModuleEnabled(tx: QueryRunner, code: string): Promise<boolean> {
  const definition = moduleFor(code);
  if (!definition || !definition.available) return false;

  /* THREE THINGS MUST AGREE, AND THEY ARE DELIBERATELY NOT COLLAPSED.
   *
   *   1. The BUILD can serve it          — `definition.available`, above.
   *   2. The PLAN includes it            — VX5-21, here.
   *   3. The TENANT has it switched on   — `module_entitlement`, below.
   *
   * The plan is a CEILING and the entitlement row is the tenant's position under
   * it. They are ANDed rather than synced, and that choice is worth defending
   * because a sync is the obvious alternative:
   *
   *   · A sync would have to write rows, which means a downgrade silently
   *     rewrites a tenant's admin screen and an upgrade cannot put it back the
   *     way it was — the admin's own "off" is indistinguishable from the
   *     downgrade's.
   *   · A sync has to run somewhere. Every place it could run is a place it can
   *     fail to run, and a stale sync grants access the plan does not.
   *   · ANDing needs no job, no migration and no reconciliation. A plan change
   *     takes effect on the next entitlement refresh, in both directions.
   *
   * The cost is one extra indexed read per gate call, on a path whose own comment
   * promises "one indexed lookup". It is now two. That is the price of the gate
   * being correct after a downgrade, and it is worth it. */
  const plan = await planFor(tx);
  if (!planPermitsModule(plan, code)) return false;

  const r = await tx.query(
    `SELECT enabled FROM module_entitlement
      WHERE organization_id = ${ORG} AND module_code = $1`,
    [code],
  );
  return r.rows.length > 0 && r.rows[0].enabled === true;
}

/**
 * The gate itself. Throws `ModuleDisabledError`, which every caller can narrow
 * without importing this module (`lib/modules/errors.ts`).
 *
 * Called at the TOP of a gated function, before any write and before any
 * expensive read, so a refusal costs one indexed lookup.
 */
/**
 * Every organization with this module enabled, across tenants.
 *
 * FOR SCHEDULED WORK ONLY, and the shape is the point: it answers "who is
 * entitled to this", not "who exists". Reached through `withPlatformRead`, whose
 * `module_entitlement` policy (0033) is SELECT-only and matches enabled rows
 * only — so this function cannot see a disabled entitlement and cannot write.
 *
 * Every other scheduled job in this product finds its tenants by reading its own
 * due rows (`duePosts`, the notification drain). Compliance has no work table —
 * the scan IS the work — so this is the equivalent, and migration 0033 explains
 * at length why nothing needed it before.
 *
 * NOT for a request path. A screen already knows its tenant, and asking this
 * question from one would be asking it with the tenant guard switched off.
 */
export async function organizationsWithModule(code: string): Promise<string[]> {
  return withPlatformRead(async (tx) => {
    const r = await tx.query(
      `SELECT organization_id FROM module_entitlement
        WHERE module_code = $1
        ORDER BY organization_id`,
      [code],
    );
    return r.rows.map((row) => row.organization_id as string);
  });
}

export async function requireModule(tx: QueryRunner, code: string): Promise<void> {
  if (await isModuleEnabled(tx, code)) return;
  const definition = moduleFor(code);
  throw new ModuleDisabledError(code, definition?.name ?? code);
}

/**
 * Every declared module with this tenant's state — for the admin screen, which
 * has to show an unavailable module as unavailable rather than hiding it. A module
 * a customer is asking for and this build cannot serve is a sales answer, not an
 * empty list.
 */
export async function listEntitlements(tx: QueryRunner): Promise<EntitlementView[]> {
  const r = await tx.query(
    `SELECT e.module_code, e.enabled, e.enabled_at, e.disabled_at, u.display_name, u.email
       FROM module_entitlement e
       LEFT JOIN app_user u
         ON u.organization_id = e.organization_id AND u.id = e.changed_by_id
      WHERE e.organization_id = ${ORG}`,
  );
  const byCode = new Map(r.rows.map((row) => [row.module_code as string, row]));
  return listModules().map((module) => {
    const row = byCode.get(module.code);
    return {
      module,
      enabled: module.available && row?.enabled === true,
      enabledAt: (row?.enabled_at as Date | null) ?? null,
      disabledAt: (row?.disabled_at as Date | null) ?? null,
      changedByName: (row?.display_name as string | null) ?? (row?.email as string | null) ?? null,
    };
  });
}

/**
 * Turn a module on or off for the current tenant, and say so in the audit trail.
 *
 * UPSERT rather than insert-or-update-by-branch, keyed on the unique the
 * migration declares — two admins pressing the same toggle is a race worth not
 * having. `enabled_at` / `disabled_at` are stamped only on the transition that
 * matches, so re-enabling an already-enabled module does not rewrite the date a
 * customer's entitlement started.
 *
 * The audit row is appended in the SAME transaction, per VX2-6: an entitlement
 * change is a billing-relevant act, and "we cannot tell you who turned Budgets
 * on" is not an acceptable answer to a customer dispute.
 */
export async function setEntitlement(
  tx: QueryRunner,
  code: string,
  enabled: boolean,
  actor: AuditActor & { id: string },
): Promise<void> {
  const definition = moduleFor(code);
  if (!definition) {
    throw new ModuleDisabledError(code, code);
  }
  if (!definition.available && enabled) {
    // Refused for the reason `installIntegration` refuses an unknown adapter: a
    // row claiming a tenant has a module this build cannot serve is a row that
    // lies, and it would be believed by every read above.
    throw new Error(
      `${definition.name} is declared but not available in this build, so it cannot be enabled.`,
    );
  }
  if (enabled && !planPermitsModule(await planFor(tx), code)) {
    /* VX5-21. Refused for the same reason as the line above it: a row that says a
     * tenant has a module their plan does not include is a row `isModuleEnabled`
     * will read and then override, so it records something untrue and changes
     * nothing.
     *
     * This is only reachable from the admin screen, and it is the one place where
     * the plan ceiling produces a MESSAGE rather than a silent false — an admin
     * clicking a toggle deserves to be told why it did not move. `isModuleEnabled`
     * stays silent on purpose: a gated function refusing is not the place to
     * explain somebody's billing. */
    throw new Error(
      `${definition.name} is not included in this organization's plan.`,
    );
  }

  const upserted = await tx.query(
    `INSERT INTO module_entitlement
       (organization_id, module_code, enabled, enabled_at, disabled_at, changed_by_id)
     VALUES (${ORG}, $1, $2,
             CASE WHEN $2 THEN clock_timestamp() END,
             CASE WHEN $2 THEN NULL ELSE clock_timestamp() END,
             $3)
     ON CONFLICT (organization_id, module_code) DO UPDATE
        SET enabled = EXCLUDED.enabled,
            -- Only stamp the transition that actually happened. Re-enabling an
            -- already-enabled module must not move the date it started.
            enabled_at = CASE
              WHEN EXCLUDED.enabled AND NOT module_entitlement.enabled THEN clock_timestamp()
              ELSE module_entitlement.enabled_at END,
            disabled_at = CASE
              WHEN NOT EXCLUDED.enabled AND module_entitlement.enabled THEN clock_timestamp()
              ELSE module_entitlement.disabled_at END,
            changed_by_id = EXCLUDED.changed_by_id,
            updated_at = clock_timestamp()
     RETURNING id`,
    [code, enabled, actor.id],
  );

  // AC-24. Turning a module ON makes this tenant's backed-off posts due again: a
  // post skipped for a configuration reason waits an hour without burning an
  // attempt, and fixing the configuration is exactly the event that should clear
  // that wait. Here rather than in the screen's action — see the note on
  // `requeueWaitingPosts` for why that placement was a mistake worth reversing.
  if (enabled) await requeueWaitingPosts(tx);

  await auditAppend(tx, actor, {
    action: enabled ? 'MODULE_ENABLED' : 'MODULE_DISABLED',
    entityType: 'module_entitlement',
    // THE ROW ID, and the first version of this passed `null` on the reasoning
    // that the module CODE is the real identity. `append()` refused it —
    // "entityType and entityId are both required, or neither" — and the contract
    // is right: an entity type with no id is a row an auditor cannot navigate to.
    // The upsert keeps the same row across every toggle, so the id is stable and
    // the code is in `details` as well, which is what a "when did this tenant get
    // budgets" query actually filters on.
    entityId: upserted.rows[0].id as string,
    details: { moduleCode: code, moduleName: definition.name },
  });
}
