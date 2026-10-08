/**
 * VX4-10 part 1 — the UI chrome catalogue.
 *
 * Headings, buttons, column names, empty states, helper sentences. The 161
 * strings `e2e/pseudo-crawl.spec.ts` has been counting since VX4-7 part 3, and
 * the last large surface of this product that is still English literals in JSX.
 *
 * ── WHY THIS IS A DIFFERENT SHAPE FROM THE OTHER FIVE CATALOGUES ────────────
 *
 * The catalogues before it — enums, policy messages, refusals, fraud, controls —
 * are each keyed by something the PRODUCT already enumerates: a status union, a
 * message code emitted by a rule, a `UserMessageCode` thrown by a service. Their
 * coverage guarantee comes free from that: `EnumCopy<ReportStatus>` cannot miss a
 * status, because the union is the key.
 *
 * Chrome has no such enumeration. There is no runtime array of "every heading
 * this product shows", and inventing one would be a second list that drifts from
 * the screens — UD-9's defect, which this project has now paid for three times.
 *
 * So the guarantee here is inverted, and it is worth being honest that it is
 * weaker: `UI_COPY` IS the enumeration. `UiKey` is derived from its keys, so a
 * call site naming a key that does not exist fails to compile; but a heading
 * somebody hardcodes without calling `uiText` at all is invisible to the type
 * system. THAT is what the pseudo-locale crawl's ratchet is for, and it is why
 * this ticket lowers ceilings rather than deleting the gate: the compiler covers
 * the keys, the crawl covers the absences, and neither alone is enough.
 *
 * ── ONE FLAT NAMESPACE, DOTTED, NOT NESTED OBJECTS ─────────────────────────
 *
 * `'preferences.title'` rather than `{ preferences: { title } }`. Three reasons,
 * and the third is the one that decided it:
 *
 *   · A flat `Record<string, Copy>` is what `localizedFrom` already consumes, so
 *     the pseudo-locale applies with no new code path — and part 3's whole point
 *     is that there are exactly two places pseudo is applied.
 *   · `check:i18n` can read the keys with the same shallow parse it uses on the
 *     other five catalogues.
 *   · A nested tree invites `t(`preferences.${something}`)`, and UD-5's third
 *     requirement is that a static used-keys scan cannot see an interpolated
 *     key. A flat union of string literals makes the interpolated form a type
 *     error rather than a thing a guard has to catch after the fact.
 *
 * ── WHAT DOES *NOT* BELONG HERE ────────────────────────────────────────────
 *
 * A tenant's own data. VX5-4's starter categories are the precedent and the
 * argument: from the instant the row is written it is the CUSTOMER'S category,
 * renamed and deleted by them, and cataloguing it would mean a label that changes
 * language under somebody who had renamed it. Same for plan names from the
 * platform, employee names, report titles, merchant names.
 *
 * A sentence that names a NUMBER or a DATE. Those go through
 * `lib/i18n/catalog/message-data.ts`'s renderer shape, which takes typed params —
 * see `policy-messages.ts`. A key here whose copy contains `{something}` is a key
 * in the wrong catalogue, and `test/i18n-ui.test.ts` refuses one.
 */
import { DEFAULT_LOCALE, localizedFrom, type Locale } from '../locales';
import { type Copy, missingCopyMarker } from './enums';

/**
 * Every chrome string this product renders through a catalogue.
 *
 * `as const satisfies Record<string, Copy>` rather than a plain annotation: the
 * `satisfies` keeps the literal key types (so `UiKey` below is the union of the
 * actual keys rather than `string`) while still checking every value is `Copy`.
 * An annotation would widen the keys and lose the whole guarantee.
 *
 * Ordered by screen, and the screen's route is in the comment above each block so
 * a reader who found a string in the browser can find it here.
 */
export const UI_COPY = {
  /* ── /preferences (VX4-7 part 1's screen) ───────────────────────────────── */
  'preferences.title': { 'en-CA': 'Language and time' },
  'preferences.lede': {
    'en-CA':
      'Your own settings. Leave either one on “follow the company” and it will track whatever your organization uses.',
  },
  'preferences.saved': { 'en-CA': 'Saved.' },
  'preferences.save': { 'en-CA': 'Save' },
  'preferences.language.label': { 'en-CA': 'Language and formatting' },
  'preferences.timezone.label': { 'en-CA': 'Time zone' },
  // The em dash is deliberate and the reason is on the page it came from:
  // `localeName` already returns "English (Canada)", so nested parentheses read
  // as a typo rather than as a setting.
  'preferences.follow.company': { 'en-CA': 'Follow the company —' },
  'preferences.sample.date': { 'en-CA': 'You see' },
  'preferences.sample.money': { 'en-CA': 'Amounts' },
  'preferences.notifications.lede': { 'en-CA': 'Looking for which emails you get?' },
  'preferences.notifications.link': { 'en-CA': 'Notification preferences' },

  /* ── /admin/billing (VX5-11, rewritten by VX5-19) ───────────────────────── */
  'billing.title': { 'en-CA': 'Billing' },
  'billing.lede': {
    'en-CA': 'What this organization is on, and what it has been measured at.',
  },
  'billing.none.billed.title': { 'en-CA': 'Nothing is being billed for this organization.' },
  'billing.none.billed.detail': {
    'en-CA':
      'VeloTech has no subscription on record for it, so everything works normally and nothing is being charged.',
  },
  'billing.none.unconfigured.title': { 'en-CA': 'Billing is not configured in this deployment.' },
  'billing.none.unconfigured.detail': {
    'en-CA':
      'VeloExpense is running without a connection to VeloTech billing. Everything works normally and nothing is being charged.',
  },
  'billing.usage.title': { 'en-CA': 'Measured usage' },
  'billing.usage.lede': {
    'en-CA':
      'Counted at the end of each period. Amounts are not shown here — what is charged is calculated by VeloTech, and two copies of the same arithmetic eventually disagree.',
  },
  'billing.usage.empty': {
    'en-CA': 'Nothing measured yet. The first reading is taken at the end of the current period.',
  },
  'billing.column.period': { 'en-CA': 'Period' },
  'billing.column.measure': { 'en-CA': 'Measure' },
  'billing.column.quantity': { 'en-CA': 'Quantity' },
  'billing.column.plan': { 'en-CA': 'Plan' },
  'billing.column.counted': { 'en-CA': 'Counted' },
  'billing.managed.elsewhere': {
    'en-CA':
      'Plans, prices and payment are managed by VeloTech, not in VeloExpense — this page shows what VeloTech holds for this organization. To change a plan or a payment method, get in touch.',
  },
  'billing.back': { 'en-CA': 'Back to settings' },
  'billing.no.payment.method': { 'en-CA': 'No payment method is connected yet.' },

  /* ── the meters, as a reader sees them ──────────────────────────────────── */
  //
  // Not in `enums.ts` with the other unions, deliberately. `Meter` is a BILLING
  // vocabulary the platform also uses; these are the words this screen puts in a
  // table cell, and "People" is not what `SEAT` is called anywhere else. Keeping
  // them here means the screen's wording can change without touching a shared
  // enum other code reads.
  /* ── subscription status, as this SCREEN says it ────────────────────────── */
  //
  // In the chrome catalogue and not in `enums.ts`, and the split is deliberate.
  // `enums.ts` holds what a value is CALLED wherever it appears; these are a label
  // AND a paragraph explaining what still works, which is copy belonging to one
  // screen. `app/admin/billing/page.tsx` keys them through a
  // `Record<SubscriptionStatus, …>`, so a status added to the union is still a
  // compile error here — the coverage guarantee survives the move.
  'billing.status.TRIALING.label': { 'en-CA': 'Trial' },
  'billing.status.TRIALING.detail': {
    'en-CA': 'Everything works. Nothing is being charged yet.',
  },
  'billing.status.ACTIVE.label': { 'en-CA': 'Active' },
  'billing.status.ACTIVE.detail': { 'en-CA': 'Everything works.' },
  'billing.status.PAST_DUE.label': { 'en-CA': 'Payment overdue' },
  // Deliberately calm: this state restricts nothing, and a banner that sounded
  // like it did would have people chasing a problem that is not stopping them.
  'billing.status.PAST_DUE.detail': {
    'en-CA':
      'A payment did not go through and is being retried. Nothing is restricted — reports can still be submitted, approved and paid.',
  },
  'billing.status.LAPSED.label': { 'en-CA': 'Lapsed' },
  'billing.status.LAPSED.detail': {
    'en-CA':
      'Drafts still save and everything is still readable. Reports cannot be submitted, approved or marked paid until this is resolved.',
  },
  'billing.status.CANCELLED.label': { 'en-CA': 'Cancelled' },
  'billing.status.CANCELLED.detail': {
    'en-CA':
      'Drafts still save and everything is still readable. Reports cannot be submitted, approved or marked paid.',
  },
  // NOT a synonym for lapsed. Suspension is a decision somebody made; lapsing is
  // what happens when a trial runs out or dunning gives up. Telling an
  // administrator whose card is fine that they have "lapsed" sends them to fix
  // the wrong problem.
  'billing.status.SUSPENDED.label': { 'en-CA': 'Suspended' },
  'billing.status.SUSPENDED.detail': {
    'en-CA':
      'This organization has been suspended by VeloTech. Drafts still save and everything is still readable. Get in touch to resolve it.',
  },

  /* ── UD-16: page titles ─────────────────────────────────────────────────── */
  //
  // A tab title, a bookmark, a back-history entry, and what a screen reader
  // announces on navigation — one string, four jobs, and until UD-16 every route
  // in the product used the same one.
  //
  // NOT the same keys as the headings, even where the words match. A heading has
  // the page around it; a title stands alone in a strip of twenty tabs, so
  // `Employees` may want to be `People` in one and not the other, and a translator
  // has to be able to make that choice. Two keys with identical `en-CA` today is
  // the cheap half of that; one key would have forbidden it.
  //
  // Composed with the tenant's name by `title.template` in `app/layout.tsx`, so
  // these are the page's half only.
  'title.home': { 'en-CA': 'Home' },
  'title.expenses': { 'en-CA': 'Expense reports' },
  'title.expenses.new': { 'en-CA': 'New expense report' },
  // The fallback when a report cannot be named — see `dataTitle`. A report's own
  // title is the CUSTOMER's words and is never catalogued.
  'title.expenses.report': { 'en-CA': 'Expense report' },
  'title.approvals': { 'en-CA': 'Approvals' },
  'title.approvals.delegations': { 'en-CA': 'Delegations' },
  'title.approve': { 'en-CA': 'Approve a report' },
  'title.notifications': { 'en-CA': 'Notifications' },
  'title.notifications.preferences': { 'en-CA': 'Notification preferences' },
  'title.preferences': { 'en-CA': 'Language and time' },
  'title.login': { 'en-CA': 'Sign in' },
  'title.signup': { 'en-CA': 'Create an organization' },
  'title.signup.verify': { 'en-CA': 'Confirm your email' },
  'title.invite.accept': { 'en-CA': 'Accept your invitation' },
  'title.admin.analytics': { 'en-CA': 'Spend analytics' },
  'title.admin.approval.ladder': { 'en-CA': 'Approval ladder' },
  'title.admin.billing': { 'en-CA': 'Billing' },
  'title.admin.business.units': { 'en-CA': 'Business units' },
  'title.admin.branding': { 'en-CA': 'Branding' },
  'title.admin.budgets': { 'en-CA': 'Budgets' },
  'title.admin.chart.of.accounts': { 'en-CA': 'Chart of accounts' },
  'title.admin.compliance': { 'en-CA': 'Compliance' },
  'title.admin.employees': { 'en-CA': 'Employees' },
  'title.admin.employees.invite': { 'en-CA': 'Invite someone' },
  // Fallback for the employee detail page, which titles itself by the person's
  // name. Same rule as a report title.
  'title.admin.employees.one': { 'en-CA': 'Employee' },
  'title.admin.expense.policies': { 'en-CA': 'Expense policies' },
  'title.admin.integrations': { 'en-CA': 'Accounting integrations' },
  'title.admin.ledger.queue': { 'en-CA': 'Ledger queue' },
  'title.admin.locale': { 'en-CA': 'Language and time' },
  'title.admin.expense.categories': { 'en-CA': 'Expense categories' },
  'title.admin.modules': { 'en-CA': 'Modules' },
  'title.admin.notification.delivery': { 'en-CA': 'Email delivery' },
  'title.admin.notification.templates': { 'en-CA': 'Notification wording' },
  'title.admin.reimbursements': { 'en-CA': 'Reimbursements' },

  /* ── shared navigation, on more than one screen ─────────────────────────── */
  //
  // Named `nav.*` rather than under the screen they happen to sit on, because
  // both of these appear on two screens today and the key is what a translator
  // sees. A `expenses.approvals.link` that also renders on /approvals is a key
  // that lies about where its copy lives.
  'nav.delegations': { 'en-CA': 'Delegations' },

  /* The #147 sidebar's `nav.sidebar.*` keys are gone with it: the ported ExpenseOS
     shell (app/(app)/) reads ExpenseOS's catalogue, `nav.items.*` (packages/i18n). */
  'pager.previous': { 'en-CA': 'Previous' },
  'pager.next': { 'en-CA': 'Next' },

  /* ── /expenses (VX1-6, UD-4) ────────────────────────────────────────────── */
  //
  // Two titles rather than one with the scope appended: UD-4's finding was that a
  // list whose scope is invisible gets read as the whole set, and the fix put the
  // scope in the HEADING. Two whole headings is what lets a translator keep that.
  'expenses.title.own': { 'en-CA': 'Your expense reports' },
  'expenses.title.org': { 'en-CA': 'All expense reports' },
  'expenses.new': { 'en-CA': 'New report' },
  'expenses.filter.search': { 'en-CA': 'Search' },
  // Catalogued although the ratchet cannot see it: `visibleStrings` walks text
  // nodes, and a placeholder is an attribute. A screen-reader user hears it and a
  // sighted user reads it, so "the gate cannot see it" is not a reason to leave
  // it in English — it is a reason to say here that the gate is not what is
  // covering it.
  'expenses.filter.search.placeholder': { 'en-CA': 'Title or EXP number' },
  'expenses.filter.status': { 'en-CA': 'Status' },
  'expenses.filter.status.any': { 'en-CA': 'Any' },
  'expenses.filter.everyone': { 'en-CA': 'Everyone’s reports' },
  'expenses.filter.apply': { 'en-CA': 'Apply' },
  'expenses.empty.start.link': { 'en-CA': 'Start one' },
  'expenses.column.report': { 'en-CA': 'Report' },
  'expenses.column.submitter': { 'en-CA': 'Submitter' },
  'expenses.column.status': { 'en-CA': 'Status' },
  'expenses.column.expenses': { 'en-CA': 'Expenses' },
  'expenses.column.receipts': { 'en-CA': 'Receipts' },
  'expenses.column.created': { 'en-CA': 'Created' },
  'expenses.column.total': { 'en-CA': 'Total' },

  /* ── /notifications (VX2-8, VX4-10 part 3) ──────────────────────────────── */
  //
  // The ROWS on this screen were already catalogued and it is worth knowing why
  // before reading the ceiling below: a notification's body comes from
  // `notification-templates`, and its two sub-labels from `EVENT_TYPE_COPY` and
  // `NOTIFICATION_WORDING_COPY` in `enums.ts`. Part 3 had only the chrome left,
  // which is why this screen's residue is one `Intl` date per row and nothing
  // else.
  'notifications.title': { 'en-CA': 'Notifications' },
  'notifications.none.unread': { 'en-CA': 'Nothing unread' },
  'notifications.mark.all.read': { 'en-CA': 'Mark all read' },
  'notifications.mark.read': { 'en-CA': 'Mark read' },
  'notifications.filter.all': { 'en-CA': 'Everything' },
  'notifications.filter.unread': { 'en-CA': 'Unread only' },
  'notifications.column.what': { 'en-CA': 'What happened' },
  'notifications.column.when': { 'en-CA': 'When' },
  // Two empty states, not one with a clause bolted on. The unread-only view is
  // empty because the reader has caught up; the everything view is empty because
  // nothing has happened yet, and those want different sentences in any language.
  'notifications.empty.unread': { 'en-CA': 'Nothing unread.' },
  'notifications.empty.all': {
    'en-CA': 'Nothing yet. Submitted reports, approvals and returns land here.',
  },
  'notifications.footer': {
    'en-CA':
      'Open a report to act on it — a notification says what happened, the report is where you do something about it.',
  },
  'nav.preferences': { 'en-CA': 'Preferences' },

  /* ── /approvals (VX2-4) ─────────────────────────────────────────────────── */
  'approvals.title': { 'en-CA': 'Approvals' },
  'approvals.none.waiting': { 'en-CA': 'Nothing waiting on you' },
  'approvals.column.report': { 'en-CA': 'Report' },
  'approvals.column.submitted.by': { 'en-CA': 'Submitted by' },
  'approvals.column.total': { 'en-CA': 'Total' },
  'approvals.column.step': { 'en-CA': 'Step' },
  'approvals.column.why': { 'en-CA': 'Why you' },
  'approvals.column.waiting.since': { 'en-CA': 'Waiting since' },
  // The link TEXT of `approvals.footer`, and the same for `expenses.empty.start`.
  // Param-less, so it lives here with the other plain strings; `UI_SENTENCES`
  // holds the sentence with the `{link}` hole and this fills it. Two entries for
  // one sentence is the cost of letting a translator move the link, and it is
  // cheaper than the alternative, which is not letting them.
  'approvals.footer.link': { 'en-CA': 'Arrange cover' },
  // Appended to the count sentence with a space when the reader is an ADMIN. Its
  // own entry so the plural forms stay about the plural and this stays about the
  // role — one clause after another, not a word inserted into a sentence.
  'approvals.count.admin.suffix': {
    'en-CA': '— other people’s approvals are on their reports, not here',
  },
  'approvals.empty': {
    'en-CA': 'Nothing to approve. Reports appear here when somebody submits one that routes to you.',
  },

  /* ── /admin/expense-policies (VX3-2, VX4-10 part 4) ─────────────────────── */
  //
  // The rule NAMES and DESCRIPTIONS are NOT here. They are `RULE_KIND_COPY` and
  // `RULE_DESCRIPTION_COPY` in `enums.ts`, keyed by `RuleKind` — a union the
  // product enumerates, so a new rule kind is a compile error there in a way it
  // could never be here. This catalogue holds the screen's chrome and nothing
  // that a type can guarantee coverage of.
  'policies.title': { 'en-CA': 'Expense policies' },
  // The clause after the rule count. Param-less, so it lives here and
  // `policies.count.rules.*` interpolates it as `{tail}` — split that way so a
  // translator can move it, or drop the interpunct, without touching the plural
  // forms. `UI_SENTENCES` rejected it for exactly the reason it should: no hole.
  'policies.count.tail': {
    'en-CA': 'changes apply on the next save of a report, no deploy',
  },
  'policies.restore.starter': { 'en-CA': 'Restore starter rules' },
  'policies.currency.title': { 'en-CA': 'Threshold currency' },
  'policies.currency.lede': {
    'en-CA':
      'Every amount below is compared in this currency. A report in another currency is converted first, so one limit means the same thing to everybody. A rule can override it — useful if you have entities in more than one country.',
  },
  'policies.currency.aria': { 'en-CA': 'Policy currency' },
  'policies.save': { 'en-CA': 'Save' },
  'policies.delete': { 'en-CA': 'Delete' },
  'policies.no.rates': {
    'en-CA': 'No exchange rates are loaded. Reports in a single currency are unaffected.',
  },
  'policies.column.rule': { 'en-CA': 'Rule' },
  'policies.column.category': { 'en-CA': 'Category' },
  'policies.column.severity': { 'en-CA': 'Severity' },
  'policies.column.threshold': { 'en-CA': 'Threshold' },
  'policies.column.effective': { 'en-CA': 'Effective' },
  'policies.column.on': { 'en-CA': 'On' },
  'policies.empty': {
    'en-CA': 'No policy rules yet. Restore the starter set above, or add one below.',
  },
  'policies.all.categories': { 'en-CA': 'All categories' },
  'policies.whole.report': { 'en-CA': 'Whole report' },
  'policies.category.inactive.suffix': { 'en-CA': ' (inactive)' },
  'policies.add.title': { 'en-CA': 'Add a rule' },
  'policies.add.choose': { 'en-CA': 'Choose…' },
  'policies.field.rule': { 'en-CA': 'Rule' },
  'policies.field.severity': { 'en-CA': 'Severity' },
  'policies.field.threshold': { 'en-CA': 'Threshold' },
  'policies.field.category': { 'en-CA': 'Category' },
  'policies.field.effective.from': { 'en-CA': 'Effective from' },
  'policies.field.effective.to': { 'en-CA': 'Effective to' },
  'policies.field.enabled': { 'en-CA': 'Enabled' },
  'policies.add.submit': { 'en-CA': 'Add rule' },
  'nav.employees': { 'en-CA': 'Employees' },

  /* ── /admin/locale (VX4-7 part 2a's screen) ─────────────────────────────── */
  //
  // The words repeat /preferences deliberately and the KEYS do not. Same copy,
  // different screens: one sets a personal preference, one sets the org default,
  // and a translator who wants "Sprache und Zeit" on one and something else on the
  // other must be able to have it. A shared key would forbid that to save two
  // lines.
  'locale.title': { 'en-CA': 'Language and time' },
  'locale.lede': {
    'en-CA':
      'How dates, times and amounts are written for everyone in this organization. An employee who sets their own preference keeps it; everyone else follows what you choose here.',
  },
  'locale.language.label': { 'en-CA': 'Language and formatting' },
  'locale.timezone.label': { 'en-CA': 'Time zone' },
  'locale.timezone.help': {
    'en-CA':
      'Timestamps recorded by the product — when a report was submitted, approved or paid — are shown in this zone. Dates people type, like the date on an expense, are calendar dates and do not move.',
  },
  'locale.samples.title': { 'en-CA': 'How each option reads' },
  'locale.column.language': { 'en-CA': 'Language' },
  'locale.column.datetime': { 'en-CA': 'Date and time' },
  'locale.column.amounts': { 'en-CA': 'Amounts' },
  'locale.in.use': { 'en-CA': 'in use' },
  'locale.audited': { 'en-CA': 'Changes are recorded in the audit trail.' },
  'locale.save': { 'en-CA': 'Save' },

  'billing.meter.seat': { 'en-CA': 'People' },
  'billing.meter.tenant': { 'en-CA': 'Organization' },
  'billing.meter.card': { 'en-CA': 'Cards' },
} as const satisfies Record<string, Copy>;

/**
 * Every key in the chrome catalogue.
 *
 * Derived from `UI_COPY` rather than declared beside it, so the two cannot
 * disagree. A second hand-maintained list of keys is exactly the shape UD-9
 * caught three times.
 */
export type UiKey = keyof typeof UI_COPY;

/** Every key, at runtime — for the coverage test and for nothing else. */
export const UI_KEYS = Object.keys(UI_COPY) as UiKey[];

/**
 * One chrome string, for a reader.
 *
 * `UiKey` rather than `string`, which is the whole safety of this module: a typo
 * or a removed key is a compile error at the call site, not a
 * `⟦missing:…⟧` somebody notices in production. The marker fallback below is
 * therefore unreachable through the type system and exists only for a value that
 * arrived from outside it — which `test/i18n-ui.test.ts` proves by casting.
 *
 * Goes through `localizedFrom`, so the pseudo-locale brackets it with no new code
 * path. That is what makes a catalogued heading visible to the crawl's ratchet
 * and an uncatalogued one countable.
 */
export function uiText(key: UiKey, locale: Locale | string = DEFAULT_LOCALE): string {
  const entry = UI_COPY[key] as Copy | undefined;
  if (entry === undefined) return missingCopyMarker(key);
  return localizedFrom<string>(entry, locale) ?? missingCopyMarker(key);
}

/**
 * ── PARAMETERISED CHROME: SENTENCES, NOT HEADINGS ──────────────────────────
 *
 * `UI_COPY` above forbids a `{parameter}` and `test/i18n-ui.test.ts` enforces it.
 * That rule is right and this map is why it can afford to be: a sentence naming a
 * count, a date or a person is a different kind of thing from a column header,
 * and mixing them would have meant loosening the rule that makes the flat map
 * safe.
 *
 * WHY THIS IS NOT `message-data.ts`. That machinery renders a row's `data` jsonb
 * for policy, fraud and control messages: it is keyed by a message CODE, its
 * accessors refuse a key missing from the row, and its whole job is turning
 * stored evidence into a sentence. Nothing here comes from a row. `Page 3 of 7`
 * is chrome that happens to contain numbers, and routing it through a jsonb
 * accessor would have been a second, wronger use of a good abstraction.
 *
 * ── ONE ENTRY PER PLURAL FORM, AS A FLAT KEY ───────────────────────────────
 *
 * `expenses.count.own.one` and `expenses.count.own.other`, not one entry holding
 * `{ one, other }`. The reason is mechanical and worth knowing before somebody
 * tidies it: `localizedFrom` applies the pseudo-locale ONLY to string values —
 * line 220, `if (typeof value === 'string') return pseudoIfEnabled(value)`. A
 * nested object would pass through untouched, the sentence would render
 * unbracketed, and the crawl would count a catalogued string as un-catalogued.
 * Worse, it would do so quietly. Keeping every value a string keeps the number of
 * places the pseudo-locale is applied at exactly two, which VX4-7 part 3 argued
 * for at length.
 *
 * English has two forms; `Intl.PluralRules` is asked for the category rather than
 * `n === 1 ? … : …` being written inline, so a locale with three or six forms
 * needs new ENTRIES and no new code.
 */
export const UI_SENTENCES = {
  /* ── /expenses ──────────────────────────────────────────────────────────── */
  'expenses.count.own.one': { 'en-CA': '{n} report submitted by you' },
  'expenses.count.own.other': { 'en-CA': '{n} reports submitted by you' },
  'expenses.count.org.one': { 'en-CA': '{n} report across your organization' },
  'expenses.count.org.other': { 'en-CA': '{n} reports across your organization' },
  'expenses.page.of': { 'en-CA': 'Page {page} of {pages}' },
  // The empty state is a sentence with a link INSIDE it, which is why it is here
  // and not in `UI_COPY` as two fragments. A translator who cannot move the link
  // cannot write a correct German sentence, and two fragments is exactly the
  // shape that forbids it.
  'expenses.empty.start': { 'en-CA': 'No reports yet. {link}.' },

  /* ── /approvals ─────────────────────────────────────────────────────────── */
  'approvals.count.waiting.one': { 'en-CA': '{n} waiting on you' },
  'approvals.count.waiting.other': { 'en-CA': '{n} waiting on you' },
  'approvals.step.of': { 'en-CA': '{step} of {steps}' },
  'approvals.covering.for': { 'en-CA': 'for {name}' },
  'approvals.escalated.one': { 'en-CA': 'routed {n} step from the rung' },
  'approvals.escalated.other': { 'en-CA': 'routed {n} steps from the rung' },
  'approvals.footer': {
    'en-CA':
      'Open a report to approve, return or reject it — the decision lives with the thing you are deciding on. Going away? {link} — you keep your queue, your stand-in gains the ability to decide.',
  },

  /* ── /admin/expense-policies ────────────────────────────────────────────── */
  'policies.count.rules.one': { 'en-CA': '{n} rule · {tail}' },
  'policies.count.rules.other': { 'en-CA': '{n} rules · {tail}' },
  // Both halves of the unconvertible-currency warning. `{currencies}` and
  // `{scopeable}` arrive already joined by `lib/i18n/list.ts`, so the connecting
  // word is `Intl`'s and not this catalogue's.
  'policies.unconvertible.title': {
    'en-CA': 'Amount limits cannot be enforced on {currencies} reports.',
  },
  'policies.unconvertible.one.detail': {
    'en-CA':
      'There is no exchange rate between that currency and {code}, so those reports get an informational note instead of a limit check. Rules that do not involve an amount are unaffected.',
  },
  'policies.unconvertible.many.detail': {
    'en-CA':
      'There is no exchange rate between those currencies and {code}, so those reports get an informational note instead of a limit check. Rules that do not involve an amount are unaffected.',
  },
  'policies.rates.available': {
    'en-CA': 'Rates available: {pairs} (the reverse of each is derived).',
  },
  'policies.scopeable.only': {
    'en-CA': 'Only {rules} can be scoped to one category.',
  },
  'policies.threshold.currency.aria': { 'en-CA': 'Currency for the {rule} threshold' },

  /* ── /notifications ─────────────────────────────────────────────────────── */
  'notifications.count.unread.one': { 'en-CA': '{n} unread' },
  'notifications.count.unread.other': { 'en-CA': '{n} unread' },

  /* ── /admin/billing — the branch part 1's ceiling of 0 never saw ─────────── */
  'billing.trial.ends': { 'en-CA': 'Trial ends {date}.' },
  'billing.mirrored.at': { 'en-CA': 'Last confirmed with VeloTech {date}.' },

  /* ── /admin/locale ──────────────────────────────────────────────────────── */
  'locale.sample.shown.in': { 'en-CA': '4 March 2026, 02:30 UTC, shown in {zone}' },
} as const satisfies Record<string, Copy>;

export type UiSentenceKey = keyof typeof UI_SENTENCES;
export const UI_SENTENCE_KEYS = Object.keys(UI_SENTENCES) as UiSentenceKey[];

/** Everything a sentence can be given. Strings only — the caller formats. */
export type UiParams = Record<string, string>;

const PLACEHOLDER = /\{([a-zA-Z_]\w*)\}/g;

/**
 * Thrown when a sentence names a parameter the caller did not supply.
 *
 * REFUSES rather than rendering `{n}` or `undefined` at a reader, for the reason
 * `message-data.ts` gives about its own accessors: "undefined is $700.00, over
 * the undefined limit" is a sentence, renders fine, and tells a reader nothing
 * while looking like it worked. A missing parameter is a programming error and
 * should read as one.
 */
export class UiSentenceError extends Error {
  constructor(
    readonly key: string,
    readonly param: string,
  ) {
    super(`ui sentence ${key} needs {${param}}, which was not supplied`);
    this.name = 'UiSentenceError';
  }
}

function fill(key: string, template: string, params: UiParams): string {
  return template.replace(PLACEHOLDER, (_match, name: string) => {
    const value = params[name];
    if (value === undefined) throw new UiSentenceError(key, name);
    return value;
  });
}

function template(key: UiSentenceKey, locale: Locale | string): string {
  const entry = UI_SENTENCES[key] as Copy | undefined;
  if (entry === undefined) return missingCopyMarker(key);
  return localizedFrom<string>(entry, locale) ?? missingCopyMarker(key);
}

/** One parameterised sentence, filled. */
export function uiSentence(
  key: UiSentenceKey,
  params: UiParams = {},
  locale: Locale | string = DEFAULT_LOCALE,
): string {
  return fill(key, template(key, locale), params);
}

/**
 * The plural form of `base` for `n`, filled — `base` plus `.one`, `.other`, and
 * whatever else a locale's rules ask for.
 *
 * Falls back to `.other` when the category a locale asks for has no entry, which
 * is the only fallback that is always *a* sentence rather than a marker. That is a
 * real limitation and not a hidden one: `test/i18n-ui.test.ts` asserts every
 * shipped locale's categories are present for every base, so the fallback is
 * unreachable for the locales this product actually ships.
 */
export function uiPlural(
  base: string,
  n: number,
  params: UiParams = {},
  locale: Locale | string = DEFAULT_LOCALE,
): string {
  let category = 'other';
  try {
    category = new Intl.PluralRules(String(locale)).select(n);
  } catch {
    // An unparseable tag is not worth throwing over in a render path; `other` is
    // correct English for everything except one, and the locale registry is
    // already gated by `check:i18n`.
  }
  const exact = `${base}.${category}` as UiSentenceKey;
  const key = exact in UI_SENTENCES ? exact : (`${base}.other` as UiSentenceKey);
  return uiSentence(key, { n: String(n), ...params }, locale);
}

/**
 * A sentence with exactly one `{link}` in it, split into the text before and the
 * text after — so JSX can put a real `<Link>` between them and the TRANSLATOR
 * decides where in the sentence it goes.
 *
 * The alternative, two catalogue entries called `…before` and `…after`, is what
 * this exists to avoid: it freezes English clause order into the catalogue and
 * there is no way for a translator to say "in my language the link comes first".
 *
 * THROWS when the sentence has no `{link}`, rather than returning the whole thing
 * and an empty string. A silent one-sided split renders a sentence with the link
 * stuck on the end, which looks deliberate.
 */
export function uiAround(
  key: UiSentenceKey,
  params: UiParams = {},
  locale: Locale | string = DEFAULT_LOCALE,
): [string, string] {
  const raw = template(key, locale);
  const at = raw.indexOf('{link}');
  if (at === -1) throw new UiSentenceError(key, 'link');
  return [
    fill(key, raw.slice(0, at), params),
    fill(key, raw.slice(at + '{link}'.length), params),
  ];
}
