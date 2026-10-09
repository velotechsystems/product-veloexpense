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
  },
  /**
   * ExpenseOS's `report.*` keys (Wave 2), on VeloExpense's names for the same events
   * (lib/audit/actions.ts, UD-11). Only the keys the ported procedures write so far; the
   * rest arrive with the procedures that write them.
   */
  report: {
    update: 'REPORT_EDITED',
    delete: 'REPORT_DELETED',
  },
} as const satisfies Record<string, Record<string, AuditAction>>;

/**
 * ExpenseOS's `auditActions.config(configKey)` builds `config.<key>.update`. VeloExpense:
 * the same call, answered from this map, so a key with no registry name is a compile
 * error rather than a refused write.
 */
const CONFIG_ACTIONS = {
  fxRate: 'FX_RATE_ADDED',
  mileageRate: 'MILEAGE_RATE_CHANGED',
} as const satisfies Record<string, AuditAction>;

export const auditActions = {
  ...adminAndOthers,
  config: <K extends keyof typeof CONFIG_ACTIONS>(configKey: K) => CONFIG_ACTIONS[configKey],
};
