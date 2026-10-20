import { isModuleActive } from '@expenseos/platform';
import { ForbiddenError, type Permission } from '@expenseos/rbac';
import { resolveRbacUser } from '@expenseos/rbac/server';
import { initTRPC, TRPCError } from '@trpc/server';
import superjson from 'superjson';
import { ZodError } from 'zod';
import { auth } from '@/auth';
import { db, type TenantDb, withTenantDb, withTenantStatementsHere } from '@/lib/db/prisma';
import { hostTenantSlug } from '@/lib/tenant/request';
import { refusalData } from '@/server/refusal';

/**
 * Ported from ExpenseOS `apps/web/src/server/trpc.ts` (550b2945). Everything from
 * `initTRPC` down is ExpenseOS's, unchanged except where marked "VeloExpense:". What
 * differs is the CONTEXT, because the two apps establish who is asking differently:
 *
 *   ExpenseOS                          VeloExpense
 *   ─────────────────────────────────  ─────────────────────────────────────────────
 *   one company per deployment         many tenants; the session names the tenant
 *   session carries user id + roleId   session carries email + organizationId; the
 *                                      role is read from `app_user` per request
 *   `db` is the whole database         `db` is scoped to one tenant by RLS, and is
 *                                      only usable inside `withTenantDb`
 *   Role rows + Redis permission cache three fixed roles mapped onto ExpenseOS's
 *                                      system roles until Wave 4 (rbac/loader.ts)
 *
 * So the context is built in two steps. `createTRPCContext` reads the session (no
 * database). The `tenant` middleware, which every procedure runs, then opens ONE tenant
 * transaction for the whole procedure, refuses a host that names another tenant, reads
 * the caller's `app_user` row, and fills in the ExpenseOS-shaped `session.user` and
 * `rbac` that ported routers read. A procedure's writes commit or roll back together.
 */

/** The ExpenseOS session shape ported routers read (`ctx.session.user.id`, …). */
export interface Session {
  user: {
    /** `app_user.id` — what ExpenseOS's routers write as createdById, submitterId, … */
    id: string;
    /** `app_user.display_name`; the sidebar falls back to the email when it is empty. */
    name: string | null;
    email: string;
    roleId: string;
    roleLabel: string;
    organizationId: string;
  };
}

/** What the session says before the tenant middleware has read the database. */
export interface Caller {
  email: string;
  organizationId: string;
}

/**
 * tRPC context — assembled per-request and made available inside every
 * procedure as `ctx`. Carries:
 *   - `session`: the caller, ExpenseOS-shaped (or null until `tenant` fills it).
 *   - `db`: the tenant-scoped Prisma client (lib/db/prisma.ts).
 *   - `rbac`: the resolved RbacUser, populated by `tenant` for a member.
 */
export const createTRPCContext = async () => {
  const authSession = await auth();
  const email = authSession?.user?.email ?? null;
  const organizationId =
    (authSession?.user as { organizationId?: string } | undefined)?.organizationId ?? null;
  const caller: Caller | null = email && organizationId ? { email, organizationId } : null;
  return {
    session: null as Session | null,
    db,
    rbac: null as Awaited<ReturnType<typeof resolveRbacUser>> | null,
    caller,
  };
};
export type Context = Awaited<ReturnType<typeof createTRPCContext>>;

/**
 * f63: per-procedure options the middleware reads.
 *
 * `tenantScope: 'statements'` — the procedure runs statement-at-a-time (each query its own
 * short tenant transaction, under RLS as ever) instead of inside one transaction for the whole
 * call. For a procedure that WAITS on the network between its queries — the assistant's article
 * reads, up to ten model calls — so it never holds a pooled connection idle in a transaction.
 * The trade is atomicity: such a procedure must not need its writes to commit or fail together
 * (any that must, wrap them in `ctx.db.$transaction(fn)`, which opens one real transaction).
 */
export interface ProcedureMeta {
  tenantScope?: 'transaction' | 'statements';
}

const t = initTRPC.context<Context>().meta<ProcedureMeta>().create({
  transformer: superjson,
  errorFormatter({ shape, error }) {
    const zodError = error.cause instanceof ZodError ? error.cause.flatten() : null;
    return {
      ...shape,
      message: safeMessage(shape.message, error, zodError),
      // `refusal` is the translatable form of a deliberate refusal — see `refusal.ts`.
      // Null for every other error, so a client can test for it without a type guard.
      data: { ...shape.data, zodError, refusal: refusalData(error) },
    };
  },
});

/**
 * The message a USER is allowed to see.
 *
 * Two things reached the screen verbatim (GA readiness report F05, blocker B8):
 *
 *   · `Invalid prisma.expenseLineItem.update() invocation: Value out of range for the
 *     type: value "100000000000000000" is out of range for type bigint` — naming the ORM,
 *     the model and the column type;
 *   · a raw Zod issue array, `[{"origin":"number","code":"too_small",…,"path":["sizeBytes"]}]`,
 *     rendered as JSON.
 *
 * Both are information disclosure and neither is usable by the person reading it. An
 * unexpected server error now says so and nothing else; the original keeps going to the
 * server log, where it is useful and not public.
 *
 * A message a resolver wrote ON PURPOSE is left alone — `TRPCError({ message })` is how
 * every deliberate refusal in this codebase speaks to the user ("Add at least one expense
 * before submitting."), and laundering those would be worse than the leak. The line
 * between the two is `INTERNAL_SERVER_ERROR`, which is what an uncaught throw becomes.
 */
/**
 * What to say when a guard gave a code and no message.
 *
 * `TRPCError` defaults `message` to the CODE when none is supplied, and dozens of guards
 * here are written exactly that way — `throw new TRPCError({ code: 'NOT_FOUND' })`. Each
 * one therefore rendered its own HTTP status word at the user: the GA v2 audit hit a red
 * banner containing the single word FORBIDDEN (V2-14).
 *
 * Phrased for the person who hit it, not for the transport. None mentions a status code,
 * a request, or anything "sent" — the reader filled in a form; the wire is our business.
 */
const CODE_MESSAGES: Record<string, string> = {
  FORBIDDEN: 'You do not have permission to do that.',
  UNAUTHORIZED: 'Please sign in again to continue.',
  NOT_FOUND: 'That record no longer exists, or you do not have access to it.',
  CONFLICT: 'Somebody else changed this first. Reload and try again.',
  BAD_REQUEST: 'Some of the details are not valid. Check the highlighted fields.',
  PRECONDITION_FAILED: 'This cannot be done yet. Check the highlighted fields.',
  TIMEOUT: 'That took too long. Try again.',
  TOO_MANY_REQUESTS: 'Too many attempts. Wait a moment and try again.',
  PAYLOAD_TOO_LARGE: 'That is too large to upload.',
  UNSUPPORTED_MEDIA_TYPE: 'That file type is not supported.',
  BAD_GATEWAY: 'A system we depend on did not answer. Try again shortly.',
  SERVICE_UNAVAILABLE: 'That service is unavailable right now. Try again shortly.',
};

function safeMessage(
  message: string,
  error: { code: string; cause?: unknown },
  zodError: unknown,
): string {
  // "values SENT" described the request rather than the reader's situation (V2-04).
  if (zodError) return 'Some of the details are not valid. Check the highlighted fields.';
  /**
   * The message IS the code, so nobody wrote one. Substituting here fixes every
   * message-less guard at once — including the ones not written yet — rather than
   * editing dozens of throw sites and hoping the next author remembers.
   */
  if (message === error.code) {
    return CODE_MESSAGES[error.code] ?? 'That request could not be completed.';
  }
  if (error.code !== 'INTERNAL_SERVER_ERROR') return message;
  // Logged, not shown. Everything below this line is deliberately not user-facing.
  console.error('[trpc] unhandled error', error.cause ?? message);
  return 'Something went wrong on our side. The details have been logged.';
}

/**
 * Domain refusals that are thrown as typed errors by shared packages, translated to the
 * tRPC code they mean.
 *
 * `recomputeReportTotal` (packages/db) refuses to rewrite a decided or NetSuite-posted
 * report's total by throwing `ReportTotalFrozenError`. It cannot throw a `TRPCError` —
 * the package is shared with the worker and does not know tRPC exists — and left alone
 * the throw would surface as INTERNAL_SERVER_ERROR: logged as a crash, shown as "something
 * went wrong", when what happened is a precondition the caller can understand. Mapped
 * once, here, rather than wrapped at each of the six call sites and forgotten at the
 * seventh.
 */
/**
 * VeloExpense: ExpenseOS imports this from `@expenseos/db`, beside `ReportTotalFrozenError`
 * and the report-total recompute it guards. Those arrive with the expense core (Wave 2);
 * the check is by `name`, exactly as ExpenseOS's is, so it needs nothing else from there.
 */
function isReportTotalFrozenError(err: unknown): err is Error {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { name?: unknown }).name === 'ReportTotalFrozenError'
  );
}

const domainErrors = t.middleware(async ({ next }) => {
  const result = await next();
  if (!result.ok && isReportTotalFrozenError(result.error.cause)) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: result.error.cause.message,
      cause: result.error.cause,
    });
  }
  return result;
});

/**
 * VeloExpense: the tenant scope. Not in ExpenseOS, which has one tenant.
 *
 * Runs the rest of the procedure inside `withTenantDb`, so every query a ported router
 * makes through `ctx.db` (or the `db` it imports) is filtered by RLS to the caller's
 * organization, and its writes land there by the column default.
 *
 * A failed procedure is RETHROWN inside the scope, because tRPC hands middleware a result
 * object rather than throwing: returning `{ ok: false }` from inside the transaction would
 * COMMIT whatever the procedure wrote before it failed.
 *
 * No session (or one with no organization): runs unscoped, with `session` and `rbac` null.
 * `db` throws if touched, `protectedProcedure` refuses — the same outcome as ExpenseOS's
 * signed-out request.
 */
const tenant = t.middleware(async ({ ctx, next, meta }) => {
  if (!ctx.caller) return next();
  const caller = ctx.caller;
  const hostSlug = await hostTenantSlug();
  if (meta?.tenantScope === 'statements') {
    // f63: who is asking is resolved in one short transaction; the procedure then runs
    // statement-at-a-time (ProcedureMeta). A failure has nothing to roll back beyond the
    // statement that failed, so it is rethrown for the same reason as below: one shape.
    const member = await withTenantDb(caller.organizationId, (tx) => resolveTenantMember(tx, caller, hostSlug));
    return withTenantStatementsHere(caller.organizationId, async () => {
      const result = await next({ ctx: { ...ctx, ...member } });
      if (!result.ok) throw result.error;
      return result;
    });
  }
  return withTenantDb(caller.organizationId, async (tx) => {
    const { session, rbac } = await resolveTenantMember(tx, caller, hostSlug);
    const result = await next({ ctx: { ...ctx, session, rbac } });
    if (!result.ok) throw result.error;
    return result;
  });
});

/** f04: why `resolveTenantMember` refused a signed-in person who IS on this tenant's books. */
export class MemberRefusal extends Error {
  constructor(readonly reason: 'ACCOUNT_DEACTIVATED' | 'ACCESS_REVOKED') {
    super(reason);
    this.name = 'MemberRefusal';
  }
}

/**
 * VeloExpense: who the caller is in their tenant — the ExpenseOS-shaped `session.user` and
 * `rbac`. Shared by the tRPC `tenant` middleware and the server shell (`server/shell.ts`),
 * so the menu and the procedures can never disagree about who is asking. Runs inside the
 * caller's `withTenantDb` scope; refuses with a FORBIDDEN `TRPCError`.
 */
export async function resolveTenantMember(
  tx: TenantDb,
  caller: Caller,
  hostSlug: string | null,
): Promise<{ session: Session; rbac: Awaited<ReturnType<typeof resolveRbacUser>> }> {
  if (hostSlug !== null) {
    // `organization` has no tenant column and so no RLS policy: filtered by id, as
    // lib/tenant/request.ts does, or this would read every tenant's slug.
    const [org] = await tx.$queryRaw<{ slug: string }[]>`
      SELECT slug FROM organization WHERE id = ${caller.organizationId}::uuid`;
    if ((org?.slug ?? '') !== hostSlug) {
      throw new TRPCError({ code: 'FORBIDDEN', message: 'This address belongs to another organization.' });
    }
  }
  // The role comes from the DATABASE on every request, never from the session token:
  // a token outlives a demotion or a deactivation (lib/auth/actor.ts).
  // VeloExpense (w4-10a, d73): the person's role is their tenant's `role` row (0068).
  const [member] = await tx.$queryRaw<
    {
      id: string;
      display_name: string | null;
      role_id: string;
      role_label: Record<string, string>;
      deleted_at: Date | null;
      has_access: boolean;
    }[]
  >`SELECT u.id, u.display_name, u.role_id, r.label AS role_label, u.deleted_at, u.has_access
      FROM app_user u
      JOIN role r ON r.organization_id = u.organization_id AND r.id = u.role_id
     WHERE lower(u.email) = lower(${caller.email}) LIMIT 1`;
  if (!member) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'You are not a member of this organization.' });
  }
  // f04: the refusal carries its reason as `cause` (a MemberRefusal), so the root layout can
  // tell a deactivated person why the product is closed to them (server/shell.ts).
  if (member.deleted_at !== null) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'This account has been deactivated.',
      cause: new MemberRefusal('ACCOUNT_DEACTIVATED'),
    });
  }
  // People 1 (0072): access turned off on the People screen takes effect on the next request.
  if (!member.has_access) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Your access to this organization has been turned off.',
      cause: new MemberRefusal('ACCESS_REVOKED'),
    });
  }
  const roleId = member.role_id;
  // VeloExpense: English until the reader's locale reaches the tRPC context with next-intl —
  // ExpenseOS's session snapshot is `label.en` too (its auth.ts `resolveRoleLabel`).
  const roleLabel = member.role_label.en ?? '';
  const session: Session = {
    user: {
      id: member.id,
      name: member.display_name,
      email: caller.email,
      roleId,
      roleLabel,
      organizationId: caller.organizationId,
    },
  };
  const rbac = await resolveRbacUser(tx, {
    userId: member.id,
    roleId,
    roleLabel,
    organizationId: caller.organizationId,
  });
  return { session, rbac };
}

export const router = t.router;
export const publicProcedure = t.procedure.use(domainErrors).use(tenant);
/** Build a server-side caller for a router with an explicit context. Used by
 *  the tRPC test harness (`__test-helpers__/trpcCaller.ts`) to exercise
 *  procedures with an injected ctx (db / session / rbac). */
export const createCallerFactory = t.createCallerFactory;

/**
 * Procedures that require an authenticated session. Narrows `ctx.session`
 * and `ctx.rbac` to non-null values for consumers — no guards inside
 * resolver bodies.
 */
export const protectedProcedure = publicProcedure.use(({ ctx, next }) => {
  if (!ctx.session?.user || !ctx.rbac) {
    throw new TRPCError({ code: 'UNAUTHORIZED' });
  }
  return next({ ctx: { ...ctx, session: ctx.session, rbac: ctx.rbac } });
});

/**
 * Factory for procedures that require a specific permission. Translates
 * `ForbiddenError` from @expenseos/rbac into a tRPC 403.
 *
 * Usage:
 *   export const approveReport = withPermission(P.expense.report.approve)
 *     .input(...)
 *     .mutation(...)
 */
export function withPermission(permission: Permission) {
  return protectedProcedure.use(({ ctx, next }) => {
    if (!ctx.rbac.permissions.includes(permission)) {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: `Missing permission: ${permission}`,
        cause: new ForbiddenError(permission),
      });
    }
    return next();
  });
}

/**
 * Middleware enforcing that a module is installed + active. The server-side
 * companion to the sidebar's module gate (Sidebar.tsx) — so a deactivated
 * module's procedures return 403 even when reached by direct call, not just
 * hidden in the nav. Composable onto any procedure, including a permissioned
 * one:
 *
 *   export const importTransactions = withPermission(P.vcc.transactionImport)
 *     .use(moduleActive('virtual-credit-cards'))
 *     .input(...)
 *     .mutation(...)
 *
 * See docs/use-cases/15-platform-extensibility.md.
 */
export function moduleActive(slug: string) {
  return t.middleware(async ({ ctx, next }) => {
    if (!(await isModuleActive(ctx.db, slug))) {
      throw new TRPCError({ code: 'FORBIDDEN', message: `Module not active: ${slug}` });
    }
    return next();
  });
}

/** Convenience: an authenticated procedure gated solely by an active module. */
export function moduleProcedure(slug: string) {
  return protectedProcedure.use(moduleActive(slug));
}
