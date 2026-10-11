// @vitest-environment node
import { gzipSync } from 'node:zlib';
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type MockInstance,
  vi,
} from 'vitest';

/**
 * The worker never buffers a document larger than its cap.
 *
 * Two defects, each with its own test, red in phase 1 of `upload-size-enforced` and green
 * since the worker extraction phase:
 *   - R2: `prepareExtraction` used to download the object without asking its size first, so
 *     an object `head` reported at 10 MiB + 1 was still fetched in full.
 *   - R4: the download was `fetch(presignedUrl).arrayBuffer()`, and Node's `fetch` silently
 *     decodes a stored `Content-Encoding: gzip` object, so a few KB stored arrived at
 *     `normalize` as megabytes. The read is now the storage client's bounded server-side
 *     read, which hands back the stored bytes undecoded.
 *
 * `guardedRead` is imported by production code from `@expenseos/storage/guarded-read`, which
 * is NOT mocked here, so its real HEAD-then-read logic runs against the `head` / `read`
 * doubles below. "No download" is asserted as `read` not called. `fetch` is stubbed as a
 * tripwire that throws and must never be reached.
 *
 * `S3_MALWARE_SCAN` is read at module load (`SCAN_ENABLED`), so it is set in `vi.hoisted`
 * in this file of its own and restored in `afterAll`.
 *
 * Ported from ExpenseOS's `extract-core.size.test.ts` (550b2945). VeloExpense: `db` from
 * `@/lib/db/prisma`, storage from `@/lib/storage` (`getStorage()`, HEAD answering
 * `sizeBytes`), `guardedRead` from `@/lib/storage/guardedRead` (unmocked, as there). Not
 * ported: "prepareExtraction takes the cap from the extraction key" — its cases are about
 * a virtual-card attachment's cap, and VeloExpense has no card attachments; the receipt cap
 * is pinned by every other case here.
 */

const CAP = 10_485_760; // 10 MiB: the operator's receipt cap, pinned as a literal.

const h = vi.hoisted(() => {
  const prevScan = process.env.S3_MALWARE_SCAN;
  process.env.S3_MALWARE_SCAN = 'guardduty';
  return {
    prevScan,
    update: vi.fn(async (_arg: { where: unknown; data: Record<string, unknown> }) => ({})),
    upsert: vi.fn(async () => ({ id: 'ext-1' })),
    head: vi.fn(),
    read: vi.fn(),
    getMalwareScanStatus: vi.fn(async (): Promise<string> => 'clean'),
    fetch: vi.fn(() => {
      throw new Error('fetch must not be called: the worker reads through the storage client');
    }),
    normalize: vi.fn(async (_bytes: Uint8Array, mimeType: string) => ({
      data: new Uint8Array([1]),
      mimeType,
    })),
  };
});

vi.mock('@/lib/db/prisma', () => ({
  db: { documentExtraction: { update: h.update, upsert: h.upsert } },
}));
vi.mock('@expenseos/db', () => ({
  DocExtractStatus: {
    PENDING: 'PENDING',
    EXTRACTING: 'EXTRACTING',
    EXTRACTED: 'EXTRACTED',
    FAILED: 'FAILED',
  },
  DocScanStatus: {
    PENDING: 'PENDING',
    SCANNING: 'SCANNING',
    CLEAN: 'CLEAN',
    INFECTED: 'INFECTED',
    FAILED: 'FAILED',
  },
  Prisma: {},
}));
vi.mock('@expenseos/receipt-extraction', () => ({
  ExtractionUnavailableError: class extends Error {},
  extractReceipt: vi.fn(),
  isTransientExtractionFailure: () => false,
  sharpNormalizer: { normalize: h.normalize },
}));
// Only the bucket client is a double; `guardedRead` comes from its own, unmocked subpath.
vi.mock('@/lib/storage', () => ({
  getStorage: () => ({
    head: h.head,
    read: h.read,
    getMalwareScanStatus: h.getMalwareScanStatus,
  }),
}));

const { prepareExtraction, fetchCleanDocument } = await import('./extract-core');

const KEY = 'report-1/receipt-1.jpg';
const INPUT = { where: { receiptId: 'r-1' }, s3Key: KEY, contentType: 'image/jpeg' };
const BYTES = new Uint8Array(16).fill(7);

const updates = () => h.update.mock.calls.map((c) => c[0].data);
const lastUpdate = () => updates().at(-1) ?? {};
const headReports = (size: number) =>
  h.head.mockResolvedValue({ sizeBytes: size, contentType: 'image/jpeg' });

/** A refusal must never carry a presigned URL, a signature or a credential. */
const expectNoLeak = (text: string) => {
  expect(text).not.toMatch(/X-Amz-/i);
  expect(text).not.toMatch(/http/i);
};

let warn: MockInstance<typeof console.warn>;

beforeEach(() => {
  h.update.mockClear();
  h.upsert.mockClear();
  h.getMalwareScanStatus.mockReset();
  h.getMalwareScanStatus.mockResolvedValue('clean');
  h.fetch.mockClear();
  h.normalize.mockClear();
  // Explicit defaults, never a bare `vi.fn()`: an `undefined` HEAD would hide a fail-open.
  h.head.mockReset();
  headReports(1024);
  h.read.mockReset();
  h.read.mockResolvedValue({ ok: true, data: BYTES });
  vi.stubGlobal('fetch', h.fetch);
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  expect(h.fetch).not.toHaveBeenCalled();
  warn.mockRestore();
  vi.unstubAllGlobals();
});

afterAll(() => {
  if (h.prevScan === undefined) delete process.env.S3_MALWARE_SCAN;
  else process.env.S3_MALWARE_SCAN = h.prevScan;
});

describe('prepareExtraction asks the size before it downloads', () => {
  it('control: an object of exactly the cap is read once, bounded by the cap, and reaches EXTRACTING', async () => {
    headReports(CAP);
    const out = await prepareExtraction(INPUT);
    expect(h.read).toHaveBeenCalledTimes(1);
    expect(h.read).toHaveBeenCalledWith(KEY, CAP);
    expect(h.normalize.mock.calls[0]?.[0]).toBe(BYTES);
    expect(updates().some((d) => d.status === 'EXTRACTING')).toBe(true);
    expect(out).not.toBeNull();
  });

  it('an object of cap + 1 is never downloaded, and the row says why', async () => {
    headReports(CAP + 1);
    const out = await prepareExtraction(INPUT);
    expect(h.read).not.toHaveBeenCalled();
    expect(lastUpdate().status).toBe('FAILED');
    const error = String(lastUpdate().error);
    expect(error).toMatch(/10485761/);
    expect(error).toMatch(/10485760/);
    expectNoLeak(error);
    expect(out).toBeNull();
    // The scan ran first and passed; the size refusal does not rewrite that verdict.
    expect(
      updates()
        .filter((d) => 'scanStatus' in d)
        .at(-1)?.scanStatus,
    ).toBe('CLEAN');
  });

  it.each([
    {
      name: 'HEAD finds no object',
      arrange: () => h.head.mockResolvedValue(null),
      read: false,
      error: /^download failed: object not found$/,
    },
    {
      name: 'HEAD throws (access denied, network)',
      arrange: () => h.head.mockRejectedValue(new Error('AccessDenied')),
      read: false,
      error: /^download failed: AccessDenied$/,
    },
    {
      name: 'the read overflows the cap while streaming',
      arrange: () => h.read.mockResolvedValue({ ok: false, reason: 'too-large' }),
      read: true,
      error: /^file too large: .*10485760/,
    },
    {
      name: 'the object is deleted between HEAD and the read',
      arrange: () => h.read.mockResolvedValue({ ok: false, reason: 'missing' }),
      read: true,
      error: /^download failed: object not found$/,
    },
    {
      name: 'the read throws',
      arrange: () => h.read.mockRejectedValue(new Error('socket hang up')),
      read: true,
      error: /^download failed: socket hang up$/,
    },
  ])('$name: FAILED with the reason, null, no throw', async ({ arrange, read, error }) => {
    arrange();
    await expect(prepareExtraction(INPUT)).resolves.toBeNull();
    expect(h.read).toHaveBeenCalledTimes(read ? 1 : 0);
    expect(h.normalize).not.toHaveBeenCalled();
    expect(lastUpdate().status).toBe('FAILED');
    expect(String(lastUpdate().error)).toMatch(error);
    expectNoLeak(String(lastUpdate().error));
  });

  it('never calls a missing object "too large"', async () => {
    h.head.mockResolvedValue(null);
    await prepareExtraction(INPUT);
    expect(String(lastUpdate().error)).not.toMatch(/too large/i);
  });
});

describe('the scan verdict comes before any size check', () => {
  it('an infected file that is also over the cap records INFECTED and reads nothing', async () => {
    h.getMalwareScanStatus.mockResolvedValue('infected');
    headReports(CAP + 1);
    await expect(prepareExtraction(INPUT)).resolves.toBeNull();
    expect(lastUpdate()).toMatchObject({
      scanStatus: 'INFECTED',
      status: 'FAILED',
      error: 'infected file',
    });
    expect(h.head).not.toHaveBeenCalled();
    expect(h.read).not.toHaveBeenCalled();
  });

  it('a scan still in progress re-polls and reads nothing', async () => {
    h.getMalwareScanStatus.mockResolvedValue('pending');
    const rescheduleScan = vi.fn(async () => {});
    await expect(prepareExtraction({ ...INPUT, rescheduleScan })).resolves.toBeNull();
    expect(rescheduleScan).toHaveBeenCalledTimes(1);
    expect(h.head).not.toHaveBeenCalled();
    expect(h.read).not.toHaveBeenCalled();
  });

  it('an unavailable scan reads nothing', async () => {
    h.getMalwareScanStatus.mockResolvedValue('unavailable');
    await expect(prepareExtraction(INPUT)).resolves.toBeNull();
    expect(h.head).not.toHaveBeenCalled();
    expect(h.read).not.toHaveBeenCalled();
  });
});

describe('fetchCleanDocument reads within the receipt cap and writes no status', () => {
  const CLEAN = { s3Key: KEY, contentType: 'image/jpeg' };
  const warned = () => warn.mock.calls.map((c) => String(c[0])).join('\n');

  afterEach(() => {
    // Its contract: it never owns, or writes, a DocumentExtraction row.
    expect(h.upsert).not.toHaveBeenCalled();
    expect(h.update).not.toHaveBeenCalled();
  });

  it('control: an object of exactly the cap is read once, bounded by the cap', async () => {
    headReports(CAP);
    await expect(fetchCleanDocument(CLEAN)).resolves.toEqual({
      data: new Uint8Array([1]),
      mimeType: 'image/jpeg',
    });
    expect(h.read).toHaveBeenCalledTimes(1);
    expect(h.read).toHaveBeenCalledWith(KEY, CAP);
  });

  it('an object of cap + 1 is skipped with a warning naming the key and size, and never read', async () => {
    headReports(CAP + 1);
    await expect(fetchCleanDocument(CLEAN)).resolves.toBeNull();
    expect(h.read).not.toHaveBeenCalled();
    expect(warned()).toContain(KEY);
    expect(warned()).toMatch(/10485761 bytes.*10485760/);
    expectNoLeak(warned());
  });

  it.each([
    { name: 'HEAD finds no object', arrange: () => h.head.mockResolvedValue(null), read: false },
    {
      name: 'HEAD throws',
      arrange: () => h.head.mockRejectedValue(new Error('AccessDenied')),
      read: false,
    },
    {
      name: 'the read overflows the cap while streaming',
      arrange: () => h.read.mockResolvedValue({ ok: false, reason: 'too-large' }),
      read: true,
    },
    {
      name: 'the object is deleted between HEAD and the read',
      arrange: () => h.read.mockResolvedValue({ ok: false, reason: 'missing' }),
      read: true,
    },
    {
      name: 'the read throws',
      arrange: () => h.read.mockRejectedValue(new Error('socket hang up')),
      read: true,
    },
  ])('$name: null with a warning, no throw', async ({ arrange, read }) => {
    arrange();
    await expect(fetchCleanDocument(CLEAN)).resolves.toBeNull();
    expect(h.read).toHaveBeenCalledTimes(read ? 1 : 0);
    expect(h.normalize).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('names the limit when the read overflows, and never calls a missing object "too large"', async () => {
    h.read.mockResolvedValueOnce({ ok: false, reason: 'too-large' });
    await fetchCleanDocument(CLEAN);
    expect(warned()).toMatch(/too large: .*10485760/);
    expectNoLeak(warned());
    warn.mockClear();
    h.head.mockResolvedValueOnce(null);
    await fetchCleanDocument(CLEAN);
    expect(warned()).toMatch(/not found/);
    expect(warned()).not.toMatch(/too large/i);
  });
});

describe('a gzip-stored object reaches normalize at its stored length', () => {
  // 10 MiB + 1 byte of zeros, stored gzip-encoded: a few KB on disk. The bounded read hands
  // back the STORED bytes, as the SDK's GetObject does; nothing decodes them on the way.
  const GZIP = gzipSync(Buffer.alloc(CAP + 1));

  it('every buffer handed to normalize is the stored length, at most the cap', async () => {
    headReports(GZIP.byteLength);
    h.read.mockResolvedValue({ ok: true, data: new Uint8Array(GZIP) });
    await prepareExtraction(INPUT);
    const sizes = h.normalize.mock.calls.map((c) => c[0].byteLength);
    expect(sizes).toEqual([GZIP.byteLength]);
    for (const n of sizes) expect(n).toBeLessThanOrEqual(CAP);
  });
});
