// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { guardedRead } from './guardedRead';
import type { BoundedRead, StoredObjectHead } from './index';

/**
 * HEAD first, then the bounded read. A fake client, because what matters here is the
 * order and the short-circuits: an object HEAD already shows is over the cap, or absent,
 * must never be downloaded at all. The streaming bound itself is `s3.read.test.ts`'s.
 *
 * Ported from ExpenseOS's `guardedRead.test.ts` (550b2945). VeloExpense: `head` answers
 * `{ sizeBytes, contentType }` (lib/storage) where ExpenseOS's answers `{ size, … }`.
 */

const CAP = 10 * 1024 * 1024;
const meta = (size: number): StoredObjectHead => ({ sizeBytes: size, contentType: 'application/pdf' });
const bytes = new Uint8Array([1, 2, 3]);

const fake = (head: () => Promise<StoredObjectHead | null>) => ({
  head: vi.fn(head),
  read: vi.fn(async (): Promise<BoundedRead> => ({ ok: true, data: bytes })),
});

describe('guardedRead', () => {
  it('answers missing when HEAD finds nothing, without reading', async () => {
    const client = fake(async () => null);
    await expect(guardedRead(client, 'k', CAP)).resolves.toEqual({ ok: false, reason: 'missing' });
    expect(client.read).not.toHaveBeenCalled();
  });

  it('refuses cap + 1 with the exact size, without reading', async () => {
    const client = fake(async () => meta(CAP + 1));
    await expect(guardedRead(client, 'k', CAP)).resolves.toEqual({
      ok: false,
      reason: 'too-large',
      size: CAP + 1,
    });
    expect(client.read).not.toHaveBeenCalled();
  });

  it('reads exactly the cap, bounded by the same cap', async () => {
    const client = fake(async () => meta(CAP));
    await expect(guardedRead(client, 'k', CAP)).resolves.toEqual({ ok: true, data: bytes });
    expect(client.read).toHaveBeenCalledTimes(1);
    expect(client.read).toHaveBeenCalledWith('k', CAP);
  });

  it('rethrows a HEAD failure and does not read (fail closed)', async () => {
    const client = fake(async () => {
      throw new Error('AccessDenied');
    });
    await expect(guardedRead(client, 'k', CAP)).rejects.toThrow(/AccessDenied/);
    expect(client.read).not.toHaveBeenCalled();
  });

  it('still bounds the read when HEAD reports size 0', async () => {
    /** `head()` maps a missing `Content-Length` to 0, so 0 proves nothing: the read that
     *  follows must carry the cap, and its too-large answer must come through as is. */
    const client = fake(async () => meta(0));
    client.read.mockResolvedValueOnce({ ok: false, reason: 'too-large' });
    await expect(guardedRead(client, 'k', CAP)).resolves.toEqual({
      ok: false,
      reason: 'too-large',
    });
    expect(client.read).toHaveBeenCalledWith('k', CAP);
  });

  it('passes a read that finds the object gone after HEAD straight through', async () => {
    const client = fake(async () => meta(10));
    client.read.mockResolvedValueOnce({ ok: false, reason: 'missing' });
    await expect(guardedRead(client, 'k', CAP)).resolves.toEqual({ ok: false, reason: 'missing' });
  });

  it('uses a cap above the 25 MiB upload ceiling as given, without clamping', async () => {
    /** Inbound mail is read with 40 MiB (operator, 2026-09-28). A ~30 MB message under that
     *  cap must be read with that cap, not refused or clamped to the upload ceiling. */
    const client = fake(async () => meta(31_457_280));
    await expect(guardedRead(client, 'inbound/raw', 41_943_040)).resolves.toEqual({
      ok: true,
      data: bytes,
    });
    expect(client.read).toHaveBeenCalledWith('inbound/raw', 41_943_040);
  });

  it.each([0, -1, 1.5, Number.NaN])('throws for a cap of %s and touches nothing', async (cap) => {
    const client = fake(async () => meta(1));
    await expect(guardedRead(client, 'k', cap)).rejects.toThrow(/capBytes/);
    expect(client.head).not.toHaveBeenCalled();
    expect(client.read).not.toHaveBeenCalled();
  });
});
