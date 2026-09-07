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
