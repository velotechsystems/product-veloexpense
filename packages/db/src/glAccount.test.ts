import { describe, expect, it, vi } from 'vitest';
import { glAccountIdForCategory, glAccountIdsForCategories } from './glAccount';

/**
 * The stamping helper exists because FOUR paths write expense line items, and four
 * copies of "look up the category's account" is how three end up correct and the
 * fourth quietly writes null. So what these tests hold is the contract those four
 * share: a missing account is a real `null`, not an omission, and looking up N lines
 * is one query.
 */

function stubDb(rows: { id: string; glAccountId: string | null }[]) {
  const findMany = vi.fn(async (args: { where: { id: { in: string[] } } }) =>
    rows.filter((r) => args.where.id.in.includes(r.id)),
  );
  const findUnique = vi.fn(
    async (args: { where: { id: string } }) => rows.find((r) => r.id === args.where.id) ?? null,
  );
  return { db: { expenseCategory: { findMany, findUnique } } as never, findMany, findUnique };
}

describe('glAccountIdsForCategories', () => {
  it('maps each category to its account', async () => {
    const { db } = stubDb([
      { id: 'cat-meals', glAccountId: 'acct-1' },
      { id: 'cat-travel', glAccountId: 'acct-2' },
    ]);
    const out = await glAccountIdsForCategories(db, ['cat-meals', 'cat-travel']);
    expect(out.get('cat-meals')).toBe('acct-1');
    expect(out.get('cat-travel')).toBe('acct-2');
  });

  it('maps an unmapped category to null — a real answer, not an omission', async () => {
    const { db } = stubDb([{ id: 'cat-meals', glAccountId: null }]);
    const out = await glAccountIdsForCategories(db, ['cat-meals']);
    // The caller writes this null, so "category was unmapped when filed" stays
    // distinguishable from "this line was never stamped".
    expect(out.has('cat-meals')).toBe(true);
    expect(out.get('cat-meals')).toBeNull();
  });

  it('de-duplicates, so five lines in one category are ONE lookup', async () => {
    const { db, findMany } = stubDb([{ id: 'cat-meals', glAccountId: 'acct-1' }]);
    await glAccountIdsForCategories(db, ['cat-meals', 'cat-meals', 'cat-meals']);
    expect(findMany).toHaveBeenCalledOnce();
    expect(findMany.mock.calls[0][0].where.id.in).toEqual(['cat-meals']);
  });

  it('does not query at all for an empty or blank set', async () => {
    const { db, findMany } = stubDb([]);
    expect(await glAccountIdsForCategories(db, [])).toEqual(new Map());
    expect(await glAccountIdsForCategories(db, ['', ''])).toEqual(new Map());
    expect(findMany).not.toHaveBeenCalled();
  });

  it('omits a category that does not exist rather than inventing an entry', async () => {
    const { db } = stubDb([{ id: 'cat-meals', glAccountId: 'acct-1' }]);
    const out = await glAccountIdsForCategories(db, ['cat-meals', 'cat-gone']);
    expect(out.has('cat-gone')).toBe(false);
  });
});

describe('glAccountIdForCategory', () => {
  it('returns the account', async () => {
    const { db } = stubDb([{ id: 'cat-meals', glAccountId: 'acct-1' }]);
    expect(await glAccountIdForCategory(db, 'cat-meals')).toBe('acct-1');
  });

  it('is null for an unmapped category, and for one that has vanished', async () => {
    // Neither is worth failing a write over: an employee filing an expense cannot
    // fix a GL mapping, and blocking their line on it would stop work they do not own.
    const { db } = stubDb([{ id: 'cat-meals', glAccountId: null }]);
    expect(await glAccountIdForCategory(db, 'cat-meals')).toBeNull();
    expect(await glAccountIdForCategory(db, 'cat-gone')).toBeNull();
  });
});
