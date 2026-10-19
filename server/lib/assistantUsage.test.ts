import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * VeloExpense (w6-03): the assistant's metering — what a row says, and where it is written.
 *
 * The rows themselves are proved against Postgres in `server/routers/assistant.db.test.ts`
 * (the article reads). This pins the two shapes: the route's (a tenant transaction per call)
 * and a procedure's (collected, then written on its own transaction under a savepoint, so a
 * failed write never undoes the procedure).
 */

const h = vi.hoisted(() => ({
  recordUsage: vi.fn(),
  withTenantDb: vi.fn(),
}));

vi.mock('@/lib/ai/usage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/usage')>()),
  recordUsage: h.recordUsage,
}));
vi.mock('@/lib/db/prisma', () => ({ withTenantDb: h.withTenantDb }));

import { meterTurn, usageCollector } from './assistantUsage';

const ORG = '33333333-3333-4333-8333-333333333333';
const message = (id: string, usage: unknown = { input_tokens: 1200, output_tokens: 80 }) =>
  ({ id, model: 'claude-sonnet-5', usage }) as never;

beforeEach(() => {
  h.recordUsage.mockReset();
  h.withTenantDb.mockReset();
  h.withTenantDb.mockImplementation((_org: string, fn: (tx: unknown) => unknown) => fn('TX'));
});

describe('meterTurn', () => {
  it('writes one assistant row per call, in the tenant, against the person asking', async () => {
    await meterTurn({ organizationId: ORG, actorUserId: 'u-1' })(message('msg_1'));
    expect(h.withTenantDb).toHaveBeenCalledWith(ORG, expect.any(Function));
    expect(h.recordUsage).toHaveBeenCalledWith('TX', {
      feature: 'assistant',
      model: 'claude-sonnet-5',
      inputTokens: 1200,
      outputTokens: 80,
      requestId: 'msg_1',
      actorUserId: 'u-1',
    });
  });

  it('writes nothing for a response that reports no usage', async () => {
    await meterTurn({ organizationId: ORG, actorUserId: 'u-1' })(message('msg_2', null));
    expect(h.recordUsage).not.toHaveBeenCalled();
  });
});

describe('usageCollector', () => {
  const tx = () => ({ $executeRaw: vi.fn(async () => 0) });
  const sql = (db: ReturnType<typeof tx>) =>
    db.$executeRaw.mock.calls.map((c) => (c as unknown as [TemplateStringsArray])[0].join('?'));

  it('records nothing until flushed, then every call, under one savepoint', async () => {
    const usage = usageCollector('u-2');
    await usage.onMessage(message('msg_a'));
    await usage.onMessage(message('msg_b'));
    expect(h.recordUsage).not.toHaveBeenCalled();
    const db = tx();
    await usage.flush(db as never);
    expect(h.recordUsage.mock.calls.map((c) => c[1].requestId)).toEqual(['msg_a', 'msg_b']);
    expect(h.recordUsage.mock.calls.every((c) => c[0] === db && c[1].actorUserId === 'u-2')).toBe(true);
    expect(sql(db)).toEqual(['SAVEPOINT assistant_usage', 'RELEASE SAVEPOINT assistant_usage']);
  });

  it('rolls back to the savepoint and carries on when a write fails', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    h.recordUsage.mockRejectedValueOnce(new Error('no'));
    const usage = usageCollector('u-2');
    await usage.onMessage(message('msg_c'));
    const db = tx();
    await expect(usage.flush(db as never)).resolves.toBeUndefined();
    expect(sql(db)).toEqual(['SAVEPOINT assistant_usage', 'ROLLBACK TO SAVEPOINT assistant_usage']);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('failed to record AI usage'));
  });

  it('touches nothing when there was no call', async () => {
    const db = tx();
    await usageCollector('u-2').flush(db as never);
    expect(db.$executeRaw).not.toHaveBeenCalled();
  });
});
