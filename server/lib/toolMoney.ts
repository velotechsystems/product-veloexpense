/**
 * Money in a tool result, rendered the way the person asking would see it on screen.
 *
 * **The failure this exists to stop.** A tool names a tRPC procedure, the procedure's payload
 * went to the model verbatim, and nothing anywhere on that path formatted money. Amounts in
 * this codebase live in minor units, so a $5,000 card limit reached the model as `500000`
 * with no signal it was cents — and `runTurn`'s `jsonSafe` replacer then turned the BigInt
 * into the STRING `"500000"`, removing even the type as a hint. There is no way to recover a
 * decimal point from that, so the limit was reported as five hundred thousand dollars.
 * Confidently, with the right digits, which is the worst shape a wrong financial answer can
 * take.
 *
 * It was never a `list_virtual_cards` bug. Every tool that returns an amount had it —
 * budgets and their actuals, reports and their totals, the tax trace, per-diem caps, travel
 * estimates. Hence the fix lives HERE, at the one boundary every tool result crosses
 * (`makeExecutor`), rather than in any of the ~25 procedures.
 *
 * ## Augment, never replace
 *
 * `spendLimitMinor` stays exactly as it was and a sibling `spendLimitDisplay` is added
 * beside it. Replacing the raw value would trade one wrong answer for another: "which card
 * has the most room left?" is arithmetic, and the alternative is the model parsing
 * `$5,000.00` back into a number — group separators, symbol placement, a trailing `$ US` in
 * French. That is precisely the guessing this file removes. So the integer stays
 * authoritative, the string is for reading, and a transform that did not understand a field
 * cannot destroy it.
 *
 * A key that already exists is never overwritten.
 *
 * ## Currency is resolved per FIELD, not per object
 *
 * `formatMoney` needs a currency and an amount does not carry one, so it must come from the
 * payload — and the obvious rule, "use the object's `currency`", is wrong in three places
 * that were checked against the real resolvers rather than assumed:
 *
 *   · `Expense` carries `amountMinor` in `currency` (what the receipt said) AND
 *     `homeAmountMinor` in `homeCurrency` (the entity's home currency, snapshotted at
 *     filing). One row, two currencies.
 *   · `expenses.report`'s `rollup.byCurrency[]` carries `grossMinor` in its OWN `code` and
 *     `convertedMinor` in the rollup's `homeCurrency` — one object, two currencies, and
 *     neither field names its own.
 *   · `expenses.explainPerDiem` names its currency `policyCurrency`, and its
 *     `groups[].appliedRate` overrides that with a `currency` of its own.
 *
 * Formatting a CAD reimbursement with a US `$` is a wrong answer that looks right, which is
 * worse than no answer. So resolution is: a currency field sharing the money field's prefix
 * (`homeAmountMinor` → `homeCurrency`), then the object's own currency, then the nearest
 * ancestor's. **If none resolves, the field is left exactly as it is** — no display sibling,
 * raw minor units visible. Deliberately: a guessed currency is a mis-statement the reader
 * cannot detect, an unformatted integer is at worst unhelpful.
 *
 * ## Why the `Minor` suffix is the trigger
 *
 * Verified, not assumed. All 19 money columns in the schema end in `Minor`
 * (`amountMinor`, `spendLimitMinor`, `rateMinor`, `recoverableQstMinor`, …) and no non-money
 * column does — the near misses are `Decimal` rates and distances (`gstRate`, `fxRate`,
 * `mileageDistance`, `mileageYtdBefore`, `confidence`) and basis points (`thresholdBp`,
 * `percentBp`), none of which is an amount and none of which ends in `Minor`. So the suffix
 * is the trigger.
 *
 * The known exception is receipt-extraction output (`Expense.receipts[].extraction.data`):
 * `total`, `subtotal`, `taxGstHst`, `taxQst`, `taxPst`, `mandatoryGratuity`, `voluntaryTip`
 * and `lineItems[].amount` are money in MAJOR units as JS floats. They are left alone on
 * purpose — reading them as minor units would be wrong by a factor of 100, which is a much
 * worse failure than the one being fixed.
 *
 * No cycle guard: these payloads are `JSON.stringify`-ed one layer up, so a cyclic one would
 * throw there long before it reached a person.
 */

import type { Locale } from '@expenseos/i18n';
import { formatMoney, isKnownCurrency } from '@expenseos/money';

/** Money fields, by the codebase-wide naming convention. */
const MINOR_KEY = /^(.+)Minor$/;

/**
 * Money-field prefixes whose amount is denominated in something other than its own record's
 * currency, and which must therefore never fall back to it.
 *
 *   · `home` — `homeAmountMinor` / `homeTotalMinor` belong to `homeCurrency`, which is
 *     nullable AND frequently outside a resolver's `select`. So for these an ABSENT key
 *     cannot be read as "there is no second currency here": without this entry, an expense
 *     selected with `homeAmountMinor` but not `homeCurrency` would have its CAD payout
 *     formatted with the receipt's USD symbol.
 *   · `converted` — `rollup.byCurrency[].convertedMinor` is in the report's home currency,
 *     which lives on the grandparent, while the object it sits in declares a DIFFERENT
 *     currency (`code`) for its `grossMinor` sibling. Nothing in the object names the right
 *     one, so it stays raw.
 */
const DENOMINATED_ELSEWHERE = new Set(['home', 'converted']);

/**
 * Array keys whose elements must not inherit an ancestor's currency.
 *
 * `explainPerDiem`'s `groups[].candidates[]` are the per-diem rates that did NOT apply, and
 * `CandidateVerdict` in @expenseos/approvals drops `currencyId` while keeping `amountMinor`
 * — so a candidate's denomination is genuinely absent from the payload. Its siblings
 * (`spendMinor`, `capMinor`, `overageMinor`) ARE in `policyCurrency`, so the group itself
 * must keep inheriting; only the candidates stop. Closing this properly means carrying the
 * currency through the trace, which is a change to @expenseos/approvals.
 */
const CURRENCY_BLIND_COLLECTIONS = new Set(['candidates']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  // Dates, Prisma Decimals and Buffers are values, not containers: walking into one would
  // rebuild it as a bag of internals.
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * The amount as an integer of minor units, or null if this is not one.
 *
 * All three representations really occur, and NOT uniformly — which is why the trigger
 * cannot be a type check. `virtualCards.list`, `budgets.list` and `travelRequests.*` return
 * raw Prisma `BigInt`s; `expenses.report`, `expenses.list` and `expenseApprovals.myTasks`
 * `.toString()` theirs; `explainPerDiem` mixes both in one payload, its group totals having
 * been plain `number`s all along. Raw BigInt is the common case here because the executor
 * calls the procedure in-process — `jsonSafe`'s BigInt→string step happens strictly LATER,
 * in `runTurn`, so a transform that only handled strings would format almost nothing.
 *
 * A non-integer number is refused: minor units are integers, so a float is some other
 * quantity.
 */
function toMinorUnits(value: unknown): bigint | null {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return Number.isInteger(value) ? BigInt(value) : null;
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return BigInt(value);
  return null;
}

/** An ISO-4217 code out of whatever shape carried it, or null if it is unusable. */
function codeFrom(value: unknown): string | null {
  if (typeof value === 'string') return isKnownCurrency(value) ? value : null;
  // A `currency` relation — `{ id, code, symbol, … }`. Selected without `code` it tells us
  // nothing, which is a null, not a reason to look at the parent.
  if (isPlainObject(value) && typeof value.code === 'string') {
    return isKnownCurrency(value.code) ? value.code : null;
  }
  return null;
}

/**
 * The currency this object declares for its own amounts.
 *
 * `undefined` means it declares none, so an ancestor's may be inherited. `null` means it
 * declares one that cannot be read, which STOPS the search — an object with a currency of
 * its own is not denominated in its parent's, so falling back would be the guess this file
 * exists to avoid.
 */
function declaredCurrency(obj: Record<string, unknown>): string | null | undefined {
  if ('currencyCode' in obj) return codeFrom(obj.currencyCode);
  if ('currency' in obj) return codeFrom(obj.currency);
  // `rollup` and `entity` in `expenses.report` name their currency `homeCurrency` and carry
  // no generic one; every amount in them is in it. An expense has BOTH, and the generic one
  // above wins there, which is why this is a fallback and not a first check.
  if ('homeCurrency' in obj) return codeFrom(obj.homeCurrency);
  // `explainPerDiem` and the policy-violation `data` blobs name theirs `policyCurrency`.
  if ('policyCurrency' in obj) return codeFrom(obj.policyCurrency);
  // `rollup.byCurrency[]` rows are `{ code, grossMinor, … }` — the code IS the currency.
  // Guarded by `isKnownCurrency` and NOT treated as a blocker, because `code` means many
  // things (a tax jurisdiction, a GL account): a non-currency `code` is ignored outright
  // rather than stopping the search.
  if (typeof obj.code === 'string' && isKnownCurrency(obj.code)) return obj.code;
  // A bare FK with no `currency` include. A UUID is not a code, and the row plainly has a
  // currency of its own, so this blocks rather than inherits.
  if ('currencyId' in obj) return null;
  return undefined;
}

/**
 * Currency keys that would qualify a money key, most specific first.
 *
 * `homeAmountMinor` → `homeAmountCurrency`, `homeAmountCurrencyCode`, `homeCurrency`,
 * `homeCurrencyCode`. `amountMinor` has no prefix and yields nothing, falling through to the
 * object's own currency, which is correct for it.
 */
function qualifiedCurrencyKeys(stem: string): string[] {
  const parts = stem.split(/(?=[A-Z])/);
  const keys: string[] = [];
  for (let n = parts.length - 1; n >= 1; n--) {
    const prefix = parts.slice(0, n).join('');
    keys.push(`${prefix}Currency`, `${prefix}CurrencyCode`);
  }
  return keys;
}

function currencyForField(
  stem: string,
  obj: Record<string, unknown>,
  inherited: string | null,
): string | null {
  for (const key of qualifiedCurrencyKeys(stem)) {
    // Presence claims the field even when the value is unreadable: a null `homeCurrency`
    // means we do not know what the home amount is denominated in, not that it is the
    // record's own currency.
    if (key in obj) return codeFrom(obj[key]);
  }
  const [first = ''] = stem.split(/(?=[A-Z])/);
  if (DENOMINATED_ELSEWHERE.has(first)) return null;
  return inherited;
}

function walk(value: unknown, locale: Locale, inherited: string | null): unknown {
  if (Array.isArray(value)) return value.map((item) => walk(item, locale, inherited));
  if (!isPlainObject(value)) return value;

  const declared = declaredCurrency(value);
  const scope = declared === undefined ? inherited : declared;

  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    out[key] = walk(child, locale, CURRENCY_BLIND_COLLECTIONS.has(key) ? null : scope);
  }

  for (const [key, child] of Object.entries(value)) {
    const stem = MINOR_KEY.exec(key)?.[1];
    if (!stem) continue;
    const amountMinor = toMinorUnits(child);
    if (amountMinor === null) continue;
    const currencyCode = currencyForField(stem, value, scope);
    if (!currencyCode) continue;
    const displayKey = `${stem}Display`;
    if (displayKey in value) continue;
    try {
      /**
       * The ISO code is appended, and it is not decoration.
       *
       * `formatMoney` renders a NARROW symbol, so CAD and USD both come out as "$12.34".
       * The UI can afford that because it prints the code in the adjacent cell; a tool
       * payload has no adjacent cell, and `expenses.report`'s `rollup.byCurrency[]`
       * deliberately carries several currencies side by side. Handing a model "$12.34" for
       * a Canadian amount next to "$12.34" for an American one reintroduces exactly the
       * guessing this transform exists to remove — and a guess that reads as a fact.
       */
      const shown = formatMoney({ amountMinor, currencyCode }, { locale });
      out[displayKey] = `${shown} ${currencyCode}`;
    } catch {
      // `formatMoney` throws past Number.MAX_SAFE_INTEGER rather than render a truncated
      // figure. Losing one display string there is right; losing the whole tool call — and
      // in the chat loop the unrelated reads answered alongside it — would not be.
    }
  }
  return out;
}

/**
 * Add a locale-formatted display string beside every money field in a tool result.
 *
 * The locale is required rather than defaulted on purpose. `formatMoney` falls back to
 * `en-US`, so an omitted locale hands every French-Canadian reader `$10,799.00` where they
 * expect `10 799,00 $` — and `10,799` reads to them as ten-point-seven-nine-nine, moving the
 * apparent magnitude by three orders of magnitude. A defaulted locale is the same class of
 * bug as the raw minor units, so every surface has to say who is reading.
 */
export function withMoneyDisplay(result: unknown, locale: Locale): unknown {
  return walk(result, locale, null);
}
