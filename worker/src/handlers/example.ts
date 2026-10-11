import type { JobMap } from '@expenseos/jobs';

/**
 * Demo handler. Useful for verifying the queue+worker round-trip end
 * to end without depending on Prisma, S3, or any external service.
 */
export async function handleExamplePing(data: JobMap['example.ping']): Promise<void> {
  console.log(`[example.ping] ${data.message}`);
}
