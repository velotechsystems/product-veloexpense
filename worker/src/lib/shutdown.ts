import type { Worker } from 'bullmq';

/**
 * Drain all workers gracefully on SIGTERM / SIGINT. BullMQ's
 * `worker.close()` waits for in-flight jobs to finish (up to its
 * lockDuration) before returning, then closes the Redis connection.
 */
export function installShutdown(workers: Worker[]): void {
  let shuttingDown = false;

  const handler = (signal: string) => async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[shutdown] ${signal} received, draining ${workers.length} workers`);
    const start = Date.now();
    await Promise.all(workers.map((w) => w.close()));
    console.log(`[shutdown] drained in ${Date.now() - start}ms`);
    process.exit(0);
  };

  process.on('SIGTERM', handler('SIGTERM'));
  process.on('SIGINT', handler('SIGINT'));
}
