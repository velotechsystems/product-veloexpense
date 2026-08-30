/**
 * VX3-1 — minimal CSV parser for the chart-of-accounts format.
 *
 * PORTED VERBATIM from `product-veloledger/lib/accounts/csv.ts`, deliberately:
 * a tenant that exports a chart out of VeloLedger and imports it here should not
 * discover that the two products disagree about quoting. Same reason the account
 * numbers in `0014` are VeloLedger's numbers.
 *
 * An RFC 4180 subset, and no new dependency — comma-separated fields,
 * double-quoted fields may contain commas and escaped quotes (`""`), newlines end
 * rows. Not a general CSV library and not trying to be.
 *
 * One inherited behaviour worth knowing: fields are trimmed AFTER unquoting, so
 * `"  padded  "` arrives as `padded`. For account numbers and names that is what
 * you want; if this file is ever reused for something where leading space is
 * data, that is the line to change.
 */

export interface CsvRow {
  /** 1-indexed, counting the header as line 1, so errors can name a line. */
  lineNumber: number;
  fields: Record<string, string>;
}

export interface ParsedCsv {
  headers: string[];
  rows: CsvRow[];
}

export function parseCsv(input: string): ParsedCsv {
  const lines = splitLines(input);
  if (lines.length === 0) throw new Error('CSV is empty');
  const headers = splitFields(lines[0]);
  if (headers.length === 0) throw new Error('CSV has no header row');

  const rows: CsvRow[] = [];
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === '') continue; // blank lines are not rows
    const values = splitFields(line);
    const fields: Record<string, string> = {};
    for (let j = 0; j < headers.length; j += 1) {
      fields[headers[j]] = values[j] ?? '';
    }
    rows.push({ lineNumber: i + 1, fields });
  }
  return { headers, rows };
}

/** Split into rows, respecting quoted fields that could span newlines. */
function splitLines(input: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (ch === '"') {
      if (inQuotes && input[i + 1] === '"') {
        // Escaped double-quote: keep both here, `splitFields` collapses them.
        current += '""';
        i += 1;
      } else {
        inQuotes = !inQuotes;
        current += ch;
      }
    } else if ((ch === '\n' || ch === '\r') && !inQuotes) {
      if (ch === '\r' && input[i + 1] === '\n') i += 1; // \r\n is one break
      result.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.length > 0) result.push(current);
  return result;
}

/** Split one line into field values, respecting quoted fields. */
function splitFields(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      fields.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields.map((f) => f.trim());
}
