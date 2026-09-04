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
 * BUDGETS — per-account budgets, their rollup, and threshold alerts.
 *
 * Made available by VX4-5 part 3b, which is when it acquired an administrative
 * surface to gate. Parts 1 and 2 shipped the schema and the rollup with the
 * module still declared unavailable, which was a gap rather than a decision:
 * `0025` closed the data-plane half by putting `app_module_enabled('budgets')`
 * into every budget table's RLS policy, and these gates are the other half.
 *
 * NOTE WHAT IS *NOT* GATED, because it is the interesting part. The rollup and
 * the snapshot loader run inside `submitReport` and every approval decision — for
 * EVERY tenant, whether or not they have budgets. A `requireModule` there would
 * throw in the middle of a submit for every tenant without the module, which is
 * a gate breaking an unrelated feature: the same shape as `accountForCategory`
 * being exempt in ACCOUNTING. Under `0025` those functions simply find no rows
 * and no-op, which is the fail-closed answer with no code branch to forget.
 */
const BUDGETS: ModuleDefinition = {
  code: 'budgets',
  name: 'Budgets',
  description:
    'Per-account budgets with periods, a stored rollup, overage warnings on a report, ' +
    'and threshold alerts to the budget owner. Without this module reports still go ' +
    'through policy, approval and reimbursement; nothing is measured against a budget.',
  available: true,
  gates: [
    'lib/budgets/admin.ts#createBudget',
    'lib/budgets/admin.ts#updateBudget',
    'lib/budgets/admin.ts#deleteBudget',
    'lib/budgets/admin.ts#seedMonthlyPeriods',
    'lib/budgets/admin.ts#addThreshold',
    'lib/budgets/admin.ts#removeThreshold',
    'lib/budgets/admin.ts#addRecipient',
    'lib/budgets/admin.ts#removeRecipient',
  ],
  ungated: {
    'lib/budgets/admin.ts#listBudgets':
      'read: the screen renders its own module-off state around this, and a gated ' +
      'read would make an off module indistinguishable from a tenant with no budgets',
    'lib/budgets/admin.ts#getBudget': 'read: wraps listBudgets, same reasoning',
    'lib/budgets/admin.ts#percentToBp':
      'pure: parses a percentage into basis points and touches no tenant data at all',
    'lib/budgets/service.ts#recomputeForReport':
      'runs inside submitReport, recallReport and every approval decision, for EVERY ' +
      'tenant — gating it would throw mid-submit for tenants without budgets. 0025 ' +
      'makes the rows unreachable instead, so it finds nothing and no-ops',
    'lib/budgets/service.ts#loadBudgetSnapshots':
      'runs inside validateReport on every save, for every tenant — same reasoning ' +
      'as recomputeForReport, and the same fail-closed answer from RLS',
    'lib/budgets/alerts.ts#fireThresholdAlerts':
      'called only from recomputeForReport, which is itself reached on every ' +
      'tenant\'s submit; it reads budget rows that RLS has already made empty',
  },
};

/**
 * ANALYTICS — spend summarised over a bounded range, in the tenant's own currency.
 *
 * Made available by VX4-6a. Unlike BUDGETS this needs no RLS backstop, because
 * analytics OWNS NO TABLES: it reads the expense loop's rows, which are already
 * tenant-scoped and already gated where they belong. So the module gate here is
 * on the READ, and that is the right shape for once — a tenant without analytics
 * has no analytics screen at all, and the screen renders its own off-state from
 * the ungated `isModuleEnabled`, exactly as the chart-of-accounts screen does.
 *
 * AN-2/3/5/9 are the reason there is nothing else to gate: their four
 * cross-tenant leaks are all "the privileged case is the absence of a predicate",
 * and RLS supplies the predicate below every query here.
 */
const ANALYTICS: ModuleDefinition = {
  code: 'analytics',
  name: 'Analytics',
  description:
    'Spend summarised by month, category, GL account, department, business unit and ' +
    'submitter, over a range you choose. Without this module every report still goes ' +
    'through policy, approval and reimbursement; nothing is aggregated.',
  available: true,
  gates: ['lib/analytics/service.ts#spendSummary'],
  ungated: {},
};

/**
 * COMPLIANCE — Module 12: the retrospective fraud rules (VX4-8 part 2) and, next,
 * the periodic control evaluation.
 *
 * ── WHY THIS IS A MODULE AND NOT ALWAYS ON ─────────────────────────────────
 *
 * Everything under it is RETROSPECTIVE. A tenant without it still gets policy at
 * submit, approval routing, and every gate that refuses something in the moment;
 * what they do not get is a queue of findings about what already happened. That
 * is a coherent product for a ten-person company and an obviously-wanted one for
 * a regulated finance team, which is the test for whether something should be a
 * module rather than a setting.
 *
 * It is also the module GAP-AUDIT predicted this ticket would need: upstream runs
 * both slices as unconditional global crons (MT-5) driven by a global `SystemFlag`
 * (MT-2), so every tenant gets everybody's schedule and everybody's thresholds.
 *
 * ── ONE GATE, ON THE SCAN ──────────────────────────────────────────────────
 *
 * `runFraudScan` is the only writer and the only entry point, so it is the only
 * thing gated. The detectors in `lib/fraud/rules.ts` are exported for tests and
 * for the scan; they only READ, over rows RLS already scopes to the tenant, and
 * gating each one would be four copies of a check that the single caller already
 * makes — MT-3 in the other direction.
 */
const COMPLIANCE: ModuleDefinition = {
  code: 'compliance',
  name: 'Compliance',
  description:
    'Retrospective fraud detection: duplicate charges, unusual amounts, reports that ' +
    'trip policy repeatedly, and approvals concentrated on one pair of people. Findings ' +
    'go to a review queue — nothing is blocked, refused or reported to anybody ' +
    'automatically. Without this module every report still goes through policy and ' +
    'approval; nothing is looked at again afterwards.',
  available: true,
  gates: ['lib/fraud/scan.ts#runFraudScan'],
  ungated: {},
};

/**
 * The two the Plan names and nothing implements. Declared, unavailable, and
 * gating nothing — see the header on why they are here at all.
 */
const DECLARED_ONLY: ModuleDefinition[] = [
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

const MODULES: ModuleDefinition[] = [ACCOUNTING, BUDGETS, ANALYTICS, COMPLIANCE, ...DECLARED_ONLY];

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
