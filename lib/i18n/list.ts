/**
 * VX4-10 part 4 — joining a list of things into a phrase, in the reader's language.
 *
 * ── WHAT WAS THERE ─────────────────────────────────────────────────────────
 *
 * `app/admin/expense-policies/page.tsx` had three joins:
 *
 *   .join(' and ')   → "Per-transaction limit and Receipt required"
 *   .join(', ')      → "USD, EUR"          (two sites)
 *
 * The first hardcodes an English conjunction into a sentence a translator is
 * otherwise free to write, which is the same defect as the `n === 1 ? 'report' :
 * 'reports'` ternary part 2 replaced — one layer further out, and less obvious,
 * because `' and '` looks like punctuation rather than copy.
 *
 * The comma joins are more portable and still not right. `Intl.ListFormat` gives
 * Chinese `、` rather than `, `, and for a conjunction gives Arabic the correct
 * order and Spanish the `e`/`y` distinction — none of which a `join` can know.
 *
 * ── WHY A HELPER AND NOT `Intl.ListFormat` AT THE CALL SITE ────────────────
 *
 * Two reasons, and the second is the one that matters.
 *
 * `Intl.ListFormat` throws on an unrecognised locale tag, and this product feeds
 * render paths a `Locale | string` that has been through `readerPrefs`. One
 * `try`/`catch` here beats one at every call site, and the fallback is a comma
 * join — which is what the code did before, so a bad tag degrades to today's
 * behaviour rather than to a crash.
 *
 * ── WHAT PROTECTS THIS, AND WHAT DOES NOT ─────────────────────────────────
 *
 * An earlier draft of this comment claimed the pseudo-locale crawl would catch a
 * hardcoded conjunction: that `⟦A⟧ and ⟦B⟧` leaves ` and ` outside any brackets,
 * so the ratchet counts it. **That was measured and it is FALSE.** Reverting
 * `joinAnd` to `.join(' and ')` on `/admin/expense-policies` leaves that page at
 * 0 un-catalogued.
 *
 * The reason is `unbracketed()`: it filters whole TEXT NODES that contain a
 * marker anywhere. The join happens inside `uiSentence`'s `{rules}` hole, so the
 * rendered node is `⟦Only ⟦A⟧ and ⟦B⟧ can be scoped…⟧` — one node, marker
 * present, filtered. Every hardcoded word inside a catalogued sentence is
 * invisible to the crawl for the same reason.
 *
 * So this file is NOT crawl-protected. What protects it is
 * `test/i18n-list.test.ts` on the helper, and — added in part 4 because the
 * sabotage above came back green — `scripts/check-i18n.mjs`'s refusal of a
 * literal `.join(' and ')`-style connector anywhere under `lib/` or `app/`. A
 * static gate is the right shape here precisely because the rendered output
 * cannot be asked.
 *
 * NOT a third pseudo site: this file applies no transform. Its INPUTS arrive
 * already pseudoized when they came from a catalogue (`localizedFrom` did it) and
 * plain when they are data — currency codes are data, and `USD` should not be
 * bracketed.
 */
import { DEFAULT_LOCALE, type Locale } from './locales';

/**
 * "A, B and C" — for a list where every item applies.
 *
 * `type: 'conjunction'`, `style: 'long'`. The alternative, `'short'`, gives
 * "A, B, & C" in English, which reads as a citation rather than a sentence.
 */
export function joinAnd(items: readonly string[], locale: Locale | string = DEFAULT_LOCALE): string {
  return format(items, locale, 'conjunction');
}

/**
 * "A, B or C" — for a list where one of them applies.
 *
 * Unused at the moment and here anyway, because the alternative is somebody
 * needing it and reaching for `.join(' or ')`, which is the defect this file
 * exists to remove. `test/i18n-list.test.ts` covers it so it cannot rot.
 */
export function joinOr(items: readonly string[], locale: Locale | string = DEFAULT_LOCALE): string {
  return format(items, locale, 'disjunction');
}

/**
 * ── THERE IS NO `joinList`, AND THE MEASUREMENT IS WHY ─────────────────────
 *
 * This file first had a third function for "a bare enumeration with no connecting
 * word" — currency codes, locale tags — built on `Intl.ListFormat`'s
 * `type: 'unit'`. That was wrong, and it took running it to find out:
 *
 *   type      style     en-CA               ja-JP            zh-CN
 *   unit      long      "USD, EUR, GBP"     "USD EUR GBP"    "USDEURGBP"
 *   unit      short     "USD, EUR, GBP"     "USD EUR GBP"    "USDEURGBP"
 *   unit      narrow    "USD EUR GBP"       "USDEURGBP"      "USDEURGBP"
 *
 * `unit` is CLDR's MEASUREMENT joiner — the thing that makes "3 ft 7 in" — not a
 * comma-separated list, and in Chinese it inserts nothing at all. No style of it
 * separates opaque tokens visibly in every language, so there is no
 * `Intl.ListFormat` mode that means what a bare `join(', ')` was trying to mean.
 * `unit/long` in `es-ES` even inserts "y", so it is not consistently a separator
 * either.
 *
 * So the data lists use `joinAnd` as well:
 *
 *   en-CA  "USD, EUR and GBP"        ja-JP  "USD、EUR、GBP"
 *   zh-CN  "USD、EUR和GBP"            ar-EG  "USD وEUR وGBP"
 *
 * "Rates available: USD and GBP" reads correctly, and every language gets a
 * visible separator between every item, which the alternative could not promise.
 * One function fewer, and no call site has to choose between two joins where
 * choosing wrong is silent.
 */

function format(
  items: readonly string[],
  locale: Locale | string,
  type: 'conjunction' | 'disjunction',
): string {
  // An empty list is the caller's problem to describe, not this function's: "" is
  // the only answer that cannot invent a word. Every call site in the product
  // already branches on emptiness, because "Rates available: ." is not a sentence
  // anybody wants either way.
  if (items.length === 0) return '';
  if (items.length === 1) return items[0];
  try {
    return new Intl.ListFormat(String(locale), { style: 'long', type }).format(items);
  } catch {
    // An unparseable tag. Degrades to what the code did before this file existed,
    // which is wrong in the same way for every locale rather than broken for one.
    return items.join(', ');
  }
}
