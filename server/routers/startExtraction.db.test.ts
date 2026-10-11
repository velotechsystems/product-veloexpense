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
 * VeloExpense: ported with the workbench (w2-02b); ExpenseOS's routing cases arrived with the
 * queue (w3-02a). Each job names its tenant (`organizationId`) — the worker runs it under
 * that tenant's RLS scope.
 */

const { enqueueMock } = vi.hoisted(() => ({ enqueueMock: vi.fn(async () => {}) }));
vi.mock('@expenseos/jobs', () => ({ enqueue: enqueueMock }));
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

  it('routes a single receipt to the synchronous job', async () => {
    enqueueMock.mockClear();
    await expect(expenses.startExtraction({ receiptIds: [ids[0]] })).resolves.toEqual({ ok: true, count: 1 });
    expect(enqueueMock).toHaveBeenCalledTimes(1);
    expect(enqueueMock).toHaveBeenCalledWith('expense.extractReceipt', {
      organizationId: h.orgId,
      receiptId: ids[0],
    });
  });

  it('routes a small selection (≤5) to one synchronous job per receipt', async () => {
    enqueueMock.mockClear();
    const five = ids.slice(0, 5);
    await expenses.startExtraction({ receiptIds: five });
    expect(enqueueMock).toHaveBeenCalledTimes(5);
    for (const id of five) {
      expect(enqueueMock).toHaveBeenCalledWith('expense.extractReceipt', {
        organizationId: h.orgId,
        receiptId: id,
      });
    }
  });

  it('routes a bulk selection (>5) to one batch job', async () => {
    enqueueMock.mockClear();
    await expenses.startExtraction({ receiptIds: ids });
    expect(enqueueMock).toHaveBeenCalledTimes(1);
    const [name, payload] = enqueueMock.mock.calls[0] as unknown as [
      string,
      { organizationId: string; receiptIds: string[] },
    ];
    expect(name).toBe('expense.extractReceipt.batch');
    expect([...payload.receiptIds].sort()).toEqual([...ids].sort());
    // VeloExpense: the batch names its tenant, as every job does.
    expect(payload.organizationId).toBe(h.orgId);
  });

  it('VeloExpense: a queue that does not answer never holds the request', { timeout: 15_000 }, async () => {
    // BullMQ retries a down queue forever; the hand-off gives up after its bound (5 s) and
    // the procedure answers anyway — the receipts stand and can be read again.
    enqueueMock.mockImplementationOnce(() => new Promise<void>(() => {}));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const started = Date.now();
    await expect(expenses.startExtraction({ receiptIds: [ids[0]] })).resolves.toEqual({ ok: true, count: 1 });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(String(warn.mock.calls.at(-1)?.[0])).toMatch(/did not answer/);
    warn.mockRestore();
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
