/**
 * VX5-12 — the CSV writer, and the formula guard in particular.
 *
 * The quoting rules are RFC 4180 and are not interesting. The guard is, because
 * it is a trade: CSV avoids the typed-cell defect that upstream's Excel export
 * shipped, and pays for it with the fact that a spreadsheet EXECUTES some text.
 * Every assertion below is about where that guard's boundary sits, and the
 * important ones are the values it must NOT touch.
 */
import { describe, it, expect } from 'vitest';
import { csvField, csvRow, csvValue, needsGuard } from '@/lib/export/csv';

describe('RFC 4180 quoting', () => {
  it('leaves an ordinary value alone', () => {
    expect(csvField('Lunch with a client')).toBe('Lunch with a client');
  });

  it('quotes a comma, a quote and a newline', () => {
    expect(csvField('Taxi, airport')).toBe('"Taxi, airport"');
    expect(csvField('the "big" client')).toBe('"the ""big"" client"');
    expect(csvField('line one\nline two')).toBe('"line one\nline two"');
    expect(csvField('has\r\nCRLF')).toBe('"has\r\nCRLF"');
  });

  it('renders null and undefined as an empty field, not the word', () => {
    // `NULL` in a cell is a value somebody's import will read as the string.
    expect(csvField(null)).toBe('');
    expect(csvField(undefined)).toBe('');
  });

  it('ends a row with CRLF', () => {
    expect(csvRow(['a', 'b'])).toBe('a,b\r\n');
  });

  it('writes an empty row as a single empty field', () => {
    expect(csvRow([''])).toBe('\r\n');
  });
});

describe('the formula guard', () => {
  it('neutralises the characters a spreadsheet executes', () => {
    for (const value of ['=1+1', '=cmd|\' /C calc\'!A0', '+SUM(A1)', '@import', '\tsneaky']) {
      expect(needsGuard(value), value).toBe(true);
      expect(csvField(value).replace(/^"/, '').startsWith("'"), value).toBe(true);
    }
  });

  it('makes the decision on the FINAL text, so a guarded value is still quoted', () => {
    // A guarded value can still contain a comma. If the quote decision were made
    // before the apostrophe was added, this would be one unquoted field
    // containing a comma — a row with the wrong number of columns.
    expect(csvField('=A1,B1')).toBe('"\'=A1,B1"');
  });

  it('LEAVES NEGATIVE NUMBERS EXACT, which is the whole narrowing', () => {
    // The naive rule guards `= + - @`. `-` leads every negative amount in this
    // product, so the naive rule would corrupt every credit note in a legal
    // deliverable to defend against a formula that a number cannot be.
    for (const value of ['-1500', '-1500.00', '-0.01', '-1e6', '-.5']) {
      expect(needsGuard(value), value).toBe(false);
      expect(csvField(value), value).toBe(value);
    }
  });

  it('still guards a leading dash that is NOT a number', () => {
    for (const value of ['-1+1', '-cmd|x', '-- comment', '-A1']) {
      expect(needsGuard(value), value).toBe(true);
    }
  });

  it('leaves an empty value and ordinary text alone', () => {
    expect(needsGuard('')).toBe(false);
    expect(needsGuard('Lunch')).toBe(false);
    expect(needsGuard('1500.00')).toBe(false);
    // A dash INSIDE a value is not a leading character.
    expect(needsGuard('ACME-1500')).toBe(false);
    // Nor is an equals sign that is not first — descriptions contain these.
    expect(needsGuard('rate=1.386')).toBe(false);
  });
});

describe('rendering a database value', () => {
  it('keeps bigint precision, which every money column depends on', () => {
    // Money is minor units as bigint. `Number(v)` loses precision above 2^53,
    // and the loss is silent and in the least significant digits — i.e. in the
    // cents of the largest amounts.
    expect(csvValue(9007199254740993n)).toBe('9007199254740993');
    expect(csvValue(-150000n)).toBe('-150000');
  });

  it('renders a date as ISO 8601 with the offset', () => {
    // A local rendering in a legal export means a different instant depending on
    // who opens it.
    expect(csvValue(new Date('2026-09-07T12:34:56.000Z'))).toBe('2026-09-07T12:34:56.000Z');
  });

  it('renders jsonb as compact JSON rather than [object Object]', () => {
    // `audit_entry.details` reaches here, and it is the table an auditor reads.
    expect(csvValue({ slug: 'acme', seeded_categories: 6 })).toBe(
      '{"slug":"acme","seeded_categories":6}',
    );
    expect(csvValue([1, 'two'])).toBe('[1,"two"]');
  });

  it('renders bytes as base64', () => {
    expect(csvValue(Uint8Array.from([0xde, 0xad, 0xbe, 0xef]))).toBe('3q2+7w==');
  });

  it('renders booleans and nulls the way a reader expects', () => {
    expect(csvValue(true)).toBe('true');
    expect(csvValue(false)).toBe('false');
    expect(csvValue(null)).toBe('');
    expect(csvValue(undefined)).toBe('');
  });

  it('does not write NaN or Infinity into a cell', () => {
    // Neither is a value any reader parses, and `Infinity` in a numeric column
    // would break an import in a way that points at the importer.
    expect(csvValue(Number.NaN)).toBe('');
    expect(csvValue(Number.POSITIVE_INFINITY)).toBe('');
    expect(csvValue(new Date('nonsense'))).toBe('');
  });

  it('is composable with the guard: a jsonb value starting with = is still text', () => {
    // Not contrived — a `details` blob whose JSON begins with a brace is safe,
    // but a plain-text column holding a formula is the real case, and this is
    // the seam where the two functions meet.
    // Guarded AND quoted AND its inner quotes doubled — my first expectation here
    // omitted the quoting, which was wrong about the test rather than the code.
    expect(csvField(csvValue('=WEBSERVICE("http://x")'))).toBe(
      '"\'=WEBSERVICE(""http://x"")"',
    );
  });
});
