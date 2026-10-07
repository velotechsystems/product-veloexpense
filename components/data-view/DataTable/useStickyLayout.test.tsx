import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { ColumnDef, DataTableState } from './types';
import { minWidthForLabel, useStickyLayout } from './useStickyLayout';

/**
 * Every `defaultWidth` in the product was chosen against the English label. French runs
 * about 20% longer for the same column, and `ColumnHeader` wraps its label with
 * `whitespace-normal break-words` — so a column too narrow for its own heading does not
 * overflow, it breaks the word in half. The audit saw "Gravité" rendered as "Gravi té"
 * (GA readiness report F43).
 *
 * These fix the CONTRACT rather than the pixels: a single word never has to break, a
 * multi-word label may still wrap at its space, and a width somebody chose by dragging is
 * never overridden.
 */

type Id = 'severity' | 'wide' | 'narrow';

const col = (id: Id, label: string, defaultWidth?: number): ColumnDef<unknown, Id> => ({
  id,
  label,
  defaultWidth,
  cell: () => null,
});

const state = (columnWidths: Partial<Record<Id, number>> = {}): DataTableState<Id> =>
  ({
    columnWidths,
    pinnedColumns: { left: [], right: [] },
  }) as unknown as DataTableState<Id>;

/** The REAL hook's width lookup — not a re-implementation of it. */
function widthOf(columns: ColumnDef<unknown, Id>[], s: DataTableState<Id>, id: Id): number {
  const { result } = renderHook(() => useStickyLayout({ columns, state: s, selectColumnWidth: 0 }));
  return result.current.widthOf(id);
}

describe('minWidthForLabel', () => {
  it('measures the longest WORD, not the whole label', () => {
    // Wrapping "Effective from" across two lines is correct. Breaking "Gravité" across two
    // lines never is — so only the widest single word has to fit.
    expect(minWidthForLabel('Effective from')).toBe(minWidthForLabel('Effective'));
    expect(minWidthForLabel('a b c d e f g h')).toBe(minWidthForLabel('a'));
  });

  it('gives the longer fr-CA word more room than its English counterpart', () => {
    expect(minWidthForLabel('Gravité')).toBeGreaterThan(minWidthForLabel('Level'));
    expect(minWidthForLabel('Catégorie')).toBeGreaterThan(minWidthForLabel('Category'));
    expect(minWidthForLabel('Approbateur')).toBeGreaterThan(minWidthForLabel('Approver'));
  });

  it('caps a runaway label rather than demanding an unusable column', () => {
    expect(minWidthForLabel('A'.repeat(200))).toBe(260);
  });

  it('never returns less than the header chrome needs', () => {
    expect(minWidthForLabel('')).toBeGreaterThanOrEqual(52);
  });
});

describe('widthOf', () => {
  it('raises a default that cannot fit its own heading', () => {
    // The reported shape: a column sized for "Level" and then handed "Gravité".
    const columns = [col('severity', 'Gravité', 90)];
    expect(widthOf(columns, state(), 'severity')).toBeGreaterThan(90);
    expect(widthOf(columns, state(), 'severity')).toBe(minWidthForLabel('Gravité'));
  });

  it('leaves a default that is already wide enough alone', () => {
    const columns = [col('wide', 'Gravité', 400)];
    expect(widthOf(columns, state(), 'wide')).toBe(400);
  });

  it('never overrides a width somebody chose', () => {
    // Dragged narrow on purpose, or auto-sized. Widening it back would fight them.
    const columns = [col('narrow', 'Approbateur', 180)];
    expect(widthOf(columns, state({ narrow: 60 }), 'narrow')).toBe(60);
  });
});
