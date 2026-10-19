/**
 * An approved trip becomes an expense report skeleton.
 *
 * `importItinerary` in the legacy app (archive, L3389–3453) is the model, with its
 * three real bugs corrected. They are worth naming, because each produced data that
 * looked plausible and was wrong:
 *
 *   · it hardcoded `location: "US-Default"` and `currency: "USD"` on every generated
 *     line regardless of destination, so a Montréal trip filed in the wrong currency
 *     and reconciled against nothing;
 *   · it invented amounts — flight `min(budget × 0.4, 2000)`, car
 *     `min(budget × 0.2, 75 × nights)` — arbitrary fractions of a number that was
 *     itself a guess. Here the lines carry the APPROVED budget figures, which are
 *     either live quotes or per-diem allowances and in both cases came from
 *     somewhere;
 *   · it generated one lodging line PER NIGHT. A hotel issues one folio, and
 *     reconciling one receipt against seven lines is work nobody needs.
 *
 * The generated amounts are a starting point, not a claim. The traveller replaces
 * them with what was actually spent — which is the whole point of budget-vs-actual.
 */

import { nextReportNumber, type Prisma, type PrismaClient } from '@expenseos/db';
import { readTravelLinePayload } from '@expenseos/travel-lines';

type Db = PrismaClient | Prisma.TransactionClient;

export interface BuildReportResult {
  reportId: string;
  /** Expenses generated. Zero is possible — an approved request whose budget lines
   *  were all removed — and is not an error. */
  expenses: number;
  /** True when an existing draft was returned instead of a new report being made. */
  reused: boolean;
  /**
   * Budget lines that could NOT become expenses, because their travel category maps
   * to no expense category — there is nothing to code the generated line to.
   *
   * Reported rather than dropped silently: the traveller is about to file a report
   * that is short by these amounts, and finding that out by arithmetic is worse than
   * being told. Empty in the ordinary case, and always empty for a reused draft,
   * which reports what a previous call already decided.
   */
  skipped: { categoryId: string; label: unknown }[];
}

/** 'Sep 1 – Sep 4, 2026 · Toronto' is a title someone can find in a list. */
export function reportTitle(
  destination: string,
  departDate: Date,
  returnDate: Date | null,
  locale = 'en-CA',
): string {
  const fmt = (d: Date) =>
    d.toLocaleDateString(locale, {
      timeZone: 'UTC',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  const span = returnDate ? `${fmt(departDate)} – ${fmt(returnDate)}` : fmt(departDate);
  return `${destination} · ${span}`;
}

/**
 * The approved cabin, as a note for whoever reviews the claim.
 *
 * WHY IT IS HERE AND NOT A RULE. The cabin restriction blocks at REQUEST time, which is
 * the real control. It cannot be re-checked at expense time: an employee who cannot
 * request business class and books it anyway filed a request saying ECONOMY, so a rule
 * reading the request's cabin reads "economy" and finds nothing, and the cabin is
 * recorded nowhere on the expense at all. What catches that is the AMOUNT
 * (`TRAVEL_OVERRUN`), and what makes the overrun legible is knowing what was actually
 * approved. So this is CONTEXT for a human, deliberately not something a rule keys on.
 *
 * Null for economy: every trip that stayed within the ordinary cabin would otherwise
 * carry a note saying nothing, and a note that is always there is a note nobody reads.
 *
 * English, like `detail` and `reportTitle` beside it. That is a real limitation shared by
 * every server-composed travel string, not a new one introduced here — a violation
 * MESSAGE is localized at render because it is assembled from a key plus data, and free
 * text has no such seam.
 */
function cabinNote(kind: string, payload: unknown): string | null {
  if (kind !== 'AIRFARE') return null;
  const cabin = readTravelLinePayload('AIRFARE', payload)?.travelClass;
  if (!cabin || cabin === 'ECONOMY') return null;
  return `Approved cabin · ${cabin.replace(/_/g, ' ').toLowerCase()}`;
}

/**
 * Build (or find) the report for an approved travel request.
 *
 * Idempotent by design. A second call returns the existing DRAFT rather than making
 * another skeleton — the legacy app produced a duplicate every time somebody pressed
 * the button twice. A request whose report has already been SUBMITTED throws: that
 * report is in an approval chain, and quietly generating a rival copy of it is worse
 * than refusing.
 */
export async function buildReportFromTravel(
  db: Db,
  requestId: string,
  locale = 'en-CA',
): Promise<BuildReportResult> {
  const req = await db.travelRequest.findUniqueOrThrow({
    where: { id: requestId },
    select: {
      id: true,
      status: true,
      submitterId: true,
      purpose: true,
      destinationLabel: true,
      destinationCity: true,
      departDate: true,
      returnDate: true,
      currencyId: true,
      budgetLines: {
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
        select: {
          glAccountId: true,
          amountMinor: true,
          basis: true,
          // VeloExpense (w6-01): `notes`. ExpenseOS's own migration renamed this column
          // (`detail` → `notes`, 20260901040000) and this select kept the old name, so
          // ExpenseOS's Prisma refuses the query ("Unknown field `detail`") for every
          // approved request — a real ExpenseOS bug, fixed here, not ported.
          notes: true,
          // The cabin lives in the AIRFARE payload, and it is the one fact from the
          // approval that the expense side cannot otherwise recover. See `cabinNote`.
          kind: true,
          payload: true,
          // An expense line item codes to an EXPENSE category, so a budget line has
          // to cross the mapping to become one. `label` is here for the message a
          // skipped line produces.
          category: { select: { id: true, label: true, expenseCategoryId: true } },
        },
      },
    },
  });
  if (req.status !== 'APPROVED') {
    throw new Error('travel: only an approved request can become an expense report');
  }

  const existing = await db.expenseReport.findFirst({
    where: { travelRequestId: req.id },
    orderBy: { createdAt: 'desc' },
    select: { id: true, status: true },
  });
  if (existing) {
    if (existing.status !== 'DRAFT') {
      throw new Error('travel: this request already has a submitted expense report');
    }
    return { reportId: existing.id, expenses: 0, reused: true, skipped: [] };
  }

  /**
   * Only the lines that can become an expense line item.
   *
   * A travel category with no expense counterpart cannot: there is no category to
   * code the generated line to, and inventing one would put a bucket in the
   * accounting taxonomy that no accountant chose. Those lines are SKIPPED and named
   * in the result, so the traveller is told what did not come across instead of
   * discovering a short report — the `skipped` list is what the caller surfaces.
   *
   * The total follows the lines that were actually created, not the budget, or the
   * report would open already disagreeing with the sum of its own expenses.
   */
  const mappable = req.budgetLines.filter((l) => l.category.expenseCategoryId != null);
  const skipped = req.budgetLines
    .filter((l) => l.category.expenseCategoryId == null)
    .map((l) => ({ categoryId: l.category.id, label: l.category.label }));

  const total = mappable.reduce((a, l) => a + l.amountMinor, 0n);
  // VeloExpense (w6-01): the report number is per tenant, from the organization's sequence
  // (`nextReportNumber`, as the expenses router's `mintReportNumber` takes it); ExpenseOS's
  // comes from a column default.
  const number = await nextReportNumber(db as Prisma.TransactionClient);
  if (!number) throw new Error('travel: no tenant scope to number the report in');
  const report = await db.expenseReport.create({
    data: {
      number,
      title: reportTitle(req.destinationLabel, req.departDate, req.returnDate, locale),
      purpose: req.purpose,
      // The REQUEST's currency, not a hardcoded one. This is the whole of the first
      // legacy bug.
      currencyId: req.currencyId,
      submitterId: req.submitterId,
      travelRequestId: req.id,
      totalMinor: total,
      expenses: {
        create: mappable.map((line) => ({
          ownerId: req.submitterId,
          // The real destination. A per-diem rule matches on this string, so getting
          // it right is also what makes the generated lines checkable against the
          // allowance they came from.
          placeText: req.destinationCity ?? req.destinationLabel,
          // Departure day for everything. A budget is not an itinerary — pretending
          // to know the date of a dinner four days into a trip would be inventing
          // detail, and the traveller re-dates each entry against its receipt.
          date: req.departDate,
          amountMinor: line.amountMinor,
          currencyId: req.currencyId,
          // VeloExpense (w6-01): `notes`, the column's name — see the select above.
          purpose: line.notes,
          lineItems: {
            create: {
              // Non-null: `mappable` is exactly the lines that have one.
              categoryId: line.category.expenseCategoryId as string,
              // Carried across, not re-derived. The budget line already snapshotted
              // the account when it was priced, and re-reading the category here
              // would let a re-pointing between approval and filing move the
              // actuals away from the budget they are meant to be compared with.
              glAccountId: line.glAccountId,
              amountMinor: line.amountMinor,
              notes: cabinNote(line.kind, line.payload),
            },
          },
        })),
      },
    },
    select: { id: true },
  });

  return { reportId: report.id, expenses: mappable.length, reused: false, skipped };
}
