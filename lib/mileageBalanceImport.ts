/**
 * Year-to-date mileage (Concur "YTD Employee Mileage Summary") import parser.
 *
 * Read entirely in the browser — an .xlsx is a ZIP of XML, unzipped by `fflate` and
 * read with the platform `DOMParser` through the same grid reader the cardholder
 * import uses (`readWorkbookGrid`). Only one compact row per person is posted to
 * `mileageBalances.preview`; the file itself is never uploaded or stored.
 *
 * What the export looks like, and what this deliberately does NOT assume:
 *
 *   - A title block precedes the table — a title, a "Period: Jan 1, 2026 – Oct 15, 2026 |
 *     …" line, a totals strip — so the header is found by its LABELS, never by index.
 *   - Cells are inline strings (no sharedStrings.xml) in the export we have; shared
 *     strings are handled anyway because re-saving the file in Excel produces them.
 *   - Numbers arrive as binary floats (`0.6699999999999999`), so a rate is rounded to
 *     four places and a distance or amount to two.
 *   - The table ends in blank rows and a "Grand Total" row whose cells are formulas
 *     with no cached value. Neither is a person.
 */

import { readWorkbookGrid } from './workbookGrid';

/** One person's line, in the shape `mileageBalances.preview` takes. */
export interface MileageBalanceRow {
  /** The name exactly as the file prints it ("Last, First"). */
  name: string;
  /** Year-to-date kilometres, two places. */
  distance: string;
  /** The rate most recently paid, per km, up to four places. */
  paidRate: string | null;
  /** Total approved amount, two places. */
  amount: string | null;
  /** The person's most recent claim (YYYY-MM-DD), when the file says. */
  claimDate: string | null;
}

export type MileageBalanceParseErrorCode = 'noSheet' | 'noHeader' | 'noRows';

export interface MileageBalanceParseResult {
  rows: MileageBalanceRow[];
  /** The file's period end (YYYY-MM-DD): the "Period:" line, else the latest claim date. */
  periodEnd: string | null;
  error: MileageBalanceParseErrorCode | null;
}

/** Lowercase, alphanumerics only — "YTD Distance (KM)" ≡ "ytd_distance_km". */
function headerKey(v: string): string {
  return v.toLowerCase().replace(/[^a-z0-9]/g, '');
}

const COLUMNS = {
  name: ['Employee Name', 'Employee', 'Name'],
  distance: ['YTD Distance (KM)', 'YTD Distance KM', 'YTD KM', 'Distance (KM)', 'YTD Distance'],
  paidRate: ['Most Recent Paid Rate', 'Paid Rate', 'Rate'],
  amount: ['Total Approved Amount (CAD)', 'Total Approved Amount', 'Approved Amount'],
  claimDate: ['Most Recent Claim Date', 'Last Claim Date', 'Claim Date'],
} as const;

type Field = keyof typeof COLUMNS;

/** How far down to look for the header before giving up. */
const MAX_HEADER_SCAN = 30;

/**
 * The header row: the first one carrying BOTH a name column and a kilometre column.
 * Two labels, because a title or a totals strip can carry one of them by accident.
 */
export function findMileageHeader(grid: string[][]): {
  row: number;
  columns: Partial<Record<Field, number>>;
} | null {
  const limit = Math.min(grid.length, MAX_HEADER_SCAN);
  for (let r = 0; r < limit; r++) {
    const keys = grid[r].map(headerKey);
    const columns: Partial<Record<Field, number>> = {};
    for (const field of Object.keys(COLUMNS) as Field[]) {
      for (const alias of COLUMNS[field]) {
        const at = keys.indexOf(headerKey(alias));
        if (at >= 0) {
          columns[field] = at;
          break;
        }
      }
    }
    if (columns.name !== undefined && columns.distance !== undefined) return { row: r, columns };
  }
  return null;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const pad = (n: number) => String(n).padStart(2, '0');

function isoDate(y: number, m: number, d: number): string | null {
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
    return null;
  }
  return `${y}-${pad(m)}-${pad(d)}`;
}

/** Every date written in a piece of text, in order: "Oct 15, 2026", "15 Oct 2026", ISO. */
export function datesIn(text: string): string[] {
  const found: { at: number; iso: string }[] = [];
  const named = /\b([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})\b/g;
  for (const m of text.matchAll(named)) {
    const month = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase()) + 1;
    const iso = month > 0 ? isoDate(Number(m[3]), month, Number(m[2])) : null;
    if (iso) found.push({ at: m.index ?? 0, iso });
  }
  const dayFirst = /\b(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})\b/g;
  for (const m of text.matchAll(dayFirst)) {
    const month = MONTHS.indexOf(m[2].slice(0, 3).toLowerCase()) + 1;
    const iso = month > 0 ? isoDate(Number(m[3]), month, Number(m[1])) : null;
    if (iso) found.push({ at: m.index ?? 0, iso });
  }
  for (const m of text.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) {
    const iso = isoDate(Number(m[1]), Number(m[2]), Number(m[3]));
    if (iso) found.push({ at: m.index ?? 0, iso });
  }
  return found.sort((a, b) => a.at - b.at).map((f) => f.iso);
}

/** The end of the "Period: <start> – <end> | …" line above the header, if there is one. */
export function periodEndFrom(grid: string[][], headerRow: number): string | null {
  for (const row of grid.slice(0, headerRow)) {
    for (const cell of row) {
      const m = /period\s*:\s*([^|]*)/i.exec(cell);
      if (!m) continue;
      const dates = datesIn(m[1]);
      if (dates.length > 0) return dates[dates.length - 1];
    }
  }
  return null;
}

/** A claim date cell: ISO text, a written date, or an Excel serial day number. */
export function claimDateOf(raw: string): string | null {
  const v = raw.trim();
  if (!v) return null;
  if (/^\d+(\.\d+)?$/.test(v)) {
    // Excel's day zero is 1899-12-30 (it counts the 1900 leap day that never was).
    const days = Math.floor(Number(v));
    if (days < 1 || days > 2_958_465) return null;
    return new Date(Date.UTC(1899, 11, 30) + days * 86_400_000).toISOString().slice(0, 10);
  }
  return datesIn(v)[0] ?? null;
}

/** A non-negative number rounded to `places`, as the decimal string the server takes. */
function decimal(raw: string, places: number): string | null {
  const v = raw.trim().replace(/[$,\s]/g, '');
  if (!v) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  // Through Number again so 0.6699999999999999 → "0.67", not "0.6700".
  return String(Number(n.toFixed(places)));
}

/** Rows that are not a person: the grand total, a subtotal. */
const TOTAL_ROW = /^(grand\s+)?(sub)?totals?\b/i;

/** Parse a grid already read off the sheet. Pure, so it is testable without a workbook. */
export function parseMileageGrid(grid: string[][]): MileageBalanceParseResult {
  const header = findMileageHeader(grid);
  if (!header) return { rows: [], periodEnd: null, error: 'noHeader' };
  const { columns } = header;
  const cell = (row: string[], field: Field) => {
    const at = columns[field];
    return at === undefined ? '' : (row[at] ?? '').trim();
  };

  const rows: MileageBalanceRow[] = [];
  for (const row of grid.slice(header.row + 1)) {
    const name = cell(row, 'name');
    if (!name || TOTAL_ROW.test(name)) continue;
    const distanceRaw = decimal(cell(row, 'distance'), 2);
    // A person with no distance has nothing to carry over.
    if (distanceRaw === null) continue;
    rows.push({
      name,
      distance: Number(distanceRaw).toFixed(2),
      paidRate: decimal(cell(row, 'paidRate'), 4),
      amount: (() => {
        const a = decimal(cell(row, 'amount'), 2);
        return a === null ? null : Number(a).toFixed(2);
      })(),
      claimDate: claimDateOf(cell(row, 'claimDate')),
    });
  }

  const latestClaim = rows
    .map((r) => r.claimDate)
    .filter((d): d is string => d !== null)
    .sort()
    .at(-1);
  const periodEnd = periodEndFrom(grid, header.row) ?? latestClaim ?? null;
  return { rows, periodEnd, error: rows.length === 0 ? 'noRows' : null };
}

/** Unzip, read and parse in one call — the browser entry point. */
export function parseMileageBalances(bytes: Uint8Array): MileageBalanceParseResult {
  const grid = readWorkbookGrid(bytes);
  if (!grid) return { rows: [], periodEnd: null, error: 'noSheet' };
  return parseMileageGrid(grid);
}
