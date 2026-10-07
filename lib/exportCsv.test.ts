import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildCsv, buildSectionedCsv, downloadCsv, type ReportSection } from './exportCsv';

describe('buildCsv', () => {
  it('joins headers + rows with CRLF', () => {
    const csv = buildCsv(
      ['A', 'B'],
      [
        ['1', '2'],
        ['3', '4'],
      ],
    );
    expect(csv).toBe('A,B\r\n1,2\r\n3,4');
  });

  it('quotes fields containing comma, quote, or newline (RFC-4180)', () => {
    const csv = buildCsv(
      ['name', 'note'],
      [
        ['Doe, John', 'a "quote"'],
        ['multi', 'line\nbreak'],
      ],
    );
    expect(csv).toBe('name,note\r\n"Doe, John","a ""quote"""\r\nmulti,"line\nbreak"');
  });

  it('renders null/undefined as empty and stringifies numbers/booleans', () => {
    const csv = buildCsv(['a', 'b', 'c', 'd'], [[null, undefined, 42, true]]);
    expect(csv).toBe('a,b,c,d\r\n,,42,true');
  });
});

const SECTIONS: ReportSection[] = [
  {
    heading: 'Summary',
    headers: ['Metric', 'Amount'],
    rows: [
      ['Total spend', '$5,000.00'],
      ['Transactions', 3],
    ],
  },
  {
    heading: 'Source',
    headers: ['Source', 'Amount', 'Transactions'],
    rows: [['Credit cards', '$1,500.00', 1]],
  },
];

describe('buildSectionedCsv', () => {
  it('labels each block and separates them with a blank line', () => {
    const csv = buildSectionedCsv(SECTIONS);
    // A blank line is what Excel and Sheets both read as the end of a range.
    expect(csv).toBe(
      [
        'Summary',
        'Metric,Amount',
        'Total spend,"$5,000.00"',
        'Transactions,3',
        '',
        'Source',
        'Source,Amount,Transactions',
        'Credit cards,"$1,500.00",1',
      ].join('\r\n'),
    );
  });

  it('lets sections keep different column counts', () => {
    // Deliberately ragged: padding to the widest section is what looks corrupt.
    const widths = buildSectionedCsv(SECTIONS)
      .split('\r\n')
      .filter((l) => l.includes(','))
      .map((l) => l.split(',').length);
    expect(new Set(widths).size).toBeGreaterThan(1);
  });

  it('quotes a heading that contains a comma', () => {
    const csv = buildSectionedCsv([
      { heading: 'Spend, by month', headers: ['Month'], rows: [['2026-03']] },
    ]);
    expect(csv.startsWith('"Spend, by month"')).toBe(true);
  });

  it('renders an empty section as a heading and headers alone', () => {
    // A breakdown with no rows is a fact ("nothing in this period"), not a bug.
    expect(buildSectionedCsv([{ heading: 'Cards', headers: ['Source'], rows: [] }])).toBe(
      'Cards\r\nSource',
    );
  });
});

// ── Handing the file to the browser ───────────────────────────────────────────

describe('downloading', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function capture() {
    const anchor = document.createElement('a');
    anchor.click = vi.fn();
    vi.spyOn(document, 'createElement').mockReturnValue(anchor);
    const blobs: Blob[] = [];
    vi.stubGlobal('URL', {
      createObjectURL: (b: Blob) => {
        blobs.push(b);
        return 'blob:x';
      },
      revokeObjectURL: vi.fn(),
    });
    return { anchor, blobs };
  }

  it('adds the extension when the caller left it off', () => {
    const { anchor } = capture();
    downloadCsv('transactions', 'a,b');
    expect(anchor.download).toBe('transactions.csv');
  });

  it('does not double the extension when the caller included it', () => {
    /** `transactions.csv.csv` is the kind of detail that makes an export look untested. */
    const { anchor } = capture();
    downloadCsv('transactions.CSV', 'a,b');
    expect(anchor.download).toBe('transactions.CSV');
  });

  it('prepends a BOM so Excel reads accented FR-CA text correctly', () => {
    /**
     * Without it, Excel on Windows guesses the codepage and "Dépôt" opens as "DÃ©pÃ´t" —
     * on a bilingual product that is half the exports.
     */
    const { blobs } = capture();
    downloadCsv('x', 'Dépôt');
    // The BOM is a separate part, so the blob is longer than the CSV's own bytes.
    expect(blobs[0].size).toBeGreaterThan(new TextEncoder().encode('Dépôt').length);
    expect(blobs[0].type).toContain('text/csv');
  });

  it('cleans up the anchor it added to the document', () => {
    const { anchor } = capture();
    downloadCsv('x', 'a');
    expect(anchor.isConnected).toBe(false);
  });
});
