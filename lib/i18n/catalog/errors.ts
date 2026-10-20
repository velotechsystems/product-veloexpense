/**
 * VX4-7 part 2c — what a refusal SAYS to the person who hit it.
 *
 * PURE, and for the same reason `enums.ts` is: this is imported by
 * `lib/errors/domain.ts`, which is imported by every service module, and a
 * catalogue that dragged `pg` in would put a connection pool behind the word
 * "no". Only types cross the boundary.
 *
 * ── THE COPY RULE THIS FILE ENFORCES BY SHAPE ───────────────────────────────
 *
 * A `Copy` is a plain string with `{name}` placeholders — not a function, unlike
 * `policy-messages.ts`, whose sentences branch on their own data and needed one.
 * Nothing in here branches: where a value only chose between two wordings it is
 * a second CODE instead, because a placeholder that picks a branch is a template
 * language starting up.
 *
 * Most entries have no placeholder at all, and that is the 2c-1 argument holding
 * for the employee half: a refusal is a statement about the action somebody just
 * took, on the screen they took it from, with their own input in front of them.
 * "The end date is before the start date" needs no dates in it. The fourteen
 * that DO carry values carry COMPUTED ones the page cannot show — a contrast
 * ratio, a set of in-use counts, a size against a limit. `lib/errors/domain.ts`
 * has the three rules that scope them, including the one that refuses a record
 * id outright.
 *
 * ── WHAT IS AND IS NOT IN HERE ──────────────────────────────────────────────
 *
 * Only messages a person can act on. `report not found`, `no tenant context`
 * and `delegation not found after insert` are invariant failures: they get no
 * code, the banner shows the generic, and the real message goes to the log.
 * Cataloguing them would be translating a sentence whose only correct audience
 * is an engineer.
 *
 * Of 265 throw sites across 26 error classes, about 87 sit on a path that can
 * reach a banner. Part 2c-1 did the employee-and-approver half; 2c-2 does the
 * admin half and closes IL-11. There is no longer any path that puts an
 * exception's own text in a URL.
 */
import { DEFAULT_LOCALE, localizedFrom, type Locale } from '../locales';
import { enumLabel, missingCopyMarker, type Copy } from './enums';
import { decodeUserMessage, type MessageParams } from '@/lib/errors/domain';

export const USER_MESSAGE_CODES = [
  /* generic ─────────────────────────────────────────────────────────────── */
  'UNEXPECTED',

  /* submitting and editing a report ─────────────────────────────────────── */
  'REPORT_NOT_DRAFT',
  'REPORT_EMPTY',
  'BLOCKED_BY_POLICY_ONE',
  'BLOCKED_BY_POLICY_MANY',
  /* UD-2: the report cannot post because its coding is incomplete. */
  'SUBMIT_UNCODED_ONE',
  'SUBMIT_UNCODED_MANY',
  /* VX4-11: an expense with no transaction date. */
  'SUBMIT_UNDATED_ONE',
  'SUBMIT_UNDATED_MANY',
  /* w2-11 (d34): a policy warning nobody has justified. */
  'SUBMIT_UNJUSTIFIED_WARNING_ONE',
  'SUBMIT_UNJUSTIFIED_WARNING_MANY',

  /* VX5-1: creating an organization. VX5-2: getting there. */
  'SIGNUP_EMAIL',
  'SIGNUP_LINK_DEAD',
  'SIGNUP_CLOSED',
  'ORG_NAME_REQUIRED',
  'ORG_SLUG_SHAPE',
  'ORG_SLUG_RESERVED',
  'ORG_SLUG_TAKEN',

  /* VX5-3: invites — the only way into a tenant that is not founding one. */
  'INVITE_EMAIL',
  'INVITE_LINK_DEAD',
  'INVITE_ALREADY_MEMBER',
  'INVITE_NOT_LIVE',
  'INVITE_NOT_FOR_YOU',

  /* VX5-5: the address names one tenant and the session belongs to another. */
  'WRONG_TENANT_HOST',

  /* VX5-11: the subscription lapsed and this action moves money or work. */
  'BILLING_LAPSED',
  /* the plan's numeric caps (lib/billing/caps.ts) */
  'SEAT_LIMIT_REACHED',
  'EXPENSE_LIMIT_REACHED',
  'REPORT_NOT_SUBMITTABLE',
  'REPORT_NOT_RECALLABLE',
  'REPORT_NOT_REIMBURSABLE',
  'REIMBURSE_OWN_REPORT',
  'REIMBURSE_RACE',
  'TITLE_REQUIRED',
  'AMOUNT_NOT_WHOLE_MINOR',
  'CURRENCY_UNKNOWN',
  'CATEGORY_UNKNOWN',

  /* deciding an approval ────────────────────────────────────────────────── */
  'TASK_ALREADY_DECIDED',
  /* w2-02a: reassigning an approval. */
  'REASSIGN_TARGET_UNKNOWN',
  'REASSIGN_TARGET_SUBMITTER',
  'REASSIGN_TARGET_SAME',
  'REASSIGN_REASON_REQUIRED',
  'TASK_NOT_YOURS',
  'SELF_APPROVAL',
  'SUBMIT_NEEDS_APPROVER',
  /* w4-00c (d58): no published approval workflow governs the report. */
  'SUBMIT_NO_WORKFLOW',
  'REPORT_NOT_AWAITING_APPROVAL',

  /* delegating approvals ────────────────────────────────────────────────── */
  'DELEGATE_FOR_SOMEBODY_ELSE',
  'DELEGATE_TO_SELF',
  'DELEGATION_SCOPE_UNKNOWN',
  'DELEGATION_START_REQUIRED',
  'DELEGATION_END_INVALID',
  'DELEGATION_END_BEFORE_START',
  'DELEGATEE_NOT_IN_ORG',
  'DELEGATEE_INACTIVE',
  'DELEGATION_ALREADY_REVOKED',
  'DELEGATION_NOT_YOURS',

  /* the receipt drawer — the one client surface ─────────────────────────── */
  'RECEIPT_ACTION_FAILED',
  'RECEIPT_OPEN_FAILED',

  /* ─────────────────────────── part 2c-2: the admin half ─────────────── */

  /* amounts and rates (lib/money.ts) ───────────────────────────────────── */
  'AMOUNT_REQUIRED',
  'AMOUNT_MALFORMED',
  'AMOUNT_TOO_MANY_DECIMALS_ONE',
  'AMOUNT_TOO_MANY_DECIMALS_MANY',

  /* language and time (lib/i18n/service.ts) ────────────────────────────── */
  'LOCALE_REQUIRED',
  'LOCALE_UNSUPPORTED',
  'TIMEZONE_REQUIRED',

  /* notification setup (lib/notifications/service.ts) ──────────────────── */
  'EVENT_TYPE_UNKNOWN',
  'CHANNEL_UNKNOWN',
  'TEMPLATE_KEY_UNKNOWN',

  /* the employee directory (lib/employees/service.ts) ──────────────────── */
  'ROLE_UNKNOWN',
  'EMPLOYEE_STATUS_UNKNOWN',
  /* w2-10: a person's country that is not an ISO-3166-1 alpha-2 code. */
  'COUNTRY_UNKNOWN',
  'MANAGER_NOT_IN_ORG',
  'EMAIL_TAKEN',
  'MANAGER_CYCLE',
  'DEACTIVATE_SELF',
  'EMPLOYEE_HAS_REPORTS',
  'REASSIGNMENT_CYCLE',
  /* w4-10d: ExpenseOS's role-change guards (users.setRole). */
  'LAST_ADMIN',
  'ROLE_SELF_LOCKOUT',
  'ROLE_ABOVE_GRANTOR',

  /* budgets (lib/budgets/admin.ts) ─────────────────────────────────────── */
  'BUDGET_NAME_REQUIRED',
  'BUDGET_NEEDS_ACCOUNT',
  'BUDGET_YEAR_INVALID',
  'BUDGET_DUPLICATE_SCOPE',
  'BUDGET_SCOPE_NOT_IN_ORG',
  'BUDGET_PERIOD_COUNT_INVALID',
  'BUDGET_AMOUNT_NOT_WHOLE',
  'BUDGET_AMOUNT_NEGATIVE',
  'BUDGET_THRESHOLD_MALFORMED',
  'BUDGET_THRESHOLD_OUT_OF_RANGE',
  'BUDGET_THRESHOLD_DUPLICATE',

  /* branding (lib/branding/service.ts) ─────────────────────────────────── */
  'COLOUR_MALFORMED',
  'COLOUR_UNREADABLE',
  'LOGO_FORMAT_UNSUPPORTED',
  'LOGO_NOT_AN_IMAGE',
  'LOGO_TYPE_MISMATCH',
  'LOGO_EMPTY',
  'LOGO_TOO_LARGE',
  'TAGLINE_TOO_LONG',

  /* approvals and analytics ─────────────────────────────────────────────── */
  'TASK_WITHDRAWN',
  'ANALYTICS_RANGE_REQUIRED',
  'ANALYTICS_RANGE_INVERTED',

  /* the chart of accounts (lib/accounts/*) ─────────────────────────────── */
  'COA_ALREADY_EXISTS_IMPORT',
  'COA_ALREADY_EXISTS_ADD',
  'COA_IMPORT_HAD_PROBLEMS',
  'ACCOUNT_NEEDS_NUMBER_AND_NAME',
  'ACCOUNT_NEEDS_NAME',
  'ACCOUNT_PARENT_MISSING',
  'ACCOUNT_NUMBER_TAKEN',
  'ACCOUNT_PARENT_IN_USE',
  'ACCOUNT_IN_USE',
  'COA_FILE_UNREADABLE',
  'ACCOUNT_IS_ROLLUP',
  'ACCOUNT_IS_INACTIVE',
  'LEDGER_REPORTED_NOTHING',
  'LEDGER_DUPLICATE_NUMBERS',
  'QUEUED_POST_NOT_FOUND',

  /* connected integrations (lib/integrations/*) ────────────────────────── */
  'INTEGRATION_FIELD_REQUIRED',
  'INTEGRATION_UNKNOWN',
  'INTEGRATION_ALREADY_CONNECTED',
  'INTEGRATION_CODE_TAKEN',
  'INTEGRATION_CODE_OTHER_INTEGRATION',
  'INTEGRATION_BUILD_LACKS_ADAPTER',
  'INTEGRATION_NOT_OAUTH',
  'CAPABILITY_RIVAL',
  'CAPABILITY_AMBIGUOUS',
  'CAPABILITY_NONE',
  'OAUTH_LINK_INVALID',
  'OAUTH_ALREADY_COMPLETED',
  'OAUTH_CONNECTION_GONE',
  'OAUTH_NEEDS_REAUTH',
  'OAUTH_NO_REFRESH_TOKEN',
  'OAUTH_NEEDS_CONSENT',
  'OAUTH_PROVIDER_REFUSED',
  'OAUTH_CALLBACK_INCOMPLETE',

  /* Slack (w5-02, lib/notifications/slackConnection.ts) ─────────────────── */
  'SLACK_TOKEN_REQUIRED',
  'SLACK_NOT_CONNECTED',

  /* Google Workspace directory sync (w5-04, lib/directory/googleConnection.ts) ─ */
  'DIRECTORY_KEY_REQUIRED',
  'DIRECTORY_KEY_INVALID',
  'DIRECTORY_ADMIN_EMAIL_INVALID',
  'DIRECTORY_NOT_CONNECTED',

  /* receipts (lib/receipts/service.ts) ─────────────────────────────────── */
  'RECEIPT_TYPE_UNSUPPORTED',
  'RECEIPT_TOO_LARGE',
  'RECEIPT_ALREADY_CONFIRMED',
  'RECEIPT_NOTHING_UPLOADED',
  'RECEIPT_UPLOAD_INCOMPLETE',
  'RECEIPT_NOT_SCANNED',
  'RECEIPT_NONE_SELECTED',
  'RECEIPT_NOT_UPLOADED_YET',

  /* ── VX4-8 part 4: reviewing a fraud flag ─────────────────────────────── */
  'FRAUD_FLAG_NOT_FOUND',
  'FRAUD_FLAG_ALREADY_REVIEWED',
  'FRAUD_DISMISS_NEEDS_NOTE',
  'FRAUD_FLAG_NEEDS_NOTE',
  'FRAUD_FLAG_NEEDS_SUBJECT',

  /* ── VX4-9: the admin gate's own refusals ─────────────────────────────── */
  'SIGN_IN_REQUIRED',
  'NOT_A_MEMBER_HERE',
  'ACCOUNT_DEACTIVATED',
  'ADMIN_ONLY',
  /* ── People 1: access revoked (has_access, 0072) ──────────────────────── */
  'ACCESS_REVOKED',
  /* ── f09: a deactivated business unit (lib/businessUnits/usable.ts) ─────── */
  'BUSINESS_UNIT_UNAVAILABLE',
] as const;
export type UserMessageCode = (typeof USER_MESSAGE_CODES)[number];

export function isUserMessageCode(value: string): value is UserMessageCode {
  return (USER_MESSAGE_CODES as readonly string[]).includes(value);
}

/**
 * The placeholders one code's sentence needs, DERIVED from the sentence.
 *
 * ── WHY THIS IS DERIVED AND `POLICY_MESSAGES.requires` IS DECLARED ─────────
 *
 * Part 2b declared its `requires` lists by hand and the header there says why:
 * a renderer is a FUNCTION, and a function's body cannot be inspected for the
 * keys it will reach for. That is the whole of UD-5 requirement 3.
 *
 * Here the copy is a STRING, so the placeholders are right there in it. A
 * hand-written list beside it would be a second source of truth about the same
 * fact — and the first draft of this file had one, with `APPROVER_OVERSPECIFIED`
 * already missing from it. Reading the template is not a shortcut; it is the
 * only way to be sure the two agree.
 *
 * Read from the DEFAULT locale's template, because that is the one the type
 * requires to exist. `test/i18n-errors.test.ts` asserts every other locale's
 * override uses the same key set, which is the check this derivation cannot do
 * for itself.
 */
const PLACEHOLDER = /\{(\w+)\}/g;

export function requires(code: UserMessageCode): readonly string[] {
  const template = ERROR_COPY[code][DEFAULT_LOCALE] ?? '';
  return [...new Set([...template.matchAll(PLACEHOLDER)].map((m) => m[1]))];
}

/**
 * The copy. `EnumCopy`'s shape, so the default locale is a compile-time
 * requirement and every other locale is an override — see `enums.ts` on why the
 * asymmetry is the fallback chain in type form.
 */
export const ERROR_COPY: Record<UserMessageCode, Copy> = {
  /* ── generic ───────────────────────────────────────────────────────────── */
  UNEXPECTED: {
    // Deliberately says nothing about what went wrong, and deliberately says
    // that somebody has been told. An apology with no next step is worse than
    // useless on a screen where the person still has work to do.
    'en-CA': 'Something went wrong on our side. Nothing was saved — try again, ' +
      'and if it keeps happening tell your administrator.',
  },

  /* ── submitting and editing ────────────────────────────────────────────── */
  REPORT_NOT_DRAFT: {
    'en-CA': 'This report is no longer a draft, so it cannot be edited.',
  },
  REPORT_EMPTY: {
    // Ported near-verbatim; the em-dash clause is upstream's and it is the useful
    // half — a person told "this report is empty" still has to guess what to add.
    'en-CA': 'This report has no line items — code at least one expense before submitting.',
  },
  /* ── UD-2 ─────────────────────────────────────────────────────────────────
   *
   * One code per BRANCH, the same shape as BLOCKED_BY_POLICY_ONE/MANY below and
   * for the same reason: the code that KNOWS which sentence applies should record
   * it, rather than leaving a renderer to re-derive a plural from a count it
   * would have to be handed anyway.
   *
   * `{categories}` is a list of category LABELS — the thing somebody fixes, and
   * not an identifier, so it passes `assertRenderableParams`. It is the whole
   * point of the message: "your report cannot be posted" without naming what
   * needs mapping is a refusal an employee can only escalate by guessing.
   *
   * Both sentences say WHO fixes it. The employee cannot: a category's GL
   * account is admin-owned (`0014` made it nullable precisely because "the
   * employee filing the expense is not who fixes it"), so a refusal that does
   * not name the administrator leaves the person staring at a screen they have
   * no permission to change.
   */
  SUBMIT_UNCODED_ONE: {
    'en-CA':
      'This report cannot be sent to the accounting system yet: the category {categories} has ' +
      'no account assigned. Ask an administrator to map it on the chart-of-accounts screen, ' +
      'then submit again.',
  },
  SUBMIT_UNCODED_MANY: {
    'en-CA':
      'This report cannot be sent to the accounting system yet: these categories have no ' +
      'account assigned — {categories}. Ask an administrator to map them on the ' +
      'chart-of-accounts screen, then submit again.',
  },

  /* ── VX4-11 ───────────────────────────────────────────────────────────────
   *
   * A COUNT rather than a list of merchants, which is where this differs from
   * SUBMIT_UNCODED above. Two reasons: an expense is not required to have a
   * merchant, so half a list could read "and (no merchant)"; and unlike an
   * unmapped category — which lives on a screen the employee cannot reach — every
   * undated expense is on the page they are already looking at, with its date
   * field sitting empty. The count tells them how many to look for.
   */
  SUBMIT_UNDATED_ONE: {
    'en-CA':
      'One expense on this report has no date. Add the date it was incurred — it is used to ' +
      'match duplicates and to put the spend in the right period.',
  },
  SUBMIT_UNDATED_MANY: {
    'en-CA':
      '{count} expenses on this report have no date. Add the date each was incurred — dates are ' +
      'used to match duplicates and to put the spend in the right period.',
  },

  /* ── VX5-1: signup ────────────────────────────────────────────────────────
   *
   * These reach somebody who has no account yet, which is a reader this
   * catalogue has never had before: everything else here is shown to a person
   * already inside a tenant. So they name the field and say what to do, and none
   * of them mentions a slug — the word is ours, not theirs. "Web address" is
   * what the thing IS to the person choosing it.
   */
  SIGNUP_EMAIL: {
    'en-CA': 'Enter the email address you want to sign in with.',
  },
  SIGNUP_LINK_DEAD: {
    // ONE sentence for three cases — unknown, already used, expired — because
    // `0035`'s policy makes them one case (the row is not visible) and because
    // telling somebody WHICH would say whether a token they hold ever existed.
    // "Start again" is the only action, whichever it was.
    'en-CA':
      'That confirmation link is no longer valid — it may have expired or already been used. ' +
      'Start again and we will send a new one.',
  },
  SIGNUP_CLOSED: {
    'en-CA': 'Sign-up is by invitation here. Ask your organization\'s administrator to invite you.',
  },
  ORG_NAME_REQUIRED: {
    'en-CA': 'Give your organization a name — it is what your people will see when they sign in.',
  },
  ORG_SLUG_SHAPE: {
    'en-CA':
      'A web address can use lowercase letters, numbers and hyphens only, and must start and end ' +
      'with a letter or number.',
  },
  ORG_SLUG_RESERVED: {
    // Not "invalid": it is a perfectly good address that is not available, and
    // telling somebody their choice was invalid when it was taken sends them
    // looking for the mistake they made.
    'en-CA': 'That web address is reserved. Choose another one.',
  },
  ORG_SLUG_TAKEN: {
    'en-CA': 'That web address is already in use. Choose another one.',
  },

  /* ── VX5-3: invites ───────────────────────────────────────────────────────
   *
   * Two readers again, and further apart than anywhere else in this catalogue.
   * `INVITE_EMAIL`, `INVITE_ALREADY_MEMBER` and `INVITE_NOT_LIVE` are read by an
   * ADMIN looking at their own directory. `INVITE_LINK_DEAD` and
   * `INVITE_NOT_FOR_YOU` are read by somebody who does not have an account and
   * may never have heard of this product.
   */
  INVITE_EMAIL: {
    'en-CA': 'Enter the work email address to invite.',
  },
  INVITE_LINK_DEAD: {
    // ONE sentence for four cases — unknown, expired, revoked, already accepted —
    // because `0036`'s policy makes them one case, and because telling somebody
    // WHICH would say whether an invitation they hold ever existed. `ask again`
    // rather than `start again`: unlike a signup, they cannot fix this alone.
    'en-CA':
      'That invitation is no longer valid — it may have expired, been withdrawn, or already ' +
      'been used. Ask whoever invited you to send a new one.',
  },
  INVITE_ALREADY_MEMBER: {
    'en-CA': 'That person is already in your organization.',
  },
  INVITE_NOT_LIVE: {
    // Reads after a race: the admin pressed Withdraw on a list drawn a moment
    // before, and the invitation was accepted in between. Says what happened
    // rather than that the button failed, because the outcome is not an error —
    // the person is in.
    'en-CA': 'That invitation is no longer pending — it was accepted or withdrawn already.',
  },
  WRONG_TENANT_HOST: {
    // Says WHAT happened and WHAT to do, and names neither organization. The
    // reader is signed in to one of them, so telling them that one is safe — but
    // the sentence is also rendered on a host somebody else chose, and confirming
    // "yes, acme is a customer of ours" to whoever typed it is an oracle this
    // page has no reason to be.
    'en-CA':
      'This web address belongs to a different organization than the one you are signed in to. ' +
      'Sign out and sign in again to use it.',
  },
  INVITE_NOT_FOR_YOU: {
    // The one that has to be careful. Somebody signed in with the wrong work
    // account, which is the likeliest way this flow fails for an honest person —
    // so it names the fix. It must NOT name the invited address: this is rendered
    // to whoever just signed in, and they are, by construction, not that person.
    'en-CA':
      'That invitation was sent to a different address. Sign in with the work account it ' +
      'was sent to, or ask for a new invitation.',
  },

  // w2-11 (d34). ExpenseOS's rule, in the same one-code-per-branch shape as
  // BLOCKED_BY_POLICY below, and with no count for the same reason: the policy panel lists
  // every warning that still needs a note.
  SUBMIT_UNJUSTIFIED_WARNING_ONE: {
    'en-CA':
      'One policy warning needs a justification before this report can be submitted. Add a ' +
      'note explaining the exception, or an explanation on the expense.',
  },
  SUBMIT_UNJUSTIFIED_WARNING_MANY: {
    'en-CA':
      'Policy warnings need a justification before this report can be submitted. Add a note ' +
      'explaining each exception, or an explanation on the expense.',
  },
  BLOCKED_BY_POLICY_ONE: {
    'en-CA': 'One blocking policy violation has to be fixed before this report can be submitted.',
  },
  BLOCKED_BY_POLICY_MANY: {
    // The COUNT is gone, and it is the one place this ticket loses information.
    // It is affordable here and nowhere else: the policy panel directly below
    // this banner lists every blocking finding, so the number was a summary of
    // something already on screen. Keeping it would have meant a parameter, and
    // a parameter would have meant an encoding scheme in every URL.
    'en-CA': 'Blocking policy violations have to be fixed before this report can be submitted.',
  },
  BILLING_LAPSED: {
    // WHAT STILL WORKS comes first, because the person reading this is usually an
    // employee who did nothing wrong and whose next thought is "have I lost my
    // work". They have not: drafts still save, everything is still readable.
    //
    // It names an administrator rather than a page, and deliberately gives no
    // link: the billing screen is ADMIN-only, so a link would take most readers
    // of this sentence to a refusal — which is the "dead end dressed as help"
    // shape VX4-9's forbidden page exists to stop.
    'en-CA':
      'This organization\u2019s subscription has lapsed, so reports cannot be submitted, ' +
      'approved or paid right now. Your drafts are saved and everything is still ' +
      'readable \u2014 an administrator can restore this from the billing settings.',
  },
  SEAT_LIMIT_REACHED: {
    // Read by the person ACCEPTING an invitation as often as by an admin, so it
    // says who can fix it rather than pointing at a page most readers cannot open.
    'en-CA':
      'This organization\u2019s plan allows {limit} people, and every seat is taken. ' +
      'An administrator can free one or change the plan from the billing settings.',
  },
  EXPENSE_LIMIT_REACHED: {
    'en-CA':
      'This organization\u2019s plan allows {limit} expenses a year, and that many have been ' +
      'added in the last twelve months. Your drafts are saved \u2014 an administrator can ' +
      'change the plan from the billing settings.',
  },
  REPORT_NOT_SUBMITTABLE: {
    // w2-11: a RETURNED report is submittable too (d26, ExpenseOS's rule).
    'en-CA': 'Only a draft or a returned report can be submitted, and this report is neither.',
  },
  REPORT_NOT_RECALLABLE: {
    'en-CA': 'Only a submitted or returned report can be recalled.',
  },
  REPORT_NOT_REIMBURSABLE: {
    'en-CA': 'Only an approved report can be marked reimbursed.',
  },
  REIMBURSE_OWN_REPORT: {
    'en-CA':
      'You cannot mark your own report reimbursed — ask somebody else in finance to ' +
      'release the payment.',
  },
  REIMBURSE_RACE: {
    // Not a failure the person did anything wrong to cause, and the copy says so
    // rather than reading as a refusal. Somebody else got there first.
    'en-CA': 'Somebody else marked this report reimbursed a moment ago.',
  },
  TITLE_REQUIRED: {
    'en-CA': 'Give the report a title.',
  },
  AMOUNT_NOT_WHOLE_MINOR: {
    // `lib/money.ts` REFUSES extra decimals rather than rounding (VX1-6), so this
    // is reachable by typing $10.005 — and the copy has to explain a rule the
    // person has no reason to know, without saying "minor units" at them.
    'en-CA': 'That amount has more decimal places than this currency uses.',
  },
  CURRENCY_UNKNOWN: {
    'en-CA': 'That currency is not one this organization has set up.',
  },
  CATEGORY_UNKNOWN: {
    'en-CA': 'That category is not one this organization has, or it has been retired.',
  },

  /* ── deciding an approval ──────────────────────────────────────────────── */
  REASSIGN_TARGET_UNKNOWN: {
    'en-CA': 'That person is not an active member of this organization, so the approval cannot go to them.',
  },
  REASSIGN_TARGET_SUBMITTER: {
    'en-CA': 'A report cannot be handed to the person who submitted it to approve.',
  },
  REASSIGN_TARGET_SAME: {
    'en-CA': 'That person already holds this approval.',
  },
  REASSIGN_REASON_REQUIRED: {
    'en-CA':
      'Say why the approval is being passed on — the submitter and the new approver both see it.',
  },
  TASK_ALREADY_DECIDED: {
    // THE most common one on this list, and it is not an error in any useful
    // sense: two approvers open the same inbox, or somebody uses the back button.
    // It says what happened and does not blame anybody for it.
    'en-CA': 'That approval has already been decided.',
  },
  TASK_NOT_YOURS: {
    // Replaces `user ${actorId} may not decide approval task ${taskId}` — two
    // internal UUIDs shown to somebody who, by definition, has no right to the
    // record. Saying less here is a fix, not a loss.
    'en-CA': 'This approval is not yours to decide.',
  },
  SELF_APPROVAL: {
    'en-CA': 'A report cannot be approved by the person who submitted it.',
  },
  SUBMIT_NEEDS_APPROVER: {
    // DECIDED 4 Oct 2026: nobody approves their own expenses, including the only
    // person in the tenant. So this does not offer a way round — it says who to
    // add, and where, in the words the home page's setup list already uses.
    'en-CA':
      'Nobody else here can approve this report, and an expense report cannot be approved by ' +
      'the person who filed it. Invite somebody who can approve (Employees \u2192 Invite someone) ' +
      'or give yourself a manager, then submit again. Your report is saved as a draft.',
  },
  SUBMIT_NO_WORKFLOW: {
    // d58: ExpenseOS approves a report no workflow governs; VeloExpense refuses it. The fix
    // is an administrator's, so the copy says whose — and that nothing was lost.
    'en-CA':
      'No approval workflow applies to this report, so it cannot be submitted. Ask an ' +
      'administrator to publish one (Admin \u2192 Approval workflows). Your report has not ' +
      'been submitted and is unchanged.',
  },
  REPORT_NOT_AWAITING_APPROVAL: {
    'en-CA': 'That report is not waiting for approval.',
  },

  /* ── delegating ────────────────────────────────────────────────────────── */
  DELEGATE_FOR_SOMEBODY_ELSE: {
    'en-CA': 'Only an administrator can delegate somebody else’s approvals.',
  },
  DELEGATE_TO_SELF: {
    'en-CA': 'You cannot delegate your approvals to yourself.',
  },
  DELEGATION_SCOPE_UNKNOWN: {
    'en-CA': 'Pick what this delegation covers.',
  },
  // Three codes where the error code has one (`INVALID_RANGE`). This is the
  // finding in `lib/errors/domain.ts` made concrete: a caller branching on the
  // code does not need to tell these apart, and a person fixing the form does.
  DELEGATION_START_REQUIRED: {
    'en-CA': 'Give a start date.',
  },
  DELEGATION_END_INVALID: {
    'en-CA': 'Give an end date, or leave it open-ended.',
  },
  DELEGATION_END_BEFORE_START: {
    'en-CA': 'The end date is before the start date.',
  },
  DELEGATEE_NOT_IN_ORG: {
    'en-CA': 'That person is not in this organization.',
  },
  DELEGATEE_INACTIVE: {
    // The NAME is gone from this one ("Dana is not active, so…"). It was the only
    // interpolated value on a user-facing message in this half, and it is
    // affordable: the person picked that name from a select two seconds ago.
    'en-CA': 'That person is not active, so approvals sent to them would go nowhere.',
  },
  DELEGATION_ALREADY_REVOKED: {
    'en-CA': 'That delegation was already revoked.',
  },
  DELEGATION_NOT_YOURS: {
    'en-CA': 'That delegation is not yours to revoke.',
  },

  /* ── the receipt drawer ────────────────────────────────────────────────── */
  // Found by `check:i18n`'s new gate, not by looking: the drawer is a CLIENT
  // component and its failures never went near `?error=`, so it was outside
  // every list this ticket was working from. What it was printing is whatever
  // crossed the server-action boundary or came back from an upload — a Next
  // digest string in production, a browser fetch error otherwise. Neither is
  // copy anybody wrote, and neither tells the person what to do.
  RECEIPT_ACTION_FAILED: {
    'en-CA': 'That did not work. Try again, and check the file is a PDF or an image under 10 MB.',
  },
  RECEIPT_OPEN_FAILED: {
    'en-CA': 'That receipt could not be opened. Try again in a moment.',
  },

  /* ════════════════════════ part 2c-2: the admin half ═══════════════════════
   *
   * PORTED, not rewritten. Unlike the approvals half — where the messages were
   * diagnostics with UUIDs in them and had to be replaced — most of these were
   * already written for the admin who pressed the button. So the rule here was:
   * move the sentence, keep the words, and change only what a code cannot carry.
   *
   * Three kinds of change, each marked where it happens:
   *   · a leading capital and a full stop, because these are now sentences in a
   *     banner rather than fragments after "Error: ";
   *   · a value that was a record id or a bare internal token dropped;
   *   · one split into two codes where the sentence was singular/plural.
   * ═══════════════════════════════════════════════════════════════════════════ */

  /* ── amounts and rates ─────────────────────────────────────────────────── */
  AMOUNT_REQUIRED: {
    'en-CA': 'An amount is required.',
  },
  AMOUNT_MALFORMED: {
    'en-CA': '“{given}” is not a valid amount.',
  },
  AMOUNT_TOO_MANY_DECIMALS_ONE: {
    // Split from one message whose plural was computed inline
    // (`decimal place${minorUnit === 1 ? '' : 's'}`). Two codes rather than a
    // parameter, per the rule in lib/errors/domain.ts.
    'en-CA': 'That amount has more than one decimal place.',
  },
  AMOUNT_TOO_MANY_DECIMALS_MANY: {
    // The limit itself is dropped rather than parameterised: it is a property of
    // the currency the person already chose, and the sentence is actionable
    // without it. AMOUNT_NOT_WHOLE_MINOR (part 2c-1) says the same thing on the
    // expense form.
    'en-CA': 'That amount has more decimal places than this currency uses.',
  },

  /* ── language and time ─────────────────────────────────────────────────── */
  LOCALE_REQUIRED: {
    'en-CA': 'Pick a language.',
  },
  LOCALE_UNSUPPORTED: {
    'en-CA': '“{given}” is not a language this product ships. Pick one from the list.',
  },
  TIMEZONE_REQUIRED: {
    'en-CA': 'Pick a time zone.',
  },

  /* ── notification setup ────────────────────────────────────────────────── */
  // The three `unknown ${x}` messages here interpolated an internal token that
  // could only come from a tampered form — the value is dropped and the log
  // keeps it.
  EVENT_TYPE_UNKNOWN: {
    'en-CA': 'That is not an event this product can notify on.',
  },
  CHANNEL_UNKNOWN: {
    'en-CA': 'That is not a delivery channel this product has.',
  },
  TEMPLATE_KEY_UNKNOWN: {
    'en-CA': 'That is not a template this product has.',
  },

  /* ── the employee directory ────────────────────────────────────────────── */
  ROLE_UNKNOWN: {
    'en-CA': 'That is not a role this product has.',
  },
  COUNTRY_UNKNOWN: {
    'en-CA': 'That is not a country code this product knows.',
  },
  EMPLOYEE_STATUS_UNKNOWN: {
    'en-CA': 'That is not an employee status this product has.',
  },
  MANAGER_NOT_IN_ORG: {
    'en-CA': 'That manager is not in this organization.',
  },
  EMAIL_TAKEN: {
    'en-CA': 'An employee with that email already exists.',
  },
  MANAGER_CYCLE: {
    'en-CA': 'That manager would create a reporting cycle.',
  },
  DEACTIVATE_SELF: {
    'en-CA': 'You cannot deactivate your own account.',
  },
  EMPLOYEE_HAS_REPORTS: {
    // The COUNT is kept, and it is one of the fourteen that earns a parameter:
    // an admin deciding where to move a team needs to know whether it is one
    // person or eleven, and the directory behind the banner is filtered.
    'en-CA':
      '{count} direct report(s) still report to this employee — choose a new manager first.',
  },
  REASSIGNMENT_CYCLE: {
    'en-CA': 'That reassignment would create a reporting cycle.',
  },
  LAST_ADMIN: {
    'en-CA':
      'This is the last active System Administrator. Give another person that role before changing or deactivating this one.',
  },
  ROLE_SELF_LOCKOUT: {
    'en-CA': 'You cannot give yourself a role without the permission to manage employees.',
  },
  ROLE_ABOVE_GRANTOR: {
    // The permissions are named: the admin needs to know which ones their own role lacks.
    'en-CA': 'You cannot give a role with permissions you do not hold yourself: {permissions}.',
  },

  /* ── budgets ───────────────────────────────────────────────────────────── */
  BUDGET_NAME_REQUIRED: {
    'en-CA': 'A budget needs a name.',
  },
  BUDGET_NEEDS_ACCOUNT: {
    'en-CA': 'A budget has to name a GL account — it is what makes the number reconcilable.',
  },
  BUDGET_YEAR_INVALID: {
    'en-CA': 'The fiscal year has to be a whole year like 2026.',
  },
  BUDGET_DUPLICATE_SCOPE: {
    'en-CA':
      'A budget already exists for that account and scope in that fiscal year — edit it instead.',
  },
  BUDGET_SCOPE_NOT_IN_ORG: {
    'en-CA': 'That GL account, business unit, department or owner is not in this organization.',
  },
  BUDGET_PERIOD_COUNT_INVALID: {
    'en-CA': 'A budget year is between 1 and 53 periods.',
  },
  BUDGET_AMOUNT_NOT_WHOLE: {
    'en-CA': 'The amount must be a whole number of minor units.',
  },
  BUDGET_AMOUNT_NEGATIVE: {
    'en-CA': 'A budget cannot be negative.',
  },
  BUDGET_THRESHOLD_MALFORMED: {
    'en-CA':
      '“{given}” is not a percentage — use a number like 90 or 99.5, with at most two decimals.',
  },
  BUDGET_THRESHOLD_OUT_OF_RANGE: {
    'en-CA': 'A threshold is between 0.01% and 200%.',
  },
  BUDGET_THRESHOLD_DUPLICATE: {
    'en-CA': 'That threshold is already configured for this budget.',
  },

  /* ── branding ──────────────────────────────────────────────────────────── */
  COLOUR_MALFORMED: {
    // `JSON.stringify(input)` in the original, which prints quotes around a
    // string and `{}` for an object — a shape only an engineer reads.
    'en-CA': '“{given}” is not a colour — expected a hex value such as #0f766e.',
  },
  COLOUR_UNREADABLE: {
    // All three numbers KEPT, deliberately. `e2e/branding-flow.spec.ts` asserts
    // each of them and its comment says why: "Contrast too low" is not something
    // an admin can act on; "4.00 against white, 4.46 against dark, we need 4.5"
    // tells them the colour is too middling and roughly by how much. This is the
    // clearest case in the product for parameters existing at all.
    //
    // Ported in full, including the closing clause. My first draft of this entry
    // ended at "…is needed for either" and dropped "Try a deeper or lighter
    // shade of the same hue" — the ONLY actionable sentence in the message, cut
    // because I was working from a truncated dump rather than the source. That is
    // the part-2a regression exactly, and the reason the port rule is to read the
    // line, not a summary of it.
    'en-CA':
      '{hex} cannot carry readable text: {white}:1 against white and {ink}:1 against dark ink, ' +
      'and {floor}:1 is needed for button and badge labels. Try a deeper or lighter shade of ' +
      'the same hue.',
  },
  LOGO_FORMAT_UNSUPPORTED: {
    // "our own pages", as written. The word was dropped in my first draft.
    'en-CA':
      '{mime} is not an accepted logo format — use PNG, JPEG or WebP. SVG is refused because ' +
      'it can carry script into our own pages.',
  },
  LOGO_NOT_AN_IMAGE: {
    // The magic-byte sniff, which my first pass missed entirely: the throw at
    // lib/branding/service.ts:229 carries TWO sentences behind a ternary and the
    // dump I was reading had truncated it. Two codes, one per branch.
    'en-CA': 'The uploaded file is not a PNG, JPEG or WebP image, whatever it is named.',
  },
  LOGO_TYPE_MISMATCH: {
    'en-CA':
      'The file was sent as {mime} but its contents are {sniffed} — re-export it, or upload ' +
      'it with the right type.',
  },
  LOGO_EMPTY: {
    'en-CA': 'The uploaded logo is empty.',
  },
  LOGO_TOO_LARGE: {
    'en-CA': 'The logo is {size} KiB and the limit is {limit} KiB.',
  },
  TAGLINE_TOO_LONG: {
    'en-CA': 'The tagline is {length} characters and the limit is {limit}.',
  },

  /* ── approvals and analytics ──────────────────────────────────────────── */
  ANALYTICS_RANGE_REQUIRED: {
    'en-CA': 'Analytics needs a start and an end date — there is deliberately no default range.',
  },
  ANALYTICS_RANGE_INVERTED: {
    // The two dates are dropped: they are the two inputs directly above the
    // banner on that screen, which is the 2c-1 argument holding.
    'en-CA': 'The range ends before it begins.',
  },
  TASK_WITHDRAWN: {
    // The email-approval page's own copy, moved rather than rewritten. It was
    // already a sentence for a reader — `lib/notifications/approve.ts` shapes
    // these deliberately — which is exactly why it deserved a code instead of
    // being the one string on that page nobody could translate.
    'en-CA': 'This report was withdrawn or decided elsewhere, so there is nothing to approve.',
  },

  /* ── the chart of accounts ─────────────────────────────────────────────── */
  COA_ALREADY_EXISTS_IMPORT: {
    'en-CA': 'This organization already has a chart of accounts — import or add accounts instead.',
  },
  COA_ALREADY_EXISTS_ADD: {
    'en-CA': 'This organization already has a chart of accounts — add accounts individually instead.',
  },
  COA_IMPORT_HAD_PROBLEMS: {
    // The per-line detail was appended by the action as raw text
    // (`err.message + detail`). It is the useful half — "3 problems" without
    // "line 4: Cash is not a number" leaves an admin opening the file blind — so
    // it moved into a parameter rather than being dropped. It is the admin's own
    // file content, capped at five lines by the action, not anything internal.
    'en-CA': 'That file has {problems} problem(s), and none of it was imported ({detail}).',
  },
  ACCOUNT_NEEDS_NUMBER_AND_NAME: {
    'en-CA': 'An account needs a number and a name.',
  },
  ACCOUNT_NEEDS_NAME: {
    'en-CA': 'An account needs a name.',
  },
  ACCOUNT_PARENT_MISSING: {
    'en-CA': 'There is no account numbered {number} to be the parent.',
  },
  ACCOUNT_NUMBER_TAKEN: {
    'en-CA': 'Account {number} already exists.',
  },
  ACCOUNT_PARENT_IN_USE: {
    'en-CA':
      '{number} is coded to by {categories} category/categories and {lines} expense line(s). ' +
      'Adding a child under it would make those postings ambiguous.',
  },
  ACCOUNT_IN_USE: {
    'en-CA':
      'That account is in use ({categories} category/categories, {lines} expense line(s), ' +
      '{children} child account(s)) — deactivate it instead of deleting it.',
  },
  COA_FILE_UNREADABLE: {
    // Was `e instanceof Error ? e.message : …` — a THIRD-PARTY CSV parser's
    // exception, put in a URL and on an admin's screen. Found while tagging, not
    // by the gate, because it is inside a service rather than an action; the
    // parser's own text tells an admin nothing about their file.
    'en-CA': 'That file could not be read as CSV. Check it is comma-separated with a header row.',
  },
  ACCOUNT_IS_ROLLUP: {
    // Both of these were a POSTGRES TRIGGER's RAISE message, string-matched with
    // a regex and then reshaped with `message.replace(/^[^:]*:\s*/, '')` before
    // being shown. The two regex branches already knew which case it was, so two
    // codes is what the code was reaching for; a database's error text now stops
    // at the log.
    'en-CA': 'That account is a rollup, so expenses cannot be posted to it directly.',
  },
  ACCOUNT_IS_INACTIVE: {
    'en-CA': 'That account is inactive, so expenses cannot be posted to it.',
  },
  LEDGER_REPORTED_NOTHING: {
    'en-CA':
      'The ledger reported no accounts at all — check the configured entity before treating ' +
      'that as correct.',
  },
  LEDGER_DUPLICATE_NUMBERS: {
    'en-CA':
      'The ledger reports these account numbers more than once, so the chart cannot be ' +
      'reconciled: {numbers}.',
  },

  QUEUED_POST_NOT_FOUND: {
    'en-CA': 'That queued post is no longer there.',
  },

  /* ── connected integrations ────────────────────────────────────────────── */
  INTEGRATION_FIELD_REQUIRED: {
    // The FIELD's label, from the adapter's own config schema — product copy, and
    // what makes this point at the right box on a form with six of them.
    'en-CA': '{field} is required.',
  },
  INTEGRATION_UNKNOWN: {
    'en-CA': 'That is not an integration this build has.',
  },
  INTEGRATION_ALREADY_CONNECTED: {
    'en-CA':
      '{name} is already connected for this organization. Disconnect it first, or edit the ' +
      'existing connection.',
  },
  INTEGRATION_CODE_TAKEN: {
    'en-CA': 'The code “{code}” is already used here.',
  },
  INTEGRATION_CODE_OTHER_INTEGRATION: {
    // The rival integration's slug is DROPPED from what the original said
    // (`(${row.integration_slug})`). It is an internal identifier and the
    // sentence is actionable without it; the log keeps it.
    'en-CA': 'The code “{code}” belongs to a different integration here. Choose another.',
  },
  INTEGRATION_BUILD_LACKS_ADAPTER: {
    // Reachable after a downgrade or a rename: a stored connection names an
    // adapter this build has no code for. An admin can act on it (reconnect, or
    // roll forward), so it is not an invariant — but the slug goes to the log.
    'en-CA':
      'This connection names an integration this build does not have. It may have been ' +
      'renamed or removed — reconnect it, or ask your administrator.',
  },
  INTEGRATION_NOT_OAUTH: {
    'en-CA': '{name} is not connected by authorisation — it takes configuration values.',
  },
  CAPABILITY_RIVAL: {
    // `rivalMessage()` built this by hand in lib/integrations/conflicts.ts. Both
    // names and the overlapping jobs are kept: AC-22 is the whole reason this
    // refusal exists, and "two things conflict" without saying which two is not
    // something an admin can resolve.
    'en-CA':
      '“{rival}” is already connected and can {jobs}, so connecting {name} as well would ' +
      'leave no single answer to which one an approved report goes to. Disconnect “{rival}” ' +
      'first if you are switching.',
  },
  CAPABILITY_AMBIGUOUS: {
    'en-CA':
      '{names} are both connected and can {jobs}, so there is no single answer to which one ' +
      'should be used. Disconnect one of them.',
  },
  CAPABILITY_NONE: {
    'en-CA': 'No connected integration in this organization can {jobs}.',
  },
  OAUTH_LINK_INVALID: {
    // Ported EXACTLY. `oauth.ts` keeps "unknown", "already used" and "expired"
    // indistinguishable on purpose so the wording cannot be used to probe for
    // valid states, and three codes here would have undone that deliberately
    // built property. One code, one sentence — which is also why this is the one
    // place in the file where fewer codes is the correct answer.
    'en-CA':
      'This authorisation link is no longer valid. Start the connection again from the ' +
      'integrations screen.',
  },
  OAUTH_ALREADY_COMPLETED: {
    'en-CA': 'This authorisation was already completed.',
  },
  OAUTH_CONNECTION_GONE: {
    'en-CA': 'The connection this authorisation belongs to is gone.',
  },
  OAUTH_NEEDS_REAUTH: {
    'en-CA':
      'This connection needs authorising again — somebody with access to the accounting ' +
      'system has to sign in and approve it.',
  },
  OAUTH_NO_REFRESH_TOKEN: {
    'en-CA': 'This connection has no refresh token, so it cannot be renewed. Authorise it again.',
  },
  OAUTH_NEEDS_CONSENT: {
    // THE ONE I NAMED IN #88 AS THE FIRST THING TO CLOSE. This was
    // `throw new IntegrationError(err.message, 'NEEDS_CONSENT')`, where `err` is
    // an `OAuthConsentRequired` raised by an ADAPTER — so a far-end service's
    // text went into a query string and onto an admin's screen. Whatever
    // QuickBooks or a future adapter chooses to say is now in the log, and the
    // admin gets a sentence written here.
    'en-CA':
      'The accounting system needs this connection authorised again. Reconnect it from the ' +
      'integrations screen.',
  },

  OAUTH_PROVIDER_REFUSED: {
    // FOUND BY THE STRICT RENDERER, via a failing e2e — the best kind of find.
    // This was `sp.get('error_description') ?? …`: text taken straight off the
    // far end's query string and rendered inside our own error banner. A remote
    // party choosing the words in our UI is not something to leave running, and
    // 2c-1's pass-through renderer would have kept doing it silently.
    //
    // The provider's error CODE is dropped too — also remote input — and goes to
    // the log with the description. "refused the connection" is kept from the
    // original because `e2e/oauth-flow.spec.ts` asserts on it, and it is the
    // half an admin needs.
    'en-CA': 'The accounting system refused the connection. Nothing was changed.',
  },
  OAUTH_CALLBACK_INCOMPLETE: {
    'en-CA': 'That authorisation came back incomplete. Start the connection again.',
  },

  /* ── Slack ─────────────────────────────────────────────────────────────── */
  SLACK_TOKEN_REQUIRED: {
    'en-CA': 'Paste the Bot User OAuth Token (xoxb-…) to connect Slack.',
  },
  SLACK_NOT_CONNECTED: {
    'en-CA': 'Slack is not connected, so there is nothing to test.',
  },

  /* ── Google Workspace directory sync ───────────────────────────────────── */
  DIRECTORY_KEY_REQUIRED: {
    'en-CA': 'Paste the service account key file (JSON) to connect Google Workspace.',
  },
  DIRECTORY_KEY_INVALID: {
    'en-CA':
      'That is not a service account key file. Paste the whole JSON file Google downloaded, from the opening brace to the closing one.',
  },
  DIRECTORY_ADMIN_EMAIL_INVALID: {
    'en-CA': 'Enter the email address of a Google Workspace administrator.',
  },
  DIRECTORY_NOT_CONNECTED: {
    'en-CA': 'Google Workspace is not connected, so there is nothing to test or sync.',
  },

  /* ── receipts ──────────────────────────────────────────────────────────── */
  RECEIPT_TYPE_UNSUPPORTED: {
    'en-CA': '{mime} is not a receipt format this product accepts — use a PDF or an image.',
  },
  RECEIPT_TOO_LARGE: {
    'en-CA': 'That receipt is {size} bytes and the limit is {limit} bytes.',
  },
  RECEIPT_ALREADY_CONFIRMED: {
    'en-CA': 'That receipt is already attached.',
  },
  RECEIPT_NOTHING_UPLOADED: {
    'en-CA': 'No file arrived for that receipt — try the upload again.',
  },
  RECEIPT_UPLOAD_INCOMPLETE: {
    'en-CA': 'That receipt has not finished uploading.',
  },
  RECEIPT_NOT_SCANNED: {
    'en-CA': 'That receipt can be opened once its security scan is clean.',
  },
  RECEIPT_NONE_SELECTED: {
    'en-CA': 'No receipts selected.',
  },
  RECEIPT_NOT_UPLOADED_YET: {
    'en-CA': '{filename} has not finished uploading yet.',
  },

  /* ── VX4-8 part 4: reviewing a fraud flag ─────────────────────────────── */
  FRAUD_FLAG_NOT_FOUND: {
    'en-CA': 'That flag no longer exists — it may have been removed with its report.',
  },
  FRAUD_FLAG_ALREADY_REVIEWED: {
    // Names the outcome rather than blaming the reader: two people working a
    // queue is the system being used, not a mistake either of them made.
    'en-CA':
      'Somebody has already recorded a decision on that flag. Reload the page to see it.',
  },
  FRAUD_DISMISS_NEEDS_NOTE: {
    // WHY, not just what. A dismissal is the one verdict an auditor asks about,
    // and a person told only "a note is required" writes "n/a".
    'en-CA':
      'Say why you are setting this aside — a dismissal is the one decision here that ' +
      'somebody may ask about later.',
  },
  FRAUD_FLAG_NEEDS_NOTE: {
    'en-CA': 'Write what the concern is — a flag with nothing on it is one nobody can action.',
  },
  FRAUD_FLAG_NEEDS_SUBJECT: {
    'en-CA':
      'Say which report this is about. A flag with no subject has nothing for a reviewer to open.',
  },

  /* ── VX4-9: the admin gate's own refusals ─────────────────────────────── */
  //
  // These three replace a bare `Error('forbidden: admin role required')`, which
  // `errorParam` correctly refused to show and turned into the generic
  // "something went wrong on our side" — so a manager who submitted an admin
  // form was told the product had broken. IL-11's shape on the write path.
  SIGN_IN_REQUIRED: {
    'en-CA': 'Your session has ended. Sign in again to carry on.',
  },
  NOT_A_MEMBER_HERE: {
    // The honest reading of "signed in, but no employee record in this tenant":
    // almost always an invite withdrawn between signing in and clicking.
    'en-CA':
      'Your account is not a member of this organization. If it should be, ask an ' +
      'administrator to invite you again.',
  },
  ACCOUNT_DEACTIVATED: {
    // `requireActor` has refused a deactivated account since VX1-10; until now it
    // did so with a diagnostic nobody could show, so the person was told the
    // product had broken rather than that their account had been turned off.
    'en-CA':
      'This account has been deactivated. Ask an administrator of your organization to ' +
      'reactivate it.',
  },
  ACCESS_REVOKED: {
    // People 1 (0072): an administrator turned this person's access off on the People
    // screen. Separate from deactivation — the person is still an employee, still in the
    // org chart and on their reports — so it says "access", not "deactivated".
    'en-CA':
      'Your access to this organization has been turned off. Ask an administrator of your ' +
      'organization if you need it back.',
  },
  ADMIN_ONLY: {
    // Says WHOSE it is and what to do, not just "denied". A person refused with
    // no route forward asks a colleague, and the colleague guesses.
    'en-CA':
      'That is an administrator screen. Ask an administrator of your organization if you ' +
      'need something changed there.',
  },
  BUSINESS_UNIT_UNAVAILABLE: {
    'en-CA': 'That business unit is no longer available. Choose another one.',
  },
};

/**
 * ── PARAMS THAT ARE KEYS, NOT TEXT ─────────────────────────────────────────
 *
 * A refusal's `params` travel through a `?error=` URL, filled where the error is
 * THROWN and rendered somewhere else entirely. So a param filled with a word is a
 * word chosen without knowing who is going to read it — and
 * `POLICY_PARAM_REQUIRED` ("{rule} needs {field}.") did exactly that: eight sites
 * in `lib/policy/service.ts` passed English rule and field names into a
 * catalogued sentence, so a French reader got a French template with
 * `Per-transaction limit` and `Limit` inside it.
 *
 * The fix is that those params now carry the KEY — `PER_TRANSACTION_LIMIT`,
 * `PER_TRANSACTION_LIMIT.thresholdMinor`, `BLOCK` — and this table says which
 * catalogue turns each into words, HERE, where the reader's locale is known.
 *
 * Keyed by PARAM NAME rather than by message code, deliberately: `{rule}` means
 * the same thing in all eight messages that use it, and a per-code table would
 * be eight chances to disagree.
 *
 * A param not in this table is still filled verbatim, which is right — `{count}`
 * and `{name}` are data.
 */
// w4-02d: empty since VeloExpense's v1 policy refusals (`POLICY_*`, whose `{rule}`,
// `{field}` and `{maximum}` params were keys) went with its engine. The mechanism stays for
// the next refusal whose parameter is a key rather than text.
const PARAM_CATALOGUES: Record<string, Record<string, Copy>> = {};

function fill(template: string, params: MessageParams, locale: Locale | string): string | null {
  let missing = false;
  const out = template.replace(/\{(\w+)\}/g, (_m, key: string) => {
    const value = params[key];
    if (value === undefined || value === null || String(value) === '') {
      missing = true;
      return '';
    }
    const catalogue = PARAM_CATALOGUES[key];
    if (catalogue !== undefined) {
      // `enumLabel` returns the missing-copy marker for a value the catalogue does
      // not hold — loud, and the same shape as everywhere else. Not a silent
      // fall-through to the raw key, which would put `PER_TRANSACTION_LIMIT` in a
      // sentence and look almost right.
      return enumLabel(catalogue, String(value), locale);
    }
    return String(value);
  });
  // A sentence with a hole in it reads as a product bug rather than a data one —
  // `policy-messages.ts` learned the same thing about `String(undefined)`. The
  // caller turns null into the generic, which at least tells the truth.
  return missing ? null : out;
}

/**
 * Turn a `?error=` value into words for this reader.
 *
 * THE ONE PLACE that happens — `ErrorBanner` is the only caller, and the only
 * component that renders the parameter.
 *
 * STRICT since part 2c-2: a value that is not a known code becomes the generic,
 * not itself. 2c-1 passed it through so the uncatalogued admin screens kept
 * working; now that they are catalogued, pass-through only serves a
 * hand-edited link, and rendering arbitrary text inside the product's own error
 * banner is a thing worth not doing.
 *
 * Never throws. IL-4 is a missing key blanking a page.
 */
export function renderUserMessage(value: string | null | undefined, locale: Locale | string): string {
  if (value === null || value === undefined || value.trim() === '') return '';
  const { code, params } = decodeUserMessage(value);
  if (!isUserMessageCode(code)) return generic(locale);
  const template = localizedFrom<string>(ERROR_COPY[code], locale);
  if (template === null) return missingCopyMarker(code);
  // A declared key that did not survive the URL means the sentence would have a
  // hole in it. The generic is the honest answer, and the test suite is where
  // this is loud rather than silent.
  for (const key of requires(code)) {
    if (params[key] === undefined) return generic(locale);
  }
  return fill(template, params, locale) ?? generic(locale);
}

function generic(locale: Locale | string): string {
  return localizedFrom<string>(ERROR_COPY.UNEXPECTED, locale) ?? '';
}

/**
 * The generic, for a caller that has no value at all.
 *
 * Routed through `renderUserMessage` rather than reading `ERROR_COPY.UNEXPECTED`
 * directly: `Copy` indexed by `DEFAULT_LOCALE` is `string | undefined` (the
 * constant is typed `Locale`, not its literal), and the honest way to resolve
 * that is the same fallback walk every other string takes, not a `!`.
 */
export function unexpectedMessage(locale: Locale | string): string {
  return generic(locale);
}
