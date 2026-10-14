/**
 * ExpenseOS's `auditActions`, for the routers ported so far.
 *
 * VeloExpense: ExpenseOS's action strings are dotted (`admin.expenseCategory.create`).
 * VeloExpense's audit chain accepts only the names in its registry
 * (`lib/audit/actions.ts`, SCREAMING_SNAKE), and an action string can never be
 * renamed once rows carry it, because it is inside the hash. So the ported KEYS are
 * ExpenseOS's — `auditActions.admin.expenseCategoryCreate` reads the same in ported
 * code — and the VALUES are VeloExpense's registry names. Each router's port adds
 * its keys here and its names there; `writeAudit` refuses a name the registry lacks.
 */
import type { AuditAction } from '@/lib/audit/actions';

const adminAndOthers = {
  admin: {
    expenseCategoryCreate: 'EXPENSE_CATEGORY_CREATED',
    expenseCategoryUpdate: 'EXPENSE_CATEGORY_UPDATED',
    businessUnitCreate: 'BUSINESS_UNIT_CREATED',
    businessUnitUpdate: 'BUSINESS_UNIT_UPDATED',
    /** ExpenseOS's `delete` is a deactivation: lookup rows are never deleted (`setActive`). */
    businessUnitDelete: 'BUSINESS_UNIT_DEACTIVATED',
    legalEntityCreate: 'LEGAL_ENTITY_CREATED',
    legalEntityUpdate: 'LEGAL_ENTITY_UPDATED',
    /** As for business units: a deactivation. */
    legalEntityDelete: 'LEGAL_ENTITY_DEACTIVATED',
    departmentCreate: 'DEPARTMENT_CREATED',
    departmentUpdate: 'DEPARTMENT_UPDATED',
    /** As for business units: a deactivation. */
    departmentDelete: 'DEPARTMENT_DEACTIVATED',
    jobLevelCreate: 'JOB_LEVEL_CREATED',
    jobLevelUpdate: 'JOB_LEVEL_UPDATED',
    /** A job level is really deleted (ExpenseOS's `delete`), and only when nobody is on it. */
    jobLevelDelete: 'JOB_LEVEL_DELETED',
    fiscalYearCreate: 'FISCAL_YEAR_CREATED',
    fiscalYearUpdate: 'FISCAL_YEAR_UPDATED',
    fiscalYearSetCurrent: 'FISCAL_YEAR_SET_CURRENT',
    fiscalYearDelete: 'FISCAL_YEAR_DELETED',
    /** w4-10c: the Role Builder (`server/routers/roles.ts`). A role is really deleted, and
     *  only when nobody holds it and nothing names it. */
    roleCreate: 'ROLE_CREATED',
    roleUpdate: 'ROLE_UPDATED',
    roleDelete: 'ROLE_DELETED',
  },
  /** ExpenseOS's `approvalWorkflow.*` keys (w4-01, the workflow builder). */
  approvalWorkflow: {
    create: 'APPROVAL_WORKFLOW_CREATED',
    update: 'APPROVAL_WORKFLOW_UPDATED',
    saveDraft: 'APPROVAL_WORKFLOW_DRAFT_SAVED',
    publish: 'APPROVAL_WORKFLOW_PUBLISHED',
  },
  /** ExpenseOS's `savedView.*` keys (w4-08, server/routers/savedViews.ts). */
  savedView: {
    create: 'SAVED_VIEW_CREATED',
    update: 'SAVED_VIEW_UPDATED',
    delete: 'SAVED_VIEW_DELETED',
  },
  /** ExpenseOS's `workflow.*` key (w4-00c, server/lib/workflowEffects). */
  workflow: {
    actionFired: 'WORKFLOW_ACTION_FIRED',
  },
  /**
   * ExpenseOS's `report.*` keys (Wave 2), on VeloExpense's names for the same events
   * (lib/audit/actions.ts, UD-11). Only the keys the ported procedures write so far; the
   * rest arrive with the procedures that write them.
   */
  report: {
    update: 'REPORT_EDITED',
    delete: 'REPORT_DELETED',
    lineItemAdd: 'LINE_ITEM_ADDED',
    lineItemUpdate: 'LINE_ITEM_EDITED',
    lineItemDelete: 'LINE_ITEM_REMOVED',
    create: 'REPORT_CREATED',
    receiptAttach: 'RECEIPT_ATTACHED',
    receiptDetach: 'RECEIPT_REMOVED',
    /** w2-02a: the FX override (`expenseApprovals.setFxOverride`). */
    fxOverride: 'REPORT_FX_OVERRIDE_SET',
    /** w3-02a: a document's extraction landed after the report left DRAFT/RETURNED, so the
     *  worker did not apply it (ExpenseOS's `report.extraction.skipped`). */
    extractionSkipped: 'REPORT_EXTRACTION_SKIPPED',
    /** w4-00c: the approver's actions (`expenseApprovals`). ExpenseOS writes `report.approve`
     *  / `report.reject` for every decision; VeloExpense's chain names a decision that ends
     *  the approval apart from one step of several (`stepApprove` / `stepReject`), as its
     *  ladder did, so `server/lib/reportLifecycle.ts` picks the key from the outcome. */
    approve: 'REPORT_APPROVED',
    reject: 'REPORT_REJECTED',
    stepApprove: 'APPROVAL_STEP_APPROVED',
    stepReject: 'APPROVAL_STEP_REJECTED',
    return: 'REPORT_RETURNED',
    reassign: 'APPROVAL_TASK_REASSIGNED',
    recall: 'REPORT_RECALLED',
  },
} as const satisfies Record<string, Record<string, AuditAction>>;

/**
 * ExpenseOS's `auditActions.config(configKey)` builds `config.<key>.update`. VeloExpense:
 * the same call, answered from this map, so a key with no registry name is a compile
 * error rather than a refused write.
 */
const CONFIG_ACTIONS = {
  /** w4-02c: a category's policy (ExpenseOS's `config.policy.update`). */
  policy: 'EXPENSE_POLICY_CHANGED',
  fxRate: 'FX_RATE_ADDED',
  mileageRate: 'MILEAGE_RATE_CHANGED',
  /** w4-02b: every rule-instance write, the operation in `details.op` (as ExpenseOS). */
  policyRule: 'POLICY_RULE_CHANGED',
} as const satisfies Record<string, AuditAction>;

export const auditActions = {
  ...adminAndOthers,
  config: <K extends keyof typeof CONFIG_ACTIONS>(configKey: K) => CONFIG_ACTIONS[configKey],
};
