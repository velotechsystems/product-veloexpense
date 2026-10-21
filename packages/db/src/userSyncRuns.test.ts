// eos batch 4 — ported from ExpenseOS `packages/db/src/userSyncRuns.test.ts` (67db2e33, #582); the
// dry-run case's kind is GOOGLE_DIRECTORY, the only one here.
import { describe, expect, it, vi } from 'vitest';
import { finishRun, heartbeatRun, openRun, pruneRuns, recordRunItems } from './userSyncRuns';

/**
 * The people-sync run report and its lock.
 *
 * The lock is what stops two nightly passes — or a manual run and the cron — writing the
 * same people at once; the reclaim rules are what stop a worker restart from losing a night:
 * a run that stopped heart-beating is taken over, and so is a run left by the very job that
 * is now being delivered again.
 */

const NOW = new Date('2026-10-14T02:30:00Z');
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

function fakeDb(live: { id: string; jobId: string | null; heartbeatAt: Date }[] = []) {
  return {
    userSyncRun: {
      findMany: vi.fn(async () => live),
      update: vi.fn(async () => ({})),
      create: vi.fn(async () => ({ id: 'new-run' })),
      deleteMany: vi.fn(async () => ({ count: 3 })),
    },
    userSyncRunItem: {
      createMany: vi.fn(async () => ({ count: 0 })),
      deleteMany: vi.fn(async () => ({ count: 2 })),
    },
  };
}
type Fake = ReturnType<typeof fakeDb>;
const asDb = (db: Fake) => db as never;

describe('openRun', () => {
  it('opens a run when nothing else is running', async () => {
    const db = fakeDb();
    const out = await openRun(asDb(db), { kind: 'GOOGLE_DIRECTORY', trigger: 'cron' }, NOW);
    expect(out).toEqual({ status: 'opened', runId: 'new-run' });
    expect(db.userSyncRun.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ kind: 'GOOGLE_DIRECTORY', dryRun: false, startedAt: NOW }),
      }),
    );
  });

  it('refuses while another live run of the same kind is heart-beating', async () => {
    const db = fakeDb([{ id: 'other', jobId: 'job-1', heartbeatAt: minutesAgo(2) }]);
    const out = await openRun(
      asDb(db),
      { kind: 'GOOGLE_DIRECTORY', trigger: 'cron', jobId: 'job-2' },
      NOW,
    );
    expect(out).toEqual({ status: 'busy', runId: 'other' });
    expect(db.userSyncRun.create).not.toHaveBeenCalled();
  });

  it('reclaims a run whose heartbeat went stale', async () => {
    const db = fakeDb([{ id: 'dead', jobId: 'job-1', heartbeatAt: minutesAgo(11) }]);
    const out = await openRun(asDb(db), { kind: 'GOOGLE_DIRECTORY', trigger: 'cron' }, NOW);
    expect(out.status).toBe('opened');
    expect(db.userSyncRun.update).toHaveBeenCalledWith({
      where: { id: 'dead' },
      data: expect.objectContaining({ status: 'ERROR', finishedAt: NOW }),
    });
  });

  it('takes over a fresh run left by the same job being delivered again', async () => {
    // BullMQ re-delivers a stalled job; yielding to its own half-finished run would lose it.
    const db = fakeDb([{ id: 'mine', jobId: 'job-1', heartbeatAt: minutesAgo(1) }]);
    const out = await openRun(
      asDb(db),
      { kind: 'GOOGLE_DIRECTORY', trigger: 'cron', jobId: 'job-1' },
      NOW,
    );
    expect(out.status).toBe('opened');
    expect(db.userSyncRun.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'mine' } }),
    );
  });

  it('never contends for the lock on a dry run', async () => {
    const db = fakeDb([{ id: 'other', jobId: null, heartbeatAt: minutesAgo(1) }]);
    const out = await openRun(
      asDb(db),
      // VeloExpense: GOOGLE_DIRECTORY is the only kind (no NetSuite, d80).
      { kind: 'GOOGLE_DIRECTORY', trigger: 'manual', dryRun: true },
      NOW,
    );
    expect(out.status).toBe('opened');
    expect(db.userSyncRun.findMany).not.toHaveBeenCalled();
  });
});

describe('progress and close', () => {
  it('heartbeats with or without totals', async () => {
    const db = fakeDb();
    await heartbeatRun(asDb(db), 'r1');
    await heartbeatRun(asDb(db), 'r1', { scanned: 5 });
    const calls = db.userSyncRun.update.mock.calls as unknown as [{ data: object }][];
    expect(calls[0][0].data).not.toHaveProperty('counts');
    expect(calls[1][0].data).toHaveProperty('counts', { scanned: 5 });
  });

  it('closes a run with its status, totals and message', async () => {
    const db = fakeDb();
    await finishRun(asDb(db), 'r1', { status: 'COMPLETED', counts: { created: 1 } });
    await finishRun(asDb(db), 'r1', { status: 'ERROR', message: 'boom' });
    const calls = db.userSyncRun.update.mock.calls as unknown as [{ data: object }][];
    expect(calls[0][0].data).toMatchObject({
      status: 'COMPLETED',
      counts: { created: 1 },
      message: null,
    });
    expect(calls[1][0].data).toMatchObject({ status: 'ERROR', message: 'boom' });
    expect(calls[1][0].data).not.toHaveProperty('counts');
  });

  it('records items, and writes nothing for an empty batch', async () => {
    const db = fakeDb();
    await recordRunItems(asDb(db), 'r1', []);
    expect(db.userSyncRunItem.createMany).not.toHaveBeenCalled();
    await recordRunItems(asDb(db), null, [
      { kind: 'GOOGLE_DIRECTORY', outcome: 'CREATED', userId: 'u1', externalRef: 'g1' },
    ]);
    expect(db.userSyncRunItem.createMany).toHaveBeenCalledWith({
      data: [
        {
          runId: null,
          kind: 'GOOGLE_DIRECTORY',
          outcome: 'CREATED',
          userId: 'u1',
          externalRef: 'g1',
          fields: {},
          message: null,
        },
      ],
    });
  });
});

describe('pruneRuns', () => {
  it('deletes runs and standalone items past the 90-day window', async () => {
    const db = fakeDb();
    const out = await pruneRuns(asDb(db), NOW);
    expect(out).toEqual({ runs: 3, items: 2 });
    const cutoff = new Date(NOW.getTime() - 90 * 24 * 60 * 60 * 1000);
    expect(db.userSyncRun.deleteMany).toHaveBeenCalledWith({
      where: { startedAt: { lt: cutoff } },
    });
    expect(db.userSyncRunItem.deleteMany).toHaveBeenCalledWith({
      where: { runId: null, createdAt: { lt: cutoff } },
    });
  });
});
