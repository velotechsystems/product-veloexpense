import { TRPCError } from '@trpc/server';

/**
 * A refusal the browser can TRANSLATE.
 *
 * Every deliberate refusal in this codebase is a `TRPCError` with an English `message`,
 * and `safeMessage` (trpc.ts) passes that sentence to the screen verbatim. That is right
 * for the log and wrong for an FR-CA reader, who gets a French heading followed by an
 * English apology. Until now the fix has been per surface — `PersonalApiKey` keys its
 * sentence off the error CODE — which only works while a code maps to one sentence.
 *
 * A `Refusal` rides in the error's `cause` and names a CATALOG KEY plus the values the
 * sentence needs. `errorFormatter` copies it onto `data.refusal`, and the client's
 * `useRefusalText` renders `t(key, params)` when the catalog has the key, falling back to
 * the English `message` when it does not. The message stays exactly as written, so logs,
 * tests and every surface that has not adopted the helper are unchanged.
 *
 * KEYS ARE FULL PATHS under the `refusals` catalog area, not namespace-relative: the same
 * refusal is rendered by components bound to `expenses`, `expenses.statement` and
 * `admin.fxRates`, and a key that depended on the caller's namespace would resolve in one
 * and not the others. `refusal.test.ts` asserts every key here exists in BOTH locales,
 * which is the check `check-used-keys` cannot do for a key composed at runtime.
 */
export const REFUSAL_KEYS = {
  /** An amount, document or field write on a report that is not DRAFT / RETURNED. */
  reportNotEditable: 'refusals.expenses.reportNotEditable',
  /** Attaching a document to a report that has been decided. */
  documentsClosed: 'refusals.expenses.documentsClosed',
  /** Re-running extraction on a report that has been decided. */
  documentsRereadClosed: 'refusals.expenses.documentsRereadClosed',
  /** Paid tax larger than the gross it was paid on. `{ tax, amount }`. */
  taxExceedsAmount: 'refusals.expenses.taxExceedsAmount',
  /** The same, naming the expense, for the report-level check at submit.
   *  `{ merchant, tax, amount }`. */
  taxExceedsAmountAt: 'refusals.expenses.taxExceedsAmountAt',
  /** The FX override on a report that is not SUBMITTED. */
  fxOverrideNotSubmitted: 'refusals.fx.overrideNotSubmitted',
  /** A hand-typed rate outside (0, max]. `{ max }`. */
  fxRateOutOfBounds: 'refusals.fx.rateOutOfBounds',
  /** An override rate more than `band`× from the daily rate.
   *  `{ rate, band, reference, from, home }`. */
  fxRateFarFromDaily: 'refusals.fx.rateFarFromDaily',
  /** A hand-entered rate more than `bound`% from the pair's last recorded row (#510).
   *  `{ base, quote, prior, on, rate, deviation, bound }` — `deviation` is already
   *  rounded to one decimal and `on` is the prior row's ISO date, so the sentence is
   *  the same figures in either language. */
  fxRateFarFromPrior: 'refusals.fx.rateFarFromPrior',
  // VeloExpense: ExpenseOS's six `netsuite*` refusals (adopt unmapped, reference in use /
  // still active, the three reconcile states and a concurrent change) are not here yet. They
  // arrive, under vendor-neutral names, with the ledger integration in Wave 5:
  // scripts/check-vendor-neutral.mjs keeps vendor names out of everything but the adapter.
  /** An expense category's NetSuite override naming a row the synced mirror no longer
   *  has. Stays `NOT_FOUND` — the code alone cannot tell it from a missing category,
   *  which is why the drawer reads the key. Takes no ICU arguments. */
  expenseCategoryNsMissing: 'refusals.expenseCategories.nsCategoryMissing',
  /** The same override naming a row NetSuite has made inactive. Stays `BAD_REQUEST`,
   *  which zod validation also returns. Takes no ICU arguments. */
  expenseCategoryNsInactive: 'refusals.expenseCategories.nsCategoryInactive',
  /** VeloExpense: a new expense past the plan's yearly expense cap (lib/billing/caps.ts),
   *  refused by a ported procedure. `{ limit }`. */
  expenseLimitReached: 'refusals.billing.expenseLimitReached',
  /** eos batch 4 (#582): an admin edit to a field Google Workspace owns, for a person linked
   *  to Google while directory sync is on — the next sync would undo it. `{ fields }`. */
  peopleDirectoryManaged: 'refusals.people.directoryManaged',
  /** f75: a person's country that is not an assigned ISO-3166-1 alpha-2 code (e.g. "XX").
   *  BAD_REQUEST. `{ country }`. */
  peopleCountryUnknown: 'refusals.people.countryUnknown',
  /** A point dropped on a mileage route where Google has no road and no address to turn it
   *  into a place. The drop is undone. Takes no ICU arguments. */
  mileageNoRoadNear: 'refusals.mileage.noRoadNear',
  /** A dropped point could not be turned into a place because the Maps key may not call
   *  the API(s) that do it. `{ apis }` is the console names of the refused APIs ("Roads
   *  API, Geocoding API") — proper nouns, never Google's own text. */
  mileageDragApisUnavailable: 'refusals.mileage.dragApisUnavailable',
  /** The route lookup carried a dragged point (`via`) and Google would not route through
   *  its place ID (spec TR-13 check 1). BAD_REQUEST; the modal reads this KEY, not the
   *  code, to retry the newest Roads point once through Geocoding. The sentence is what
   *  is shown when it does not retry, or the retry is refused too. No ICU arguments. */
  mileageViaPlaceRefused: 'refusals.mileage.viaPlaceRefused',
} as const;

export type RefusalKey = (typeof REFUSAL_KEYS)[keyof typeof REFUSAL_KEYS];
/** ICU arguments for the sentence. Strings and numbers only — it crosses the wire. */
export type RefusalParams = Record<string, string | number>;
/**
 * One translated DETAIL LINE under the headline sentence.
 *
 * A refusal that has to enumerate something — "4 expenses in `Expense.categoryId`, 1 report
 * in `Report.locationId`" — cannot say it in one sentence without building that sentence on
 * the server, in one language. A row is the enumerated unit: its own catalog key and its own
 * ICU arguments, rendered by the client in the reader's language like the headline is.
 *
 * `key` is a full catalog path, as the headline's is, but it is deliberately a plain `string`
 * and NOT a `RefusalKey`. A row's sentence belongs in the catalog its subject already lives
 * in — the NetSuite reference delete rows name keys under `netsuite.reference.deleteTable.*`
 * in `netsuite.json` — rather than being copied into the `refusals` area just to satisfy a
 * union. The cost is real and worth naming: `refusal.test.ts` asserts both-locale coverage
 * for `REFUSAL_KEYS` and can assert nothing about a row key, so whoever emits rows owes that
 * coverage where their own catalog is tested.
 */
export type RefusalRow = { key: string; params?: RefusalParams };
/** What the browser receives on `error.data.refusal`. */
export type RefusalData = { key: RefusalKey; params?: RefusalParams; rows?: RefusalRow[] };

/**
 * The `cause` of a translatable refusal.
 *
 * Extends `Error` on purpose: `TRPCError` keeps an `Error` cause as-is and copies a plain
 * object into an anonymous one, which would still work but would lose the `instanceof`
 * the formatter keys on.
 */
export class Refusal extends Error {
  readonly key: RefusalKey;
  readonly params: RefusalParams | undefined;
  readonly rows: RefusalRow[] | undefined;
  constructor(key: RefusalKey, params?: RefusalParams, rows?: RefusalRow[]) {
    super(key);
    this.name = 'Refusal';
    this.key = key;
    this.params = params;
    this.rows = rows;
  }
}

type RefusalCode = 'BAD_REQUEST' | 'NOT_FOUND' | 'PRECONDITION_FAILED' | 'CONFLICT' | 'FORBIDDEN';

/**
 * A `TRPCError` that carries a catalog key beside its English message.
 *
 *   throw refusal('BAD_REQUEST', REFUSAL_KEYS.reportNotEditable, 'Report is not editable.');
 *
 * The message is what tests match and what the log shows; the key is what the reader
 * sees, in their language.
 *
 * `rows` is the optional fifth argument: N translated detail lines under that sentence
 * (see `RefusalRow`). A refusal that enumerates — "and here is every place that still
 * points at it" — passes them; every other refusal ignores the parameter and is unchanged.
 * A caller that wants rows but no ICU arguments passes `undefined` for `params`:
 *
 *   throw refusal('CONFLICT', REFUSAL_KEYS.netsuiteReferenceInUse, 'Still in use.',
 *     undefined, rows);
 */
export function refusal(
  code: RefusalCode,
  key: RefusalKey,
  message: string,
  params?: RefusalParams,
  rows?: RefusalRow[],
): TRPCError {
  return new TRPCError({ code, message, cause: new Refusal(key, params, rows) });
}

/** The refusal on an error, if it carries one. Used by the formatter and by router tests. */
export function refusalData(error: unknown): RefusalData | null {
  const cause = (error as { cause?: unknown } | null)?.cause;
  if (!(cause instanceof Refusal)) return null;
  // Absent properties are OMITTED, not set to `undefined` — the rule the `params` ternary
  // this replaced already kept. Router tests assert the whole object (`toEqual({ key })`),
  // and this value is serialised onto `data.refusal` rather than read in place.
  const data: RefusalData = { key: cause.key };
  if (cause.params !== undefined) data.params = cause.params;
  if (cause.rows !== undefined) data.rows = cause.rows;
  return data;
}
