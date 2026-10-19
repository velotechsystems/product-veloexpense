// @vitest-environment node
import { TOOLS } from '@expenseos/mcp-server';
import { beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * `appRouter` pulls in NextAuth, which wants a Next runtime this environment has not got.
 * Every router test in this directory stubs it the same way and imports dynamically.
 */
// VeloExpense (w6-03): the session comes from `@/auth` (auth-kit).
vi.mock('@/auth', () => ({ auth: vi.fn(async () => null) }));
vi.mock('@expenseos/rbac/server', () => ({
  resolveRbacUser: vi.fn(),
  invalidateRolePermissions: vi.fn(async () => {}),
}));

/**
 * Every tool `path` names a procedure that actually exists.
 *
 * The registry opens by promising exactly this — "Every `path` is a real tRPC procedure
 * and every `permission` is the one that procedure actually declares" — and nothing
 * checked it. `@expenseos/mcp-server` cannot: the dependency runs the other way, so its
 * own tests can only assert the SHAPE of a path (`router.procedure`, two segments). A
 * typo like `travelRequests.formOption` satisfies that and fails at runtime, on the first
 * person who asks the assistant to do the thing.
 *
 * This is the only place both halves are in scope, so this is where the promise is kept.
 * It costs one import and catches every future path the same way.
 *
 * Written against the ROUTER rather than a hand-kept list, so it cannot rot: rename a
 * procedure and the tool pointing at it fails here, in the change that renamed it.
 */
describe('every MCP tool points at a real procedure', () => {
  let record: Record<string, unknown>;

  beforeAll(async () => {
    const { appRouter } = await import('./_app');
    record = appRouter._def.procedures as Record<string, unknown>;
  });

  it('has procedures to check against', () => {
    // Guards the guard: if the internals ever stop exposing this shape, the loop below
    // would pass vacuously on an empty set and assert nothing at all.
    expect(Object.keys(record).length).toBeGreaterThan(50);
  });

  /**
   * VeloExpense (w6-03): the assistant's own router (`assistant.*`, the help-article search)
   * arrives with Assistant 2 of 3, the server. Until then a tool pointing into it is pending,
   * not wrong. The case below retires the exemption: the moment the router is registered it
   * fails, naming this set, so the exemption cannot outlive its reason.
   */
  const PENDING_ROUTERS = new Set(['assistant']);

  it('pending routers are still pending', () => {
    for (const router of PENDING_ROUTERS) {
      expect(
        Object.keys(record).some((p) => p.startsWith(`${router}.`)),
        `the "${router}" router is registered now; remove it from PENDING_ROUTERS.`,
      ).toBe(false);
    }
  });

  for (const tool of TOOLS) {
    const pending = PENDING_ROUTERS.has(tool.path.split('.')[0]!);
    (pending ? it.skip : it)(`${tool.name} → ${tool.path}`, () => {
      expect(
        record[tool.path],
        `${tool.name} points at "${tool.path}", which is not a procedure on appRouter. ` +
          'Either the path is a typo or the procedure was renamed without updating the ' +
          'tool registry.',
      ).toBeDefined();
    });
  }
});
