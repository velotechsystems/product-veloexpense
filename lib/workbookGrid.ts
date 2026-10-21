/**
 * In-browser .xlsx reader shared by the spreadsheet importers.
 *
 * VeloExpense (eos batch 3): ExpenseOS keeps these functions in `cardProfileImport.ts`, the
 * virtual-card profile importer, and #589 exported `readWorkbookGrid` from there for
 * `mileageBalanceImport`. VeloExpense has no virtual cards, so the shared reader lives in its
 * own file. The code below is ExpenseOS's (67db2e33), unchanged.
 *
 * An .xlsx is a ZIP of XML: `fflate` unzips, the platform `DOMParser` reads the sheet, so the
 * file never leaves the browser.
 */

import { strFromU8, unzipSync } from 'fflate';

const XLSX_MAIN_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';

/** "B" → 1, "AA" → 26 (0-based column index from an A1-style cell ref). */
function columnIndex(cellRef: string): number {
  const letters = cellRef.match(/^[A-Z]+/)?.[0] ?? '';
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** Strip a UTF-8 BOM, normalize the non-breaking spaces the report pads cells
 *  with, and collapse runs of whitespace. */
function clean(v: string | undefined): string {
  return (v ?? '')
    .replace(/^\uFEFF/, '')
    .replace(/\u00A0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Read the shared-strings table (index → text). */
function readSharedStrings(xml: string): string[] {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const out: string[] = [];
  for (const si of Array.from(doc.getElementsByTagNameNS(XLSX_MAIN_NS, 'si'))) {
    let text = '';
    for (const t of Array.from(si.getElementsByTagNameNS(XLSX_MAIN_NS, 't'))) {
      text += t.textContent ?? '';
    }
    out.push(text);
  }
  return out;
}

/** Read one worksheet into a dense 2-D array of trimmed cell strings. */
function readSheet(xml: string, shared: string[]): string[][] {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const rows: string[][] = [];
  for (const row of Array.from(doc.getElementsByTagNameNS(XLSX_MAIN_NS, 'row'))) {
    const cells: Record<number, string> = {};
    let maxCol = -1;
    for (const c of Array.from(row.getElementsByTagNameNS(XLSX_MAIN_NS, 'c'))) {
      const ref = c.getAttribute('r');
      if (!ref) continue;
      const col = columnIndex(ref);
      const type = c.getAttribute('t');
      let value = '';
      if (type === 's') {
        // Shared string — <v> holds the table index.
        const vi = c.getElementsByTagNameNS(XLSX_MAIN_NS, 'v')[0]?.textContent;
        if (vi != null) value = shared[Number(vi)] ?? '';
      } else if (type === 'inlineStr') {
        const is = c.getElementsByTagNameNS(XLSX_MAIN_NS, 'is')[0];
        for (const t of Array.from(is?.getElementsByTagNameNS(XLSX_MAIN_NS, 't') ?? [])) {
          value += t.textContent ?? '';
        }
      } else {
        // Number / boolean / formula-cached / str — value is in <v> verbatim.
        value = c.getElementsByTagNameNS(XLSX_MAIN_NS, 'v')[0]?.textContent ?? '';
      }
      cells[col] = clean(value);
      if (col > maxCol) maxCol = col;
    }
    const dense: string[] = [];
    for (let i = 0; i <= maxCol; i++) dense.push(cells[i] ?? '');
    rows.push(dense);
  }
  return rows;
}

/**
 * Unzip a workbook and read its first worksheet into a dense grid of cleaned cell
 * strings. Shared and inline strings both resolve; numbers come back verbatim.
 * `null` when the archive holds no worksheet. Shared with the other in-browser
 * spreadsheet importers (`mileageBalanceImport`).
 */
export function readWorkbookGrid(bytes: Uint8Array): string[][] | null {
  const files = unzipSync(bytes);
  const sharedXml = files['xl/sharedStrings.xml'];
  const shared = sharedXml ? readSharedStrings(strFromU8(sharedXml)) : [];

  // Prefer sheet1, else the lexically-first worksheet part.
  const sheetPath =
    'xl/worksheets/sheet1.xml' in files
      ? 'xl/worksheets/sheet1.xml'
      : Object.keys(files)
          .filter((p) => /^xl\/worksheets\/sheet\d+\.xml$/.test(p))
          .sort()[0];
  if (!sheetPath) return null;
  return readSheet(strFromU8(files[sheetPath]), shared);
}

