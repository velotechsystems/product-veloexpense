/**
 * `groupRows` — the partition both trees draw their group headers from.
 *
 * The whole reason it is a module is that a second copy would agree today and
 * drift later, so what is pinned here is the CONTRACT the two surfaces rely
 * on: the ordering guarantees, the off switch, and the selection metrics.
 * A change that reorders groups changes what the table renders on every
 * grouped page at once, which is why order is asserted and not assumed.
 */

import { describe, expect, it } from 'vitest';
import { groupRows } from './groupRows';

interface Row {
  id: string;
  status: string;
}
type Col = 'status' | 'name';

const ROWS: Row[] = [
  { id: 'a', status: 'SUBMITTED' },
  { id: 'b', status: 'DRAFT' },
  { id: 'c', status: 'SUBMITTED' },
  { id: 'd', status: 'DRAFT' },
];

const BASE = {
  groupBy: 'status' as Col,
  groupKeyFor: (r: Row) => r.status,
  rowKey: (r: Row) => r.id,
  selectedIds: new Set<string>(),
};

describe('groupRows', () => {
  it('groups in FIRST-APPEARANCE order, not alphabetically', () => {
    // The table does not sort groups — that is the consumer's sort field.
    // Sorting here would silently override it on every grouped page.
    const groups = groupRows(ROWS, BASE);
    expect(groups.map((g) => g.key)).toEqual(['SUBMITTED', 'DRAFT']);
  });

  it('keeps rows in their relative input order inside a group', () => {
    const groups = groupRows(ROWS, BASE);
    expect(groups[0]?.rows.map((r) => r.id)).toEqual(['a', 'c']);
    expect(groups[1]?.rows.map((r) => r.id)).toEqual(['b', 'd']);
  });

  it('is OFF — an empty list — with no groupBy', () => {
    // `[]` is the signal both trees take their ungrouped path on, so
    // "grouped?" is one question with one answer rather than a flag each
    // surface re-derives.
    expect(groupRows(ROWS, { ...BASE, groupBy: null })).toEqual([]);
  });

  it('is OFF with a groupBy but no groupKeyFor — the consumer has not opted in', () => {
    expect(groupRows(ROWS, { ...BASE, groupKeyFor: undefined })).toEqual([]);
  });

  it('labels through groupLabelFor, and falls back to the key', () => {
    const labelled = groupRows(ROWS, { ...BASE, groupLabelFor: (k) => `Status: ${k}` });
    expect(labelled.map((g) => g.label)).toEqual(['Status: SUBMITTED', 'Status: DRAFT']);
    expect(groupRows(ROWS, BASE).map((g) => g.label)).toEqual(['SUBMITTED', 'DRAFT']);
  });

  it('computes allSelected / someSelected per group', () => {
    // Computed here rather than left to each surface: a header checkbox that
    // disagrees with the rows under it is worse than no header checkbox.
    const groups = groupRows(ROWS, { ...BASE, selectedIds: new Set(['a', 'c', 'b']) });
    expect(groups[0]).toMatchObject({ key: 'SUBMITTED', allSelected: true, someSelected: true });
    expect(groups[1]).toMatchObject({ key: 'DRAFT', allSelected: false, someSelected: true });
  });

  it('reports collapsed straight off the collapsed set', () => {
    const groups = groupRows(ROWS, { ...BASE, collapsedGroups: new Set(['DRAFT']) });
    expect(groups.map((g) => g.collapsed)).toEqual([false, true]);
  });

  it('returns no groups for no rows', () => {
    expect(groupRows([], BASE)).toEqual([]);
  });
});
