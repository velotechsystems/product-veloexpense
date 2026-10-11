// @vitest-environment node
/* eslint-disable @typescript-eslint/no-explicit-any -- VeloExpense: ExpenseOS's suite reads its rows untyped (`db: any`); Biome allows it there. */
import { permissions as P } from '@expenseos/rbac';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createTenantHarness,
  type TenantHarness,
} from '../../../server/__test-helpers__/tenantHarness';
import {
  expensesWithTransactionId,
  MERCHANT_RECEIPT_SOURCE,
  normalizeTransactionId,
  recordTransactionId,
} from './receiptTransactionId';

/**
 * The merchant's printed transaction number, at both grains.
 *
 * The case this exists for is the LAST test: two different merchants printing the same
 * receipt number. Every other alias table in the schema is unique on
 * `(sourceId, sourceValue)`, and copying that here would have rejected the second
 * insert — so the one thing a duplicate check needs to see, it could never record.
 *
 * Gated on DATABASE_URL; the hermetic CI run skips it.
 *
 * Ported from ExpenseOS's `receiptTransactionId.db.test.ts` (550b2945). VeloExpense: the
 * suite's own tenant (`createTenantHarness`), its report and expenses made through the
 * ported procedures, and the source created on first use rather than seeded — so the
 * first case also pins that, and a deactivated source still answers no.
 */

vi.mock('@/auth', () => ({ auth: vi.fn(async () => null) }));
vi.mock('@/lib/tenant/request', () => ({ hostTenantSlug: async () => null }));

const RW = [P.expense.report.readOwn, P.expense.report.createOwn, P.expense.report.updateOwn] as const;

describe.skipIf(!process.env.DATABASE_URL)('receipt transaction ids (integration)', () => {
  let h: TenantHarness;
  let db: any;
  let reportId: string;
  let userId: string;

  async function newExpense() {
    const { id } = await h.makeCaller(RW, userId).createExpense({ reportId });
    // `createExpense` reuses a blank expense on the report; a merchant makes this one not blank.
    await db.expense.update({ where: { id }, data: { merchant: `Fixture ${id.slice(0, 8)}` } });
    return id as string;
  }

  async function newReceipt(expenseId: string) {
    const stamp = `${Date.now()}-${Math.floor(performance.now() * 1000)}`;
    const r = await db.receipt.create({
      data: {
        expenseId,
        s3Key: `receipts/txnid-fixture-${stamp}`,
        filename: 'receipt.jpg',
        contentType: 'image/jpeg',
        sizeBytes: 1024,
        uploadedById: userId,
        status: 'STORED',
      },
      select: { id: true },
    });
    return r.id;
  }

  beforeAll(async () => {
    h = await createTenantHarness({ slug: 'txn-ids', name: 'Txn Ids' });
    db = h.db;
    userId = h.people[0].id;
    reportId = (await h.makeCaller(RW, userId).create({ title: 'Txn id fixture', currency: 'CAD' })).id;
  });

  afterAll(async () => {
    await h.end();
  });

  it('VeloExpense: creates the tenant\'s source on first use, and honours switching it off', async () => {
    expect(await db.externalIdSource.count({ where: { code: MERCHANT_RECEIPT_SOURCE } })).toBe(0);
    const expenseId = await newExpense();
    await recordTransactionId(db, { expenseId, transactionId: 'FIRST-1' });
    expect(await db.externalIdSource.count({ where: { code: MERCHANT_RECEIPT_SOURCE } })).toBe(1);
    await db.externalIdSource.updateMany({ where: { code: MERCHANT_RECEIPT_SOURCE }, data: { active: false } });
    expect(await recordTransactionId(db, { expenseId, transactionId: 'OFF-1' })).toEqual({ written: 0 });
    await db.externalIdSource.updateMany({ where: { code: MERCHANT_RECEIPT_SOURCE }, data: { active: true } });
  });

  it('writes the number at both grains', async () => {
    const expenseId = await newExpense();
    const receiptId = await newReceipt(expenseId);
    const res = await recordTransactionId(db, { receiptId, expenseId, transactionId: 'AUTH-8891' });
    expect(res.written).toBe(2);
    expect(
      await db.receiptExternalId.count({ where: { receiptId, sourceValue: 'AUTH-8891' } }),
    ).toBe(1);
    expect(
      await db.expenseExternalId.count({ where: { expenseId, sourceValue: 'AUTH-8891' } }),
    ).toBe(1);
  });

  it('is idempotent, so a re-scan does not accumulate rows', async () => {
    const expenseId = await newExpense();
    const receiptId = await newReceipt(expenseId);
    await recordTransactionId(db, { receiptId, expenseId, transactionId: 'AUTH-1' });
    await recordTransactionId(db, { receiptId, expenseId, transactionId: 'AUTH-1' });
    expect(await db.receiptExternalId.count({ where: { receiptId } })).toBe(1);
    expect(await db.expenseExternalId.count({ where: { expenseId } })).toBe(1);
  });

  it('ignores a number the document never printed', async () => {
    const expenseId = await newExpense();
    for (const v of [null, undefined, '', '   ']) {
      expect(await recordTransactionId(db, { expenseId, transactionId: v })).toEqual({
        written: 0,
      });
    }
    // A blank stored value would match every other blank one — worse than none.
    expect(await db.expenseExternalId.count({ where: { expenseId } })).toBe(0);
  });

  it('finds the earlier expense carrying the same number', async () => {
    const first = await newExpense();
    const second = await newExpense();
    await recordTransactionId(db, { expenseId: first, transactionId: 'DUP-42' });
    await recordTransactionId(db, { expenseId: second, transactionId: 'DUP-42' });
    // The lookup a duplicate check runs — and it must not match itself.
    expect(await expensesWithTransactionId(db, { transactionId: 'DUP-42' })).toHaveLength(2);
    expect(
      await expensesWithTransactionId(db, { transactionId: 'DUP-42', exceptExpenseId: second }),
    ).toEqual([first]);
  });

  it('lets two different charges share a printed number', async () => {
    /**
     * The reason the unique key is `(sourceId, sourceValue, expenseId)` and not the
     * `(sourceId, sourceValue)` every other alias table uses.
     *
     * A merchant receipt number is not globally unique — two shops both print
     * "0001" — and, more to the point, a duplicate check exists to NOTICE a repeat.
     * A global unique would have raised a constraint violation on the second write,
     * so the collision could never be recorded, let alone reported.
     */
    const a = await newExpense();
    const b = await newExpense();
    await expect(recordTransactionId(db, { expenseId: a, transactionId: '0001' })).resolves.toEqual(
      { written: 1 },
    );
    await expect(recordTransactionId(db, { expenseId: b, transactionId: '0001' })).resolves.toEqual(
      { written: 1 },
    );
    expect(await db.expenseExternalId.count({ where: { sourceValue: '0001' } })).toBe(2);
  });
});

describe('normalizeTransactionId', () => {
  it('trims, and rejects empty or absurd values', () => {
    expect(normalizeTransactionId('  AUTH-9  ')).toBe('AUTH-9');
    expect(normalizeTransactionId('')).toBeNull();
    expect(normalizeTransactionId(null)).toBeNull();
    expect(normalizeTransactionId(undefined)).toBeNull();
    // Point-of-sale software prints odd things; a page of OCR noise is not an id.
    expect(normalizeTransactionId('x'.repeat(129))).toBeNull();
    expect(normalizeTransactionId('x'.repeat(128))).toHaveLength(128);
  });
});
