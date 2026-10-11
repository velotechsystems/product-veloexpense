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
import type { Severity, RuleKind } from '@/lib/policy/rules';
import type { PostStatus } from '@/lib/integrations/post-outbox';
import type { FraudSeverity } from '@/lib/fraud/rules';
import type { ControlSeverity } from '@/lib/fraud/controls';
import type { FlagStatus } from '@/lib/fraud/review';
import type { ControlRunStatus } from '@/lib/fraud/evaluate';
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

/* ── policy ───────────────────────────────────────────────────────────────── */

export const SEVERITY_COPY: EnumCopy<Severity> = {
  INFO: { 'en-CA': 'For information' },
  WARNING: { 'en-CA': 'Warning' },
  // Not "Block": the word on the screen should say what it does to the person
  // reading it, and what it does is refuse the submission until they fix it.
  BLOCK: { 'en-CA': 'Must be fixed' },
};

/**
 * ── THIS CATALOGUE WAS DEAD UNTIL VX4-10 PART 4, AND THAT IS THE STORY ─────
 *
 * Built in VX4-7 part 2a with full coverage of `RuleKind` and a passing test in
 * `test/i18n-enum-catalog.test.ts`. It had exactly two consumers, and both were
 * that test file. Nothing in `lib/` or `app/` ever asked it anything.
 *
 * Meanwhile `lib/policy/rules.ts` carried a `label` on every `RuleDefinition` —
 * a SECOND list of the same five names — and that is what `/admin/expense-policies`
 * rendered, what `lib/policy/service.ts` put into eight refusal messages, and
 * therefore the only one a person ever read.
 *
 * The two had already drifted on two of five members:
 *
 *   NON_NEGATIVE_AMOUNT   catalogue: "Amount cannot be negative"
 *                            rules.ts: "No negative amounts"   ← what shipped
 *   BUDGET_OVERAGE        catalogue: "Budget overage"
 *                            rules.ts: "Over budget"           ← what shipped
 *
 * UD-9's defect in its purest form, and the fourth time this tree has paid for
 * it. What made it invisible is worth more than the fix: a coverage test can
 * prove a catalogue covers its union and cannot notice that nobody reads the
 * catalogue. `scripts/check-i18n.mjs` now refuses a catalogue here whose only
 * references are its own test.
 *
 * ── WHICH WORDING SURVIVED, AND WHY IT IS THE LIVE ONE ─────────────────────
 *
 * `rules.ts`', on both disagreements. Not because it is better — "Amount cannot
 * be negative" is arguably clearer than "No negative amounts" — but because it is
 * what readers see today, and a ticket about removing a duplicate list is not a
 * ticket about changing copy. Changing both at once would have meant nobody could
 * tell afterwards which change caused a complaint. The wording question is now a
 * one-line edit here, which is the whole point of the catalogue existing.
 */
export const RULE_KIND_COPY: EnumCopy<RuleKind> = {
  PER_TRANSACTION_LIMIT: { 'en-CA': 'Per-transaction limit' },
  RECEIPT_REQUIRED: { 'en-CA': 'Receipt required' },
  CATEGORY_ACTIVE: { 'en-CA': 'Category must be active' },
  NON_NEGATIVE_AMOUNT: { 'en-CA': 'No negative amounts' },
  BUDGET_OVERAGE: { 'en-CA': 'Over budget' },
};

/**
 * What a rule's PARAMETER is called, for the sentence a refusal makes.
 *
 * Keyed `<RuleKind>.<paramName>`, and the compound key is forced rather than
 * chosen: both parameters in the product are named `thresholdMinor` and they are
 * NOT called the same thing — it is "Limit" on a per-transaction cap and "Only
 * above" on a receipt requirement, because those are different questions with the
 * same storage. A catalogue keyed by the parameter name alone would have to pick
 * one and be wrong on the other screen.
 *
 * So this is not an `EnumCopy<T>` — there is no union of `(kind, param)` pairs in
 * the type system. Coverage still comes from the product's own enumeration rather
 * than from a hand-kept list: `RULE_DEFINITIONS` names every pair, so
 * `test/i18n-policy-params.test.ts` walks `RULE_KINDS × definition.params` and
 * refuses a pair with no entry. Same guarantee, arrived at through a loop instead
 * of through a type.
 *
 * WHY IT IS CATALOGUED AT ALL: these appear inside `POLICY_PARAM_REQUIRED` and
 * friends, which are themselves catalogued sentences. `'{rule} needs {field}.'`
 * rendered a French template with `Limit` inside it, because the param was filled
 * with an English literal at the throw site. See `PARAM_CATALOGUES` in
 * `errors.ts` for the half that resolves them.
 */
export const RULE_PARAM_COPY: Record<string, Copy> = {
  'PER_TRANSACTION_LIMIT.thresholdMinor': { 'en-CA': 'Limit' },
  'RECEIPT_REQUIRED.thresholdMinor': { 'en-CA': 'Only above' },
};

/** The key `RULE_PARAM_COPY` uses. One place, so no call site spells it. */
export function ruleParamKey(kind: string, paramName: string): string {
  return `${kind}.${paramName}`;
}

/**
 * What each rule DOES, in a sentence, for the admin choosing whether to enable it.
 *
 * Genuinely un-catalogued before part 4 — unlike the labels above, no catalogue
 * held these at all. They render only on `/admin/expense-policies`, which is why
 * no gate saw them: that screen sat behind a pseudo-locale ceiling of 46 from the
 * day the ratchet was built until the day this ticket lowered it.
 *
 * A separate catalogue from the labels rather than a `{ label, description }`
 * pair per member, because `Copy` is a locale-keyed STRING map and nesting a
 * second level inside it would put an object where `localizedFrom` expects a
 * string — the same mechanical trap VX4-10 part 2 hit with plural forms, where a
 * nested value passes through unpseudoized and the crawl then counts a catalogued
 * string as un-catalogued. Two flat catalogues keyed by the same union cost one
 * extra declaration and keep every value a string.
 *
 * Verbatim from the `description` fields they replace. Wording changes are a
 * separate decision, for the reason given above the labels.
 */
export const RULE_DESCRIPTION_COPY: EnumCopy<RuleKind> = {
  PER_TRANSACTION_LIMIT: {
    'en-CA':
      'Flags any single line item above the limit. Scope it to one category to give, say, meals a tighter cap than airfare.',
  },
  RECEIPT_REQUIRED: {
    'en-CA':
      'Flags an expense with no receipt attached. Set a limit to require receipts only above an amount.',
  },
  CATEGORY_ACTIVE: {
    'en-CA':
      'Flags a line item coded to a category the tenant has retired. Catches reports left in draft across a chart-of-accounts change.',
  },
  NON_NEGATIVE_AMOUNT: {
    'en-CA':
      'Flags a line item below zero. Credits and refunds belong on the original report, not as a negative line.',
  },
  BUDGET_OVERAGE: {
    'en-CA':
      'Flags a report whose spend takes a budget period past its budget, counting what is already approved and what is still awaiting a decision. Warns; it never blocks.',
  },
};

/* ── approvals ────────────────────────────────────────────────────────────── */


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
  // UD-8. Three statuses on this screen now mean something close to "not sent",
  // and the copy has to keep them apart because the operator's next action
  // differs in each: PENDING the system will send on its own, HELD needs a person
  // to say go, CANCELLED somebody already said no. So this one names WHO has to
  // act rather than describing the row's condition — 'held' alone would read as a
  // synonym of 'withheld', which is the status directly below it.
  HELD: { 'en-CA': 'waiting for someone to send it' },
  POSTED: { 'en-CA': 'drafted in the ledger' },
  FAILED: { 'en-CA': 'failed, will retry' },
  DEAD: { 'en-CA': 'out of attempts' },
  CANCELLED: { 'en-CA': 'withheld' },
  NEEDS_REVIEW: { 'en-CA': 'needs review' },
};

/* ── compliance (VX4-8) ───────────────────────────────────────────────────── */

/**
 * THREE SEVERITY VOCABULARIES NOW EXIST and the copy is where the difference
 * becomes visible to a person, so it is worth saying which is which:
 * `policy_severity` (INFO/WARNING/BLOCK) says whether a report may be submitted,
 * `fraud_severity` (LOW/MEDIUM/HIGH) says how much a reviewer should care about a
 * transaction, and `control_severity` (INFO/WARNING/CRITICAL) says whether a
 * control is operating. Migrations 0031 and 0032 argue for keeping them apart;
 * these words are what stop a reader having to know that.
 */
export const FRAUD_SEVERITY_COPY: EnumCopy<FraudSeverity> = {
  // Not "low/medium/high" alone. A severity badge that only ranks tells a reviewer
  // the order to work in and nothing about what the ranking means; these say what
  // the rule actually claims, which is the difference between a queue somebody
  // works and a queue somebody sorts.
  LOW: { 'en-CA': 'worth knowing' },
  MEDIUM: { 'en-CA': 'worth checking' },
  HIGH: { 'en-CA': 'worth opening' },
};

export const FRAUD_FLAG_STATUS_COPY: EnumCopy<FlagStatus> = {
  ACTIVE: { 'en-CA': 'open' },
  // 'dealt with' rather than 'resolved': the flag is not what got fixed, and
  // "resolved" invites reading it as "the concern was unfounded" — which is what
  // DISMISSED means and is a different decision.
  RESOLVED: { 'en-CA': 'dealt with' },
  DISMISSED: { 'en-CA': 'set aside' },
  ESCALATED: { 'en-CA': 'escalated' },
};

export const CONTROL_SEVERITY_COPY: EnumCopy<ControlSeverity> = {
  // These are an AUDITOR's words, not a developer's, because a control
  // evaluation is the one artefact here read by somebody outside the company.
  INFO: { 'en-CA': 'incomplete' },
  WARNING: { 'en-CA': 'drifting' },
  CRITICAL: { 'en-CA': 'would be a finding' },
};

export const CONTROL_RUN_STATUS_COPY: EnumCopy<ControlRunStatus> = {
  RUNNING: { 'en-CA': 'running' },
  COMPLETED: { 'en-CA': 'completed' },
  // NOT 'failed' alone. A failed run is the state migration 0032 exists to make
  // visible — "no findings" and "never finished" must not read alike — so the
  // word says the run did not finish rather than that it found problems.
  FAILED: { 'en-CA': 'did not finish' },
};

export const CAPABILITY_COPY: EnumCopy<Capability> = {
  POST_EXPENSE_REPORT: { 'en-CA': 'Post expense reports' },
  PULL_CHART_OF_ACCOUNTS: { 'en-CA': 'Pull the chart of accounts' },
  READ_PAYMENT_STATUS: { 'en-CA': 'Read payment status' },
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
  RECEIPT_REMINDER: { 'en-CA': 'Someone asked for your missing receipts' },
  COMMENT: { 'en-CA': 'Someone commented on a report' },
  REASSIGNED: { 'en-CA': 'An approval was passed to someone else' },
};

/* ── receipts ─────────────────────────────────────────────────────────────── */


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
/*
 * ── THREE CATALOGUES WERE DELETED HERE BY VX4-10 PART 4 ────────────────────
 *
 * `DECISION_COPY`, `ACCOUNT_SOURCE_COPY` and `RECEIPT_STATUS_COPY`. The
 * dead-catalogue gate added to `scripts/check-i18n.mjs` in part 4 found them on
 * its first run — none was read from anywhere but its own coverage test, exactly
 * like `RULE_KIND_COPY` before it, and none of the three enums is rendered to a
 * reader anywhere in the product today.
 *
 * Deleted rather than exempted, and the reason is the gate's own argument: a
 * catalogue with no call site is where a duplicate hides, and an exemption list
 * would have preserved precisely the condition the gate exists to prevent.
 * `Decision` is the clearest case — APPROVED / REJECTED / RETURNED already
 * overlapped `TRANSITION_ACTION_COPY` and still overlaps `REPORT_STATUS_COPY`, which
 * is live, so a third spelling of those words was a drift waiting to happen.
 *
 * `TransitionAction` (`TRANSITION_ACTION_COPY`) followed in w2-02b: its one reader was the
 * old report page's lifecycle bar, retired for ExpenseOS's workbench, whose history is the
 * report's discussion (`CommentThread`) in the `comments` catalogue's words.
 *
 * If a screen needs any of them, three lines brings it back — and the wording
 * will then be chosen with the screen in front of the author, which is better
 * than inheriting a guess nobody has ever seen rendered.
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
