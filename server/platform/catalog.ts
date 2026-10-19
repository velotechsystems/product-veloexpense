/**
 * The module descriptors the assistant describes to the model — ExpenseOS's
 * `MODULE_DESCRIPTORS` (`apps/web/src/server/platform/catalog.ts`, 1e682dd6), as far as the
 * assistant reads them.
 *
 * VeloExpense (w6-03): ExpenseOS's catalog is also the source its boot-time reconcile upserts
 * into the Module / Integration spec tables. VeloExpense has neither table — what this build
 * serves is `lib/modules/registry.ts`, and what a tenant has switched on is
 * `lib/modules/service.ts` — so only the part the assistant uses is ported: each module's
 * slug, name and description, for the system prompt's "what this workspace has" and the
 * empty state. The integration descriptors are not ported; VeloExpense's own integration
 * registry is `lib/integrations/registry.ts`.
 *
 * The slugs are ExpenseOS's, as `server/platform/modules.ts` translates them, so a tool's
 * `moduleSlug` and these descriptors agree:
 *
 *   · `virtual-credit-cards` is not here: VeloExpense has no cards (d50).
 *   · `netsuite-gl` is `ledger-gl`, renamed for the vendor guard as `modules.ts` names it.
 *   · `budgets` is VeloExpense's own module (ExpenseOS keeps budgets under finance-reporting).
 *   · `assistant` describes VeloExpense, and declares no required integration: it is CORE
 *     here, with the key from the environment (d40).
 */

export interface ModuleDescriptor {
  slug: string;
  name: { en: string; 'fr-CA': string };
  description: { en: string; 'fr-CA': string };
}

export const MODULE_DESCRIPTORS: ModuleDescriptor[] = [
  {
    slug: 'expense-management',
    name: { en: 'Expense Management', 'fr-CA': 'Gestion des dépenses' },
    description: {
      en: 'Expense reports, approvals, reimbursements, and reference data.',
      'fr-CA': 'Notes de frais, approbations, remboursements et données de référence.',
    },
  },
  {
    slug: 'travel',
    name: { en: 'Travel', 'fr-CA': 'Voyages' },
    description: {
      en: 'Pre-trip travel requests with a priced budget, approval, and conversion into an expense report.',
      'fr-CA':
        'Demandes de voyage avant départ avec budget chiffré, approbation et conversion en note de frais.',
    },
  },
  {
    slug: 'finance-reporting',
    // VeloExpense (w6-03): VeloExpense's Analytics module (`analytics`); budgets are their own.
    name: { en: 'Analytics', 'fr-CA': 'Analytique' },
    description: {
      en: 'Expense analytics: spend summarised by month, category, account, department and submitter.',
      'fr-CA':
        'Analyse des dépenses : dépenses résumées par mois, catégorie, compte, service et demandeur.',
    },
  },
  {
    // VeloExpense (w6-03): VeloExpense's own module; not in ExpenseOS's catalog.
    slug: 'budgets',
    name: { en: 'Budgets', 'fr-CA': 'Budgets' },
    description: {
      en: 'Budgets with periods, overage warnings on a report, and threshold alerts to the budget owner.',
      'fr-CA':
        'Budgets par période, avertissements de dépassement sur une note de frais et alertes de seuil au responsable du budget.',
    },
  },
  {
    slug: 'assistant',
    name: { en: 'Assistant', 'fr-CA': 'Assistant' },
    description: {
      // VeloExpense (w6-03): the product's name.
      en: 'A conversational help centre that answers questions about VeloExpense and can draft actions for you to confirm.',
      'fr-CA':
        "Un centre d'aide conversationnel qui répond aux questions sur VeloExpense et peut préparer des actions que vous confirmez.",
    },
  },
  {
    slug: 'compliance-audit',
    name: { en: 'Compliance & Audit', 'fr-CA': 'Conformité et audit' },
    description: {
      en: 'Expense policies, the tamper-evident audit trail, fraud detection, and control evaluation.',
      'fr-CA':
        'Politiques de dépenses, piste de vérification inviolable, détection de fraude et évaluation des contrôles.',
    },
  },
  {
    // VeloExpense (w6-03): ExpenseOS's `netsuite-gl`, as `modules.ts` names it — VeloExpense's
    // Accounting integrations module (`accounting`).
    slug: 'ledger-gl',
    name: { en: 'Accounting integrations', 'fr-CA': 'Intégrations comptables' },
    description: {
      en: 'A chart of accounts, a connected ledger, and approved reports posted to it.',
      'fr-CA': 'Un plan comptable, un grand livre connecté et les notes approuvées qui y sont comptabilisées.',
    },
  },
];
