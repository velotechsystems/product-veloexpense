/**
 * VX4-7 part 2b — what a policy violation SAYS, rendered for the reader.
 *
 * ── THE DEFECT THIS CLOSES ──────────────────────────────────────────────────
 *
 * `policy_violation.message` is English text frozen at validation time. Whoever
 * saved the report picked the words, the currency format and the date format
 * that every later reader sees — an approver, an auditor, the submitter coming
 * back a month later. IL-11 names the general case (157 English server messages
 * rendered verbatim); this is the half of it a normal employee reads most.
 *
 * It is also frozen in a second, less obvious way. `$1,000.00` was formatted
 * once, in whatever locale the validating request happened to resolve to. Part
 * 1b spent a whole PR establishing that a stored value must not carry a
 * presentation decision, and a baked sentence is that mistake with more words.
 *
 * ── THE SHAPE, AND WHY `rule_code` WAS NOT ENOUGH ───────────────────────────
 *
 * The obvious design is to render from `rule_code` + `data`, and it does not
 * work: five rule kinds emit TEN distinct sentences. A limit finding reads
 * differently when the amount had to be converted; `RECEIPT_REQUIRED` has three
 * shapes depending on whether the rule has a floor and whether conversion was
 * needed; `BUDGET_OVERAGE` emits an overage and a separate FX-floor note.
 * Choosing among them at render time would mean re-deriving, from `data`, the
 * branch the rule already took — which is the same decision made twice, in two
 * places, from different information. So the row carries a MESSAGE code beside
 * its rule code, and the branch is recorded rather than reconstructed.
 *
 * ── WHY THESE ARE FUNCTIONS AND THE ENUM CATALOGUE IS STRINGS ───────────────
 *
 * Part 2a's `EnumCopy` maps a member to a word. These sentences interpolate
 * money, dates and lists, and three of them choose between clauses. Expressing
 * that as a template string needs conditionals, which means inventing a template
 * language and then a parser and then a gate for the parser. A function per
 * locale is the smaller thing: the compiler checks its arity, `PolicyCopy`
 * demands the default locale exactly as `Copy` does, and the fallback chain
 * works unchanged because it walks a map either way.
 *
 * The cost is that a function can silently return English while claiming to be
 * French. That is what `test/i18n-policy-messages.test.ts` is for, and it is the
 * same trade the enum catalogue makes with `Partial<Record<Locale, …>>`.
 *
 * ── UD-5 REQUIREMENT 3: THE KEY A STATIC SCAN CANNOT SEE ────────────────────
 *
 * `scripts/check-i18n.mjs` can see `enumLabel(REPORT_STATUS_COPY, …)` because
 * the catalogue is named in the source. It cannot see whether `data.thresholdMinor`
 * will be THERE at render time, because `data` is a jsonb column written months
 * ago by a rule that has since been edited. Upstream's answer is a nightly
 * crawler pinned to one locale (IL-5/IL-6) — a gate that watches one of three
 * things, which is the shape of gate this project keeps finding.
 *
 * Ours is a declared `requires` list per code, enforced at three depths:
 *   1. RENDER — `fields()` refuses a missing key rather than printing
 *      `undefined`, and `renderPolicyMessage` turns that into a marker instead
 *      of throwing. A page must never blank over copy; IL-4 is exactly that.
 *   2. TEST — `test/i18n-policy-messages.test.ts` runs the REAL rules over
 *      fixtures, takes the `data` they actually emit, and asserts every declared
 *      key is present. This is the assertion that cannot be faked by reading
 *      source: it is the rule's own output, not a scan of it.
 *   3. GATE — `check:i18n` asserts the code sets in this file and in
 *      `lib/policy/rules.ts` are equal in BOTH directions, so a code added to
 *      one and not the other fails CI.
 *
 * ── THE STORED SENTENCE IS NOT DELETED ──────────────────────────────────────
 *
 * `policy_violation.message` stays, and `renderViolation` prefers the catalogue
 * only when the row has a code. Two reasons. A violation waved through with a
 * justification is an audit artefact: the sentence the approver read is part of
 * what they agreed to, and editing this file later must not rewrite that. And
 * every row written before migration `0029` has `message_code = ''` and no
 * labels in its `data`, so it can only be shown as what it already says.
 */
import { DEFAULT_LOCALE, fallbackChain, isLocale, type Locale } from '../locales';
import { formatCalendarDate } from '../format';
import { formatMinor } from '@/lib/money';
import { missingCopyMarker } from './enums';
import { pseudoIfEnabled } from '../pseudo';

/**
 * Every sentence a rule can emit. One per BRANCH, not one per rule — see the
 * header. `lib/policy/rules.ts` names each of these exactly once.
 */
export const POLICY_MESSAGE_CODES = [
  'LIMIT_EXCEEDED',
  'LIMIT_EXCEEDED_CONVERTED',
  'RECEIPT_MISSING',
  'RECEIPT_MISSING_ABOVE',
  'RECEIPT_MISSING_ABOVE_CONVERTED',
  'CATEGORY_INACTIVE',
  'NEGATIVE_AMOUNT',
  'BUDGET_EXCEEDED',
  'BUDGET_FLOOR_FX',
  'RATE_MISSING',
] as const;
export type PolicyMessageCode = (typeof POLICY_MESSAGE_CODES)[number];

export function isPolicyMessageCode(value: string): value is PolicyMessageCode {
  return (POLICY_MESSAGE_CODES as readonly string[]).includes(value);
}

/** The `data` jsonb as it comes back from Postgres. Values are unknown by construction. */
export type MessageData = Record<string, unknown>;

/**
 * Thrown by `fields()` when a declared key is absent. Never escapes
 * `renderPolicyMessage` — see requirement 3, depth 1 — but the tests catch it
 * deliberately, which is how a missing key becomes a failure rather than a
 * sentence with a hole in it.
 */
export class MessageDataError extends Error {
  constructor(
    readonly code: string,
    readonly key: string,
  ) {
    super(`policy message ${code} needs data.${key}, which is not in the row`);
    this.name = 'MessageDataError';
  }
}

/**
 * Typed, checked access to one row's `data`.
 *
 * Every accessor REFUSES rather than coercing. `String(undefined)` is the
 * failure mode this exists to prevent: it produces "undefined is $700.00, over
 * the undefined limit", which is a sentence, renders fine, and tells a reader
 * nothing while looking like it worked.
 */
export interface Fields {
  /** A user-supplied string — a line description, a merchant, a budget name. */
  text(key: string): string;
  /** A minor-unit amount formatted in the READER's locale. */
  money(amountKey: string, currencyKey: string, unitKey: string): string;
  /** A calendar date (no timezone — part 1b), formatted in the reader's locale. */
  date(key: string): string;
  /** A list of currency codes. Empty is a legitimate answer, so it does not throw. */
  list(key: string): string[];
}

function fields(code: string, data: MessageData, locale: Locale): Fields {
  const need = (key: string): unknown => {
    const value = data[key];
    if (value === undefined || value === null) throw new MessageDataError(code, key);
    return value;
  };
  return {
    text(key) {
      const value = need(key);
      // '' is a real answer for an optional label, but it is not a real answer
      // for a key the catalogue DECLARED it needs — the rule should have put a
      // fallback in (`lineLabel` already does, returning 'this line item').
      const s = String(value);
      // TRIMMED, not just checked against ''. A merchant of '   ' renders as
      // "   is $700.00, over the …" — a sentence with a hole in it that reads
      // like a product bug rather than a data one, which is precisely what this
      // accessor exists to stop.
      if (s.trim() === '') throw new MessageDataError(code, key);
      return s;
    },
    money(amountKey, currencyKey, unitKey) {
      const amount = need(amountKey);
      const currency = String(need(currencyKey));
      const unit = Number(need(unitKey));
      if (!Number.isInteger(unit) || unit < 0 || unit > 8) {
        throw new MessageDataError(code, unitKey);
      }
      // `formatMinor` takes a bigint-able; the column stores these as strings
      // because JSON has no bigint and `lib/money` refuses floats.
      return formatMinor(amount as string, currency, unit, locale);
    },
    date(key) {
      // NUMERIC, not `formatCalendarDate`'s `dateStyle: 'medium'` default. Two
      // reasons, and the second is the load-bearing one. A budget period is a
      // RANGE inside a sentence ("(2026-01-01 to 2026-03-31)"), where numeric
      // reads as bounds and "Jan 1, 2026 to Mar 31, 2026" reads as prose. And
      // medium renders `en-CA` as "Jan 1, 2026", which would silently change the
      // ported sentence; numeric gives `en-CA` the `2026-01-01` it already had
      // and `en-US` the `01/01/2026` it should have had all along.
      return formatCalendarDate(String(need(key)), locale, {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      });
    },
    list(key) {
      const value = data[key];
      if (!Array.isArray(value)) return [];
      return value.map((item) => String(item));
    },
  };
}

type Renderer = (f: Fields, locale: Locale) => string;

/**
 * One sentence's copy. The default locale is REQUIRED and the rest are
 * overrides — identical asymmetry to `Copy` in `enums.ts`, and for the identical
 * reason: `en-CA` is where copy is authored and has nowhere to fall back to.
 */
export type PolicyCopy = { [DEFAULT_LOCALE]: Renderer } & Partial<Record<Locale, Renderer>>;

export interface MessageDefinition {
  /**
   * The `data` keys this sentence interpolates. NOT derived from the renderer —
   * a function's body cannot be inspected for the keys it will touch, which is
   * the whole of requirement 3. Declared here, checked against the rules' real
   * output by the test suite.
   */
  requires: readonly string[];
  copy: PolicyCopy;
}

/* ── the sentences ─────────────────────────────────────────────────────────── */

/**
 * PORTED VERBATIM. Every `en-CA` renderer below reproduces, character for
 * character, the sentence `lib/policy/rules.ts` built inline before this file
 * existed — `test/i18n-policy-messages.test.ts` pins each one as a literal
 * string taken from the pre-change source. That pinning is not ceremony: part 2a
 * shipped three copy regressions behind a comment claiming a verbatim port, and
 * `POSTED: 'drafted in the ledger'` was materially wrong for a day.
 *
 * The two deliberate changes, both flagged rather than slipped in:
 *   - Money is formatted in the READER's locale instead of the constant. At
 *     `en-CA` this is a no-op, which is why the pinned strings still match. An
 *     `en-US` reader now sees `CA$700.00` where they used to see `$700.00` for a
 *     Canadian-dollar amount — `Intl` disambiguating a currency that is not the
 *     reader's, which is IL-1's finding pointing the useful way for once.
 *   - Budget period dates go through `formatCalendarDate` with NUMERIC options
 *     instead of being interpolated as raw ISO. Also a no-op at `en-CA`
 *     (`2026-01-01`), and an `en-US` reader gets `01/01/2026`. The options are
 *     explicit rather than the function's `medium` default precisely because
 *     `medium` renders `en-CA` as "Jan 1, 2026" and would have changed the
 *     ported sentence without anybody noticing.
 */
export const POLICY_MESSAGES: Record<PolicyMessageCode, MessageDefinition> = {
  LIMIT_EXCEEDED: {
    requires: [
      'label',
      'amountMinor',
      'currencyCode',
      'minorUnit',
      'thresholdMinor',
      'thresholdCurrency',
      'thresholdMinorUnit',
    ],
    copy: {
      'en-CA': (f) =>
        `${f.text('label')} is ${f.money('amountMinor', 'currencyCode', 'minorUnit')}, over the ` +
        `${f.money('thresholdMinor', 'thresholdCurrency', 'thresholdMinorUnit')} ` +
        `per-transaction limit.`,
    },
  },

  LIMIT_EXCEEDED_CONVERTED: {
    requires: [
      'label',
      'amountMinor',
      'currencyCode',
      'minorUnit',
      'convertedMinor',
      'thresholdMinor',
      'thresholdCurrency',
      'thresholdMinorUnit',
    ],
    copy: {
      // Both currencies are named whenever they differ. A sentence reading
      // "is $700.00, over the $500.00 limit" while one is USD and the other CAD
      // is the sentence that hid PE-1 in the first place.
      'en-CA': (f) =>
        `${f.text('label')} is ${f.money('amountMinor', 'currencyCode', 'minorUnit')} — ` +
        `${f.money('convertedMinor', 'thresholdCurrency', 'thresholdMinorUnit')} converted — ` +
        `over the ${f.money('thresholdMinor', 'thresholdCurrency', 'thresholdMinorUnit')} ` +
        `per-transaction limit.`,
    },
  },

  RECEIPT_MISSING: {
    requires: ['label'],
    copy: {
      'en-CA': (f) => `${f.text('label')} has no receipt attached.`,
    },
  },

  RECEIPT_MISSING_ABOVE: {
    requires: [
      'label',
      'subtotalMinor',
      'currencyCode',
      'minorUnit',
      'thresholdMinor',
      'thresholdCurrency',
      'thresholdMinorUnit',
    ],
    copy: {
      'en-CA': (f) =>
        `${f.text('label')} is ${f.money('subtotalMinor', 'currencyCode', 'minorUnit')} and has ` +
        `no receipt attached (receipts required above ` +
        `${f.money('thresholdMinor', 'thresholdCurrency', 'thresholdMinorUnit')}).`,
    },
  },

  RECEIPT_MISSING_ABOVE_CONVERTED: {
    requires: [
      'label',
      'subtotalMinor',
      'currencyCode',
      'minorUnit',
      'convertedMinor',
      'thresholdMinor',
      'thresholdCurrency',
      'thresholdMinorUnit',
    ],
    copy: {
      'en-CA': (f) =>
        `${f.text('label')} is ${f.money('subtotalMinor', 'currencyCode', 'minorUnit')} — ` +
        `${f.money('convertedMinor', 'thresholdCurrency', 'thresholdMinorUnit')} converted — ` +
        `and has no receipt attached (receipts required above ` +
        `${f.money('thresholdMinor', 'thresholdCurrency', 'thresholdMinorUnit')}).`,
    },
  },

  CATEGORY_INACTIVE: {
    // `categoryLabel` is required here even though the inline version tolerated
    // null with `?? 'a category'`. The fallback moved INTO the rule, where the
    // category row is in hand — a renderer choosing a noun for missing data is a
    // renderer inventing content, and it hides that the label was never loaded.
    requires: ['label', 'categoryLabel'],
    copy: {
      'en-CA': (f) =>
        `${f.text('label')} is coded to ${f.text('categoryLabel')}, which is no longer active. ` +
        `Recode it.`,
    },
  },

  NEGATIVE_AMOUNT: {
    requires: ['label', 'amountMinor', 'currencyCode', 'minorUnit'],
    copy: {
      'en-CA': (f) =>
        `${f.text('label')} is ${f.money('amountMinor', 'currencyCode', 'minorUnit')}. ` +
        `Line items cannot be negative.`,
    },
  },

  BUDGET_EXCEEDED: {
    requires: [
      'budgetName',
      'startsOn',
      'endsOn',
      'currencyCode',
      'minorUnit',
      'amountMinor',
      'projectedMinor',
      'overageMinor',
      'actualMinor',
      'pendingMinor',
      'reportMinor',
    ],
    copy: {
      'en-CA': (f) => {
        const scope = `${f.text('budgetName')} (${f.date('startsOn')} to ${f.date('endsOn')})`;
        const m = (key: string) => f.money(key, 'currencyCode', 'minorUnit');
        return (
          `This report takes ${scope} to ${m('projectedMinor')} against a budget of ` +
          `${m('amountMinor')} — over by ${m('overageMinor')}. ` +
          `${m('actualMinor')} is already approved, ${m('pendingMinor')} ` +
          `is awaiting a decision, and this report adds ${m('reportMinor')}.`
        );
      },
    },
  },

  BUDGET_FLOOR_FX: {
    // `reportMissingRateFrom` is deliberately NOT in `requires`: an empty list is
    // a meaningful state (the unconvertible spend is on EARLIER reports, not this
    // one) and the sentence branches on it. `list()` returns [] rather than
    // throwing for exactly that reason.
    requires: ['budgetName', 'startsOn', 'endsOn', 'currencyCode', 'minorUnit', 'projectedMinor'],
    copy: {
      'en-CA': (f) => {
        const scope = `${f.text('budgetName')} (${f.date('startsOn')} to ${f.date('endsOn')})`;
        const currency = f.text('currencyCode');
        const missing = f.list('reportMissingRateFrom');
        return (
          `Some spend counted against ${scope} could not be converted into ` +
          `${currency}, so ${f.money('projectedMinor', 'currencyCode', 'minorUnit')} is a floor ` +
          `rather than a total` +
          (missing.length > 0
            ? // A plain comma join, kept from the ported sentence. `Intl.ListFormat`
              // is the right answer and is a copy change ("USD, EUR, and GBP"), so
              // it belongs in the PR that adds a locale where a comma join is
              // actually wrong — not smuggled into a port.
              `. This report has spend in ${missing.join(', ')} with no exchange rate to ` +
              `${currency}; an administrator needs to add one.`
            : `. Earlier spend on this budget is affected; an administrator needs to add the ` +
              `missing exchange rates.`)
        );
      },
    },
  },

  RATE_MISSING: {
    requires: ['label', 'fromCurrency', 'toCurrency'],
    copy: {
      'en-CA': (f) =>
        `${f.text('label')} could not be checked against the limit: there is no exchange rate ` +
        `from ${f.text('fromCurrency')} to ${f.text('toCurrency')}, so the two amounts are not ` +
        `comparable. An administrator needs to add one.`,
    },
  },
};

/**
 * Render one message for a reader, or return a marker.
 *
 * ── COPY FALLS BACK; FORMATTING DOES NOT ────────────────────────────────────
 *
 * Two locales are in play here and conflating them is a bug this function had
 * for its first draft, caught by `test/i18n-policy-messages.test.ts`:
 *
 *   COPY locale — which WORDS. Walks the fallback chain, because a locale
 *     without its own sentence borrows one that exists.
 *   READER locale — which NUMBERS AND DATES. Never falls back, because `Intl`
 *     needs no catalogue and there is nothing to borrow. An `en-US` reader with
 *     no `en-US` override still gets `CA$700.00` and `03/31/2026`.
 *
 * The first draft passed `target` — the copy locale — to `fields()`, so an
 * `en-US` reader inheriting `en-CA` words also inherited `en-CA` money, which is
 * the entire defect this ticket exists to fix, reintroduced inside the fix. It
 * matters far more in a locale where the two diverge properly: a French reader
 * reading English copy must still see `1 300,00 $`, because the numbers are
 * theirs even when the sentence is not.
 *
 * NEVER THROWS. IL-4 is a missing key blanking a page, twice, in upstream's
 * production; a renderer that can throw at request time is that defect with
 * extra steps. A `data` row that cannot satisfy its own message is a bug, and
 * the place it is loud is CI — see requirement 3's three depths in the header.
 */
export function renderPolicyMessage(
  code: string,
  data: MessageData,
  locale: Locale | string,
): string {
  const definition = POLICY_MESSAGES[code as PolicyMessageCode] as MessageDefinition | undefined;
  if (definition === undefined) return missingCopyMarker(code);
  // An unsupported tag formats in the default rather than in itself: by the time
  // a row reaches here the locale has been through `resolveLocale`, which only
  // ever returns a member of the registry, so anything else is a caller passing
  // a raw header or a stale column and `Intl` should not be handed it.
  const reader: Locale = isLocale(locale) ? locale : DEFAULT_LOCALE;
  for (const target of fallbackChain(locale)) {
    const renderer = definition.copy[target];
    if (renderer === undefined) continue;
    try {
      // The SECOND place the pseudo-locale is applied. These renderers are
      // functions rather than locale-keyed strings, so they never reach
      // `localizedFrom` — a sentence assembled here would have been the one
      // surface the crawl could not see, which is exactly the kind of gap
      // IL-5/IL-6 is about.
      return pseudoIfEnabled(renderer(fields(code, data, reader), reader));
    } catch {
      // A MessageDataError means this ROW cannot satisfy this sentence, which no
      // other locale will fix — walking on would just repeat the failure in
      // another language. Anything else is a genuine bug in a renderer and is
      // equally not the next locale's problem. Either way the caller gets a
      // marker and `renderViolation` turns that into the stored English.
      return missingCopyMarker(code);
    }
  }
  return missingCopyMarker(code);
}

/**
 * What a stored violation says to this reader.
 *
 * THE ONE PLACE a violation row turns into a sentence. The precedence is the
 * ticket in one function: render from the code when the row has one, and fall
 * back to the frozen English otherwise — which is every row written before
 * `0029`, and any row whose `data` has since stopped satisfying its message.
 */
export function renderViolation(
  violation: {
    message_code: string | null;
    message: string;
    data: MessageData;
  },
  locale: Locale | string,
): string {
  const code = violation.message_code ?? '';
  if (code === '') return violation.message;
  const rendered = renderPolicyMessage(code, violation.data ?? {}, locale);
  // The marker is for a developer in CI, not for an employee looking at their
  // own report. A stored sentence is stale, possibly formatted for the wrong
  // reader — and still enormously better than `{LIMIT_EXCEEDED}`.
  if (rendered === missingCopyMarker(code)) return violation.message;
  return rendered;
}
