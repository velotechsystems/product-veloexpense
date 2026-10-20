import { describe, expect, it, vi } from 'vitest';
import {
  pairUploads,
  runReceiptUploads,
  type UploadSlot,
} from '@/components/assistant/receiptUpload';

const slot = (over: Partial<UploadSlot> = {}): UploadSlot => ({
  expenseId: '01920000-0000-7000-8000-000000000001',
  key: 'report/abc.heic',
  filename: 'dinner.heic',
  contentType: 'image/heic',
  url: 'https://s3.example/put/1',
  method: 'PUT',
  headers: { 'Content-Type': 'image/heic' },
  ...over,
});

const file = (name: string, type: string, bytes = 4) =>
  new File([new Uint8Array(bytes)], name, { type });

describe('pairUploads', () => {
  it('pairs by name and type, not by position', () => {
    // The slots come back in the order the MODEL listed the files. If it reorders them,
    // pairing by index puts the taxi receipt on the restaurant expense and extraction fills
    // in the wrong merchant — wrong in a way that looks entirely correct.
    const slots = [
      slot({ filename: 'taxi.pdf', contentType: 'application/pdf', key: 'r/taxi' }),
      slot({ filename: 'dinner.heic', contentType: 'image/heic', key: 'r/dinner' }),
    ];
    const files = [file('dinner.heic', 'image/heic'), file('taxi.pdf', 'application/pdf')];

    const { paired, unmatchedSlots, unmatchedFiles } = pairUploads(slots, files);

    expect(paired.map((p) => [p.slot.key, p.file.name])).toEqual([
      ['r/taxi', 'taxi.pdf'],
      ['r/dinner', 'dinner.heic'],
    ]);
    expect(unmatchedSlots).toEqual([]);
    expect(unmatchedFiles).toEqual([]);
  });

  it('consumes each file once when two share a name and type', () => {
    const slots = [slot({ key: 'r/a' }), slot({ key: 'r/b' })];
    const files = [file('dinner.heic', 'image/heic', 4), file('dinner.heic', 'image/heic', 9)];

    const { paired, unmatchedFiles } = pairUploads(slots, files);

    expect(paired).toHaveLength(2);
    expect(paired[0]?.file).not.toBe(paired[1]?.file);
    expect(unmatchedFiles).toEqual([]);
  });

  it('reports a slot it holds no bytes for rather than substituting another file', () => {
    const slots = [slot({ filename: 'invented.pdf', contentType: 'application/pdf' })];
    const files = [file('dinner.heic', 'image/heic')];

    const { paired, unmatchedSlots, unmatchedFiles } = pairUploads(slots, files);

    expect(paired).toEqual([]);
    expect(unmatchedSlots).toHaveLength(1);
    expect(unmatchedFiles).toHaveLength(1);
  });

  it('treats a typeless file as octet-stream, which no receipt slot claims', () => {
    const { unmatchedFiles } = pairUploads([slot()], [file('dinner.heic', '')]);
    expect(unmatchedFiles).toHaveLength(1);
  });
});

describe('runReceiptUploads', () => {
  const deps = (over: Partial<Parameters<typeof runReceiptUploads>[2]> = {}) => ({
    put: vi.fn(async () => true),
    reissue: vi.fn(async (s: UploadSlot) => ({
      ...s,
      key: `${s.key}/reissued`,
      url: `${s.url}/2`,
    })),
    register: vi.fn(async () => ({ id: 'receipt-1' })),
    extract: vi.fn(async () => undefined),
    ...over,
  });

  it('uploads, registers with the real byte size, then extracts the batch once', async () => {
    const d = deps();
    const files = [file('dinner.heic', 'image/heic', 11), file('taxi.pdf', 'application/pdf', 7)];
    const slots = [
      slot({ key: 'r/dinner' }),
      slot({ filename: 'taxi.pdf', contentType: 'application/pdf', key: 'r/taxi' }),
    ];

    const report = await runReceiptUploads(slots, files, d);

    expect(report).toEqual({ filed: 2, failed: 0, mismatched: 0, retried: 0 });
    // The success path never asks for a second link.
    expect(d.reissue).not.toHaveBeenCalled();
    // sizeBytes comes from the File, never from what the model said it was.
    expect(d.register).toHaveBeenCalledWith(expect.objectContaining({ sizeBytes: 11 }));
    expect(d.register).toHaveBeenCalledWith(expect.objectContaining({ sizeBytes: 7 }));
    // One extraction call for the batch: above five files that is what takes the cheaper
    // Batch API path instead of one synchronous model call each.
    expect(d.extract).toHaveBeenCalledTimes(1);
    expect(d.extract).toHaveBeenCalledWith(['receipt-1', 'receipt-1']);
  });

  it('carries on when one file will not upload, and still extracts the rest', async () => {
    // Refused on the reissued link as well, so this one is a real failure.
    const d = deps({
      put: vi.fn(async (s: UploadSlot) => s.filename !== 'taxi.pdf'),
    });
    const report = await runReceiptUploads(
      [
        slot({ key: 'r/dinner' }),
        slot({ filename: 'taxi.pdf', contentType: 'application/pdf', key: 'r/taxi' }),
      ],
      [file('dinner.heic', 'image/heic'), file('taxi.pdf', 'application/pdf')],
      d,
    );

    expect(report).toEqual({ filed: 1, failed: 1, mismatched: 0, retried: 0 });
    expect(d.extract).toHaveBeenCalledWith(['receipt-1']);
  });

  it('never registers a receipt whose upload failed', async () => {
    // A row pointing at an object that is not there is an expense showing a receipt nobody
    // can open, and extraction failing for a reason no one can see.
    const d = deps({ put: vi.fn(async () => false) });
    const report = await runReceiptUploads([slot()], [file('dinner.heic', 'image/heic')], d);

    expect(d.register).not.toHaveBeenCalled();
    expect(d.extract).not.toHaveBeenCalled();
    expect(report).toEqual({ filed: 0, failed: 1, mismatched: 0, retried: 0 });
  });

  it('counts a mismatch instead of uploading the wrong bytes', async () => {
    const d = deps();
    const report = await runReceiptUploads(
      [slot({ filename: 'invented.pdf', contentType: 'application/pdf' })],
      [file('dinner.heic', 'image/heic')],
      d,
    );

    expect(d.put).not.toHaveBeenCalled();
    expect(d.reissue).not.toHaveBeenCalled();
    expect(report).toEqual({ filed: 0, failed: 0, mismatched: 2, retried: 0 });
  });

  it('survives an extraction enqueue that throws', async () => {
    // Same contract as receiptCreate: the receipts are filed and visible, and a queue hiccup
    // must not read as a failed upload.
    const d = deps({
      extract: vi.fn(async () => {
        throw new Error('redis down');
      }),
    });
    const report = await runReceiptUploads([slot()], [file('dinner.heic', 'image/heic')], d);
    expect(report.filed).toBe(1);
  });

  it('reports progress per file', async () => {
    const onProgress = vi.fn();
    await runReceiptUploads(
      [slot({ key: 'r/a' }), slot({ key: 'r/b' })],
      [file('dinner.heic', 'image/heic'), file('dinner.heic', 'image/heic')],
      { ...deps(), onProgress },
    );
    expect(onProgress.mock.calls).toEqual([
      [1, 2],
      [2, 2],
    ]);
  });
});

describe('runReceiptUploads, when the first PUT is refused', () => {
  // Every link is bound to one exact byte length, and on this path that length is whatever
  // the model copied into its tool call. One digit copied wrong and storage refuses the PUT.
  // The File in hand holds the real size, so the fix is one fresh link sized from it.
  const deps = (over: Partial<Parameters<typeof runReceiptUploads>[2]> = {}) => ({
    // Only the reissued link takes the bytes.
    put: vi.fn(async (s: UploadSlot) => s.key.endsWith('/reissued')),
    reissue: vi.fn(async (s: UploadSlot) => ({
      ...s,
      key: `${s.key}/reissued`,
      url: `${s.url}/2`,
    })),
    register: vi.fn(async () => ({ id: 'receipt-1' })),
    extract: vi.fn(async () => undefined),
    ...over,
  });

  it('files it on a link reissued for the real size, and registers the new key', async () => {
    const d = deps();
    const bytes = file('dinner.heic', 'image/heic', 13);

    const report = await runReceiptUploads([slot({ key: 'r/dinner' })], [bytes], d);

    expect(report).toEqual({ filed: 1, failed: 0, mismatched: 0, retried: 1 });
    // Reissued for the same slot and the same File — the File is where the size comes from.
    expect(d.reissue).toHaveBeenCalledTimes(1);
    expect(d.reissue).toHaveBeenCalledWith(expect.objectContaining({ key: 'r/dinner' }), bytes);
    expect(vi.mocked(d.put).mock.calls.map(([s]) => s.url)).toEqual([
      'https://s3.example/put/1',
      'https://s3.example/put/1/2',
    ]);
    // The original key holds nothing: registering it would point a receipt at no object.
    expect(d.register).toHaveBeenCalledTimes(1);
    expect(d.register).toHaveBeenCalledWith({
      expenseId: '01920000-0000-7000-8000-000000000001',
      key: 'r/dinner/reissued',
      filename: 'dinner.heic',
      contentType: 'image/heic',
      sizeBytes: 13,
    });
    expect(d.extract).toHaveBeenCalledWith(['receipt-1']);
  });

  it('retries a PUT that rejected outright, not only one that answered with an error', async () => {
    const d = deps({
      put: vi.fn(async (s: UploadSlot) => {
        if (!s.key.endsWith('/reissued')) throw new TypeError('Failed to fetch');
        return true;
      }),
    });
    const report = await runReceiptUploads([slot()], [file('dinner.heic', 'image/heic')], d);
    expect(report).toEqual({ filed: 1, failed: 0, mismatched: 0, retried: 1 });
  });

  it('retries once only, and counts a second refusal as failed', async () => {
    const d = deps({ put: vi.fn(async () => false) });
    const report = await runReceiptUploads([slot()], [file('dinner.heic', 'image/heic')], d);

    expect(d.put).toHaveBeenCalledTimes(2);
    expect(d.reissue).toHaveBeenCalledTimes(1);
    expect(d.register).not.toHaveBeenCalled();
    expect(d.extract).not.toHaveBeenCalled();
    expect(report).toEqual({ filed: 0, failed: 1, mismatched: 0, retried: 0 });
  });

  it('counts the file as failed when the reissue itself throws, and carries on', async () => {
    const d = deps({
      put: vi.fn(async (s: UploadSlot) => s.filename === 'taxi.pdf'),
      reissue: vi.fn(async () => {
        throw new Error('That file type is not allowed');
      }),
    });
    const report = await runReceiptUploads(
      [
        slot({ key: 'r/dinner' }),
        slot({ filename: 'taxi.pdf', contentType: 'application/pdf', key: 'r/taxi' }),
      ],
      [file('dinner.heic', 'image/heic'), file('taxi.pdf', 'application/pdf')],
      d,
    );

    expect(report).toEqual({ filed: 1, failed: 1, mismatched: 0, retried: 0 });
    expect(d.register).toHaveBeenCalledWith(expect.objectContaining({ key: 'r/taxi' }));
    expect(d.extract).toHaveBeenCalledWith(['receipt-1']);
  });

  it('does not count a retry for a file that then failed to register', async () => {
    const d = deps({
      register: vi.fn(async () => {
        throw new Error('decided');
      }),
    });
    const report = await runReceiptUploads([slot()], [file('dinner.heic', 'image/heic')], d);
    expect(report).toEqual({ filed: 0, failed: 1, mismatched: 0, retried: 0 });
  });
});
