// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { createBlankExpensesForReceipts, createReportFromReceipts } from './receiptIntake';

/**
 * What the intake writes onto each new expense besides the placeholders.
 *
 * The email path hands its message body over as both `purpose` and `explanation`; the
 * browser paths hand over neither. Pinned at this layer because both doors share it: a
 * field written by one function and forgotten by the other is a report filed by email that
 * reads differently depending on whether it was the first email or a reply.
 */

const BASE = {
  currencyId: 'cur-1',
  count: 2,
  businessUnitSource: 'EXPENSEOS' as const,
  now: new Date('2026-10-08T00:00:00Z'),
};

function fakeTx() {
  const expenseCreate = vi.fn(async () => ({ id: `e${expenseCreate.mock.calls.length}` }));
  const reportCreate = vi.fn(async () => ({
    id: 'r1',
    number: 'EXP-1',
    expenses: [{ id: 'e1' }, { id: 'e2' }],
  }));
  return {
    tx: { expense: { create: expenseCreate }, expenseReport: { create: reportCreate } } as never,
    expenseCreate,
    reportCreate,
  };
}

describe('createBlankExpensesForReceipts', () => {
  it('writes the note as both the purpose and the explanation of every expense', async () => {
    const { tx, expenseCreate } = fakeTx();
    await createBlankExpensesForReceipts(tx, {
      ...BASE,
      reportId: 'r1',
      ownerId: 'u1',
      purpose: ' Client dinner ',
      explanation: ' Client dinner ',
    });
    expect(expenseCreate).toHaveBeenCalledTimes(2);
    for (const [arg] of expenseCreate.mock.calls as unknown as [{ data: object }][]) {
      expect(arg.data).toMatchObject({ purpose: 'Client dinner', explanation: 'Client dinner' });
    }
  });

  it('writes neither when none is given, as on a browser upload', async () => {
    const { tx, expenseCreate } = fakeTx();
    await createBlankExpensesForReceipts(tx, { ...BASE, reportId: 'r1', ownerId: 'u1' });
    const [[arg]] = expenseCreate.mock.calls as unknown as [{ data: object }][];
    expect(arg.data).not.toHaveProperty('purpose');
    expect(arg.data).not.toHaveProperty('explanation');
  });
});

describe('createReportFromReceipts', () => {
  it('writes the explanation onto every nested expense', async () => {
    const { tx, reportCreate } = fakeTx();
    await createReportFromReceipts(tx, {
      ...BASE,
      submitterId: 'u1',
      // VeloExpense: the tenant-sequence number is the caller's (w2-09).
      number: 'EXP-000001',
      title: 'Emailed receipts',
      purpose: 'Client dinner',
      explanation: 'Client dinner',
    });
    const [[arg]] = reportCreate.mock.calls as unknown as [
      { data: { expenses: { create: object[] } } },
    ][];
    expect(arg.data.expenses.create).toHaveLength(2);
    for (const e of arg.data.expenses.create) {
      expect(e).toMatchObject({ purpose: 'Client dinner', explanation: 'Client dinner' });
    }
  });

  it('treats a blank explanation as none', async () => {
    const { tx, reportCreate } = fakeTx();
    await createReportFromReceipts(tx, {
      ...BASE,
      submitterId: 'u1',
      // VeloExpense: the tenant-sequence number is the caller's (w2-09).
      number: 'EXP-000001',
      title: 'Emailed receipts',
      explanation: '   ',
    });
    const [[arg]] = reportCreate.mock.calls as unknown as [
      { data: { expenses: { create: object[] } } },
    ][];
    expect(arg.data.expenses.create[0]).not.toHaveProperty('explanation');
  });
});
