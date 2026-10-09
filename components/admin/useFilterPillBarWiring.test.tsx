import { act, renderHook } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

/**
 * The shared FilterPillBar plumbing — the five handlers and four prop bags that thirty
 * listing pages spread into the same component.
 *
 * The one that carries real weight is `nextOpValue`, the rule for what happens to a
 * clause's VALUE when its operator changes. Date operators do not share an encoding: a
 * `within` carries a preset token ('last30'), an `on` carries YYYY-MM-DD, a `between`
 * carries a range, and `isEmpty` carries nothing at all. Keeping the old value across an
 * incompatible switch produces a clause the server rejects — or worse, one it accepts and
 * evaluates against a string that means something else. Switching `contains` → `startsWith`
 * has to KEEP the value, because that is a user narrowing what they already typed.
 */

vi.mock('next-intl', () => ({
  useTranslations: () => (k: string) => `table.${k}`,
}));

import { useFilterPillBarWiring } from './useFilterPillBarWiring';

type Col = 'name' | 'status' | 'created' | 'plain';

const COLUMNS = [
  { id: 'name' as Col, label: 'Name', filterable: { kind: 'text' as const } },
  {
    id: 'status' as Col,
    label: 'Status',
    filterable: { kind: 'enum' as const, options: [{ value: 'a', label: 'Active' }] },
  },
  { id: 'created' as Col, label: 'Created', filterable: { kind: 'date' as const } },
  // No `filterable` at all — must not appear in the pill bar's field list.
  { id: 'plain' as Col, label: 'Plain' },
];

/** Drive the hook against real state, since every handler is a setState reducer. */
function harness(
  initialFilters: Array<{ id: string; field: Col; op: string; value: string }> = [],
) {
  return renderHook(() => {
    const [state, setState] = useState({
      filters: initialFilters,
      sort: null,
      columnVisibility: {},
      columnWidths: {},
      density: 'normal',
      selectedIds: new Set<string>(),
    });
    const wiring = useFilterPillBarWiring(COLUMNS as never, state as never, setState as never);
    return { wiring, state };
  });
}

describe('the prop bags', () => {
  it('offers only the columns that declare themselves filterable', () => {
    /** A field with no `filterable` has no editor to render; offering it produces a pill
     *  whose value box does nothing. */
    const { result } = harness();
    expect(result.current.wiring.filterFields).toEqual(['name', 'status', 'created']);
  });

  it('labels each field with the column’s own label', () => {
    const { result } = harness();
    expect(result.current.wiring.filterLabels).toEqual({
      name: 'Name',
      status: 'Status',
      created: 'Created',
    });
  });

  it('carries each field’s kind, which decides its editor', () => {
    const { result } = harness();
    expect(result.current.wiring.filterKinds).toEqual({
      name: 'text',
      status: 'enum',
      created: 'date',
    });
  });

  it('defaults a filterable column with no kind to text', () => {
    /** Text is the only kind that needs no configuration, so it is the safe default —
     *  an enum with no options would render an empty picker. */
    const { result } = renderHook(() => {
      const [state, setState] = useState({ filters: [], sort: null } as never);
      return useFilterPillBarWiring(
        [{ id: 'x', label: 'X', filterable: {} }] as never,
        state as never,
        setState as never,
      );
    });
    expect(result.current.filterKinds).toEqual({ x: 'text' });
  });

  it('carries the enum options, and an empty list for the rest', () => {
    const { result } = harness();
    expect(result.current.wiring.filterOptions.status).toEqual([{ value: 'a', label: 'Active' }]);
    expect(result.current.wiring.filterOptions.name).toEqual([]);
  });

  it('translates the clear label, which used to be the last English string on every page', () => {
    /** `FilterPillBar` defaulted it to English and 29 of 30 call sites never passed one, so
     *  it showed up untranslated on every listing page in a French session. */
    const { result } = harness();
    expect(result.current.wiring.clearLabel).toBe('table.misc.clearFilters');
  });
});

describe('adding and removing clauses', () => {
  it('adds a clause with an id of its own', () => {
    const { result } = harness();
    act(() => result.current.wiring.addClause('name', 'contains', 'acme'));
    expect(result.current.state.filters).toHaveLength(1);
    expect(result.current.state.filters[0]).toMatchObject({
      field: 'name',
      op: 'contains',
      value: 'acme',
    });
    expect(result.current.state.filters[0].id).toBeTruthy();
  });

  it('gives every clause a distinct id, so two on one field can coexist', () => {
    /** "contains acme" AND "does not contain holdings" is a legitimate pair, and removing
     *  one must not remove both. */
    const { result } = harness();
    act(() => result.current.wiring.addClause('name', 'contains', 'a'));
    act(() => result.current.wiring.addClause('name', 'contains', 'b'));
    const [first, second] = result.current.state.filters;
    expect(first.id).not.toBe(second.id);
    act(() => result.current.wiring.removeClause(first.id));
    expect(result.current.state.filters).toHaveLength(1);
    expect(result.current.state.filters[0].value).toBe('b');
  });

  it('clears every clause at once', () => {
    const { result } = harness();
    act(() => result.current.wiring.addClause('name', 'contains', 'a'));
    act(() => result.current.wiring.addClause('status', 'equals', 'a'));
    act(() => result.current.wiring.clearClauses());
    expect(result.current.state.filters).toEqual([]);
  });

  it('leaves other clauses alone when one value changes', () => {
    const { result } = harness();
    act(() => result.current.wiring.addClause('name', 'contains', 'a'));
    act(() => result.current.wiring.addClause('status', 'equals', 'x'));
    const id = result.current.state.filters[0].id;
    act(() => result.current.wiring.updateClauseValue(id, 'changed'));
    expect(result.current.state.filters[0].value).toBe('changed');
    expect(result.current.state.filters[1].value).toBe('x');
  });
});

describe('what changing the operator does to the value', () => {
  const withClause = (op: string, value: string) =>
    harness([{ id: 'c1', field: 'created', op, value }]);

  it('keeps the value across a compatible text switch', () => {
    /** Narrowing `contains` to `startsWith` is a refinement of what was already typed;
     *  clearing it would make the user retype their own search. */
    const { result } = harness([{ id: 'c1', field: 'name', op: 'contains', value: 'acme' }]);
    act(() => result.current.wiring.updateClauseOp('c1', 'startsWith'));
    expect(result.current.state.filters[0]).toMatchObject({ op: 'startsWith', value: 'acme' });
  });

  it('drops the value for an operator that takes none', () => {
    /** `isEmpty` with a leftover value is a clause the server reads as contradictory. */
    for (const op of ['isEmpty', 'isNotEmpty'] as const) {
      const { result } = harness([{ id: 'c1', field: 'name', op: 'contains', value: 'acme' }]);
      act(() => result.current.wiring.updateClauseOp('c1', op));
      expect(result.current.state.filters[0], op).toMatchObject({ op, value: '' });
    }
  });

  it('gives `within` a preset token rather than a leftover date', () => {
    /**
     * `within` is encoded as a relative preset, not a date. Carrying '2026-08-01' into it
     * produces a clause whose value the resolver cannot parse — and the failure is a list
     * that silently returns nothing.
     */
    const { result } = withClause('on', '2026-08-01');
    act(() => result.current.wiring.updateClauseOp('c1', 'within'));
    expect(result.current.state.filters[0]).toMatchObject({ op: 'within', value: 'last30' });
  });

  it('empties the value for an absolute date operator', () => {
    /** Each of these carries its own encoding — a single day, a bound, or a range — so a
     *  value written for one of the others is wrong rather than merely stale. */
    for (const op of ['on', 'before', 'after', 'between'] as const) {
      const { result } = withClause('within', 'last30');
      act(() => result.current.wiring.updateClauseOp('c1', op));
      expect(result.current.state.filters[0], op).toMatchObject({ op, value: '' });
    }
  });

  it('changes only the clause it was given', () => {
    const { result } = harness([
      { id: 'c1', field: 'name', op: 'contains', value: 'a' },
      { id: 'c2', field: 'name', op: 'contains', value: 'b' },
    ]);
    act(() => result.current.wiring.updateClauseOp('c2', 'isEmpty'));
    expect(result.current.state.filters[0]).toMatchObject({ op: 'contains', value: 'a' });
    expect(result.current.state.filters[1]).toMatchObject({ op: 'isEmpty', value: '' });
  });
});
