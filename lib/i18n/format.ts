/**
 * VX4-7 part 1b — rendering a date, of which there are THREE KINDS.
 *
 * PURE. No `pg`, no `next`, same rule as the rest of `lib/i18n`.
 *
 * ── WHY THREE FUNCTIONS AND NOT ONE ─────────────────────────────────────────
 *
 * `app/expenses/ui.tsx` had one, `formatDate = toISOString().slice(0, 10)`,
 * applied at twenty call sites to two different kinds of value plus a form
 * field. One function, three jobs, and it was wrong at two of them:
 *
 *   A CALENDAR DATE (`date` column: `expense.txn_date`, `budget_period.
 *   starts_on`, `expense_policy.effective_from`, `fx_rate.as_of` — 8 columns).
 *   "The fourth of March" with no time and no zone. It must render as the
 *   fourth of March to every reader on earth. `lib/db/client.ts` now hands these
 *   over as `'YYYY-MM-DD'` STRINGS so no timezone can touch them — read that
 *   file's header for the measurement, which is that a Paris server was already
 *   turning the 4th into the 3rd.
 *
 *   AN INSTANT (`timestamptz`: `created_at`, `approved_at`, `posted_at` — ~90
 *   columns). A moment that happened. It must render in the READER'S zone,
 *   because "approved at 18:00 on the 4th" and "approved at 02:30 on the 5th"
 *   are the same moment described to two people. `formatDate` rendered the UTC
 *   day, so a Vancouver reader saw tomorrow's date for anything recorded after
 *   16:00 their time.
 *
 *   A FORM VALUE (`<input type="date">`). Not a rendering at all: HTML requires
 *   `YYYY-MM-DD` regardless of locale, forever. Localising it is a DATA LOSS
 *   bug, not a cosmetic one — Chrome silently rejects a value it cannot parse,
 *   the field goes blank, and saving the form clears the date. This is the trap
 *   this ticket walked up to: `app/expenses/[reportId]/page.tsx` fed the display
 *   formatter straight into a date input.
 *
 * Three jobs, three names, and `scripts/check-i18n.mjs` now refuses a display
 * formatter in an `<input>` value so the third can never be confused with the
 * other two again.
 */
import { DEFAULT_LOCALE, type Locale } from './locales';
import type { ReaderPrefs } from './resolve';

/**
 * A calendar date as stored and as handed over by the driver: `'YYYY-MM-DD'`.
 *
 * A named type rather than a bare `string`, because the whole point of the type
 * parser is that these are NOT interchangeable with an instant, and a signature
 * saying `CalendarDate` says which of the three kinds it wants.
 */
export type CalendarDate = string;

const CALENDAR_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Render a calendar date. No zone is involved, because the value has none.
 *
 * The `Date` built below is at UTC midnight and is DISCARDED after formatting —
 * it exists only because `Intl.DateTimeFormat` takes a Date. Pairing it with
 * `timeZone: 'UTC'` means the three numbers that go in are the three numbers
 * that come out. Nothing here reads the process's zone, so this function
 * produces the same string on a Paris server and a Vancouver one, which is the
 * property that was missing.
 *
 * Returns '' for null/absent, matching what the old `formatDate` did, so a
 * missing date renders as a gap rather than as "Invalid Date".
 */
export function formatCalendarDate(
  value: CalendarDate | null | undefined,
  locale: Locale | string,
  options: Intl.DateTimeFormatOptions = { dateStyle: 'medium' },
): string {
  if (!value) return '';
  const m = CALENDAR_DATE.exec(value.slice(0, 10));
  if (!m) return '';
  const [, y, mo, d] = m;
  const at = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
  if (Number.isNaN(at.getTime())) return '';
  return new Intl.DateTimeFormat(locale, { ...options, timeZone: 'UTC' }).format(at);
}

/**
 * Render an instant in the reader's zone.
 *
 * Takes the whole `ReaderPrefs` rather than a locale and a zone separately, for
 * the reason `resolve.ts` gives: two parameters means the second one gets
 * forgotten at half the call sites, which is exactly how `formatMinor`'s locale
 * parameter sat unused at all 23 of its callers for three phases.
 *
 * `dateStyle: 'medium'` by default — the same information the old formatter
 * gave, in the reader's conventions. A caller that wants the time as well
 * passes `timeStyle`, which is what the notification and delivery screens do,
 * because "next try 14:05" without a clock is not an answer.
 */
export function formatInstant(
  value: Date | string | null | undefined,
  prefs: ReaderPrefs,
  options: Intl.DateTimeFormatOptions = { dateStyle: 'medium' },
): string {
  if (value === null || value === undefined) return '';
  const at = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(at.getTime())) return '';
  return new Intl.DateTimeFormat(prefs.locale, { ...options, timeZone: prefs.timeZone }).format(at);
}

/**
 * The value for an `<input type="date">`. ALWAYS `YYYY-MM-DD`, never localised.
 *
 * ── THIS FUNCTION IS DELIBERATELY NOT LOCALE-AWARE, AND THAT IS THE POINT ───
 *
 * HTML defines the value of a date input as a valid date string in exactly this
 * format. The browser renders it to the user in THEIR locale itself — that is
 * the browser's job, not ours — and it rejects anything else. "Rejects" here
 * means silently: no error, no console warning, the field simply shows empty.
 * So a localised value produces a form that looks like it has no date, and
 * submitting it clears the stored one.
 *
 * A `CalendarDate` is already in this format, so this is the identity for the
 * common case — kept as a named function anyway, because the NAME is what tells
 * the next reader that this string is bound for a form control and must not be
 * "fixed" to respect the reader's locale. A bare `{expense.txn_date}` in a
 * `defaultValue` would be correct today and indistinguishable from an oversight.
 *
 * It accepts a Date too, for the one caller that has an instant and wants the
 * calendar day of it — and that conversion is done in the SUPPLIED ZONE rather
 * than in UTC or the server's, because "today" for a date input means today
 * where the reader is.
 */
export function toDateInputValue(
  value: CalendarDate | Date | null | undefined,
  zone?: string,
): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') {
    return CALENDAR_DATE.test(value.slice(0, 10)) ? value.slice(0, 10) : '';
  }
  if (Number.isNaN(value.getTime())) return '';

  // The PARTS are read and the string is assembled here, rather than letting a
  // locale lay it out. Writing `Intl.DateTimeFormat('en-CA', …)` would also
  // produce `YYYY-MM-DD` — en-CA happens to use ISO order — but it would be a
  // locale tag doing a formatter's job, which is the exact confusion this whole
  // ticket is about, and `scripts/check-i18n.mjs` would rightly flag the
  // literal. Assembling from parts makes the output provably independent of
  // which locale is passed: only the ZONE affects the answer.
  //
  // The zone is the reader's when given, because 02:30 UTC is still yesterday
  // in Vancouver, and a date picker that opens on tomorrow is a bug somebody
  // reports as "it defaults wrong".
  const parts = new Intl.DateTimeFormat(DEFAULT_LOCALE, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone: zone ?? 'UTC',
  }).formatToParts(value);
  const at = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? '';
  const y = at('year');
  const mo = at('month');
  const d = at('day');
  return y && mo && d ? `${y}-${mo}-${d}` : '';
}
