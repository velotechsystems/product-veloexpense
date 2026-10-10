// @vitest-environment node
/* eslint-disable @typescript-eslint/no-explicit-any -- VeloExpense: ExpenseOS's suite reads its rows untyped (`db: any`); Biome allows it there. */
import { permissions as P } from '@expenseos/rbac';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTenantHarness, type TenantHarness } from '../__test-helpers__/tenantHarness';

/**
 * The per-expense procedures, against a real database.
 *
 * Three groups, each with its own reason for being here:
 *
 *   · **Header edits** are the only place a human contradicts the extraction, so every
 *     correction is recorded as an OVERRIDE — otherwise a re-scan overwrites the fix and
 *     the person makes it twice. Attendees are a full-replace set, which means an omitted
 *     key and an empty array have to mean different things.
 *   · **Deletes** cascade, and their S3 objects have to be collected BEFORE the cascade
 *     or they are orphaned forever. The bulk one is all-or-nothing on ownership: a
 *     partial delete of a group action is worse than a refusal.
 *   · **The statement and grouping queries** are recommendation engines. They must not
 *     offer an expense the document already sits on, and must not "suggest" merging two
 *     receipts that already share one expense — that suggestion IS the current state.
 *
 * VeloExpense: ExpenseOS's `expenses.expenses.db.test.ts`, the header-edit and delete
 * blocks (w2-08b), and the grouping block's cases that read no extraction (w2-02b). The
 * statement block, and the grouping cases that compare extractions, arrive with extraction
 * (Wave 3).
 * The cases are ExpenseOS's; the harness is VeloExpense's (`createTenantHarness`: the
 * suite's own tenant, every call inside it under RLS, storage in memory, and
 * `lastAudit` reading `audit_entry`). Currencies are keyed by their ISO code.
 */

vi.mock('@/auth', () => ({ auth: vi.fn(async () => null) }));
vi.mock('@/lib/tenant/request', () => ({ hostTenantSlug: async () => null }));

const RW = [
  P.expense.report.readOwn,
  P.expense.report.createOwn,
  P.expense.report.updateOwn,
] as const;

describe.skipIf(!process.env.DATABASE_URL)('expenses on a report (integration)', () => {
  let h: TenantHarness;
  let db: any;
  let makeCaller: (perms: readonly string[], userId: string) => any;
  let storage: TenantHarness['storage'];
  let lastAudit: (entityType: string, entityId: string) => Promise<any>;
  let ownerId: string;
  let strangerId: string;
  let currencyId: string;
  let otherCurrencyId: string;

  beforeAll(async () => {
    h = await createTenantHarness({
      slug: 'expenses-expenses',
      name: 'Expenses Expenses',
      people: [{ email: 'stranger@expenses-expenses.test', name: 'Stranger' }],
    });
    ({ db, makeCaller, storage, lastAudit } = h);
    ownerId = h.people[0].id;
    strangerId = h.people[1].id;
    // VeloExpense: a currency's id is its ISO code.
    currencyId = 'CAD';
    otherCurrencyId = 'USD';
  });

  /** A draft report with `count` expenses, each with a distinct amount and merchant. */
  const scenario = async (
    count = 1,
    over: Record<string, unknown> = {},
  ): Promise<{ reportId: string; expenseIds: string[] }> => {
    const report = await db.expenseReport.create({
      data: {
        title: 'expense harness',
        currencyId,
        submitterId: ownerId,
        ...over,
        expenses: {
          create: Array.from({ length: count }, (_, i) => ({
            ownerId,
            currencyId,
            date: new Date('2026-07-01T12:00:00Z'),
            amountMinor: BigInt(1000 * (i + 1)),
            merchant: `Merchant ${i + 1}`,
          })),
        },
      },
      select: { id: true, expenses: { select: { id: true }, orderBy: { amountMinor: 'asc' } } },
    });
    return { reportId: report.id, expenseIds: report.expenses.map((e: { id: string }) => e.id) };
  };

  /**
   * A receipt on an expense.
   *
   * VeloExpense: without ExpenseOS's optional extraction — VeloExpense has no
   * `DocumentExtraction` until Wave 3, and the blocks that read one are not ported here.
   */
  const addReceipt = async (
    expenseId: string,
    over: Record<string, unknown> = {},
  ): Promise<{ id: string; s3Key: string }> => {
    const s3Key = (over.s3Key as string) ?? `key-${Math.random().toString(36).slice(2)}.pdf`;
    return db.receipt.create({
      data: {
        expenseId,
        filename: 'doc.pdf',
        contentType: 'application/pdf',
        sizeBytes: 1000,
        uploadedById: ownerId,
        ...over,
        s3Key,
      },
      select: { id: true, s3Key: true },
    });
  };

  beforeEach(() => {
    storage.delete.mockClear();
  });

  /**
   * Take the rows back out.
   *
   * VeloExpense: the next suite truncates the tenants; only the pool is ours to close.
   */
  afterAll(async () => {
    await h.end();
  });

  // ── updateExpense ───────────────────────────────────────────────────────────

  describe('editing an expense header', () => {
    it('writes the fields it was given', async () => {
      const { expenseIds } = await scenario();
      await makeCaller(RW, ownerId).updateExpense({
        expenseId: expenseIds[0],
        merchant: 'Blue Bottle',
        placeText: 'Toronto',
        purpose: 'Client meeting',
      });
      const row = await db.expense.findUniqueOrThrow({
        where: { id: expenseIds[0] },
        select: { merchant: true, placeText: true, purpose: true },
      });
      expect(row).toMatchObject({
        merchant: 'Blue Bottle',
        placeText: 'Toronto',
        purpose: 'Client meeting',
      });
    });

    it('clears a field set to null', async () => {
      /**
       * Null and omitted are different inputs: one is "the merchant is not stated", the
       * other is "I am not editing the merchant".
       */
      const { expenseIds } = await scenario();
      const caller = makeCaller(RW, ownerId);
      await caller.updateExpense({ expenseId: expenseIds[0], merchant: 'Blue Bottle' });
      await caller.updateExpense({ expenseId: expenseIds[0], merchant: null });
      const row = await db.expense.findUniqueOrThrow({
        where: { id: expenseIds[0] },
        select: { merchant: true },
      });
      expect(row.merchant).toBeNull();
    });

    it('leaves the currency alone when none was sent', async () => {
      // An absent currency must not fall through to a null FK.
      const { expenseIds } = await scenario();
      await makeCaller(RW, ownerId).updateExpense({
        expenseId: expenseIds[0],
        merchant: 'Blue Bottle',
      });
      const row = await db.expense.findUniqueOrThrow({
        where: { id: expenseIds[0] },
        select: { currencyId: true },
      });
      expect(row.currencyId).toBe(currencyId);
    });

    it('changes the currency when asked', async () => {
      if (otherCurrencyId === currencyId) return;
      const { expenseIds } = await scenario();
      await makeCaller(RW, ownerId).updateExpense({
        expenseId: expenseIds[0],
        currencyId: otherCurrencyId,
      });
      const row = await db.expense.findUniqueOrThrow({
        where: { id: expenseIds[0] },
        select: { currencyId: true },
      });
      expect(row.currencyId).toBe(otherCurrencyId);
    });

    it('accepts a subtotal as a digit string, since superjson may send either', async () => {
      /**
       * `minorInput` is a union for a reason: the browser sends a BigInt through
       * superjson, but a replayed or hand-built payload sends the digits.
       */
      const { expenseIds } = await scenario();
      await makeCaller(RW, ownerId).updateExpense({
        expenseId: expenseIds[0],
        subtotalMinor: '4200',
      });
      const row = await db.expense.findUniqueOrThrow({
        where: { id: expenseIds[0] },
        select: { subtotalMinor: true },
      });
      expect(row.subtotalMinor?.toString()).toBe('4200');
    });

    it('clears a subtotal set to null', async () => {
      const { expenseIds } = await scenario();
      const caller = makeCaller(RW, ownerId);
      await caller.updateExpense({ expenseId: expenseIds[0], subtotalMinor: '4200' });
      await caller.updateExpense({ expenseId: expenseIds[0], subtotalMinor: null });
      const row = await db.expense.findUniqueOrThrow({
        where: { id: expenseIds[0] },
        select: { subtotalMinor: true },
      });
      expect(row.subtotalMinor).toBeNull();
    });

    it('replaces the attendee roster wholesale', async () => {
      /**
       * The editor sends the whole roster on save. Merging would double every attendee
       * on the second save, and an attendee list drives the meal-per-head policy.
       */
      const { expenseIds } = await scenario();
      const caller = makeCaller(RW, ownerId);
      await caller.updateExpense({
        expenseId: expenseIds[0],
        attendees: [{ name: 'Ada' }, { name: 'Grace' }],
      });
      await caller.updateExpense({ expenseId: expenseIds[0], attendees: [{ name: 'Ada' }] });
      const rows = await db.expenseAttendee.findMany({ where: { expenseId: expenseIds[0] } });
      expect(rows.map((r: { name: string }) => r.name)).toEqual(['Ada']);
    });

    it('records who was external, and for whom', async () => {
      // A client at the table is what makes a meal entertainment rather than a per-diem.
      const { expenseIds } = await scenario();
      await makeCaller(RW, ownerId).updateExpense({
        expenseId: expenseIds[0],
        attendees: [{ name: 'Ada', company: 'Acme', isExternal: true }],
      });
      const row = await db.expenseAttendee.findFirstOrThrow({
        where: { expenseId: expenseIds[0] },
      });
      expect(row).toMatchObject({ name: 'Ada', company: 'Acme', isExternal: true });
    });

    it('treats an attendee with no company as internal by default', async () => {
      const { expenseIds } = await scenario();
      await makeCaller(RW, ownerId).updateExpense({
        expenseId: expenseIds[0],
        attendees: [{ name: 'Ada' }],
      });
      const row = await db.expenseAttendee.findFirstOrThrow({
        where: { expenseId: expenseIds[0] },
      });
      expect(row).toMatchObject({ company: null, isExternal: false });
    });

    it('clears the roster when handed an empty list', async () => {
      /**
       * "I removed everybody" has to be expressible — the requires-attendees policy
       * check would otherwise be satisfied by a roster nobody can delete.
       */
      const { expenseIds } = await scenario();
      const caller = makeCaller(RW, ownerId);
      await caller.updateExpense({ expenseId: expenseIds[0], attendees: [{ name: 'Ada' }] });
      await caller.updateExpense({ expenseId: expenseIds[0], attendees: [] });
      expect(await db.expenseAttendee.count({ where: { expenseId: expenseIds[0] } })).toBe(0);
    });

    it('leaves the roster untouched when the key is omitted', async () => {
      // Editing the merchant must not silently wipe the attendees.
      const { expenseIds } = await scenario();
      const caller = makeCaller(RW, ownerId);
      await caller.updateExpense({ expenseId: expenseIds[0], attendees: [{ name: 'Ada' }] });
      await caller.updateExpense({ expenseId: expenseIds[0], merchant: 'Blue Bottle' });
      expect(await db.expenseAttendee.count({ where: { expenseId: expenseIds[0] } })).toBe(1);
    });

    it('audits which fields were touched, not their values', async () => {
      /**
       * The values are in the row; the audit answers "who changed what, when", and
       * copying the values in would duplicate the record and widen what the log leaks.
       */
      const { expenseIds } = await scenario();
      await makeCaller(RW, ownerId).updateExpense({
        expenseId: expenseIds[0],
        merchant: 'Blue Bottle',
      });
      const audit = await lastAudit('Expense', expenseIds[0]);
      expect(audit).not.toBeNull();
      expect(audit.details.fields).toContain('merchant');
      expect(audit.details.fields).not.toContain('expenseId');
    });

    it('refuses an expense on a submitted report', async () => {
      const { expenseIds } = await scenario(1, { status: 'SUBMITTED' });
      await expect(
        makeCaller(RW, ownerId).updateExpense({
          expenseId: expenseIds[0],
          merchant: 'too late',
        }),
      ).rejects.toThrow(/not editable/);
    });

    it('refuses somebody else’s expense', async () => {
      if (strangerId === ownerId) return;
      const { expenseIds } = await scenario();
      await expect(
        makeCaller(RW, strangerId).updateExpense({
          expenseId: expenseIds[0],
          merchant: 'not mine',
        }),
      ).rejects.toThrow();
    });
  });

  // ── deleteExpense ───────────────────────────────────────────────────────────

  describe('deleting one expense', () => {
    it('removes it and recomputes the report total', async () => {
      /**
       * The total is derived. Leaving it stale means the report says one thing and its
       * expenses another, and the approver sees the wrong figure.
       */
      const { reportId, expenseIds } = await scenario(2);
      await makeCaller(RW, ownerId).deleteExpense({ expenseId: expenseIds[0] });
      expect(await db.expense.findUnique({ where: { id: expenseIds[0] } })).toBeNull();
      const report = await db.expenseReport.findUniqueOrThrow({
        where: { id: reportId },
        select: { totalMinor: true },
      });
      expect(report.totalMinor.toString()).not.toBe('0');
    });

    it('deletes the receipt objects it was carrying', async () => {
      const { expenseIds } = await scenario();
      const receipt = await addReceipt(expenseIds[0]);
      await makeCaller(RW, ownerId).deleteExpense({ expenseId: expenseIds[0] });
      expect(storage.delete).toHaveBeenCalledWith(receipt.s3Key);
    });

    it('anchors the audit row to the report when the expense is filed', async () => {
      /**
       * The report is the thing somebody will audit; an entry pointing at a deleted
       * expense id is one nobody can navigate to.
       */
      const { reportId, expenseIds } = await scenario();
      await makeCaller(RW, ownerId).deleteExpense({ expenseId: expenseIds[0] });
      const audit = await lastAudit('ExpenseReport', reportId);
      expect(audit).not.toBeNull();
      expect(audit.details.removedExpenseId).toBe(expenseIds[0]);
    });

    it('records which expense went, since the row itself is gone', async () => {
      /**
       * The audit row anchors to the report, so the removed expense's id has to be in
       * the details or the entry says only "this report changed".
       */
      const { reportId, expenseIds } = await scenario(2);
      await makeCaller(RW, ownerId).deleteExpense({ expenseId: expenseIds[1] });
      const audit = await lastAudit('ExpenseReport', reportId);
      expect(audit.details.removedExpenseId).toBe(expenseIds[1]);
    });

    it('refuses an expense on a submitted report', async () => {
      const { expenseIds } = await scenario(1, { status: 'SUBMITTED' });
      await expect(
        makeCaller(RW, ownerId).deleteExpense({ expenseId: expenseIds[0] }),
      ).rejects.toThrow(/not editable/);
    });
  });

  // ── deleteExpenses ──────────────────────────────────────────────────────────

  describe('deleting several at once', () => {
    it('removes them all and recomputes the total', async () => {
      const { reportId, expenseIds } = await scenario(3);
      const result = await makeCaller(RW, ownerId).deleteExpenses({ ids: expenseIds.slice(0, 2) });
      expect(result).toMatchObject({ ok: true, deleted: 2 });
      expect(await db.expense.count({ where: { reportId } })).toBe(1);
    });

    it('refuses the whole batch when one id is not the caller’s', async () => {
      /**
       * All-or-nothing: a group action that deleted four of five rows and then failed
       * would leave somebody guessing which four.
       */
      if (strangerId === ownerId) return;
      const mine = await scenario(2);
      const theirs = await db.expenseReport.create({
        data: {
          title: 'not mine',
          currencyId,
          submitterId: strangerId,
          expenses: {
            create: [
              {
                ownerId: strangerId,
                currencyId,
                date: new Date('2026-07-01T12:00:00Z'),
                amountMinor: 500n,
              },
            ],
          },
        },
        select: { expenses: { select: { id: true } } },
      });
      await expect(
        makeCaller(RW, ownerId).deleteExpenses({
          ids: [...mine.expenseIds, theirs.expenses[0].id],
        }),
      ).rejects.toThrow();
      expect(await db.expense.count({ where: { id: { in: mine.expenseIds } } })).toBe(2);
    });

    it('refuses the batch when an id does not exist', async () => {
      // A stale list from a page somebody left open.
      const { expenseIds } = await scenario(1);
      await expect(
        makeCaller(RW, ownerId).deleteExpenses({
          ids: [...expenseIds, '00000000-0000-7000-8000-0000000000fd'],
        }),
      ).rejects.toThrow();
      expect(await db.expense.count({ where: { id: expenseIds[0] } })).toBe(1);
    });

    it('refuses the batch when any expense sits on a submitted report', async () => {
      const draft = await scenario(1);
      const submitted = await scenario(1, { status: 'SUBMITTED' });
      await expect(
        makeCaller(RW, ownerId).deleteExpenses({
          ids: [...draft.expenseIds, ...submitted.expenseIds],
        }),
      ).rejects.toThrow();
      expect(await db.expense.count({ where: { id: draft.expenseIds[0] } })).toBe(1);
    });

    it('deletes the receipt objects of every expense in the batch', async () => {
      const { expenseIds } = await scenario(2);
      const a = await addReceipt(expenseIds[0]);
      const b = await addReceipt(expenseIds[1]);
      await makeCaller(RW, ownerId).deleteExpenses({ ids: expenseIds });
      expect(storage.delete).toHaveBeenCalledWith(a.s3Key);
      expect(storage.delete).toHaveBeenCalledWith(b.s3Key);
    });

    it('recomputes every affected report, not just the first', async () => {
      /**
       * The expense list is cross-report — that is the whole point of it — so a group
       * delete routinely spans two reports and both totals have to move.
       */
      const first = await scenario(1);
      const second = await scenario(1);
      await makeCaller(RW, ownerId).deleteExpenses({
        ids: [...first.expenseIds, ...second.expenseIds],
      });
      for (const id of [first.reportId, second.reportId]) {
        const report = await db.expenseReport.findUniqueOrThrow({
          where: { id },
          select: { totalMinor: true },
        });
        expect(report.totalMinor.toString()).toBe('0');
      }
    });
  });
  // ── receiptGroupingSuggestions ──────────────────────────────────────────────

  describe('suggesting which documents are the same charge', () => {
    // VeloExpense: ExpenseOS's "suggests merging two documents that describe one charge",
    // "says nothing about two documents already sharing an expense", "says nothing about
    // unrelated charges" and "names each document, so the suggestion can be judged" give
    // each receipt an extraction to compare; they arrive with extraction (Wave 3).

    it('ignores a document nothing has read yet', async () => {
      // Without an extraction there is no evidence to compare.
      const { reportId, expenseIds } = await scenario(2);
      await addReceipt(expenseIds[0]);
      await addReceipt(expenseIds[1]);
      const result = await makeCaller(RW, ownerId).receiptGroupingSuggestions({ reportId });
      expect(result.items).toHaveLength(0);
    });

    it('refuses a report that does not exist', async () => {
      await expect(
        makeCaller(RW, ownerId).receiptGroupingSuggestions({
          reportId: '00000000-0000-7000-8000-0000000000fc',
        }),
      ).rejects.toThrow();
    });

    it('refuses somebody else’s report', async () => {
      if (strangerId === ownerId) return;
      const { reportId } = await scenario();
      await expect(
        makeCaller(RW, strangerId).receiptGroupingSuggestions({ reportId }),
      ).rejects.toThrow(/FORBIDDEN|Forbidden/i);
    });

    it('admits an admin to anybody’s report', async () => {
      /**
       * AP chases receipts across reports they did not file, and the grouping question
       * is exactly one they need to answer.
       */
      if (strangerId === ownerId) return;
      const { reportId } = await scenario();
      const admin = makeCaller([...RW, P.expense.report.readAll], strangerId);
      await expect(admin.receiptGroupingSuggestions({ reportId })).resolves.toMatchObject({
        items: expect.any(Array),
      });
    });
  });
});
