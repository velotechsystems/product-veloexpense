/**
 * Table exports beyond CSV — Excel (.xlsx) and print-to-PDF.
 *
 * Neither adds a dependency:
 *
 *   - **Excel** is a real `.xlsx` written with `fflate`, which the app already
 *     ships (the VCC bulk import unzips one to READ it; this is the same trick
 *     in the write direction). A renamed CSV is not an option — Excel warns on
 *     open and mangles anything that looks like a date.
 *   - **PDF** is the browser's Print → Save as PDF, matching how the printable
 *     expense report works (#130). A server-side generator would mean a
 *     headless browser in the worker image for something the browser already
 *     does well.
 *
 * CSV and the print view use the values the table already computed, so they
 * read exactly like the screen. Excel does NOT: a column that can supply a raw
 * number or date emits a real typed cell, because `"1,500.00"` as text cannot
 * be summed, pivoted or charted — which is most of the reason anyone exports
 * to a spreadsheet. Formatting isn't lost: the workbook carries number formats
 * so the cell still displays as currency or a date, while holding a value
 * Excel can compute on.
 */

import { strToU8, zipSync } from 'fflate';

/**
 * One spreadsheet cell. A bare string is text; the wrappers request a typed
 * cell so Excel treats the value as a number or a date rather than a label.
 */
export type XlsxCell = string | { num: number } | { date: Date };

/** Style indices into the `cellXfs` table written in `stylesXml`. */
const STYLE_TEXT = 0;
const STYLE_NUMBER = 1;
const STYLE_DATE = 2;

/**
 * Excel's serial date: days since 1899-12-30, using the UTC clock so a
 * timezone west of GMT can't shift a date back a day. (The legacy Concur
 * importer used the inverse of this constant — see docs/legacy/data-model.md
 * §4.15.)
 */
function excelSerial(d: Date): number {
  return d.getTime() / 86_400_000 + 25569;
}

/** XML-escape a cell value. `&` first, or it double-escapes the others. */
function esc(v: string): string {
  return v
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** 0-based column index → spreadsheet column letters (0→A, 26→AA). */
function colName(i: number): string {
  let n = i;
  let out = '';
  do {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}

/** Strip characters Excel rejects in a sheet name, and cap at its 31-char limit. */
function safeSheetName(name: string): string {
  const cleaned = name.replace(/[\\/?*[\]:]/g, ' ').trim();
  return (cleaned || 'Sheet1').slice(0, 31);
}

/** Render one cell, typed by its wrapper. */
function cellXml(ref: string, cell: XlsxCell): string {
  if (typeof cell !== 'string') {
    if ('num' in cell) {
      // No `t` attribute = numeric. Non-finite would produce a corrupt file.
      if (!Number.isFinite(cell.num)) return `<c r="${ref}" s="${STYLE_TEXT}"/>`;
      return `<c r="${ref}" s="${STYLE_NUMBER}"><v>${cell.num}</v></c>`;
    }
    const t = cell.date.getTime();
    if (Number.isNaN(t)) return `<c r="${ref}" s="${STYLE_TEXT}"/>`;
    return `<c r="${ref}" s="${STYLE_DATE}"><v>${excelSerial(cell.date)}</v></c>`;
  }
  // inlineStr avoids needing a sharedStrings part for a one-shot export.
  return `<c r="${ref}" t="inlineStr" s="${STYLE_TEXT}"><is><t xml:space="preserve">${esc(cell)}</t></is></c>`;
}

function sheetXml(headers: string[], rows: XlsxCell[][]): string {
  const row = (cells: XlsxCell[], r: number) =>
    `<row r="${r}">${cells.map((c, i) => cellXml(`${colName(i)}${r}`, c)).join('')}</row>`;
  const body = [row(headers, 1), ...rows.map((r, i) => row(r, i + 2))].join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`;
}

/**
 * Minimal styles part: three cell formats, indexed by the STYLE_* constants.
 * Without it a numeric cell shows as `1500` and a date as `46085` — technically
 * correct values that nobody can read.
 */
function stylesXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="#,##0.00"/></numFmts><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="1"><fill><patternFill patternType="none"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs></styleSheet>`;
}

/** Build a minimal single-sheet .xlsx as bytes. */
export function buildXlsx(headers: string[], rows: XlsxCell[][], sheetName = 'Sheet1'): Uint8Array {
  const sheet = safeSheetName(sheetName);
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>',
    ),
    '_rels/.rels': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    ),
    'xl/workbook.xml': strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${esc(sheet)}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    ),
    'xl/_rels/workbook.xml.rels': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
    ),
    'xl/styles.xml': strToU8(stylesXml()),
    'xl/worksheets/sheet1.xml': strToU8(sheetXml(headers, rows)),
  };
  return zipSync(files, { level: 6 });
}

/** Build and download an .xlsx. */
export function downloadXlsx(
  filename: string,
  headers: string[],
  rows: XlsxCell[][],
  sheetName?: string,
): void {
  const bytes = buildXlsx(headers, rows, sheetName ?? filename);
  // Copy into a fresh ArrayBuffer: fflate may hand back a view onto a larger
  // pooled buffer, and Blob would then include the slack bytes.
  const blob = new Blob([bytes.slice().buffer as ArrayBuffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${filename}.xlsx`;
  a.click();
  URL.revokeObjectURL(url);
}

/** HTML-escape for the print document. */
function escHtml(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Open a print-optimized view of the table and trigger the print dialog, where
 * the user picks "Save as PDF". Returns false if the popup was blocked, so the
 * caller can tell them rather than appearing to do nothing.
 */
export function printTable(title: string, headers: string[], rows: string[][]): boolean {
  const win = window.open('', '_blank', 'width=1024,height=768');
  if (!win) return false;
  const thead = headers.map((h) => `<th>${escHtml(h)}</th>`).join('');
  const tbody = rows
    .map((r) => `<tr>${r.map((c) => `<td>${escHtml(c)}</td>`).join('')}</tr>`)
    .join('');
  win.document.write(
    `<!doctype html><html><head><meta charset="utf-8"><title>${escHtml(title)}</title><style>
      *{box-sizing:border-box}
      body{font:12px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif;color:#111;margin:24px}
      h1{font-size:16px;margin:0 0 12px}
      table{border-collapse:collapse;width:100%}
      th,td{border:1px solid #d4d4d4;padding:4px 6px;text-align:left;vertical-align:top}
      th{background:#f4f4f4;font-weight:600}
      tr{break-inside:avoid}
      thead{display:table-header-group}
      @page{margin:12mm}
    </style></head><body><h1>${escHtml(title)}</h1><table><thead><tr>${thead}</tr></thead><tbody>${tbody}</tbody></table></body></html>`,
  );
  win.document.close();
  win.focus();
  /**
   * Close the print window once the dialog is dismissed.
   *
   * Without this, every export leaves an orphaned tab behind — after a few the person is
   * hunting for the one they were reading. `onafterprint` fires on both Print and Cancel.
   *
   * NOTE on the "export hangs the tab" report (F33): `print()` opens a NATIVE MODAL, and
   * a native modal cannot be dismissed by a script. An automated driver therefore sees the
   * page stop responding until it gives up, which is what was observed. For a person it is
   * an ordinary print dialog. That part is not a defect and is not "fixed" here; what was
   * genuinely missing from that menu was Excel, which is now offered.
   */
  win.onafterprint = () => win.close();
  // Let layout settle before printing, or Safari prints a blank first page.
  // Close when the print is over — the same orphan, and the same reasoning, as `printReport`.
  win.onafterprint = () => win.close();
  win.setTimeout(() => win.print(), 250);
  return true;
}

/**
 * Print a report made of several labelled tables — the PDF counterpart to
 * `buildSectionedCsv`.
 *
 * Same mechanism as `printTable` (browser Print → Save as PDF, no headless browser
 * in the worker image for something the browser does well), but a dashboard is not
 * one table: its KPIs, month series and breakdowns each have their own columns.
 *
 * `break-inside: avoid` on each section so a five-row breakdown is not split across
 * a page boundary, which is the one thing that makes an exported summary look
 * careless.
 */
export function printReport(
  title: string,
  sections: readonly { heading: string; headers: readonly string[]; rows: readonly string[][] }[],
  subtitle?: string,
): boolean {
  const win = window.open('', '_blank', 'width=1024,height=768');
  if (!win) return false;
  const block = (s: { heading: string; headers: readonly string[]; rows: readonly string[][] }) => {
    const thead = s.headers.map((h) => `<th>${escHtml(h)}</th>`).join('');
    const tbody = s.rows
      .map((r) => `<tr>${r.map((c) => `<td>${escHtml(c)}</td>`).join('')}</tr>`)
      .join('');
    return `<section><h2>${escHtml(s.heading)}</h2><table><thead><tr>${thead}</tr></thead><tbody>${tbody}</tbody></table></section>`;
  };
  win.document.write(
    `<!doctype html><html><head><meta charset="utf-8"><title>${escHtml(title)}</title><style>
      *{box-sizing:border-box}
      body{font:12px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif;color:#111;margin:24px}
      h1{font-size:16px;margin:0 0 2px}
      p.sub{color:#555;margin:0 0 16px;font-size:11px}
      section{break-inside:avoid;margin:0 0 18px}
      h2{font-size:13px;margin:0 0 6px}
      table{border-collapse:collapse;width:100%}
      th,td{border:1px solid #d4d4d4;padding:4px 6px;text-align:left;vertical-align:top}
      th{background:#f4f4f4;font-weight:600}
      tr{break-inside:avoid}
      thead{display:table-header-group}
      @page{margin:12mm}
    </style></head><body><h1>${escHtml(title)}</h1>${
      subtitle ? `<p class="sub">${escHtml(subtitle)}</p>` : ''
    }${sections.map(block).join('')}</body></html>`,
  );
  win.document.close();
  win.focus();

  /**
   * CLOSE THE WINDOW WHEN THE PRINT IS OVER.
   *
   * It used to open a tab, call `print()`, and leave it. The audit reported the tab
   * unresponsive for over 60 seconds and abandoned it (GA readiness report F33). The
   * unresponsiveness itself is not a defect — `print()` opens a NATIVE modal, and a native
   * modal cannot be dismissed by a script, so an automated driver sees a page that has stopped
   * responding until it gives up. What IS a defect is the orphan it leaves behind for a person:
   * they print, dismiss the dialog, and are left holding a stray tab of raw report markup with
   * no way back to where they were.
   *
   * `onafterprint` fires whether the dialog was accepted or cancelled, which is exactly the
   * moment the window has done its job.
   */
  win.onafterprint = () => win.close();

  // Let layout settle before printing, or Safari prints a blank first page.
  win.setTimeout(() => win.print(), 250);
  return true;
}
