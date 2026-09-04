/**
 * The machinery two message catalogues share: typed access to a row's `data`,
 * and the shape of a locale-keyed renderer.
 *
 * ── WHY THIS FILE EXISTS, AS OF VX4-8 PART 2 ────────────────────────────────
 *
 * All of it was written for `policy-messages.ts` in VX4-7 part 2b, where it was
 * private. `fraud-messages.ts` needs exactly the same three things — a `Fields`
 * accessor that REFUSES a missing key rather than rendering `undefined`, an error
 * that names the code and the key, and a `Copy` type whose default locale is
 * required and whose others are overrides.
 *
 * Copying it would have been the cheaper diff and the wrong one. UD-9 is the
 * standing note about hand-kept correspondences in this tree: two copies of an
 * accessor is two places for the refusal rules to drift, and the day they drift
 * is the day one catalogue renders a sentence with a hole in it while the other
 * throws. `policy-messages.ts` re-exports these names, so nothing that imported
 * them from there had to change.
 *
 * Nothing here knows what a policy or a fraud rule is, and it should stay that
 * way: a third catalogue should be able to use it without adding a case.
 */
import { formatMinor } from '@/lib/money';
import { formatCalendarDate } from '@/lib/i18n/format';
import { DEFAULT_LOCALE, type Locale } from '@/lib/i18n/locales';

/** The `data` jsonb as it comes back from Postgres. Values are unknown by construction. */
export type MessageData = Record<string, unknown>;

/**
 * Thrown by `fields()` when a declared key is absent. Never escapes
 * the catalogue's own render function — see requirement 3, depth 1 — but the tests catch it
 * deliberately, which is how a missing key becomes a failure rather than a
 * sentence with a hole in it.
 */
export class MessageDataError extends Error {
  constructor(
    readonly code: string,
    readonly key: string,
  ) {
    super(`message ${code} needs data.${key}, which is not in the row`);
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
  /**
   * A whole number — a count of entries, approvals, samples — formatted in the
   * reader's locale.
   *
   * Added in VX4-8 part 2, when a second catalogue turned out to be made of
   * counts and multiples where the first was made of money and dates. It is here
   * rather than in `fraud-messages.ts` for the reason this file exists at all: a
   * third catalogue should not have to write it a third time.
   *
   * REFUSES a non-integer rather than rounding. A count that arrives as 3.5 is a
   * query returning something other than what the sentence claims to be
   * describing, and rounding it to 4 would put a plausible wrong number in front
   * of a reviewer.
   */
  count(key: string): string;
  /**
   * A ratio or a multiple — 2.4σ, 0.83 concentration — at a fixed number of
   * decimal places, in the reader's locale.
   *
   * `digits` is the caller's, not the data's: the sentence decides how much
   * precision is worth reading, and a stored 2.4166666 must not decide it by
   * accident.
   */
  decimal(key: string, digits: number): string;
}

export function fields(code: string, data: MessageData, locale: Locale): Fields {
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
    count(key) {
      const value = Number(need(key));
      if (!Number.isInteger(value)) throw new MessageDataError(code, key);
      return new Intl.NumberFormat(locale).format(value);
    },
    decimal(key, digits) {
      const value = Number(need(key));
      if (!Number.isFinite(value)) throw new MessageDataError(code, key);
      return new Intl.NumberFormat(locale, {
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
      }).format(value);
    },
  };
}

export type Renderer = (f: Fields, locale: Locale) => string;

/**
 * One sentence's copy. The default locale is REQUIRED and the rest are
 * overrides — identical asymmetry to `Copy` in `enums.ts`, and for the identical
 * reason: `en-CA` is where copy is authored and has nowhere to fall back to.
 */
export type MessageCopy = { [DEFAULT_LOCALE]: Renderer } & Partial<Record<Locale, Renderer>>;

export interface MessageDefinition {
  /**
   * The `data` keys this sentence interpolates. NOT derived from the renderer —
   * a function's body cannot be inspected for the keys it will touch, which is
   * the whole of requirement 3. Declared here, checked against the rules' real
   * output by the test suite.
   */
  requires: readonly string[];
  copy: MessageCopy;
}
