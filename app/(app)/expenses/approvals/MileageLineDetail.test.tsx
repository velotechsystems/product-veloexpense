import { DEFAULT_LOCALE, type Locale } from '@expenseos/i18n/locales';
import '@testing-library/jest-dom/vitest';
import enExpenses from '@expenseos/i18n/catalogs/en/expenses';
import frExpenses from '@expenseos/i18n/catalogs/fr-CA/expenses';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it } from 'vitest';
import { MileageLineDetail, type MileageLineFields, mileageTiers } from './MileageLineDetail';

/**
 * MileageLineDetail — the mileage claim on the approver's expense card.
 *
 * Resolved against the REAL catalogs, not an identity mock: the copy here carries a
 * security rule ("route as filed", never "verified"), and an identity mock would render
 * the key and pass whatever the catalog said. The drawer's own test covers placement
 * (under the line, mileage lines only) with its usual mock.
 *
 * FR-CA money and grouping use no-break spaces whose code point depends on the ICU
 * build, so French text is compared with every space folded to a plain one.
 */

const CAD = { code: 'CAD', symbol: '$' };

const line = (over: Partial<MileageLineFields> = {}): MileageLineFields => ({
  mileageDistance: '120.00',
  mileageUnit: 'KM',
  mileageBreakdown: [
    { fromDistance: '0.00', rateMinor: '70', distance: '120.00', amountMinor: '8400' },
  ],
  mileageRoute: null,
  routeDistance: null,
  mileageRouteUnavailable: false,
  ...over,
});

const twoTier = [
  { fromDistance: '0.00', rateMinor: '70', distance: '100.00', amountMinor: '7000' },
  { fromDistance: '5000.00', rateMinor: '64', distance: '50.00', amountMinor: '3200' },
];

// VeloExpense: the locales from the registry (check:i18n), where ExpenseOS writes 'en' | 'fr-CA'.
function show(fields: MileageLineFields, locale: Locale = DEFAULT_LOCALE) {
  return render(
    <NextIntlClientProvider
      locale={locale}
      messages={{ expenses: locale === 'en' ? enExpenses : frExpenses }}
    >
      <MileageLineDetail line={fields} currency={CAD} locale={locale} />
    </NextIntlClientProvider>,
  );
}

/** Every whitespace variant (incl. U+00A0 / U+202F) as one plain space. */
const fold = (s: string | null | undefined) => (s ?? '').replace(/\s/gu, ' ');

// ── The tier helper ───────────────────────────────────────────────────────────

describe('mileageTiers', () => {
  it('reads one band as one open-ended tier', () => {
    expect(
      mileageTiers([
        { fromDistance: '0.00', rateMinor: '70', distance: '120.00', amountMinor: '8400' },
      ]),
    ).toEqual([{ from: '0.00', to: null, distance: '120.00', rateMinor: 70n, amountMinor: 8400n }]);
  });

  it("closes each band at the next one's lower bound and leaves the last open", () => {
    expect(mileageTiers(twoTier)).toEqual([
      { from: '0.00', to: '5000.00', distance: '100.00', rateMinor: 70n, amountMinor: 7000n },
      { from: '5000.00', to: null, distance: '50.00', rateMinor: 64n, amountMinor: 3200n },
    ]);
  });

  it('accepts numbers where the stored JSON carries them', () => {
    expect(
      mileageTiers([{ fromDistance: 0, rateMinor: 70, distance: 12.5, amountMinor: 875 }]),
    ).toEqual([{ from: '0', to: null, distance: '12.5', rateMinor: 70n, amountMinor: 875n }]);
  });

  it.each([
    ['null', null],
    ['an object', { fromDistance: '0.00' }],
    ['an empty array', []],
    ['a non-object entry', ['0.00']],
    ['a missing field', [{ fromDistance: '0.00', rateMinor: '70', distance: '1.00' }]],
    [
      'a non-numeric distance',
      [{ fromDistance: 'zero', rateMinor: '70', distance: '1.00', amountMinor: '70' }],
    ],
    [
      'a fractional minor amount',
      [{ fromDistance: '0.00', rateMinor: '70.5', distance: '1.00', amountMinor: '70' }],
    ],
    [
      'one bad entry among good ones',
      [twoTier[0], { fromDistance: '5000.00', rateMinor: null, distance: '1', amountMinor: '1' }],
    ],
  ])('yields no tiers for %s — a partial split would not sum to the line', (_, input) => {
    expect(mileageTiers(input)).toEqual([]);
  });
});

// ── What the card shows ───────────────────────────────────────────────────────

describe('<MileageLineDetail>', () => {
  it('shows a single-band claim as a distance and a flat rate', () => {
    show(line());
    expect(screen.getByText('120.00 km')).toBeInTheDocument();
    expect(screen.getByText('@ $0.70/km')).toBeInTheDocument();
    expect(screen.queryByText(/route as filed/)).not.toBeInTheDocument();
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
  });

  it('pairs the claim with the route as filed, and splits a two-band trip', () => {
    show(line({ mileageDistance: '150.00', routeDistance: '120.00', mileageBreakdown: twoTier }));
    expect(screen.getByText('claimed 150.00 km · route as filed 120.00 km')).toBeInTheDocument();
    // The pair replaces the bare distance; it never appears twice.
    expect(screen.queryByText('150.00 km')).not.toBeInTheDocument();
    const tiers = screen.getAllByRole('listitem').map((li) => li.textContent);
    expect(tiers).toEqual([
      '0–5,000 km: 100.00 km @ $0.70 = $70.00',
      '5,000+ km: 50.00 km @ $0.64 = $32.00',
    ]);
    expect(screen.queryByText(/@ \$0\.70\/km/)).not.toBeInTheDocument();
  });

  it('never words a hidden pair as agreement', () => {
    show(line({ mileageBreakdown: twoTier }));
    expect(screen.getByText('120.00 km')).toBeInTheDocument();
    expect(screen.queryByText(/route|match|verified|computed/i)).not.toBeInTheDocument();
  });

  it('labels miles as miles', () => {
    show(line({ mileageUnit: 'MI', mileageDistance: '30.00' }));
    expect(screen.getByText('30.00 mi')).toBeInTheDocument();
    expect(screen.getByText('@ $0.70/mi')).toBeInTheDocument();
  });

  it('draws the filed stops joined with arrows', () => {
    show(
      line({
        mileageRoute: {
          stops: [
            { description: 'Montréal' },
            { description: 'Laval' },
            { description: 'Montréal' },
          ],
        },
      }),
    );
    expect(screen.getByText('Montréal → Laval → Montréal')).toBeInTheDocument();
  });

  const STOPS = [{ description: 'Toronto' }, { description: 'Ottawa' }];

  it('says which route was chosen when filed, and that it was the only one offered', () => {
    show(line({ mileageRoute: { stops: STOPS, routeLabel: 'Hwy 401', routeCount: 1 } }));
    expect(screen.getByText('Toronto → Ottawa')).toBeInTheDocument();
    expect(
      screen.getByText('Route chosen when filed: via Hwy 401 · 1 route offered'),
    ).toBeInTheDocument();
  });

  it('counts three routes offered in the plural', () => {
    show(line({ mileageRoute: { stops: STOPS, routeLabel: 'Hwy 7', routeCount: 3 } }));
    expect(
      screen.getByText('Route chosen when filed: via Hwy 7 · 3 routes offered'),
    ).toBeInTheDocument();
  });

  it('places the chosen route under the stops', () => {
    const { container } = show(
      line({ mileageRoute: { stops: STOPS, routeLabel: 'Hwy 401', routeCount: 3 } }),
    );
    const lines = [...container.querySelectorAll('p')].map((p) => p.textContent);
    expect(lines.indexOf('Route chosen when filed: via Hwy 401 · 3 routes offered')).toBe(
      lines.indexOf('Toronto → Ottawa') + 1,
    );
  });

  it('shows a label as text, never as markup', () => {
    const { container } = show(
      line({ mileageRoute: { stops: STOPS, routeLabel: '<b>via</b> {count}', routeCount: 2 } }),
    );
    expect(container.querySelector('b')).toBeNull();
    expect(
      screen.getByText('Route chosen when filed: via <b>via</b> {count} · 2 routes offered'),
    ).toBeInTheDocument();
  });

  it.each([
    ['no label', { routeCount: 3 }],
    ['no count', { routeLabel: 'Hwy 401' }],
    ['neither — an older line, or one filed with lookup off', {}],
  ])('adds nothing new with %s', (_, chosen) => {
    show(line({ mileageRoute: { stops: STOPS, ...chosen } }));
    expect(screen.getByText('Toronto → Ottawa')).toBeInTheDocument();
    expect(screen.queryByText(/chosen|offered|via/)).not.toBeInTheDocument();
  });

  it('says which route was chosen in French, with the French plural', () => {
    const one = show(
      line({ mileageRoute: { stops: STOPS, routeLabel: '401', routeCount: 1 } }),
      'fr-CA',
    );
    expect(fold(one.container.textContent)).toContain(
      'Itinéraire choisi à la soumission : via 401 · 1 itinéraire proposé',
    );
    one.unmount();
    const three = show(
      line({ mileageRoute: { stops: STOPS, routeLabel: '401', routeCount: 3 } }),
      'fr-CA',
    );
    expect(fold(three.container.textContent)).toContain(
      'Itinéraire choisi à la soumission : via 401 · 3 itinéraires proposés',
    );
  });

  it('says the route is unavailable when the server could not read it', () => {
    show(line({ mileageRouteUnavailable: true }));
    expect(screen.getByText('Route unavailable')).toBeInTheDocument();
  });

  it('says nothing about a route when none was filed', () => {
    const { container } = show(line());
    expect(screen.queryByText('Route unavailable')).not.toBeInTheDocument();
    expect(container.textContent).not.toContain('→');
  });

  it('shows no rate when the breakdown is unreadable, and keeps the distance', () => {
    show(line({ mileageBreakdown: 'garbage' }));
    expect(screen.getByText('120.00 km')).toBeInTheDocument();
    expect(screen.queryByText(/@/)).not.toBeInTheDocument();
  });

  it('shows neither distance nor rate without a unit', () => {
    const { container } = show(line({ mileageUnit: null }));
    expect(container.textContent).toBe('');
  });

  it('lets long text wrap rather than overflow a 360 px card', () => {
    // jsdom applies no stylesheet; the class is the honest thing to pin.
    const { container } = show(line());
    expect(container.firstElementChild).toHaveClass('break-words', 'min-w-0');
  });

  it('carries the "as filed" qualifier in French too', () => {
    const { container } = show(
      line({ mileageDistance: '150.00', routeDistance: '120.00', mileageBreakdown: twoTier }),
      'fr-CA',
    );
    const text = fold(container.textContent);
    expect(text).toContain('déclaré : 150,00 km · trajet tel que soumis : 120,00 km');
    expect(text).toContain('0–5 000 km : 100,00 km à 0,70 $ = 70,00 $');
    expect(text).toContain('5 000 km et plus : 50,00 km à 0,64 $ = 32,00 $');
  });

  it('says the route is unavailable in French', () => {
    show(line({ mileageRouteUnavailable: true }), 'fr-CA');
    expect(screen.getByText('Trajet non disponible')).toBeInTheDocument();
  });
});
