/**
 * Loads .env.local + .env from the repo root so the worker boots
 * with the same env contract as the web app's next.config.ts. In prod
 * (ECS), env is injected by the task definition and these files do
 * not exist — dotenv silently no-ops.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

if (process.env.NODE_ENV !== 'production') {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // VeloExpense: worker/src/lib → up three to the repo root (ExpenseOS's apps/worker/src/lib
  // is four down from its monorepo root). After bundling, `here` is worker/dist, which is
  // only ever run with NODE_ENV=production, so this branch is not taken there.
  const root = path.resolve(here, '..', '..', '..');
  dotenv.config({ path: path.join(root, '.env.local'), quiet: true });
  dotenv.config({ path: path.join(root, '.env'), quiet: true });
}
