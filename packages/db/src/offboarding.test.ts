import { describe, expect, it, vi } from 'vitest';
import { rollUpOnOffboard } from './offboarding';

// VeloExpense: ported from ExpenseOS (1e682dd6) without the card halves — virtual cards are
// out of scope (7 Oct 2026). Added: no card table is touched at all.

/** Fake Prisma capturing the writes rollUpOnOffboard issues. */
function fakeDb(opts: { managerId: string | null; cardCount?: number; reportCount?: number }) {
  const cardUpdateMany = vi.fn(async () => ({ count: opts.cardCount ?? 0 }));
  const reportUpdateMany = vi.fn(async () => ({ count: opts.reportCount ?? 0 }));
  const reportCount = vi.fn(async () => opts.reportCount ?? 0);
  const db = {
    user: { findUnique: async () => ({ managerId: opts.managerId }) },
    virtualCard: { updateMany: cardUpdateMany },
    expenseReport: { updateMany: reportUpdateMany, count: reportCount },
  } as never;
  return { db, cardUpdateMany, reportUpdateMany, reportCount };
}

describe('rollUpOnOffboard', () => {
  it('with a manager: reassigns open reports to the manager', async () => {
    const { db, cardUpdateMany, reportUpdateMany } = fakeDb({
      managerId: 'mgr',
      cardCount: 2,
      reportCount: 3,
    });
    const summary = await rollUpOnOffboard(db, 'dep');
    expect(summary).toEqual({
      managerId: 'mgr',
      reportsToManager: 3,
      reportsOrphaned: 0,
    });
    expect(cardUpdateMany).not.toHaveBeenCalled();
    // Open reports move to the manager.
    expect(reportUpdateMany).toHaveBeenCalledWith({
      where: { submitterId: 'dep', status: { in: ['DRAFT', 'SUBMITTED', 'RETURNED'] } },
      data: { submitterId: 'mgr' },
    });
  });

  it('without a manager: leaves reports orphaned', async () => {
    const { db, cardUpdateMany, reportUpdateMany, reportCount } = fakeDb({
      managerId: null,
      cardCount: 1,
      reportCount: 2,
    });
    const summary = await rollUpOnOffboard(db, 'dep');
    expect(summary).toEqual({
      managerId: null,
      reportsToManager: 0,
      reportsOrphaned: 2,
    });
    expect(cardUpdateMany).not.toHaveBeenCalled();
    // Orphaned reports are counted, not moved.
    expect(reportUpdateMany).not.toHaveBeenCalled();
    expect(reportCount).toHaveBeenCalled();
  });
});
