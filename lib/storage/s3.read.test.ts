// @vitest-environment node
import { Readable } from 'node:stream';
import { GetObjectCommand, GetObjectTaggingCommand, NoSuchKey, type S3Client } from '@aws-sdk/client-s3';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { S3Storage } from './index';

/**
 * The S3 driver's two reads: the bounded download the worker reads a receipt through, and
 * GuardDuty's scan-status tag.
 *
 * Ported from ExpenseOS's `packages/storage/src/s3.test.ts` (550b2945), its `read` and
 * `getMalwareScanStatus` blocks. VeloExpense: the driver is `S3Storage(bucket, client)`
 * (lib/storage), so the SDK client is a stand-in passed to it rather than a mocked module,
 * and a command's kind is its real SDK class. Nothing in this driver presigns a read, so
 * ExpenseOS's "nothing presigned" assertion is the same fact stated by the command's class.
 */

const sent: unknown[] = [];
/** What the next `send` should do. Set per test; reset in `beforeEach`. */
const reply: { value?: unknown; error?: unknown } = {};
const client = {
  async send(cmd: unknown) {
    sent.push(cmd);
    if (reply.error) throw reply.error;
    return reply.value ?? {};
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
  reply.value = undefined;
  reply.error = undefined;
});

describe('read', () => {
  /**
   * The bounded download every worker read goes through. What matters is that it STOPS:
   * nothing past the cap is ever held, whatever the object turns out to be. So the body is
   * a real `Readable` over a generator that counts its pulls — the proof that reading
   * stopped is the chunk after the cap never being asked for, not only the result.
   */
  const CAP = 1024;

  /** A `Readable` body yielding `sizes` chunks, with a pull counter and a `destroy` spy. */
  const bodyOf = (sizes: number[], fill = (i: number) => i + 1) => {
    const state = { pulled: 0 };
    function* gen() {
      for (const [i, size] of sizes.entries()) {
        state.pulled++;
        yield new Uint8Array(size).fill(fill(i));
      }
    }
    const body = Readable.from(gen());
    const destroy = vi.spyOn(body, 'destroy');
    return { body, destroy, state };
  };

  it('stops at cap + 1: too-large with no size, stream destroyed, next chunk never pulled', async () => {
    const { body, destroy, state } = bodyOf([CAP / 2, CAP / 2, CAP / 2, CAP / 2]);
    reply.value = { Body: body };
    const s3 = new AwsS3Client(base);
    const out = await s3.read('a/b.pdf', CAP);
    // `size` is absent: an overflow caught while streaming knows only "more than the cap".
    expect(out).toEqual({ ok: false, reason: 'too-large' });
    expect(destroy).toHaveBeenCalled();
    // The 3rd chunk crossed the cap; the 4th was never asked for.
    expect(state.pulled).toBe(3);
  });

  it('returns exactly the cap, across chunks, in order', async () => {
    const { body } = bodyOf([400, 400, 224]);
    reply.value = { Body: body };
    const s3 = new AwsS3Client(base);
    const out = await s3.read('a/b.pdf', CAP);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.data.byteLength).toBe(CAP);
    expect(out.data[0]).toBe(1);
    expect(out.data[399]).toBe(1);
    expect(out.data[400]).toBe(2);
    expect(out.data[799]).toBe(2);
    expect(out.data[800]).toBe(3);
    expect(out.data[CAP - 1]).toBe(3);
  });

  it('returns an empty object as zero bytes', async () => {
    reply.value = { Body: bodyOf([]).body };
    const s3 = new AwsS3Client(base);
    const out = await s3.read('a/empty.pdf', CAP);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.data.byteLength).toBe(0);
  });

  it('asks for the key it was given, in the configured bucket', async () => {
    reply.value = { Body: bodyOf([1]).body };
    const s3 = new AwsS3Client(base);
    await s3.read('receipts/2026/x.pdf', CAP);
    const cmd = sent.at(-1) as GetObjectCommand;
    // A direct SDK read (a GetObjectCommand sent, nothing presigned), so no URL exists to
    // leak into a log.
    expect(cmd).toBeInstanceOf(GetObjectCommand);
    expect(cmd.input).toEqual({ Bucket: 'receipts', Key: 'receipts/2026/x.pdf' });
  });

  it('answers missing for an object that is not there', async () => {
    reply.error = new NoSuchKey({ message: 'no such key', $metadata: {} } as never);
    const s3 = new AwsS3Client(base);
    await expect(s3.read('gone.pdf', CAP)).resolves.toEqual({ ok: false, reason: 'missing' });
  });

  it('rethrows anything that is not a missing object', async () => {
    /** An AccessDenied read as "missing" would tell a caller the file was never uploaded. */
    reply.error = new Error('AccessDenied');
    const s3 = new AwsS3Client(base);
    await expect(s3.read('a/b.pdf', CAP)).rejects.toThrow(/AccessDenied/);
  });

  it('rethrows a stream that breaks mid-read', async () => {
    const body = new Readable({
      read() {
        this.push(new Uint8Array(10));
        this.destroy(new Error('socket reset'));
      },
    });
    reply.value = { Body: body };
    const s3 = new AwsS3Client(base);
    await expect(s3.read('a/b.pdf', CAP)).rejects.toThrow(/socket reset/);
  });

  it('refuses a body it cannot stream rather than reading it unbounded', async () => {
    reply.value = {};
    const s3 = new AwsS3Client(base);
    await expect(s3.read('a/b.pdf', CAP)).rejects.toThrow(/cannot be streamed/);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'throws for a maxBytes of %s and sends nothing',
    async (maxBytes) => {
      const s3 = new AwsS3Client(base);
      await expect(s3.read('a/b.pdf', maxBytes)).rejects.toThrow(/maxBytes/);
      expect(sent).toHaveLength(0);
    },
  );

  it('takes a cap above the 25 MiB upload ceiling as given, without clamping', async () => {
    /**
     * The cap is the caller's: inbound mail is read with 40 MiB, above the upload ceiling on
     * purpose (operator, 2026-09-28). A 27 MiB object under a 40 MiB cap must come back
     * whole — clamping to 25 MiB would silently drop mail that is filed today.
     */
    const MiB = 1024 * 1024;
    const chunk = new Uint8Array(MiB);
    function* gen() {
      for (let i = 0; i < 27; i++) yield chunk;
    }
    reply.value = { Body: Readable.from(gen()) };
    const s3 = new AwsS3Client(base);
    const out = await s3.read('inbound/raw.eml', 41_943_040);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.data.byteLength).toBe(27 * MiB);
  });
});

describe('getMalwareScanStatus', () => {
  /**
   * The gate in front of every receipt a person can open, and it FAILS CLOSED: anything
   * this cannot read as a clean scan is `unavailable`, which the viewer treats as
   * not-yet-safe. Worth pinning branch by branch, because the difference between
   * `pending` and `unavailable` decides whether the UI keeps polling or stops, and the
   * difference between either and `clean` decides whether a file is served at all.
   */
  const withTags = (tags: { Key: string; Value: string }[]) => {
    reply.value = { TagSet: tags };
    return new AwsS3Client(base);
  };

  it('reads a completed clean scan', async () => {
    const s3 = withTags([{ Key: 'GuardDutyMalwareScanStatus', Value: 'NO_THREATS_FOUND' }]);
    await expect(s3.getMalwareScanStatus('a/b.pdf')).resolves.toBe('clean');
  });

  it('reads a detection', async () => {
    const s3 = withTags([{ Key: 'GuardDutyMalwareScanStatus', Value: 'THREATS_FOUND' }]);
    await expect(s3.getMalwareScanStatus('a/b.pdf')).resolves.toBe('infected');
  });

  it('reads no tag at all as still scanning', async () => {
    /** GuardDuty tags asynchronously, so the window between upload and tag is normal and
     *  the honest answer is "not yet" — the one status the UI is allowed to retry. */
    const s3 = withTags([]);
    await expect(s3.getMalwareScanStatus('a/b.pdf')).resolves.toBe('pending');
  });

  it('reads OTHER tags as still scanning, not as clean', async () => {
    // A bucket can carry unrelated tags; only the GuardDuty one answers this question.
    const s3 = withTags([{ Key: 'Environment', Value: 'prod' }]);
    await expect(s3.getMalwareScanStatus('a/b.pdf')).resolves.toBe('pending');
  });

  it('fails closed on a scan status it does not recognise', async () => {
    /** ACCESS_DENIED, UNSUPPORTED, FAILED — and anything GuardDuty adds later. None of
     *  them is evidence the file is safe, so none of them may read as clean. */
    for (const value of ['ACCESS_DENIED', 'UNSUPPORTED', 'FAILED', 'SOMETHING_NEW']) {
      const s3 = withTags([{ Key: 'GuardDutyMalwareScanStatus', Value: value }]);
      await expect(s3.getMalwareScanStatus('a/b.pdf'), value).resolves.toBe('unavailable');
    }
  });

  it('fails closed when the tags cannot be read', async () => {
    /** Transport, auth, or the object being gone. "I could not check" must never widen
     *  into "it is fine". */
    reply.error = new Error('AccessDenied');
    const s3 = new AwsS3Client(base);
    await expect(s3.getMalwareScanStatus('a/b.pdf')).resolves.toBe('unavailable');
  });

  it('asks for the tags of the key it was given', async () => {
    const s3 = withTags([]);
    await s3.getMalwareScanStatus('receipts/2026/x.pdf');
    expect(sent.at(-1)).toBeInstanceOf(GetObjectTaggingCommand);
    expect((sent.at(-1) as { input: Record<string, unknown> }).input).toMatchObject({
      Bucket: 'receipts',
      Key: 'receipts/2026/x.pdf',
    });
  });
});
