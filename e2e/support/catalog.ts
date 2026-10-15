import { readFileSync } from 'node:fs';

/**
 * The copy the specs assert on, read from the next-intl catalogs rather than pinned.
 *
 * The catalog is the source of truth; a copy edit that would turn a pinned string into a
 * false alarm turns into nothing here. A RENAMED key is the failure that should be loud, so
 * a missing key throws with its name rather than surfacing as `toHaveText(undefined)`.
 *
 * `tsconfig.e2e.json` has no `resolveJsonModule`, hence `readFileSync` + `JSON.parse`. Paths
 * are repo-relative because Playwright runs from the repo root (as `playwright.config.ts`
 * itself assumes).
 */

function load(locale: string, namespace: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(`packages/i18n/src/catalogs/${locale}/${namespace}.json`, 'utf8'),
  ) as Record<string, unknown>;
}

/** `catalog.a.b.c` as a string, or a named failure. */
function text(locale: string, namespace: string, path: string): string {
  let node: unknown = load(locale, namespace);
  for (const key of path.split('.')) {
    node = node && typeof node === 'object' ? (node as Record<string, unknown>)[key] : undefined;
  }
  if (typeof node !== 'string') {
    throw new Error(`${namespace}.${path} is missing from the ${locale} catalog`);
  }
  return node;
}

export interface CommonCopy {
  retry: string;
  offline: { title: string };
  notFound: { title: string };
}

/** `common.retry`, `common.offline.title`, `common.notFound.title`. */
export function commonCatalog(locale: string): CommonCopy {
  return {
    retry: text(locale, 'common', 'retry'),
    offline: { title: text(locale, 'common', 'offline.title') },
    notFound: { title: text(locale, 'common', 'notFound.title') },
  };
}

export interface NavCopy {
  items: { expenseReports: string; delegations: string };
}

/** `nav.items.*` — the TopBar `h1` for a route, per `ROUTE_TITLE_KEYS`. */
export function navCatalog(locale: string): NavCopy {
  return {
    items: {
      expenseReports: text(locale, 'nav', 'items.expenseReports'),
      delegations: text(locale, 'nav', 'items.delegations'),
    },
  };
}

export interface DelegationsCopy {
  /** The top bar's published control, and the create drawer's title — the same string. */
  new: string;
  form: {
    title: string;
    delegateePlaceholder: string;
    startsAt: string;
    endsAt: string;
    scope: string;
    submit: string;
  };
  status: { active: string };
}

/**
 * `/delegations`, read per locale rather than pinned.
 *
 * `e2e/delegations.mobile.spec.ts` runs BOTH locales, so this is the accessor that makes the
 * FR-CA half a real assertion instead of a second English run. Hardcoding the French strings
 * in the spec was the alternative and it is the worse one for a reason
 * `e2e/topbar-overlap.spec.ts` already records: every accented character has to be
 * precomposed NFC to match what the DOM renders, and a decomposed `e` + combining acute
 * looks identical in a source file and never matches. Reading the catalog cannot get that
 * wrong, and a renamed key throws with its name.
 */
export function delegationsCatalog(locale: string): DelegationsCopy {
  return {
    new: text(locale, 'delegations', 'new'),
    form: {
      title: text(locale, 'delegations', 'form.title'),
      delegateePlaceholder: text(locale, 'delegations', 'form.delegateePlaceholder'),
      startsAt: text(locale, 'delegations', 'form.startsAt'),
      endsAt: text(locale, 'delegations', 'form.endsAt'),
      scope: text(locale, 'delegations', 'form.scope'),
      submit: text(locale, 'delegations', 'form.submit'),
    },
    status: { active: text(locale, 'delegations', 'status.active') },
  };
}

export interface VccViewsCopy {
  /** The five system views of the card-transactions list, in the order the dropdown lists them. */
  txnList: {
    defaultView: string;
    viewPending: string;
    viewProcessing: string;
    viewPosted: string;
    viewFailed: string;
  };
}

/**
 * `vcc.txnList.*` — the saved-view names on `/virtual-cards/transactions`.
 *
 * The view dropdown's trigger is a plain `<button>` whose accessible name IS the active view's
 * name, so these strings are the only role-based handle on it. Read per locale because the
 * phone specs that switch views run in FR-CA as well as EN.
 */
export function vccViewsCatalog(locale: string): VccViewsCopy {
  return {
    txnList: {
      defaultView: text(locale, 'vcc', 'txnList.defaultView'),
      viewPending: text(locale, 'vcc', 'txnList.viewPending'),
      viewProcessing: text(locale, 'vcc', 'txnList.viewProcessing'),
      viewPosted: text(locale, 'vcc', 'txnList.viewPosted'),
      viewFailed: text(locale, 'vcc', 'txnList.viewFailed'),
    },
  };
}

export interface VccSyncCopy {
  /** `vcc.syncState.*` — the badge on a charge, and the label of a `sync` filter pill. */
  syncState: { pending: string; synced: string; reconciled: string; posted: string };
  /** The notice beside a `?txn=` link the active view leaves out, and its way out. */
  txnList: { deepLinkNotInView: string; showAll: string };
}

/**
 * The sync-state copy of `/virtual-cards/transactions`: what a charge's badge says, what a
 * `sync` pill says, and the "not in this view" notice.
 *
 * Kept apart from `vccViewsCatalog` on purpose. `e2e/support/vcc.ts` builds its view-trigger
 * locator from EVERY string in that one's `txnList`, so a button label such as "Show all
 * transactions" added there would be taken for a view name.
 */
export function vccSyncCatalog(locale: string): VccSyncCopy {
  return {
    syncState: {
      pending: text(locale, 'vcc', 'syncState.pending'),
      synced: text(locale, 'vcc', 'syncState.synced'),
      reconciled: text(locale, 'vcc', 'syncState.reconciled'),
      posted: text(locale, 'vcc', 'syncState.posted'),
    },
    txnList: {
      deepLinkNotInView: text(locale, 'vcc', 'txnList.deepLinkNotInView'),
      showAll: text(locale, 'vcc', 'txnList.showAll'),
    },
  };
}

export interface ApprovalsCopy {
  /** `expenses.approvals.*` — the approver's controls. The drawer and the workbench share them. */
  approve: string;
  reject: string;
  return: string;
  confirmReject: string;
  confirmReturn: string;
  rejectNotePlaceholder: string;
  returnNotePlaceholder: string;
}

/**
 * The approver's decide controls, per locale.
 *
 * One set of keys serves both trees an approver can decide in — the phone drawer
 * (`ApproverReportDrawer.tsx`) and the report page (`ExpenseReportWorkbench.tsx`) — so a
 * spec that drives either reads the same strings. FR-CA is the reason this exists rather than
 * a literal "Approve": the deep-link spec lands an approver on the report page in both
 * locales, and an English literal there would make the FR-CA half a second English run.
 */
export function approvalsCatalog(locale: string): ApprovalsCopy {
  return {
    approve: text(locale, 'expenses', 'approvals.approve'),
    reject: text(locale, 'expenses', 'approvals.reject'),
    return: text(locale, 'expenses', 'approvals.return'),
    confirmReject: text(locale, 'expenses', 'approvals.confirmReject'),
    confirmReturn: text(locale, 'expenses', 'approvals.confirmReturn'),
    rejectNotePlaceholder: text(locale, 'expenses', 'approvals.rejectNotePlaceholder'),
    returnNotePlaceholder: text(locale, 'expenses', 'approvals.returnNotePlaceholder'),
  };
}
