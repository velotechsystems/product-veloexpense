import { describe, expect, it } from 'vitest';
import { flattenTree } from './useTreeRows';

interface Row {
  nsId: string;
  parent: string | null;
  name: string;
}
const id = (r: Row) => r.nsId;
const parent = (r: Row) => r.parent;

// 1 ─ 1.1 ─ 1.1.1
//   └ 1.2
// 2
const ROWS: Row[] = [
  { nsId: '1', parent: null, name: 'Root 1' },
  { nsId: '1.1', parent: '1', name: 'Child 1.1' },
  { nsId: '1.1.1', parent: '1.1', name: 'Grandchild' },
  { nsId: '1.2', parent: '1', name: 'Child 1.2' },
  { nsId: '2', parent: null, name: 'Root 2' },
];

describe('flattenTree', () => {
  it('orders depth-first with correct depths when fully expanded', () => {
    const out = flattenTree(ROWS, id, parent, new Set());
    expect(out.map((n) => `${n.id}@${n.depth}`)).toEqual([
      '1@0',
      '1.1@1',
      '1.1.1@2',
      '1.2@1',
      '2@0',
    ]);
    expect(out.find((n) => n.id === '1')?.hasChildren).toBe(true);
    expect(out.find((n) => n.id === '2')?.hasChildren).toBe(false);
  });

  it('omits the subtree of a collapsed node', () => {
    const out = flattenTree(ROWS, id, parent, new Set(['1.1']));
    expect(out.map((n) => n.id)).toEqual(['1', '1.1', '1.2', '2']); // 1.1.1 hidden
  });

  it('collapsing a root hides all descendants', () => {
    const out = flattenTree(ROWS, id, parent, new Set(['1']));
    expect(out.map((n) => n.id)).toEqual(['1', '2']);
  });

  it('promotes orphans (missing parent) to roots instead of dropping them', () => {
    const orphans: Row[] = [{ nsId: 'x', parent: 'ghost', name: 'Orphan' }];
    const out = flattenTree(orphans, id, parent, new Set());
    expect(out.map((n) => `${n.id}@${n.depth}`)).toEqual(['x@0']);
  });

  it('does not loop on a self-referential / cyclic parent', () => {
    const cyclic: Row[] = [
      { nsId: 'a', parent: 'b', name: 'A' },
      { nsId: 'b', parent: 'a', name: 'B' },
    ];
    // Neither has a missing parent, so both are children → no roots → empty,
    // but the cycle guard must prevent an infinite loop regardless.
    expect(() => flattenTree(cyclic, id, parent, new Set())).not.toThrow();
  });
});
