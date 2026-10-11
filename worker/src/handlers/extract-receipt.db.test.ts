// @vitest-environment node
/* eslint-disable @typescript-eslint/no-explicit-any -- the harness reads rows untyped */
import { permissions as P } from '@expenseos/rbac';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTenantHarness, type TenantHarness } from '../../../server/__test-helpers__/tenantHarness';

/**
 * VeloExpense (w3-02a): one receipt read end to end, the way the worker runs it.
 *
 * Not an ExpenseOS test — ExpenseOS's handler tests stub the database. This one runs the
 * ported handler for real against Postgres through VeloExpense's plumbing, because that
 * plumbing is the part that is new: the job runs as its tenant (`inTenant`, statement at a
 * time, as `veloapp` under RLS), reads the stored bytes through `lib/storage`, records the
 * call in `ai_usage`, and leaves the reading, the prefilled expense and the determination
 * where the web app reads them. Only the model is a stand-in.
 */

const h0 = vi.hoisted(() => ({
  extractReceipt: vi.fn(),
  seenInFlight: [] as string[],
}));

vi.mock('@/auth', () => ({ auth: vi.fn(async () => null) }));
vi.mock('@/lib/tenant/request', () => ({ hostTenantSlug: async () => null }));
vi.mock('@expenseos/receipt-extraction', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@expenseos/receipt-extraction')>()),
  extractReceipt: h0.extractReceipt,
  // Passthrough: the bytes are a fixture, not an image sharp can decode.
  sharpNormalizer: { normalize: async (data: Uint8Array, mimeType: string) => ({ data, mimeType }) },
}));

const RW = [P.expense.report.readOwn, P.expense.report.createOwn, P.expense.report.updateOwn] as const;

describe.skipIf(!process.env.DATABASE_URL)('expense.extractReceipt, end to end (integration)', () => {
  let h: TenantHarness;
  let db: any;
  let categoryId: string;
  let ownerId: string;
  let run: (receiptId: string) => Promise<void>;

  async function receiptOnBlankExpense(): Promise<{ expenseId: string; receiptId: string }> {
    const caller = h.makeCaller(RW, ownerId);
    const report = await caller.create({ title: `read ${Date.now()}`, currency: 'CAD' });
    const { id: expenseId } = await caller.createExpense({ reportId: report.id });
    const key = `receipts/e2e/${expenseId}.jpg`;
    h.storage.memory.put(key, new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3]), 'image/jpeg');
    const { id: receiptId } = await db.receipt.create({
      data: {
        expenseId,
        s3Key: key,
        filename: 'r.jpg',
        contentType: 'image/jpeg',
        sizeBytes: 6,
        uploadedById: ownerId,
        status: 'STORED',
      },
      select: { id: true },
    });
    return { expenseId, receiptId };
  }

  beforeAll(async () => {
    h = await createTenantHarness({ slug: 'read-e2e', name: 'Read E2E' });
    db = h.db;
    ownerId = h.people[0].id;
    categoryId = (
      await db.expenseCategory.create({ data: { label: { en: 'Read meals' } }, select: { id: true } })
    ).id;
    const { handleExtractReceipt } = await import('./extract-receipt');
    const { inTenant } = await import('../lib/tenant');
    run = (receiptId) =>
      inTenant({ organizationId: h.orgId, receiptId }, () =>
        handleExtractReceipt({ organizationId: h.orgId, receiptId }, { attemptsMade: 0, opts: { attempts: 5 } }),
      );
    process.env.ANTHROPIC_API_KEY = 'sk-test';
  });

  afterAll(async () => {
    delete process.env.ANTHROPIC_API_KEY;
    await h?.end();
  });

  it('reads the receipt, prefills the expense, records the call and the determination', async () => {
    const { expenseId, receiptId } = await receiptOnBlankExpense();
    h0.extractReceipt.mockImplementationOnce(async () => {
      // While the model "works", the reading is already committed as EXTRACTING — what
      // the workbench and `submit` read from their own connections.
      const row = (
        await h.admin.query('SELECT status FROM document_extraction WHERE receipt_id = $1', [receiptId])
      ).rows[0];
      h0.seenInFlight.push(row?.status);
      return {
        model: 'claude-sonnet-5',
        confidence: 0.93,
        rawResponse: { id: 'msg_e2e', usage: { input_tokens: 2000, output_tokens: 300 } },
        data: {
          vendor: 'Le Bremner',
          address: '1 King St W, Toronto',
          date: '2026-09-14',
          currencyCode: 'CAD',
          total: 56.5,
          subtotal: 50,
          taxGstHst: 6.5,
          taxQst: null,
          taxPst: null,
          voluntaryTip: null,
          confidence: 0.93,
          derivedCategoryCode: categoryId,
          lineItems: [],
          transactionId: 'AUTH-777',
        },
      };
    });

    await run(receiptId);

    expect(h0.seenInFlight).toEqual(['EXTRACTING']);
    const reading = await db.documentExtraction.findFirstOrThrow({ where: { receiptId } });
    expect(reading).toMatchObject({ status: 'EXTRACTED', scanStatus: 'CLEAN', model: 'claude-sonnet-5' });

    const expense = await db.expense.findUniqueOrThrow({
      where: { id: expenseId },
      select: { merchant: true, amountMinor: true, taxSource: true, lineItems: { select: { categoryId: true } } },
    });
    expect(expense).toMatchObject({ merchant: 'Le Bremner', amountMinor: 5650n, taxSource: 'EXTRACTED' });
    expect(expense.lineItems.map((l: { categoryId: string }) => l.categoryId)).toEqual([categoryId]);

    const usage = await db.aiUsage.findMany({ where: { receiptId } });
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({
      organizationId: h.orgId,
      feature: 'receipt_extraction',
      inputTokens: 2000,
      outputTokens: 300,
      metered: false,
      requestId: 'msg_e2e',
      reportedAt: null,
    });

    const determination = await db.expenseDetermination.findFirstOrThrow({ where: { expenseId } });
    expect(determination.receiptIds).toEqual([receiptId]);
    expect(await db.expenseExternalId.count({ where: { expenseId, sourceValue: 'AUTH-777' } })).toBe(1);
  });

  it("records a person's later correction against the determination, for the next pass to keep", async () => {
    // The web half of rule 2: `noteOverrides` (expenses.updateExpense) writes to the
    // determination this handler recorded, inside the request's own transaction.
    const expenseId = (await db.expenseDetermination.findFirstOrThrow({ select: { expenseId: true } })).expenseId;
    await h.makeCaller(RW, ownerId).updateExpense({ expenseId, merchant: 'Bremner (corrected)' });
    const current = await db.expenseDetermination.findFirstOrThrow({
      where: { expenseId, supersededById: null },
      select: { overrides: true },
    });
    expect(current.overrides).toMatchObject({ merchant: 'Bremner (corrected)' });
  });

  it('parks the reading PENDING, and spends nothing, when no key is configured', async () => {
    const { receiptId } = await receiptOnBlankExpense();
    delete process.env.ANTHROPIC_API_KEY;
    const { ExtractionUnavailableError } = await import('@expenseos/receipt-extraction');
    h0.extractReceipt.mockRejectedValueOnce(new ExtractionUnavailableError('ANTHROPIC_API_KEY is not set'));
    try {
      await run(receiptId);
    } finally {
      process.env.ANTHROPIC_API_KEY = 'sk-test';
    }
    expect(await db.documentExtraction.findFirstOrThrow({ where: { receiptId } })).toMatchObject({
      status: 'PENDING',
    });
    expect(await db.aiUsage.count({ where: { receiptId } })).toBe(0);
  });

  it('runs as its tenant: another tenant\'s receipt id is not there to read', async () => {
    const other = '00000000-0000-4000-8000-0000000000aa';
    await expect(
      (async () => {
        const { handleExtractReceipt } = await import('./extract-receipt');
        const { inTenant } = await import('../lib/tenant');
        const { receiptId } = await receiptOnBlankExpense();
        // The right receipt id, the wrong tenant: RLS hides it, so the job does nothing.
        await inTenant({ organizationId: other, receiptId }, () =>
          handleExtractReceipt({ organizationId: other, receiptId }),
        );
        return db.documentExtraction.count({ where: { receiptId } });
      })(),
    ).resolves.toBe(0);
  });
});
