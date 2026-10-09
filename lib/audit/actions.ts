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
 * ── THE BRANDING NAMES, RENAMED WHILE IT WAS STILL POSSIBLE ─────────────────
 *
 * Six actions were written `branding.color.set` and so on, lower-case-dotted,
 * where the other thirty-six are SCREAMING_SNAKE. VX4-11 flagged it and left it
 * alone, correctly: renaming as a side effect of adding a registry would have
 * been a quiet decision about an append-only log.
 *
 * Renamed now, deliberately, because **the window closes at GA and does not
 * reopen.** The action string is inside the hash payload (`chain.ts`), so a
 * stored row's spelling can never be changed — not by a migration, not by
 * anything, because changing it changes the hash and the chain stops verifying.
 * That is the log working as designed.
 *
 * What that means in practice, and it is worth being exact rather than
 * reassuring:
 *
 *   · Rows already written keep `branding.color.set` FOREVER. Their chains still
 *     verify, because verification recomputes each hash from what is stored, not
 *     from this list.
 *   · A database with pre-rename rows therefore contains both spellings for the
 *     same event, and no query can be written that is right for both without
 *     naming both.
 *   · Today that costs nothing: nothing is in production, and every database
 *     that has one of these rows is a development or CI one that gets rebuilt.
 *     After the first customer it would cost that mixed history permanently.
 *
 * So this is the last cheap moment, and it is being taken. `test/audit-canonical`
 * asserts no member of this list is dotted, so a thirty-seventh cannot arrive in
 * the old shape and start the problem again.
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
  /* the tenant itself — VX5-1. The genesis row of every chain. */
  'ORGANIZATION_CREATED',

  /* the report and its contents — UD-11 (#98) */
  'REPORT_EDITED',
  'REPORT_DELETED',
  'EXPENSE_ADDED',
  'EXPENSE_EDITED',
  'EXPENSE_REMOVED',
  'LINE_ITEM_ADDED',
  'LINE_ITEM_EDITED',
  'LINE_ITEM_REMOVED',

  /* the report's own transitions. Missing until 4 Oct 2026: a submit and a recall
   * wrote only to `expense_report_event`, so the tamper-evident chain recorded who
   * APPROVED a report and never who put it forward or took it back — half of the
   * question an auditor asks. Found during the entitlement work (#124). */
  'REPORT_SUBMITTED',
  'REPORT_RECALLED',

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
  /* Expense categories — the Wave 0 ExpenseOS port (packages/audit/src/actions.ts maps
     ExpenseOS's `admin.expenseCategory.*` onto these). A reorder is an UPDATED, as in
     ExpenseOS. */
  'EXPENSE_CATEGORY_CREATED',
  'EXPENSE_CATEGORY_UPDATED',
  /* Business units — the Wave 1 port (admin.businessUnit.*). ExpenseOS's `delete` is the
     soft deactivation; a reactivation is an UPDATED, as in ExpenseOS. */
  'BUSINESS_UNIT_CREATED',
  'BUSINESS_UNIT_UPDATED',
  'BUSINESS_UNIT_DEACTIVATED',
  /* Legal entities — the Wave 1 port (admin.legalEntity.*), the same shape. */
  'LEGAL_ENTITY_CREATED',
  'LEGAL_ENTITY_UPDATED',
  'LEGAL_ENTITY_DEACTIVATED',
  /* Departments — the Wave 1 port (admin.department.*), the same shape. */
  'DEPARTMENT_CREATED',
  'DEPARTMENT_UPDATED',
  'DEPARTMENT_DEACTIVATED',
  'MODULE_ENABLED',
  'MODULE_DISABLED',
  'USER_LOCALE_CHANGED',
  'ORG_LOCALE_CHANGED',

  /* compliance — VX4-8 */
  'FRAUD_FLAG_RAISED',

  /* membership — VX5-3. The invite is the only way into a tenant now, so this
   * family is the whole story of how anybody but the founder got here. Both ends
   * of an invitation are recorded, and so is a refusal: with joining invite-only,
   * a DENIED sign-in is the shape a stranger probing a tenant takes, and until
   * this ticket the only trace of one was a `console.warn`. */
  'INVITE_SENT',
  'INVITE_RESENT',
  'INVITE_REVOKED',
  'INVITE_ACCEPTED',
  /* An invitation that could not be accepted for a reason the invitee did not
   * cause — today only the plan's seat cap. Written ahead of the auth kit's own
   * SIGN_IN_DENIED, which has no way to carry a reason. */
  'INVITE_REFUSED',
  'SIGN_IN_DENIED',

  /* branding — VX4-3. The odd family; see the header. */
  'BRANDING_COLOR_SET',
  'BRANDING_COLOR_CLEARED',
  'BRANDING_LOGO_SET',
  'BRANDING_LOGO_CLEARED',
  'BRANDING_TAGLINE_SET',
  'BRANDING_TAGLINE_CLEARED',
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
