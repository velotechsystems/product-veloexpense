// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A returned-but-empty extraction is a FAILURE, and is recorded as one.
 *
 * The model is called with a FORCED tool call, so it always returns something — including for
 * an unreadable image, where it comes back with every field null and a confidence of 0. That
 * was written as `EXTRACTED`, so a 4000x4000 noise JPG got a green "Extracted" badge and an
 * "AI: 0%" chip (GA readiness report F10), and nothing downstream could tell "read the receipt
 * and is certain of nothing" from "there was nothing to read".
 *
 * Fixed at the source rather than in the badge: the stored status was lying to every consumer
 * and the badge was only the first one to read it.
 *
 * Ported from ExpenseOS's `apps/worker/src/handlers/lib/extract-core.test.ts` (550b2945).
 * VeloExpense: `db` is mocked where VeloExpense's comes from (`@/lib/db/prisma`), with the
 * `ai_usage` writer beside it (d43); storage is `@/lib/storage`'s `getStorage()`, whose HEAD
 * answers `sizeBytes`.
 */

const h = {
  update: vi.fn(async (_arg: { where: unknown; data: Record<string, unknown> }) => ({})),
  // `prepareExtraction` owns the satellite row and upserts it before anything else runs.
  upsert: vi.fn(async () => ({ id: 'doc-1', scanStatus: 'CLEAN' })),
  // The bytes arrive through the bounded read (`guardedRead`, real, from its own subpath),
  // so `head` and `read` are the seams. Explicit defaults: a bare `vi.fn()` HEAD would
  // return `undefined` and hide a fail-open.
  head: vi.fn(async () => ({ sizeBytes: 1024, contentType: 'image/png' })),
  read: vi.fn(async () => ({ ok: true, data: new Uint8Array([1]) })),
  aiUsage: vi.fn(async (_arg: { data: Record<string, unknown> }) => ({})),
};

vi.mock('@/lib/db/prisma', () => ({
  db: { documentExtraction: { update: h.update, upsert: h.upsert }, aiUsage: { create: h.aiUsage } },
}));
vi.mock('@expenseos/db', () => ({
  DocExtractStatus: { EXTRACTED: 'EXTRACTED', FAILED: 'FAILED', PENDING: 'PENDING' },
  DocScanStatus: { PENDING: 'PENDING', SCANNING: 'SCANNING', CLEAN: 'CLEAN', INFECTED: 'INFECTED' },
  Prisma: {},
}));
vi.mock('@expenseos/receipt-extraction', () => ({
  ExtractionUnavailableError: class extends Error {},
  extractReceipt: vi.fn(),
  sharpNormalizer: { normalize: vi.fn() },
  // Real behaviour, not a stub: the retry decision is the thing under test below, and a
  // stub that always said `true` would make both of those tests pass on nothing.
  isTransientExtractionFailure: (err: unknown) =>
    /rate limit|overloaded|credit balance|timed out/i.test(
      err instanceof Error ? err.message : String(err),
    ),
}));
vi.mock('@/lib/storage', () => ({
  getStorage: () => ({
    head: h.head,
    read: h.read,
    getMalwareScanStatus: vi.fn(async () => 'CLEAN'),
  }),
}));

const { finalizeExtraction, prepareExtraction, runDocumentExtraction } = await import(
  './extract-core'
);
const rx = await import('@expenseos/receipt-extraction');

const KEY = { documentId: 'doc-1' } as never;
const lastUpdate = () => h.update.mock.calls.at(-1)?.[0].data as Record<string, unknown>;

const RESULT = (over: Record<string, unknown> = {}) => ({
  model: 'claude-sonnet-5',
  confidence: 0.9,
  rawResponse: {},
  data: { vendor: 'Tim Hortons', date: '2026-08-01', total: 12.5 },
  ...over,
});

beforeEach(() => h.update.mockClear());

describe('an extraction that extracted nothing', () => {
  it('records FAILED when no vendor, date or total came back', async () => {
    await finalizeExtraction(KEY, {
      ok: true,
      result: RESULT({ data: { vendor: null, date: null, total: null } }) as never,
    });
    expect(lastUpdate().status).toBe('FAILED');
    expect(lastUpdate().error).toMatch(/could not be read/);
  });

  it('records FAILED when the model reports it is certain of nothing', async () => {
    /**
     * The second, independent test. Either alone is escapable: a confidence floor catches the
     * model reporting its own failure, and the all-null check catches a confidently-returned
     * empty shape. This fixture has every material field present and confidence 0.
     */
    await finalizeExtraction(KEY, { ok: true, result: RESULT({ confidence: 0 }) as never });
    expect(lastUpdate().status).toBe('FAILED');
  });

  it('keeps the model and confidence on a failure, because who said it matters', async () => {
    await finalizeExtraction(KEY, { ok: true, result: RESULT({ confidence: 0 }) as never });
    expect(lastUpdate().model).toBe('claude-sonnet-5');
    expect(lastUpdate().confidence).toBe(0);
  });
});

describe('an extraction that did extract something', () => {
  it('records EXTRACTED', async () => {
    // The floor must be about emptiness, not about extraction in general.
    await finalizeExtraction(KEY, { ok: true, result: RESULT() as never });
    expect(lastUpdate().status).toBe('EXTRACTED');
    expect(lastUpdate().error).toBeNull();
  });

  it('accepts an extraction that found only ONE material field', async () => {
    // A receipt whose vendor is illegible but whose total is clear is still worth keeping —
    // the person types the rest over the top.
    await finalizeExtraction(KEY, {
      ok: true,
      result: RESULT({ data: { vendor: null, date: null, total: 12.5 } }) as never,
    });
    expect(lastUpdate().status).toBe('EXTRACTED');
  });

  it('leaves a missing API key as PENDING, not FAILED', async () => {
    // Retryable: a later configuration can re-drive it.
    await finalizeExtraction(KEY, { ok: false, unavailable: true, error: 'no key' });
    expect(lastUpdate().status).toBe('PENDING');
  });

  it('keeps the provider’s own words on a retryable failure', async () => {
    /**
     * "extraction not configured" is true of a missing key and a lie about a daily cap.
     * The row is what a person reads when they ask why a receipt is still spinning, so
     * the reason it is waiting has to be the real one.
     */
    await finalizeExtraction(KEY, {
      ok: false,
      unavailable: true,
      error: 'rate limit',
      pendingReason: 'Your credit balance is too low',
    });
    expect(lastUpdate().status).toBe('PENDING');
    expect(lastUpdate().error).toBe('Your credit balance is too low');
  });
});

describe('a transient provider failure is retried, a permanent one is not', () => {
  /**
   * The 31 August outage in one sentence: the provider's daily cap was hit, two production
   * receipts read "Extraction failed", and nothing retried — because this function is
   * best-effort and never threw, so BullMQ had nothing to catch.
   *
   * Re-throwing is the whole fix. The `integrations` queue already carries the policy
   * (five attempts, exponential backoff from a minute out to an hour); it was simply never
   * reached. These tests assert the THROW, because that is what hands control to it.
   */
  const INPUT = {
    where: KEY,
    s3Key: 'k',
    contentType: 'image/png',
  } as never;

  beforeEach(() => {
    h.update.mockClear();
    vi.mocked(rx.sharpNormalizer.normalize).mockResolvedValue({
      data: new Uint8Array([1]),
      mimeType: 'image/png',
    } as never);
  });

  it('re-throws a rate limit so the queue can retry it', async () => {
    vi.mocked(rx.extractReceipt).mockRejectedValue(new Error('rate limit exceeded'));
    await expect(runDocumentExtraction(INPUT)).rejects.toThrow(/rate limit/);
    // And it does not accuse the document while it waits.
    expect(lastUpdate().status).toBe('PENDING');
  });

  it('settles as FAILED on the last attempt, rather than waiting for ever', async () => {
    /**
     * PENDING means "still working on it". Once the queue has no attempts left that is no
     * longer true, and a row that says it for ever is worse than one that says it failed.
     */
    vi.mocked(rx.extractReceipt).mockRejectedValue(new Error('rate limit exceeded'));
    const out = await runDocumentExtraction({
      ...(INPUT as object),
      isFinalAttempt: () => true,
    } as never);
    expect(out).toBeNull();
    expect(lastUpdate().status).toBe('FAILED');
    expect(String(lastUpdate().error)).toMatch(/rate limit/);
  });

  it('does NOT re-throw an unreadable document', async () => {
    // Five more goes reach the same answer an hour later, having spent money to do it.
    vi.mocked(rx.extractReceipt).mockRejectedValue(new Error('unsupported media type'));
    await expect(runDocumentExtraction(INPUT)).resolves.toBeNull();
    expect(lastUpdate().status).toBe('FAILED');
  });
});

describe('with no malware scanner (local / MinIO), the size cap still holds', () => {
  /**
   * This file runs with `S3_MALWARE_SCAN` unset, which is the dev path: no scan gate, the
   * row goes straight to CLEAN. The size check must not depend on the scan gate being on.
   */
  const CAP = 10_485_760;
  const INPUT = { where: { receiptId: 'r-1' }, s3Key: 'k', contentType: 'image/png' };

  beforeEach(() => {
    h.update.mockClear();
    h.head.mockClear();
    h.read.mockClear();
    vi.mocked(rx.sharpNormalizer.normalize).mockResolvedValue({
      data: new Uint8Array([1]),
      mimeType: 'image/png',
    } as never);
  });

  it('refuses an object of cap + 1 without reading it', async () => {
    h.head.mockResolvedValueOnce({ sizeBytes: CAP + 1, contentType: 'image/png' });
    await expect(prepareExtraction(INPUT)).resolves.toBeNull();
    expect(h.read).not.toHaveBeenCalled();
    expect(lastUpdate().status).toBe('FAILED');
    expect(String(lastUpdate().error)).toMatch(/10485761/);
  });

  it('reads an object of exactly the cap, bounded by the cap', async () => {
    h.head.mockResolvedValueOnce({ sizeBytes: CAP, contentType: 'image/png' });
    await expect(prepareExtraction(INPUT)).resolves.not.toBeNull();
    expect(h.read).toHaveBeenCalledWith('k', CAP);
  });
});

describe('VeloExpense: every model call is recorded in ai_usage (d43)', () => {
  /**
   * Not ExpenseOS's — it meters nothing. Receipt reading is included in every plan, so the
   * row is never reported as credits, but it is what Velotech's cost per tenant and the
   * fair-use count are read from. A reading that found nothing cost the same tokens, so it
   * is recorded too; and the usage write must never be what fails a reading.
   */
  const INPUT = { where: { receiptId: 'r-1' }, s3Key: 'k', contentType: 'image/png' };
  const RESPONSE = { id: 'msg_01', usage: { input_tokens: 2100, output_tokens: 320 } };

  beforeEach(() => {
    h.update.mockClear();
    h.aiUsage.mockReset();
    h.aiUsage.mockResolvedValue({});
    vi.mocked(rx.sharpNormalizer.normalize).mockResolvedValue({
      data: new Uint8Array([1]),
      mimeType: 'image/png',
    } as never);
  });

  it('records the tokens, the model and the receipt, as included', async () => {
    vi.mocked(rx.extractReceipt).mockResolvedValueOnce(RESULT({ rawResponse: RESPONSE }) as never);
    await runDocumentExtraction(INPUT);
    expect(h.aiUsage).toHaveBeenCalledTimes(1);
    expect(h.aiUsage.mock.calls[0][0].data).toMatchObject({
      feature: 'receipt_extraction',
      model: 'claude-sonnet-5',
      inputTokens: 2100,
      outputTokens: 320,
      costMicroUsd: 2100n * 3n + 320n * 15n,
      metered: false,
      receiptId: 'r-1',
      requestId: 'msg_01',
    });
  });

  it('records a reading that found nothing — the tokens were spent', async () => {
    vi.mocked(rx.extractReceipt).mockResolvedValueOnce(
      RESULT({ rawResponse: RESPONSE, data: { vendor: null, date: null, total: null } }) as never,
    );
    await runDocumentExtraction(INPUT);
    expect(h.aiUsage).toHaveBeenCalledTimes(1);
    expect(lastUpdate().status).toBe('FAILED');
  });

  it('never fails the reading over a usage write', async () => {
    vi.mocked(rx.extractReceipt).mockResolvedValueOnce(RESULT({ rawResponse: RESPONSE }) as never);
    h.aiUsage.mockRejectedValueOnce(new Error('connection reset'));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(runDocumentExtraction(INPUT)).resolves.toMatchObject({ vendor: 'Tim Hortons' });
    expect(lastUpdate().status).toBe('EXTRACTED');
    // Logged, not swallowed: a dropped row under-counts with no other trace.
    expect(String(err.mock.calls.at(-1)?.[0])).toMatch(/AI usage/);
    err.mockRestore();
  });

  it('records nothing when the response reports no usage', async () => {
    vi.mocked(rx.extractReceipt).mockResolvedValueOnce(RESULT({ rawResponse: {} }) as never);
    await runDocumentExtraction(INPUT);
    expect(h.aiUsage).not.toHaveBeenCalled();
  });
});
