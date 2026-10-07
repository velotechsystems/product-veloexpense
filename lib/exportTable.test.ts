import { strFromU8, unzipSync } from 'fflate';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildXlsx, downloadXlsx, printReport, printTable } from './exportTable';

/** Unzip the generated workbook so assertions read its real parts. */
function open(bytes: Uint8Array) {
  const files = unzipSync(bytes);
  return {
    names: Object.keys(files).sort(),
    part: (name: string) => strFromU8(files[name]),
  };
}

describe('buildXlsx', () => {
  const headers = ['Date', 'Employee', 'Amount'];
  const rows = [
    ['2026-03-04', 'Ada Lovelace', '1,500.00'],
    ['2026-03-05', 'Kati Birmingham', '250.00'],
  ];

  it('emits every part Excel needs to open the file', () => {
    // A renamed CSV is the tempting shortcut; Excel warns on open and mangles
    // anything date-shaped. This is a real OOXML package.
    const { names } = open(buildXlsx(headers, rows));
    expect(names).toEqual([
      '[Content_Types].xml',
      '_rels/.rels',
      'xl/_rels/workbook.xml.rels',
      'xl/styles.xml',
      'xl/workbook.xml',
      'xl/worksheets/sheet1.xml',
    ]);
  });

  it('writes the header row first, then one row per record', () => {
    const sheet = open(buildXlsx(headers, rows)).part('xl/worksheets/sheet1.xml');
    expect(sheet).toContain('<row r="1">');
    expect(sheet).toContain('<row r="2">');
    expect(sheet).toContain('<row r="3">');
    expect(sheet).not.toContain('<row r="4">');
    expect(sheet).toContain('Ada Lovelace');
    expect(sheet).toContain('1,500.00');
  });

  it('addresses cells with real spreadsheet references, past column Z', () => {
    const wide = Array.from({ length: 28 }, (_, i) => `col${i}`);
    const sheet = open(buildXlsx(wide, [wide])).part('xl/worksheets/sheet1.xml');
    expect(sheet).toContain('r="A1"');
    expect(sheet).toContain('r="Z1"');
    // 27th column is AA, not BA — the classic off-by-one in base-26 naming.
    expect(sheet).toContain('r="AA1"');
    expect(sheet).toContain('r="AB1"');
  });

  it('escapes XML so a stray & or < cannot corrupt the workbook', () => {
    const sheet = open(buildXlsx(['A & B'], [['<script>"x"</script>']])).part(
      'xl/worksheets/sheet1.xml',
    );
    expect(sheet).toContain('A &amp; B');
    expect(sheet).toContain('&lt;script&gt;');
    expect(sheet).not.toContain('<script>');
    // Escaping & first, or the others double-escape into &amp;lt;.
    expect(sheet).not.toContain('&amp;lt;');
  });

  it('preserves leading and trailing spaces in a cell', () => {
    const sheet = open(buildXlsx(['A'], [['  padded  ']])).part('xl/worksheets/sheet1.xml');
    expect(sheet).toContain('xml:space="preserve"');
    expect(sheet).toContain('  padded  ');
  });

  it('sanitizes the sheet name to what Excel accepts', () => {
    const book = open(buildXlsx(['A'], [['x']], 'expenses/2026:Q1[draft]')).part('xl/workbook.xml');
    // Only the sheet NAME is constrained — the rest of workbook.xml is full of
    // namespace URLs that legitimately contain / and :.
    const name = book.match(/<sheet name="([^"]*)"/)?.[1] ?? '';
    expect(name).not.toMatch(/[\\/?*[\]:]/);
    expect(name).toBe('expenses 2026 Q1 draft');
    const long = open(buildXlsx(['A'], [['x']], 'x'.repeat(60))).part('xl/workbook.xml');
    // Excel's hard limit is 31 characters.
    expect(long).toMatch(/name="x{31}"/);
  });

  it('writes a numeric cell Excel can sum, not a text label', () => {
    // "1,500.00" as text can't be summed or pivoted — the whole reason for
    // the Excel export over CSV.
    const sheet = open(buildXlsx(['Amount'], [[{ num: 1500.5 }]])).part('xl/worksheets/sheet1.xml');
    expect(sheet).toContain('<v>1500.5</v>');
    // No t="inlineStr" on the value cell, and it carries the number format.
    expect(sheet).not.toContain('t="inlineStr" s="1"');
    expect(sheet).toContain('s="1"');
  });

  it('writes a date as an Excel serial so pivots can group by month', () => {
    const sheet = open(
      buildXlsx(['Date'], [[{ date: new Date('2026-03-04T00:00:00.000Z') }]]),
    ).part('xl/worksheets/sheet1.xml');
    // 2026-03-04 → 46085 days since the 1899-12-30 epoch.
    expect(sheet).toContain('<v>46085</v>');
    expect(sheet).toContain('s="2"');
  });

  it('ships a styles part, or numbers and dates render as raw serials', () => {
    const { names, part } = open(buildXlsx(['A'], [[{ num: 1 }]]));
    expect(names).toContain('xl/styles.xml');
    const styles = part('xl/styles.xml');
    expect(styles).toContain('#,##0.00'); // currency-ish
    expect(styles).toContain('numFmtId="14"'); // short date
    // The relationship + content type must both point at it or Excel refuses
    // to open the workbook.
    expect(part('xl/_rels/workbook.xml.rels')).toContain('styles.xml');
    expect(part('[Content_Types].xml')).toContain('/xl/styles.xml');
  });

  it('degrades a NaN or Infinite number to an empty cell, never corrupt XML', () => {
    const sheet = open(
      buildXlsx(['A', 'B'], [[{ num: Number.NaN }, { num: Number.POSITIVE_INFINITY }]]),
    ).part('xl/worksheets/sheet1.xml');
    expect(sheet).not.toContain('NaN');
    expect(sheet).not.toContain('Infinity');
  });

  it('handles an empty result set without producing a broken sheet', () => {
    const sheet = open(buildXlsx(headers, [])).part('xl/worksheets/sheet1.xml');
    expect(sheet).toContain('<row r="1">');
    expect(sheet).not.toContain('<row r="2">');
  });
});

// ── Handing the file to the browser ───────────────────────────────────────────

/**
 * The download and print halves, which is where the bugs that reach people live: the
 * workbook can be perfect and still arrive as `undefined.xlsx`, or with a tail of slack
 * bytes that makes Excel refuse it.
 */
describe('downloading a workbook', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function captureDownload() {
    const anchor = {
      href: '',
      download: '',
      click: vi.fn(),
    } as unknown as HTMLAnchorElement;
    vi.spyOn(document, 'createElement').mockReturnValue(anchor);
    const blobs: Blob[] = [];
    const created = vi.fn((b: Blob) => {
      blobs.push(b);
      return 'blob:x';
    });
    const revoked = vi.fn();
    vi.stubGlobal('URL', { createObjectURL: created, revokeObjectURL: revoked });
    return { anchor, blobs, created, revoked };
  }

  it('names the file after what the caller asked for', () => {
    const { anchor } = captureDownload();
    downloadXlsx('card-transactions', ['A'], [['1']]);
    expect(anchor.download).toBe('card-transactions.xlsx');
    expect(anchor.href).toBe('blob:x');
  });

  it('hands over a spreadsheet MIME type, not a generic octet-stream', () => {
    /** It is what makes the browser and the OS open it in Excel rather than asking. */
    const { blobs } = captureDownload();
    downloadXlsx('x', ['A'], [['1']]);
    expect(blobs[0].type).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  });

  it('copies the bytes rather than passing fflate’s pooled view', () => {
    /**
     * `zipSync` may hand back a view onto a larger pooled buffer. Passing that view's
     * buffer straight to Blob appends the slack bytes, and Excel rejects the file — the
     * kind of failure that only shows up on some inputs.
     */
    const { blobs } = captureDownload();
    downloadXlsx('x', ['A'], [['1']]);
    const built = buildXlsx(['A'], [['1']], 'x');
    expect(blobs[0].size).toBe(built.length);
  });

  it('releases the object URL, so a page of exports does not leak blobs', () => {
    const { revoked } = captureDownload();
    downloadXlsx('x', ['A'], [['1']]);
    expect(revoked).toHaveBeenCalledWith('blob:x');
  });

  it('defaults the sheet name to the file name', () => {
    // A workbook whose tab reads "Sheet1" tells the reader nothing about what they opened.
    captureDownload();
    const bytes = buildXlsx(['A'], [['1']], 'Card transactions');
    expect(strFromU8(unzipSync(bytes)['xl/workbook.xml'])).toContain('Card transactions');
  });
});

describe('printing to PDF', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function fakeWindow() {
    const written: string[] = [];
    const win = {
      document: { write: (html: string) => written.push(html), close: vi.fn() },
      focus: vi.fn(),
      print: vi.fn(),
      close: vi.fn(),
      /** Assigned by `printReport`; the tests fire it to stand in for the browser. */
      onafterprint: null as null | (() => void),
      setTimeout: vi.fn((fn: () => void) => {
        fn();
        return 0;
      }),
    };
    vi.spyOn(window, 'open').mockReturnValue(win as unknown as Window);
    return { win, html: () => written.join('') };
  }

  it('writes the rows into a printable document and opens the dialog', () => {
    const { win, html } = fakeWindow();
    expect(printTable('Transactions', ['Merchant', 'Amount'], [['Acme', '$12.99']])).toBe(true);
    expect(html()).toContain('<th>Merchant</th>');
    expect(html()).toContain('<td>Acme</td>');
    expect(win.print).toHaveBeenCalled();
  });

  it('escapes HTML, so a merchant called "<script>" cannot inject markup', () => {
    /** The values come from the table, which got them from a bank feed. */
    const { html } = fakeWindow();
    printTable('T', ['M'], [['<script>alert(1)</script>']]);
    expect(html()).toContain('&lt;script&gt;');
    expect(html()).not.toContain('<script>alert');
  });

  it('escapes the title too', () => {
    const { html } = fakeWindow();
    printTable('Q1 <b>report</b>', ['M'], []);
    expect(html()).toContain('Q1 &lt;b&gt;report&lt;/b&gt;');
  });

  it('waits before printing, or Safari prints a blank first page', () => {
    const { win } = fakeWindow();
    printTable('T', ['M'], []);
    expect(win.setTimeout).toHaveBeenCalledWith(expect.any(Function), 250);
  });

  it('repeats the header row across pages', () => {
    /** A twelve-page export whose column headings appear once is unreadable from page two. */
    const { html } = fakeWindow();
    printTable('T', ['M'], []);
    expect(html()).toContain('display:table-header-group');
  });

  it('reports a blocked popup instead of appearing to do nothing', () => {
    /** The caller can then say so. Silence here reads as a broken button. */
    vi.spyOn(window, 'open').mockReturnValue(null);
    expect(printTable('T', ['M'], [])).toBe(false);
  });
});

describe('printing a sectioned report', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function fakeWindow() {
    const written: string[] = [];
    const win = {
      document: { write: (html: string) => written.push(html), close: vi.fn() },
      focus: vi.fn(),
      print: vi.fn(),
      close: vi.fn(),
      /** Assigned by the function under test; the tests fire it to stand in for the browser. */
      onafterprint: null as null | (() => void),
      setTimeout: vi.fn((fn: () => void) => {
        fn();
        return 0;
      }),
    };
    vi.spyOn(window, 'open').mockReturnValue(win as unknown as Window);
    return { win, html: () => written.join('') };
  }

  it('CLOSES the window when the print is over', () => {
    /**
     * It used to open a tab, call `print()`, and leave it. The audit reported the tab
     * unresponsive for over 60 seconds and abandoned it (GA readiness report F33).
     *
     * The unresponsiveness is not the defect — `print()` opens a NATIVE modal, and a native
     * modal cannot be dismissed by a script, so an automated driver sees a page that has
     * stopped responding until it gives up. The defect is the ORPHAN left behind for a person:
     * they print, dismiss the dialog, and are holding a stray tab of raw report markup with no
     * way back.
     */
    const { win } = fakeWindow();
    printReport('Q1', [{ heading: 'S', headers: ['A'], rows: [] }]);

    // Not closed before the dialog is done with — that would cancel the print.
    expect(win.close).not.toHaveBeenCalled();
    expect(win.onafterprint).toBeTypeOf('function');

    win.onafterprint?.();
    expect(win.close).toHaveBeenCalled();
  });

  it('closes on a CANCELLED print too, not only an accepted one', () => {
    // `onafterprint` fires either way, which is what makes it the right hook: somebody who
    // changes their mind is left with the same orphan otherwise.
    const { win } = fakeWindow();
    printReport('Q1', []);
    win.onafterprint?.();
    expect(win.close).toHaveBeenCalledTimes(1);
  });

  it('gives each block its own heading and columns', () => {
    /**
     * A dashboard is not one table: its KPIs, month series and breakdowns each have their
     * own columns, and flattening them into one column set fits none of them.
     */
    const { html } = fakeWindow();
    expect(
      printReport('Q1', [
        { heading: 'KPIs', headers: ['Metric', 'Value'], rows: [['Spend', '$1,200']] },
        { heading: 'By month', headers: ['Month', 'Total'], rows: [['Jan', '$400']] },
      ]),
    ).toBe(true);
    const out = html();
    expect(out).toContain('<h2>KPIs</h2>');
    expect(out).toContain('<h2>By month</h2>');
    expect(out).toContain('<th>Metric</th>');
    expect(out).toContain('<th>Month</th>');
  });

  it('keeps a short block from being split across a page boundary', () => {
    /** A five-row breakdown broken in half is the one thing that makes an exported summary
     *  look careless. */
    const { html } = fakeWindow();
    printReport('Q1', [{ heading: 'S', headers: ['A'], rows: [] }]);
    expect(html()).toContain('break-inside:avoid');
  });

  it('renders a subtitle when given one, and nothing when not', () => {
    const { html: withSub } = fakeWindow();
    printReport('Q1', [], 'Jan 1 – Mar 31');
    expect(withSub()).toContain('Jan 1 – Mar 31');
    vi.restoreAllMocks();
    const { html: without } = fakeWindow();
    printReport('Q1', []);
    expect(without()).not.toContain('class="sub"');
  });

  it('escapes headings and cells', () => {
    const { html } = fakeWindow();
    printReport('T', [{ heading: '<b>h</b>', headers: ['<i>c</i>'], rows: [['<u>v</u>']] }]);
    const out = html();
    expect(out).toContain('&lt;b&gt;h&lt;/b&gt;');
    expect(out).toContain('&lt;i&gt;c&lt;/i&gt;');
    expect(out).toContain('&lt;u&gt;v&lt;/u&gt;');
  });

  it('reports a blocked popup', () => {
    vi.spyOn(window, 'open').mockReturnValue(null);
    expect(printReport('T', [])).toBe(false);
  });
});
