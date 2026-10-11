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
 * VeloExpense: ExpenseOS's cases on VeloExpense's harness and `document_extraction` (0056,
 * w3-01). Its last case reads the approver's report view (`expenseApprovals.report`), which
 * VeloExpense has not ported yet; it arrives with that view.
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
    // A completed but low-confidence extraction (0.50 < the 0.70 default).
    await db.documentExtraction.create({
      data: { receiptId, status: 'EXTRACTED', scanStatus: 'CLEAN', confidence: 0.5 },
    });
  });

  afterAll(async () => {
    // VeloExpense: the next suite truncates the tenants; only the pool is ours to close.
    await h?.end();
  });

  const extractionOf = async () => {
    const detail = await expenses.report({ reportId });
    return {
      threshold: detail.extractionReviewThreshold as number,
      ext: detail.expenses[0].receipts.find((r: { id: string }) => r.id === receiptId)?.extraction,
    };
  };

  it('report() exposes the threshold and an unreviewed low-confidence extraction', async () => {
    const { threshold, ext } = await extractionOf();
    expect(threshold).toBe(0.7);
    expect(ext.confidence).toBeCloseTo(0.5);
    expect(ext.reviewedAt).toBeNull();
  });

  it('marks the extraction reviewed, then clears it (toggle)', async () => {
    await expenses.markExtractionReviewed({ receiptId });
    expect((await extractionOf()).ext.reviewedAt).not.toBeNull();

    await expenses.markExtractionReviewed({ receiptId, reviewed: false });
    expect((await extractionOf()).ext.reviewedAt).toBeNull();
  });

  it('refuses a non-owner', async () => {
    const stranger = h.makeCaller(RW, strangerId);
    await expect(stranger.markExtractionReviewed({ receiptId })).rejects.toThrow();
  });
});
