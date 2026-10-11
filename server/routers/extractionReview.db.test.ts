/* eslint-disable @typescript-eslint/no-explicit-any -- VeloExpense: ExpenseOS's suite reads its rows untyped (`db: any`); Biome allows it there. */
// @vitest-environment node
import { permissions as P } from '@expenseos/rbac';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTenantHarness, type TenantHarness } from '../__test-helpers__/tenantHarness';

/**
 * Integration test for the low-confidence extraction-review flow:
 *   - report() exposes the configurable `extractionReviewThreshold` + the
 *     extraction's `reviewedAt`,
 *   - markExtractionReviewed stamps / clears reviewedAt (toggle),
 *   - only the report owner can mark it. Gated on DATABASE_URL.
 *
 * VeloExpense: ported with the workbench (w2-02b). There is no `DocumentExtraction` until
 * extraction (Wave 3), so ExpenseOS's cases that create one and read it back — the threshold
 * and the low-confidence reading on `report()` and on the approver's view, and the toggle —
 * arrive with it. What holds today: `report()` carries the threshold (ExpenseOS's default)
 * and a receipt with no reading, and the sign-off is the owner's alone.
 */

vi.mock('@/auth', () => ({ auth: vi.fn(async () => null) }));
vi.mock('@/lib/tenant/request', () => ({ hostTenantSlug: async () => null }));

const RW = [
  P.expense.report.readOwn,
  P.expense.report.updateOwn,
  P.expense.report.createOwn,
] as const;

describe.skipIf(!process.env.DATABASE_URL)('extraction review (integration)', () => {
  let h: TenantHarness;
  let db: any;
  let expenses: any;
  let ownerId: string;
  let strangerId: string;
  let reportId: string;
  let receiptId: string;

  beforeAll(async () => {
    h = await createTenantHarness({
      slug: 'extraction-review',
      name: 'Extraction Review',
      people: [{ email: 'stranger@extraction-review.test', name: 'Stranger' }],
    });
    db = h.db;
    ownerId = h.people[0].id;
    strangerId = h.people[1].id;
    expenses = h.makeCaller(RW, ownerId);

    const report = await expenses.create({ title: 'extraction review', currency: 'CAD' });
    const created = await expenses.createExpense({ reportId: report.id });
    reportId = created.reportId;
    const key = `org/${h.orgId}/receipts/${reportId}/test-receipt.jpg`;
    // VeloExpense: `report()` signs a view URL, so the object is in (memory) storage.
    h.storage.memory.put(key, new Uint8Array(1024), 'image/jpeg');
    const receipt = await db.receipt.create({
      data: {
        expenseId: created.id,
        s3Key: key,
        filename: 'r.jpg',
        contentType: 'image/jpeg',
        sizeBytes: 1024,
        status: 'STORED',
        uploadedById: ownerId,
      },
      select: { id: true },
    });
    receiptId = receipt.id;
  });

  afterAll(async () => {
    // VeloExpense: the next suite truncates the tenants; only the pool is ours to close.
    await h?.end();
  });

  it('report() exposes the threshold, and a receipt nothing has read', async () => {
    const detail = await expenses.report({ reportId });
    expect(detail.extractionReviewThreshold).toBe(0.7);
    const receipt = detail.expenses[0].receipts.find((r: { id: string }) => r.id === receiptId);
    expect(receipt).toBeDefined();
    expect(receipt.extraction).toBeNull();
  });

  it('lets the owner sign off', async () => {
    await expect(expenses.markExtractionReviewed({ receiptId })).resolves.toEqual({ ok: true });
    await expect(
      expenses.markExtractionReviewed({ receiptId, reviewed: false }),
    ).resolves.toEqual({ ok: true });
  });

  it('refuses a non-owner', async () => {
    const stranger = h.makeCaller(RW, strangerId);
    await expect(stranger.markExtractionReviewed({ receiptId })).rejects.toThrow();
  });
});
