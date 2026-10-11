// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Reading several receipts uploaded together, in one Anthropic Message Batch.
 *
 * The Batch API is ~half the price and asynchronous, which buys a two-phase state machine
 * carried in the JOB PAYLOAD rather than in a table: no `batchId` means submit, a
 * `batchId` means poll. That choice is what these tests are mostly about, because its
 * failure modes are all silent:
 *
 *   · **One credential for the whole lifecycle.** A batch submitted under one key is
 *     unreadable under another, so the integration is resolved once per invocation —
 *     submit, poll and collect all reach the same account.
 *   · **The poll budget must terminate.** Without the cap a batch that never ends leaves
 *     every receipt stuck EXTRACTING forever, with a spinner and no error.
 *   · **One ready document is a synchronous call.** The batch's latency is not worth
 *     paying for a single receipt somebody is watching upload.
 *   · **Nothing throws.** Every failure is recorded against its own receipt, because one
 *     bad document must not cost the other nine their extraction.
 */

const h = vi.hoisted(() => ({
  // Declared in the hoisted block because the module factory below is hoisted too, and
  // a class at file scope is not initialised by the time it runs.
  Unavailable: class ExtractionUnavailable extends Error {},
  anthropic: null as { apiKey?: string; model?: string } | null,
  retrieve: vi.fn(),
  collect: vi.fn(),
  submit: vi.fn(),
  extract: vi.fn(),
  enqueue: vi.fn(),
  finalize: vi.fn(),
  prepare: vi.fn(),
  prefill: vi.fn(),
  group: vi.fn(),
  receipts: [] as unknown[],
  receiptById: new Map<string, unknown>(),
  threshold: 0.8,
  usage: vi.fn(),
}));

// VeloExpense: the tenant-scoped client lives in `@/lib/db/prisma`, not `@expenseos/db`.
vi.mock('@/lib/db/prisma', () => ({
  db: {
    expenseCategory: { findMany: async () => [{ id: 'cat-1', label: { en: 'Meals' } }] },
    receipt: {
      findMany: async () => h.receipts,
      findUnique: async ({ where }: { where: { id: string } }) =>
        h.receiptById.get(where.id) ?? null,
    },
  },
}));
vi.mock('@expenseos/jobs', () => ({ enqueue: (...a: unknown[]) => h.enqueue(...a) }));
vi.mock('@expenseos/receipt-extraction', () => ({
  DEFAULT_MODEL: 'claude-default',
  ExtractionUnavailableError: h.Unavailable,
  collectReceiptBatch: (...a: unknown[]) => h.collect(...a),
  retrieveReceiptBatch: (...a: unknown[]) => h.retrieve(...a),
  submitReceiptBatch: (...a: unknown[]) => h.submit(...a),
  extractReceipt: (...a: unknown[]) => h.extract(...a),
  collectReceiptBatchItem: vi.fn(),
}));
vi.mock('./lib/anthropic', () => ({ anthropicForExtraction: async () => h.anthropic }));
vi.mock('./lib/extract-core', () => ({
  finalizeExtraction: (...a: unknown[]) => h.finalize(...a),
  prepareExtraction: (...a: unknown[]) => h.prepare(...a),
  // VeloExpense (d43): each model call is recorded in `ai_usage`.
  recordExtractionUsage: (...a: unknown[]) => h.usage(...a),
  message: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));
vi.mock('./lib/group-receipts', () => ({
  groupUploadedReceipts: (...a: unknown[]) => h.group(...a),
}));
vi.mock('./lib/prefill', () => ({
  labelEn: (l: unknown) => (l as { en: string }).en,
  loadReviewThreshold: async () => h.threshold,
  prefillExpense: (...a: unknown[]) => h.prefill(...a),
}));

import { handleExtractReceiptBatch } from './extract-receipt-batch';

const receipt = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  s3Key: `receipts/${id}.pdf`,
  contentType: 'application/pdf',
  expenseId: `exp-${id}`,
  ...over,
});

/** A prepared document, as `prepareExtraction` hands one back. */
const prepared = { data: 'base64', mimeType: 'application/pdf' };

/** VeloExpense: every tenant job carries its tenant (worker/src/lib/tenant.ts). */
const ORG = 'org-1';

const run = (data: Record<string, unknown>) =>
  handleExtractReceiptBatch({ organizationId: ORG, ...data } as never);

/** The receipt ids finalized, in order, with whether each succeeded. */
const finalized = () =>
  h.finalize.mock.calls.map(([target, outcome]) => [
    (target as { receiptId: string }).receiptId,
    (outcome as { ok: boolean }).ok,
  ]);

beforeEach(() => {
  h.anthropic = { apiKey: 'sk-ant-test', model: 'claude-configured' };
  h.retrieve = vi.fn().mockResolvedValue({ status: 'ended' });
  h.collect = vi.fn().mockResolvedValue([]);
  h.submit = vi.fn().mockResolvedValue({ batchId: 'batch-1', model: 'claude-configured' });
  h.extract = vi.fn().mockResolvedValue({ model: 'm', data: { total: 1 }, confidence: 0.9 });
  h.enqueue = vi.fn().mockResolvedValue(undefined);
  h.finalize = vi.fn().mockResolvedValue(undefined);
  h.prepare = vi.fn().mockResolvedValue(prepared);
  h.prefill = vi.fn().mockResolvedValue(undefined);
  h.group = vi.fn().mockResolvedValue({ merged: 0, proposed: 0 });
  h.receipts = [receipt('r1'), receipt('r2')];
  h.receiptById = new Map([
    ['r1', { expenseId: 'exp-r1' }],
    ['r2', { expenseId: 'exp-r2' }],
  ]);
  h.threshold = 0.8;
  h.usage = vi.fn().mockResolvedValue(undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('the credential', () => {
  it('reaches the batch with the integration’s key', async () => {
    /**
     * Resolved once per invocation on purpose: a batch submitted under one key is
     * unreadable under another, so submit, poll and collect must share it.
     */
    await run({ receiptIds: ['r1', 'r2'] });
    expect(h.submit).toHaveBeenCalledWith(expect.anything(), {
      apiKey: 'sk-ant-test',
      model: 'claude-configured',
    });
  });

  it('sends no key at all when the integration is not configured', async () => {
    // The SDK then falls back to the ambient environment, which is the intended path.
    h.anthropic = null;
    await run({ receiptIds: ['r1', 'r2'] });
    expect(h.submit).toHaveBeenCalledWith(expect.anything(), {});
  });

  it('omits the model override when the integration names none', async () => {
    h.anthropic = { apiKey: 'sk-ant-test' };
    await run({ receiptIds: ['r1', 'r2'] });
    expect(h.submit).toHaveBeenCalledWith(expect.anything(), { apiKey: 'sk-ant-test' });
  });
});

describe('the submit phase', () => {
  it('submits the ready documents as one batch, then polls', async () => {
    await run({ receiptIds: ['r1', 'r2'] });
    expect(h.submit).toHaveBeenCalled();
    expect(h.enqueue).toHaveBeenCalledWith(
      'expense.extractReceipt.batch',
      expect.objectContaining({ batchId: 'batch-1', pollAttempt: 0 }),
      expect.objectContaining({ delayMs: expect.any(Number) }),
    );
  });

  it('reads a single ready document synchronously instead', async () => {
    /**
     * The Batch API's latency is not worth paying for one receipt somebody is watching
     * upload — and half of nothing is nothing.
     */
    h.receipts = [receipt('r1')];
    await run({ receiptIds: ['r1'] });
    expect(h.extract).toHaveBeenCalled();
    expect(h.submit).not.toHaveBeenCalled();
    expect(finalized()).toEqual([['r1', true]]);
  });

  it('prefills the expense from a single synchronous read', async () => {
    h.receipts = [receipt('r1')];
    await run({ receiptIds: ['r1'] });
    expect(h.prefill).toHaveBeenCalled();
  });

  it('records a synchronous failure against that receipt', async () => {
    h.receipts = [receipt('r1')];
    h.extract = vi.fn().mockRejectedValue(new Error('bad image'));
    await run({ receiptIds: ['r1'] });
    expect(h.finalize).toHaveBeenCalledWith(
      { receiptId: 'r1' },
      expect.objectContaining({ ok: false, error: 'bad image' }),
    );
  });

  it('marks an extraction outage as such, not as a bad document', async () => {
    /**
     * "Unavailable" is retryable and says nothing about the receipt; conflating it with
     * a failed read would tell somebody their receipt is unreadable when it is fine.
     */
    h.receipts = [receipt('r1')];
    h.extract = vi.fn().mockRejectedValue(new h.Unavailable('rate limited'));
    await run({ receiptIds: ['r1'] });
    expect(h.finalize).toHaveBeenCalledWith(
      { receiptId: 'r1' },
      expect.objectContaining({ ok: false, unavailable: true }),
    );
  });

  it('skips a receipt with no expense to write back to', async () => {
    // An orphaned receipt has nowhere to put an extraction.
    h.receipts = [receipt('r1', { expenseId: null }), receipt('r2')];
    await run({ receiptIds: ['r1', 'r2'] });
    expect(h.prepare).toHaveBeenCalledTimes(1);
  });

  it('leaves a document that is still being scanned out of the batch', async () => {
    /**
     * `prepareExtraction` returns nothing while a virus scan is pending and re-enqueues
     * the receipt as its own self-polling job — including it here would batch a file
     * nobody has cleared yet.
     */
    h.prepare = vi.fn(async ({ where }: { where: { receiptId: string } }) =>
      where.receiptId === 'r1' ? prepared : null,
    );
    await run({ receiptIds: ['r1', 'r2'] });
    expect(h.submit).not.toHaveBeenCalled();
    expect(h.extract).toHaveBeenCalledTimes(1);
  });

  it('does nothing at all when nothing is ready', async () => {
    // The sync fallbacks that prepareExtraction enqueued will pick these up.
    h.prepare = vi.fn().mockResolvedValue(null);
    await run({ receiptIds: ['r1', 'r2'] });
    expect(h.submit).not.toHaveBeenCalled();
    expect(h.extract).not.toHaveBeenCalled();
    expect(h.finalize).not.toHaveBeenCalled();
  });

  it('records a failed submission against every document in it', async () => {
    /**
     * A rejected submission means none of them will ever be read, and leaving them
     * EXTRACTING is the worst outcome — a spinner with no error behind it.
     */
    h.submit = vi.fn().mockRejectedValue(new h.Unavailable('no credit'));
    await run({ receiptIds: ['r1', 'r2'] });
    expect(finalized()).toEqual([
      ['r1', false],
      ['r2', false],
    ]);
    expect(h.finalize.mock.calls[0][1]).toMatchObject({ unavailable: true });
  });

  it('carries only the submitted ids into the poll job', async () => {
    // Polling for a receipt that was never in the batch would never resolve.
    h.prepare = vi.fn(async ({ where }: { where: { receiptId: string } }) =>
      where.receiptId === 'r1' ? prepared : null,
    );
    h.receipts = [receipt('r1'), receipt('r2'), receipt('r3')];
    h.prepare = vi.fn(async ({ where }: { where: { receiptId: string } }) =>
      where.receiptId === 'r3' ? null : prepared,
    );
    await run({ receiptIds: ['r1', 'r2', 'r3'] });
    expect(h.enqueue).toHaveBeenCalledWith(
      'expense.extractReceipt.batch',
      expect.objectContaining({ receiptIds: ['r1', 'r2'] }),
      expect.anything(),
    );
  });
});

describe('the poll phase', () => {
  it('re-enqueues itself while the batch is still running', async () => {
    h.retrieve = vi.fn().mockResolvedValue({ status: 'in_progress' });
    await run({ receiptIds: ['r1'], batchId: 'batch-1', pollAttempt: 3 });
    expect(h.enqueue).toHaveBeenCalledWith(
      'expense.extractReceipt.batch',
      expect.objectContaining({ batchId: 'batch-1', pollAttempt: 4 }),
      expect.objectContaining({ delayMs: 30_000 }),
    );
  });

  it('counts from zero when the attempt is missing', async () => {
    h.retrieve = vi.fn().mockResolvedValue({ status: 'in_progress' });
    await run({ receiptIds: ['r1'], batchId: 'batch-1' });
    expect(h.enqueue).toHaveBeenCalledWith(
      'expense.extractReceipt.batch',
      expect.objectContaining({ pollAttempt: 1 }),
      expect.anything(),
    );
  });

  it('gives up rather than polling forever, and says so on every receipt', async () => {
    /**
     * The cap is the whole reason a batch cannot hang the upload: without it a batch
     * that never ends leaves every receipt EXTRACTING, indefinitely, with no error.
     */
    h.retrieve = vi.fn().mockResolvedValue({ status: 'in_progress' });
    await run({ receiptIds: ['r1', 'r2'], batchId: 'batch-1', pollAttempt: 120 });
    expect(h.enqueue).not.toHaveBeenCalled();
    expect(finalized()).toEqual([
      ['r1', false],
      ['r2', false],
    ]);
    expect(h.finalize.mock.calls[0][1]).toMatchObject({ error: 'batch timed out' });
  });

  it('survives a receipt that cannot even be marked timed out', async () => {
    // Best-effort: one failing write must not abort the rest of the cleanup.
    h.retrieve = vi.fn().mockResolvedValue({ status: 'in_progress' });
    h.finalize = vi.fn().mockRejectedValue(new Error('row gone'));
    await expect(
      run({ receiptIds: ['r1', 'r2'], batchId: 'batch-1', pollAttempt: 120 }),
    ).resolves.toBeUndefined();
  });

  it('records each result, and prefills the ones that read', async () => {
    h.collect = vi.fn().mockResolvedValue([
      { customId: 'r1', data: { total: 4200 }, confidence: 0.91, rawResponse: '{}' },
      { customId: 'r2', data: null, error: 'unreadable' },
    ]);
    await run({ receiptIds: ['r1', 'r2'], batchId: 'batch-1' });
    expect(finalized()).toEqual([
      ['r1', true],
      ['r2', false],
    ]);
    expect(h.prefill).toHaveBeenCalledTimes(1);
  });

  it('stamps the model the batch actually ran, not the default', async () => {
    /**
     * The extraction is auditable, and "which model read this receipt" is part of the
     * record — the payload carries it from submission for exactly that reason.
     */
    h.collect = vi
      .fn()
      .mockResolvedValue([{ customId: 'r1', data: { total: 1 }, rawResponse: '{}' }]);
    await run({ receiptIds: ['r1'], batchId: 'batch-1', model: 'claude-submitted' });
    expect(h.finalize.mock.calls[0][1]).toMatchObject({
      result: expect.objectContaining({ model: 'claude-submitted' }),
    });
  });

  it('falls back to the default model when the payload lost it', async () => {
    h.collect = vi
      .fn()
      .mockResolvedValue([{ customId: 'r1', data: { total: 1 }, rawResponse: '{}' }]);
    await run({ receiptIds: ['r1'], batchId: 'batch-1' });
    expect(h.finalize.mock.calls[0][1]).toMatchObject({
      result: expect.objectContaining({ model: 'claude-default' }),
    });
  });

  it('records a missing confidence as null rather than dropping the field', async () => {
    // Null is "the model did not say"; absent would read as zero downstream.
    h.collect = vi
      .fn()
      .mockResolvedValue([{ customId: 'r1', data: { total: 1 }, rawResponse: '{}' }]);
    await run({ receiptIds: ['r1'], batchId: 'batch-1' });
    expect(h.finalize.mock.calls[0][1]).toMatchObject({
      result: expect.objectContaining({ confidence: null }),
    });
  });

  it('names a failure the batch did not explain', async () => {
    h.collect = vi.fn().mockResolvedValue([{ customId: 'r1', data: null }]);
    await run({ receiptIds: ['r1'], batchId: 'batch-1' });
    expect(h.finalize.mock.calls[0][1]).toMatchObject({ error: 'batch item failed' });
  });

  it('skips prefill for a receipt with no expense', async () => {
    h.receiptById = new Map([['r1', { expenseId: null }]]);
    h.collect = vi
      .fn()
      .mockResolvedValue([{ customId: 'r1', data: { total: 1 }, rawResponse: '{}' }]);
    await run({ receiptIds: ['r1'], batchId: 'batch-1' });
    expect(h.prefill).not.toHaveBeenCalled();
  });

  it('keeps the extraction when the prefill fails', async () => {
    /**
     * The read is the expensive part and it succeeded. Losing it because a category
     * lookup threw would mean paying to read the receipt again.
     */
    h.prefill = vi.fn().mockRejectedValue(new Error('category gone'));
    h.collect = vi
      .fn()
      .mockResolvedValue([{ customId: 'r1', data: { total: 1 }, rawResponse: '{}' }]);
    await expect(run({ receiptIds: ['r1'], batchId: 'batch-1' })).resolves.toBeUndefined();
    expect(h.finalize.mock.calls[0][1]).toMatchObject({ ok: true });
  });
});

describe('grouping, once everything has been read', () => {
  it('looks for duplicates across the whole upload', async () => {
    /**
     * The first moment anything CAN be compared. A restaurant bill and its card copy
     * arrive as two expenses each carrying the full total; this is what stops the meal
     * being claimed twice.
     */
    await run({ receiptIds: ['r1', 'r2'], batchId: 'batch-1' });
    expect(h.group).toHaveBeenCalledWith(['r1', 'r2']);
  });

  it('reports what it merged and what it left for review', async () => {
    h.group = vi.fn().mockResolvedValue({ merged: 1, proposed: 2 });
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    await run({ receiptIds: ['r1', 'r2'], batchId: 'batch-1' });
    expect(info).toHaveBeenCalledWith(expect.stringContaining('1 merged'));
  });

  it('says nothing when it found nothing', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    await run({ receiptIds: ['r1', 'r2'], batchId: 'batch-1' });
    expect(info).not.toHaveBeenCalled();
  });

  it('keeps the extractions when grouping throws', async () => {
    // An over-claim somebody fixes by hand beats losing every extraction in the batch.
    h.group = vi.fn().mockRejectedValue(new Error('grouping broke'));
    await expect(run({ receiptIds: ['r1'], batchId: 'batch-1' })).resolves.toBeUndefined();
  });

  it('does not group after a submission, only after a read', async () => {
    // Nothing has been extracted yet at submit time, so there is nothing to compare.
    await run({ receiptIds: ['r1', 'r2'] });
    expect(h.group).not.toHaveBeenCalled();
  });
});

/**
 * VeloExpense: the worker's tenant scope is per job, so a job this one queues reaches its
 * tenant only through its payload (`inTenant` refuses one without `organizationId`). A
 * dropped id would not fail here — it would fail in the NEXT job, as a dead letter.
 */
describe('the tenant (VeloExpense)', () => {
  it('carries the tenant into the poll job', async () => {
    await run({ receiptIds: ['r1', 'r2'] });
    expect(h.enqueue).toHaveBeenCalledWith(
      'expense.extractReceipt.batch',
      expect.objectContaining({ organizationId: ORG, batchId: 'batch-1' }),
      expect.anything(),
    );
  });

  it('carries the tenant into the next poll', async () => {
    h.retrieve = vi.fn().mockResolvedValue({ status: 'in_progress' });
    await run({ receiptIds: ['r1'], batchId: 'batch-1', pollAttempt: 1 });
    expect(h.enqueue).toHaveBeenCalledWith(
      'expense.extractReceipt.batch',
      expect.objectContaining({ organizationId: ORG, pollAttempt: 2 }),
      expect.anything(),
    );
  });

  it('every job it queues names the tenant', async () => {
    h.receipts = [receipt('r1'), receipt('r2'), receipt('r3')];
    h.prepare = vi.fn(async ({ where }: { where: { receiptId: string } }) =>
      where.receiptId === 'r3' ? null : prepared,
    );
    await run({ receiptIds: ['r1', 'r2', 'r3'] });
    expect(h.enqueue).toHaveBeenCalled();
    for (const [, payload] of h.enqueue.mock.calls) {
      expect(payload).toMatchObject({ organizationId: ORG });
    }
  });
});

/**
 * VeloExpense (d43): one `ai_usage` row per model call. A batch item is a model call at
 * the batch rate; the lone synchronous read is one at the standard rate. A failed item
 * returned no reading, so it is not recorded.
 */
describe('usage (VeloExpense, d43)', () => {
  it('records each read batch item at the batch rate, against its receipt', async () => {
    h.collect = vi.fn().mockResolvedValue([
      { customId: 'r1', data: { total: 4200 }, confidence: 0.91, rawResponse: '{}' },
      { customId: 'r2', data: null, error: 'unreadable' },
    ]);
    await run({ receiptIds: ['r1', 'r2'], batchId: 'batch-1', model: 'claude-submitted' });
    expect(h.usage).toHaveBeenCalledTimes(1);
    expect(h.usage).toHaveBeenCalledWith(
      'r1',
      expect.objectContaining({ model: 'claude-submitted', rawResponse: '{}' }),
      { batch: true },
    );
  });

  it('records the lone synchronous read at the standard rate', async () => {
    h.receipts = [receipt('r1')];
    await run({ receiptIds: ['r1'] });
    expect(h.usage).toHaveBeenCalledTimes(1);
    expect(h.usage.mock.calls[0][0]).toBe('r1');
    expect(h.usage.mock.calls[0][2]).toBeUndefined();
  });

  it('records nothing for a synchronous read that failed', async () => {
    h.receipts = [receipt('r1')];
    h.extract = vi.fn().mockRejectedValue(new Error('bad image'));
    await run({ receiptIds: ['r1'] });
    expect(h.usage).not.toHaveBeenCalled();
  });
});
