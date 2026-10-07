import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ColumnDef, DataTableState } from './DataTable';
import { TableExportMenu } from './TableExportMenu';

/**
 * The table download. Three formats, one column-selection rule, and one distinction
 * that is the whole reason the Excel branch exists.
 *
 * The selection rule: a column is exported only if it declares `exportValue`. `cell`
 * returns JSX and cannot be stringified, so a column without an accessor would land
 * in the file as `[object Object]` — omitting it is the honest outcome, and it is why
 * the kebab-menu column never appears in a download.
 *
 * The Excel distinction: a cell gets a raw number or date where the column can supply
 * one, so the column is summable and pivotable in the spreadsheet. Exporting `"$1,234.56"`
 * as text produces a column somebody has to re-type before they can total it.
 */

const h = vi.hoisted(() => ({
  buildCsv: vi.fn((..._a: unknown[]) => 'csv-text'),
  downloadCsv: vi.fn(),
  downloadXlsx: vi.fn(),
  printTable: vi.fn(),
}));

vi.mock('@/lib/exportCsv', () => ({ buildCsv: h.buildCsv, downloadCsv: h.downloadCsv }));
vi.mock('@/lib/exportTable', () => ({
  downloadXlsx: h.downloadXlsx,
  printTable: h.printTable,
}));
vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
}));

type Row = { id: string; name: string; amount: number; when: Date };
type Col = 'name' | 'amount' | 'when' | 'actions';

const ROWS: Row[] = [
  { id: 'a', name: 'Ada', amount: 1234.56, when: new Date('2026-08-01T00:00:00Z') },
  { id: 'b', name: 'Grace', amount: 0, when: new Date('2026-08-02T00:00:00Z') },
];

const COLUMNS: ColumnDef<Row, Col>[] = [
  { id: 'name', label: 'Name', cell: (r) => r.name, exportValue: (r) => r.name },
  {
    id: 'amount',
    label: 'Amount',
    cell: (r) => `$${r.amount.toFixed(2)}`,
    exportValue: (r) => `$${r.amount.toFixed(2)}`,
    exportNumber: (r) => r.amount,
  },
  {
    id: 'when',
    label: 'When',
    cell: (r) => r.when.toISOString(),
    exportValue: (r) => r.when.toISOString(),
    exportDate: (r) => r.when,
  },
  // No `exportValue` — the kebab column. Must never reach the file.
  { id: 'actions', label: 'Actions', cell: () => <button type="button">…</button> },
];

const state = (over: Partial<DataTableState<Col>> = {}): DataTableState<Col> =>
  ({
    columnOrder: ['name', 'amount', 'when', 'actions'],
    columnVisibility: {},
    columnWidths: {},
    density: 'normal',
    filters: [],
    sort: null,
    selectedIds: new Set<string>(),
    groupBy: null,
    ...over,
  }) as DataTableState<Col>;

async function exportAs(format: 'CSV' | 'Excel' | 'PDF', props: Record<string, unknown> = {}) {
  const user = userEvent.setup();
  render(
    <TableExportMenu<Row, Col>
      columns={COLUMNS}
      rows={ROWS}
      filename="business-units"
      state={state()}
      {...props}
    />,
  );
  await user.click(screen.getByRole('button', { name: /trigger/i }));
  await user.click(await screen.findByText(format));
}

beforeEach(() => {
  vi.clearAllMocks();
  h.buildCsv.mockReturnValue('csv-text');
});

describe('<TableExportMenu>', () => {
  it('offers every format enabled — none of them is "coming soon" any more', async () => {
    // The page-level stub this replaced rendered all three disabled.
    const user = userEvent.setup();
    render(<TableExportMenu<Row, Col> columns={COLUMNS} rows={ROWS} filename="f" />);
    await user.click(screen.getByRole('button', { name: /trigger/i }));
    for (const fmt of ['CSV', 'Excel', 'PDF']) {
      expect(await screen.findByText(fmt)).toBeInTheDocument();
    }
    expect(screen.queryByText('comingSoon')).not.toBeInTheDocument();
  });

  it('downloads CSV under the given filename', async () => {
    await exportAs('CSV');
    expect(h.downloadCsv).toHaveBeenCalledWith('business-units', 'csv-text');
  });

  it('exports only the columns that declare an accessor', async () => {
    /**
     * `cell` returns JSX. A column without `exportValue` has nothing stringifiable, so
     * including it would write `[object Object]` into somebody's spreadsheet.
     */
    await exportAs('CSV');
    const [headers, data] = h.buildCsv.mock.calls[0] as [string[], unknown[][]];
    expect(headers).toEqual(['Name', 'Amount', 'When']);
    expect(data[0]).toHaveLength(3);
  });

  it('honours the user’s column order', async () => {
    // What they exported should match what they were looking at.
    await exportAs('CSV', { state: state({ columnOrder: ['amount', 'name', 'when', 'actions'] }) });
    expect(h.buildCsv.mock.calls[0][0]).toEqual(['Amount', 'Name', 'When']);
  });

  it('omits a column the user hid', async () => {
    await exportAs('CSV', { state: state({ columnVisibility: { amount: false } as never }) });
    expect(h.buildCsv.mock.calls[0][0]).toEqual(['Name', 'When']);
  });

  it('includes every export-capable column when there is no table state', async () => {
    // `columnVisibility` is sparse — an id absent from it is visible, not hidden.
    const user = userEvent.setup();
    render(<TableExportMenu<Row, Col> columns={COLUMNS} rows={ROWS} filename="f" />);
    await user.click(screen.getByRole('button', { name: /trigger/i }));
    await user.click(await screen.findByText('CSV'));
    expect(h.buildCsv.mock.calls[0][0]).toEqual(['Name', 'Amount', 'When']);
  });

  it('drops a stale id in the order that no longer matches a column', async () => {
    await exportAs('CSV', {
      state: state({ columnOrder: ['name', 'gone' as Col, 'amount'] }),
    });
    expect(h.buildCsv.mock.calls[0][0]).toEqual(['Name', 'Amount']);
  });

  it('gives Excel raw numbers and dates so the columns are summable', async () => {
    await exportAs('Excel');
    const [filename, headers, cells] = h.downloadXlsx.mock.calls[0];
    expect(filename).toBe('business-units');
    expect(headers).toEqual(['Name', 'Amount', 'When']);
    expect(cells[0][0]).toBe('Ada'); // no numeric accessor → text
    expect(cells[0][1]).toEqual({ num: 1234.56 }); // not "$1,234.56"
    expect(cells[0][2]).toEqual({ date: ROWS[0].when });
  });

  it('exports a zero as a number, not as an empty cell', async () => {
    // `exportNumber` returning 0 is falsy; treating it as absent would blank the cell
    // and break the column total.
    await exportAs('Excel');
    expect(h.downloadXlsx.mock.calls[0][2][1][1]).toEqual({ num: 0 });
  });

  it('opens a print view for PDF rather than shipping a PDF library', async () => {
    /**
     * The browser's Print → Save as PDF produces the file. Same approach as the
     * printable expense report, and it needs no server round-trip.
     */
    await exportAs('PDF');
    const [title, headers, text] = h.printTable.mock.calls[0];
    expect(title).toBe('business-units'); // falls back to the filename
    expect(headers).toEqual(['Name', 'Amount', 'When']);
    // The print view wants strings, so the money column keeps its formatting here.
    expect(text[0][1]).toBe('$1234.56');
  });

  it('titles the print view when given one', async () => {
    await exportAs('PDF', { title: 'Business Units' });
    expect(h.printTable.mock.calls[0][0]).toBe('Business Units');
  });
});
