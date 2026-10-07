'use client';

/**
 * TableExportMenu — a drop-in `ExportMenu` pre-wired to download the
 * current table as CSV. Replaces the per-page stub that rendered every
 * format disabled ("Coming soon").
 *
 * Every format is built from the columns that (a) are currently visible and
 * (b) declare an `exportValue` accessor, in the table's column order.
 * `cell` returns JSX and can't be stringified, so a column with no
 * `exportValue` is omitted from the download.
 *
 * CSV and Excel download; PDF opens a print view and lets the browser's
 * Print → Save as PDF produce the file (same approach as the printable expense
 * report). None of the three needs a server round-trip or a new dependency —
 * see lib/exportTable.
 */

import { ExportMenu } from '@expenseos/design-system';
import { useTranslations } from 'next-intl';
import { buildCsv, downloadCsv } from '@/lib/exportCsv';
import { downloadXlsx, printTable, type XlsxCell } from '@/lib/exportTable';
import type { ColumnDef, DataTableState } from './DataTable';

export type ExportFormat = 'CSV' | 'Excel' | 'PDF';
const FORMATS: readonly ExportFormat[] = ['CSV', 'Excel', 'PDF'];
const DISABLED: readonly ExportFormat[] = [];

export interface TableExportMenuProps<Row, ColumnId extends string> {
  /** Column defs — export uses each column's `exportValue`. */
  columns: ColumnDef<Row, ColumnId>[];
  /** The rows to export (already filtered/sorted as the user sees them). */
  rows: readonly Row[];
  /** Base filename (without extension). A `.csv` suffix is added. */
  filename: string;
  /** Table state, to honor column order + hidden columns. Optional —
   *  without it, all export-capable columns are included in declared order. */
  state?: DataTableState<ColumnId>;
  /** Localized trigger label ("Export"). */
  label?: string;
  /** Localized "Coming soon" hint for disabled formats. */
  disabledLabel?: string;
  /** Heading printed at the top of the PDF view. Defaults to `filename`. */
  title?: string;
}

export function TableExportMenu<Row, ColumnId extends string>({
  columns,
  rows,
  filename,
  state,
  label,
  disabledLabel,
  title,
}: TableExportMenuProps<Row, ColumnId>) {
  const t = useTranslations('table.export');
  const onExport = (format: ExportFormat) => {
    // Column order: the table state's order when present, else declared order.
    const order = state?.columnOrder ?? columns.map((c) => c.id);
    const byId = new Map(columns.map((c) => [c.id, c]));
    const cols = order
      .map((id) => byId.get(id))
      .filter((c): c is ColumnDef<Row, ColumnId> => {
        if (!c?.exportValue) return false;
        return state ? state.columnVisibility[c.id] !== false : true;
      });
    const headers = cols.map((c) => c.label);
    // `exportValue` may return a number/boolean; CSV stringifies internally,
    // the print view wants strings.
    const data = rows.map((r) => cols.map((c) => c.exportValue?.(r) ?? ''));
    const text = data.map((r) => r.map((v) => String(v)));
    if (format === 'CSV') {
      downloadCsv(filename, buildCsv(headers, data));
    } else if (format === 'Excel') {
      // Excel prefers a raw number/date when the column can supply one, so the
      // cell is summable and pivotable; otherwise it falls back to the text.
      const cells: XlsxCell[][] = rows.map((r) =>
        cols.map((c): XlsxCell => {
          const n = c.exportNumber?.(r);
          if (n !== null && n !== undefined) return { num: n };
          const d = c.exportDate?.(r);
          if (d) return { date: d };
          return String(c.exportValue?.(r) ?? '');
        }),
      );
      downloadXlsx(filename, headers, cells);
    } else {
      printTable(title ?? filename, headers, text);
    }
  };

  return (
    <ExportMenu<ExportFormat>
      formats={FORMATS}
      disabledFormats={DISABLED}
      onExport={onExport}
      label={label ?? t('trigger')}
      disabledLabel={disabledLabel ?? t('comingSoon')}
    />
  );
}
