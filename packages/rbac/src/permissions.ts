/**
 * Typed permission registry. Adding a permission is a single-line
 * change here — every consumer (Sidebar nav-gating, tRPC procedure
 * middleware, worker handlers) imports `permissions.<area>.<verb>`
 * so typos are compile errors and the universe of permissions can be
 * enumerated by tooling.
 *
 * Naming convention:
 *   <module>.<resource>.<action>[.<scope>]
 *
 * Where <scope> is one of `own` / `reportingChain` / `all` /
 * `businessUnit` / `any` when permissions need to differentiate.
 *
 * The strings stored on Role.permissions in the DB MUST be drawn
 * from this registry. tRPC writers validate Role updates against
 * `ALL_PERMISSIONS` before persisting.
 */
export const permissions = {
  // ── Module 2 — Employees & Org ─────────────────────────────────
  user: {
    readOwn: 'user.read.own',
    readAll: 'user.read.all',
    create: 'user.create',
    update: 'user.update',
    deactivate: 'user.deactivate',
    setRole: 'user.setRole',
    setOnLeave: 'user.setOnLeave',
  },

  // ── Module 3 — Config & reference data ─────────────────────────
  config: {
    policyRead: 'config.policy.read',
    policyUpdate: 'config.policy.update',
    currencyUpdate: 'config.currency.update',
    fxRateUpdate: 'config.fxRate.update',
    perDiemUpdate: 'config.perDiem.update',
    mileageUpdate: 'config.mileage.update',
    glAccountUpdate: 'config.glAccount.update',
    budgetCategoryUpdate: 'config.budgetCategory.update',
    customFieldUpdate: 'config.customField.update',
    jobLevelUpdate: 'config.jobLevel.update',
    fiscalYearUpdate: 'config.fiscalYear.update',
  },

  // ── Module 4 — Expense Reports ────────────────────────────────
  expense: {
    report: {
      readOwn: 'expense.report.read.own',
      readChain: 'expense.report.read.reportingChain',
      readAll: 'expense.report.read.all',
      createOwn: 'expense.report.create.own',
      updateOwn: 'expense.report.update.own',
      deleteDraft: 'expense.report.delete.draft',
      submitOwn: 'expense.report.submit.own',
      approve: 'expense.report.approve',
      reject: 'expense.report.reject',
      return: 'expense.report.return',
      reimburse: 'expense.report.reimburse',
      reassign: 'expense.report.reassign',
      /**
       * Decide, return or reassign ANY pending expense-report task — assigned to you or
       * not. The approval OVERRIDE, and the only thing that grants it.
       *
       * It used to ride on `read.all`: every decide path computed its admin flag from the
       * read permission, so whoever could see every report could approve every report.
       * AP Clerk holds `read.all` to work its queue and `reimburse` to pay what a manager
       * authorised — and could therefore approve and then pay the same claim, which is
       * the segregation of duties the workflow exists to create. A read permission must
       * never confer a decision; an override is a grant somebody makes on purpose.
       *
       * Held by `admin` and `expense-administrator`. A custom role gets it in the Role
       * Builder, and every decision made on its strength is audited with `override: true`.
       */
      decideAny: 'expense.report.decide.any',
      /**
       * Pin the FX rate a card statement actually charged onto a SUBMITTED report —
       * restating every foreign line's home amount and the total the approver signs
       * and NetSuite posts.
       *
       * It used to ride on `reimburse`, which put restating a report's amounts and
       * sending it to the ledger (`netsuite.sync.push`) in the AP Clerk's one pair of
       * hands: the role that pays could also decide what the number was. Restating is
       * a finance-administration act, not a payment one, so it is its own grant.
       *
       * Held by `admin` and `expense-administrator`; never by `ap-clerk`
       * (`systemRoles.test.ts` pins that). Inside admin, where role shape cannot separate
       * duties, `netsuiteSync.approveExpenseReportPosting` refuses the person who set the
       * report's current override — the two-person rule at runtime.
       */
      fxOverride: 'expense.report.fxOverride',
    },
  },

  // ── Module 5 — Quick Expenses ────────────────────────────────

  // ── Module 6 — Travel Requests ────────────────────────────────
  travel: {
    request: {
      createOwn: 'travel.request.create.own',
      updateOwn: 'travel.request.update.own',
      submitOwn: 'travel.request.submit.own',
      approve: 'travel.request.approve',
      reject: 'travel.request.reject',
      return: 'travel.request.return',
      /** The travel override — see `expense.report.decide.any`. Replaces `user.read.all`,
       *  a directory permission that had been standing in for it. */
      decideAny: 'travel.request.decide.any',
    },
  },

  // ── Module 7 — Virtual Corporate Cards ────────────────────────
  vcc: {
    requestOwn: 'vcc.request.own',
    requestApprove: 'vcc.request.approve',
    requestReject: 'vcc.request.reject',
    /** The card override — decide or adjust ANY pending card request or limit increase,
     *  whoever the workflow named. See `expense.report.decide.any`. Admin-only among the
     *  system roles: a limit increase writes the new ceiling to a live card the moment it
     *  is approved, and the Card Administrator issues what gets approved, so approving and
     *  issuing must not sit in one non-admin role. */
    requestDecideAny: 'vcc.request.decide.any',
    /** View every card; grants no action. Widens what `virtualCards.list` and
     *  `virtualCards.get` return from the caller's own cards to every card's masked profile,
     *  and nothing else: revealing the full number and CVV still reads `vcc.card.issue`, and
     *  every card mutation keeps its own permission. Held by admin, Card Administrator and
     *  AP Clerk (who reconciles card spend company-wide); `systemRoles.test.ts` pins
     *  exactly those three. */
    cardReadAll: 'vcc.card.read.all',
    cardIssue: 'vcc.card.issue',
    /** Edit what identifies a card and who holds it: move it to another cardholder, change
     *  the card number, the expiry or the CVV. Everything else (the name on the card included)
     *  on a card stays editable with `vcc.card.issue`. Admin-only among the system roles —
     *  `systemRoles.test.ts` pins that: a card administrator who could both issue cards and
     *  rewrite a live card's number or holder could move spend onto any card unseen. */
    cardEditSensitive: 'vcc.card.edit.sensitive',
    cardClose: 'vcc.card.close',
    cardReassign: 'vcc.card.reassign',
    limitRequestIncrease: 'vcc.limit.requestIncrease',
    transactionImport: 'vcc.transaction.import',
    transactionMatch: 'vcc.transaction.match',
  },

  // ── NetSuite integration (netsuite-gl module) ─────────────────
  // VeloExpense: the key and the strings say `ledger`, not `netsuite`. VeloExpense keeps
  // vendor names out of everything but the adapter (scripts/check-vendor-neutral.mjs), and
  // these permissions govern the ledger integration whichever system is behind it.
  // Renamed, not re-scoped: each one guards exactly what its ExpenseOS original did.
  // Augmentation permissions: only meaningful while the netsuite
  // integration + netsuite-gl module are active. Procedures double-gate
  // with moduleActive('netsuite-gl').
  ledger: {
    referenceView: 'ledger.reference.view',
    referenceSync: 'ledger.reference.sync',
    /**
     * Permanently remove one inactive reference row from our mirror.
     *
     * The sync upserts what NetSuite returned and flips the rest to `isActive = false`;
     * it never deletes, so a record NetSuite dropped lingers as an inactive row forever.
     * This is the only way one leaves. It is irreversible FOR THE ROW: the local id never
     * returns, and neither does anything that named it. Whether a row reappears depends on
     * why it was inactive — a record NetSuite actually dropped stays gone, while one
     * NetSuite still returns but has deactivated is re-created by the next sync under a NEW
     * local id. Both are safe here precisely because only a zero-reference row is
     * deletable, so nothing was pointing at the id that went away.
     *
     * Admin-only, alongside `referenceSync` — `systemRoles.test.ts` pins that. Holding it
     * is not by itself permission to orphan anything: the procedure counts every row
     * pointing at the record through a foreign key first and refuses while any remain.
     */
    referenceDelete: 'ledger.reference.delete',
    mappingManage: 'ledger.mapping.manage',
    syncPush: 'ledger.sync.push',
    syncRetry: 'ledger.sync.retry',
  },

  // ── Module 8 — Approvals & Delegations ────────────────────────
  delegation: {
    createOwn: 'delegation.create.own',
    createAny: 'delegation.create.any',
    revokeOwn: 'delegation.revoke.own',
    revokeAny: 'delegation.revoke.any',
    viewAll: 'delegation.view.all',
  },

  // ── Module 9 — Policy Engine ──────────────────────────────────
  policy: {
    violationOverride: 'policy.violation.override',
  },

  // ── Module 10 — Budgets ───────────────────────────────────────
  //
  // Visibility is row-level, not dimension-level: `read` gets you the Budgets
  // page and the budgets you own, are named a viewer of, or are an alert
  // recipient for; `viewAll` is the finance/admin scope over every budget.
  // There is deliberately no business-unit or department scope — see
  // docs/design/budgets.md, "Visibility".
  budget: {
    read: 'budget.read',
    viewAll: 'budget.view.all',
    create: 'budget.create',
    update: 'budget.update',
    delete: 'budget.delete',
  },

  // ── Module 11 — Notifications ─────────────────────────────────
  notification: {
    readOwn: 'notification.read.own',
    templateUpdate: 'notification.template.update',
    retry: 'notification.retry',
    queueView: 'notification.queue.view',
  },

  // ── Module 12 — Audit & Compliance ────────────────────────────
  audit: {
    read: 'audit.read',
    chainVerify: 'audit.chain.verify',
    fraudFlagReview: 'audit.fraudFlag.review',
    controlEvaluationRun: 'audit.controlEvaluation.run',
  },

  // ── Module 13 — Analytics & Reporting ─────────────────────────
  analytics: {
    /**
     * Opens the analytics dashboard at all.
     *
     * Separate from the `view.*` trio, which decide HOW MUCH of the company's spend
     * you see once you are in. Every seeded role holds `view.own`, so before this
     * existed the only gate on the screen was "can you see your own numbers" — which
     * is everybody. Company-level spend is a C-suite and finance-admin question, and
     * that is a different question from whose rows you may read.
     */
    dashboardView: 'analytics.dashboard.view',
    viewOwn: 'analytics.view.own',
    viewChain: 'analytics.view.reportingChain',
    viewAll: 'analytics.view.all',
    reportBuild: 'analytics.report.build',
    exportSchedule: 'analytics.export.schedule',
    permissionsSet: 'analytics.permissions.set',
    overrideGrant: 'analytics.override.grant',
  },

  // ── Module 14 — Admin & Integrations ──────────────────────────
  admin: {
    role: {
      create: 'admin.role.create',
      update: 'admin.role.update',
      delete: 'admin.role.delete',
      list: 'admin.role.list',
    },
    businessUnit: {
      create: 'admin.businessUnit.create',
      update: 'admin.businessUnit.update',
      delete: 'admin.businessUnit.delete',
      list: 'admin.businessUnit.list',
    },
    legalEntity: {
      create: 'admin.legalEntity.create',
      update: 'admin.legalEntity.update',
      delete: 'admin.legalEntity.delete',
      list: 'admin.legalEntity.list',
    },
    department: {
      create: 'admin.department.create',
      update: 'admin.department.update',
      delete: 'admin.department.delete',
      list: 'admin.department.list',
    },
    expenseCategory: {
      create: 'admin.expenseCategory.create',
      update: 'admin.expenseCategory.update',
      list: 'admin.expenseCategory.list',
    },
    /** Travel's own taxonomy — separate from the expense one because the two are
     *  separate tables with separate audiences: an accountant curates the chart of
     *  accounts, and whoever owns the travel policy curates what a trip can be
     *  planned against. */
    travelCategory: {
      create: 'admin.travelCategory.create',
      update: 'admin.travelCategory.update',
      list: 'admin.travelCategory.list',
    },
    module: {
      view: 'admin.module.view',
      manage: 'admin.module.manage',
    },
    approvalWorkflow: {
      view: 'admin.approvalWorkflow.view',
      manage: 'admin.approvalWorkflow.manage',
    },
    integration: {
      view: 'admin.integration.view',
      update: 'admin.integration.update',
    },
    apiKey: {
      create: 'admin.apiKey.create',
      revoke: 'admin.apiKey.revoke',
      list: 'admin.apiKey.list',
    },
    webhook: {
      view: 'admin.webhook.view',
    },
    appSettings: {
      update: 'admin.appSettings.update',
    },
    help: {
      manage: 'admin.help.manage',
    },
  },
} as const;

/** Helper: recursively extract every string-leaf from the registry. */
type Leaves<T> = T extends string ? T : { [K in keyof T]: Leaves<T[K]> }[keyof T];

/** Literal-typed union of every permission string in the registry. */
export type Permission = Leaves<typeof permissions>;

/** Flat array of every permission code. Used to validate Role.permissions writes. */
export const ALL_PERMISSIONS: readonly Permission[] = flatten(permissions);

function flatten(node: unknown): readonly Permission[] {
  if (typeof node === 'string') return [node as Permission];
  if (node && typeof node === 'object') {
    return Object.values(node as Record<string, unknown>).flatMap(flatten);
  }
  return [];
}

/** Fast-path lookup set for validation. */
const PERMISSION_SET = new Set<string>(ALL_PERMISSIONS);

export function isPermission(value: unknown): value is Permission {
  return typeof value === 'string' && PERMISSION_SET.has(value);
}
