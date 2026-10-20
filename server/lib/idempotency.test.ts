import { describe, expect, it, vi } from 'vitest';
import { claim, complete, release, requestHash, SENSITIVE_TOOLS } from './idempotency';

/**
 * Replay protection for API-key calls.
 *
 * A client that retries a timed-out `submit_expense_report` would otherwise submit twice —
 * so the first call claims the key and a repeat returns the first outcome instead of
 * acting again. Four states, and each exists because a three-state version was wrong:
 *
 *   · **replay** — the retry anybody was worried about.
 *   · **in_flight** — two simultaneous retries would BOTH miss a COMPLETED record and both
 *     act. This is what makes the protection safe under concurrency rather than merely
 *     usually right.
 *   · **mismatch** — a key reused with different input is a client bug. Returning the
 *     earlier result would answer a question nobody asked.
 *   · **proceed** — including for an EXPIRED record, which must be reclaimed rather than
 *     blocking that key forever.
 *
 * And `release` exists because without it a call that crashed mid-flight leaves the key
 * IN_FLIGHT for 24 hours and every retry is refused: the protection becomes the outage.
 */

const NOW = new Date('2026-08-24T12:00:00Z');
const later = (ms: number) => new Date(NOW.getTime() + ms);

function makeDb(existing: unknown = null) {
  const upsert = vi.fn(async (_args: unknown) => ({ id: 'idem-1' }));
  const update = vi.fn(async (_args: unknown) => ({}));
  const del = vi.fn(async (_args: unknown) => ({}));
  return {
    db: {
      apiKeyIdempotency: {
        findUnique: vi.fn(async (_args: unknown) => existing),
        upsert,
        update,
        delete: del,
      },
    } as never,
    upsert,
    update,
    del,
  };
}

const record = (over: Record<string, unknown> = {}) => ({
  id: 'idem-1',
  requestHash: requestHash('submit_expense_report', { reportId: 'r-1' }),
  status: 'COMPLETED',
  response: { ok: true },
  expiresAt: later(60_000),
  ...over,
});

describe('requestHash', () => {
  it('is stable across key order, so a re-serialized retry still matches', () => {
    /**
     * The client is an LLM or a script; neither guarantees property order. Hashing the raw
     * JSON would report a mismatch — refusing a legitimate retry and telling the caller
     * they have a bug they do not have.
     */
    const a = requestHash('t', { a: 1, b: { c: 2, d: 3 } });
    const b = requestHash('t', { b: { d: 3, c: 2 }, a: 1 });
    expect(a).toBe(b);
  });

  it('ignores undefined properties, which JSON would have dropped anyway', () => {
    expect(requestHash('t', { a: 1, b: undefined })).toBe(requestHash('t', { a: 1 }));
  });

  it('distinguishes the same input sent to a different tool', () => {
    /** One key per client action. Two different tools sharing a key is a mismatch, not a
     *  replay — approving something is not submitting it. */
    expect(requestHash('approve', { id: '1' })).not.toBe(requestHash('reject', { id: '1' }));
  });

  it('distinguishes arrays from objects with the same members', () => {
    expect(requestHash('t', [1, 2])).not.toBe(requestHash('t', { 0: 1, 1: 2 }));
  });

  it('distinguishes array order, which is meaningful in a payload', () => {
    expect(requestHash('t', ['a', 'b'])).not.toBe(requestHash('t', ['b', 'a']));
  });

  it('handles a null and a primitive input without throwing', () => {
    expect(requestHash('t', null)).toEqual(expect.any(String));
    expect(requestHash('t', 42)).not.toBe(requestHash('t', '42'));
  });
});

describe('claim', () => {
  it('claims an unseen key and lets the call proceed', async () => {
    const { db, upsert } = makeDb(null);
    const result = await claim(db, 'key-1', 'idem-abc', 'submit_expense_report', { r: 1 }, NOW);
    expect(result).toEqual({ kind: 'proceed', id: 'idem-1' });
    const args = upsert.mock.calls[0][0] as { create: Record<string, unknown> };
    expect(args.create).toMatchObject({ status: 'IN_FLIGHT', apiKeyId: 'key-1', key: 'idem-abc' });
  });

  it('remembers the claim for a day — long enough for any sane retry', async () => {
    const { db, upsert } = makeDb(null);
    await claim(db, 'key-1', 'idem-abc', 'submit_expense_report', { r: 1 }, NOW);
    const args = upsert.mock.calls[0][0] as { create: { expiresAt: Date } };
    expect(args.create.expiresAt.getTime() - NOW.getTime()).toBe(24 * 60 * 60 * 1000);
  });

  it('replays the first outcome for a repeat of the same call', async () => {
    const { db } = makeDb(record());
    const result = await claim(
      db,
      'key-1',
      'idem-abc',
      'submit_expense_report',
      { reportId: 'r-1' },
      NOW,
    );
    expect(result).toEqual({ kind: 'replay', response: { ok: true } });
  });

  it('refuses a second call while the first is still running', async () => {
    /**
     * The case a COMPLETED-only check misses entirely: two retries arriving together both
     * see no completed record and both submit the report. This is the difference between
     * safe under concurrency and usually right.
     */
    const { db } = makeDb(record({ status: 'IN_FLIGHT', response: null }));
    const result = await claim(
      db,
      'key-1',
      'idem-abc',
      'submit_expense_report',
      { reportId: 'r-1' },
      NOW,
    );
    expect(result).toEqual({ kind: 'in_flight' });
  });

  it('reports a key reused with different input rather than absorbing it', async () => {
    /** Returning the earlier response would answer a question the caller did not ask —
     *  and would look to them like their new request succeeded. */
    const { db } = makeDb(record());
    const result = await claim(
      db,
      'key-1',
      'idem-abc',
      'submit_expense_report',
      { reportId: 'DIFFERENT' },
      NOW,
    );
    expect(result).toEqual({ kind: 'mismatch' });
  });

  it('checks the fingerprint before the status, so a mismatched in-flight key is a mismatch', async () => {
    // Otherwise a client bug would present as "your earlier call is still running".
    const { db } = makeDb(record({ status: 'IN_FLIGHT', requestHash: 'something-else' }));
    const result = await claim(db, 'key-1', 'idem-abc', 'submit_expense_report', { r: 1 }, NOW);
    expect(result).toEqual({ kind: 'mismatch' });
  });

  it('reclaims an expired record instead of blocking the key forever', async () => {
    /** A key is a client-chosen string. One that expired and could never be reused would
     *  make a well-behaved client's next call fail for a day. */
    const { db, upsert } = makeDb(record({ expiresAt: later(-1) }));
    const result = await claim(db, 'key-1', 'idem-abc', 'submit_expense_report', { r: 1 }, NOW);
    expect(result).toEqual({ kind: 'proceed', id: 'idem-1' });
    const args = upsert.mock.calls[0][0] as { update: Record<string, unknown> };
    expect(args.update).toMatchObject({ status: 'IN_FLIGHT', response: undefined });
  });

  it('treats a record expiring exactly now as expired', async () => {
    const { db } = makeDb(record({ expiresAt: NOW }));
    const result = await claim(db, 'key-1', 'idem-abc', 'submit_expense_report', { r: 1 }, NOW);
    expect(result).toMatchObject({ kind: 'proceed' });
  });

  it('scopes the key to the API key that used it', async () => {
    /** Two tenants choosing "retry-1" must not collide — the composite is what makes a
     *  client-chosen string safe as an identifier. */
    const { db } = makeDb(null);
    await claim(db, 'key-A', 'retry-1', 't', {}, NOW);
    const where = (
      db as unknown as {
        apiKeyIdempotency: { findUnique: { mock: { calls: Array<[{ where: unknown }]> } } };
      }
    ).apiKeyIdempotency.findUnique.mock.calls[0][0].where;
    expect(where).toEqual({ apiKeyId_key: { apiKeyId: 'key-A', key: 'retry-1' } });
  });
});

describe('complete', () => {
  it('stores the response so a retry can replay it', async () => {
    const { db, update } = makeDb(null);
    await complete(db, 'idem-1', 'submit_expense_report', { reportId: 'r-1' });
    expect((update.mock.calls[0][0] as { data: Record<string, unknown> }).data).toEqual({
      status: 'COMPLETED',
      response: { reportId: 'r-1' },
    });
  });

  it('stores null rather than undefined for a tool that returns nothing', async () => {
    // `undefined` in a Json column is "leave it alone", which would keep the row blank and
    // make the replay indistinguishable from an in-flight one.
    const { db, update } = makeDb(null);
    await complete(db, 'idem-1', 't', undefined);
    expect((update.mock.calls[0][0] as { data: { response: unknown } }).data.response).toBeNull();
  });

  it('swallows a failed write rather than failing the call that succeeded', async () => {
    /** The work is already done. Throwing here would report a failure for an action that
     *  went through, and the client would retry it. */
    const { db, update } = makeDb(null);
    update.mockRejectedValueOnce(new Error('row gone'));
    await expect(complete(db, 'idem-1', 't', { ok: true })).resolves.toBeUndefined();
  });

  it('has a list for tools whose results must never be stored', () => {
    /**
     * Empty today, deliberately. It exists so the FIRST tool that returns a secret has an
     * obvious place to be listed, rather than the question being noticed after a card
     * number has been sitting in a replay table with a different retention policy from the
     * encrypted column it came from.
     */
    expect(SENSITIVE_TOOLS.size).toBe(0);
  });
});

describe('release', () => {
  it('drops the claim so a retry is not refused for a day', async () => {
    /** Without this, a call that crashed mid-flight leaves the key IN_FLIGHT for 24 hours
     *  and every retry is refused — the protection becomes the outage. */
    const { db, del } = makeDb(null);
    await release(db, 'idem-1');
    expect(del).toHaveBeenCalledWith({ where: { id: 'idem-1' } });
  });

  it('ignores a claim that is already gone', async () => {
    const { db, del } = makeDb(null);
    del.mockRejectedValueOnce(new Error('not found'));
    await expect(release(db, 'idem-1')).resolves.toBeUndefined();
  });
});
