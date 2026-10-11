// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * VeloExpense: a job runs as the tenant its payload names, or not at all.
 *
 * The worker connects as `veloapp`, under RLS. A payload without a tenant cannot run — `db`
 * throws outside a scope — and must not be "rescued" by guessing one, so it is refused
 * before any statement, with a message that says why.
 */

const h = vi.hoisted(() => ({
  scoped: vi.fn(),
  enqueue: vi.fn(async () => undefined),
  sql: [] as string[],
  orgs: [] as string[],
}));
vi.mock('@/lib/db/prisma', () => ({
  withTenantStatements: (org: string, run: () => Promise<unknown>) => {
    h.scoped(org);
    return run();
  },
}));
vi.mock('@expenseos/jobs', () => ({ enqueue: h.enqueue }));
vi.mock('@/lib/tenant/context', () => ({
  withoutOrg: async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      query: async (sql: string) => {
        h.sql.push(sql);
        return { rows: h.orgs.map((id) => ({ id })) };
      },
    }),
}));

const { fanOutToTenants, inTenant } = await import('./tenant');

beforeEach(() => {
  h.scoped.mockClear();
  h.enqueue.mockClear();
  h.sql = [];
  h.orgs = [];
});

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

describe('fanOutToTenants (w3-05)', () => {
  it('queues one job per tenant, each naming its tenant, and runs nothing itself', async () => {
    h.orgs = ['org-1', 'org-2'];
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await expect(fanOutToTenants('expense.receiptChase', { trigger: 'cron' })).resolves.toBe(2);
    expect(h.enqueue.mock.calls).toEqual([
      ['expense.receiptChase', { trigger: 'cron', organizationId: 'org-1' }],
      ['expense.receiptChase', { trigger: 'cron', organizationId: 'org-2' }],
    ]);
    expect(h.scoped).not.toHaveBeenCalled();
  });

  it('skips a suspended organization: nobody can act on a reminder about it', async () => {
    await fanOutToTenants('expense.receiptChase', { trigger: 'cron' });
    expect(h.sql[0]).toContain("status <> 'suspended'");
  });

  it('queues nothing when there are no tenants', async () => {
    await expect(fanOutToTenants('expense.receiptChase', { trigger: 'cron' })).resolves.toBe(0);
    expect(h.enqueue).not.toHaveBeenCalled();
  });
});
