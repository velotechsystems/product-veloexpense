/**
 * Creating the expenses a batch of receipts will hang off — one implementation, three callers.
 *
 * `expenses.startFromReceipts` (browser upload), `expenses.addReceiptExpenses` (adding to a
 * report that exists) and the inbound-email worker all need the same thing: N blank expenses
 * in a known order, so file[i] can be attached to expense[i]. The worker cannot reach a tRPC
 * procedure, so without this there would be two copies of the rule — and two copies of
 * "placeholder date, zero amount, report currency" is how a report filed by email starts
 * differing from one filed in the browser.
 *
 * **No audit here.** Every function takes a transaction client and the CALLER wraps it in
 * `withAudit`, because `@expenseos/audit` depends on this package and importing it back would
 * be circular. That split is deliberate rather than incidental: the audit row belongs to the
 * action ("filed by email", "filed from the reports list"), which is something only the caller
 * knows.
 *
 * VeloExpense: ExpenseOS's module (Wave 2, w2-09) for its two browser callers; VeloExpense has
 * no inbound-email worker. Adaptations, each marked `VeloExpense:` —
 *   · a currency is keyed by its ISO code, and a person's home currency is their legal
 *     entity's (`resolveIntakeCurrencyId`);
 *   · a report's number is minted by the caller from the tenant's sequence and passed in
 *     (`createReportFromReceipts`), where ExpenseOS's column default draws it.
 */

import type { Prisma, PrismaClient } from '@/lib/generated/prisma/client';
import type { BusinessUnitSource } from './businessUnitSource';
import { allocationCreateFor, type CodingDefaults } from './expenseCodingDefaults';
import { homeCurrencyCode } from './homeCurrency';

type Db = PrismaClient | Prisma.TransactionClient;

/** A UUID, matching the shape every id in the product has. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The currency for a receipt batch: an explicit choice, else the submitter's home currency,
 * else USD. (VeloExpense: else the tenant's main entity's, else CAD — `homeCurrencyCode`.)
 *
 * Accepts a UUID or an ISO-4217 code because its callers differ — a tRPC input carries
 * whichever the client had, and an email carries nothing at all. Returns the id, so no caller
 * has to know that `Expense.currencyId` is a foreign key.
 *
 * VeloExpense: a currency's key is its code, so the "id" returned is the code, and a UUID
 * names no currency (refused as unknown, as ExpenseOS refuses one that does not exist). A
 * person carries no currency of their own: the home currency is their legal entity's, as
 * `readerCurrencyCode` reads it.
 */
export async function resolveIntakeCurrencyId(
  db: Db,
  input: { userId: string; requested?: string | null },
): Promise<string | null> {
  const requested = input.requested?.trim();
  if (requested && UUID.test(requested)) {
    return null;
  }
  if (requested) {
    const byCode = await db.currency.findUnique({
      where: { code: requested.toUpperCase() },
      select: { code: true },
    });
    return byCode?.code ?? null;
  }
  // VeloExpense (f29): the person's home currency by the same rule the reader's totals use
  // (`homeCurrencyCode`: their entity, else the tenant's main entity, else CAD), where
  // ExpenseOS fell back to USD here and to CAD there. Still checked against the currency
  // table, as ExpenseOS's USD lookup was.
  const home = await homeCurrencyCode(db, input.userId);
  const known = await db.currency.findUnique({ where: { code: home }, select: { code: true } });
  return known?.code ?? null;
}

export interface BlankExpenseInput {
  reportId: string;
  ownerId: string;
  currencyId: string;
  /**
   * The owner's own coding, copied onto every expense created here. Passed in rather than
   * looked up so this stays a pure write against the transaction it is given, and so the
   * caller pays for the one `User` read instead of one per receipt.
   */
  coding?: CodingDefaults | null;
  /** The business unit source `coding` was resolved for (`codingDefaultsFor`). Required, so
   *  a caller cannot forget it and quietly default as `EXPENSEOS`. */
  businessUnitSource: BusinessUnitSource;
  /** How many to create. One per file, never deduplicated — see below. */
  count: number;
  /**
   * Business reason recorded on every expense created here.
   *
   * Set by the email path from the message body; the browser paths leave it unset and the
   * person types it in the workbench.
   */
  purpose?: string | null;
  /**
   * "Explain this charge" text recorded on every expense created here.
   *
   * Set by the email path to the same message body as `purpose`: the note somebody typed
   * when they emailed the receipts is the explanation they would otherwise retype on each
   * expense, and `purpose` alone is not shown in the workbench. The browser paths leave it
   * unset.
   */
  explanation?: string | null;
  /** Placeholder date, injected so a test can pin it. Extraction overwrites it. */
  now?: Date;
}

/**
 * Create exactly `count` blank expenses on a report, oldest-id first.
 *
 * **Exactly `count`, never fewer.** `expenses.createExpense` deliberately reuses an existing
 * empty expense rather than piling up blanks, so calling it N times returns the SAME id until
 * a receipt is attached — and N receipts would land on one expense, where `determineExpense`
 * reads a multi-document expense as ONE charge with tips. Three dinners would become one
 * dinner with two tips. Anything filing a batch at once has to create the rows itself.
 */
export async function createBlankExpensesForReceipts(
  tx: Prisma.TransactionClient,
  input: BlankExpenseInput,
): Promise<string[]> {
  const date = input.now ?? new Date();
  const purpose = input.purpose?.trim() || null;
  const explanation = input.explanation?.trim() || null;
  // One create per row rather than createMany: createMany returns no ids, and the order of
  // the ids IS the contract with the caller (file[i] → expense[i]).
  const created = await Promise.all(
    Array.from({ length: input.count }, () =>
      tx.expense.create({
        data: {
          reportId: input.reportId,
          ownerId: input.ownerId,
          currencyId: input.currencyId,
          // Placeholders extraction overwrites; the person can correct either.
          date,
          amountMinor: 0n,
          ...(purpose ? { purpose } : {}),
          ...(explanation ? { explanation } : {}),
          // The filer's own department / BU / class, in the same statement as the expense.
          ...allocationCreateFor(input.coding ?? null, input.businessUnitSource),
        },
        select: { id: true },
      }),
    ),
  );
  return created.map((e) => e.id);
}

export interface ReportFromReceiptsInput {
  submitterId: string;
  /** VeloExpense: the report's number, minted by the caller from the tenant's own sequence
   *  (`mintReportNumber`) — ExpenseOS's column default draws it from a global one. */
  number: string;
  /** Localized by the caller — "Untitled report" from the browser, the subject line from an
   *  email. Never defaulted here, or a French user gets an English title. */
  title: string;
  currencyId: string;
  count: number;
  purpose?: string | null;
  /** See `BlankExpenseInput.explanation`. */
  explanation?: string | null;
  /** The submitter's own coding, copied onto every expense. See `expenseCodingDefaults`. */
  coding?: CodingDefaults | null;
  /** The business unit source `coding` was resolved for (`codingDefaultsFor`). */
  businessUnitSource: BusinessUnitSource;
  now?: Date;
}

/**
 * Create a DRAFT report holding one blank expense per receipt.
 *
 * The report is created even if every upload afterwards fails: a draft with empty expenses is
 * visible and fixable, where a silent no-op leaves somebody wondering where their receipts
 * went. That contract is the same whether the files came from a browser or an inbox.
 */
export async function createReportFromReceipts(
  tx: Prisma.TransactionClient,
  input: ReportFromReceiptsInput,
): Promise<{ id: string; number: string; expenseIds: string[] }> {
  const date = input.now ?? new Date();
  const purpose = input.purpose?.trim() || null;
  const explanation = input.explanation?.trim() || null;
  const report = await tx.expenseReport.create({
    data: {
      number: input.number,
      title: input.title,
      currencyId: input.currencyId,
      submitterId: input.submitterId,
      expenses: {
        create: Array.from({ length: input.count }, () => ({
          ownerId: input.submitterId,
          date,
          amountMinor: 0n,
          currencyId: input.currencyId,
          ...(purpose ? { purpose } : {}),
          ...(explanation ? { explanation } : {}),
          ...allocationCreateFor(input.coding ?? null, input.businessUnitSource),
        })),
      },
    },
    select: {
      id: true,
      number: true,
      // VeloExpense: ids are random (gen_random_uuid), not time-ordered like ExpenseOS's
      // uuidv7, so this order is not creation order. Every expense here is the same blank, so
      // any order pairs file[i] with an expense of its own — which is the contract.
      expenses: { select: { id: true }, orderBy: { id: 'asc' } },
    },
  });
  return {
    id: report.id,
    // VeloExpense: the column is nullable for reports from before numbering; this one was
    // just given `input.number`.
    number: report.number ?? input.number,
    expenseIds: report.expenses.map((e) => e.id),
  };
}
