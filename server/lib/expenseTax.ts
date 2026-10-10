/**
 * Server-authoritative tax resolution at the EXPENSE level.
 *
 * A receipt (= one expense) carries one tax total. `resolveExpenseTax` runs the
 * pure `@expenseos/tax` engine to split GST/HST vs QST vs PST on the expense's
 * TAXABLE base, then derives the recoverable ITC slice with the shared
 * `allocateRecoverable` — tax split across the lines by amount, each line's
 * category rate applied, gated by the legal entity. MANUAL/EXTRACTED amounts are
 * trusted (explicit-wins); CALCULATED reverse-calcs. Recoverable is always
 * engine-derived, never client-supplied.
 *
 * The taxable base is NOT the expense total: a voluntary tip is reimbursed but
 * not taxed (CRA), so it comes off the gross before the reverse-calc. Mandatory
 * gratuity stays in — it IS taxable. The engine's own contract has said so all
 * along; this caller simply wasn't honouring it, and every Canadian meal with a
 * tip was over-taxed and over-credited as a result.
 */

import type { ExpenseTaxSource, Prisma } from '@expenseos/db';
import {
  type ExplicitTax,
  explainRecoverable,
  explainTax,
  type RecoverableTrace,
  type TaxTrace,
} from '@expenseos/tax';

/** A line item as far as tax allocation cares: its category + amount. */
export interface LineForTax {
  categoryId: string;
  amountMinor: bigint;
}

export interface ResolveExpenseTaxParams {
  /** Tax-inclusive expense total (minor units) — the whole gross, tip included. */
  grossMinor: bigint;
  /**
   * Voluntary tip inside `grossMinor`, which is reimbursed but never taxed.
   * Subtracted before the reverse-calc; ignored when the tax amounts are
   * explicit, since those are taken as given.
   */
  untaxedTipMinor?: bigint;
  taxJurisdictionId: string | null;
  taxSource: ExpenseTaxSource;
  /** Explicit tax paid — used only when taxSource is MANUAL or EXTRACTED. */
  explicit?: ExplicitTax;
  /** The expense's line items — the recoverable ITC is allocated across these. */
  lines: LineForTax[];
  /**
   * Whether the submitter's LEGAL ENTITY can reclaim input tax credits
   * (`LegalEntity.itcRecoverable`).
   *
   * False for a non-registrant or exempt entity — a US corporation, say — and it
   * forces BOTH recoverable figures to 0 regardless of the category's ITC%. The
   * credit belongs to the entity that incurred the cost, so the entity is what
   * decides whether one arises at all; the category rate only ever narrows a
   * credit that exists. Defaults to true.
   */
  itcRecoverable?: boolean;
}

export interface ResolvedExpenseTax {
  taxGstHstMinor: bigint;
  taxQstMinor: bigint;
  taxPstMinor: bigint;
  recoverableGstHstMinor: bigint;
  recoverableQstMinor: bigint;
}

/**
 * The same figures, plus why they are what they are.
 *
 * Two traces rather than one, because this pipeline has two stages and a zero can come from
 * either: `tax` explains the SPLIT (was any tax charged, and why not), `recoverable` explains
 * the CREDIT (the entity gate, the line items, the category rates). Somebody asking "why is
 * my recoverable ITC zero?" is asking about one of them, and answering from the wrong stage
 * produces a fluent, specific, wrong answer.
 */
export interface ExplainedExpenseTax extends ResolvedExpenseTax {
  taxTrace: TaxTrace;
  recoverableTrace: RecoverableTrace;
}

/** No jurisdiction coded → no tax (e.g. a US expense with no state selected). */
const ZERO_RATES = { gstRate: 0, hstRate: 0, pstRate: 0, qstRate: 0, salesTaxRate: 0 };
/** ITC recoverability is applied per line below, so the engine's own category
 *  slice is neutral here (we take only its GST/HST·QST·PST split). */
const FULL_ITC = { itcGstHstRate: 100, itcQstRate: 100, pstRecoverable: false };

/**
 * The figures alone. Delegates to `explainExpenseTax` and drops the traces, so the write path
 * and the explanation can never be two implementations that drift apart — the same reason
 * `explainTax` re-runs `computeTax` rather than restating its arithmetic.
 */
export async function resolveExpenseTax(
  db: Pick<Prisma.TransactionClient, 'expenseCategory' | 'taxJurisdiction'>,
  params: ResolveExpenseTaxParams,
): Promise<ResolvedExpenseTax> {
  const {
    taxTrace: _taxTrace,
    recoverableTrace: _recoverableTrace,
    ...tax
  } = await explainExpenseTax(db, params);
  return tax;
}

/** The figures, and the trace behind each stage. */
export async function explainExpenseTax(
  db: Pick<Prisma.TransactionClient, 'expenseCategory' | 'taxJurisdiction'>,
  params: ResolveExpenseTaxParams,
): Promise<ExplainedExpenseTax> {
  const j = params.taxJurisdictionId
    ? await db.taxJurisdiction.findUnique({
        where: { id: params.taxJurisdictionId },
        select: { gstRate: true, hstRate: true, pstRate: true, qstRate: true, salesTaxRate: true },
      })
    : null;
  // The tip is reimbursed but untaxed, so it leaves the base before the
  // reverse-calc. Clamped at zero: a tip larger than the total is nonsense, and
  // a negative base would invent a credit.
  const tip = params.untaxedTipMinor ?? 0n;
  const taxableMinor =
    tip > 0n && tip < params.grossMinor ? params.grossMinor - tip : params.grossMinor;
  const split = explainTax({
    grossMinor: taxableMinor,
    jurisdiction: j
      ? {
          gstRate: Number(j.gstRate),
          hstRate: Number(j.hstRate),
          pstRate: Number(j.pstRate),
          qstRate: Number(j.qstRate),
          salesTaxRate: Number(j.salesTaxRate),
        }
      : ZERO_RATES,
    category: FULL_ITC,
    explicit: params.taxSource === 'CALCULATED' ? undefined : params.explicit,
  });

  // Recoverable ITC: one shared allocator for every write path, so the tRPC
  // editor and the worker's extraction prefill can't round differently or
  // disagree about the entity gate.
  const catIds = [...new Set(params.lines.map((l) => l.categoryId))];
  const cats = catIds.length
    ? await db.expenseCategory.findMany({
        where: { id: { in: catIds } },
        select: { id: true, itcGstHstRate: true, itcQstRate: true },
      })
    : [];
  const itc = new Map(cats.map((c) => [c.id, c]));
  const recoverable = explainRecoverable({
    gstHstMinor: split.gstHstMinor,
    qstMinor: split.qstMinor,
    entityRecovers: params.itcRecoverable !== false,
    lines: params.lines.map((l) => ({
      amountMinor: l.amountMinor,
      itcGstHstRate: itc.get(l.categoryId)?.itcGstHstRate ?? 100,
      itcQstRate: itc.get(l.categoryId)?.itcQstRate ?? 100,
    })),
  });

  return {
    taxGstHstMinor: split.gstHstMinor,
    taxQstMinor: split.qstMinor,
    taxPstMinor: split.pstMinor,
    recoverableGstHstMinor: recoverable.recoverableGstHstMinor,
    recoverableQstMinor: recoverable.recoverableQstMinor,
    taxTrace: split.trace,
    recoverableTrace: recoverable.trace,
  };
}
