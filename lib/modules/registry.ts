/**
 * VX4-1 — the module catalogue, owned by CODE.
 *
 * ── Why a registry and not a table ─────────────────────────────────────────
 *
 * Identical reasoning to `lib/integrations/registry.ts`, and to `0016`'s note on
 * `integration_slug`: a build either contains the code that serves a module or it
 * does not, and a database row cannot make it true. `module_entitlement` records
 * what a TENANT is entitled to; this file records what this BUILD can serve. The
 * service is where the two meet.
 *
 * This module is deliberately PURE — no `pg` import, no database access — so it
 * can be read by a guard script, a test, or a page without a connection. The
 * house rule that keeps `lib/integrations/registry.ts` importable applies here.
 *
 * ── `available` is the dormant-QuickBooks pattern ──────────────────────────
 *
 * Four of the five modules the Plan names for Phase 4 do not exist yet. They are
 * declared anyway, with `available: false`, because the alternative is discovering
 * the shape of the entitlement system on the morning somebody builds Budgets —
 * which is the argument VX3-8 made for registering QuickBooks dormant. An
 * unavailable module cannot be enabled (`setEntitlement` refuses it) and cannot
 * gate anything, so declaring it costs nothing and documents the intent.
 */

export interface ModuleDefinition {
  /** Stored in `module_entitlement.module_code`. Stable forever once shipped. */
  code: string;
  name: string;
  description: string;
  /**
   * False while this build cannot serve the module. It is then visible on the
   * admin screen as "not in this build" and refused by `setEntitlement`.
   */
  available: boolean;
  /**
   * The service functions this module gates, as `<file>#<export>`. THIS IS THE
   * LIST THE GUARD ENUMERATES — `scripts/check-module-gates.mjs` fails the build
   * when an exported function in one of these files is neither listed here nor
   * listed in `ungated` with a reason.
   *
   * The list exists because GAP-AUDIT MT-3 is the defect to avoid: ExpenseOS
   * gates at the edge, so 30 of 40 routers are ungated and a page can be gated
   * while the data behind it is not. A gate you have to remember is a gate
   * somebody forgets; a gate an enumerating guard checks is not.
   */
  gates: string[];
  /**
   * Exports in those same files that are deliberately NOT gated, each with the
   * reason. Same shape as the vendor guard's ALLOWED set, and for the same
   * purpose: an exemption that has to be written down is an exemption somebody
   * has to justify.
   */
  ungated: Record<string, string>;
}

/**
 * ACCOUNTING — the chart of accounts, integrations and the posting queue.
 *
 * The only module with anything to gate today, which is why it is the one this
 * ticket proves the mechanism on. Everything Phase 3 built lives here.
 */
const ACCOUNTING: ModuleDefinition = {
  code: 'accounting',
  name: 'Accounting integrations',
  description:
    'A chart of accounts, a connected ledger, and approved reports posted to it. ' +
    'Without this module a report still goes through approval and reimbursement; ' +
    'nothing is drafted anywhere.',
  available: true,
  gates: [
    'lib/accounts/service.ts#instantiateTemplate',
    'lib/accounts/service.ts#importFromCsv',
    'lib/accounts/service.ts#createAccount',
    'lib/accounts/service.ts#renameAccount',
    'lib/accounts/service.ts#deactivateAccount',
    'lib/accounts/service.ts#reactivateAccount',
    'lib/accounts/service.ts#removeAccount',
    'lib/accounts/service.ts#setCategoryAccount',
    'lib/accounts/pull.ts#pullChartOfAccounts',
    'lib/integrations/service.ts#installIntegration',
    'lib/integrations/service.ts#updateInstallation',
    'lib/integrations/service.ts#disconnect',
    'lib/integrations/service.ts#testInstallation',
    'lib/integrations/service.ts#resolveCapability',
  ],
  ungated: {
    // ── READS a screen needs in order to say "this module is off" ────────────
    //
    // A gated read would make the module-off state indistinguishable from an
    // empty chart, which is the AC-22 mistake: the screen must be able to say
    // WHY it is empty, and it cannot do that if asking is itself refused.
    'lib/accounts/service.ts#listAccounts': 'read: the screen renders the off-state around it',
    'lib/accounts/service.ts#listPostableAccounts': 'read: same as listAccounts',
    'lib/accounts/service.ts#listTemplates': 'read: names templates, touches no tenant data',
    'lib/accounts/service.ts#listCategoryMappings': 'read: the screen renders the off-state around it',
    'lib/accounts/service.ts#accountForCategory':
      'read, and called from the POLICY engine on every report — gating it would ' +
      'make an unrelated module fail. The posting path is gated at resolveCapability.',
    'lib/integrations/service.ts#listInstallations': 'read: the screen renders the off-state around it',
    'lib/integrations/service.ts#availableAdapters': 'read: registry only, no tenant data',
    'lib/integrations/service.ts#getInstallation': 'read: used by gated callers after their own check',
    'lib/integrations/service.ts#auditSecrets': 'diagnostic: must work regardless, or a leak hides behind a toggle',
    // ── Wrappers whose gate lives one call down ─────────────────────────────
    'lib/integrations/service.ts#requireCapability': 'wraps resolveCapability, which is gated',
    'lib/integrations/service.ts#capabilityAvailability': 'wraps resolveCapability, which is gated',
    'lib/accounts/pull.ts#pullFromLedger': 'wraps pullChartOfAccounts, which is gated',
  },
};

/**
 * The four the Plan names and nothing implements. Declared, unavailable, and
 * gating nothing — see the header on why they are here at all.
 */
const DECLARED_ONLY: ModuleDefinition[] = [
  {
    code: 'budgets',
    name: 'Budgets',
    description: 'Per-account budgets with periods, thresholds and overage warnings.',
    available: false,
    gates: [],
    ungated: {},
  },
  {
    code: 'analytics',
    name: 'Analytics',
    description: 'Spend dashboards and period comparisons.',
    available: false,
    gates: [],
    ungated: {},
  },
  {
    code: 'travel',
    name: 'Travel',
    description: 'Travel requests, itineraries and trip-linked expenses.',
    available: false,
    gates: [],
    ungated: {},
  },
  {
    code: 'virtual_cards',
    name: 'Virtual cards',
    description: 'Issued cards, transactions and card-to-expense matching.',
    available: false,
    gates: [],
    ungated: {},
  },
];

const MODULES: ModuleDefinition[] = [ACCOUNTING, ...DECLARED_ONLY];

/** Every declared module, available or not. Stable order, for a screen. */
export function listModules(): ModuleDefinition[] {
  return MODULES;
}

/** The definition for a code, or null when this build does not have it. */
export function moduleFor(code: string): ModuleDefinition | null {
  return MODULES.find((m) => m.code === code) ?? null;
}

/** Modules this build can actually serve. */
export function availableModules(): ModuleDefinition[] {
  return MODULES.filter((m) => m.available);
}

/** Codes only, for a guard or a test that does not need the rest. */
export function moduleCodes(): string[] {
  return MODULES.map((m) => m.code);
}
