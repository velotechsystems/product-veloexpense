import type { BoundedRead, Storage } from './index';

/**
 * Read an object only if it fits the caller's cap: HEAD first, then a bounded read.
 *
 * - HEAD finds no object → `missing`, and nothing is downloaded.
 * - HEAD reports more than `capBytes` → `too-large` with the exact `size`, and nothing is
 *   downloaded.
 * - Otherwise → `client.read(key, capBytes)`, which still stops at `capBytes` + 1 whatever
 *   HEAD said. HEAD can be stale (the object replaced in between) or report 0 for a missing
 *   `Content-Length`, so it is never the only bound.
 *
 * Any HEAD error is thrown and `read` is not called: a failed size check never turns into an
 * unchecked download.
 *
 * `capBytes` is the caller's cap and is used as given. It is deliberately not compared with
 * the 25 MiB upload ceiling, because some objects read this way (inbound mail) are not
 * uploads. It must be a positive safe integer.
 *
 * Its own subpath, `@expenseos/storage/guarded-read`, so production code imports it from
 * there: a test that mocks `@expenseos/storage` wholesale then still runs this logic for real
 * against its `head` / `read` doubles.
 *
 * Ported from ExpenseOS's `packages/storage/src/guardedRead.ts` (550b2945). VeloExpense:
 * the storage seam is `lib/storage` (its own module here, for the same reason), and its
 * `head` answers `sizeBytes` where ExpenseOS's answers `size`.
 */
export async function guardedRead(
  client: Pick<Storage, 'head' | 'read'>,
  key: string,
  capBytes: number,
): Promise<BoundedRead> {
  if (!Number.isSafeInteger(capBytes) || capBytes <= 0) {
    throw new RangeError(`guardedRead capBytes must be a positive integer; got ${capBytes}`);
  }
  const meta = await client.head(key);
  if (!meta) return { ok: false, reason: 'missing' };
  if (meta.sizeBytes > capBytes) return { ok: false, reason: 'too-large', size: meta.sizeBytes };
  return client.read(key, capBytes);
}
