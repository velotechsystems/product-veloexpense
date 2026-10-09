/**
 * Cross-cutting display / formatting helpers shared by list pages and
 * drawers. These are pure functions with no React, i18n, or router
 * dependencies so they can be unit-tested directly and reused anywhere
 * in the web app.
 *
 * Note: this `pickText` is the app-side locale-map reader (object →
 * requested locale → `en` → first available → `''`, with plain-string
 * passthrough). It intentionally differs from `@expenseos/i18n`'s
 * `getLocalized`, which returns `null` (no first-available fallback, no
 * string passthrough) and is used on DB-content paths that want that
 * stricter contract.
 */

import { formatMoney, getCurrency, isKnownCurrency } from '@expenseos/money';

/** Pull a display string out of a Prisma Json locale map. */
export function pickText(value: unknown, locale: string): string {
  if (value && typeof value === 'object') {
    const map = value as Record<string, string>;
    return map[locale] ?? map.en ?? Object.values(map)[0] ?? '';
  }
  return typeof value === 'string' ? value : '';
}

/** Compose a person's display name, falling back to their email. */
export function displayName(u: {
  firstName: string | null;
  lastName: string | null;
  email: string;
}): string {
  return [u.firstName, u.lastName].filter(Boolean).join(' ') || u.email;
}

/** The currency shape `formatMinor` needs: an ISO code (which drives the
 *  exponent AND the symbol) plus an optional `symbol`. Most payloads already
 *  carry `{ code, symbol }` on `…​.currency`.
 *
 *  The `symbol` field is only read as a *suppression* signal: absent/null/empty
 *  means "print the number bare" (the caller renders the code itself, which is
 *  what `{ code }`-only call sites have always relied on). When present it is
 *  NOT used as the glyph — see `formatMinor` for why. */
export interface CurrencyLike {
  code: string;
  symbol?: string | null;
}

/**
 * Minor-unit bigint/number → display string for one READER, in that reader's
 * locale. Thin wrapper over `formatMoney` from `@expenseos/money` — the
 * exponent maths, the symbol, its POSITION, and the group/decimal separators
 * all come from `Intl` there. This function exists only to absorb the three
 * things the app-side call sites need and the package contract doesn't offer:
 * a `null` amount, a `{ code, symbol }` row instead of a `Money`, and
 * tolerance of an unknown ISO code.
 *
 * Why it must NOT format anything itself: it used to be a second formatter —
 * `${symbol}${major.toLocaleString(undefined, …)}` — and both halves of that
 * template were wrong. `undefined` resolves to the *runtime's* locale (the
 * Node process on the server, the browser's setting on the client), so it
 * disagreed with the `[locale]` route segment and disagreed with itself
 * across hydration; and a hard-coded leading symbol makes correct output
 * structurally impossible for the locales that trail it. The same 10 799,00
 * CAD read `$10,799.00` to a French-Canadian reader instead of
 * `10 799,00 $`.
 *
 * `locale` is required and must be the reader's — `useLocale()` from
 * next-intl in a client component. Every current call site is in a
 * `'use client'` component under `[locale]`, so it is always reachable.
 *
 * `null` → em dash. An ISO code Intl/dinero doesn't know (blank strings and
 * placeholder codes both occur in import previews) falls back to a
 * locale-aware 2-decimal *decimal* — still the reader's separators, just no
 * symbol. The only throw it inherits is `formatMoney`'s overflow guard past
 * `Number.MAX_SAFE_INTEGER` minor units, which is deliberate: a truncated
 * money figure is worse than a loud one.
 */
export function formatMinor(
  minor: bigint | number | null,
  currency: CurrencyLike,
  locale: string,
  opts?: {
    /**
     * Render the ISO code instead of the symbol, on the side the locale puts it.
     *
     * For any list that can hold more than one currency at once: CAD and USD share the
     * `$` glyph, so without this a USD report and a CAD one print identically and the
     * reader cannot tell them apart (GA readiness report F54).
     */
    withCode?: boolean;
  },
): string {
  if (minor === null) return '—';
  // A falsy `symbol` is the long-standing "caller prints the code beside it"
  // signal — `{ code }` with no symbol at all is the common form of it, and
  // the old template rendered `currency.symbol ?? ''` for exactly that case.
  // …but an EXPLICIT `withCode` beats that inference. `{ code }` with no symbol is the
  // common shape of a currency in this app, and a caller asking for the code has already
  // said what it wants printed — reading the absent symbol as "print nothing" would
  // silently drop the code and hand back a bare number.
  const noSymbol = !opts?.withCode && !currency.symbol;
  const amountMinor = typeof minor === 'bigint' ? minor : BigInt(Math.round(minor));
  if (!isKnownCurrency(currency.code)) {
    return new Intl.NumberFormat(locale, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(Number(amountMinor) / 100);
  }
  return formatMoney(
    { amountMinor, currencyCode: currency.code },
    { locale, noSymbol, withCode: opts?.withCode },
  );
}

/** ISO-4217 exponent for a currency code, defaulting to 2 for unknown codes.
 *  The single place the web app derives a currency's minor-unit scale. */
export function currencyExponent(code: string): number {
  try {
    return getCurrency(code).exponent;
  } catch {
    return 2;
  }
}

/** The group and decimal characters a locale actually uses, read out of Intl
 *  rather than hardcoded — fr-CA groups with a no-break space (U+00A0) or a
 *  narrow no-break space (U+202F) depending on the ICU build, so a literal
 *  table would be wrong on some runtimes. */
function localeSeparators(locale: string): { group: string; decimal: string } {
  const parts = new Intl.NumberFormat(locale).formatToParts(12345.6);
  return {
    group: parts.find((p) => p.type === 'group')?.value ?? ',',
    decimal: parts.find((p) => p.type === 'decimal')?.value ?? '.',
  };
}

/** One parse attempt with an explicit decimal character. Returns null for
 *  anything that isn't unambiguously a number in that notation — refusing an
 *  ambiguous amount is the only safe answer for money. */
function parseWith(text: string, group: string, decimal: string): number | null {
  // Strip every flavour of space: the grouping character a locale emits may be
  // U+00A0 / U+202F / U+2009, while a person typing it uses a plain space.
  let s = text.replace(/[\s\u00A0\u202F\u2009]/g, '');
  if (s === '') return null;
  const sign = s[0] === '-' || s[0] === '+' ? s[0] : '';
  if (sign) s = s.slice(1);
  const pieces = s.split(decimal);
  if (pieces.length > 2) return null; // two decimal separators — not a number
  const frac = pieces[1];
  let ints = pieces[0] ?? '';
  // A *visible* group separator (en's comma) has to sit in a legal grouping
  // position before we drop it. Without this check a fr-CA amount typed into
  // an en field — "10799,00" — would strip to "1079900" and read as
  // 1,079,900.00 instead of being rejected: a silent 100x, the worst possible
  // outcome. (fr-CA's group is a space, already gone above.)
  if (group.trim() !== '' && ints.includes(group)) {
    const chunks = ints.split(group);
    if (!/^\d{1,3}$/.test(chunks[0])) return null;
    if (!chunks.slice(1).every((c) => /^\d{3}$/.test(c))) return null;
    ints = chunks.join('');
  }
  if (ints !== '' && !/^\d+$/.test(ints)) return null;
  if (frac !== undefined && !/^\d*$/.test(frac)) return null;
  if (ints === '' && (frac === undefined || frac === '')) return null;
  const n = Number(`${sign}${ints || '0'}.${frac || '0'}`);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse a user-entered major-unit amount into minor units for the currency
 * (×10^exponent), reading it in the READER's notation. `null`/blank → null,
 * and null for anything that isn't cleanly a number.
 *
 * Why `locale` is required: this is the inverse of the `formatMinor` bug. The
 * old body was `Number(major)`, which only ever accepted `1234.56`. A
 * French-Canadian typing `10 799,00` — which is what their keyboard's decimal
 * key and their own notation produce, and what a localized field ought to
 * accept — got `NaN` → `null`. Several call sites coalesce that null with
 * `?? 0n` (the budget spread, for one), so the amount didn't merely fail to
 * save: it saved as ZERO.
 *
 * Both notations are accepted where they're unambiguous: the locale's own
 * decimal character first, then a plain `.` as a fallback when `.` isn't the
 * locale's grouping character (it isn't in either EN or FR-CA), so a fr-CA
 * user with a US keyboard is not locked out either.
 */
export function majorToMinor(
  major: number | string | null,
  code: string,
  locale: string,
): bigint | null {
  if (major === null || major === '') return null;
  let n: number | null;
  if (typeof major === 'number') {
    n = major;
  } else {
    const { group, decimal } = localeSeparators(locale);
    n = parseWith(major, group, decimal);
    if (n === null && decimal !== '.' && group !== '.') n = parseWith(major, group, '.');
  }
  if (n === null || !Number.isFinite(n)) return null;
  return BigInt(Math.round(n * 10 ** currencyExponent(code)));
}

/**
 * Drop every character that cannot appear in a money amount typed in this locale.
 *
 * A FILTER, not a validator, and the distinction is the whole point: it has to let a
 * HALF-TYPED amount through — "", "-", "12,", "1 " — because people type one character at a
 * time. What it makes impossible is getting "abc", or a pasted "twelve dollars", into the
 * field at all.
 *
 * The audit typed `abc<b>x</b>` into a `$` field and it was accepted (GA readiness report
 * F06). The only consequence was a save that never happened, because the value could not be
 * converted — so the bogus text sat there looking exactly like a saved amount.
 *
 * Locale-aware because the reader's decimal character is: a French-Canadian typing "12,50"
 * is not making a mistake, and stripping their comma would be.
 */
export function sanitizeMoneyText(text: string, locale: string): string {
  const { group, decimal } = localeSeparators(locale);
  let out = '';
  for (const ch of text) {
    if (ch >= '0' && ch <= '9') {
      out += ch;
      continue;
    }
    // A leading sign only, and only once — "1-2" is not a number anybody means.
    if ((ch === '-' || ch === '+') && out.length === 0) {
      out += ch;
      continue;
    }
    // One decimal mark. Both the locale's and '.' are accepted on the way in, the same
    // tolerance `majorToMinor` already applies, so a pasted machine value still works.
    if ((ch === decimal || ch === '.') && !out.includes(decimal) && !out.includes('.')) {
      out += ch;
      continue;
    }
    /**
     * Grouping characters pass through — `majorToMinor` strips them — but only AFTER a digit.
     * fr-CA groups with a space, so a space is legitimate inside "1 234,50"; one at the front
     * is not grouping anything, and letting it through is how "twelve dollars" left a stray
     * " " in the field instead of nothing.
     */
    if ((ch === group || ch === ' ' || ch === '\u00A0' || ch === '\u202F') && /[0-9]/.test(out)) {
      out += ch;
    }
    // Anything else — letters, markup, currency symbols, emoji — is dropped.
  }
  return out;
}

/** Minor units → a plain decimal string ("11.30", or "1130" for JPY) to seed a
 *  money INPUT field — exponent-aware, no symbol.
 *
 *  Deliberately NOT localized, and deliberately separate from `formatMinor`:
 *  this string is a machine value, not a rendered figure. Several callers feed
 *  it straight back into `Number(...)` or into a CSV `exportValue`, both of
 *  which would break on a comma decimal. `majorToMinor` accepts the reader's
 *  notation on the way in, so a person who retypes the field in their own
 *  notation still round-trips. `null` → "". */
export function minorToMajorInput(minor: bigint | number | null, code: string): string {
  if (minor === null) return '';
  return (Number(minor) / 10 ** currencyExponent(code)).toFixed(currencyExponent(code));
}

/**
 * Sum a set of already-converted totals, EXCLUDING the ones that could not be converted.
 *
 * The values are `homeTotalMinor` as the expense routers hand it over: a minor-unit amount
 * as a decimal STRING (bigint does not survive JSON), already converted into the reader's
 * home currency — or `null` when no FX rate connects the report's currency to the reader's
 * in either direction.
 *
 * **`null` means EXCLUDE. It never means zero.** Both of the obvious shortcuts are wrong in
 * ways that show up as a number a reader will act on:
 *
 *   - `?? 0` understates the total silently. The panel says $4,000 when the true figure is
 *     unknowable-but-larger, and nothing on screen admits a report was left out.
 *   - falling back to the raw `totalMinor` adds USD cents to CAD cents under a single `$`.
 *     That is the F54 error from the GA readiness report, and it is worse than understating
 *     because the result looks precise.
 *
 * So the count comes back alongside the sum: `excluded` is how many amounts were dropped,
 * and a caller that renders the total is expected to say so when it is non-zero. A total
 * that quietly omits rows is a wrong total.
 *
 * Returns `{ minor: 0n, excluded: 0 }` for an empty list — a real zero, and the only zero
 * this function can produce that means "nothing to add up".
 */
export function sumInHome(values: readonly (string | null)[]): {
  minor: bigint;
  excluded: number;
} {
  let minor = 0n;
  let excluded = 0;
  for (const v of values) {
    if (v === null) excluded += 1;
    else minor += BigInt(v);
  }
  return { minor, excluded };
}
