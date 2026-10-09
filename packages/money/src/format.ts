/**
 * Locale-aware Money formatter.
 *
 * Uses Intl.NumberFormat so the symbol position, grouping separator,
 * and exponent all follow the user's locale. Pass the same `locale`
 * value next-intl uses elsewhere (e.g. `'en'`, `'fr-CA'`) so a single
 * report reads consistently across all its money fields.
 *
 * Implementation note: we read base + exponent from the dinero
 * currency definition rather than letting Intl infer them from the
 * ISO code. dinero's exponent for JPY is 0 (no minor unit), and Intl
 * sometimes formats currencies it doesn't fully recognise as zero-
 * exponent — this keeps the two in sync.
 */

import { getCurrency } from './currencies';
import type { Money } from './money';

const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

export interface FormatMoneyOptions {
  /** BCP-47 locale tag — REQUIRED, and it must be the READER's locale
   *  (the `[locale]` route segment / next-intl `useLocale()`), never the
   *  runtime's. There is deliberately no default: a default is silently
   *  wrong for every reader who doesn't share it, and an `'en-US'`
   *  fallback here is what shipped `10,799.00` to French-Canadian
   *  readers who should have seen `10 799,00 $`. If a caller can't
   *  reach the reader's locale, that call site is in the wrong place —
   *  thread the locale down rather than picking one here. */
  locale: string;
  /** When true, drops the currency symbol — useful for inline forms
   *  where the currency is shown next to the input. */
  noSymbol?: boolean;
  /**
   * When true, renders the ISO code where the symbol would go, on the side the
   * locale puts it — `CAD 3,529.17` in `en`, `3 529,17 CAD` in `fr-CA`.
   *
   * For any list that can hold more than one currency at once. CAD and USD share
   * the `$` glyph, so `narrowSymbol` makes two different amounts of two different
   * currencies print identically, and the reader has no way to tell a USD report
   * from a CAD one (GA readiness report F54). Ignored when `noSymbol` is set —
   * that asks for a bare number, and the caller is printing the code itself.
   */
  withCode?: boolean;
}

export function formatMoney(m: Money, opts: FormatMoneyOptions): string {
  const c = getCurrency(m.currencyCode);
  if (m.amountMinor > MAX_SAFE_BIGINT || m.amountMinor < -MAX_SAFE_BIGINT) {
    // Same overflow rule as toDinero — silently truncating here would
    // produce a misleading display string.
    throw new Error(`amountMinor ${m.amountMinor.toString()} exceeds Number.MAX_SAFE_INTEGER`);
  }
  // Divide the integer minor amount by base^exponent to get the
  // major-unit value the formatter expects. dinero uses base=10 +
  // exponent=2 for typical currencies (cents); JPY is base=10
  // exponent=0 so the amount is already the major unit.
  //
  // `c.base` is a number for every modern ISO-4217 currency. The
  // array form (mixed-base currencies — pre-decimal GBP, etc.) is
  // not in scope; throw early rather than silently miscomputing.
  const baseNum = typeof c.base === 'number' ? c.base : null;
  if (baseNum === null) {
    throw new Error(`Currency ${m.currencyCode} uses a mixed base; not supported.`);
  }
  const minor = Number(m.amountMinor);
  const major = minor / baseNum ** c.exponent;
  const formatter = new Intl.NumberFormat(opts.locale, {
    style: opts.noSymbol ? 'decimal' : 'currency',
    currency: m.currencyCode,
    // `narrowSymbol`, not the default `symbol`. The default disambiguates
    // against the locale's own currency — CAD in `en` renders `CA$10,799.00`,
    // USD in `fr-CA` renders `80,40 $ US` — which is correct in isolation but
    // wrong beside the ISO code most of this app's money fields already print,
    // and it is not the glyph the `Currency` rows carry. `narrowSymbol` gives
    // `$10,799.00` in `en` and `10 799,00 $` in `fr-CA`: the short glyph, on
    // the side the locale puts it. It falls back to the full symbol (or the
    // code, as for KWD) where no narrow form exists.
    ...(opts.noSymbol
      ? {}
      : { currencyDisplay: opts.withCode ? ('code' as const) : ('narrowSymbol' as const) }),
    minimumFractionDigits: c.exponent,
    maximumFractionDigits: c.exponent,
  });
  return formatter.format(major);
}
