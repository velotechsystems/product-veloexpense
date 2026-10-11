import type { Prisma } from '@/lib/generated/prisma/client';
import { describe, expect, it, vi } from 'vitest';
import {
  currentDetermination,
  overridesForPrompt,
  overridesOf,
  recordOverrides,
  supersedeDetermination,
} from './determination';

describe('overridesOf', () => {
  it('reads a plain map', () => {
    expect(overridesOf({ total: '130.00', merchant: 'Acme' })).toEqual({
      total: '130.00',
      merchant: 'Acme',
    });
  });

  it('renders a non-string value rather than dropping it', () => {
    // The map goes into a prompt, so a number still has to say something.
    expect(overridesOf({ total: 130 } as never)).toEqual({ total: '130' });
  });

  it('skips nulls — a cleared override is not an override', () => {
    expect(overridesOf({ total: null, merchant: 'Acme' } as never)).toEqual({ merchant: 'Acme' });
  });

  it('reads anything that is not an object as empty', () => {
    // A display path must not break on one odd row.
    expect(overridesOf(null)).toEqual({});
    expect(overridesOf(undefined)).toEqual({});
    expect(overridesOf('nonsense' as never)).toEqual({});
    expect(overridesOf([1, 2] as never)).toEqual({});
  });
});

describe('overridesForPrompt', () => {
  it('flattens to the field/value pairs the determination pass consumes', () => {
    expect(overridesForPrompt({ total: '130.00' })).toEqual([{ field: 'total', value: '130.00' }]);
  });
});

/** A determination row stub with just the delegate the helpers touch. */
type UpdateArg = { where: { id: string }; data: { overrides: Record<string, string> } };
type CreateArg = { data: { overrides: Record<string, string> } };

function stubDb(current: { id: string; overrides: unknown } | null) {
  const update = vi.fn(async (_arg: UpdateArg) => ({}));
  const create = vi.fn(async (_arg: CreateArg) => ({ id: 'new-det' }));
  return {
    db: {
      expenseDetermination: {
        findFirst: vi.fn(async () => current),
        update,
        create,
      },
    } as never,
    update,
    create,
  };
}

describe('recordOverrides', () => {
  it('merges onto the current determination without forgetting earlier fields', async () => {
    const { db, update } = stubDb({ id: 'det-1', overrides: { merchant: 'Acme' } });
    await recordOverrides(db, 'exp-1', { total: '130.00' });
    expect(update).toHaveBeenCalledWith({
      where: { id: 'det-1' },
      data: { overrides: { merchant: 'Acme', total: '130.00' } },
    });
  });

  it('null CLEARS a field — reverting to what was proposed is not a disagreement', async () => {
    const { db, update } = stubDb({ id: 'det-1', overrides: { merchant: 'Acme', total: '1' } });
    await recordOverrides(db, 'exp-1', { total: null });
    expect(update).toHaveBeenCalledWith({
      where: { id: 'det-1' },
      data: { overrides: { merchant: 'Acme' } },
    });
  });

  it('does nothing when there is no determination — manual entry is not an override', async () => {
    const { db, update } = stubDb(null);
    await recordOverrides(db, 'exp-1', { total: '130.00' });
    expect(update).not.toHaveBeenCalled();
  });

  it('ignores undefined — an untouched field is not an instruction', async () => {
    const { db, update } = stubDb({ id: 'det-1', overrides: {} });
    await recordOverrides(db, 'exp-1', { total: undefined, merchant: undefined });
    expect(update).not.toHaveBeenCalled();
  });

  it('records the latest value only — one opinion per field', async () => {
    const { db, update } = stubDb({ id: 'det-1', overrides: { total: '100.00' } });
    await recordOverrides(db, 'exp-1', { total: '130.00' });
    expect(update.mock.calls[0][0].data.overrides).toEqual({ total: '130.00' });
  });
});

describe('currentDetermination', () => {
  it('returns the live row with its overrides coerced', async () => {
    const { db } = stubDb(null);
    const withRow = {
      expenseDetermination: {
        findFirst: vi.fn(async () => ({
          id: 'det-1',
          receiptIds: ['r1', 'r2'],
          proposed: { total: 130 },
          overrides: { total: '130.00' },
          model: 'claude-sonnet-5',
          confidence: '0.910',
          createdAt: new Date('2026-08-06T00:00:00Z'),
        })),
        update: vi.fn(),
        create: vi.fn(),
      },
    } as never;
    void db;
    const out = await currentDetermination(withRow, 'exp-1');
    expect(out?.receiptIds).toEqual(['r1', 'r2']);
    expect(out?.overrides).toEqual({ total: '130.00' });
    // Decimal → number, so callers never do arithmetic on a Prisma Decimal.
    expect(out?.confidence).toBe(0.91);
  });

  it('returns null when the expense has no determination', async () => {
    const { db } = stubDb(null);
    expect(await currentDetermination(db, 'exp-1')).toBeNull();
  });
});

describe('supersedeDetermination', () => {
  it('carries the prior overrides forward and retires the old row', async () => {
    const create = vi.fn(async (_arg: CreateArg) => ({ id: 'det-2' }));
    const update = vi.fn(async (_arg: UpdateArg) => ({}));
    const db = {
      expenseDetermination: {
        findFirst: vi.fn(async () => ({ id: 'det-1', overrides: { total: '130.00' } })),
        create,
        update,
      },
    } as never;
    const out = await supersedeDetermination(db, {
      expenseId: 'exp-1',
      receiptIds: ['r1', 'r2'],
      proposed: { total: 130 },
      model: 'claude-sonnet-5',
      confidence: 0.9,
    });
    expect(out).toEqual({ id: 'det-2' });
    // A correction survives every rebuild until its author changes their mind.
    expect(create.mock.calls[0][0].data.overrides).toEqual({ total: '130.00' });
    // The chain is auditable rather than overwritten.
    expect(update).toHaveBeenCalledWith({
      where: { id: 'det-1' },
      data: { supersededById: 'det-2' },
    });
  });

  it('accepts a transaction client, so it can join a caller’s transaction', async () => {
    /**
     * The joint rebuild writes the determination INSIDE the transaction that holds the
     * report row's lock, alongside the figures it explains — a chain that survived a
     * rolled-back apply would describe numbers the expense does not have.
     *
     * That is only possible because this takes the narrowest client its body needs. A
     * `Prisma.TransactionClient` has no `$transaction`, so it never satisfied the old
     * `PrismaClient` parameter at all. The annotation below is the assertion `tsc`
     * checks; the call is what proves the body only ever touches that one delegate.
     */
    const create = vi.fn(async (_arg: CreateArg) => ({ id: 'det-1' }));
    const onlyDelegate = {
      expenseDetermination: { findFirst: vi.fn(async () => null), create, update: vi.fn() },
    };
    const inTransaction = (tx: Prisma.TransactionClient) =>
      supersedeDetermination(tx, { expenseId: 'exp-1', receiptIds: ['r1'], proposed: {} });
    await inTransaction(onlyDelegate as unknown as Prisma.TransactionClient);
    expect(create).toHaveBeenCalledOnce();
  });

  it('writes the first determination with no prior to retire', async () => {
    const create = vi.fn(async (_arg: CreateArg) => ({ id: 'det-1' }));
    const update = vi.fn(async (_arg: UpdateArg) => ({}));
    const db = {
      expenseDetermination: { findFirst: vi.fn(async () => null), create, update },
    } as never;
    await supersedeDetermination(db, {
      expenseId: 'exp-1',
      receiptIds: ['r1'],
      proposed: {},
    });
    expect(create.mock.calls[0][0].data.overrides).toEqual({});
    expect(update).not.toHaveBeenCalled();
  });
});
