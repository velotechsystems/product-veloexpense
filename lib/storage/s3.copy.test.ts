// @vitest-environment node
import { CopyObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryStorage, S3Storage } from './index';

/**
 * The S3 driver's server-side copy, which puts one bank statement on several expenses.
 *
 * Ported from ExpenseOS's `packages/storage/src/s3.test.ts` (550b2945), its `copy` block.
 * VeloExpense: the driver is `S3Storage(bucket, client)` (lib/storage), so the SDK client is
 * a stand-in passed to it rather than a mocked module, as in `s3.read.test.ts`. ExpenseOS's
 * live check against MinIO (`s3.copy.db.test.ts`) is not ported: VeloExpense's test stack
 * has no S3 endpoint, and the encoding it confirmed is the same code. The memory driver's
 * copy is pinned too, because the statement procedures' db suites run on it.
 */

const sent: unknown[] = [];
const client = {
  async send(cmd: unknown) {
    sent.push(cmd);
    return {};
  },
} as unknown as S3Client;

class AwsS3Client extends S3Storage {
  constructor(opts: { bucket: string }) {
    super(opts.bucket, client);
  }
}

const base = { bucket: 'receipts', region: 'us-east-1' };

beforeEach(() => {
  sent.length = 0;
});

describe('copy', () => {
  it('encodes the source so a key with a space or + cannot resolve elsewhere', async () => {
    /**
     * `copy()` backs applying a statement to several expenses (`expenses.ts`), so getting
     * the source wrong moves the wrong document onto an expense — or none.
     *
     * This pins the SHAPE: the whole `bucket/key` string goes through
     * `encodeURIComponent`, which encodes the bucket/key SEPARATOR as `%2F` too.
     *
     * It is **correct**, confirmed against a live endpoint in ExpenseOS. Two facts settle
     * it, both observed rather than inferred: the SDK forwards this value to
     * `x-amz-copy-source` verbatim (so there is no double-encoding), and the server decodes
     * the header before splitting bucket from key.
     */
    const s3 = new AwsS3Client(base);
    await s3.copy('folder/a b+c.pdf', 'dest/x.pdf');
    const cmd = sent.at(-1) as CopyObjectCommand;
    expect(cmd).toBeInstanceOf(CopyObjectCommand);
    const input = cmd.input as unknown as Record<string, unknown>;
    expect(input.Key).toBe('dest/x.pdf');
    // Certainly right: no raw space or raw `+` survives, either of which would resolve to
    // a different object.
    expect(String(input.CopySource)).not.toContain(' ');
    expect(String(input.CopySource)).not.toMatch(/\+/);
    expect(String(input.CopySource)).toContain('receipts');
    // Current shape, asserted so a deliberate change to it is visible in a diff.
    expect(String(input.CopySource)).toBe(encodeURIComponent('receipts/folder/a b+c.pdf'));
  });

  it('copies within the configured bucket', async () => {
    const s3 = new AwsS3Client(base);
    await s3.copy('a.pdf', 'b.pdf');
    expect(((sent.at(-1) as CopyObjectCommand).input as unknown as Record<string, unknown>).Bucket).toBe('receipts');
  });

  it('VeloExpense: encodes the # a statement copy carries, so it is not read as a fragment', async () => {
    const s3 = new AwsS3Client(base);
    await s3.copy('org/o/receipts/r/s.pdf', 'org/o/receipts/r/s.pdf#e2');
    const input = (sent.at(-1) as CopyObjectCommand).input as unknown as Record<string, unknown>;
    expect(input.Key).toBe('org/o/receipts/r/s.pdf#e2');
    expect(String(input.CopySource)).toBe(encodeURIComponent('receipts/org/o/receipts/r/s.pdf'));
  });

  it('VeloExpense: starts the copy with no tags, so the web role never writes a scan verdict', async () => {
    // S3 copies the source's tags by default, and a receipt's tag is GuardDuty's verdict.
    // Copying it needs tagging permissions the web role must not have; GuardDuty tags the
    // copy itself. Dev's first statement apply failed without this (w3-04).
    const s3 = new AwsS3Client(base);
    await s3.copy('org/o/receipts/r/s.pdf', 'org/o/receipts/r/s.pdf#e2');
    const input = (sent.at(-1) as CopyObjectCommand).input as unknown as Record<string, unknown>;
    expect(input.TaggingDirective).toBe('REPLACE');
    expect(input.Tagging).toBeUndefined();
  });
});

describe('VeloExpense: the memory driver copies too', () => {
  it('copies the bytes and type under the new key, leaving the source', async () => {
    const m = new MemoryStorage();
    m.put('a.pdf', 'statement', 'application/pdf');
    await m.copy('a.pdf', 'a.pdf#e2');
    expect(m.has('a.pdf')).toBe(true);
    expect(new TextDecoder().decode(m.body('a.pdf#e2') ?? new Uint8Array())).toBe('statement');
    expect(await m.head('a.pdf#e2')).toEqual({ sizeBytes: 9, contentType: 'application/pdf' });
  });

  it('refuses a missing source, as S3 does', async () => {
    const m = new MemoryStorage();
    await expect(m.copy('nope.pdf', 'x.pdf')).rejects.toMatchObject({ name: 'NoSuchKey' });
    expect(m.has('x.pdf')).toBe(false);
  });
});
