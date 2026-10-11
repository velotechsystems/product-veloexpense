/* eslint-disable @typescript-eslint/no-explicit-any -- VeloExpense: ExpenseOS's suite reads its rows untyped (`db: any`); Biome allows it there. */
// @vitest-environment node
import { permissions as P } from '@expenseos/rbac';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTenantHarness, type TenantHarness } from '../__test-helpers__/tenantHarness';

/**
 * `expenses.startExtraction` routing: one receipt → a synchronous
 * `expense.extractReceipt` job; several uploaded together → one batched
 * `expense.extractReceipt.batch` job. Owner-gated. `enqueue` is mocked, so we
 * assert the job name + payload without a live queue. Gated on DATABASE_URL.
 *
 * VeloExpense: ported with the workbench (w2-02b), which calls `startExtraction` after every
 * upload. Its `enqueue` hands the jobs to nothing until extraction (Wave 3) and is not a
 * module that can be mocked, so ExpenseOS's three routing cases — which job, how many —
 * arrive with the queue. What holds today is pinned instead: the procedure answers for
 * every receipt it was given, and the owner gate.
 */

vi.mock('@/auth', () => ({ auth: vi.fn(async () => null) }));
vi.mock('@/lib/tenant/request', () => ({ hostTenantSlug: async () => null }));

const RW = [
  P.expense.report.readOwn,
  P.expense.report.updateOwn,
  P.expense.report.createOwn,
] as const;

describe.skipIf(!process.env.DATABASE_URL)('expenses.startExtraction routing', () => {
  let h: TenantHarness;
  let db: any;
  let expenses: any;
  let ownerId: string;
  let strangerId: string;
  let ids: string[] = [];

  beforeAll(async () => {
    h = await createTenantHarness({
      slug: 'start-extraction',
      name: 'Start Extraction',
      people: [{ email: 'stranger@start-extraction.test', name: 'Stranger' }],
    });
    db = h.db;
    ownerId = h.people[0].id;
    strangerId = h.people[1].id;
    expenses = h.makeCaller(RW, ownerId);

    const report = await expenses.create({ title: 'start extraction', currency: 'CAD' });
    const created = await expenses.createExpense({ reportId: report.id });
    const mk = async (n: number) =>
      (
        await db.receipt.create({
          data: {
            expenseId: created.id,
            s3Key: `org/${h.orgId}/receipts/${report.id}/r${n}.jpg`,
            filename: `r${n}.jpg`,
            contentType: 'image/jpeg',
            sizeBytes: 1024,
            uploadedById: ownerId,
          },
          select: { id: true },
        })
      ).id;
    // Six receipts: enough to exercise both sides of the 5-file batch threshold.
    ids = [];
    for (let n = 1; n <= 6; n++) ids.push(await mk(n));
  });

  afterAll(async () => {
    // VeloExpense: the next suite truncates the tenants; only the pool is ours to close.
    await h?.end();
  });

  it('answers for a single receipt', async () => {
    await expect(expenses.startExtraction({ receiptIds: [ids[0]] })).resolves.toEqual({
      ok: true,
      count: 1,
    });
  });

  it('answers for a bulk selection (>5), every receipt counted', async () => {
    await expect(expenses.startExtraction({ receiptIds: ids })).resolves.toEqual({
      ok: true,
      count: 6,
    });
  });

  it('refuses receipts the caller does not own', async () => {
    const stranger = h.makeCaller(RW, strangerId);
    await expect(stranger.startExtraction({ receiptIds: [ids[0]] })).rejects.toThrow();
  });

  it('refuses a selection with one receipt that is not there', async () => {
    // VeloExpense: the count check ExpenseOS's gate starts with, pinned on its own.
    await expect(
      expenses.startExtraction({ receiptIds: [ids[0], '00000000-0000-7000-8000-0000000000ee'] }),
    ).rejects.toThrow(/NOT_FOUND/);
  });
});
