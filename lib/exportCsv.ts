/**
 * Client-side CSV export for data tables.
 *
 * RFC-4180 quoting: a field is wrapped in double quotes when it contains
 * a comma, quote, CR, or LF, and embedded quotes are doubled. A leading
 * UTF-8 BOM is prepended so Excel opens accented (FR-CA) text correctly.
 */

/** Serialize one cell value to a CSV field. */
function csvField(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return '';
  const s = String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Build a CSV document from a header row + data rows (already reduced to
 *  primitive cell values). Rows are newline-joined with CRLF per RFC-4180. */
export function buildCsv(
  headers: readonly string[],
  rows: readonly (readonly (string | number | boolean | null | undefined)[])[],
): string {
  const lines = [headers, ...rows].map((cells) => cells.map(csvField).join(','));
  return lines.join('\r\n');
}

/** Trigger a browser download of `csv` as `<filename>.csv`. No-op on the
 *  server (guards `document`). */
export function downloadCsv(filename: string, csv: string): void {
  if (typeof document === 'undefined') return;
  const blob = new Blob(['﻿', csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename.toLowerCase().endsWith('.csv') ? filename : `${filename}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/**
 * One block of a sectioned export: a heading, a header row, and its rows.
 *
 * A dashboard is not one table. Exporting it as a single flat sheet would mean
 * inventing a column set that fits KPIs, a month series and five breakdowns at
 * once — which fits none of them.
 */
export interface ReportSection {
  heading: string;
  headers: readonly string[];
  rows: readonly (readonly (string | number | boolean | null | undefined)[])[];
}

/**
 * Build a CSV holding several labelled blocks, one after another.
 *
 * Not valid single-table CSV, deliberately: the sections have different column
 * counts, and every spreadsheet handles that by leaving the short rows short. The
 * alternative — padding everything to the widest section — produces a sheet full of
 * empty columns that reads as corrupt. A blank line separates blocks, which is what
 * Excel and Sheets both use to end a range.
 */
export function buildSectionedCsv(sections: readonly ReportSection[]): string {
  const blocks = sections.map((s) => [
    csvField(s.heading),
    ...[s.headers, ...s.rows].map((cells) => cells.map(csvField).join(',')),
  ]);
  return blocks.map((b) => b.join('\r\n')).join('\r\n\r\n');
}
