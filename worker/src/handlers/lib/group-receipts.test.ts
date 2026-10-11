import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The database half of grouping. The decision itself is tested in
 * `@expenseos/receipt-extraction`; what matters here is that a merge moves the
 * documents, deletes only genuinely empty shells, and hands the survivor to the
 * joint determination — and that an inconclusive group is left completely alone.
 *
 * The shell delete is the one destructive act in the whole feature, so most of this
 * is about when it does and does not happen.
 */

const h = vi.hoisted(() => ({
  db: {
    receipt: { findMany: vi.fn(), updateMany: vi.fn(), count: vi.fn() },
    expense: { findUniqueOrThrow: vi.fn(), delete: vi.fn() },
    $transaction: vi.fn(),
    // The report row lock + status re-read the merge takes before moving anything.
    $queryRaw: vi.fn(),
  },
  enqueue: vi.fn(),
  recomputeReportTotal: vi.fn(),
  tenant: 'org-1' as string | null,
}));

vi.mock('@expenseos/db', () => ({
  recomputeReportTotal: h.recomputeReportTotal,
}));
// VeloExpense: the tenant-scoped client lives in `@/lib/db/prisma`, with the job's tenant.
vi.mock('@/lib/db/prisma', () => ({ db: h.db, currentTenantId: () => h.tenant }));
vi.mock('@expenseos/jobs', () => ({ enqueue: h.enqueue }));
vi.mock('./extract-core', () => ({ message: (e: unknown) => String(e) }));

const { groupUploadedReceipts } = await import('./group-receipts');

/** A receipt row as the loader selects it. */
function row(over: Record<string, unknown> = {}) {
  return {
    id: 'r1',
    expenseId: 'e1',
    kind: 'ITEMIZED_BILL',
    extraction: {
      confidence: 0.95,
      data: {
        vendor: 'Joe’s Pizza',
        date: '2026-08-05',
        currencyCode: 'CAD',
        total: 113,
        subtotal: 100,
      },
    },
    ...over,
  };
}

const BILL = row({ id: 'r-bill', expenseId: 'e-bill' });
const CARD = row({
  id: 'r-card',
  expenseId: 'e-card',
  kind: 'CARD_COPY',
  extraction: {
    confidence: 0.95,
    data: { vendor: 'Joe’s Pizza', date: '2026-08-05', currencyCode: 'CAD', total: 130 },
  },
});

beforeEach(() => {
  vi.clearAllMocks();
  h.db.expense.findUniqueOrThrow.mockResolvedValue({ reportId: 'rep-1' });
  // Run the transaction body against the same mock surface.
  h.db.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(h.db));
  h.db.receipt.count.mockResolvedValue(0);
  h.db.$queryRaw.mockResolvedValue([{ status: 'DRAFT' }]);
  h.enqueue.mockResolvedValue(undefined);
});

describe('groupUploadedReceipts', () => {
  it('moves the bill onto the card copy and deletes the emptied shell', async () => {
    h.db.receipt.findMany.mockResolvedValue([BILL, CARD]);
    const out = await groupUploadedReceipts(['r-bill', 'r-card']);

    expect(out).toEqual({ merged: 1, proposed: 0 });
    // The CARD COPY survives: its total is the amount actually charged.
    expect(h.db.receipt.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['r-bill'] } },
      data: { expenseId: 'e-card' },
    });
    expect(h.db.expense.delete).toHaveBeenCalledWith({ where: { id: 'e-bill' } });
    expect(h.enqueue).toHaveBeenCalledWith('expense.determineExpense', {
      organizationId: 'org-1',
      expenseId: 'e-card',
    });
    expect(h.recomputeReportTotal).toHaveBeenCalledWith(h.db, 'rep-1');
  });

  it('leaves a report alone once it has been submitted', async () => {
    /**
     * Batch extraction can land an hour after the upload, by which time the person may
     * have submitted. A merge moves documents and deletes an expense — a change to the
     * filed claim — so a report that is no longer DRAFT/RETURNED is left as filed, and
     * the group is reported as "proposed" rather than silently dropped.
     */
    h.db.receipt.findMany.mockResolvedValue([BILL, CARD]);
    h.db.$queryRaw.mockResolvedValue([{ status: 'SUBMITTED' }]);
    const out = await groupUploadedReceipts(['r-bill', 'r-card']);

    expect(out).toEqual({ merged: 0, proposed: 1 });
    expect(h.db.receipt.updateMany).not.toHaveBeenCalled();
    expect(h.db.expense.delete).not.toHaveBeenCalled();
    expect(h.enqueue).not.toHaveBeenCalled();
    expect(h.recomputeReportTotal).not.toHaveBeenCalled();
  });

  it('keeps a vacated expense that still holds another document', async () => {
    // A concurrent upload could have added a file to it. Deleting the row would
    // take that file with it.
    h.db.receipt.findMany.mockResolvedValue([BILL, CARD]);
    h.db.receipt.count.mockResolvedValue(1);
    await groupUploadedReceipts(['r-bill', 'r-card']);
    expect(h.db.expense.delete).not.toHaveBeenCalled();
  });

  it('leaves an inconclusive group completely alone', async () => {
    const shaky = { ...CARD, extraction: { ...CARD.extraction, confidence: 0.3 } };
    h.db.receipt.findMany.mockResolvedValue([BILL, shaky]);
    const out = await groupUploadedReceipts(['r-bill', 'r-card']);

    expect(out).toEqual({ merged: 0, proposed: 1 });
    expect(h.db.receipt.updateMany).not.toHaveBeenCalled();
    expect(h.db.expense.delete).not.toHaveBeenCalled();
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it('does not merge two identical purchases with different transaction ids', async () => {
    const a = row({
      id: 'w1',
      expenseId: 'e-w1',
      kind: 'RECEIPT',
      extraction: {
        confidence: 0.95,
        data: {
          vendor: 'Kiosk',
          date: '2026-08-05',
          currencyCode: 'CAD',
          total: 4.5,
          transactionId: '000871',
        },
      },
    });
    const b = row({
      id: 'w2',
      expenseId: 'e-w2',
      kind: 'RECEIPT',
      extraction: {
        confidence: 0.95,
        data: {
          vendor: 'Kiosk',
          date: '2026-08-05',
          currencyCode: 'CAD',
          total: 4.5,
          transactionId: '000944',
        },
      },
    });
    h.db.receipt.findMany.mockResolvedValue([a, b]);
    expect(await groupUploadedReceipts(['w1', 'w2'])).toEqual({ merged: 0, proposed: 0 });
    expect(h.db.receipt.updateMany).not.toHaveBeenCalled();
  });

  it('does nothing for a single-file upload, without querying', async () => {
    expect(await groupUploadedReceipts(['only'])).toEqual({ merged: 0, proposed: 0 });
    expect(h.db.receipt.findMany).not.toHaveBeenCalled();
  });

  it('skips a receipt whose extraction never landed rather than guessing', async () => {
    h.db.receipt.findMany.mockResolvedValue([BILL, { ...CARD, extraction: null }]);
    expect(await groupUploadedReceipts(['r-bill', 'r-card'])).toEqual({ merged: 0, proposed: 0 });
  });

  it('survives a failed merge without throwing', async () => {
    // The receipts and expenses are already persisted; an over-claim to fix by hand
    // beats losing the extractions.
    h.db.receipt.findMany.mockResolvedValue([BILL, CARD]);
    h.db.$transaction.mockRejectedValue(new Error('deadlock'));
    expect(await groupUploadedReceipts(['r-bill', 'r-card'])).toEqual({ merged: 0, proposed: 0 });
  });
});

describe('groupUploadedReceipts · the tenant (VeloExpense)', () => {
  it('refuses to run outside a tenant scope, before reading or moving anything', async () => {
    h.tenant = null;
    try {
      await expect(groupUploadedReceipts(['r-bill', 'r-card'])).rejects.toThrow(/no tenant scope/);
      expect(h.db.receipt.findMany).not.toHaveBeenCalled();
    } finally {
      h.tenant = 'org-1';
    }
  });
});
