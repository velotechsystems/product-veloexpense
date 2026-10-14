/**
 * @expenseos/rbac/server — server-only surface. Re-exports the cache
 * + loader primitives that depend on ioredis and the Prisma client.
 * Importing this from a client component will pull node:net, node:fs,
 * and the BullMQ-compatible Redis driver into the browser bundle —
 * use the bare `@expenseos/rbac` entry point for client components.
 *
 * VeloExpense (w4-10a): ExpenseOS's, now that roles are rows (0068).
 */
export {
  getRbacRedis,
  getRolePermissions,
  invalidateAllRoles,
  invalidateRolePermissions,
} from './cache';
export { resolveRbacUser } from './loader';
