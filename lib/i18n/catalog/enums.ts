/**
 * VX4-7 part 2a — what an enum value is CALLED, for a reader.
 *
 * PURE, and it takes some care to stay that way: every union below is imported
 * with `import type`, never as a value. `REPORT_STATUSES` lives in
 * `lib/expenses/service.ts`, which imports `pg`; pulling the array in at runtime
 * would drag a connection pool into every page that wants the word "Submitted".
 * The TYPES give this file its compile-time guarantee, and
 * `test/i18n-enum-catalog.test.ts` imports the runtime arrays to close the loop.
 *
 * ── UD-5 REQUIREMENT 1: THE ENUM IS THE SOURCE OF TRUTH ─────────────────────
 *
 * Each catalogue below is `EnumCopy<TheUnion>` = `Record<TheUnion, Copy>`, so a
 * member added to the union and forgotten here is a COMPILE ERROR, not a runtime
 * miss. That is the strongest form the requirement can take: not a generated
 * assertion that runs, but a shape that cannot be written wrong.
 *
 * What the type CANNOT check is the other direction — whether each entry has
 * copy in every locale we ship — because `Copy` allows any subset beyond the
 * default. That half is the generated assertion, and it enumerates the RUNTIME
 * arrays rather than the keys of these objects. The difference matters and is
 * requirement 2 restated: asking "does the catalogue cover its own keys" is
 * asking the catalogue about itself, and it passes when the catalogue is wrong
 * in a self-consistent way.
 *
 * ── WHY `en-CA` IS REQUIRED AND THE REST ARE NOT ────────────────────────────
 *
 * `Copy` demands `'en-CA'` and permits the others. That mirrors the fallback
 * chain exactly: `en-CA` is where copy is authored and has nowhere to fall back
 * to, so a missing one is missing everywhere and the compiler should say so.
 * `en-US` inherits it, and its override list being nearly empty is the mechanism
 * working rather than a gap — the two dialects genuinely agree about the word
 * "Approved". Where they would differ (cheque/check, GST vs sales tax) there is
 * a place for it to live, which is the whole reason the chain is a chain.
 *
 * ── WHAT THIS REPLACED ──────────────────────────────────────────────────────
 *
 * Four hand-rolled label maps that disagreed about their own shape — one had
 * copy with a raw fallback (`STATUS_TEXT[s] ?? s`), one had only colours, one
 * lowercased the enum as a substitute for copy (`row.status.toLowerCase()`) —
 * and eight sites that rendered the SCREAMING_SNAKE value straight into the
 * page. "This report is REIMBURSED and can no longer be edited" was on a screen
 * an employee reads.
 */
import type { EmployeeRole, EmployeeStatus } from '@/lib/employees/service';
import type { ReportStatus } from '@/lib/expenses/service';
import type { TransitionAction } from '@/lib/expenses/lifecycle';
import type { Severity, RuleKind } from '@/lib/policy/rules';
import type { PostStatus } from '@/lib/integrations/post-outbox';
import type { Capability } from '@/lib/integrations/contract';
import type { DeliveryStatus } from '@/lib/notifications/outbox';
import type { Channel, EventType } from '@/lib/notifications/catalog';
import type { InboxRoute } from '@/lib/approvals/inbox';
import type { DelegationScope } from '@/lib/approvals/tiers';
import type { Decision } from '@/lib/approvals/engine';
import type { AccountSource } from '@/lib/accounts/service';
import type { ReceiptStatus } from '@/lib/receipts/service';
import { DEFAULT_LOCALE, localizedFrom, type Locale } from '../locales';

/**
 * One value's copy. The default locale is REQUIRED; every other locale is an
 * override. See the header on why the asymmetry is the fallback chain in type
 * form rather than a convenience.
 */
export type Copy = { [DEFAULT_LOCALE]: string } & Partial<Record<Locale, string>>;

/** Every member of `T` must have copy. A missing one will not compile. */
export type EnumCopy<T extends string> = Record<T, Copy>;

/* ── expense reports ──────────────────────────────────────────────────────── */

export const REPORT_STATUS_COPY: EnumCopy<ReportStatus> = {
  DRAFT: { 'en-CA': 'Draft' },
  SUBMITTED: { 'en-CA': 'Submitted' },
  APPROVED: { 'en-CA': 'Approved' },
  REJECTED: { 'en-CA': 'Rejected' },
  RETURNED: { 'en-CA': 'Returned for changes' },
  REIMBURSED: { 'en-CA': 'Reimbursed' },
};

export const TRANSITION_ACTION_COPY: EnumCopy<TransitionAction> = {
  SUBMIT: { 'en-CA': 'Submitted' },
  RECALL: { 'en-CA': 'Withdrawn' },
  APPROVE: { 'en-CA': 'Approved' },
  REJECT: { 'en-CA': 'Rejected' },
  RETURN: { 'en-CA': 'Returned' },
  REIMBURSE: { 'en-CA': 'Reimbursed' },
};

/* ── policy ───────────────────────────────────────────────────────────────── */

export const SEVERITY_COPY: EnumCopy<Severity> = {
  INFO: { 'en-CA': 'For information' },
  WARNING: { 'en-CA': 'Warning' },
  // Not "Block": the word on the screen should say what it does to the person
  // reading it, and what it does is refuse the submission until they fix it.
  BLOCK: { 'en-CA': 'Must be fixed' },
};

export const RULE_KIND_COPY: EnumCopy<RuleKind> = {
  PER_TRANSACTION_LIMIT: { 'en-CA': 'Per-transaction limit' },
  RECEIPT_REQUIRED: { 'en-CA': 'Receipt required' },
  CATEGORY_ACTIVE: { 'en-CA': 'Category must be active' },
  NON_NEGATIVE_AMOUNT: { 'en-CA': 'Amount cannot be negative' },
  BUDGET_OVERAGE: { 'en-CA': 'Budget overage' },
};

/* ── approvals ────────────────────────────────────────────────────────────── */

export const DECISION_COPY: EnumCopy<Decision> = {
  APPROVED: { 'en-CA': 'Approved' },
  REJECTED: { 'en-CA': 'Rejected' },
  RETURNED: { 'en-CA': 'Returned for changes' },
};

export const DELEGATION_SCOPE_COPY: EnumCopy<DelegationScope> = {
  // Replaces `row.scope === 'ALL' ? 'Everything' : 'Expense reports'` — an
  // inline ternary doing a catalogue's job, which works for two members and
  // silently renders the wrong branch for a third.
  ALL: { 'en-CA': 'Everything' },
  REPORTS: { 'en-CA': 'Expense reports' },
};

export const INBOX_ROUTE_COPY: EnumCopy<InboxRoute> = {
  // Verbatim from `ROUTE_LABEL`. `DELEGATED` is 'Covering', not the more literal
  // 'Delegated to you' this catalogue first invented: you are covering for
  // somebody, which is what an approver would say about it.
  ASSIGNED: { 'en-CA': 'Assigned to you' },
  DELEGATED: { 'en-CA': 'Covering' },
  ROLE_POOL: { 'en-CA': 'Your role' },
};

/* ── people ───────────────────────────────────────────────────────────────── */

export const EMPLOYEE_ROLE_COPY: EnumCopy<EmployeeRole> = {
  EMPLOYEE: { 'en-CA': 'Employee' },
  MANAGER: { 'en-CA': 'Manager' },
  ADMIN: { 'en-CA': 'Administrator' },
};

export const EMPLOYEE_STATUS_COPY: EnumCopy<EmployeeStatus> = {
  ACTIVE: { 'en-CA': 'Active' },
  ON_LEAVE: { 'en-CA': 'On leave' },
  DEACTIVATED: { 'en-CA': 'Deactivated' },
};

/* ── the ledger queue ─────────────────────────────────────────────────────── */

export const POST_STATUS_COPY: EnumCopy<PostStatus> = {
  // VERBATIM from the `STATUS_TEXT` map this replaces, lowercase and all —
  // that map's wording was written for an operator reading a queue, and the
  // first draft of this catalogue replaced it with tidier-looking words before
  // checking what it actually said. An e2e caught the difference.
  //
  // `POSTED` is the one that mattered: 'drafted in the ledger' rather than
  // 'Posted', because VX3-4 creates a DRAFT bill at the far end. "Posted" would
  // have claimed a journal entry exists, to the person whose job is knowing
  // whether one does. Tidying copy is not a rename, and this was nearly a
  // regression dressed as an improvement.
  //
  // Lowercase is kept for the same reason: these render inline in a sentence on
  // that screen. Recasing them is a cosmetic decision, and not one to smuggle
  // into a localisation change.
  PENDING: { 'en-CA': 'waiting' },
  POSTED: { 'en-CA': 'drafted in the ledger' },
  FAILED: { 'en-CA': 'failed, will retry' },
  DEAD: { 'en-CA': 'out of attempts' },
  CANCELLED: { 'en-CA': 'withheld' },
  NEEDS_REVIEW: { 'en-CA': 'needs review' },
};

export const CAPABILITY_COPY: EnumCopy<Capability> = {
  POST_EXPENSE_REPORT: { 'en-CA': 'Post expense reports' },
  PULL_CHART_OF_ACCOUNTS: { 'en-CA': 'Pull the chart of accounts' },
  READ_PAYMENT_STATUS: { 'en-CA': 'Read payment status' },
};

export const ACCOUNT_SOURCE_COPY: EnumCopy<AccountSource> = {
  TEMPLATE: { 'en-CA': 'From a template' },
  IMPORT: { 'en-CA': 'Imported' },
  MANUAL: { 'en-CA': 'Added by hand' },
  PULLED: { 'en-CA': 'Pulled from the ledger' },
};

/* ── notifications ────────────────────────────────────────────────────────── */

export const DELIVERY_STATUS_COPY: EnumCopy<DeliveryStatus> = {
  // THE ONE CATALOGUE HERE THAT IS AN IMPROVEMENT RATHER THAN A PORT, said
  // plainly because the other five are ports and the difference should not have
  // to be inferred.
  //
  // What this replaces is `row.status === 'CANCELLED' ? 'nothing to send' :
  // row.status.toLowerCase()` — string surgery standing in for copy. It gave
  // 'pending', 'sent', 'failed', 'dead' — and 'dead' is the schema's word for a
  // delivery that ran out of attempts, shown to an admin as though it meant
  // something to them. Only the CANCELLED branch had been written by anybody.
  //
  // Lowercase is kept, because these render inline in a sentence exactly as the
  // ledger queue's do.
  PENDING: { 'en-CA': 'queued' },
  SENT: { 'en-CA': 'sent' },
  FAILED: { 'en-CA': 'failed, will retry' },
  DEAD: { 'en-CA': 'out of attempts' },
  CANCELLED: { 'en-CA': 'nothing to send' },
};

export const CHANNEL_COPY: EnumCopy<Channel> = {
  // Verbatim from `CHANNEL_LABEL`: 'In-app', not 'In the app'.
  IN_APP: { 'en-CA': 'In-app' },
  EMAIL: { 'en-CA': 'Email' },
  SLACK: { 'en-CA': 'Slack' },
};

export const EVENT_TYPE_COPY: EnumCopy<EventType> = {
  TASK_ASSIGNED: { 'en-CA': 'A report needs your approval' },
  APPROVED: { 'en-CA': 'Your report was approved' },
  REJECTED: { 'en-CA': 'Your report was rejected' },
  RETURNED: { 'en-CA': 'Your report was returned' },
  RECALLED: { 'en-CA': 'A report was withdrawn' },
  REIMBURSED: { 'en-CA': 'You were reimbursed' },
  BUDGET_THRESHOLD: { 'en-CA': 'A budget crossed a threshold' },
};

/* ── receipts ─────────────────────────────────────────────────────────────── */

export const RECEIPT_STATUS_COPY: EnumCopy<ReceiptStatus> = {
  PENDING: { 'en-CA': 'Uploading' },
  STORED: { 'en-CA': 'Attached' },
};

/* ── the render boundary ──────────────────────────────────────────────────── */

/**
 * What a missing string renders as.
 *
 * Braces and the raw value, deliberately: `{DRAFT}` on a screen is unmistakably
 * a missing-copy bug and names the thing that is missing, where a blank reads as
 * a product fault and hides the cause. It is the rule
 * `lib/notifications/catalog.ts` already states for placeholders — "`{amont}` in
 * the output is a visible typo somebody fixes, whereas an empty gap reads as a
 * product bug" — applied to the other kind of missing text.
 *
 * In a locale we actually ship this is unreachable, because the generated
 * assertion fails the build first. It exists for the window between adding a
 * locale to the registry and finishing its copy, and for a stored value from an
 * enum member that no longer exists.
 */
/**
 * Which wording a notification was sent with — the tenant's template, or ours.
 *
 * VX4-7 part 3. Not a database enum, which is why it had no catalogue: it is a
 * boolean on the row (`fromTemplate`) rendered as ` · your wording` /
 * ` · shipped wording`, inline in the JSX. Catalogued now for two reasons — it
 * is copy an employee reads on every notification, and being PER ROW it made
 * `/notifications`' un-catalogued count scale with how many notifications
 * exist, so the pseudo crawl's ceiling for that page could not be a stable
 * number. Cataloguing it fixes the page and the measurement at once.
 */
export type NotificationWording = 'TEMPLATE' | 'SHIPPED';

export const NOTIFICATION_WORDING_COPY: EnumCopy<NotificationWording> = {
  TEMPLATE: { 'en-CA': 'your wording' },
  SHIPPED: { 'en-CA': 'shipped wording' },
};

export function missingCopyMarker(value: string): string {
  return `{${value}}`;
}

/**
 * Read one member's copy for a reader, walking the fallback chain.
 *
 * THE ONE PLACE an enum turns into words. Every screen goes through here, which
 * is what makes the coverage assertion meaningful — a page that formatted its
 * own label would be outside the guarantee, and four of them used to be.
 */
export function enumLabel(
  // Deliberately NOT generic over the union. A generic would infer `T` from the
  // VALUE argument and then demand the catalogue prove it covers exactly that
  // one member — friction with no safety behind it, because the coverage
  // guarantee lives at each catalogue's DECLARATION (`EnumCopy<TheUnion>`) and
  // the value itself arrives from the database as a plain string.
  catalogue: Record<string, Copy>,
  value: string | null | undefined,
  locale: Locale | string,
): string {
  if (value === null || value === undefined || value === '') return '';
  const entry = catalogue[value] as Copy | undefined;
  if (entry === undefined) return missingCopyMarker(value);
  return localizedFrom<string>(entry, locale) ?? missingCopyMarker(value);
}
