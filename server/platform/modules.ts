/**
 * `isModuleActive` with ExpenseOS's signature, answered by VeloExpense's module gate.
 *
 * ExpenseOS reads its own `Module` / `ModuleInstallation` tables. VeloExpense already has a
 * module gate with three conditions that must all hold — the build serves it, the plan
 * includes it, the tenant switched it on (`lib/modules/service.ts`, `isModuleEnabled`) — so
 * ported code asks THAT, by translating ExpenseOS's slug to VeloExpense's module code.
 *
 * A slug with no VeloExpense module is OFF, which is the gate's own rule ("absence means
 * off"): a ported procedure for a feature VeloExpense does not have yet refuses rather than
 * running half-built.
 */
import { currentTenantId } from '@/lib/db/prisma';
import { isModuleEnabled } from '@/lib/modules/service';
import { withOrg } from '@/lib/tenant/context';

/**
 * ExpenseOS slug -> VeloExpense module code. `CORE` is always on: it is the product itself,
 * which VeloExpense does not gate.
 */
const CORE = Symbol('core');
export const MODULE_FOR_SLUG: Readonly<Record<string, string | typeof CORE>> = {
  'expense-management': CORE,
  travel: 'travel',
  // ExpenseOS's `netsuite-gl`, renamed for the vendor guard (as the `ledger.*` permissions
  // are); ported calls say moduleActive('ledger-gl').
  'ledger-gl': 'accounting',
  'compliance-audit': 'compliance',
  'finance-reporting': 'analytics',
  // VeloExpense-only slug: VeloExpense's budgets screen has a module of its own, where
  // ExpenseOS's budget tracking sits under finance-reporting (app/(app)/veloexpenseNav.ts).
  budgets: 'budgets',
  // Out of scope (7 Oct): virtual cards. No entry, so OFF.
  // Not yet a VeloExpense module: the assistant (Wave 6). No entry, so OFF.
};

export async function isModuleActive(_db: unknown, slug: string): Promise<boolean> {
  const code = MODULE_FOR_SLUG[slug];
  if (code === undefined) return false;
  if (code === CORE) return true;
  const orgId = currentTenantId();
  // Outside a tenant scope there is no tenant to ask about; refuse rather than guess.
  if (orgId === null) return false;
  return withOrg(orgId, (tx) => isModuleEnabled(tx, code));
}

/**
 * ExpenseOS's `activeModuleSlugs(db)`: every slug whose module is on for the current tenant,
 * for the sidebar's module gates. One transaction for all of them rather than one per slug
 * (`isModuleActive` above opens its own), since the shell asks on every page render.
 */
export async function activeModuleSlugs(_db?: unknown): Promise<Set<string>> {
  const active = new Set<string>();
  const orgId = currentTenantId();
  for (const [slug, code] of Object.entries(MODULE_FOR_SLUG)) if (code === CORE) active.add(slug);
  if (orgId === null) return active;
  await withOrg(orgId, async (tx) => {
    for (const [slug, code] of Object.entries(MODULE_FOR_SLUG)) {
      if (code !== CORE && (await isModuleEnabled(tx, code))) active.add(slug);
    }
  });
  return active;
}
