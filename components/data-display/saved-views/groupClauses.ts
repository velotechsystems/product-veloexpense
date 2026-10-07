/**
 * `field::op` grouping — the one definition of what a filter BLOCK is.
 *
 * A block is every clause that shares a field AND an operator, which is what
 * lets `<FilterBlock>` draw "Status equals Draft or Submitted" as one pill
 * with two values instead of two pills that look like an impossible AND.
 * Two clauses on the same field with DIFFERENT operators are two blocks —
 * "Name contains foo" and "Name doesn't equal bar" are not alternatives to
 * each other.
 *
 * WHY IT IS A MODULE. This was eight lines inline in `<FilterPillBar>`. The
 * mobile sheet needs the identical partition — the same clauses grouped the
 * same way, in the same order — and a second copy of eight lines is a
 * grouping that agrees today and drifts the first time either side is
 * touched. When it drifts, the two surfaces disagree about how many filters
 * are active and about which values are joined by `or`, which is the
 * difference between "Status is Submitted or Approved" reading as one filter
 * or as two. So the bar and the sheet call this, and neither keeps a copy.
 *
 * ORDER IS PART OF THE CONTRACT, not an implementation detail:
 *
 *   - Groups come back in first-appearance order (the order their first
 *     clause appears in the input).
 *   - Clauses inside a group keep their relative input order.
 *
 * Both matter downstream. `clausesToServerFilters` in the web app collapses
 * same-field clauses by FIELD alone — a coarser partition than this one —
 * and its mixed-operator branch sends `list[0]` and drops the rest. A
 * regrouping that reordered clauses would therefore change which filter the
 * server is asked for, silently. `apps/web/src/components/data-view/
 * filterParity.test.ts` pins that the two partitions agree on the payload.
 */

import type { FilterClause, FilterOp } from '../filters/types';

/** One `<FilterBlock>`'s worth of clauses. */
export interface ClauseGroup<F extends string = string> {
  field: F;
  op: FilterOp;
  clauses: FilterClause<F>[];
}

/**
 * Stable key for a group — also the React key both surfaces render with, so
 * a clause moving between surfaces does not remount its block.
 */
export function clauseGroupKey<F extends string>(group: { field: F; op: FilterOp }): string {
  return `${group.field}::${group.op}`;
}

/**
 * Partition clauses into blocks by `field::op`. See the module note for the
 * ordering guarantees, which callers rely on.
 *
 * `.length` is also the number a person would say is active — the mobile
 * trigger reads `Filters · 3` off this list and never off `filters.length`,
 * because "Status is Submitted or Approved" is one filter to whoever set it
 * and reporting 2 would describe a screen they cannot see.
 */
export function groupClauses<F extends string>(
  filters: readonly FilterClause<F>[],
): ClauseGroup<F>[] {
  const groups = new Map<string, ClauseGroup<F>>();
  for (const c of filters) {
    const key = clauseGroupKey(c);
    if (!groups.has(key)) groups.set(key, { field: c.field, op: c.op, clauses: [] });
    groups.get(key)?.clauses.push(c);
  }
  return Array.from(groups.values());
}
