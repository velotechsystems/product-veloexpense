import { describe, expect, it } from 'vitest';
import { canSortClientSide, resolveSortField, sortRows, sortSheetOptions } from './sortRows';
import type { ColumnDef } from './types';

/**
 * `DataTable` recorded `state.sort`, drew the ascending / descending indicator, and then
 * reordered nothing — sorting was the consumer's job, exactly as filtering still is. Nine
 * of the twenty-one listings did that work; the rest drew an arrow that meant nothing.
 * Clicking "Report" or "Total" on the Expense Reports list moved the indicator and left
 * all twelve rows where they were (GA readiness report F04).
 *
 * The rules worth pinning are the ones a naive `[...rows].sort()` gets wrong: money and
 * dates must not be compared as the strings a `cell` renderer produces, blanks must not
 * march to the top when the direction flips, and a column that cannot be sorted honestly
 * must not offer the affordance at all.
 */

interface Row {
  id: string;
  name: string;
  amount: number | null;
  when: Date | null;
}

const col = (over: Partial<ColumnDef<Row, string>> & { id: string }): ColumnDef<Row, string> => ({
  label: over.id,
  cell: () => null,
  sortable: true,
  ...over,
});

const NAME = col({ id: 'name', exportValue: (r) => r.name });
const AMOUNT = col({ id: 'amount', exportNumber: (r) => r.amount });
const WHEN = col({ id: 'when', exportDate: (r) => r.when });
/** Renders fine, but exposes no comparable value. */
const OPAQUE = col({ id: 'opaque' }); // no accessor, and no row field of that name either

const SAMPLE: Row[] = [{ id: 's', name: 'Sample', amount: 1, when: new Date('2026-01-01') }];

const row = (id: string, name: string, amount: number | null, when: string | null): Row => ({
  id,
  name,
  amount,
  when: when ? new Date(when) : null,
});

describe('canSortClientSide', () => {
  it('needs an export accessor to be sortable in the browser', () => {
    expect(canSortClientSide(NAME, SAMPLE)).toBe(true);
    expect(canSortClientSide(AMOUNT, SAMPLE)).toBe(true);
    expect(canSortClientSide(WHEN, SAMPLE)).toBe(true);
    // The case that produced the reported symptom: an arrow over a column with no value
    // behind it. Better to offer nothing than to offer a control that does nothing.
    expect(canSortClientSide(OPAQUE, SAMPLE)).toBe(false);
  });

  it('falls back to a row field named like the column', () => {
    /**
     * `{ id: 'name', cell: (r) => r.name }` with no export accessor is a perfectly normal
     * column, and the existing `DataTable` fixtures are exactly that shape. Refusing to
     * sort those would have hidden working controls for the sake of a rule — which is how
     * the first cut of this change broke five suites.
     */
    const plain = col({ id: 'name' });
    expect(canSortClientSide(plain, SAMPLE)).toBe(true);
    const rows = [row('a', 'Zed', 0, null), row('b', 'Ana', 0, null)];
    expect(sortRows(rows, { field: 'name', dir: 'asc' }, [plain]).map((r) => r.id)).toEqual([
      'b',
      'a',
    ]);
  });

  it('refuses a server-sorted column', () => {
    // `serverField` means the listing sends the sort to its query; re-sorting the page
    // that came back would fight it, and on a cursor-paginated list would order only the
    // rows loaded so far.
    expect(canSortClientSide(col({ id: 'x', sortable: { serverField: 'x' } }), SAMPLE)).toBe(false);
  });

  it('refuses a column that is not sortable at all', () => {
    expect(
      canSortClientSide(col({ id: 'x', sortable: false, exportValue: () => 'a' }), SAMPLE),
    ).toBe(false);
    expect(canSortClientSide(undefined, SAMPLE)).toBe(false);
  });
});

describe('sortRows', () => {
  const rows = [
    row('a', 'Beta', 9, '2026-03-01'),
    row('b', 'alpha', 1500, '2026-01-01'),
    row('c', 'Gamma', 200, '2026-02-01'),
  ];

  it('orders money as numbers, not as rendered text', () => {
    // The bug a string sort produces: "$1,500.00" sorts before "$9.00".
    const asc = sortRows(rows, { field: 'amount', dir: 'asc' }, [AMOUNT]).map((r) => r.id);
    expect(asc).toEqual(['a', 'c', 'b']);
    const desc = sortRows(rows, { field: 'amount', dir: 'desc' }, [AMOUNT]).map((r) => r.id);
    expect(desc).toEqual(['b', 'c', 'a']);
  });

  it('orders dates chronologically', () => {
    const asc = sortRows(rows, { field: 'when', dir: 'asc' }, [WHEN]).map((r) => r.id);
    expect(asc).toEqual(['b', 'c', 'a']);
  });

  it('orders text case-insensitively, so a reader sees one group', () => {
    const asc = sortRows(rows, { field: 'name', dir: 'asc' }, [NAME]).map((r) => r.id);
    expect(asc).toEqual(['b', 'a', 'c']); // alpha, Beta, Gamma
  });

  it('orders embedded numbers the way a person reads them', () => {
    const items = [row('x', 'Item 10', 0, null), row('y', 'Item 2', 0, null)];
    expect(sortRows(items, { field: 'name', dir: 'asc' }, [NAME]).map((r) => r.id)).toEqual([
      'y',
      'x',
    ]);
  });

  it('keeps blanks last in BOTH directions', () => {
    /**
     * A row with no value has not "got a small one". The question being asked is "show me
     * the biggest" or "the smallest", and neither of those means "show me the ones that
     * have none" — so flipping the direction must not march the empties to the top.
     */
    const withBlank = [...rows, row('d', 'Delta', null, null)];
    expect(sortRows(withBlank, { field: 'amount', dir: 'asc' }, [AMOUNT]).at(-1)?.id).toBe('d');
    expect(sortRows(withBlank, { field: 'amount', dir: 'desc' }, [AMOUNT]).at(-1)?.id).toBe('d');
  });

  it('is stable — equal values keep the order they arrived in', () => {
    const tied = [row('p', 'Same', 5, null), row('q', 'Same', 5, null), row('r', 'Same', 5, null)];
    expect(sortRows(tied, { field: 'name', dir: 'asc' }, [NAME]).map((r) => r.id)).toEqual([
      'p',
      'q',
      'r',
    ]);
  });

  it('returns the very same array when there is nothing to do', () => {
    // Identity matters: a new array on every render defeats memoisation downstream.
    expect(sortRows(rows, null, [NAME])).toBe(rows);
    expect(sortRows(rows, { field: '', dir: 'asc' }, [NAME])).toBe(rows);
    // A column it cannot sort honestly is left alone rather than half-sorted.
    expect(sortRows(rows, { field: 'opaque', dir: 'asc' }, [OPAQUE])).toBe(rows);
    expect(sortRows(rows, { field: 'nosuch', dir: 'asc' }, [NAME])).toBe(rows);
  });
});

/**
 * `resolveSortField` / `sortSheetOptions` — the rule the table header used to
 * carry inline, now shared with the mobile `<SortSheet>`.
 *
 * Cards have no header row, so on a phone the sheet IS the sort affordance.
 * It has to offer exactly what the header would have offered: a field the
 * header withheld but the sheet lists is F04 again by another route — a
 * control that appears to work and does not. These pin that the extraction
 * kept the header's behaviour intact, quirks included.
 */
describe('resolveSortField', () => {
  it('gives a `sortable: true` column its own id, when the rows can back it', () => {
    expect(resolveSortField(NAME, SAMPLE)).toBe('name');
  });

  it('gives a `sortable: true` column NOTHING when the rows cannot', () => {
    // The dead-arrow rule. Decided from the rows, not the declaration.
    expect(resolveSortField(OPAQUE, SAMPLE)).toBeNull();
  });

  it('trusts a `sortable: true` column under `sortMode="external"`', () => {
    // There the listing is doing the comparing, in its query, and the
    // browser has no business second-guessing it from a 20-row sample.
    expect(resolveSortField(OPAQUE, SAMPLE, { sortMode: 'external' })).toBe('opaque');
  });

  it('uses `serverField` verbatim, without consulting the rows', () => {
    const c = col({ id: 'total', sortable: { serverField: 'total_cents' } });
    expect(resolveSortField(c, [])).toBe('total_cents');
  });

  it('gives an unsortable column nothing', () => {
    expect(resolveSortField(col({ id: 'actions', sortable: false }), SAMPLE)).toBeNull();
  });

  it('lets `sortFieldFor` override the answer outright, including a null', () => {
    /**
     * The header has always behaved this way — `sortFieldFor ? sortFieldFor(def) : …` —
     * and the extraction keeps it rather than quietly tightening it. A consumer that maps
     * every column to a server field is saying it sorts them all, and the sheet offering
     * exactly what the header offers is a stronger guarantee than any rule invented here.
     */
    expect(resolveSortField(OPAQUE, SAMPLE, { sortFieldFor: (c) => `srv_${c.id}` })).toBe(
      'srv_opaque',
    );
  });
});

describe('sortSheetOptions', () => {
  it('is the resolver mapped over the columns, unsortables dropped', () => {
    expect(sortSheetOptions([NAME, OPAQUE, AMOUNT], SAMPLE)).toEqual([
      { field: 'name', label: 'name' },
      { field: 'amount', label: 'amount' },
    ]);
  });

  it('keeps the column order the reader sees', () => {
    expect(sortSheetOptions([AMOUNT, NAME], SAMPLE).map((o) => o.field)).toEqual([
      'amount',
      'name',
    ]);
  });

  it('labels each option with the column header text, not its id', () => {
    // The sheet is read by somebody who never saw the id. "submittedAt"
    // names a column they have only ever seen called "Submitted".
    const c = col({ id: 'submittedAt', label: 'Submitted', exportDate: (r) => r.when });
    expect(sortSheetOptions([c], SAMPLE)).toEqual([{ field: 'submittedAt', label: 'Submitted' }]);
  });

  it('comes back empty when nothing on the list can be sorted', () => {
    // The sheet renders its empty state rather than a list of dead rows.
    expect(sortSheetOptions([OPAQUE], SAMPLE)).toEqual([]);
  });
});
