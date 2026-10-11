import { auditActions, withAudit } from '@expenseos/audit';
import {
  EXPENSE_FX_SELECT,
  ExpenseTaxSource,
  fxColumns,
  fxParamsFrom,
  glAccountIdsForCategories,
  type Prisma,
  recomputeReportTotal,
  recordTransactionId,
  resolveExpenseFx,
} from '@expenseos/db';
import { tipPayload } from '@expenseos/expense-lines';
import { getCurrency, isKnownCurrency } from '@expenseos/money';
import { type ReceiptExtraction, reconcileLineItems } from '@expenseos/receipt-extraction';
import { allocateRecoverable } from '@expenseos/tax';
import { db } from '@/lib/db/prisma';
import { isReportEditable, lockReportStatus } from './report-editable';

/*
 * Ported from ExpenseOS's `apps/worker/src/handlers/lib/prefill.ts` (550b2945), Wave 3
 * (w3-02a). VeloExpense, plumbing only: `db` is the tenant-scoped client (lib/db/prisma.ts);
 * a currency's key is its ISO code (`currency.code`, which `expense.currencyId` holds), and
 * a legal entity's home currency is that code (`homeCurrencyId`, 0048); the review
 * threshold is the constant `expenses.report` uses, as VeloExpense has no Platform Settings.
 */

/** Active expense category with the fields prefill + hinting need. */
export type CategoryRow = {
  id: string;
  label: Prisma.JsonValue;
  itcGstHstRate: number;
  itcQstRate: number;
  pstRecoverable: boolean;
  /** Whether a line here may carry a tip — decides where an extracted tip lands. */
  acceptsTip?: boolean;
  /** A mileage line keeps its own kind whatever else is true of it. */
  isMileage?: boolean;
};

export function labelEn(label: Prisma.JsonValue): string {
  if (label && typeof label === 'object' && !Array.isArray(label)) {
    const en = (label as Record<string, unknown>).en;
    if (typeof en === 'string') return en;
  }
  return 'category';
}

function nonZero(v: bigint): bigint | null {
  return v === 0n ? null : v;
}

/** The confidence threshold (Platform Settings; default 0.7) below which the
 *  extraction's per-line categories aren't trusted — the prefill then codes every
 *  line to the main receipt category. Same knob that drives the review nudge. */
export async function loadReviewThreshold(): Promise<number> {
  // VeloExpense: ExpenseOS reads `platformConfig.extractionReviewThreshold` (default 0.7).
  // VeloExpense has no Platform Settings row; the default is the value, the same constant
  // `expenses.report` gives the workbench's review nudge.
  return 0.7;
}

/** Split `totalMinor` across `weights` proportionally, largest-remainder, so the
 *  parts sum EXACTLY to `totalMinor` (no rounding drift). */
// VeloExpense: exported so the joint pass can reconcile its lines to the charged total
// with the same largest-remainder split (determine.ts, f24).
export function allocate(totalMinor: bigint, weights: number[]): bigint[] {
  const sumW = weights.reduce((a, b) => a + b, 0);
  if (totalMinor === 0n || sumW <= 0) return weights.map(() => 0n);
  const total = Number(totalMinor);
  const raw = weights.map((w) => (total * w) / sumW);
  const out = raw.map((r) => BigInt(Math.floor(r)));
  let remainder = Number(totalMinor - out.reduce((a, b) => a + b, 0n));
  const byFrac = raw
    .map((r, i) => ({ i, frac: r - Math.floor(r) }))
    .sort((a, b) => b.frac - a.frac);
  for (let k = 0; remainder > 0 && k < byFrac.length; k++, remainder--) out[byFrac[k].i] += 1n;
  return out;
}

/**
 * Recoverable ITC for the whole expense, via the shared allocator.
 *
 * This used to be a second implementation of the same tax rule — Number weights
 * where the tRPC path used BigInt, and no legal-entity gate at all. A US-entity
 * expense therefore showed a credit here that vanished the next time any line
 * edit ran the other path. One allocator now, one answer.
 */
function deriveRecoverable(
  lines: { categoryId: string; amountMinor: bigint }[],
  tax: { gstHstMinor: bigint; qstMinor: bigint },
  byId: Map<string, CategoryRow>,
  entityRecovers: boolean,
): { gstHst: bigint; qst: bigint } {
  if (lines.length === 0) return { gstHst: 0n, qst: 0n };
  const { recoverableGstHstMinor, recoverableQstMinor } = allocateRecoverable({
    gstHstMinor: tax.gstHstMinor,
    qstMinor: tax.qstMinor,
    entityRecovers,
    lines: lines.map((l) => ({
      amountMinor: l.amountMinor,
      itcGstHstRate: byId.get(l.categoryId)?.itcGstHstRate ?? 100,
      itcQstRate: byId.get(l.categoryId)?.itcQstRate ?? 100,
    })),
  });
  return { gstHst: recoverableGstHstMinor, qst: recoverableQstMinor };
}

/**
 * Apply a receipt's extraction to its Expense — shared by the sync
 * (single-receipt) and batch (bulk) handlers.
 *
 * REPLACE-ALL, and today that's safe only because an expense has exactly one
 * receipt: every pass deletes the whole line set and rebuilds it.
 *
 * NOTE: this comment used to describe an additive, per-receipt design keyed on a
 * `sourceReceiptId` column. No such column exists and none of that was built —
 * it described an intention. The multi-document design that replaces it is a
 * single JOINT pass over all of an expense's documents whose result is exactly
 * this wipe-and-rebuild, with human edits captured separately and replayed.
 *
 * Header fields (merchant/date/…) are still only filled while the merchant is
 * blank — a manually-entered header wins. The stored expense + report totals are
 * recomputed from the resulting line set.
 *
 * Itemization: when the receipt breaks into ≥2 priced lines and we have a usable
 * receipt-level category (the guaranteed fallback), each line is coded to its own
 * category (when the model is confident) or the main receipt category, then
 * same-category lines are collapsed into one; the total + tax are allocated
 * across the resulting lines by amount share. Per-line categories are only
 * trusted when the overall extraction confidence clears `reviewThreshold`.
 */
export async function prefillExpense(
  expenseId: string,
  categories: CategoryRow[],
  ex: ReceiptExtraction,
  reviewThreshold: number,
  /** The document this extraction came from, so its printed transaction number can be
   *  recorded at the receipt grain as well as the expense grain. */
  receiptId?: string | null,
): Promise<void> {
  const expense = await db.expense.findUnique({
    where: { id: expenseId },
    select: {
      id: true,
      reportId: true,
      merchant: true,
      ...EXPENSE_FX_SELECT,
      currency: { select: { code: true } },
      // The credit belongs to the entity that incurred the cost, so the ITC gate
      // rides along with the expense rather than costing a second read. The same
      // relation carries the home currency the conversion targets (rule 3).
      // VeloExpense: the home currency is the entity's `homeCurrencyId` (an ISO code), the
      // field `EXPENSE_FX_SELECT` reads, kept here because this `owner` replaces that one.
      owner: {
        select: {
          entity: { select: { itcRecoverable: true, homeCurrencyId: true } },
        },
      },
      report: { select: { status: true } },
    },
  });
  if (!expense) return;

  /**
   * A filed report's numbers must not move under its approver — the same rule the
   * joint pass (`determine.ts`) has always applied, and which this single-document
   * path lacked. Documents can still be attached to a SUBMITTED report as evidence;
   * they simply no longer redetermine anything. Checked once here, cheaply, so an
   * unreadable-but-late result costs no writes at all; and checked AGAIN under a row
   * lock around the money writes below, because a submit can land between the two.
   */
  if (!isReportEditable(expense.report.status)) {
    await recordExtractionSkipped(expense.id, expense.reportId, expense.report.status, receiptId);
    return;
  }

  // Adopt the currency the receipt is actually in — only on a fresh, untouched
  // expense (merchant still blank, same guard as the header below), so a manual
  // currency choice is never stomped by a re-scan. The receipt's amounts are in
  // this currency, so it also sets the exponent the amounts parse with (e.g.
  // JPY has 0 decimals, CAD 2). Requires the code to be a known ISO currency
  // AND present in our Currency table (for a valid FK).
  const fresh = !expense.merchant;
  let currencyCode = expense.currency.code;
  let adoptCurrencyId: string | null = null;
  if (fresh && ex.currencyCode) {
    const code = ex.currencyCode.trim().toUpperCase();
    if (code !== expense.currency.code && isKnownCurrency(code)) {
      // VeloExpense: a currency's key IS its code (`expense.currencyId` holds the code).
      const row = await db.currency.findUnique({ where: { code }, select: { code: true } });
      if (row) {
        currencyCode = code;
        adoptCurrencyId = row.code;
      }
    }
  }

  const exp = getCurrency(currencyCode).exponent;
  const toMinor = (d: number | null): bigint | null =>
    d == null ? null : BigInt(Math.round(d * 10 ** exp));

  const totalMinor = toMinor(ex.total);

  // Header fields — only while the merchant is still blank (a manual header wins).
  if (fresh) {
    await db.expense.update({
      where: { id: expense.id },
      data: {
        merchant: ex.vendor ?? undefined,
        // `placeText`, not `location`. The column was renamed precisely because
        // "location" also names the NetSuite dimension (`ExpenseAllocation.locationId`)
        // — and this call site was missed. It survived typecheck because the
        // conditional spreads below widen the literal enough to defeat
        // excess-property checking, and it survived testing because Prisma DROPS an
        // unknown key whose value is `undefined`: the bug only fires when the receipt
        // actually carries an address, which is most real receipts.
        placeText: ex.address ?? undefined,
        ...(ex.date ? { date: new Date(ex.date) } : {}),
        ...(adoptCurrencyId ? { currencyId: adoptCurrencyId } : {}),
        subtotalMinor: toMinor(ex.subtotal),
      },
    });
  }

  const byId = new Map(categories.map((c) => [c.id, c]));
  const mainCatId =
    ex.derivedCategoryCode && byId.has(ex.derivedCategoryCode) ? ex.derivedCategoryCode : null;

  const explicit = {
    gstHstMinor: toMinor(ex.taxGstHst) ?? 0n,
    qstMinor: toMinor(ex.taxQst) ?? 0n,
    pstMinor: toMinor(ex.taxPst) ?? 0n,
  };

  // Build the category + amount line set (no tax on lines anymore). With a
  // usable receipt-level category: one line, or — for ≥2 priced lines — code
  // each to its own category (when confident) or the main one, collapse same-
  // category lines, and allocate the gross across groups by amount share.
  const lineData: { categoryId: string; amountMinor: bigint }[] = [];
  /** The replacement line set, built here and written under the lock below. */
  let lineRows: Prisma.ExpenseLineItemCreateManyInput[] | null = null;
  if (mainCatId) {
    /**
     * Two independent gates on per-line categories, and BOTH must pass.
     *
     * Confidence asks "did the model read this document well?". Reconciliation asks
     * "are these rows even purchases?" — a US folio lists Occupancy / City / State tax
     * as rows beside the room charge, and a model that reads them perfectly (0.95 here)
     * still must not have its per-line categories trusted, because one of those rows is
     * a tax. Confidence alone let that through, and the sample folio only came out
     * right because the model happened to tag all five rows as lodging.
     */
    const reconciliation = reconcileLineItems(ex, (n) => toMinor(n) ?? 0n);
    const trustPerLine = (ex.confidence ?? 0) >= reviewThreshold && reconciliation.trustPerLine;
    const priced = (ex.lineItems ?? [])
      .map((li) => ({ sub: li.amount ?? 0, code: li.categoryCode }))
      .filter((li) => li.sub > 0);
    const gross = totalMinor ?? toMinor(ex.subtotal) ?? 0n;
    // No second guard on the branch itself. When `trustPerLine` is false every line
    // groups under the main category, which the collapse step merges into exactly one
    // line — so a `matched !== 'subtotal'` test here would be a redundant mechanism no
    // test could distinguish from this one. It would also be slightly WORSE: this
    // branch derives the gross as `subSum + tax` when the document states no total,
    // where the single-line branch falls back to the bare subtotal.
    if (priced.length < 2) {
      lineData.push({ categoryId: mainCatId, amountMinor: gross });
    } else {
      const groups = new Map<string, { catId: string; sub: number }>();
      for (const li of priced) {
        const own = trustPerLine && li.code && byId.has(li.code) ? li.code : null;
        const catId = own ?? mainCatId;
        const g = groups.get(catId) ?? { catId, sub: 0 };
        g.sub += li.sub;
        groups.set(catId, g);
      }
      const grouped = [...groups.values()];
      const taxMinor = explicit.gstHstMinor + explicit.qstMinor + explicit.pstMinor;
      const subSumMinor = priced.reduce((a, li) => a + (toMinor(li.sub) ?? 0n), 0n);
      const grossTotal = totalMinor ?? subSumMinor + taxMinor;
      const grossAlloc = allocate(
        grossTotal,
        grouped.map((g) => g.sub),
      );
      grouped.forEach((g, i) => {
        lineData.push({ categoryId: g.catId, amountMinor: grossAlloc[i] });
      });
    }
    if (lineData.length > 0) {
      // The receipt states ONE tip; a line has to own it. It goes to the largest
      // line whose category accepts one — a bill with a meal and a parking charge
      // tipped the meal. Mandatory gratuity is deliberately not handled here: it's
      // taxable, so it stays inside a line's amount where the extractor put it.
      const tipMinor = toMinor(ex.voluntaryTip) ?? 0n;
      let tipLineIndex = -1;
      if (tipMinor > 0n) {
        lineData.forEach((l, i) => {
          if (!byId.get(l.categoryId)?.acceptsTip) return;
          if (tipLineIndex < 0 || l.amountMinor > lineData[tipLineIndex].amountMinor) {
            tipLineIndex = i;
          }
        });
      }
      // One lookup for the whole extracted set, not one per line.
      const glByCategory = await glAccountIdsForCategories(
        db,
        lineData.map((l) => l.categoryId),
      );
      /**
       * One receipt per expense (1:1), so the extraction defines the line set and
       * replaces it whole — but only from HERE, where a replacement actually exists.
       *
       * This used to run before the set was built, and unconditionally. A document the
       * model could not read then deleted the person's own lines and created none in
       * their place: a hand-entered $113.00 line became $0.00 twelve seconds after a
       * receipt was attached, with no submit involved.
       */
      lineRows = lineData.map((l, i) => {
        const built = i === tipLineIndex ? tipPayload(tipMinor) : null;
        const mileage = byId.get(l.categoryId)?.isMileage;
        return {
          expenseId: expense.id,
          ...l,
          // Snapshotted at write time, like every other line-writing path.
          glAccountId: glByCategory.get(l.categoryId) ?? null,
          kind: mileage ? 'MILEAGE' : (built?.kind ?? 'STANDARD'),
          ...(built?.payload ? { payload: built.payload } : {}),
        };
      });
    }
  }

  // Tax lives on the EXPENSE now (a receipt = one tax total): the paid amounts
  // from the receipt (EXTRACTED), with recoverable ITC derived across the lines.
  // Absent relation → assume recoverable, the same default the tRPC path uses.
  const recoverable = deriveRecoverable(
    lineData,
    explicit,
    byId,
    expense.owner?.entity?.itcRecoverable ?? true,
  );
  /**
   * Whether the extraction produced any money at all.
   *
   * With no line set and no stated total there is nothing to write, and writing anyway
   * is what zeroed the expense: `totalMinor ?? 0n` supplied the zero, and
   * `nonZero(0n)` nulled the tax the person had typed. A read that found nothing must
   * leave the expense as it was — the same rule the header already follows.
   */
  const extractedMoney = lineData.length > 0 || totalMinor != null;
  const expenseTotal = lineData.reduce((a, l) => a + l.amountMinor, 0n) || (totalMinor ?? 0n);
  // Snapshot the conversion against the total we just derived, and against the
  // currency the receipt turned out to be in (adopted above) rather than the one
  // the expense was created with.
  const fx = await resolveExpenseFx(db, {
    ...fxParamsFrom(expense, expenseTotal),
    currencyCode,
  });
  /**
   * The money lands in ONE transaction that first takes the report row's lock and
   * re-reads its status. Every write below is therefore a write to a report that was
   * still DRAFT/RETURNED at commit; a submit racing this pass either commits first and
   * is seen here, or waits for this commit and files the extracted figures.
   */
  const settled = await db.$transaction(async (tx) => {
    const status = await lockReportStatus(tx, expense.reportId);
    if (!isReportEditable(status)) return { written: false as const, status };
    if (lineRows) {
      await tx.expenseLineItem.deleteMany({ where: { expenseId: expense.id } });
      await tx.expenseLineItem.createMany({ data: lineRows });
    }
    if (extractedMoney) {
      await tx.expense.update({
        where: { id: expense.id },
        data: {
          amountMinor: expenseTotal,
          taxGstHstMinor: nonZero(explicit.gstHstMinor),
          taxQstMinor: nonZero(explicit.qstMinor),
          taxPstMinor: nonZero(explicit.pstMinor),
          recoverableGstHstMinor: nonZero(recoverable.gstHst),
          recoverableQstMinor: nonZero(recoverable.qst),
          taxSource: ExpenseTaxSource.EXTRACTED,
          ...fxColumns(fx),
        },
      });
      // The shared roll-up, not a raw sum of `amountMinor`: adding minor units across
      // currencies produces a number that means nothing, and it disagreed with what
      // the web app stored for the same report. INSIDE the transaction, under the lock
      // taken above: run after the commit it would re-lock the row on its own, and a
      // submit + approve landing in that gap would leave the lines written here
      // against a total the guard then (rightly) refuses to update.
      await recomputeReportTotal(tx, expense.reportId);
    }
    return { written: true as const };
  });
  if (!settled.written) {
    await recordExtractionSkipped(expense.id, expense.reportId, settled.status, receiptId);
    return;
  }

  /**
   * The merchant's printed transaction/auth number, kept rather than discarded.
   *
   * It was already extracted and read once for receipt grouping, then dropped. It is
   * the strongest evidence two documents are NOT the same charge, so persisting it is
   * what lets a later duplicate check ask "have we seen this number" instead of
   * inferring from vendor, date and total — which is how two coffees from one kiosk on
   * one day look like a single charge entered twice.
   *
   * Last, and swallowing its own failure: an optional correlation must not be able to
   * undo a prefill that has already written the money.
   */
  try {
    await recordTransactionId(db, {
      receiptId,
      expenseId: expense.id,
      transactionId: ex.transactionId,
    });
  } catch (err) {
    console.warn(`[prefill] transaction id not recorded for expense ${expense.id}: ${err}`);
  }
}

/**
 * The audit line for a result that was read and deliberately not applied. Without it
 * a receipt whose printed total disagrees with its expense has no visible reason, and
 * the next person to look assumes the extraction failed. Best-effort: the decision not
 * to write must not itself fail the job.
 */
async function recordExtractionSkipped(
  expenseId: string,
  reportId: string,
  reportStatus: string | null,
  receiptId: string | null | undefined,
): Promise<void> {
  try {
    await withAudit(
      db,
      {
        action: auditActions.report.extractionSkipped,
        entityType: 'Expense',
        entityId: expenseId,
        actor: { kind: 'system', jobName: 'expense.extractReceipt' },
        details: { reportId, reportStatus, receiptId: receiptId ?? null },
      },
      async () => null,
    );
  } catch (err) {
    console.warn(`[prefill] skip not audited for expense ${expenseId}: ${err}`);
  }
  console.info(
    `[prefill] expense ${expenseId} not rewritten: report ${reportId} is ${reportStatus ?? 'gone'}`,
  );
}
