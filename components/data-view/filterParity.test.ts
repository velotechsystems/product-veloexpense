import { groupClauses } from '@expenseos/design-system';
import { describe, expect, it } from 'vitest';
import { clausesToServerFilters, type FilterClause, type FilterOp } from './types';

/**
 * Desktop pill bar and mobile filter sheet must ask the server the same
 * question.
 *
 * ── The gap this closes ─────────────────────────────────────────────
 *
 * There are TWO partitions of the same clause array in this codebase and
 * they are deliberately different:
 *
 *   - `groupClauses()` (design system) splits by `field::op`. That is what a
 *     `<FilterBlock>` is, on both surfaces.
 *   - `clausesToServerFilters()` (below, in `./types`) splits by FIELD
 *     ALONE, and its mixed-operator branch sends `list[0]` and silently
 *     drops the rest — the Phase 1 backend has no AND/OR composition.
 *
 * Two partitions of different coarseness over one array, where the coarser
 * one is order-sensitive. That is the shape of bug where a UI change nobody
 * thought was semantic — stacking pills vertically instead of horizontally —
 * quietly changes which filter runs.
 *
 * ── What "the sheet's output" means here ────────────────────────────
 *
 * Neither surface owns a clause array. Both edit the host's, through the
 * same `<FilterBlock>` callbacks, so their WRITES are identical by
 * construction. What differs is the order each one puts clauses on screen:
 * the bar renders the array's own order, the sheet renders it regrouped and
 * stacked. `sheetOrder()` below is that stacked order, made concrete.
 *
 * If the sheet ever writes back what it displays — a reorder affordance, a
 * "normalise on apply", a state round-trip through the saved-view payload —
 * the array becomes the regrouped one, and this test is what catches the
 * server payload changing underneath it. Today the assertion passes because
 * regrouping is first-preserving per field; that is a property, not a
 * coincidence, and it is exactly the property worth pinning.
 */

type F = 'status' | 'name' | 'createdAt';

const c = (id: string, field: F, op: FilterOp, value = ''): FilterClause<F> => ({
  id,
  field,
  op,
  value,
});

/** The bar's order: the clause array exactly as the host holds it. */
const barOrder = (list: FilterClause<F>[]): FilterClause<F>[] => list;

/** The sheet's order: blocks stacked top to bottom, clauses within a block
 *  in the order their values are drawn. */
const sheetOrder = (list: FilterClause<F>[]): FilterClause<F>[] =>
  groupClauses(list).flatMap((g) => g.clauses);

/** Assert both orders produce the same payload, and that it is the expected
 *  one. Both halves matter: parity alone would pass if the two surfaces
 *  broke identically. */
function expectParity(list: FilterClause<F>[], expected: unknown) {
  expect(clausesToServerFilters(barOrder(list))).toEqual(expected);
  expect(clausesToServerFilters(sheetOrder(list))).toEqual(expected);
}

describe('single clause — every operator', () => {
  const SINGLE: Array<[FilterOp, string, unknown]> = [
    // A lone `equals` collapses to `isAnyOf` with one value, not to `equals`.
    // That is the aggregator's rule and it applies on both surfaces.
    ['equals', 'DRAFT', { status: { op: 'isAnyOf', values: ['DRAFT'] } }],
    ['doesNotEqual', 'DRAFT', { status: { op: 'isNoneOf', values: ['DRAFT'] } }],
    ['contains', 'ada', { status: { op: 'contains', value: 'ada' } }],
    ['doesNotContain', 'ada', { status: { op: 'doesNotContain', value: 'ada' } }],
    ['startsWith', 'ad', { status: { op: 'startsWith', value: 'ad' } }],
    ['endsWith', 'da', { status: { op: 'endsWith', value: 'da' } }],
    ['isEmpty', '', { status: { op: 'isEmpty' } }],
    ['isNotEmpty', '', { status: { op: 'isNotEmpty' } }],
  ];

  for (const [op, value, expected] of SINGLE) {
    it(`${op} maps identically on both surfaces`, () => {
      expectParity([c('c1', 'status', op, value)], expected);
    });
  }
});

describe('valueless operators', () => {
  it('carry no value, on either surface', () => {
    // `isEmpty` with a stale value attached would be a filter the server
    // reads differently from the one the pill describes.
    expectParity([c('c1', 'status', 'isEmpty', 'LEFTOVER')], { status: { op: 'isEmpty' } });
  });

  it('do not merge with a valued clause on the same field', () => {
    // Mixed ops → first clause wins, and the first clause here is the
    // valueless one, so the value is dropped.
    expectParity([c('c1', 'status', 'isNotEmpty'), c('c2', 'status', 'equals', 'DRAFT')], {
      status: { op: 'isNotEmpty' },
    });
  });
});

describe('date operators reach neither payload', () => {
  // Resolved client-side into absolute bounds by the pages that use them,
  // so the people-directory aggregator has nothing to map. Pinned because
  // "the sheet emits a date filter the bar does not" would be invisible
  // otherwise — both sides have to drop it.
  for (const op of ['on', 'before', 'after', 'between', 'within'] as const) {
    it(`${op} is dropped`, () => {
      expectParity([c('c1', 'createdAt', op, '2026-01-01')], {});
    });
  }
});

describe('collapsing same-field, same-op clauses', () => {
  it('all-equals becomes isAnyOf, values in the order they were added', () => {
    expectParity(
      [
        c('c1', 'status', 'equals', 'DRAFT'),
        c('c2', 'status', 'equals', 'SUBMITTED'),
        c('c3', 'status', 'equals', 'APPROVED'),
      ],
      { status: { op: 'isAnyOf', values: ['DRAFT', 'SUBMITTED', 'APPROVED'] } },
    );
  });

  it('all-doesNotEqual becomes isNoneOf', () => {
    expectParity(
      [c('c1', 'status', 'doesNotEqual', 'DRAFT'), c('c2', 'status', 'doesNotEqual', 'PAID')],
      { status: { op: 'isNoneOf', values: ['DRAFT', 'PAID'] } },
    );
  });

  it('keeps values in order even when another field interleaves them', () => {
    // The sheet lifts the two status clauses into one block, so its order is
    // [c1, c3, c2] where the bar's is [c1, c2, c3]. The status VALUES must
    // still come out in the same order — `isAnyOf` is a set to the server
    // but the array is what gets compared here, and a reordered one would
    // be a real difference in what was sent.
    expectParity(
      [
        c('c1', 'status', 'equals', 'DRAFT'),
        c('c2', 'name', 'contains', 'ada'),
        c('c3', 'status', 'equals', 'SUBMITTED'),
      ],
      {
        status: { op: 'isAnyOf', values: ['DRAFT', 'SUBMITTED'] },
        name: { op: 'contains', value: 'ada' },
      },
    );
  });
});

describe('the documented mixed-operator degradation', () => {
  /**
   * The branch this whole file exists for.
   *
   * `clausesToServerFilters` groups by field, finds the ops disagree, and
   * sends `list[0]` — dropping everything else. Which clause is `list[0]`
   * therefore decides what the server does, and the sheet regroups the
   * array before drawing it. If regrouping moved a different clause to the
   * front, the same screen would filter differently on a phone.
   */

  it('sends the FIRST clause and drops the rest', () => {
    expectParity([c('c1', 'status', 'contains', 'dra'), c('c2', 'status', 'equals', 'DRAFT')], {
      status: { op: 'contains', value: 'dra' },
    });
  });

  it('is order-sensitive — reversing the input changes the answer', () => {
    // Proof the assertion above has teeth. If order did not matter, the
    // parity check would be vacuous.
    const forward = [c('c1', 'status', 'contains', 'dra'), c('c2', 'status', 'equals', 'DRAFT')];
    const reversed = [...forward].reverse();
    expect(clausesToServerFilters(forward)).not.toEqual(clausesToServerFilters(reversed));
  });

  it('regrouping does not change which clause is first', () => {
    // The property that makes the sheet safe: a field's first clause in the
    // array starts that field's first BLOCK, blocks come out in
    // first-appearance order, and a clause is first within its own block —
    // so it is still `list[0]` after flattening.
    const list = [
      c('c1', 'status', 'equals', 'DRAFT'),
      c('c2', 'status', 'contains', 'sub'),
      c('c3', 'status', 'equals', 'APPROVED'),
    ];
    expect(sheetOrder(list).map((x) => x.id)).toEqual(['c1', 'c3', 'c2']);
    expectParity(list, { status: { op: 'equals', value: 'DRAFT' } });
  });

  it('holds when the first clause is a valueless op', () => {
    expectParity(
      [c('c1', 'name', 'isEmpty'), c('c2', 'name', 'contains', 'ada'), c('c3', 'name', 'isEmpty')],
      { name: { op: 'isEmpty' } },
    );
  });

  it('holds when the first clause is a date op the aggregator cannot map', () => {
    // Mixed ops → `list[0]` → a date op → no branch matches → the field is
    // absent entirely. Both surfaces must agree on the absence too.
    expectParity(
      [c('c1', 'createdAt', 'within', 'last30'), c('c2', 'createdAt', 'equals', '2026-01-01')],
      {},
    );
  });
});

describe('the whole matrix at once', () => {
  it('agrees on a payload built from every operator', () => {
    // One array exercising all thirteen ops across three fields, with the
    // fields interleaved so the sheet's regrouping is doing real work. The
    // deep-equal is the contract; the literal expectation below it is what
    // stops both sides regressing together.
    const list: FilterClause<F>[] = [
      c('c01', 'status', 'equals', 'DRAFT'),
      c('c02', 'name', 'contains', 'ada'),
      c('c03', 'createdAt', 'within', 'last30'),
      c('c04', 'status', 'equals', 'SUBMITTED'),
      c('c05', 'name', 'doesNotContain', 'bot'),
      c('c06', 'createdAt', 'between', '2026-01-01..2026-02-01'),
      c('c07', 'status', 'doesNotEqual', 'PAID'),
      c('c08', 'name', 'startsWith', 'a'),
      c('c09', 'createdAt', 'on', '2026-01-15'),
      c('c10', 'name', 'endsWith', 'z'),
      c('c11', 'createdAt', 'before', '2026-03-01'),
      c('c12', 'name', 'isEmpty'),
      c('c13', 'createdAt', 'after', '2025-12-01'),
      c('c14', 'name', 'isNotEmpty'),
      c('c15', 'status', 'doesNotEqual', 'VOID'),
    ];

    expect(sheetOrder(list)).not.toEqual(barOrder(list)); // the regrouping is real
    expectParity(list, {
      // status: equals ×2 then doesNotEqual ×2 → mixed → first clause only
      status: { op: 'equals', value: 'DRAFT' },
      // name: contains first, everything after it dropped
      name: { op: 'contains', value: 'ada' },
      // createdAt: all date ops → nothing mappable
    });
  });
});
