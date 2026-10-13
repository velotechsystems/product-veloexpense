// Ported from ExpenseOS `apps/web/src/server/policy/facts.ts` (550b2945), w4-02a (d63). Each adaptation is
// marked "VeloExpense:"; travel, which is out of VeloExpense's scope, is the main one.
/**
 * Policy-engine fact model (v2). Policy owns its OWN flat fact enums — LINE
 * (per line item) and REPORT (per report) — deliberately separate from the
 * approvals engine's routing `PREDICATE_FIELDS`, so per-line rules can attribute
 * a violation to the one line that matched (no cross-line false positives). Both
 * schemas are built from the shared `@expenseos/predicate` primitive.
 *
 * Booleans are encoded as the strings 'true'/'false' (the primitive's convention).
 */
import { convertMoney } from '@expenseos/money';
import { type FactValue, makePredicateSchema, type Predicate } from '@expenseos/predicate';

export const LINE_FIELDS = [
  'lineAmount',
  'lineCurrency',
  'categoryId',
  'categoryCode',
  'merchant',
  'date',
  'dayOfWeek',
  'hasReceipt',
  'isFutureDated',
] as const;
export type LineField = (typeof LINE_FIELDS)[number];

export const REPORT_FIELDS = [
  'reportTotal',
  'reportCurrency',
  'lineCount',
  'maxLineAmount',
  'categoryIds',
  'submitterJobLevelId',
  'submitterDepartmentId',
  'submitterLegalEntityId',
  'submitterBusinessUnitId',
  'submitterHomeCurrency',
  // VeloExpense: ExpenseOS's `travelApprovedTotal` (the linked travel request's approved
  // total) is not a field here — travel is out of VeloExpense's scope.
] as const;
export type ReportField = (typeof REPORT_FIELDS)[number];

export const linePredicateSchema = makePredicateSchema(LINE_FIELDS);
export const reportPredicateSchema = makePredicateSchema(REPORT_FIELDS);

export type LineFacts = Partial<Record<LineField, FactValue>>;
export type ReportFacts = Partial<Record<ReportField, FactValue>>;
export type LinePredicate = Predicate<LineField>;
export type ReportPredicate = Predicate<ReportField>;

/** One flattened line item + its parent-expense context, in the shape the fact
 *  builder needs. `amountMinor` is compared as a base-currency number by numeric
 *  predicates (the primitive requires numbers), so `lineAmount` is emitted as a
 *  Number of minor units in the line's own currency — an admin authoring an
 *  amount threshold works in minor units, matching the routing `amount` fact. */
export interface FactLine {
  lineItemId: string;
  categoryId: string;
  categoryCode: string;
  amountMinor: bigint;
  currencyCode: string;
  merchant: string | null;
  date: Date;
  hasReceipt: boolean;
}

export interface FactSource {
  now: Date;
  reportTotalMinor: bigint;
  reportCurrencyCode: string;
  submitter: {
    jobLevelId: string | null;
    departmentId: string | null;
    legalEntityId: string | null;
    businessUnitId: string | null;
    homeCurrency: string | null;
  };
  lines: FactLine[];
  /** When provided, `lineAmount` / `maxLineAmount` / `reportTotal` are converted
   *  into `policyCurrency` (via `fxRates`, keys `from->to`) so numeric amount
   *  predicates compare in ONE currency — otherwise a multi-currency report
   *  compares incommensurable minor units. Omit (tests / single-currency) to
   *  keep raw same-currency minor units. */
  fxRates?: Map<string, string>;
  policyCurrency?: string;
}

/** A line's facts paired with the ids the runner needs to scope + anchor it. */
export interface BuiltLine {
  lineItemId: string;
  categoryId: string;
  facts: LineFacts;
}

export interface BuiltFacts {
  report: ReportFacts;
  lines: BuiltLine[];
}

const DAY = ['0', '1', '2', '3', '4', '5', '6'] as const; // getUTCDay(): 0=Sun … 6=Sat

/** Project the loaded report into LINE + REPORT facts. Pure. */
export function buildFacts(src: FactSource): BuiltFacts {
  // Convert a minor amount into the policy currency for numeric amount facts —
  // so thresholds compare in one currency across a multi-currency report. No
  // rate map (or same currency, or missing rate) → raw minor units unchanged.
  const toPolicyMinor = (amountMinor: bigint, fromCode: string): bigint => {
    const to = src.policyCurrency;
    if (!src.fxRates || !to || fromCode === to) return amountMinor;
    const converted = convertMoney({ amountMinor, currencyCode: fromCode }, to, src.fxRates);
    return converted ? converted.amountMinor : amountMinor;
  };

  const lines: BuiltLine[] = src.lines.map((l) => ({
    lineItemId: l.lineItemId,
    categoryId: l.categoryId,
    facts: {
      lineAmount: Number(toPolicyMinor(l.amountMinor, l.currencyCode)),
      lineCurrency: l.currencyCode,
      categoryId: l.categoryId,
      categoryCode: l.categoryCode,
      merchant: l.merchant,
      date: l.date.toISOString().slice(0, 10),
      dayOfWeek: DAY[l.date.getUTCDay()],
      hasReceipt: l.hasReceipt ? 'true' : 'false',
      isFutureDated: l.date > src.now ? 'true' : 'false',
    },
  }));

  const categoryIds = [...new Set(src.lines.map((l) => l.categoryId))];
  // Max is taken AFTER converting to the policy currency (comparing raw minor
  // units across currencies would pick the wrong line).
  const maxLineMinor = src.lines.reduce((m, l) => {
    const v = toPolicyMinor(l.amountMinor, l.currencyCode);
    return v > m ? v : m;
  }, 0n);

  const report: ReportFacts = {
    reportTotal: Number(toPolicyMinor(src.reportTotalMinor, src.reportCurrencyCode)),
    reportCurrency: src.reportCurrencyCode,
    lineCount: src.lines.length,
    maxLineAmount: Number(maxLineMinor),
    categoryIds,
    submitterJobLevelId: src.submitter.jobLevelId,
    submitterDepartmentId: src.submitter.departmentId,
    submitterLegalEntityId: src.submitter.legalEntityId,
    submitterBusinessUnitId: src.submitter.businessUnitId,
    submitterHomeCurrency: src.submitter.homeCurrency,
  };

  return { report, lines };
}
