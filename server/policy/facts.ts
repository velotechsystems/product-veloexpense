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

/**
 * VeloExpense (w4-02d, d67, GAP-AUDIT PE-7): a conversion into the policy currency that
 * could not be made, because no FX rate links the two currencies.
 */
export interface FxGap {
  from: string;
  to: string;
}

/** A line's facts paired with the ids the runner needs to scope + anchor it. */
export interface BuiltLine {
  lineItemId: string;
  categoryId: string;
  facts: LineFacts;
  /** VeloExpense (PE-7): set when this line's amount has no rate into the policy currency.
   *  `lineAmount` is then `null`, and a rule comparing it reports the gap instead. */
  fxGap?: FxGap;
}

export interface BuiltFacts {
  report: ReportFacts;
  lines: BuiltLine[];
  /** VeloExpense (PE-7): set when an amount behind `reportTotal` / `maxLineAmount` has no
   *  rate into the policy currency; both facts are then `null`. */
  reportFxGap?: FxGap;
}

const DAY = ['0', '1', '2', '3', '4', '5', '6'] as const; // getUTCDay(): 0=Sun … 6=Sat

/** Project the loaded report into LINE + REPORT facts. Pure. */
export function buildFacts(src: FactSource): BuiltFacts {
  // Convert a minor amount into the policy currency for numeric amount facts —
  // so thresholds compare in one currency across a multi-currency report. No
  // rate map (or same currency) → raw minor units unchanged.
  //
  // VeloExpense (PE-7, d67): a MISSING rate is `null`, not the raw minor units. ExpenseOS
  // passes the unconverted number through, so ¥10,000 compares as 10,000 against a CAD
  // limit and €40 slips under a $50 one, silently. A null fact matches no numeric
  // comparison, and the runner reports the gap as an INFO finding instead (engine.ts).
  const toPolicyMinor = (amountMinor: bigint, fromCode: string): bigint | null => {
    const to = src.policyCurrency;
    if (!src.fxRates || !to || fromCode === to) return amountMinor;
    const converted = convertMoney({ amountMinor, currencyCode: fromCode }, to, src.fxRates);
    return converted ? converted.amountMinor : null;
  };
  const gapOf = (fromCode: string): FxGap | undefined =>
    src.policyCurrency ? { from: fromCode, to: src.policyCurrency } : undefined;
  const asFact = (minor: bigint | null): number | null => (minor === null ? null : Number(minor));

  const lines: BuiltLine[] = src.lines.map((l) => {
    const inPolicy = toPolicyMinor(l.amountMinor, l.currencyCode);
    return {
      lineItemId: l.lineItemId,
      categoryId: l.categoryId,
      ...(inPolicy === null ? { fxGap: gapOf(l.currencyCode) } : {}),
      facts: {
        lineAmount: asFact(inPolicy),
        lineCurrency: l.currencyCode,
        categoryId: l.categoryId,
        categoryCode: l.categoryCode,
        merchant: l.merchant,
        date: l.date.toISOString().slice(0, 10),
        dayOfWeek: DAY[l.date.getUTCDay()],
        hasReceipt: l.hasReceipt ? 'true' : 'false',
        isFutureDated: l.date > src.now ? 'true' : 'false',
      },
    };
  });

  const categoryIds = [...new Set(src.lines.map((l) => l.categoryId))];
  // Max is taken AFTER converting to the policy currency (comparing raw minor
  // units across currencies would pick the wrong line).
  // VeloExpense (PE-7): one unconvertible line leaves the maximum unknown.
  let reportFxGap: FxGap | undefined;
  const maxLineMinor = src.lines.reduce<bigint | null>((m, l) => {
    const v = toPolicyMinor(l.amountMinor, l.currencyCode);
    if (v === null) reportFxGap ??= gapOf(l.currencyCode);
    if (m === null || v === null) return null;
    return v > m ? v : m;
  }, 0n);
  const totalInPolicy = toPolicyMinor(src.reportTotalMinor, src.reportCurrencyCode);
  if (totalInPolicy === null) reportFxGap ??= gapOf(src.reportCurrencyCode);

  const report: ReportFacts = {
    reportTotal: asFact(totalInPolicy),
    reportCurrency: src.reportCurrencyCode,
    lineCount: src.lines.length,
    maxLineAmount: asFact(maxLineMinor),
    categoryIds,
    submitterJobLevelId: src.submitter.jobLevelId,
    submitterDepartmentId: src.submitter.departmentId,
    submitterLegalEntityId: src.submitter.legalEntityId,
    submitterBusinessUnitId: src.submitter.businessUnitId,
    submitterHomeCurrency: src.submitter.homeCurrency,
  };

  return { report, lines, ...(reportFxGap ? { reportFxGap } : {}) };
}
