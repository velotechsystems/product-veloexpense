/**
 * Recording the transaction/auth number a merchant printed on a receipt.
 *
 * The number is already extracted — `ReceiptExtraction.transactionId`, described in
 * `@expenseos/receipt-extraction` as "the strongest evidence that two documents are
 * NOT the same charge" — and until now it was read once for grouping and thrown away.
 * Persisting it is what lets a later duplicate check ask "have we seen this number?"
 * instead of guessing from vendor, date and total, which is exactly how two coffees
 * from the same kiosk on the same day look like one charge entered twice.
 *
 * Written at BOTH grains, because they answer different questions. The RECEIPT is
 * where the number is physically printed, and an expense takes several documents — a
 * restaurant bill, the cardholder copy, a card statement — each of which may print its
 * own. The EXPENSE carries the one the determination settled on, which is what a
 * duplicate check compares.
 *
 * Ported from ExpenseOS's `packages/db/src/receiptTransactionId.ts` (550b2945) with Wave 3
 * (w3-02a). VeloExpense: the source is found or created per tenant (below); the tables are
 * 0057's.
 */

import type { Prisma, PrismaClient } from '@/lib/generated/prisma/client';

type Db = PrismaClient | Prisma.TransactionClient;

/** The `ExternalIdSource.code` these rows hang off. VeloExpense: the tenant's, created on
 *  first use (`merchantReceiptSourceId`). */
export const MERCHANT_RECEIPT_SOURCE = 'merchant-receipt';

/**
 * Receipt numbers are printed by hand-built point-of-sale software and read by a
 * model, so they arrive with stray whitespace and occasional emptiness. A blank or
 * absurd value is worse than none: it would match every other blank one.
 */
const MAX_LEN = 128;

export function normalizeTransactionId(raw: string | null | undefined): string | null {
  const v = raw?.trim();
  if (!v || v.length > MAX_LEN) return null;
  return v;
}

/**
 * Resolve the merchant-receipt source id, or null when it has been switched off.
 *
 * Null rather than a throw: a workspace seeded before this shipped should keep filing
 * expenses, just without the dedup key. Losing an optional correlation is not a reason
 * to fail somebody's receipt upload.
 *
 * VeloExpense: a source is the tenant's own (`@@unique([organizationId, code])`), so there
 * is no global row to seed. The tenant's is found by code within the RLS scope and created
 * there on first use — the same find-or-create `syncEntityAliases` (server/routers/
 * adminLookup.ts) does for the alias sources. An admin who deactivates it still gets null.
 */
export async function merchantReceiptSourceId(db: Db): Promise<string | null> {
  const row =
    (await db.externalIdSource.findFirst({
      where: { code: MERCHANT_RECEIPT_SOURCE },
      select: { id: true, active: true },
    })) ??
    (await db.externalIdSource.create({
      data: {
        code: MERCHANT_RECEIPT_SOURCE,
        label: { en: 'Merchant receipt', 'fr-CA': 'Reçu du marchand' },
      },
      select: { id: true, active: true },
    }));
  return row.active ? row.id : null;
}

export interface RecordTransactionIdInput {
  /** The document the number was printed on. */
  receiptId?: string | null;
  /** The expense the determination settled it onto. */
  expenseId?: string | null;
  transactionId: string | null | undefined;
}

/**
 * Upsert the number onto whichever grains were given. A no-op when the value is empty
 * or the source is not seeded.
 *
 * Upsert rather than create: re-scanning a receipt must not accumulate duplicate rows,
 * which is the whole reason the unique key includes the owning id.
 */
export async function recordTransactionId(
  db: Db,
  input: RecordTransactionIdInput,
): Promise<{ written: number }> {
  const sourceValue = normalizeTransactionId(input.transactionId);
  if (!sourceValue) return { written: 0 };
  const sourceId = await merchantReceiptSourceId(db);
  if (!sourceId) return { written: 0 };

  let written = 0;
  if (input.receiptId) {
    await db.receiptExternalId.upsert({
      where: {
        sourceId_sourceValue_receiptId: { sourceId, sourceValue, receiptId: input.receiptId },
      },
      update: {},
      create: { sourceId, sourceValue, receiptId: input.receiptId },
    });
    written += 1;
  }
  if (input.expenseId) {
    await db.expenseExternalId.upsert({
      where: {
        sourceId_sourceValue_expenseId: { sourceId, sourceValue, expenseId: input.expenseId },
      },
      update: {},
      create: { sourceId, sourceValue, expenseId: input.expenseId },
    });
    written += 1;
  }
  return { written };
}

/**
 * Expenses already carrying one of these numbers — the lookup a duplicate check runs.
 *
 * Exposed now, with nothing calling it, because it is the reason the columns exist and
 * the shape of the read is what justified indexing `[sourceId, sourceValue]`. Excludes
 * `exceptExpenseId` so the expense being checked does not match itself.
 */
export async function expensesWithTransactionId(
  db: Db,
  input: { transactionId: string | null | undefined; exceptExpenseId?: string | null },
): Promise<string[]> {
  const sourceValue = normalizeTransactionId(input.transactionId);
  if (!sourceValue) return [];
  const sourceId = await merchantReceiptSourceId(db);
  if (!sourceId) return [];
  const rows = await db.expenseExternalId.findMany({
    where: {
      sourceId,
      sourceValue,
      ...(input.exceptExpenseId ? { expenseId: { not: input.exceptExpenseId } } : {}),
    },
    select: { expenseId: true },
  });
  return rows.map((r) => r.expenseId);
}
