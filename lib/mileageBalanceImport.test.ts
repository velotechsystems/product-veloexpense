import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import {
  claimDateOf,
  datesIn,
  parseMileageBalances,
  parseMileageGrid,
} from './mileageBalanceImport';

/**
 * The Concur year-to-date export, as the real one is laid out — a title, a "Period:"
 * line, a totals strip, then the table, a grand-total row and blank rows — built
 * synthetically. The real file carries people's names and is never used here.
 */

const HEADER = [
  'Employee Name',
  'YTD Distance (KM)',
  'YTD Distance (Miles)',
  'Most Recent Paid Rate',
  'Currency',
  'Most Recent Claim Date',
  'Total Approved Amount (CAD)',
];

type Cell = string | number | null;

const colLetter = (i: number) => String.fromCharCode(65 + i);
const esc = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * A minimal workbook. Strings are inline (`t="inlineStr"`) like the export, or shared
 * (`t="s"` + sharedStrings.xml) like the same file re-saved in Excel. Numbers are `<v>`.
 * `null` is a formula cell with no cached value — the export's totals.
 */
function buildXlsx(
  grid: Cell[][],
  opts: { shared?: boolean; sheetName?: string; startRow?: number } = {},
): Uint8Array {
  const shared: string[] = [];
  const start = opts.startRow ?? 1;
  const rowsXml = grid
    .map((row, r) => {
      const ref = r + start;
      const cells = row
        .map((v, c) => {
          const at = `${colLetter(c)}${ref}`;
          if (v === null) return `<c r="${at}"><f>SUM(B1:B2)</f><v></v></c>`;
          if (typeof v === 'number') return `<c r="${at}" t="n"><v>${v}</v></c>`;
          if (opts.shared) {
            shared.push(v);
            return `<c r="${at}" t="s"><v>${shared.length - 1}</v></c>`;
          }
          return `<c r="${at}" t="inlineStr"><is><t>${esc(v)}</t></is></c>`;
        })
        .join('');
      return `<row r="${ref}">${cells}</row>`;
    })
    .join('');
  const ns = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  const files: Record<string, Uint8Array> = {
    [`xl/worksheets/${opts.sheetName ?? 'sheet1'}.xml`]: strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="${ns}"><sheetData>${rowsXml}</sheetData></worksheet>`,
    ),
  };
  if (opts.shared) {
    const si = shared.map((s) => `<si><t>${esc(s)}</t></si>`).join('');
    files['xl/sharedStrings.xml'] = strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><sst xmlns="${ns}">${si}</sst>`,
    );
  }
  return zipSync(files);
}

const EXPORT: Cell[][] = [
  ['EXCESSIVE PERSONAL CAR MILEAGE - YTD SUMMARY'],
  ['Period: Jan 1, 2026 – Oct 15, 2026 | Comprehensive YTD Employee Mileage & Paid Rates'],
  [],
  ['Total Active Employees', '', 'Total Distance Travelled'],
  [null, '', null],
  [],
  HEADER,
  ['Doe, Jane', 6123.456, null, 0.6699999999999999, 'CAD', '2026-10-14', 4102.71],
  ['Roe, Richard Q', 1200, null, 0.73, 'CAD', '2026-09-02', 876],
  ['Grand Total', null, null, '', '', '', null],
  ['', '', '', '', '', '', ''],
  [],
];

describe('parseMileageBalances (.xlsx)', () => {
  it('finds the table under the title block and reads every person', () => {
    const res = parseMileageBalances(buildXlsx(EXPORT));
    expect(res.error).toBeNull();
    expect(res.rows).toEqual([
      {
        name: 'Doe, Jane',
        distance: '6123.46',
        paidRate: '0.67',
        amount: '4102.71',
        claimDate: '2026-10-14',
      },
      {
        name: 'Roe, Richard Q',
        distance: '1200.00',
        paidRate: '0.73',
        amount: '876.00',
        claimDate: '2026-09-02',
      },
    ]);
  });

  it('reads the period end from the "Period:" line', () => {
    expect(parseMileageBalances(buildXlsx(EXPORT)).periodEnd).toBe('2026-10-15');
  });

  it('falls back to the latest claim date when there is no period line', () => {
    const grid = EXPORT.filter((r) => !String(r[0] ?? '').startsWith('Period'));
    expect(parseMileageBalances(buildXlsx(grid)).periodEnd).toBe('2026-10-14');
  });

  it('reads shared strings as well as inline ones', () => {
    const res = parseMileageBalances(buildXlsx(EXPORT, { shared: true, startRow: 3 }));
    expect(res.rows.map((r) => r.name)).toEqual(['Doe, Jane', 'Roe, Richard Q']);
    expect(res.periodEnd).toBe('2026-10-15');
  });

  it('reads the first worksheet when it is not called sheet1', () => {
    const res = parseMileageBalances(buildXlsx(EXPORT, { sheetName: 'sheet3' }));
    expect(res.rows).toHaveLength(2);
  });

  it('reports a workbook with no worksheet', () => {
    const bytes = zipSync({ '[Content_Types].xml': strToU8('<Types/>') });
    expect(parseMileageBalances(bytes)).toEqual({ rows: [], periodEnd: null, error: 'noSheet' });
  });

  it('reports a sheet without the mileage header', () => {
    const res = parseMileageBalances(
      buildXlsx([
        ['Name', 'Email'],
        ['Doe, Jane', 'j@e.inc'],
      ]),
    );
    expect(res.error).toBe('noHeader');
  });

  it('reports a table with nobody in it', () => {
    const res = parseMileageBalances(buildXlsx([HEADER, ['Grand Total', null]]));
    expect(res.error).toBe('noRows');
    expect(res.periodEnd).toBeNull();
  });
});

describe('parseMileageGrid', () => {
  it('finds columns by label, whatever their order and spelling', () => {
    const res = parseMileageGrid([
      ['ytd_distance_km', 'Rate', 'employee'],
      ['1,234.5', '$0.72', 'Doe, Jane'],
    ]);
    expect(res.rows).toEqual([
      { name: 'Doe, Jane', distance: '1234.50', paidRate: '0.72', amount: null, claimDate: null },
    ]);
  });

  it('skips rows without a usable distance, and subtotals', () => {
    const res = parseMileageGrid([
      ['Employee Name', 'YTD Distance (KM)'],
      ['Doe, Jane', ''],
      ['Roe, Richard', 'n/a'],
      ['Poe, Edgar', '-5'],
      ['Subtotal', '99'],
      ['Moe, Mary', '0'],
    ]);
    expect(res.rows.map((r) => r.name)).toEqual(['Moe, Mary']);
  });
});

describe('dates', () => {
  it('reads written and ISO dates in order', () => {
    expect(datesIn('Jan 1, 2026 – Oct 15, 2026')).toEqual(['2026-01-01', '2026-10-15']);
    expect(datesIn('1 January 2026 to 15 Sept. 2026')).toEqual(['2026-01-01', '2026-09-15']);
    expect(datesIn('2026-01-01 - 2026-10-15')).toEqual(['2026-01-01', '2026-10-15']);
  });

  it('ignores impossible dates and unknown months', () => {
    expect(datesIn('Feb 30, 2026')).toEqual([]);
    expect(datesIn('Foo 3, 2026')).toEqual([]);
  });

  it('reads a claim date as text or as an Excel serial day', () => {
    expect(claimDateOf('2026-10-14')).toBe('2026-10-14');
    expect(claimDateOf('Oct 14, 2026')).toBe('2026-10-14');
    expect(claimDateOf('46309')).toBe('2026-10-14');
    expect(claimDateOf('')).toBeNull();
    expect(claimDateOf('0')).toBeNull();
    expect(claimDateOf('soon')).toBeNull();
  });
});
