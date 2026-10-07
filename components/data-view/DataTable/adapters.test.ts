import { describe, expect, it } from 'vitest';
import {
  columnFilterToClauses,
  filterClauseToColumnFilter,
  moveRow,
  reorderForPinning,
} from './DataTable';
import type { FilterClause } from './types';

const strip = (cs: FilterClause<string>[]) =>
  cs.map(({ field, op, value }) => ({ field, op, value }));

describe('columnFilterToClauses', () => {
  it('expands isAnyOf into one equals clause per value', () => {
    expect(strip(columnFilterToClauses('status', { op: 'isAnyOf', values: ['A', 'B'] }))).toEqual([
      { field: 'status', op: 'equals', value: 'A' },
      { field: 'status', op: 'equals', value: 'B' },
    ]);
  });

  it('expands isNoneOf into one doesNotEqual clause per value', () => {
    expect(strip(columnFilterToClauses('status', { op: 'isNoneOf', values: ['X'] }))).toEqual([
      { field: 'status', op: 'doesNotEqual', value: 'X' },
    ]);
  });

  it('maps valueless ops to a single empty-value clause', () => {
    expect(strip(columnFilterToClauses('name', { op: 'isEmpty' }))).toEqual([
      { field: 'name', op: 'isEmpty', value: '' },
    ]);
    expect(strip(columnFilterToClauses('name', { op: 'isNotEmpty' }))).toEqual([
      { field: 'name', op: 'isNotEmpty', value: '' },
    ]);
  });

  it('maps a value op to a single clause carrying the value', () => {
    expect(strip(columnFilterToClauses('name', { op: 'contains', value: 'foo' }))).toEqual([
      { field: 'name', op: 'contains', value: 'foo' },
    ]);
  });

  it('assigns a unique id to every produced clause', () => {
    const clauses = columnFilterToClauses('s', { op: 'isAnyOf', values: ['A', 'B'] });
    expect(new Set(clauses.map((c) => c.id)).size).toBe(2);
  });
});

describe('filterClauseToColumnFilter', () => {
  const clause = (over: Partial<FilterClause<string>>): FilterClause<string> => ({
    id: 'x',
    field: 'name',
    op: 'contains',
    value: 'foo',
    ...over,
  });

  it('returns null when the column has no clauses', () => {
    expect(filterClauseToColumnFilter([], 'name')).toBeNull();
  });

  it('collapses a single value clause', () => {
    expect(filterClauseToColumnFilter([clause({})], 'name')).toEqual({
      op: 'contains',
      value: 'foo',
    });
  });

  it('collapses a single valueless clause without a value', () => {
    expect(filterClauseToColumnFilter([clause({ op: 'isEmpty', value: '' })], 'name')).toEqual({
      op: 'isEmpty',
    });
  });

  it('collapses all-equals clauses into isAnyOf', () => {
    expect(
      filterClauseToColumnFilter(
        [clause({ op: 'equals', value: 'A' }), clause({ op: 'equals', value: 'B' })],
        'name',
      ),
    ).toEqual({ op: 'isAnyOf', values: ['A', 'B'] });
  });

  it('collapses all-doesNotEqual clauses into isNoneOf', () => {
    expect(
      filterClauseToColumnFilter(
        [clause({ op: 'doesNotEqual', value: 'A' }), clause({ op: 'doesNotEqual', value: 'B' })],
        'name',
      ),
    ).toEqual({ op: 'isNoneOf', values: ['A', 'B'] });
  });

  it('returns null for mixed-op groups (only editable via the pill bar)', () => {
    expect(
      filterClauseToColumnFilter(
        [clause({ op: 'equals', value: 'A' }), clause({ op: 'contains', value: 'B' })],
        'name',
      ),
    ).toBeNull();
  });

  it('ignores clauses belonging to other columns', () => {
    expect(
      filterClauseToColumnFilter([clause({ field: 'other', op: 'contains', value: 'z' })], 'name'),
    ).toBeNull();
  });
});

describe('reorderForPinning', () => {
  it('moves pinned-left first and pinned-right last, preserving unpinned order', () => {
    expect(reorderForPinning(['a', 'b', 'c', 'd'], { left: ['c'], right: ['a'] })).toEqual([
      'c',
      'b',
      'd',
      'a',
    ]);
  });

  it('is a no-op when nothing is pinned', () => {
    expect(reorderForPinning(['a', 'b', 'c'], { left: [], right: [] })).toEqual(['a', 'b', 'c']);
  });

  it('honors pin-add order within the left band', () => {
    expect(reorderForPinning(['a', 'b', 'c'], { left: ['c', 'a'], right: [] })).toEqual([
      'c',
      'a',
      'b',
    ]);
  });
});

describe('moveRow', () => {
  it('moves an id forward to the target slot', () => {
    expect(moveRow(['a', 'b', 'c', 'd'], 'a', 'c')).toEqual(['b', 'c', 'a', 'd']);
  });

  it('moves an id backward to the target slot', () => {
    expect(moveRow(['a', 'b', 'c', 'd'], 'd', 'b')).toEqual(['a', 'd', 'b', 'c']);
  });

  it('is a no-op when drag and target are the same', () => {
    expect(moveRow(['a', 'b', 'c'], 'b', 'b')).toEqual(['a', 'b', 'c']);
  });

  it('is a no-op when an id is not present', () => {
    expect(moveRow(['a', 'b', 'c'], 'x', 'b')).toEqual(['a', 'b', 'c']);
    expect(moveRow(['a', 'b', 'c'], 'a', 'z')).toEqual(['a', 'b', 'c']);
  });
});
