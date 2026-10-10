import { describe, expect, it } from 'vitest';
import { fxParamsFrom, resolveExpenseFx } from './expenseFx';

// String literals rather than the FxRateSource enum value: the literals are
// assignable to the string-union type, and nothing here needs the runtime enum.

/** Minimal stub of the one delegate resolveExpenseFx reads. */
function stubDb(rate: string | null) {
  return {
    fxRate: {
      findFirst: async () => (rate === null ? null : { rate }),
      findMany: async () => [],
    },
  } as never;
}

/**
 * A stub that actually respects direction, which the single-rate stub above cannot.
 *
 * Pairs are given as `BASE->QUOTE`. Anything not listed does not exist, so a test can
 * state "only USD->CAD is published" and mean it — which is the real shape of the data:
 * the Bank of Canada feed publishes `FX<ISO>CAD` series only, so every stored row quotes
 * CAD and no row ever quotes anything else.
 */
function tableDb(pairs: Record<string, string>) {
  const rows = Object.entries(pairs).map(([pair, rate]) => {
    const [base, quote] = pair.split('->');
    return { base, quote, rate, fetchedAt: new Date('2026-08-31T12:00:00Z') };
  });
  return {
    fxRate: {
      findFirst: async ({ where }: { where: { base: string; quote: string } }) =>
        rows.find((r) => r.base === where.base && r.quote === where.quote) ?? null,
      findMany: async ({ where }: { where: { OR: Array<Record<string, string>> } }) =>
        rows.filter((r) =>
          where.OR.some((c) => (c.base ? r.base === c.base : r.quote === c.quote)),
        ),
    },
  } as never;
}

describe('resolveExpenseFx', () => {
  it('records no rate for a same-currency expense', async () => {
    const fx = await resolveExpenseFx(stubDb('1.37'), {
      amountMinor: 10000n,
      currencyCode: 'CAD',
      homeCurrency: 'CAD',
    });
    expect(fx).toEqual({
      fxRate: null,
      fxRateSource: null,
      homeCurrency: 'CAD',
      homeAmountMinor: 10000n,
    });
  });

  it('derives the daily rate and snapshots it as CALCULATED', async () => {
    const fx = await resolveExpenseFx(stubDb('1.37'), {
      amountMinor: 10000n,
      currencyCode: 'USD',
      homeCurrency: 'CAD',
    });
    expect(fx.fxRateSource).toBe('CALCULATED');
    expect(fx.fxRate).toBe('1.37');
    expect(fx.homeAmountMinor).toBe(13700n);
  });

  it('adopts a provided rate and does NOT consult the table', async () => {
    // The stub would answer 1.37; MANUAL must win (AP's statement rate).
    const fx = await resolveExpenseFx(stubDb('1.37'), {
      amountMinor: 10000n,
      currencyCode: 'USD',
      homeCurrency: 'CAD',
      providedRate: { rate: '1.4025', source: 'MANUAL' },
    });
    expect(fx.fxRateSource).toBe('MANUAL');
    expect(fx.homeAmountMinor).toBe(14025n);
  });

  it('leaves the converted amount null when no rate exists, rather than guessing', async () => {
    const fx = await resolveExpenseFx(stubDb(null), {
      amountMinor: 10000n,
      currencyCode: 'JPY',
      homeCurrency: 'CAD',
    });
    expect(fx).toEqual({
      fxRate: null,
      fxRateSource: null,
      homeCurrency: 'CAD',
      homeAmountMinor: null,
    });
  });

  // ── Only one direction is ever published ─────────────────────────────────
  // The sole feed is the Bank of Canada, whose series are all `FX<ISO>CAD`: on dev, all
  // 676 rows quote CAD and not one quotes anything else. So an entity whose home
  // currency is not CAD asks for a pair that will never exist, and 210 of the 591 live
  // users sit on exactly such an entity (EBlock Corporation, home USD). Their foreign
  // expenses got no rate at all, and the report only failed at the NetSuite post.

  it('inverts the published rate when only the opposite direction exists', async () => {
    // CAD expense, USD home. USD->CAD is published; CAD->USD never is.
    const fx = await resolveExpenseFx(tableDb({ 'USD->CAD': '1.3866' }), {
      amountMinor: 28950n,
      currencyCode: 'CAD',
      homeCurrency: 'USD',
    });
    expect(fx.fxRateSource).toBe('CALCULATED');
    expect(fx.fxRate).toBe('0.72118852'); // 1 / 1.3866, at the column's 8 dp
    // $289.50 CAD at that rate → $208.78 USD.
    expect(fx.homeAmountMinor).toBe(20878n);
  });

  it('does not invent an inverse when the rate is zero', async () => {
    const fx = await resolveExpenseFx(tableDb({ 'USD->CAD': '0' }), {
      amountMinor: 10000n,
      currencyCode: 'CAD',
      homeCurrency: 'USD',
    });
    expect(fx.fxRate).toBeNull();
    expect(fx.homeAmountMinor).toBeNull();
  });

  it('triangulates through a shared currency when neither direction is published', async () => {
    // EUR expense, USD home: the feed has EUR->CAD and USD->CAD, neither of which is
    // the pair asked for. EUR->USD = 1.6098 / 1.3866.
    const fx = await resolveExpenseFx(tableDb({ 'EUR->CAD': '1.6098', 'USD->CAD': '1.3866' }), {
      amountMinor: 10000n,
      currencyCode: 'EUR',
      homeCurrency: 'USD',
    });
    expect(fx.fxRateSource).toBe('CALCULATED');
    expect(fx.fxRate).toBe('1.16096928');
    expect(fx.homeAmountMinor).toBe(11610n);
  });

  it('still reports no rate when no path exists at all', async () => {
    // GBP shares no counterpart with JPY here, so there is nothing to derive from.
    const fx = await resolveExpenseFx(tableDb({ 'GBP->CAD': '1.72' }), {
      amountMinor: 10000n,
      currencyCode: 'JPY',
      homeCurrency: 'USD',
    });
    expect(fx.fxRate).toBeNull();
    expect(fx.homeAmountMinor).toBeNull();
  });

  it('prefers the published direction over an inverse or a pivot', async () => {
    // A direct row must win: deriving when we do not have to would introduce rounding
    // the published figure does not have.
    const fx = await resolveExpenseFx(tableDb({ 'USD->CAD': '1.3866', 'CAD->USD': '0.7300' }), {
      amountMinor: 10000n,
      currencyCode: 'CAD',
      homeCurrency: 'USD',
    });
    // Trailing zeros are normalised away, as a Decimal(18,8) column's own toString
    // already does — what matters is that it is 0.73 and not the reciprocal 0.72118852.
    expect(fx.fxRate).toBe('0.73');
    expect(fx.homeAmountMinor).toBe(7300n);
  });

  it('handles differing ISO exponents (JPY has no minor units)', async () => {
    // ¥10,000 at 0.0091 → CAD $91.00 = 9100 minor units, not 91.
    const fx = await resolveExpenseFx(stubDb('0.0091'), {
      amountMinor: 10000n,
      currencyCode: 'JPY',
      homeCurrency: 'CAD',
    });
    expect(fx.homeAmountMinor).toBe(9100n);
  });

  it('is case-insensitive on currency codes', async () => {
    const fx = await resolveExpenseFx(stubDb('1.37'), {
      amountMinor: 10000n,
      currencyCode: 'usd',
      homeCurrency: 'cad',
    });
    expect(fx.homeCurrency).toBe('CAD');
    expect(fx.homeAmountMinor).toBe(13700n);
  });
});

describe('fxParamsFrom', () => {
  const row = (over: Record<string, unknown> = {}) =>
    ({
      amountMinor: 10000n,
      currency: { code: 'USD' },
      fxRate: null,
      fxRateSource: null,
      // VeloExpense: the entity's `homeCurrencyId` holds the code itself (0048).
      owner: { entity: { homeCurrencyId: 'CAD' } },
      ...over,
    }) as never;

  it('reads the home currency off the legal entity (rule 3)', () => {
    // The entity's currency is a FK now, so the row carries `{ code }` — the params
    // it produces still carry a plain code, which is what the resolver compares.
    expect(fxParamsFrom(row()).homeCurrency).toBe('CAD');
  });

  it('carries a MANUAL rate forward so a recompute cannot overwrite it', () => {
    const p = fxParamsFrom(row({ fxRate: '1.4025', fxRateSource: 'MANUAL' }));
    expect(p.providedRate).toEqual({ rate: '1.4025', source: 'MANUAL' });
  });

  it('does NOT carry a CALCULATED rate forward — it is re-derived', () => {
    const p = fxParamsFrom(row({ fxRate: '1.37', fxRateSource: 'CALCULATED' }));
    expect(p.providedRate).toBeNull();
  });

  it('falls back to the expense currency when the entity has no home currency', () => {
    // Nothing to convert into, so the snapshot stays inert rather than inventing
    // a conversion nobody configured.
    expect(fxParamsFrom(row({ owner: { entity: null } })).homeCurrency).toBe('USD');
    expect(fxParamsFrom(row({ owner: { entity: { homeCurrencyId: null } } })).homeCurrency).toBe(
      'USD',
    );
  });

  it('prefers a freshly recalculated amount over the stored column', () => {
    expect(fxParamsFrom(row(), 25000n).amountMinor).toBe(25000n);
  });
});
