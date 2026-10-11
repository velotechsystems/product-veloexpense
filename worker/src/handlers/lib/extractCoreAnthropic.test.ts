// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The last link: the credential the handler resolved actually reaches the SDK call.
 *
 * Everything above this is threading — `resolveAnthropicConfig` → handler →
 * `runDocumentExtraction`. This is where it turns into an Anthropic client, and it is
 * the only place a silent `process.env` fallback could still swallow the integration's
 * key without any test noticing.
 *
 * Ported from ExpenseOS's `extractCoreAnthropic.test.ts` (550b2945). VeloExpense: the key is
 * the environment's (`anthropicForExtraction`, ./anthropic.test.ts), but this link is the
 * same — what the handler resolved is what reaches the SDK call. Mocks at VeloExpense's
 * seams: `db` from `@/lib/db/prisma`, storage from `@/lib/storage`.
 */

const h = vi.hoisted(() => ({
  extractReceipt: vi.fn(),
  db: {
    documentExtraction: {
      upsert: vi.fn(async () => ({ id: 'x1' })),
      update: vi.fn(async () => ({})),
    },
  },
  normalize: vi.fn(async (data: Uint8Array) => ({ data, mimeType: 'image/jpeg' })),
}));

vi.mock('@/lib/db/prisma', () => ({ db: h.db }));
vi.mock('@expenseos/db', () => ({
  DocExtractStatus: { PENDING: 'PENDING', EXTRACTING: 'EXTRACTING', FAILED: 'FAILED' },
  DocScanStatus: { CLEAN: 'CLEAN', NO_SCAN: 'NO_SCAN' },
}));
vi.mock('@expenseos/receipt-extraction', () => ({
  extractReceipt: h.extractReceipt,
  ExtractionUnavailableError: class extends Error {},
  sharpNormalizer: { normalize: h.normalize },
}));
// The scan gate is off without S3_MALWARE_SCAN (the local/MinIO path), so only the
// bounded read needs stubbing: `head` for the size check, `read` for the bytes. The real
// `guardedRead` runs; it is imported from its own subpath, which is not mocked here.
vi.mock('@/lib/storage', () => ({
  getStorage: () => ({
    head: async () => ({ sizeBytes: 3, contentType: 'image/jpeg' }),
    read: async () => ({ ok: true, data: new Uint8Array([1, 2, 3]) }),
  }),
}));
vi.mock('./scanPolicy', () => ({ MAX_SCAN_ATTEMPTS: 3, scanPollDelayMs: () => 1000 }));

const INPUT = {
  where: { receiptId: 'r1' },
  s3Key: 'receipts/r1.jpg',
  contentType: 'image/jpeg',
};

describe('runDocumentExtraction — credential', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.normalize.mockImplementation(async (data: Uint8Array) => ({
      data,
      mimeType: 'image/jpeg',
    }));
    h.extractReceipt.mockResolvedValue({
      data: { vendor: 'Fixture', confidence: 0.9 },
      model: 'claude-sonnet-5',
    });
  });

  it('passes the resolved key and model to the extractor', async () => {
    const { runDocumentExtraction } = await import('./extract-core');
    await runDocumentExtraction({
      ...INPUT,
      anthropic: { apiKey: 'installed-key', model: 'claude-sonnet-5' },
    });
    expect(h.extractReceipt.mock.calls[0]?.[0]).toMatchObject({
      apiKey: 'installed-key',
      model: 'claude-sonnet-5',
    });
  });

  it('omits both when Claude is not configured, so the package default stands', async () => {
    // `null` reaches the extractor as absence, not as an empty key — an empty string
    // would look configured and fail at the API instead of degrading to PENDING.
    const { runDocumentExtraction } = await import('./extract-core');
    await runDocumentExtraction({ ...INPUT, anthropic: null });
    const arg = h.extractReceipt.mock.calls[0]?.[0] as Record<string, unknown>;
    expect('apiKey' in arg).toBe(false);
    expect('model' in arg).toBe(false);
  });

  it('omits the model when the installation pins only a key', async () => {
    const { runDocumentExtraction } = await import('./extract-core');
    await runDocumentExtraction({ ...INPUT, anthropic: { apiKey: 'k' } });
    const arg = h.extractReceipt.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(arg.apiKey).toBe('k');
    expect('model' in arg).toBe(false);
  });
});
