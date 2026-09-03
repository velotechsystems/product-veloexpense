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
 * A `Copy` is a plain string. No interpolation, no parameters, no functions —
 * unlike `policy-messages.ts`, where a sentence genuinely has to say
 * `$700.00`. The difference is not laziness; it is what a refusal is FOR.
 *
 * A policy violation is a statement about a report: it must name the amount and
 * the limit or it says nothing. A refusal is a statement about the ACTION the
 * person just took, on the screen they took it from, with their own input still
 * in front of them. "The end date is before the start date" needs no dates in
 * it — both dates are in the two fields above the banner.
 *
 * That constraint is what lets a code travel in `?error=CODE` with no encoding
 * scheme and be rendered by the page in the READER's locale.
 *
 * ── WHAT IS AND IS NOT IN HERE ──────────────────────────────────────────────
 *
 * Only messages a person can act on. `lib/errors/domain.ts` explains the split
 * at length: `report not found`, `no tenant context` and `delegation not found
 * after insert` are invariant failures, they get no code, and the banner shows
 * `UNEXPECTED` while the real message goes to the log. Cataloguing them would be
 * translating a sentence whose only correct audience is an engineer.
 *
 * Of 265 throw sites across 26 error classes, about 87 sit on a path that can
 * reach a banner. This file covers the employee-and-approver half of those; the
 * admin modules are part 2c-2, and until then they keep printing their English
 * through `errorParam`'s transitional branch.
 */
import { localizedFrom, type Locale } from '../locales';
import { type Copy, missingCopyMarker } from './enums';

export const USER_MESSAGE_CODES = [
  /* generic ─────────────────────────────────────────────────────────────── */
  'UNEXPECTED',

  /* submitting and editing a report ─────────────────────────────────────── */
  'REPORT_NOT_DRAFT',
  'REPORT_EMPTY',
  'BLOCKED_BY_POLICY_ONE',
  'BLOCKED_BY_POLICY_MANY',
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
  'TASK_NOT_YOURS',
  'SELF_APPROVAL',
  'RUN_NOT_RUNNING',
  'RECEIPT_ACK_REQUIRED',
  'STEP_UNROUTABLE',
  'REPORT_NOT_AWAITING_APPROVAL',
  'RUN_ALREADY_OPEN',

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
] as const;
export type UserMessageCode = (typeof USER_MESSAGE_CODES)[number];

export function isUserMessageCode(value: string): value is UserMessageCode {
  return (USER_MESSAGE_CODES as readonly string[]).includes(value);
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
  REPORT_NOT_SUBMITTABLE: {
    'en-CA': 'Only a draft can be submitted, and this report is not one any more.',
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
  RUN_NOT_RUNNING: {
    'en-CA': 'This report is no longer going through approval.',
  },
  RECEIPT_ACK_REQUIRED: {
    'en-CA': 'This approval step requires you to confirm you reviewed the receipts.',
  },
  STEP_UNROUTABLE: {
    // The one refusal on this list whose fix belongs to somebody else, so the
    // copy has to hand it over rather than leave the approver retrying.
    'en-CA':
      'This report cannot be routed to its next approver. The approval ladder or the ' +
      'reporting line needs fixing before it can move — ask your administrator.',
  },
  REPORT_NOT_AWAITING_APPROVAL: {
    'en-CA': 'That report is not waiting for approval.',
  },
  RUN_ALREADY_OPEN: {
    'en-CA': 'That report is already going through approval.',
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
};

/**
 * Turn a `?error=` value into words for this reader.
 *
 * THE ONE PLACE that happens — `ErrorBanner` is the only caller, and it is the
 * only component that renders the parameter.
 *
 * A value that is NOT a known code passes through unchanged. That is the
 * transitional branch `errorParam` writes for an uncatalogued `DomainError`, and
 * it is what keeps every admin screen saying what it says today while part 2c-2
 * fills the rest in. When that lands, this returns the generic for an unknown
 * value instead — which also stops arbitrary text in a link from being rendered
 * as though the product had said it.
 */
export function renderUserMessage(value: string | null | undefined, locale: Locale | string): string {
  if (value === null || value === undefined || value.trim() === '') return '';
  if (!isUserMessageCode(value)) return value;
  return localizedFrom<string>(ERROR_COPY[value], locale) ?? missingCopyMarker(value);
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
  return renderUserMessage('UNEXPECTED', locale);
}
