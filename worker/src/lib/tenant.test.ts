// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * VeloExpense: a job runs as the tenant its payload names, or not at all.
 *
 * The worker connects as `veloapp`, under RLS. A payload without a tenant cannot run — `db`
 * throws outside a scope — and must not be "rescued" by guessing one, so it is refused
 * before any statement, with a message that says why.
 */

const h = vi.hoisted(() => ({ scoped: vi.fn() }));
vi.mock('@/lib/db/prisma', () => ({
  withTenantStatements: (org: string, run: () => Promise<unknown>) => {
    h.scoped(org);
    return run();
  },
}));

const { inTenant } = await import('./tenant');

beforeEach(() => h.scoped.mockClear());

describe('inTenant', () => {
  it('runs the job in the scope of the tenant its payload names', async () => {
    const out = await inTenant({ organizationId: 'org-1', receiptId: 'r1' }, async () => 'done');
    expect(out).toBe('done');
    expect(h.scoped).toHaveBeenCalledWith('org-1');
  });

  it.each([{}, { organizationId: '' }, { organizationId: 7 }, null])(
    'refuses a payload with no tenant (%j), before anything runs',
    async (data) => {
      const run = vi.fn(async () => 'ran');
      await expect(inTenant(data, run)).rejects.toThrow(/organizationId/);
      expect(run).not.toHaveBeenCalled();
      expect(h.scoped).not.toHaveBeenCalled();
    },
  );
});
