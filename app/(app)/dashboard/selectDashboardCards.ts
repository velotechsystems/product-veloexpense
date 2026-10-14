import { permissions as P } from '@expenseos/rbac';

/**
 * Which module-bound cards the dashboard shows, decided from two inputs and nothing else.
 *
 * WHY THIS IS A PURE FUNCTION IN ITS OWN FILE, and not three `&&`s inline in `page.tsx`:
 *
 *   1. The dashboard MAY NOT 404 on a module gate. `requireActiveModule` is
 *      `if (!(await isModuleActive(db, slug))) notFound()` — correct on `/travel`, fatal
 *      here, because this is the post-login landing page. Calling it for `travel` would
 *      return 404 for the whole first screen of every workspace that has not installed
 *      travel. So the dashboard reads `activeModuleSlugs()` (a set, no control flow) and
 *      decides visibility, never reachability.
 *
 *   2. "Mount the card and let the query fail quietly" does not work either. Every travel
 *      procedure sits behind the `moduleActive('travel')` tRPC middleware, and that
 *      middleware THROWS `FORBIDDEN` — it does not return empty. A mounted card would
 *      paint a red error panel on the landing page of every travel-off customer. The same
 *      is true of `withPermission(...)`, which throws in exactly the same way — so a
 *      PERMISSION a card's procedures require is as much a gate as a module is, and
 *      `showExpenses` below carries one of each.
 *
 *   3. The only place the module-inactive case can be tested is here. Playwright cannot
 *      reach it: `bootstrapModuleInstallations()` skips any module that already has an
 *      installation row (`if (module.installations.length > 0) continue`), so once travel
 *      is deactivated in a seeded database no boot ever reactivates it. The table test
 *      beside this file is therefore the whole coverage story for that branch, and it is
 *      exhaustive over the inputs on purpose.
 *
 * DEPENDENCY DIRECTION. Core may depend on a module's *contract* — a slug string — never on
 * its implementation. These two literals are that contract, and this file is the single
 * obvious place a deleted module breaks the dashboard's compile.
 */

/** Module slugs the dashboard's own gating depends on. Contract, not implementation. */
export const TRAVEL_MODULE = 'travel';
export const EXPENSE_MODULE = 'expense-management';

export interface DashboardCardInput {
  /** Slugs of every installed + active module, from `activeModuleSlugs(db)`. */
  activeModules: ReadonlySet<string>;
  /** The reader's resolved permissions, from `resolveRbacUser(db, ...)`. */
  permissions: readonly string[];
}

export interface DashboardCards {
  /** The travel card, which deep-links to `/travel`. */
  showTravel: boolean;
  /** The approvals card, whose rows deep-link into `/expenses/approvals`. */
  showApprovals: boolean;
  /** The reader's own reports, whose rows deep-link into `/expenses/<id>`. */
  showExpenses: boolean;
}

export function selectDashboardCards({
  activeModules,
  permissions,
}: DashboardCardInput): DashboardCards {
  const has = (p: string) => permissions.includes(p);

  return {
    /**
     * Mirrors `travel/page.tsx` EXACTLY — module active AND (create-own OR approve).
     * It has to: the card deep-links there, and a card whose destination 404s is worse
     * than no card at all. Widen one side and you ship a dead link; narrow one side and
     * you hide a page the reader can open from the sidebar.
     */
    showTravel:
      activeModules.has(TRAVEL_MODULE) &&
      (has(P.travel.request.createOwn) || has(P.travel.request.approve)),

    /**
     * DELIBERATELY NARROWER than `expenses/approvals/page.tsx`, which also admits
     * `reimburse` and `readAll`. A reimburse-only AP clerk can open the inbox but gets no
     * dashboard card, because the card is about work waiting on *your decision* and an AP
     * clerk's queue is not that. This is intended, not an oversight — do not widen it.
     *
     * The module clause is not optional. Without it the card renders on a workspace with
     * expense management switched off and every row links into a 404.
     */
    showApprovals: activeModules.has(EXPENSE_MODULE) && has(P.expense.report.approve),

    /**
     * BOTH CLAUSES ARE REQUIRED, AND THEY COME FROM DIFFERENT MECHANISMS. That is what
     * makes this predicate unlike the two above, where one fact — a module that is off —
     * explains every failure. Here the module is a ROUTE GUARD and the permission is a
     * tRPC MIDDLEWARE, and each one independently ruins the card without the other.
     *
     *   · THE MODULE CLAUSE, because of where the card LINKS. `expenses/page.tsx:19` opens
     *     with `requireActiveModule('expense-management')`, which is `notFound()`. Every
     *     row's title is an `<a>` to `/expenses/<id>` and the footer is an `<a>` to
     *     `/expenses`, so on a workspace where an admin has switched expense management off
     *     — a supported act, from `ModulesAdmin` — the card is a set of 404s on the
     *     post-login landing page. This is the identical rule `showApprovals` states above.
     *
     *   · THE PERMISSION CLAUSE, because of what the card FETCHES. It issues
     *     `expenses.list` — its only query since the header badge that read
     *     `expenses.summaryOwn` was removed — and that sits behind
     *     `withPermission(P.expense.report.readOwn)`, which THROWS `FORBIDDEN` — it does
     *     not return an empty list. A reader without that permission gets the card's
     *     `common.panelUnavailable` panel, with a Retry that can never succeed, on the
     *     first screen after signing in.
     *
     * The permission clause looks dead and is not. Every SYSTEM role holds `readOwn` —
     * `collectEmployeeBase()` grants it, `flatten(P.expense)` covers admin and expense
     * administrator — which is exactly why no Playwright actor can reach the FORBIDDEN
     * branch and why the E2E role matrix structurally cannot catch its absence. Roles
     * authored in the Role Builder are admin-composed and unconstrained: a reviewer role
     * built without `expense.report.readOwn` is an ordinary thing to author, and it is the
     * reader this clause exists for. The truth table beside this file is its only coverage.
     */
    showExpenses: activeModules.has(EXPENSE_MODULE) && has(P.expense.report.readOwn),
  };
}
