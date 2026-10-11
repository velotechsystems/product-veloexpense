// @vitest-environment node
import type { Worker } from 'bullmq';
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';
import { installShutdown } from './shutdown';

/**
 * Draining the worker on SIGTERM.
 *
 * ECS sends SIGTERM and then kills the task after a grace period, so what happens in
 * between decides whether an in-flight job finishes or is abandoned mid-write.
 * `worker.close()` waits for the job it is holding, which is why a deploy does not have
 * to be timed around the queue.
 *
 * The re-entry guard is not defensive padding: SIGTERM followed by an impatient SIGINT
 * is exactly what a `docker stop` then Ctrl-C produces, and closing the same workers
 * twice while the first drain is still running is how a shutdown hangs instead of
 * finishing.
 */

describe('graceful shutdown', () => {
  const listeners: Array<{ signal: string; handler: () => Promise<void> }> = [];
  // VeloExpense: typed as `process.exit`'s own spy — vitest 2's bare `ReturnType<typeof vi.spyOn>`
  // does not accept it (ExpenseOS runs a newer vitest).
  let exit: MockInstance<typeof process.exit>;

  const makeWorker = (closeMs = 0) => {
    const close = vi.fn(() => new Promise<void>((resolve) => setTimeout(resolve, closeMs)));
    return { close } as unknown as Worker & { close: ReturnType<typeof vi.fn> };
  };

  const fire = async (signal: string) => {
    const found = listeners.find((l) => l.signal === signal);
    if (!found) throw new Error(`no handler for ${signal}`);
    await found.handler();
  };

  beforeEach(() => {
    listeners.length = 0;
    vi.spyOn(process, 'on').mockImplementation(((signal: string, handler: () => Promise<void>) => {
      listeners.push({ signal, handler });
      return process;
    }) as never);
    exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('listens for both the signals a container gets', () => {
    /**
     * SIGTERM is what an orchestrator sends; SIGINT is what a developer sends. A worker
     * that only handled one would abandon jobs in whichever case it missed.
     */
    installShutdown([makeWorker()]);
    expect(listeners.map((l) => l.signal).sort()).toEqual(['SIGINT', 'SIGTERM']);
  });

  it('closes every worker, not just the first', async () => {
    // One process runs a worker per queue; a partial drain abandons the others' jobs.
    const a = makeWorker();
    const b = makeWorker();
    installShutdown([a, b]);
    await fire('SIGTERM');
    expect(a.close).toHaveBeenCalled();
    expect(b.close).toHaveBeenCalled();
  });

  it('waits for the drain before exiting', async () => {
    /**
     * The whole point: `close()` resolves once the in-flight job is done, so exiting
     * before it would abandon exactly the work the grace period exists to protect.
     */
    const slow = makeWorker(20);
    installShutdown([slow]);
    await fire('SIGTERM');
    expect(slow.close).toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('exits zero — a drained worker is a successful shutdown', async () => {
    // A non-zero exit would read as a crash and colour the deployment red.
    installShutdown([makeWorker()]);
    await fire('SIGINT');
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('ignores a second signal while the first drain is running', async () => {
    /**
     * SIGTERM then an impatient Ctrl-C. Closing the same workers twice mid-drain is how
     * a shutdown hangs rather than completes.
     */
    const worker = makeWorker(10);
    installShutdown([worker]);
    await Promise.all([fire('SIGTERM'), fire('SIGINT')]);
    expect(worker.close).toHaveBeenCalledTimes(1);
  });

  it('says which signal it got and how long the drain took', async () => {
    // The two facts anybody reading a shutdown log actually wants.
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    installShutdown([makeWorker()]);
    await fire('SIGTERM');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('SIGTERM'));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('drained in'));
  });

  it('shuts down cleanly with no workers at all', async () => {
    // A worker process whose queue list is empty still has to exit on a signal.
    installShutdown([]);
    await fire('SIGTERM');
    expect(exit).toHaveBeenCalledWith(0);
  });
});
