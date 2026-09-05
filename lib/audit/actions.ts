/**
 * The audit actions, in one place — flagged in #98 and closed here.
 *
 * ── WHY A REGISTRY IS WORTH IT AND A LIST ON ITS OWN IS NOT ─────────────────
 *
 * There were fifteen bare literals scattered across nine modules, `append` took
 * `action: string`, and #98 added eight more. A typo'd action is not an error —
 * it is a row that inserts happily and that nobody's query ever finds again,
 * which for an append-only table means it is wrong for good.
 *
 * A registry that merely LISTS them would be decorative: the compiler would still
 * accept `action: 'REPROT_EDITED'`. What makes this load-bearing is
 * `AuditInput.action` being typed as `AuditAction` — every call site is now a
 * checked reference, and a new action has to be added HERE before it can be
 * written anywhere.
 *
 * ── A RUNTIME ARRAY AS WELL AS A TYPE, for the reason UD-9 gives ────────────
 *
 * `AUDIT_ACTIONS` exists so nothing has to hand-keep a second copy of the member
 * list — a test that wants to iterate them, an export that wants to explain them,
 * a future admin screen that filters by them. The type is derived FROM the array
 * rather than the other way round, so the two cannot disagree. Same shape as
 * `POST_STATUSES`, `VERDICTS` and `RULE_KINDS`.
 *
 * ── THE TRANSITION ACTIONS ARE NOT THESE, and the distinction is load-bearing ─
 *
 * `lib/expenses/lifecycle.ts` has a `TransitionAction` — SUBMIT, RECALL, APPROVE,
 * REJECT, RETURN, REIMBURSE — written to `expense_report_event`, a different
 * table answering a different question ("what happened to this report"). Some of
 * the names rhyme with the ones below and none of them are the same value. The
 * two lists must not be merged: the audit chain is hashed and append-only, the
 * event log is neither.
 *
 * ── ONE INCONSISTENCY THIS EXPOSED, DELIBERATELY LEFT ALONE ─────────────────
 *
 * Everything here is SCREAMING_SNAKE except branding, which writes
 * `branding.color.set` and five siblings. That is a real inconsistency and this
 * file is the first place it has been visible, because it is the first time the
 * names have sat in one list. NOT renamed here: an audit action is written into
 * rows that cannot be updated, so changing the spelling splits every historical
 * query in two, and doing that as a side effect of adding a registry would be
 * exactly the kind of quiet decision this codebase keeps writing guards against.
 * It is flagged for its own line in the handoff; the rename is one edit here
 * whenever it is wanted.
 *
 * ── WHAT THE COMPILER FOUND ON THE FIRST RUN, WORTH RECORDING ───────────────
 *
 * This list was built by grepping for `action: '…'`, and it was WRONG — nine
 * actions were missing, because five of them are passed through helpers typed
 * `action: string` (`auditBranding`, `auditPrefs`, `auditPostAction`, this
 * project's own `auditEdit`) and two more sit in a ternary that spans lines. A
 * grep cannot see any of those. Typing `AuditInput.action` found all nine in one
 * pass, which is the argument for the registry restated as evidence: the method
 * that produces an incomplete list is exactly the method a list without a
 * compiler is maintained by.
 */
import { VERDICTS, type Verdict } from '@/lib/fraud/review';

export const AUDIT_ACTIONS = [
  /* the report and its contents — UD-11 (#98) */
  'REPORT_EDITED',
  'REPORT_DELETED',
  'EXPENSE_ADDED',
  'EXPENSE_EDITED',
  'EXPENSE_REMOVED',
  'LINE_ITEM_ADDED',
  'LINE_ITEM_EDITED',
  'LINE_ITEM_REMOVED',

  /* approvals — VX2-3 */
  'APPROVAL_RUN_OPENED',
  'APPROVAL_RUN_CANCELLED',
  'APPROVAL_STEP_APPROVED',
  'REPORT_APPROVED',
  'REPORT_REJECTED',
  'REPORT_RETURNED',

  /* delegation — VX2-9 */
  'DELEGATION_CREATED',
  'DELEGATION_REVOKED',

  /* money out — VX2-7 */
  'REPORT_REIMBURSED',

  /* the ledger queue — VX3-6 / UD-8 */
  'LEDGER_POSTING_TRIGGER_CHANGED',
  'LEDGER_POST_RELEASED',
  'LEDGER_POST_RETRIED',
  'LEDGER_POST_SENT_MANUALLY',
  'LEDGER_POST_WITHHELD',

  /* notifications — VX2-8 */
  'NOTIFICATION_PREFERENCE_CHANGED',
  'NOTIFICATION_TEMPLATE_SAVED',
  'NOTIFICATION_TEMPLATE_RESET',

  /* tenant configuration */
  'MODULE_ENABLED',
  'MODULE_DISABLED',
  'USER_LOCALE_CHANGED',
  'ORG_LOCALE_CHANGED',

  /* compliance — VX4-8 */
  'FRAUD_FLAG_RAISED',

  /* branding — VX4-3. The odd family; see the header. */
  'branding.color.set',
  'branding.color.clear',
  'branding.logo.set',
  'branding.logo.clear',
  'branding.tagline.set',
  'branding.tagline.clear',
] as const;

/**
 * A reviewer's verdict is written as `FRAUD_FLAG_<VERDICT>`, so the three members
 * are DERIVED from `VERDICTS` rather than typed out — a template literal type,
 * which is what lets `lib/fraud/review.ts` keep building the string from the
 * verdict it was handed instead of switching over three literals. Add a fourth
 * verdict and this follows it; misspell one and it does not compile.
 */
export type FraudVerdictAction = `FRAUD_FLAG_${Verdict}`;

export type AuditAction = (typeof AUDIT_ACTIONS)[number] | FraudVerdictAction;

/**
 * For a caller holding a string from outside — a query parameter, a log filter.
 *
 * The verdict half is built FROM `VERDICTS`, not matched against a regex naming
 * the three. The first draft of this function wrote
 * `/^FRAUD_FLAG_(RESOLVED|DISMISSED|ESCALATED)$/` — a hand-kept copy of the very
 * list this file exists to stop being copied, three lines below the type that
 * derives it correctly.
 */
export function isAuditAction(value: string): value is AuditAction {
  if ((AUDIT_ACTIONS as readonly string[]).includes(value)) return true;
  return VERDICTS.some((verdict) => value === `FRAUD_FLAG_${verdict}`);
}
