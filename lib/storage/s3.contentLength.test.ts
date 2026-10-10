// @vitest-environment node
import { S3Client } from '@aws-sdk/client-s3';
import { describe, expect, it, vi } from 'vitest';
import { S3Storage } from './index';

/**
 * What the REAL presigner signs into an upload link.
 *
 * This file mocks nothing: the real `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner`
 * compute a SigV4 query-string signature offline (presigning never calls `send()`), with
 * static fake credentials so no credential lookup touches the network.
 *
 * The defect this pins: `getUploadUrl` used to build its `PutObjectCommand` without
 * `ContentLength`, so the link signed `host` only and bound no length. A link issued for a
 * 1 KB receipt accepted a body of any size, and nothing refused a length past the 25 MiB
 * ceiling.
 *
 * The defect is fixed: `getUploadUrl` now sets `ContentLength` and refuses a length past the
 * ceiling. Each case sits beside a control that exercises the same real client, which is
 * what proves the signer is really in play rather than a mock.
 *
 * VeloExpense: ExpenseOS's `s3.contentLength.test.ts`, on VeloExpense's `S3Storage`
 * (`presignUpload` with `contentLength`, d29). VeloExpense's driver sets no SSE-KMS header,
 * so ExpenseOS's two KMS cases are not ported, and the control is a link signed WITHOUT a
 * length — the same real client, signing only `host`.
 */

const CEILING = 26_214_400; // 25 MiB — the operator's absolute ceiling, pinned as a literal.

const client = () =>
  new S3Storage(
    'receipts-test',
    new S3Client({
      region: 'us-east-1',
      credentials: { accessKeyId: 'AKIAEXAMPLEEXAMPLE00', secretAccessKey: 'fake-secret-for-tests' },
    }),
  );

const signedHeaders = (url: string) =>
  (new URL(url).searchParams.get('X-Amz-SignedHeaders') ?? '').split(';');

const uploadFor = (contentLength?: number) =>
  client().presignUpload('org/o/receipts/report-1/receipt-1.pdf', 'application/pdf', { contentLength });

describe('getUploadUrl signs the byte length into the link', () => {
  it('control: the real signer is in play — a link with no length signs host alone', async () => {
    const { url } = await uploadFor(undefined);
    expect(signedHeaders(url)).toEqual(['host']);
    expect(new URL(url).searchParams.get('X-Amz-Signature')).toBeTruthy();
  });

  it('a link issued for 1234 bytes signs content-length', async () => {
    const { url } = await uploadFor(1234);
    expect(signedHeaders(url)).toContain('content-length');
  });

  it('binds the VALUE, not just the header name: 1234 and 1235 sign differently', async () => {
    // Same instant for both, so the only input that differs is the length.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-09-28T12:00:00Z'));
      const a = await uploadFor(1234);
      const b = await uploadFor(1235);
      const sig = (url: string) => new URL(url).searchParams.get('X-Amz-Signature');
      expect(sig(a.url)).toBeTruthy();
      expect(sig(a.url)).not.toBe(sig(b.url));
    } finally {
      vi.useRealTimers();
    }
  });

  it('never hands Content-Length back as a header the client must send', async () => {
    // A forbidden fetch header: the browser sets it from the body, which is what is checked.
    const { headers } = await uploadFor(1234);
    expect(Object.keys(headers).map((h) => h.toLowerCase())).not.toContain('content-length');
  });
});

describe('getUploadUrl refuses a length past the 25 MiB ceiling', () => {
  it('control: exactly 25 MiB signs and returns a URL', async () => {
    const { url } = await uploadFor(CEILING);
    expect(url).toMatch(/^https:\/\//);
  });

  it('exactly 25 MiB is signed as content-length', async () => {
    const { url } = await uploadFor(CEILING);
    expect(signedHeaders(url)).toContain('content-length');
  });

  it('25 MiB + 1 byte is refused before signing', async () => {
    await expect(uploadFor(CEILING + 1)).rejects.toThrow();
  });
});
