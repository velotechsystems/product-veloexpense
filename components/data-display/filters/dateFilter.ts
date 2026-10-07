/**
 * Date-filter value model for the pill bar's `'date'` field kind.
 *
 * A date clause carries a `FilterOp` plus a string value; this module is the
 * single source of truth for how that (op, value) pair is encoded, resolved to
 * an absolute `[gte, lt)` window, and rendered as a human-readable pill label.
 *
 * Encoding by op:
 *   on / before / after   value = `YYYY-MM-DD`
 *   between               value = `YYYY-MM-DD..YYYY-MM-DD`
 *   within (relative)     value = a preset token (see DATE_PRESETS) or
 *                                 `lastNdays:<n>` for a custom "last N days"
 *
 * Relative presets resolve against a caller-supplied `now` so resolution is
 * pure and timezone-correct (the client passes the browser's `new Date()`),
 * which keeps the server filtering on plain absolute `gte` / `lt` bounds.
 *
 * ── On adding a preset ──
 *
 * A `last3mo` was proposed here, when `/expenses/all` moved its opening default
 * from a year to a quarter, and was REJECTED. Not because a three-month window
 * is wrong — it is what that list now opens on — but because the enum already
 * holds that slot twice over: `qtd` is the calendar quarter and `last90` is the
 * rolling one. A third token would leave every future author choosing a
 * quarter-ish default facing two near-identical options with no principled rule
 * for picking between them, and saved views splitting across both.
 *
 * The rule that governs this list is TOKEN-NAME HONESTY, not window duration: a
 * token's label is a promise about what it resolves to, so nothing labelled
 * "Last 3 months" may resolve `addDays(-89)`. `last90` is labelled "Last 90
 * days" and resolves ninety days, which is why it was already correct.
 */

export type DatePresetToken =
  | 'today'
  | 'yesterday'
  | 'last7'
  | 'last30'
  | 'last90'
  | 'last12mo'
  | 'mtd'
  | 'qtd'
  | 'ytd'
  | 'thisMonth'
  | 'lastMonth'
  | 'thisYear'
  | 'lastYear';

/** Ordered preset list for the `within` editor's dropdown. */
export const DATE_PRESETS: { value: DatePresetToken; label: string }[] = [
  { value: 'today', label: 'Today' },
  { value: 'yesterday', label: 'Yesterday' },
  { value: 'last7', label: 'Last 7 days' },
  { value: 'last30', label: 'Last 30 days' },
  { value: 'last90', label: 'Last 90 days' },
  // A rolling year, which is a different window from `ytd` (January to today) and from
  // `lastYear` (the previous calendar year). No list OPENS on it any more — `/expenses/all`
  // was its only consumer and moved to `last90` — but it is what the missing-receipt chase
  // view carries, because the receipts worth chasing are the oldest ones.
  { value: 'last12mo', label: 'Last 12 months' },
  { value: 'mtd', label: 'Month to date' },
  { value: 'qtd', label: 'Quarter to date' },
  { value: 'ytd', label: 'Year to date' },
  { value: 'thisMonth', label: 'This month' },
  { value: 'lastMonth', label: 'Last month' },
  { value: 'thisYear', label: 'This year' },
  { value: 'lastYear', label: 'Last year' },
];

const PRESET_LABELS: Record<DatePresetToken, string> = Object.fromEntries(
  DATE_PRESETS.map((p) => [p.value, p.label]),
) as Record<DatePresetToken, string>;

/** Sentinel value the editor writes for the custom "Last N days" choice. */
export const LAST_N_DAYS_PREFIX = 'lastNdays:';

// ─── Local-time date helpers (pure; operate on the caller's `now`) ──
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const startOfMonth = (d: Date) => new Date(d.getFullYear(), d.getMonth(), 1);
const addMonths = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth() + n, 1);
const startOfQuarter = (d: Date) => new Date(d.getFullYear(), Math.floor(d.getMonth() / 3) * 3, 1);
const startOfYear = (d: Date) => new Date(d.getFullYear(), 0, 1);
/** Shift a DAY by whole months, keeping the day-of-month where the target month has one
 *  (31 Mar − 1 month is 28/29 Feb, not 3 March — `Date` would roll it forward). */
const addMonthsToDay = (d: Date, n: number) => {
  const target = new Date(d.getFullYear(), d.getMonth() + n, 1);
  const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  return new Date(target.getFullYear(), target.getMonth(), Math.min(d.getDate(), lastDay));
};

/** Parse a `YYYY-MM-DD` token as a local date (not UTC). Returns null if blank
 *  or malformed so callers can no-op on a half-typed clause. */
function parseDay(value: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const [, y, mo, d] = m;
  return new Date(Number(y), Number(mo) - 1, Number(d));
}

export interface DateWindow {
  gte?: Date;
  /** Exclusive upper bound (`<`). */
  lt?: Date;
}

/** Parse `lastNdays:<n>` → n (>=1), else null. */
export function parseLastNDays(value: string): number | null {
  if (!value.startsWith(LAST_N_DAYS_PREFIX)) return null;
  const n = Number.parseInt(value.slice(LAST_N_DAYS_PREFIX.length), 10);
  return Number.isFinite(n) && n >= 1 ? n : null;
}

function resolveWithin(value: string, now: Date): DateWindow {
  const endOfTodayExclusive = addDays(startOfDay(now), 1);
  const n = parseLastNDays(value);
  if (n !== null) {
    // "Last N days" includes today → window is [today-(n-1), tomorrow).
    return { gte: addDays(startOfDay(now), -(n - 1)), lt: endOfTodayExclusive };
  }
  switch (value as DatePresetToken) {
    case 'today':
      return { gte: startOfDay(now), lt: endOfTodayExclusive };
    case 'yesterday':
      return { gte: addDays(startOfDay(now), -1), lt: startOfDay(now) };
    case 'last7':
      return { gte: addDays(startOfDay(now), -6), lt: endOfTodayExclusive };
    case 'last30':
      return { gte: addDays(startOfDay(now), -29), lt: endOfTodayExclusive };
    case 'last90':
      return { gte: addDays(startOfDay(now), -89), lt: endOfTodayExclusive };
    case 'last12mo':
      // Twelve calendar months back from today, not 365 days: a window that shifts by a
      // day every leap year reads as a bug on a report somebody runs monthly.
      return { gte: addMonthsToDay(startOfDay(now), -12), lt: endOfTodayExclusive };
    case 'mtd':
      return { gte: startOfMonth(now), lt: endOfTodayExclusive };
    case 'qtd':
      return { gte: startOfQuarter(now), lt: endOfTodayExclusive };
    case 'ytd':
      return { gte: startOfYear(now), lt: endOfTodayExclusive };
    case 'thisMonth':
      return { gte: startOfMonth(now), lt: addMonths(startOfMonth(now), 1) };
    case 'lastMonth':
      return { gte: addMonths(startOfMonth(now), -1), lt: startOfMonth(now) };
    case 'thisYear':
      return { gte: startOfYear(now), lt: new Date(now.getFullYear() + 1, 0, 1) };
    case 'lastYear':
      return { gte: new Date(now.getFullYear() - 1, 0, 1), lt: startOfYear(now) };
    default:
      return {};
  }
}

/**
 * Resolve a date clause to an absolute `[gte, lt)` window. Returns an empty
 * window for an unparseable / half-typed value so callers can skip it.
 */
export function resolveDateFilter(op: string, value: string, now: Date): DateWindow {
  if (op === 'within') return resolveWithin(value, now);
  if (op === 'between') {
    const [a, b] = value.split('..');
    const start = a ? parseDay(a) : null;
    const end = b ? parseDay(b) : null;
    const win: DateWindow = {};
    if (start) win.gte = start;
    if (end) win.lt = addDays(end, 1); // inclusive end day
    return win;
  }
  const day = parseDay(value);
  if (!day) return {};
  switch (op) {
    case 'on':
      return { gte: day, lt: addDays(day, 1) };
    case 'before':
      return { lt: day };
    case 'after':
      return { gte: day };
    default:
      return {};
  }
}

/** Human-readable rendering of a date clause value for the pill chip. */
export function formatDateFilterValue(op: string, value: string): string {
  if (op === 'within') {
    const n = parseLastNDays(value);
    if (n !== null) return `Last ${n} days`;
    return PRESET_LABELS[value as DatePresetToken] ?? value;
  }
  if (op === 'between') {
    const [a, b] = value.split('..');
    if (!a && !b) return '…';
    return `${a || '…'} → ${b || '…'}`;
  }
  return value || '…';
}
