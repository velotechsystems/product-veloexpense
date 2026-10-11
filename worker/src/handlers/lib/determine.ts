/**
 * Rebuild an expense from the JOINT determination over its whole document set.
 *
 * Called when an expense gains a second (third, …) document. The single-document
 * path stays as it is — one receipt is already one answer, and paying for a
 * second model call to reach the same conclusion would be waste.
 *
 * The contract with the rest of the system:
 *
 *   1. Every document is read TOGETHER, so the bill's total and the card copy's
 *      total are understood as the same charge rather than summed.
 *   2. The derived state is WIPED and rebuilt. Merging into the previous answer
 *      is how upload three inherits upload two's mistakes.
 *   3. Human corrections go IN (so the pass reconciles to them) and are applied
 *      again on the way OUT (so a rebuild never costs somebody their work).
 *
 * Best-effort, like every extraction path: the receipts and the expense are
 * already persisted, so a model failure leaves what the user can see intact.
 *
 * Ported from ExpenseOS's `apps/worker/src/handlers/lib/determine.ts` (550b2945), Wave 3
 * (w3-02b). VeloExpense, plumbing only: `db` is the tenant-scoped client; a currency's key
 * is its code and an entity's home currency is that code (`homeCurrencyId`), as in prefill;
 * only STORED receipts are documents (as everywhere VeloExpense reads them); and the model
 * call is recorded in `ai_usage` (d43).
 */

import { auditActions, withAudit } from '@expenseos/audit';
import {
  currentDetermination,
  EXPENSE_FX_SELECT,
  ExpenseTaxSource,
  fxColumns,
  fxParamsFrom,
  glAccountIdsForCategories,
  type OverrideMap,
  overridesForPrompt,
  type Prisma,
  recomputeReportTotal,
  resolveExpenseFx,
  supersedeDetermination,
} from '@expenseos/db';
import { tipPayload } from '@expenseos/expense-lines';
import { getCurrency, isKnownCurrency } from '@expenseos/money';
import {
  type DeterminationDocument,
  determineExpense,
  type ExpenseDeterminationResult,
} from '@expenseos/receipt-extraction';
import { allocateRecoverable } from '@expenseos/tax';
import { db } from '@/lib/db/prisma';
import { anthropicForExtraction } from './anthropic';
import { fetchCleanDocument, message, prepareExtraction, recordExtractionUsage } from './extract-core';
import { type CategoryRow, labelEn } from './prefill';
import { isReportEditable, lockReportStatus } from './report-editable';

/** Minor-unit helper bound to one currency's ISO-4217 exponent. */
function minorAt(exponent: number) {
  return (d: number | null | undefined): bigint | null =>
    d == null ? null : BigInt(Math.round(d * 10 ** exponent));
}

function nonZero(v: bigint | null): bigint | null {
  return v == null || v === 0n ? null : v;
}

/**
 * Which fields a human has already decided, as the REBUILD must respect them.
 *
 * Parsed back out of the same rendered strings that went into the prompt. That
 * round-trip is deliberate: one representation, written once by the UI, read by
 * both the model and the rebuild — so there is no way for the prompt to be told
 * one thing and the database another.
 */
interface AppliedOverrides {
  merchant?: string;
  location?: string;
  date?: Date;
  totalMinor?: bigint;
  subtotalMinor?: bigint;
  taxGstHstMinor?: bigint;
  taxQstMinor?: bigint;
  taxPstMinor?: bigint;
  /** The human owns the line set — the rebuild must not touch it. */
  keepLineItems?: boolean;
  fxRate?: string;
}

function parseOverrides(overrides: OverrideMap, exponent: number): AppliedOverrides {
  const toMinor = (s: string | undefined): bigint | undefined => {
    if (s == null) return undefined;
    const n = Number(s.replace(/[^\d.-]/g, ''));
    return Number.isFinite(n) ? BigInt(Math.round(n * 10 ** exponent)) : undefined;
  };
  const date = overrides.date ? new Date(overrides.date) : undefined;
  return {
    merchant: overrides.merchant,
    location: overrides.location,
    date: date && !Number.isNaN(date.getTime()) ? date : undefined,
    totalMinor: toMinor(overrides.total),
    subtotalMinor: toMinor(overrides.subtotal),
    taxGstHstMinor: toMinor(overrides.taxGstHst),
    taxQstMinor: toMinor(overrides.taxQst),
    taxPstMinor: toMinor(overrides.taxPst),
    keepLineItems: overrides.lineItems != null,
    fxRate: overrides.fxRate,
  };
}

/**
 * Load every document's bytes for the joint pass — scanning only what has not
 * been scanned.
 *
 * The determination must SEE all documents (that is the whole point: a bill and
 * its cardholder copy are one charge, and only a reader with both knows the
 * difference between them is a tip). But it must not RE-SCAN them. GuardDuty's
 * verdict on an object never changes, so a document already recorded CLEAN is
 * settled; re-gating it costs a tag read per file per upload and, worse, drove its
 * `DocumentExtraction` back to EXTRACTING — which the report page reads to decide
 * whether to keep polling and the workbench reads to decide whether the editor is
 * locked. A second upload therefore used to lock the expense permanently.
 *
 * So: a CLEAN document is re-read read-only; anything else goes through the full
 * gate, which owns its status. In practice the new file has already been gated by
 * its own extraction job before this runs, so the common case writes nothing at
 * all.
 *
 * A file that can't be read is dropped rather than failing the pass — three
 * readable documents still beat none.
 */
async function loadDocuments(
  receipts: {
    id: string;
    s3Key: string;
    contentType: string;
    filename: string;
    extraction: { scanStatus: string } | null;
  }[],
  categoryHints: { code: string; label: string }[],
): Promise<DeterminationDocument[]> {
  const out: DeterminationDocument[] = [];
  for (const r of receipts) {
    const alreadyClean = r.extraction?.scanStatus === 'CLEAN';
    const prepared = alreadyClean
      ? await fetchCleanDocument({ s3Key: r.s3Key, contentType: r.contentType })
      : await prepareExtraction({
          where: { receiptId: r.id },
          s3Key: r.s3Key,
          contentType: r.contentType,
          categoryHints,
        });
    if (!prepared) continue;
    out.push({
      documentId: r.id,
      filename: r.filename,
      data: prepared.data,
      mimeType: prepared.mimeType,
    });
  }
  return out;
}

/**
 * Run the joint determination for one expense and apply it.
 *
 * Returns what happened, for the caller's log — never throws on a business
 * failure.
 */
export async function determineAndRebuild(
  expenseId: string,
  categories: CategoryRow[],
): Promise<{ status: 'rebuilt' | 'skipped'; reason?: string }> {
  const expense = await db.expense.findUnique({
    where: { id: expenseId },
    select: {
      id: true,
      reportId: true,
      currencyId: true,
      ...EXPENSE_FX_SELECT,
      // VeloExpense: the home currency is the entity's `homeCurrencyId` (an ISO code).
      owner: {
        select: {
          entity: { select: { itcRecoverable: true, homeCurrencyId: true } },
        },
      },
      report: { select: { status: true } },
      receipts: {
        // VeloExpense: only a receipt whose object is verified in storage is a document.
        where: { status: 'STORED' },
        orderBy: { uploadedAt: 'asc' },
        select: {
          id: true,
          s3Key: true,
          contentType: true,
          filename: true,
          // Whether this file has already cleared the malware gate — the one fact
          // that decides re-scan vs read-only re-read.
          extraction: { select: { scanStatus: true } },
        },
      },
    },
  });
  if (!expense) return { status: 'skipped', reason: 'expense gone' };
  // A filed report's numbers must not move under its approver. Documents can
  // still be attached for evidence; they simply no longer redetermine anything.
  if (expense.report.status !== 'DRAFT' && expense.report.status !== 'RETURNED') {
    return { status: 'skipped', reason: `report is ${expense.report.status}` };
  }
  if (expense.receipts.length === 0) return { status: 'skipped', reason: 'no documents' };

  const hints = categories.map((c) => ({ code: c.id, label: labelEn(c.label) }));
  const documents = await loadDocuments(expense.receipts, hints);
  if (documents.length === 0) return { status: 'skipped', reason: 'no readable documents' };

  const prior = await currentDetermination(db, expenseId);
  const priorOverrides = prior?.overrides ?? {};

  let result: ExpenseDeterminationResult;
  let model: string;
  let confidence: number | null;
  try {
    // Same credential as the single-document path — the `anthropic` integration, with
    // the environment behind it. Threaded in rather than read from `process.env` inside
    // the package, so one admin action covers every call Claude receives.
    const anthropic = await anthropicForExtraction();
    const run = await determineExpense({
      documents,
      categoryHints: hints,
      overrides: overridesForPrompt(priorOverrides),
      ...(anthropic?.apiKey ? { apiKey: anthropic.apiKey } : {}),
      ...(anthropic?.model ? { model: anthropic.model } : {}),
    });
    result = run.data;
    model = run.model;
    confidence = run.confidence;
    // VeloExpense (d43): one joint call, over the whole set — recorded against no single
    // receipt, as included receipt reading.
    await recordExtractionUsage(null, run, { feature: 'expense_determination' });
  } catch (err) {
    return { status: 'skipped', reason: message(err) };
  }

  const documentIds = documents.map((d) => d.documentId);
  const outcome = await applyDetermination({
    expense,
    documents: documentIds,
    result,
    model,
    confidence,
    overrides: priorOverrides,
    categories,
  });
  if (!outcome.applied) {
    // The status the LOCK saw, not the one the read above did. The report was filed
    // while the model was thinking, so the determination is discarded and said so.
    await recordDeterminationSkipped(expense.id, expense.reportId, outcome.status, documentIds);
    return {
      status: 'skipped',
      reason: `report became ${outcome.status ?? 'gone'} while the determination ran`,
    };
  }
  return { status: 'rebuilt' };
}

/**
 * What the apply did, for the caller's log.
 *
 * `applied: false` is not a failure: it means the report stopped being the
 * submitter's between the plain status read at the top of `determineAndRebuild` and
 * the moment the writes were ready to commit, and the determination was therefore
 * thrown away rather than restated over a filed claim.
 */
type ApplyOutcome = { applied: true } | { applied: false; status: string | null };

async function applyDetermination(params: {
  expense: {
    id: string;
    reportId: string;
    currencyId: string;
    amountMinor: bigint;
    currency: { code: string };
    fxRate: { toString(): string } | null;
    // VeloExpense: text with a CHECK (0054), so the client types it `string`.
    fxRateSource: string | null;
    owner: { entity: { itcRecoverable: boolean; homeCurrencyId: string | null } | null };
  };
  documents: string[];
  result: ExpenseDeterminationResult;
  model: string;
  confidence: number | null;
  overrides: OverrideMap;
  categories: CategoryRow[];
}): Promise<ApplyOutcome> {
  const { expense, result, categories } = params;

  // ── The currency the determination settled on ─────────────────────────────
  //
  // Adopted when the set names a real one, because the amounts below are in THAT
  // currency and its exponent is what parses them (JPY has none, KWD has three).
  let currencyCode = expense.currency.code;
  let adoptCurrencyId: string | null = null;
  if (result.currencyCode) {
    const code = result.currencyCode.trim().toUpperCase();
    if (code !== currencyCode && isKnownCurrency(code)) {
      // VeloExpense: a currency's key IS its code.
      const row = await db.currency.findUnique({ where: { code }, select: { code: true } });
      if (row) {
        currencyCode = code;
        adoptCurrencyId = row.code;
      }
    }
  }
  const exponent = getCurrency(currencyCode).exponent;
  const toMinor = minorAt(exponent);
  const applied = parseOverrides(params.overrides, exponent);

  // ── Header ────────────────────────────────────────────────────────────────
  const header = {
    merchant: applied.merchant ?? result.vendor ?? undefined,
    // `placeText` is the column; `applied.location` is this module's own
    // internal shape and keeps its name. Same rename miss as prefill.ts.
    placeText: applied.location ?? result.address ?? undefined,
    ...(applied.date ? { date: applied.date } : result.date ? { date: new Date(result.date) } : {}),
    ...(adoptCurrencyId ? { currencyId: adoptCurrencyId } : {}),
    subtotalMinor: applied.subtotalMinor ?? toMinor(result.subtotal),
  };

  // ── Document classification ───────────────────────────────────────────────
  //
  // What each file turned out to be. AP can correct it; the point is that the
  // reviewer can see WHY the tip came from one document and the tax from another.
  const seen = new Set(params.documents);
  const verdicts = result.documents.filter((v) => seen.has(v.documentId));

  // ── Lines: wipe and rebuild, unless the human owns them ───────────────────
  const byId = new Map(categories.map((c) => [c.id, c]));
  const fallbackCategoryId =
    (result.derivedCategoryCode && byId.has(result.derivedCategoryCode)
      ? result.derivedCategoryCode
      : null) ?? categories[0]?.id;

  let lineData: {
    categoryId: string;
    amountMinor: bigint;
    tipMinor: bigint;
    notes: string | null;
  }[] = [];
  /** The rows to write, or null when the line set is not this pass's to touch. */
  let lineRows: Prisma.ExpenseLineItemUncheckedCreateInput[] | null = null;
  if (applied.keepLineItems) {
    // The person authored these lines. Read them back so tax still allocates
    // across the real categories, and leave the rows alone.
    const existing = await db.expenseLineItem.findMany({
      where: { expenseId: expense.id },
      select: { categoryId: true, amountMinor: true },
    });
    lineData = existing.map((l) => ({
      categoryId: l.categoryId,
      amountMinor: l.amountMinor,
      tipMinor: 0n,
      notes: null,
    }));
  } else if (fallbackCategoryId) {
    for (const li of result.lineItems) {
      const amount = toMinor(li.amount);
      if (amount == null || amount === 0n) continue;
      const categoryId =
        li.categoryCode && byId.has(li.categoryCode) ? li.categoryCode : fallbackCategoryId;
      // A tip only lands where its category admits one — otherwise the flag on
      // ExpenseCategory is decorative and a tip appears on a software renewal.
      const tip = byId.get(categoryId)?.acceptsTip ? (toMinor(li.tip) ?? 0n) : 0n;
      lineData.push({
        categoryId,
        amountMinor: amount,
        tipMinor: tip > 0n && tip < amount ? tip : 0n,
        notes: li.description?.slice(0, 500) ?? null,
      });
    }
    // Nothing itemized but a total is known: one line at the whole amount, so the
    // expense is still coded and still adds up.
    const total = applied.totalMinor ?? toMinor(result.total);
    if (lineData.length === 0 && total != null && total !== 0n) {
      lineData.push({
        categoryId: fallbackCategoryId,
        amountMinor: total,
        tipMinor: 0n,
        notes: null,
      });
    }
    // One lookup for the whole rebuilt set, not one per line — and OUTSIDE the
    // transaction below, because reference data a write only reads is a round trip
    // held open under a row lock for nothing.
    const glByCategory = await glAccountIdsForCategories(
      db,
      lineData.map((l) => l.categoryId),
    );
    lineRows = lineData.map((l) => {
      const tip = tipPayload(l.tipMinor);
      return {
        expenseId: expense.id,
        categoryId: l.categoryId,
        glAccountId: glByCategory.get(l.categoryId) ?? null,
        amountMinor: l.amountMinor,
        notes: l.notes,
        kind: tip.kind,
        ...(tip.payload ? { payload: tip.payload as Prisma.InputJsonValue } : {}),
      };
    });
  }

  // ── Tax + total ───────────────────────────────────────────────────────────
  const gstHst = applied.taxGstHstMinor ?? toMinor(result.taxGstHst) ?? 0n;
  const qst = applied.taxQstMinor ?? toMinor(result.taxQst) ?? 0n;
  const pst = applied.taxPstMinor ?? toMinor(result.taxPst) ?? 0n;
  const entityRecovers = expense.owner.entity?.itcRecoverable ?? true;
  // The tip leaves the taxable base but stays inside its line's amount, which is
  // why the recoverable split is weighted by the line net.
  const recoverable = allocateRecoverable({
    gstHstMinor: gstHst,
    qstMinor: qst,
    lines: lineData.map((l) => {
      const cat = byId.get(l.categoryId);
      return {
        amountMinor: l.amountMinor - l.tipMinor,
        itcGstHstRate: cat?.itcGstHstRate ?? 100,
        itcQstRate: cat?.itcQstRate ?? 100,
      };
    }),
    entityRecovers,
  });

  const lineSum = lineData.reduce((a, l) => a + l.amountMinor, 0n);
  const amountMinor =
    applied.totalMinor ?? (lineSum !== 0n ? lineSum : (toMinor(result.total) ?? 0n));

  // ── FX ────────────────────────────────────────────────────────────────────
  //
  // A statement that shows the same charge settled in the home currency IS the
  // rate that was applied — better evidence than the daily table, which is why
  // EXTRACTED outranks CALCULATED. A human's rate still outranks both.
  const homeCurrency = expense.owner.entity?.homeCurrencyId ?? null;
  const statementRate =
    result.fxRate != null &&
    result.fxRate > 0 &&
    result.fxToCurrency &&
    homeCurrency &&
    result.fxToCurrency.trim().toUpperCase() === homeCurrency.toUpperCase()
      ? String(result.fxRate)
      : null;
  const fx = await resolveExpenseFx(db, {
    ...fxParamsFrom({ ...expense, amountMinor }, amountMinor),
    currencyCode,
    providedRate: applied.fxRate
      ? { rate: applied.fxRate, source: 'MANUAL' }
      : statementRate
        ? { rate: statementRate, source: 'EXTRACTED' }
        : (fxParamsFrom(expense).providedRate ?? null),
  });

  /**
   * Everything above is arithmetic and reads; everything below is the write.
   *
   * The write lands in ONE transaction whose first statement takes the report row's
   * lock and re-reads the status. The only check this used to have was a plain read
   * in `determineAndRebuild`, taken BEFORE the model call — and the model call is
   * long (the Batch API polls for up to an hour). A report submitted and approved in
   * that window still had its merchant, its line set, its tax, its FX snapshot and
   * its determination rewritten underneath the person who signed it.
   *
   * `submit` changes the status with a plain UPDATE, which must wait for this lock.
   * So a write here is a write to a report that was still DRAFT/RETURNED at COMMIT,
   * and a submit that already landed is seen rather than stepped over. The model call
   * stays outside, as does every read it needs — a transaction that waits on Anthropic
   * would hold the row for an hour.
   */
  return db.$transaction(async (tx) => {
    const status = await lockReportStatus(tx, expense.reportId);
    if (!isReportEditable(status)) return { applied: false as const, status };

    await tx.expense.update({ where: { id: expense.id }, data: header });

    for (const verdict of verdicts) {
      await tx.receipt.update({
        where: { id: verdict.documentId },
        data: { kind: verdict.kind },
      });
    }

    if (lineRows) {
      await tx.expenseLineItem.deleteMany({ where: { expenseId: expense.id } });
      for (const row of lineRows) {
        await tx.expenseLineItem.create({ data: row });
      }
    }

    await tx.expense.update({
      where: { id: expense.id },
      data: {
        amountMinor,
        taxGstHstMinor: nonZero(gstHst),
        taxQstMinor: nonZero(qst),
        taxPstMinor: nonZero(pst),
        recoverableGstHstMinor: nonZero(recoverable.recoverableGstHstMinor),
        recoverableQstMinor: nonZero(recoverable.recoverableQstMinor),
        taxSource: ExpenseTaxSource.EXTRACTED,
        ...fxColumns(fx),
      },
    });

    // ── The determination itself ─────────────────────────────────────────────
    //
    // Under the same lock as the figures it explains: a chain that survived a rolled
    // back apply would describe numbers the expense does not have.
    await supersedeDetermination(tx, {
      expenseId: expense.id,
      receiptIds: params.documents,
      proposed: params.result as unknown as Prisma.InputJsonValue,
      overrides: params.overrides,
      model: params.model,
      confidence: params.confidence,
    });

    // On `tx`, so the roll-up runs under the lock taken above rather than opening a
    // transaction of its own. Its status guard (#511) is still the backstop — but it
    // is no longer the only thing standing between a decided report and this pass,
    // because the expense-level writes above now share this lock.
    await recomputeReportTotal(tx, expense.reportId);
    return { applied: true as const };
  });
}

/**
 * The audit line for a determination that was read and deliberately not applied.
 *
 * The same record `prefill` leaves for the same refusal, under the same action, so
 * "why does this expense disagree with its receipts" has one answer to look for
 * whichever path read them. Best-effort: the decision not to write must not itself
 * fail the job.
 */
async function recordDeterminationSkipped(
  expenseId: string,
  reportId: string,
  reportStatus: string | null,
  receiptIds: string[],
): Promise<void> {
  try {
    await withAudit(
      db,
      {
        action: auditActions.report.extractionSkipped,
        entityType: 'Expense',
        entityId: expenseId,
        actor: { kind: 'system', jobName: 'expense.determineExpense' },
        details: { reportId, reportStatus, receiptIds },
      },
      async () => null,
    );
  } catch (err) {
    console.warn(`[determine] skip not audited for expense ${expenseId}: ${err}`);
  }
}
