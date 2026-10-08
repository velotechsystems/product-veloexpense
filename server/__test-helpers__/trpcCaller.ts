/**
 * tRPC test harness — build a procedure `ctx` with an injected db / session /
 * rbac so router procedures can be exercised without the per-request context
 * assembly (`createTRPCContext`), which pulls in NextAuth + the Redis-cached
 * RBAC lookup.
 *
 * Pair with `createCallerFactory` from `@/server/trpc`:
 *
 *   const { createCallerFactory } = await import('@/server/trpc');
 *   const { expensesRouter } = await import('@/server/routers/expenses');
 *   const caller = createCallerFactory(expensesRouter)(
 *     makeContext({ db, userId, permissions: [P.expense.report.updateOwn] }),
 *   );
 *
 * This module is import-side-effect-free (type-only import of `Context`), so it
 * is safe to import at the top of a test even in the hermetic unit run that
 * never sets `DATABASE_URL`. Import the tRPC root + router *dynamically* inside
 * a `beforeAll` (they eagerly load the Prisma client).
 */

import type { Context } from '@/server/trpc';

export interface TestCtxOptions {
  /** The Prisma client (a real test-DB client, or a stub). Becomes `ctx.db`. */
  db: unknown;
  /** Authenticated user id — drives `session.user.id` and `rbac.id`. */
  userId?: string;
  roleId?: string;
  roleLabel?: string;
  name?: string | null;
  email?: string | null;
  /** Permission strings the caller carries (checked by `withPermission`). */
  permissions?: readonly string[];
}

/** Assemble a `Context` for a server-side caller. Mirrors the shape produced by
 *  `createTRPCContext` (session + db + rbac) but fully injectable. */
export function makeContext(opts: TestCtxOptions): Context {
  const userId = opts.userId ?? '00000000-0000-7000-8000-0000000000a1';
  const roleId = opts.roleId ?? '00000000-0000-7000-8000-0000000000b1';
  const roleLabel = opts.roleLabel ?? 'Employee';
  return {
    session: {
      user: {
        id: userId,
        name: opts.name ?? 'Test User',
        email: opts.email ?? 'test@e.inc',
        roleId,
        roleLabel,
      },
      expires: '2999-01-01T00:00:00.000Z',
    },
    db: opts.db,
    rbac: {
      id: userId,
      roleId,
      roleLabel,
      permissions: opts.permissions ?? [],
    },
  } as unknown as Context;
}
