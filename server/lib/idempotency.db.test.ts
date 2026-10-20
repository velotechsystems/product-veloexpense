// @vitest-environment node
// Ported from ExpenseOS `apps/web/src/server/lib/idempotency.db.test.ts` (1e682dd6), w6-04 (d88).
// Each adaptation is marked "VeloExpense (w6-04):".
/* eslint-disable @typescript-eslint/no-explicit-any -- VeloExpense (w6-04): ExpenseOS's suite holds its db untyped (`any`); Biome allows it there. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTenantHarness, type TenantHarness } from '../__test-helpers__/tenantHarness';
import { mintToken } from './apiKeys';
import { claim, complete, release, requestHash } from './idempotency';

/**
 * Replay protection, against a real database.
 *
 * The failure this prevents is concrete: an MCP client whose `submit_expense_report` times
 * out retries, and the report is submitted twice. Every branch below is a distinct way that
 * could still happen — or a way the protection itself could become the outage.
 *
 * Gated on DATABASE_URL; the hermetic run skips it.
 */

// VeloExpense (w6-04): VeloExpense's auth module, as the other ported suites.
vi.mock('@/auth', () => ({ auth: vi.fn(async () => null) }));

describe.skipIf(!process.env.DATABASE_URL)('idempotency (integration)', () => {
  let db: any;
  // VeloExpense (w6-04): a fresh tenant (the harness); its `db` runs each call in that tenant.
  let h: TenantHarness;
  let keyId: string;
  const keyIds: string[] = [];

  beforeAll(async () => {
    h = await createTenantHarness({ slug: 'idempotency', name: 'Idempotency Co' });
    db = h.db;
    const user = await db.user.findFirstOrThrow({ where: { deletedAt: null } });
    const minted = mintToken('USER');
    const row = await db.apiKey.create({
      data: {
        kind: 'USER',
        name: 'idempotency key',
        prefix: minted.prefix,
        tokenHash: minted.tokenHash,
        userId: user.id,
        createdById: user.id,
        scopes: [],
      },
    });
    keyIds.push(row.id);
    keyId = row.id;
  });

  afterAll(async () => {
    await db.apiKeyIdempotency.deleteMany({ where: { apiKeyId: { in: keyIds } } });
    await db.apiKey.deleteMany({ where: { id: { in: keyIds } } });
    await h?.end();
  });

  const input = { reportId: 'r1' };

  it('lets the first call through', async () => {
    const res = await claim(db, keyId, 'k-first', 'submit_expense_report', input);
    expect(res.kind).toBe('proceed');
  });

  it('replays the stored result on a repeat', async () => {
    const first = await claim(db, keyId, 'k-replay', 'submit_expense_report', input);
    if (first.kind !== 'proceed') throw new Error('expected proceed');
    await complete(db, first.id, 'submit_expense_report', { reportId: 'r1', status: 'SUBMITTED' });

    const second = await claim(db, keyId, 'k-replay', 'submit_expense_report', input);
    expect(second).toEqual({
      kind: 'replay',
      response: { reportId: 'r1', status: 'SUBMITTED' },
    });
  });

  it('refuses a concurrent duplicate while the first is still running', async () => {
    // The branch that makes this safe rather than usually-right: two simultaneous retries
    // would both miss a COMPLETED record and both act.
    await claim(db, keyId, 'k-inflight', 'submit_expense_report', input);
    expect(await claim(db, keyId, 'k-inflight', 'submit_expense_report', input)).toEqual({
      kind: 'in_flight',
    });
  });

  it('refuses a key reused with different arguments', async () => {
    // A client bug worth surfacing, not a replay to absorb — returning the earlier result
    // would answer a question nobody asked.
    const first = await claim(db, keyId, 'k-mismatch', 'submit_expense_report', input);
    if (first.kind !== 'proceed') throw new Error('expected proceed');
    await complete(db, first.id, 'submit_expense_report', { ok: true });
    expect(
      await claim(db, keyId, 'k-mismatch', 'submit_expense_report', { reportId: 'DIFFERENT' }),
    ).toEqual({ kind: 'mismatch' });
  });

  it('treats the same key on a different tool as a mismatch', async () => {
    const first = await claim(db, keyId, 'k-tool', 'submit_expense_report', input);
    if (first.kind !== 'proceed') throw new Error('expected proceed');
    await complete(db, first.id, 'submit_expense_report', { ok: true });
    expect(await claim(db, keyId, 'k-tool', 'recall_expense_report', input)).toEqual({
      kind: 'mismatch',
    });
  });

  it('releases a claim that produced nothing, so a retry is not locked out', async () => {
    // Without this a crashed call leaves the key claimed for 24 hours and every retry is
    // refused — the protection becomes the outage.
    const first = await claim(db, keyId, 'k-release', 'submit_expense_report', input);
    if (first.kind !== 'proceed') throw new Error('expected proceed');
    await release(db, first.id);
    expect((await claim(db, keyId, 'k-release', 'submit_expense_report', input)).kind).toBe(
      'proceed',
    );
  });

  it('reclaims an expired record rather than blocking the key forever', async () => {
    const first = await claim(db, keyId, 'k-expired', 'submit_expense_report', input);
    if (first.kind !== 'proceed') throw new Error('expected proceed');
    await complete(db, first.id, 'submit_expense_report', { ok: true });
    await db.apiKeyIdempotency.update({
      where: { id: first.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect((await claim(db, keyId, 'k-expired', 'submit_expense_report', input)).kind).toBe(
      'proceed',
    );
  });

  it('scopes keys per API key, so two clients cannot collide', async () => {
    const user = await db.user.findFirstOrThrow({ where: { deletedAt: null } });
    const minted = mintToken('USER');
    const other = await db.apiKey.create({
      data: {
        kind: 'USER',
        name: 'second key',
        prefix: minted.prefix,
        tokenHash: minted.tokenHash,
        userId: user.id,
        createdById: user.id,
        scopes: [],
      },
    });
    keyIds.push(other.id);
    const a = await claim(db, keyId, 'shared-name', 'submit_expense_report', input);
    if (a.kind !== 'proceed') throw new Error('expected proceed');
    await complete(db, a.id, 'submit_expense_report', { ok: true });
    expect((await claim(db, other.id, 'shared-name', 'submit_expense_report', input)).kind).toBe(
      'proceed',
    );
  });

  it('fingerprints independently of key order', () => {
    expect(requestHash('t', { a: 1, b: 2 })).toBe(requestHash('t', { b: 2, a: 1 }));
  });
});
