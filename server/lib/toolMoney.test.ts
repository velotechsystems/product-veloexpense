import { describe, expect, it } from 'vitest';
import { withMoneyDisplay } from './toolMoney';

/**
 * Money in a tool result.
 *
 * The bug: `list_virtual_cards` reported a $5,000 limit as `500000`. Nothing on the tool path
 * formatted money, so the model got minor units with no signal they were cents — and
 * `jsonSafe` in `runTurn` then stringified the BigInt, taking away even the type. Every one
 * of the ~25 tools that returns an amount had it.
 *
 * Three things these tests are really about, in order of how expensive they are to get
 * wrong:
 *
 *   · **A guessed currency is worse than no currency.** Real payloads put two currencies in
 *     one object — an expense's `amountMinor` in `currency` and its `homeAmountMinor` in
 *     `homeCurrency`; a rollup row's `grossMinor` in its own `code` and `convertedMinor` in
 *     the parent's home currency. Formatting the second with the first prints a CAD payout
 *     with a US `$`, which is a wrong answer that looks right.
 *   · **The locale has to be the reader's.** `formatMoney` defaults to `en-US`, so a call
 *     that omits the locale gives every French-Canadian reader `$10,799.00` where they
 *     expect `10 799,00 $` — and `10,799` reads to them as ten-point-seven-nine-nine.
 *   · **The raw value survives.** The model has to be able to add these up.
 *
 * The payload shapes below are the real ones, taken from the resolvers the tools name — not
 * invented, because the field names and the nesting ARE the contract this walks.
 */

/** `virtualCards.list` — raw BigInt, currency as a nested relation, no `currencyId`. */
const CARD = {
  id: 'c-1',
  last4: '4242',
  status: 'ACTIVE',
  spendLimitMinor: 500_000n,
  spendLimitInterval: 'MONTHLY',
  currency: { code: 'USD', symbol: '$' },
};

/**
 * The group separator fr-CA actually gets: U+00A0 today, U+202F on some ICU builds — never a
 * plain ASCII space. Written as escapes rather than typed literals, because a literal that
 * silently became a normal space would make every assertion below vacuous.
 */
const NBSP = /[\u00A0\u202F]/;

const at = (value: unknown, path: string): unknown =>
  path
    ? path
        .split('.')
        .reduce<unknown>((node, key) => (node as Record<string, unknown>)?.[key], value)
    : value;

/** Whether a key EXISTS — the whole point of "left exactly as it is" is that it does not. */
const has = (value: unknown, path: string, key: string): boolean =>
  key in (at(value, path) as object);

describe('the reported case', () => {
  it('renders a card spend limit as money instead of minor units', () => {
    const out = withMoneyDisplay({ items: [CARD], adminView: false }, 'en');
    expect(at(out, 'items.0.spendLimitDisplay')).toBe('$5,000.00 USD');
  });

  it('keeps the raw minor units, unchanged and still a BigInt', () => {
    /**
     * Augment rather than replace. "Which card has the most room left?" is arithmetic, and
     * the alternative is the model parsing `$5,000.00` back into a number — group
     * separators, symbol placement, a trailing `$ US` in French. That is the guessing this
     * whole change removes.
     */
    const out = withMoneyDisplay({ items: [CARD], adminView: false }, 'en');
    expect(at(out, 'items.0.spendLimitMinor')).toBe(500_000n);
  });

  it('leaves every other field exactly as it was', () => {
    const out = withMoneyDisplay({ items: [CARD], adminView: false }, 'en');
    expect(at(out, 'items.0')).toMatchObject({
      id: 'c-1',
      last4: '4242',
      status: 'ACTIVE',
      spendLimitInterval: 'MONTHLY',
    });
    expect(at(out, 'adminView')).toBe(false);
  });

  it('adds nothing for a card with no limit set', () => {
    // `spendLimitMinor` is nullable; `$0.00` would be a different and wrong statement.
    const out = withMoneyDisplay({ items: [{ ...CARD, spendLimitMinor: null }] }, 'en');
    expect(has(out, 'items.0', 'spendLimitDisplay')).toBe(false);
  });
});

describe('the reader’s locale', () => {
  it('renders fr-CA the French-Canadian way, not the American way', () => {
    /**
     * The separators are the point, not the symbol. `10,799` is ten-point-seven-nine-nine
     * to this reader, so an American group separator misstates the figure by three orders of
     * magnitude — the same class of error as the raw minor units this change exists to fix.
     */
    const display = String(at(withMoneyDisplay([CARD], 'fr-CA'), '0.spendLimitDisplay'));
    // Grouped with a no-break space, and a comma for the decimal mark.
    expect(display).toMatch(new RegExp(`^5${NBSP.source}000,00`));
    // And specifically NOT a plain ASCII space — Intl emits U+00A0 or U+202F here, and a
    // test that matched ' ' would be asserting nothing about the separator at all.
    expect(display).not.toMatch(/^5 000/);
    expect(display).not.toContain('5,000.00');
  });

  it('gives the two locales different strings for the same amount', () => {
    /**
     * The assertion that catches a hard-coded locale. A test that only checked fr-CA
     * rendered *something* would pass on a build that returned English to everyone.
     */
    const en = at(withMoneyDisplay([CARD], 'en'), '0.spendLimitDisplay');
    const frCA = at(withMoneyDisplay([CARD], 'fr-CA'), '0.spendLimitDisplay');
    expect(en).toBe('$5,000.00 USD');
    expect(frCA).not.toBe(en);
  });
});

describe('finding the currency', () => {
  it('reads a `currency` relation’s code', () => {
    const out = withMoneyDisplay({ totalMinor: 1234n, currency: { code: 'CAD' } }, 'en');
    expect(at(out, 'totalDisplay')).toBe('$12.34 CAD');
  });

  it('reads a bare `currencyCode` string', () => {
    // `budgets.list`'s `unattributed[]` rows, which carry the code as a sibling string.
    const out = withMoneyDisplay({ currencyCode: 'USD', spentMinor: 1234n }, 'en');
    expect(at(out, 'spentDisplay')).toBe('$12.34 USD');
  });

  it('reads a `currency` that is itself the code', () => {
    // `explainTax`'s root, where `currency` is `expense.currency.code`, not the relation.
    const out = withMoneyDisplay({ currency: 'USD', totalMinor: 1234n }, 'en');
    expect(at(out, 'totalDisplay')).toBe('$12.34 USD');
  });

  it('inherits the currency from a parent when the child declares none', () => {
    /**
     * `explainTax` again: one currency at the root, and the amounts spread across nested
     * objects that carry none.
     */
    const out = withMoneyDisplay(
      {
        currency: 'CAD',
        totalMinor: '11500',
        taxCharged: { gstHstMinor: '500', qstMinor: '998', pstMinor: '0' },
        lines: [{ label: 'Dinner', amountMinor: '10002' }],
      },
      'en',
    );
    expect(at(out, 'totalDisplay')).toBe('$115.00 CAD');
    expect(at(out, 'taxCharged.gstHstDisplay')).toBe('$5.00 CAD');
    expect(at(out, 'taxCharged.qstDisplay')).toBe('$9.98 CAD');
    expect(at(out, 'lines.0.amountDisplay')).toBe('$100.02 CAD');
  });

  it('lets a child’s own currency win over its parent’s', () => {
    // A CAD report containing a USD receipt. Inheriting here would restate the claim.
    const out = withMoneyDisplay(
      { currencyCode: 'CAD', expenses: [{ amountMinor: 5000n, currencyCode: 'USD' }] },
      'en',
    );
    expect(at(out, 'expenses.0.amountDisplay')).toBe('$50.00 USD');
  });

  it('formats a zero-exponent currency without inventing decimals', () => {
    // ¥500 is 500 yen, not ¥5.00 — the exponent comes from the currency definition.
    const out = withMoneyDisplay({ amountMinor: 500n, currencyCode: 'JPY' }, 'en');
    expect(at(out, 'amountDisplay')).toBe('¥500 JPY');
  });
});

describe('when the currency cannot be determined', () => {
  it('leaves the amount untouched and adds no display field at all', () => {
    /**
     * The rule the whole file turns on. A `$` in front of a CAD figure is a wrong answer the
     * reader cannot detect; a bare integer is at worst unhelpful.
     */
    const out = withMoneyDisplay({ totalMinor: 1234n }, 'en') as Record<string, unknown>;
    expect(out.totalMinor).toBe(1234n);
    expect('totalDisplay' in out).toBe(false);
  });

  it('does not treat a `currencyId` FK as a currency, and does not inherit past it', () => {
    // A UUID is not an ISO-4217 code — and a row with its own currencyId is not denominated
    // in its parent's currency either, so this must not fall back.
    const out = withMoneyDisplay(
      { currencyCode: 'CAD', rows: [{ amountMinor: 1234n, currencyId: '0192-abc' }] },
      'en',
    );
    expect(has(out, 'rows.0', 'amountDisplay')).toBe(false);
  });

  it('does not fall back to a parent when the child’s own currency is null', () => {
    const out = withMoneyDisplay(
      { currencyCode: 'CAD', rows: [{ amountMinor: 1234n, currencyCode: null }] },
      'en',
    );
    expect(has(out, 'rows.0', 'amountDisplay')).toBe(false);
  });

  it('does not fall back when a `currency` relation was selected without its code', () => {
    const out = withMoneyDisplay(
      { currencyCode: 'CAD', rows: [{ amountMinor: 1234n, currency: { id: 'cur-1' } }] },
      'en',
    );
    expect(has(out, 'rows.0', 'amountDisplay')).toBe(false);
  });

  /**
   * There is deliberately NO test here for an unrecognised currency code (`XXZ`).
   *
   * One was written and then deleted, because it could not fail. `isKnownCurrency` in
   * `codeFrom` refuses the code, but `formatMoney` ALSO throws on it and the walk's
   * `catch` swallows that — so with the guard removed the observable result is identical:
   * no display field, raw amount kept. Verified by mutation. A test that passes the same
   * way with the rule present and absent is worse than no test, because it reads as
   * coverage.
   *
   * The guard is kept in the source as belt-and-braces (control flow through an exception
   * is not something to rely on), and the OBSERVABLE half of the same idea — a `code` that
   * is not a currency must not be mistaken for one, and must not block the parent's — is
   * covered by 'ignores a `code` that is not a currency' below, which does fail when that
   * check is removed.
   */
});

describe('two currencies in one object', () => {
  it('formats `homeAmountMinor` with `homeCurrency`, not with `currencyCode`', () => {
    /**
     * The trap. An expense filed in USD is reimbursed in the entity's home currency, and
     * both amounts sit on the same row with only one of them naming its denomination.
     */
    const out = withMoneyDisplay(
      { amountMinor: 5000n, currencyCode: 'USD', homeAmountMinor: 6850n, homeCurrency: 'CAD' },
      'en',
    );
    expect(at(out, 'amountDisplay')).toBe('$50.00 USD');
    expect(at(out, 'homeAmountDisplay')).toBe('$68.50 CAD');
  });

  it('leaves `homeAmountMinor` alone when `homeCurrency` is null', () => {
    const out = withMoneyDisplay(
      { amountMinor: 5000n, currencyCode: 'USD', homeAmountMinor: 6850n, homeCurrency: null },
      'en',
    ) as Record<string, unknown>;
    expect('homeAmountDisplay' in out).toBe(false);
    expect(out.homeAmountMinor).toBe(6850n);
  });

  it('leaves `homeAmountMinor` alone when `homeCurrency` was not selected at all', () => {
    /**
     * `homeCurrency` is nullable AND often outside a resolver's `select`, so an absent key
     * cannot be read as "there is no second currency here". Without the explicit home rule
     * this would silently format a CAD payout with a US symbol.
     */
    const out = withMoneyDisplay(
      { amountMinor: 5000n, currencyCode: 'USD', homeAmountMinor: 6850n },
      'en',
    ) as Record<string, unknown>;
    expect('homeAmountDisplay' in out).toBe(false);
    expect(out.homeAmountMinor).toBe(6850n);
  });

  it('reads the rollup’s `homeCurrency` for the amounts that have no other source', () => {
    /**
     * `expenses.report`'s `rollup` names its currency `homeCurrency` and carries no generic
     * one, so `recoverableTotalMinor` would otherwise inherit the REPORT's currency — which
     * for a US-filed report is the wrong one.
     */
    const out = withMoneyDisplay(
      {
        currency: { code: 'USD' },
        totalMinor: '30000',
        rollup: { homeCurrency: 'CAD', homeTotalMinor: '42550', recoverableTotalMinor: '1900' },
      },
      'en',
    );
    expect(at(out, 'totalDisplay')).toBe('$300.00 USD');
    expect(at(out, 'rollup.homeTotalDisplay')).toBe('$425.50 CAD');
    expect(at(out, 'rollup.recoverableTotalDisplay')).toBe('$19.00 CAD');
  });

  it('reads a rollup row’s own `code`, and leaves its converted twin alone', () => {
    /**
     * `rollup.byCurrency[]` is `{ code, grossMinor, convertedMinor, rate }`: the gross is in
     * `code`, the converted figure is in the grandparent's home currency, and neither field
     * names its own. Formatting `convertedMinor` with `code` would report a CAD equivalent
     * as US dollars — so it stays raw.
     */
    const out = withMoneyDisplay(
      {
        rollup: {
          homeCurrency: 'CAD',
          byCurrency: [{ code: 'USD', grossMinor: '30000', convertedMinor: '42550', rate: '1.42' }],
        },
      },
      'en',
    );
    expect(at(out, 'rollup.byCurrency.0.grossDisplay')).toBe('$300.00 USD');
    expect(has(out, 'rollup.byCurrency.0', 'convertedDisplay')).toBe(false);
    expect(at(out, 'rollup.byCurrency.0.convertedMinor')).toBe('42550');
  });

  it('ignores a `code` that is not a currency, without blocking the search', () => {
    /**
     * `code` means many things — a tax jurisdiction, a GL account. It is only read as a
     * currency when `isKnownCurrency` accepts it, and a non-currency one must not stop the
     * parent's currency from being inherited.
     */
    const out = withMoneyDisplay(
      { currencyCode: 'CAD', jurisdiction: { code: 'QC-QST', amountMinor: 1234n } },
      'en',
    );
    expect(at(out, 'jurisdiction.amountDisplay')).toBe('$12.34 CAD');
  });
});

describe('a per-diem explanation', () => {
  /** `explainPerDiem` — currency named `policyCurrency`, group totals as plain numbers. */
  const PER_DIEM = {
    reportId: 'r-1',
    enabled: true,
    policyCurrency: 'CAD',
    totalOverageMinor: 2500,
    groups: [
      {
        date: '2026-08-01',
        place: 'Montreal',
        category: 'Meals',
        spendMinor: 10_000,
        capMinor: 7500,
        halvedForTripEdge: false,
        overageMinor: 2500,
        appliedRate: { city: 'Montreal', amountMinor: '7500', currency: 'CAD' },
        candidates: [{ city: 'Toronto', amountMinor: '9000', rejection: 'CITY_MISMATCH' }],
      },
    ],
  };

  it('reads `policyCurrency` for the group totals, which are plain numbers', () => {
    const out = withMoneyDisplay(PER_DIEM, 'en');
    expect(at(out, 'totalOverageDisplay')).toBe('$25.00 CAD');
    expect(at(out, 'groups.0.spendDisplay')).toBe('$100.00 CAD');
    expect(at(out, 'groups.0.capDisplay')).toBe('$75.00 CAD');
    expect(at(out, 'groups.0.overageDisplay')).toBe('$25.00 CAD');
  });

  it('uses the applied rate’s own currency, which may not be the policy’s', () => {
    /** A rate for a US city under a CAD policy. The rate's own `currency` has to win. */
    const usd = {
      policyCurrency: 'CAD',
      groups: [{ appliedRate: { city: 'NYC', amountMinor: '9000', currency: 'USD' } }],
    };
    expect(at(withMoneyDisplay(usd, 'en'), 'groups.0.appliedRate.amountDisplay')).toBe(
      '$90.00 USD',
    );
  });

  it('leaves the REJECTED candidates raw, because their currency is genuinely absent', () => {
    /**
     * `CandidateVerdict` keeps `amountMinor` and drops `currencyId`, so a candidate rate's
     * denomination is nowhere in the payload. It is NOT safe to assume the policy currency:
     * a rate for another city can be in another currency, and that is the case somebody
     * would be asking about.
     */
    const out = withMoneyDisplay(PER_DIEM, 'en');
    expect(has(out, 'groups.0.candidates.0', 'amountDisplay')).toBe(false);
    expect(at(out, 'groups.0.candidates.0.amountMinor')).toBe('9000');
  });
});

describe('a budget listing', () => {
  /** `budgets.list` — two different currency mechanisms in one payload, all raw BigInts. */
  const BUDGETS = {
    fiscalYear: { id: 'fy-1', label: 'FY26' },
    unattributed: [{ currencyCode: 'USD', spentMinor: 12_300n, committedMinor: 0n }],
    unconvertedCount: 1,
    budgets: [
      {
        id: 'b-1',
        currencyId: 'cur-1',
        currency: { id: 'cur-1', code: 'CAD', symbol: '$', precision: 2 },
        thresholds: [{ id: 't-1', thresholdBp: 8000 }],
        periods: [
          { monthIndex: 0, amountMinor: 100_000n, spentMinor: 25_000n, committedMinor: 0n },
        ],
        totals: { amountMinor: 1_200_000n, spentMinor: 25_000n, committedMinor: 0n },
      },
    ],
  };

  it('resolves a sibling `currencyCode` and an ancestor `currency.code` in the same payload', () => {
    const out = withMoneyDisplay(BUDGETS, 'en');
    // Sibling bare string.
    expect(at(out, 'unattributed.0.spentDisplay')).toBe('$123.00 USD');
    // Ancestor relation object — two levels up from `periods[]`, and note `currencyId` is
    // present on the same object and must not shadow it.
    expect(at(out, 'budgets.0.periods.0.amountDisplay')).toBe('$1,000.00 CAD');
    expect(at(out, 'budgets.0.periods.0.spentDisplay')).toBe('$250.00 CAD');
    expect(at(out, 'budgets.0.totals.amountDisplay')).toBe('$12,000.00 CAD');
    expect(at(out, 'budgets.0.totals.committedDisplay')).toBe('$0.00 CAD');
  });

  it('leaves the basis-point threshold alone', () => {
    // 8000bp is 80%, not $80.00 — and it does not end in `Minor`.
    expect(has(withMoneyDisplay(BUDGETS, 'en'), 'budgets.0.thresholds.0', 'thresholdDisplay')).toBe(
      false,
    );
  });
});

describe('what reaches the formatter', () => {
  it('accepts the raw BigInt the procedure returns', () => {
    /**
     * The ordering matters: the executor calls the procedure in-process, so nothing has
     * serialized it yet, and `jsonSafe`'s BigInt→string step happens strictly LATER in
     * `runTurn`. A transform that only handled strings would format almost nothing —
     * `virtualCards.list`, `budgets.list` and `travelRequests.*` all return raw BigInts.
     */
    const out = withMoneyDisplay({ amountMinor: 123_456_789n, currencyCode: 'USD' }, 'en');
    expect(at(out, 'amountDisplay')).toBe('$1,234,567.89 USD');
  });

  it('accepts a decimal string, for the resolvers that stringify their own totals', () => {
    const out = withMoneyDisplay({ amountMinor: '-4200', currencyCode: 'USD' }, 'en');
    expect(at(out, 'amountDisplay')).toBe('-$42.00 USD');
  });

  it('accepts a plain integer number', () => {
    const out = withMoneyDisplay({ amountMinor: 4200, currencyCode: 'USD' }, 'en');
    expect(at(out, 'amountDisplay')).toBe('$42.00 USD');
  });

  it('refuses a non-integer, which is not a count of minor units', () => {
    const out = withMoneyDisplay({ amountMinor: 42.5, currencyCode: 'USD' }, 'en');
    expect(has(out, '', 'amountDisplay')).toBe(false);
  });

  it('survives an amount past the safe-integer range without failing the tool call', () => {
    /**
     * `formatMoney` throws there rather than render a truncated figure, which is right.
     * Letting that throw escape would fail the whole tool call — and in the chat loop, the
     * unrelated reads answered alongside it.
     */
    const huge = BigInt(Number.MAX_SAFE_INTEGER) + 1n;
    const out = withMoneyDisplay({ amountMinor: huge, currencyCode: 'USD' }, 'en') as Record<
      string,
      unknown
    >;
    expect('amountDisplay' in out).toBe(false);
    expect(out.amountMinor).toBe(huge);
  });
});

describe('what it does not touch', () => {
  it('ignores rates and distances sitting next to a currency', () => {
    /**
     * The near misses in the schema are all rates, distances and basis points — `gstRate`,
     * `fxRate`, `mileageDistance`, `mileageYtdBefore`, `percentBp`. None ends in `Minor`, and
     * a transform keyed on "numeric field near a currency" would render an FX rate as $1.35.
     */
    const out = withMoneyDisplay(
      {
        currencyCode: 'CAD',
        gstRate: 0.05,
        fxRate: '1.35',
        mileageDistance: 120,
        mileageYtdBefore: '4200.00',
        percentBp: 5000,
      },
      'en',
    ) as Record<string, unknown>;
    expect(Object.keys(out).sort()).toEqual([
      'currencyCode',
      'fxRate',
      'gstRate',
      'mileageDistance',
      'mileageYtdBefore',
      'percentBp',
    ]);
  });

  it('leaves receipt-extraction amounts alone, because they are MAJOR units', () => {
    /**
     * `extraction.data` is the one place money does not end in `Minor`: `total`, `subtotal`,
     * `taxGstHst` and friends are decimal major units from the vision model. Reading them as
     * minor units would be wrong by a factor of 100 — a worse failure than the one being
     * fixed — so they are deliberately untouched and reported instead.
     */
    const out = withMoneyDisplay(
      { currencyCode: 'CAD', extraction: { data: { total: 12.34, taxGstHst: 0.62 } } },
      'en',
    );
    expect(at(out, 'extraction.data')).toEqual({ total: 12.34, taxGstHst: 0.62 });
  });

  it('never overwrites a display key the procedure already computed', () => {
    const out = withMoneyDisplay(
      { totalMinor: 1234n, currencyCode: 'USD', totalDisplay: 'twelve dollars and change' },
      'en',
    );
    expect(at(out, 'totalDisplay')).toBe('twelve dollars and change');
  });

  it('passes Dates through as Dates rather than unpacking them', () => {
    const createdAt = new Date('2026-08-01T00:00:00Z');
    const out = withMoneyDisplay({ createdAt, amountMinor: 1234n, currencyCode: 'USD' }, 'en');
    expect(at(out, 'createdAt')).toBe(createdAt);
  });

  it('leaves nulls, arrays of scalars and an empty payload alone', () => {
    expect(withMoneyDisplay(null, 'en')).toBeNull();
    expect(withMoneyDisplay([1, 'a', null], 'en')).toEqual([1, 'a', null]);
    expect(withMoneyDisplay({}, 'en')).toEqual({});
  });

  it('does not mutate the payload it was given', () => {
    const input = { totalMinor: 1234n, currencyCode: 'USD' };
    withMoneyDisplay(input, 'en');
    expect('totalDisplay' in input).toBe(false);
  });
});

describe('a whole expense-report payload', () => {
  /** The nesting `get_expense_report` actually returns: report → expenses → line items. */
  const REPORT = {
    id: 'r-1',
    title: 'October travel',
    currency: { code: 'CAD', symbol: '$' },
    totalMinor: '132450',
    expenses: [
      {
        id: 'e-1',
        merchant: 'Air Canada',
        amountMinor: '89900',
        subtotalMinor: '85405',
        taxGstHstMinor: '4495',
        recoverableGstHstMinor: '4495',
        currencyId: 'cur-1',
        currency: { id: 'cur-1', code: 'CAD', symbol: '$' },
        fxRate: null,
        lineItems: [
          {
            id: 'l-1',
            amountMinor: '85405',
            payload: { tipMinor: '0' },
            mileageBreakdown: [{ rateMinor: '68', distance: '120.00', amountMinor: '8160' }],
          },
        ],
      },
      {
        id: 'e-2',
        merchant: 'Hilton',
        amountMinor: '30000',
        currencyId: 'cur-2',
        currency: { id: 'cur-2', code: 'USD', symbol: '$' },
        homeCurrency: 'CAD',
        homeAmountMinor: '42550',
        lineItems: [],
      },
    ],
  };

  it('formats every level, each in its own currency', () => {
    const out = withMoneyDisplay(REPORT, 'en');
    expect(at(out, 'totalDisplay')).toBe('$1,324.50 CAD');
    expect(at(out, 'expenses.0.amountDisplay')).toBe('$899.00 CAD');
    expect(at(out, 'expenses.0.taxGstHstDisplay')).toBe('$44.95 CAD');
    expect(at(out, 'expenses.0.recoverableGstHstDisplay')).toBe('$44.95 CAD');
    // Two levels down, inheriting the expense's currency — including inside the raw Json
    // `payload` and `mileageBreakdown` blobs.
    expect(at(out, 'expenses.0.lineItems.0.amountDisplay')).toBe('$854.05 CAD');
    expect(at(out, 'expenses.0.lineItems.0.payload.tipDisplay')).toBe('$0.00 CAD');
    expect(at(out, 'expenses.0.lineItems.0.mileageBreakdown.0.rateDisplay')).toBe('$0.68 CAD');
    // The USD receipt, and its CAD reimbursement, kept apart.
    expect(at(out, 'expenses.1.amountDisplay')).toBe('$300.00 USD');
    expect(at(out, 'expenses.1.homeAmountDisplay')).toBe('$425.50 CAD');
  });

  it('leaves the mileage distance beside those amounts alone', () => {
    const out = withMoneyDisplay(REPORT, 'en');
    expect(has(out, 'expenses.0.lineItems.0.mileageBreakdown.0', 'distanceDisplay')).toBe(false);
  });

  it('renders the same report in fr-CA throughout', () => {
    const out = withMoneyDisplay(REPORT, 'fr-CA');
    const total = String(at(out, 'totalDisplay'));
    const line = String(at(out, 'expenses.0.lineItems.0.amountDisplay'));
    expect(total).toMatch(new RegExp(`^1${NBSP.source}324,50`));
    expect(line).toMatch(/^854,05/);
    expect(total).not.toContain('1,324.50');
  });
});
