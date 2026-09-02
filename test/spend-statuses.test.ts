/**
 * The shared statement of what counts as spend — the guard its own module asks for.
 *
 * No database. These are four lines of arrays and one function, and the reason
 * they get a test file is that TWO features now read them: the budget rollup and
 * analytics. AN-7's most useful sentence is not about FX — it is that their two
 * halves "disagree about whether an unconvertible amount is reportable", because
 * each half decided for itself.
 */
import { describe, it, expect } from 'vitest';
import {
  COMMITTED_STATUSES,
  COUNTED_STATUSES,
  PENDING_STATUSES,
  spendBucketOf,
} from '@/lib/spend/statuses';
import { REPORT_STATUSES } from '@/lib/expenses/service';

describe('the spend buckets partition the counted set', () => {
  it('COUNTED is exactly COMMITTED plus PENDING, with no overlap', () => {
    // Derived rather than retyped in the module, and this is the assertion that
    // it stayed derived: a third hand-written list is the drift being prevented.
    expect([...COUNTED_STATUSES].sort()).toEqual(
      [...COMMITTED_STATUSES, ...PENDING_STATUSES].sort(),
    );
    const overlap = COMMITTED_STATUSES.filter((s) =>
      (PENDING_STATUSES as readonly string[]).includes(s),
    );
    expect(overlap).toEqual([]);
  });

  it('every counted status is a real report status', () => {
    for (const status of COUNTED_STATUSES) {
      expect(REPORT_STATUSES as readonly string[]).toContain(status);
    }
  });

  it('names the statuses that are NOT spend, so a new one is a visible decision', () => {
    // The same shape as the notification catalogue's pinned event list. A status
    // added to the enum and silently counted as spend would move every budget and
    // every chart at once, with nothing recording that anybody chose it.
    const notSpend = (REPORT_STATUSES as readonly string[]).filter(
      (s) => !(COUNTED_STATUSES as readonly string[]).includes(s),
    );
    expect(notSpend.sort()).toEqual(['DRAFT', 'REJECTED', 'RETURNED']);
  });

  it('buckets each status, and answers null for the ones that are not spend', () => {
    expect(spendBucketOf('APPROVED')).toBe('COMMITTED');
    expect(spendBucketOf('REIMBURSED')).toBe('COMMITTED');
    expect(spendBucketOf('SUBMITTED')).toBe('PENDING');
    for (const status of ['DRAFT', 'REJECTED', 'RETURNED', 'NONSENSE']) {
      expect(spendBucketOf(status), status).toBeNull();
    }
  });
});
