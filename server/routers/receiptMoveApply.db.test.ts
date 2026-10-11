// @vitest-environment node
/* eslint-disable @typescript-eslint/no-explicit-any -- VeloExpense: ExpenseOS's suite reads its rows untyped (`db: any`); Biome allows it there. */
import { permissions as P } from '@expenseos/rbac';
import { afterAll, beforeAll, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';
import { createTenantHarness, type TenantHarness } from '../__test-helpers__/tenantHarness';

/**
 * Router-level coverage for `receiptMove` and `statementApply`.
 *
 * Both were covered only on their pure parts, and neither had a test against a
 * database — which is where all of their interesting behaviour lives. Between them
 * they delete rows, copy S3 objects, recompute two sets of totals and refuse two
 * different cross-report moves, and none of that is visible from a unit test.
 *
 * S3 is stubbed; everything else is real.
 *
 * Gated on DATABASE_URL; the hermetic CI run skips it.
 *
 * VeloExpense: ExpenseOS's `receiptMoveApply.db.test.ts` (550b2945), with `statementApply`
 * (w3-04). The cases are ExpenseOS's; the harness is VeloExpense's (`createTenantHarness`:
 * the suite's own tenant and people, every call under RLS, storage in memory). Adaptations,
 * each marked:
 *   · the copy is VeloExpense's storage seam (`getStorage().copy`), spied on the harness's
 *     memory driver rather than a mocked `@expenseos/storage`, so each source object is put
 *     there first — a copy of nothing fails, as it does on S3;
 *   · a currency's key is its code, and the audit row is `audit_entry`, read through the
 *     harness's `lastAudit`.
 */

vi.mock('@/auth', () => ({ auth: vi.fn(async () => null) }));
vi.mock('@/lib/tenant/request', () => ({ hostTenantSlug: async () => null }));
vi.mock('@expenseos/jobs', async () => {
  const actual = await vi.importActual<typeof import('@expenseos/jobs')>('@expenseos/jobs');
  return { ...actual, enqueue: vi.fn(async () => undefined) };
});

const OWNER = [P.expense.report.updateOwn, P.expense.report.readOwn] as const;

describe.skipIf(!process.env.DATABASE_URL)('receiptMove / statementApply (integration)', () => {
  let h: TenantHarness;
  let db: any;
  let caller: any;
  let userId: string;
  let currencyId: string;
  let copy: MockInstance<(fromKey: string, toKey: string) => Promise<void>>;
  const reportIds: string[] = [];

  /** A report with `count` expenses, each holding one receipt. */
  async function scenario(count: number) {
    const stamp = `${Date.now()}-${reportIds.length}`;
    const report = await db.expenseReport.create({
      data: { title: `move-fixture-${stamp}`, currencyId, submitterId: userId },
      select: { id: true },
    });
    reportIds.push(report.id);
    const expenses: { id: string; receiptId: string }[] = [];
    for (let i = 0; i < count; i++) {
      const e = await db.expense.create({
        data: {
          reportId: report.id,
          ownerId: userId,
          currencyId,
          date: new Date('2026-07-01T00:00:00.000Z'),
          amountMinor: BigInt(1000 * (i + 1)),
        },
        select: { id: true },
      });
      const s3Key = `receipts/move-${stamp}-${i}`;
      // VeloExpense: the object exists, so the copy has something to copy.
      h.storage.memory.put(s3Key, new Uint8Array([1, 2, 3]), 'image/jpeg');
      const r = await db.receipt.create({
        data: {
          expenseId: e.id,
          s3Key,
          filename: `doc-${i}.jpg`,
          contentType: 'image/jpeg',
          sizeBytes: 100,
          uploadedById: userId,
        },
        select: { id: true },
      });
      expenses.push({ id: e.id, receiptId: r.id });
    }
    return { reportId: report.id, expenses };
  }

  beforeAll(async () => {
    h = await createTenantHarness({ slug: 'receipt-move-apply', name: 'Receipt Move Apply' });
    db = h.db;
    userId = h.people[0].id;
    // VeloExpense: a currency's key is its ISO code.
    currencyId = 'CAD';
    caller = h.makeCaller(OWNER, userId);
    copy = vi.spyOn(h.storage.memory, 'copy');
  });

  // VeloExpense: a block body. ExpenseOS's `beforeEach(() => h.copy.mockClear())` returns
  // the mock, which vitest takes for a teardown and calls; harmless on a bare `vi.fn`, but
  // this spy wraps the real driver's method and fails without its `this`.
  beforeEach(() => {
    copy.mockClear();
  });

  afterAll(async () => {
    // VeloExpense: the next suite truncates the tenants; only the pool is ours to close.
    await h?.end();
  });

  describe('receiptMove', () => {
    it('deletes the expense the last receipt left behind', async () => {
      /**
       * The behaviour nobody would guess from the signature. An expense whose only
       * evidence just moved is not a $0 expense — it is nothing, and leaving it would
       * put an empty row on the report and in its total.
       */
      const { expenses } = await scenario(2);
      const [a, b] = expenses;
      await expect(caller.receiptMove({ id: a.receiptId, toExpenseId: b.id })).resolves.toEqual({
        ok: true,
        removed: true,
      });
      expect(await db.expense.findUnique({ where: { id: a.id } })).toBeNull();
      expect(await db.receipt.findUniqueOrThrow({ where: { id: a.receiptId } })).toMatchObject({
        expenseId: b.id,
      });
    });

    it('keeps a source expense that still holds another document', async () => {
      const { expenses, reportId } = await scenario(2);
      const [a, b] = expenses;
      // A second document on `a`, so moving the first leaves evidence behind.
      await db.receipt.create({
        data: {
          expenseId: a.id,
          s3Key: `receipts/second-${Date.now()}`,
          filename: 'second.jpg',
          contentType: 'image/jpeg',
          sizeBytes: 100,
          uploadedById: userId,
        },
      });
      await expect(caller.receiptMove({ id: a.receiptId, toExpenseId: b.id })).resolves.toEqual({
        ok: true,
        removed: false,
      });
      expect(await db.expense.findUnique({ where: { id: a.id } })).not.toBeNull();
      expect(reportId).toBeTruthy();
    });

    it('is a no-op when the receipt is already there', async () => {
      const { expenses } = await scenario(1);
      const [a] = expenses;
      await expect(caller.receiptMove({ id: a.receiptId, toExpenseId: a.id })).resolves.toEqual({
        ok: true,
        removed: false,
      });
      // Crucially the expense is NOT deleted by its own no-op move.
      expect(await db.expense.findUnique({ where: { id: a.id } })).not.toBeNull();
    });

    it('refuses to move a receipt to another report', async () => {
      // It would move money between two totals and, if one is submitted, past an
      // approver.
      const first = await scenario(1);
      const second = await scenario(1);
      await expect(
        caller.receiptMove({
          id: first.expenses[0].receiptId,
          toExpenseId: second.expenses[0].id,
        }),
      ).rejects.toThrow(/same report/i);
    });

    it('records where the document came from', async () => {
      const { expenses } = await scenario(2);
      const [a, b] = expenses;
      await caller.receiptMove({ id: a.receiptId, toExpenseId: b.id });
      // VeloExpense: `audit_entry`, the newest row for the receiving expense.
      const audit = await h.lastAudit('Expense', b.id);
      // The source expense is deleted, so the audit row is the only remaining answer
      // to "where did this receipt come from".
      expect(audit?.details).toMatchObject({ from: a.id });
    });
  });

  describe('statementApply', () => {
    it('copies the statement to every other expense on the report', async () => {
      const { expenses } = await scenario(3);
      const [src, t1, t2] = expenses;
      await caller.statementApply({
        receiptId: src.receiptId,
        expenseIds: [src.id, t1.id, t2.id],
      });
      // The source is skipped — it already holds the document.
      expect(copy).toHaveBeenCalledTimes(2);
      for (const t of [t1, t2]) {
        const rows = await db.receipt.findMany({ where: { expenseId: t.id } });
        // `#<expenseId>` keeps the copies under one recognisable base key, which is
        // how "already has this statement" is answered without another table.
        expect(rows.some((r: { s3Key: string }) => r.s3Key.endsWith(`#${t.id}`))).toBe(true);
      }
    });

    it('is idempotent, so re-applying does not stack pages', async () => {
      const { expenses } = await scenario(2);
      const [src, t1] = expenses;
      await caller.statementApply({ receiptId: src.receiptId, expenseIds: [t1.id] });
      copy.mockClear();
      await caller.statementApply({ receiptId: src.receiptId, expenseIds: [t1.id] });
      // Second run recognises the base key and does nothing at all.
      expect(copy).not.toHaveBeenCalled();
      expect(await db.receipt.count({ where: { expenseId: t1.id } })).toBe(2);
    });

    it('refuses the whole call when any target is on another report', async () => {
      // Silently skipping the stranger would apply the statement to fewer expenses
      // than were ticked and say nothing.
      const first = await scenario(2);
      const second = await scenario(1);
      await expect(
        caller.statementApply({
          receiptId: first.expenses[0].receiptId,
          expenseIds: [first.expenses[1].id, second.expenses[0].id],
        }),
      ).rejects.toThrow(/same report/i);
      expect(copy).not.toHaveBeenCalled();
    });

    it('VeloExpense: the copy is a stored document, with the reading carried across', async () => {
      // A row whose object is not confirmed in storage is not a document here (d29), and
      // the reading is the same page's, so it is copied rather than paid for again.
      const { expenses } = await scenario(2);
      const [src, t1] = expenses;
      await db.documentExtraction.create({
        data: {
          receiptId: src.receiptId,
          scanStatus: 'CLEAN',
          status: 'EXTRACTED',
          model: 'test',
          confidence: 0.9,
          data: { lineItems: [{ description: 'TAXI', amount: 20 }] },
        },
      });
      await expect(
        caller.statementApply({ receiptId: src.receiptId, expenseIds: [t1.id] }),
      ).resolves.toEqual({ applied: 1 });
      const copyRow = await db.receipt.findFirstOrThrow({
        where: { expenseId: t1.id, s3Key: { endsWith: `#${t1.id}` } },
        select: { status: true, extraction: { select: { scanStatus: true, status: true, data: true } } },
      });
      expect(copyRow).toMatchObject({
        status: 'STORED',
        extraction: {
          scanStatus: 'CLEAN',
          status: 'EXTRACTED',
          data: { lineItems: [{ description: 'TAXI', amount: 20 }] },
        },
      });
      // And the object itself exists under the copy's key.
      const srcKey = (await db.receipt.findUniqueOrThrow({ where: { id: src.receiptId } })).s3Key;
      expect(h.storage.memory.has(`${srcKey}#${t1.id}`)).toBe(true);
    });
  });
});
