import { describe, expect, it } from 'vitest';
import { STATUS_VARIANT, STATUSES, travelBudgetMinor } from './_shared';

describe('STATUSES', () => {
  it('lists every travel-request status in lifecycle order', () => {
    /** Order is load-bearing: it is the order the filter pill offers, and a
     *  reader scanning a dropdown expects the lifecycle, not the alphabet. */
    expect(STATUSES).toEqual([
      'DRAFT',
      'SUBMITTED',
      'APPROVED',
      'REJECTED',
      'RETURNED',
      'CANCELLED',
    ]);
  });
});

describe('STATUS_VARIANT', () => {
  it.each([
    ['DRAFT', 'secondary'],
    // Waiting on the approver…
    ['SUBMITTED', 'warning'],
    ['APPROVED', 'success'],
    ['REJECTED', 'destructive'],
    // …and waiting on the requester. Both are somebody's open item, so both are amber.
    ['RETURNED', 'warning'],
    // Withdrawn, not failed — grey, never red.
    ['CANCELLED', 'secondary'],
  ])('maps travel status %s → %s', (status, variant) => {
    expect(STATUS_VARIANT[status]).toBe(variant);
  });

  it('gives every status in STATUSES a variant', () => {
    /** The two constants are consumed side by side — a filter offers a status the
     *  badge map has never heard of, and that status renders as the fallback grey
     *  next to a genuinely-grey DRAFT. */
    for (const status of STATUSES) {
      expect(STATUS_VARIANT[status], status).toBeDefined();
    }
  });

  it('exposes no variant beyond the six statuses', () => {
    expect(Object.keys(STATUS_VARIANT).sort()).toEqual([...STATUSES].sort());
  });

  it('returns undefined for an unknown status (consumers fall back to secondary)', () => {
    expect(STATUS_VARIANT.UNKNOWN).toBeUndefined();
  });
});

describe('travelBudgetMinor', () => {
  const lines = [{ amountMinor: 30000n }, { amountMinor: 12550n }];

  it('sums the budget lines while nobody has approved the trip', () => {
    /** The number the decision is about. A blank until approval would hide it. */
    expect(travelBudgetMinor({ approvedTotalMinor: null, budgetLines: lines })).toBe(42550n);
  });

  it('prefers the approver’s snapshot once there is one', () => {
    // The snapshot is what was APPROVED; the lines may have moved since, and the
    // approved figure is the one that binds.
    expect(travelBudgetMinor({ approvedTotalMinor: 40000n, budgetLines: lines })).toBe(40000n);
  });

  it('is zero, not a throw, for a trip with no lines yet', () => {
    /** A draft opened and not yet filled in. It is still the traveller's request and
     *  still has to render — filtering it is how an empty trip becomes an invisible one. */
    expect(travelBudgetMinor({ approvedTotalMinor: null, budgetLines: [] })).toBe(0n);
  });

  it('accepts a snapshot of zero as a real figure, not as absent', () => {
    // `!= null` rather than a falsy test: an approver who cut every line to nothing
    // approved ZERO, and falling through to the lines would report the ask instead.
    expect(travelBudgetMinor({ approvedTotalMinor: 0n, budgetLines: lines })).toBe(0n);
  });

  it('reads string minor units the same as bigints', () => {
    expect(travelBudgetMinor({ approvedTotalMinor: '40000', budgetLines: [] })).toBe(40000n);
    expect(
      travelBudgetMinor({ approvedTotalMinor: null, budgetLines: [{ amountMinor: '250' }] }),
    ).toBe(250n);
  });
});
