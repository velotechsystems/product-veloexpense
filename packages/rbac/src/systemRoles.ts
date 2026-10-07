import { permissions as P, type Permission } from './permissions';

/**
 * Internal-only identifiers for the four seeded system roles. Used as
 * lookup keys into the SYSTEM_ROLE_IDS / SYSTEM_ROLE_LABELS /
 * SYSTEM_ROLE_PERMISSIONS maps — never persisted to the database. The
 * Role.code column was dropped in Phase A.5; the only stable identity
 * a Role row carries is its UUIDv7 `id`.
 */
export const SYSTEM_ROLE_KINDS = [
  'admin',
  'expense-administrator',
  'card-administrator',
  'ap-clerk',
  'employee',
  'executive',
] as const;

export type SystemRoleKind = (typeof SYSTEM_ROLE_KINDS)[number];

/**
 * Fixed UUIDv7 ids for system roles. The seed script and any
 * permission-graph reasoning code use these as the canonical identity
 * — there is no string `code` on the Role row to fall back to.
 *
 * If these ever change, every environment's seeded rows have to be
 * re-id'd in lockstep. Never rotate.
 */
export const SYSTEM_ROLE_IDS: Record<SystemRoleKind, string> = {
  admin: '019e3000-0000-7000-8000-000000000001',
  'expense-administrator': '019e3000-0000-7000-8000-000000000002',
  // ...000003 was Manager, folded into Employee. See RETIRED_ROLE_IDS — the id is never
  // reused, and the row is kept (deactivated) rather than deleted, because `User.roleId` is
  // a Restrict FK and Audit rows snapshot the label of the role a decision was made under.
  employee: '019e3000-0000-7000-8000-000000000004',
  // Appended, never inserted in the middle: these ids are the only stable
  // identity a Role row has, and re-using or shifting one would silently
  // re-point every existing user assigned to it.
  'card-administrator': '019e3000-0000-7000-8000-000000000005',
  'ap-clerk': '019e3000-0000-7000-8000-000000000006',
  executive: '019e3000-0000-7000-8000-000000000007',
};

/**
 * Ids that were system roles and no longer are. Never reused, never reassigned.
 *
 * Manager was folded into Employee. Employee grants a strict superset of what Manager did,
 * so every user the migration re-points gains rights and loses none.
 */
export const RETIRED_ROLE_IDS = {
  manager: '019e3000-0000-7000-8000-000000000003',
} as const;

/** Locale-keyed labels for system roles. */
export const SYSTEM_ROLE_LABELS: Record<SystemRoleKind, Record<string, string>> = {
  admin: {
    en: 'System Administrator',
    'fr-CA': 'Administrateur système',
  },
  'expense-administrator': {
    en: 'Expense Administrator',
    'fr-CA': 'Administrateur des dépenses',
  },
  employee: {
    en: 'Employee',
    'fr-CA': 'Employé',
  },
  executive: {
    en: 'Executive',
    'fr-CA': 'Direction',
  },
  'card-administrator': {
    en: 'Card Administrator',
    'fr-CA': 'Administrateur des cartes',
  },
  'ap-clerk': {
    en: 'AP Clerk',
    'fr-CA': 'Commis aux comptes payables',
  },
};

/**
 * The full permission list per system role. Source of truth for the
 * migration's INSERT statements and the seed script's upserts.
 *
 * If a permission is added here, the SQL migration MUST be regenerated
 * or follow-up migration written — the migration is the load-bearing
 * artifact for production; this constant is for runtime use and tests.
 */
export const SYSTEM_ROLE_PERMISSIONS: Record<SystemRoleKind, readonly Permission[]> = {
  admin: unique(collectAdmin()),
  'expense-administrator': unique(collectExpenseAdmin()),
  employee: unique(collectEmployee()),
  'card-administrator': unique(collectCardAdmin()),
  'ap-clerk': unique(collectApClerk()),
  executive: unique(collectExecutive()),
};

/**
 * One entry per permission, first occurrence winning.
 *
 * The collectors compose — several spread `collectEmployeeBase()` on top of grants that
 * already overlap it — and `Role.permissions` is a plain String[] the seed writes
 * verbatim. Without this a role stores `user.readOwn` twice, which is harmless to every
 * `includes()` check and confusing in the Role Builder, where the list is shown.
 */
function unique(perms: readonly Permission[]): readonly Permission[] {
  return [...new Set(perms)];
}

function collectAdmin(): readonly Permission[] {
  // Admin gets everything.
  return [
    ...flatten(P.user),
    ...flatten(P.config),
    ...flatten(P.expense),
    ...flatten(P.travel),
    ...flatten(P.vcc),
    ...flatten(P.ledger),
    ...flatten(P.delegation),
    ...flatten(P.policy),
    ...flatten(P.budget),
    ...flatten(P.notification),
    ...flatten(P.audit),
    ...flatten(P.analytics),
    ...flatten(P.admin),
  ];
}

/**
 * Expense Administrator — owns the expense and travel processes company-wide.
 *
 * Spreads ALL of `P.expense` and `P.travel`, which now includes the two approval
 * overrides (`expense.report.decide.any`, `travel.request.decide.any`): this is the role
 * that unsticks a report parked on an approver who left, and it already held that
 * ability — through `read.all`, which was the wrong key for it. The card override is
 * deliberately NOT here: its card grants are a hand-picked subset (approve when the
 * workflow names you, code spend — no issuing, no closing), and deciding any card request
 * belongs with the role that answers for the card programme, which among the system roles
 * is `admin` alone.
 */
function collectExpenseAdmin(): readonly Permission[] {
  return [
    P.user.readOwn,
    P.user.readAll,
    ...flatten(P.config),
    ...flatten(P.expense),
    ...flatten(P.travel),
    P.vcc.requestOwn,
    P.vcc.requestApprove,
    P.vcc.requestReject,
    P.vcc.transactionImport,
    P.vcc.transactionMatch,
    // NetSuite augmentation — everything except triggering the reference
    // resync, which stays admin-only (locked decision).
    P.ledger.referenceView,
    P.ledger.mappingManage,
    P.ledger.syncPush,
    P.ledger.syncRetry,
    P.delegation.viewAll,
    P.admin.expenseCategory.list,
    P.admin.expenseCategory.create,
    P.admin.expenseCategory.update,
    ...flatten(P.budget),
    ...flatten(P.notification),
    P.audit.read,
    P.audit.fraudFlagReview,
    P.audit.controlEvaluationRun,
    P.analytics.dashboardView,
    P.analytics.viewOwn,
    P.analytics.viewChain,
    P.analytics.viewAll,
    P.analytics.reportBuild,
    P.analytics.exportSchedule,
    P.analytics.overrideGrant,
    P.policy.violationOverride,
  ];
}

/**
 * Card Administrator — runs the virtual-card programme.
 *
 * This role exists because `vcc.card.issue`, `vcc.card.close` and
 * `vcc.card.reassign` were in NO role except `admin`, so issuing a card required
 * a System Administrator. `cardIssuerIds()` reads the same permission, which also
 * meant the "approved, awaiting issuance" notification only ever reached
 * sysadmins — the queue had an audience of people who do not work the queue.
 *
 * Includes NetSuite push/retry because a card transaction posts to NetSuite and
 * the person who fixes a failed post is whoever runs the cards. `user.readAll` is
 * needed to pick a cardholder. Deliberately NOT included: `config.*` (the card
 * admin does not configure the platform), `netsuite.reference.sync` (admin-only by
 * a locked decision), and anything expense-report-side.
 */
function collectCardAdmin(): readonly Permission[] {
  return [
    // A card administrator is an employee who travels and spends, like everybody else.
    // Without this they got a 404 on /expenses — their OWN expenses — and could not file
    // a single report or travel request. Every other non-employee role already carries
    // the baseline: `executive` spreads this same call, and `ap-clerk` lists the same
    // permissions with the comment "so they can file expenses like any employee". This
    // role was simply missed. Found by the Playwright permissions suite, which asserts
    // that every role reaches /expenses.
    ...collectEmployeeBase(),
    // Issuing a card and reassigning one both name another employee. A directory READ:
    // it no longer doubles as the card-approval override, which is `vcc.request.decide.any`.
    P.user.readAll,
    // Everything card-side EXCEPT the override. The card administrator issues what gets
    // approved; letting the same role approve any request — including a limit increase,
    // which raises a live card's ceiling on approval — would put authorising and issuing
    // in one pair of hands. They still approve where the workflow names them.
    ...flatten(P.vcc).filter((p) => p !== P.vcc.requestDecideAny),
    P.ledger.referenceView,
    P.ledger.syncPush,
    P.ledger.syncRetry,
    P.delegation.createOwn,
    P.delegation.revokeOwn,
    P.notification.readOwn,
    P.analytics.viewOwn,
  ];
}

/**
 * AP Clerk — codes card spend and pays approved claims.
 *
 * The distinction from `expense-administrator` is least privilege, not naming:
 * that role also carries every `config.*` permission, budgets, policy-violation
 * override and audit read. An AP clerk matching receipts and running
 * reimbursements needs none of those, and giving them out to get the day job done
 * is how a finance system ends up with everyone holding everything.
 *
 * `reimburse` but NOT `approve`: AP pays what a manager authorised, and letting
 * the same person approve and pay removes the segregation of duties the approval
 * workflow exists to create.
 */
function collectApClerk(): readonly Permission[] {
  return [
    // "so they can file expenses like any employee" is what the previous version of this
    // comment said, and it listed the expense permissions by hand — and left out travel,
    // so an AP clerk could file a report but not the trip that produced it. Spreading the
    // baseline is what stops the list drifting from the sentence describing it.
    ...collectEmployeeBase(),
    P.user.readAll,
    // Read every report — AP works a queue, not their own claims. READ ONLY: the decide
    // paths used to treat this as the admin override, which let an AP clerk approve any
    // report and then reimburse it. The override is `expense.report.decide.any`, and
    // this role must never hold it — `systemRoles.test.ts` pins that.
    P.expense.report.readAll,
    P.expense.report.reimburse,
    // NOT `expense.report.fxOverride`. AP pays and posts what somebody else authorised;
    // pinning the statement rate restates the amounts being paid and posted, and the
    // role that sends a report to the ledger must not also be the one that decided what
    // its total is. The restatement sits with the finance admins (`collectExpenseAdmin`
    // via `flatten(P.expense)`), and `systemRoles.test.ts` pins that AP never holds it.
    // Match imported card spend to expenses; no card issuance.
    P.vcc.requestOwn,
    // See every card: AP reconciles card spend company-wide, the same reason it holds
    // `expense.report.read.all`. READ ONLY: it reveals no full number or CVV (that reads
    // `vcc.card.issue`) and authorizes no card action. AP never holds issue, close,
    // reassign or the card override, and `systemRoles.test.ts` pins all four.
    P.vcc.cardReadAll,
    P.vcc.transactionImport,
    P.vcc.transactionMatch,
    P.ledger.referenceView,
    P.ledger.syncPush,
    P.ledger.syncRetry,
    P.notification.readOwn,
    P.analytics.viewOwn,
    P.analytics.viewAll,
  ];
}

/**
 * What ANY person needs to file their own expenses, and nothing more.
 *
 * Spread by every role that also happens to file — Card Administrator, AP Clerk,
 * Executive. It deliberately excludes the approval grants `collectEmployee` adds on top,
 * because two of those roles must never hold them:
 *
 *   - AP Clerk pays what somebody else authorised. One role holding both `reimburse` and
 *     `approve` is a segregation-of-duties failure, not a convenience.
 *   - Executive answers "what are we spending", not "let this through".
 *
 * `systemRoles.test.ts` asserts both, which is how the manager fold was caught trying to
 * hand `expense.report.approve` to all three of them by inheritance.
 */
function collectEmployeeBase(): readonly Permission[] {
  return [
    P.user.readOwn,
    P.expense.report.readOwn,
    P.expense.report.createOwn,
    P.expense.report.updateOwn,
    P.expense.report.deleteDraft,
    P.expense.report.submitOwn,
    P.travel.request.createOwn,
    P.travel.request.updateOwn,
    P.travel.request.submitOwn,
    P.vcc.requestOwn,
    P.notification.readOwn,
    P.analytics.viewOwn,
    /**
     * The analytics gate. `resolveScope` THROWS without it (`analytics.ts:66`), so it is
     * what makes `/analytics` reachable at all: the page itself `notFound()`s without it
     * (`analytics/page.tsx:30`), the sidebar item is hidden without it
     * (`Sidebar.tsx:331`), and `analytics.dashboard` — a bare `protectedProcedure` — throws
     * FORBIDDEN inside its resolver without it. `finance-reporting` is in
     * `DEFAULT_ACTIVE_MODULES` (`bootstrap.ts:187`), so that screen is default-on in every
     * workspace; an administrator who switches the module off has said so deliberately.
     *
     * #365 ADDED IT HERE FOR THE DASHBOARD'S SPEND CARD, WHICH NO LONGER EXISTS — and the
     * reason it stays is written down here on purpose, because the card it was granted for
     * is gone. Without this line the largest role in the product (907 of roughly 1,050
     * seeded users; GA readiness report F02) loses `/analytics` entirely, which was never
     * the intent: an employee is meant to be able to open a view of their own spend, and
     * `/analytics` is now the only place that view lives.
     *
     * NOT NARROWED BACK, DELIBERATELY. #365's migration widened every role holding
     * `expense.report.create.own`, including custom roles built from the employee template.
     * A reversing migration cannot distinguish a role that got the permission from that
     * `UPDATE` from one an administrator granted deliberately afterwards, so it would
     * revoke real grants to undo an automatic one.
     *
     * IT WIDENS WHAT SOMEBODY CAN REACH, NOT WHAT THEY CAN SEE. Scope still comes from
     * `viewAll` / `viewChain`, and an employee holds neither `viewAll` nor — with no direct
     * reports — anything beyond themselves. On the BASE so every role that files expenses can
     * see its own spend, which is the least surprising rule.
     */
    P.analytics.dashboardView,
  ];
}

/**
 * An employee. Also a manager, when they have reports.
 *
 * MANAGER WAS FOLDED IN HERE. A manager is nothing more than an employee with reports, and
 * the Manager role never tracked that: on the seeded directory TWO users held it while 135
 * people actually had direct reports. Anyone promoted stayed an Employee unless somebody
 * remembered to change their role by hand, so the approval rights a real line manager needs
 * were routinely missing — and the role had to be kept in lockstep with an org chart that
 * already lives in Google Workspace.
 *
 * Safe because THE PERMISSION HAS NEVER BEEN WHAT AUTHORIZES A DECISION: `canDecide` in
 * `@expenseos/approvals` authorizes on the approval task's assignment, and the assignment
 * comes from the workflow's approver resolution (the manager RELATION, job levels, filters).
 * The permission is the coarse gate deciding whether the approvals surface exists at all;
 * the engine decides every actual verdict.
 *
 * Three consequences, all deliberate:
 *
 *   - Every employee now sees the Approvals section, usually holding nothing. That is the
 *     honest state, and it FIXES a latent bug: somebody assigned an approval by a `filter`
 *     node or by delegation could not reach the page at all, because the nav and the page
 *     gated on a role permission they did not hold.
 *   - The unresolved-relative-approver CLAIM POOL was bounded by `expense.report.approve`,
 *     so granting it to everyone would have widened that pool from every line manager to
 *     every employee — 135 people to 907 on the seeded directory. `canClaimUnresolvedFor`
 *     now requires at least one direct report, the definition this fold is built on.
 *   - The grants stay OFF `collectEmployeeBase`, so the three roles that spread it do not
 *     inherit them.
 *
 * `readChain` and `analytics.viewChain` widen nothing for somebody with no reports: both are
 * scoped by the QUERY walking the actual org chart, not by the permission.
 */
function collectEmployee(): readonly Permission[] {
  return [
    ...collectEmployeeBase(),
    P.expense.report.readChain,
    P.expense.report.approve,
    P.expense.report.reject,
    P.expense.report.return,
    P.travel.request.approve,
    P.travel.request.reject,
    P.travel.request.return,
    P.vcc.requestApprove,
    P.vcc.requestReject,
    P.delegation.createOwn,
    P.delegation.revokeOwn,
    P.budget.read,
    P.analytics.viewChain,
  ];
}

/**
 * A C-level: the whole company's spend, and nothing else.
 *
 * Everything an employee has, because an executive files expenses like anybody
 * else, plus company-wide analytics — the dashboard gate, the widest scope, and
 * the ability to build and export a report from it. Deliberately NO admin,
 * approval, card or NetSuite rights: this role answers "what are we spending",
 * not "let this through".
 */
function collectExecutive(): readonly Permission[] {
  return [
    ...collectEmployeeBase(),
    P.analytics.dashboardView,
    P.analytics.viewChain,
    P.analytics.viewAll,
    P.analytics.reportBuild,
    P.analytics.exportSchedule,
  ];
}

function flatten(node: unknown): Permission[] {
  if (typeof node === 'string') return [node as Permission];
  if (node && typeof node === 'object') {
    return Object.values(node as Record<string, unknown>).flatMap(flatten);
  }
  return [];
}
