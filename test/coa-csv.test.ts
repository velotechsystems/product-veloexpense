/**
 * VX3-1 — the chart-of-accounts CSV parser and validator. No database.
 *
 * `lib/accounts/{csv,validate}.ts` are pure by the house rule, which is what lets
 * this suite run without Postgres. The rules being pinned here are the ones a
 * later "simplification" would quietly drop.
 */
import { describe, it, expect } from 'vitest';
import { parseCsv } from '@/lib/accounts/csv';
import { validateCoaCsv } from '@/lib/accounts/validate';

const HEADER = 'number,name,type,sub_type,parent_number,notes';

function validate(body: string) {
  return validateCoaCsv(parseCsv(`${HEADER}\n${body}`));
}

describe('parseCsv', () => {
  it('handles quoted fields containing commas and escaped quotes', () => {
    const parsed = parseCsv('number,name\n68100,"Travel, lodging and ""incidentals"""');
    expect(parsed.rows[0].fields.name).toBe('Travel, lodging and "incidentals"');
  });

  it('numbers lines from the header, so an error can name one', () => {
    const parsed = parseCsv('number,name\n1,A\n\n2,B');
    // Blank lines are skipped but do NOT shift the numbering — the point of the
    // line number is that it matches what the author sees in their editor.
    expect(parsed.rows.map((r) => r.lineNumber)).toEqual([2, 4]);
  });
});

describe('validateCoaCsv', () => {
  it('accepts a small tree and derives the rollup', () => {
    const r = validate(['68000,Travel M&E,expense,opex,,', '68100,Travel,expense,opex,68000,'].join('\n'));
    expect(r.ok).toBe(true);
    const byNumber = Object.fromEntries(r.accounts.map((a) => [a.number, a]));
    // NOT supplied in the file: 68000 is a rollup because 68100 names it.
    expect(byNumber['68000'].isPostable).toBe(false);
    expect(byNumber['68100'].isPostable).toBe(true);
    expect(byNumber['68100'].parentNumber).toBe('68000');
  });

  it('rejects the whole file when one row is bad — no partial success', () => {
    const r = validate(['68100,Travel,expense,opex,,', '68200,,expense,opex,,'].join('\n'));
    expect(r.ok).toBe(false);
    // The good row is not returned either. A chart half-imported is worse than
    // one not imported, because the half that landed looks like a chart.
    expect(r.accounts).toEqual([]);
    expect(r.errors[0]).toMatchObject({ lineNumber: 3, field: 'name' });
  });

  it('names the missing column once instead of once per row', () => {
    const r = validateCoaCsv(parseCsv('number,name\n68100,Travel\n68200,Meals'));
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatchObject({ field: 'type', lineNumber: 1 });
  });

  it('rejects an unknown account type', () => {
    const r = validate('68100,Travel,operating,opex,,');
    expect(r.ok).toBe(false);
    expect(r.errors[0].message).toMatch(/invalid type 'operating'/);
  });

  it('rejects a duplicate account number', () => {
    const r = validate(['68100,Travel,expense,opex,,', '68100,Travel again,expense,opex,,'].join('\n'));
    expect(r.errors[0].message).toMatch(/duplicate account number '68100'/);
  });

  it('rejects a parent that is not in the file', () => {
    const r = validate('68100,Travel,expense,opex,60000,');
    expect(r.errors[0]).toMatchObject({ field: 'parent_number' });
    expect(r.errors[0].message).toMatch(/must appear in the same file/);
  });

  it('rejects an account that is its own parent', () => {
    const r = validate('68100,Travel,expense,opex,68100,');
    expect(r.errors.some((e) => /cannot be its own parent/.test(e.message))).toBe(true);
  });

  it('rejects is_postable=true on an account that has children', () => {
    // The specific misunderstanding VeloLedger 0028 had to repair after the fact:
    // a parent marked postable, a line posted to it, and the amount vanished from
    // the income statement. Declaring it is allowed; declaring it WRONG is not.
    const r = validateCoaCsv(
      parseCsv(
        'number,name,type,parent_number,is_postable\n' +
          '68000,Travel M&E,expense,,true\n' +
          '68100,Travel,expense,68000,true',
      ),
    );
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatchObject({ field: 'is_postable', lineNumber: 2 });
    expect(r.errors[0].message).toMatch(/rollup/);
  });

  it('treats a chart with no parent_number column as entirely leaves', () => {
    // Not a degenerate case — a flat chart is a legitimate small-business chart,
    // and every row in it is postable. This assertion exists because the first
    // version of the test above omitted `parent_number` by mistake and passed for
    // this reason; the behaviour is right, so it is pinned rather than left as a
    // thing that happens to work.
    const r = validateCoaCsv(
      parseCsv('number,name,type\n68100,Travel,expense\n68200,Meals,expense'),
    );
    expect(r.ok).toBe(true);
    expect(r.accounts.every((a) => a.isPostable)).toBe(true);
  });

  it('rejects is_postable=false on a leaf', () => {
    const r = validateCoaCsv(
      parseCsv('number,name,type,is_postable\n68100,Travel,expense,false'),
    );
    expect(r.errors[0].message).toMatch(/is a leaf and nothing could ever post to it/);
  });

  it('treats a non-boolean is_postable as an error, not as false', () => {
    const r = validateCoaCsv(parseCsv('number,name,type,is_postable\n68100,Travel,expense,maybe'));
    expect(r.errors[0].message).toMatch(/is not a true\/false value/);
  });

  it('preserves file order when sort_order is absent', () => {
    const r = validate(
      ['68000,Travel M&E,expense,opex,,', '68100,Travel,expense,opex,68000,'].join('\n'),
    );
    // Ascending and distinct — an absent sort_order must not collapse every row to
    // 0, which would leave the picker sorted by nothing.
    const orders = r.accounts.map((a) => a.sortOrder);
    expect(orders).toEqual([...orders].sort((x, y) => x - y));
    expect(new Set(orders).size).toBe(orders.length);
  });

  it('rejects a non-numeric sort_order', () => {
    const r = validateCoaCsv(parseCsv('number,name,type,sort_order\n68100,Travel,expense,first'));
    expect(r.errors[0]).toMatchObject({ field: 'sort_order' });
  });
});
