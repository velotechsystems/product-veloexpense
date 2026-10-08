// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { stubFn } from '@/test-utils/stubFn';
import { makeContext } from '../__test-helpers__/trpcCaller';

// `@/server/trpc` pulls NextAuth in, which reaches for `next/server`. Same two mocks the
// other router tests use.
// VeloExpense: the session comes from `@/auth`.
vi.mock('@/auth', () => ({ auth: stubFn(async () => null) }));
vi.mock('@expenseos/rbac/server', () => ({ resolveRbacUser: stubFn(async () => null) }));

/**
 * Five people in the seeded directory share a display name with somebody else — two real
 * `User` rows for one human, usually one from the directory sync and one from an import.
 * The picker rendered both as the same string, so choosing an approver meant guessing
 * between two identical lines (GA readiness report F41).
 *
 * Whether those duplicate rows should exist at all is a data question (F37). The picker's
 * job is to stop making the reader guess, and it does that by qualifying only the entries
 * that are ambiguous — a picker full of emails is its own problem, so the common case has
 * to stay clean.
 */

// VeloExpense: one `name` (display_name), not firstName/lastName.
const USER = (over: Record<string, unknown> = {}) => ({
  id: 'u1',
  name: 'John Rim',
  email: 'john.rim@e.inc',
  ...over,
});

/** The real router over a stub `db`, so the wiring is exercised and not just the helper. */
async function search(rows: ReturnType<typeof USER>[], q = 'rim') {
  const db = { user: { findMany: async () => rows, findUnique: async () => rows[0] ?? null } };
  const { createCallerFactory } = await import('@/server/trpc');
  const { pickersRouter } = await import('./pickers');
  const caller = createCallerFactory(pickersRouter)(
    makeContext({ db: db as never, userId: 'me', permissions: [] }),
  );
  return caller.users.search({ q, limit: 20 });
}

describe('user picker labels', () => {
  it('qualifies two people who read the same', async () => {
    const rows = await search([
      USER({ id: 'a', email: 'john.rim@e.inc' }),
      USER({ id: 'b', email: 'jrim@e.inc' }),
    ]);
    expect(rows.map((r) => r.label)).toEqual([
      'John Rim · john.rim@e.inc',
      'John Rim · jrim@e.inc',
    ]);
    // The whole point: two entries the reader can tell apart.
    expect(new Set(rows.map((r) => r.label)).size).toBe(2);
  });

  it('leaves an unambiguous name alone', async () => {
    const rows = await search([
      USER({ id: 'a' }),
      USER({ id: 'b', name: 'Natalia Kuzma', email: 'nk@e.inc' }),
    ]);
    expect(rows.map((r) => r.label)).toEqual(['John Rim', 'Natalia Kuzma']);
  });

  it('qualifies all of a triple, not just the ones after the first', async () => {
    const rows = await search([
      USER({ id: 'a', email: 'one@e.inc' }),
      USER({ id: 'b', email: 'two@e.inc' }),
      USER({ id: 'c', email: 'three@e.inc' }),
    ]);
    expect(rows.every((r) => r.label.includes('@e.inc'))).toBe(true);
  });

  it('keeps the picker contract at { value, label }', async () => {
    // Anything more reaches every consumer of the combobox as an unannounced shape change.
    const rows = await search([USER()]);
    expect(Object.keys(rows[0] ?? {}).sort()).toEqual(['label', 'value']);
  });

  it('returns nothing below the minimum query length', async () => {
    expect(await search([USER()], 'r')).toEqual([]);
  });
});

// VeloExpense: ExpenseOS's `external-ID sources` cases are not here — the procedure is not
// ported (VeloExpense has no external-id sources yet; see pickers.ts).

describe('VeloExpense: GL account picker', () => {
  async function gl(q = '610') {
    const calls: Array<Record<string, unknown>> = [];
    const db = {
      glAccount: {
        findMany: async (args: Record<string, unknown>) => {
          calls.push(args);
          return [{ id: 'g1', number: '6100', name: 'Meals' }];
        },
      },
    };
    const { createCallerFactory } = await import('@/server/trpc');
    const { pickersRouter } = await import('./pickers');
    const caller = createCallerFactory(pickersRouter)(
      makeContext({ db: db as never, userId: 'me', permissions: [] }),
    );
    return { rows: await caller.glAccounts.search({ q, limit: 20 }), calls };
  }

  it('labels an account "<number> · <name>"', async () => {
    expect((await gl()).rows).toEqual([{ value: 'g1', label: '6100 · Meals' }]);
  });

  it('offers only active, postable accounts — the database refuses a heading on a category', async () => {
    const { calls } = await gl();
    expect(calls[0]).toMatchObject({ where: { isActive: true, isPostable: true } });
  });
});
