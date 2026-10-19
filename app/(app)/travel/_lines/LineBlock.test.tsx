import { DEFAULT_LOCALE } from '@/lib/i18n/locales';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTrpcMock } from '@/test-utils/trpc';

/**
 * One budget line, as its own block.
 *
 * Three things it shows that the table it replaced could not, and each is a case here:
 * the fields its KIND has, where its number came from, and the traveller's own words. The
 * override is the sharpest of them — typing an amount makes the line MANUAL permanently,
 * with nothing to re-price it back, so the box must not be pre-filled with the stored
 * figure and a no-op edit must not commit.
 */

const h: { trpc: ReturnType<typeof createTrpcMock> } = { trpc: createTrpcMock({}) };

vi.mock('next-intl', () => ({
  // VeloExpense (w6-02): the registry's default (en-CA), not a literal (check:i18n).
  useLocale: () => DEFAULT_LOCALE,
  useTranslations: (ns?: string) => {
    const t = (k: string, v?: Record<string, unknown>) => {
      const full = ns ? `${ns}.${k}` : k;
      return v ? `${full}:${Object.values(v).join(',')}` : full;
    };
    t.has = () => false;
    return t;
  },
}));
vi.mock('@/lib/trpc/client', () => ({
  get trpc() {
    return h.trpc;
  },
}));
// The pickers have their own suite; here they only need to be present or absent.
vi.mock('./OptionPicker', () => ({
  FlightPicker: () => <div data-testid="flight-picker" />,
  StayPicker: () => <div data-testid="stay-picker" />,
}));

import { LineBlock } from './LineBlock';

const CURRENCY = { code: 'CAD', symbol: '$' };

const line = (over: Record<string, unknown> = {}) => ({
  id: 'bl-1',
  kind: 'STANDARD',
  amountMinor: '30000',
  basis: 'PER_DIEM',
  confidence: 'HIGH',
  notes: null,
  payload: { perDiemDays: 4, perDiemCity: 'Toronto', perDiemDailyMinor: '7500' },
  category: { id: 'c-meals', label: { en: 'Meals' }, icon: '🍽️' },
  ...over,
});

const onUpdate = vi.fn();
const onRemove = vi.fn();

const show = (over: Record<string, unknown> = {}, props: Record<string, unknown> = {}) =>
  render(
    <LineBlock
      line={line(over) as never}
      requestId="tr-1"
      currency={CURRENCY}
      tripType="ROUND_TRIP"
      departDate="2026-09-01T00:00:00.000Z"
      returnDate="2026-09-05T00:00:00.000Z"
      editable
      onUpdate={onUpdate}
      onRemove={onRemove}
      onChanged={() => {}}
      onError={() => {}}
      {...props}
    />,
  );

const overrideBox = () => screen.getByLabelText('travel.line.override');
const detailBox = () => screen.getByLabelText('travel.line.notes');

beforeEach(() => {
  onUpdate.mockClear();
  onRemove.mockClear();
  h.trpc = createTrpcMock({});
});
afterEach(cleanup);

describe('the header', () => {
  it('names the category, the basis and the amount', () => {
    show();
    expect(screen.getByText('Meals')).toBeInTheDocument();
    // A policy ceiling and a market price are both "budget" and are not equally
    // trustworthy; an approver deciding on a total is entitled to know which they read.
    expect(screen.getByText('travel.basis.PER_DIEM')).toBeInTheDocument();
    // The figure is IN the amount box now — row 1 is category, amount, trash.
    expect(overrideBox()).toHaveValue(300);
  });

  it('shows the amount as read-only text once the request is filed', () => {
    show({}, { editable: false });
    expect(screen.getByText(/300[.,]00/)).toBeInTheDocument();
  });

  it('hides the confidence badge when nothing is known', () => {
    show({ confidence: 'UNKNOWN' });
    expect(screen.queryByText(/travel\.confidence/)).not.toBeInTheDocument();
  });

  it('offers no remove button once the request is no longer editable', () => {
    show({}, { editable: false });
    expect(screen.queryByRole('button', { name: /travel\.detail\.plannedRemove/ })).toBeNull();
  });

  it('removes on request', async () => {
    const user = userEvent.setup();
    show();
    await user.click(screen.getByRole('button', { name: /travel\.detail\.plannedRemove/ }));
    expect(onRemove).toHaveBeenCalled();
  });
});

describe('the summary', () => {
  it('composes the per-diem derivation from the payload', () => {
    /**
     * Not read back from a stored string. `detail` is the traveller's field now, so what a
     * reader is told about the FIGURE is derived from the facts the payload carries — which
     * is also what makes it render in their own locale.
     */
    show();
    expect(screen.getByText(/travel\.line\.summary\.perDiem:4,Toronto/)).toBeInTheDocument();
  });

  it('says nothing for a line whose payload explains nothing', () => {
    show({ payload: {} });
    expect(screen.queryByText(/travel\.line\.summary/)).not.toBeInTheDocument();
  });
});

describe('the traveller’s notes', () => {
  it('is pre-filled with what is stored, unlike the amount box', () => {
    /**
     * There is nothing derived to lose here, and a rule may be REQUIRING it — so showing
     * it empty when it is not would read as "you still have to write this".
     */
    show({ notes: 'Only nonstop that morning' });
    expect(detailBox()).toHaveValue('Only nonstop that morning');
  });

  it('commits on blur', async () => {
    const user = userEvent.setup();
    show();
    await user.type(detailBox(), 'Team offsite');
    expect(onUpdate).not.toHaveBeenCalled();
    await user.tab();
    expect(onUpdate).toHaveBeenCalledWith({ notes: 'Team offsite' });
  });

  it('does NOT commit when nothing changed', async () => {
    // Every write re-prices the line; a blur that saves an identical value is a wasted
    // round trip on every click past the field.
    const user = userEvent.setup();
    show({ notes: 'Unchanged' });
    await user.click(detailBox());
    await user.tab();
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it('sends null when cleared, so a rule can start demanding one again', async () => {
    const user = userEvent.setup();
    show({ notes: 'Was explained' });
    await user.clear(detailBox());
    await user.tab();
    expect(onUpdate).toHaveBeenCalledWith({ notes: null });
  });

  it('is read-only text once the request is no longer editable', () => {
    show({ notes: 'Only nonstop that morning' }, { editable: false });
    expect(screen.getByText('Only nonstop that morning')).toBeInTheDocument();
    expect(screen.queryByLabelText('travel.line.notes')).toBeNull();
  });
});

describe('the amount', () => {
  /**
   * The amount lives in ROW 1 and carries the figure the line currently has, editable in
   * place — the same shape an expense line item uses.
   *
   * It used to be a blank box at the bottom of the block, deliberately empty so an
   * accidental no-op edit could not flip a derived line to MANUAL. That hazard is real and
   * permanent — nothing re-prices it back — but it is answered by only writing a REAL
   * change, not by hiding the number the traveller is editing.
   */
  it('carries the figure the line has', () => {
    show();
    expect(overrideBox()).toHaveValue(300);
  });

  it('says the override is permanent BEFORE it is applied', () => {
    // A traveller who does not know will type one to "check" and lose the allowance.
    show();
    expect(screen.getByText('travel.line.overrideHint')).toBeInTheDocument();
  });

  it('sends a typed figure as MINOR units, on blur', async () => {
    // On a line the policy never priced: a typed figure displaces nothing, so it goes up
    // alone. What a typed figure on a DERIVED line owes is the next describe's subject.
    const user = userEvent.setup();
    show({ basis: 'MANUAL', payload: {} });
    await user.clear(overrideBox());
    await user.type(overrideBox(), '125.50');
    await user.tab();
    expect(onUpdate).toHaveBeenCalledWith({ amountMinor: 12550n });
  });

  it('writes NOTHING when the value did not change', async () => {
    /**
     * The whole reason the box can safely show the stored figure. Tabbing through it, or
     * retyping the same number, is not an override — and an override is permanent, so a
     * no-op that flipped a derived line to MANUAL would cost a traveller their allowance
     * for nothing.
     */
    const user = userEvent.setup();
    show();
    await user.click(overrideBox());
    await user.tab();
    expect(onUpdate).not.toHaveBeenCalled();

    await user.clear(overrideBox());
    await user.type(overrideBox(), '300.00');
    await user.tab();
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it('puts the stored figure back when the box is cleared or nonsense', async () => {
    // A box that disagrees with the line it belongs to is worse than one that refuses.
    const user = userEvent.setup();
    show();
    await user.clear(overrideBox());
    await user.tab();
    expect(onUpdate).not.toHaveBeenCalled();
    expect(overrideBox()).toHaveValue(300);
  });

  it('refuses zero rather than budgeting nothing', async () => {
    const user = userEvent.setup();
    show();
    await user.clear(overrideBox());
    await user.type(overrideBox(), '0');
    await user.tab();
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it('previews what is being typed, and only while it differs', async () => {
    /**
     * `<input type="number">` formats nothing, so without this the only formatted money
     * on the row was the stored figure — "can't see what you enter until after" (UAT A14).
     */
    const user = userEvent.setup();
    show();
    const preview = () => screen.getByLabelText('travel.line.overridePreview');
    expect(preview()).toHaveTextContent('');
    await user.clear(overrideBox());
    await user.type(overrideBox(), '450');
    expect(preview().textContent).toMatch(/450/);
  });

  it('is a plain figure once the request is no longer editable', () => {
    show({}, { editable: false });
    expect(screen.queryByLabelText('travel.line.override')).toBeNull();
  });
});

/**
 * A typed figure that displaces a policy-derived one owes a reason (GA-6).
 *
 * The server refuses such an override without a note, and used to be the first place the
 * traveller heard of it — as an error banner, after a round trip, with the box reset. The
 * block mirrors the rule WHILE the figure is typed: the warning appears as the box starts
 * to differ, the notes field turns required, an unexplained blur is refused on the client,
 * and the note goes up with the amount once written. The server rule stands behind it.
 */
describe('overriding a derived figure', () => {
  const change = (value: string) => fireEvent.change(overrideBox(), { target: { value } });
  const liveWarning = () => screen.queryByText(/travel\.line\.overrides:/);

  it('says what the figure replaced in EDIT mode too, not only once filed', () => {
    /**
     * It used to render only on the read-only branch, so the traveller editing the line —
     * the one person who could still change their mind — was the one person never shown
     * that their $450 had displaced a policy $300.
     */
    show({ basis: 'MANUAL', amountMinor: '45000', derivedAmountMinor: '30000' });
    expect(screen.getByText(/travel\.line\.overrode:.*300/)).toBeInTheDocument();
    expect(overrideBox()).toBeInTheDocument();
  });

  it('warns, live, while the typed figure differs from the derivation', () => {
    // A PER_DIEM line IS its derivation until somebody types over it.
    show();
    expect(liveWarning()).toBeNull();
    change('450');
    expect(screen.getByRole('status', { name: '' })).toBeDefined();
    expect(liveWarning()).toHaveTextContent(/300/);
    // And it goes when the figure goes back.
    change('300.00');
    expect(liveWarning()).toBeNull();
  });

  it('marks the notes required, and invalid while empty, for the duration', () => {
    show();
    expect(detailBox()).not.toHaveAttribute('aria-required');
    change('450');
    expect(detailBox()).toHaveAttribute('aria-required', 'true');
    expect(detailBox()).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText('travel.line.noteRequiredForOverride')).toBeInTheDocument();
    fireEvent.change(detailBox(), { target: { value: 'Hotel restaurant' } });
    expect(detailBox()).toHaveAttribute('aria-required', 'true');
    expect(detailBox()).not.toHaveAttribute('aria-invalid');
    expect(screen.queryByText('travel.line.noteRequiredForOverride')).toBeNull();
  });

  it('refuses to send an unexplained override, keeps the figure, and hands focus to the notes', async () => {
    const user = userEvent.setup();
    show();
    await user.clear(overrideBox());
    await user.type(overrideBox(), '450');
    await user.tab();
    expect(onUpdate).not.toHaveBeenCalled();
    // Not reset to the stored figure: the traveller is one sentence away from saving it.
    expect(overrideBox()).toHaveValue(450);
    expect(detailBox()).toHaveFocus();
  });

  it('sends the override WITH the note once the note is written', async () => {
    // Otherwise the traveller writes the reason, sees nothing happen, and has to find
    // their way back to the amount and blur it again.
    const user = userEvent.setup();
    show();
    await user.clear(overrideBox());
    await user.type(overrideBox(), '450');
    await user.tab();
    await user.type(detailBox(), 'Hotel restaurant');
    await user.tab();
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(onUpdate).toHaveBeenCalledWith({ amountMinor: 45000n, notes: 'Hotel restaurant' });
  });

  it('sends a note typed FIRST along with the amount', async () => {
    /**
     * Leaving the notes field commits the note on its own, as it always has. The point
     * here is the SECOND write: the amount must carry the note too, because the guard is
     * evaluated per write and this harness — unlike the app — never refreshes `line.notes`
     * between the two.
     */
    const user = userEvent.setup();
    show();
    await user.type(detailBox(), 'Hotel restaurant');
    await user.click(overrideBox());
    await user.clear(overrideBox());
    await user.type(overrideBox(), '450');
    await user.tab();
    expect(onUpdate).toHaveBeenLastCalledWith({ amountMinor: 45000n, notes: 'Hotel restaurant' });
  });

  it('is satisfied by a note the line already carries', async () => {
    // The server accepts stored notes; the block must not demand a second sentence.
    const user = userEvent.setup();
    show({ notes: 'Already explained' });
    await user.clear(overrideBox());
    await user.type(overrideBox(), '450');
    await user.tab();
    expect(onUpdate).toHaveBeenCalledWith({ amountMinor: 45000n });
  });

  it('compares against a LIVE preview of the derivation for an untouched derived line', () => {
    /**
     * The stored figure is what the policy derived when the line was written. If the rate
     * has moved since, the write will record the CURRENT derivation as the one displaced —
     * so that is the number the warning names.
     */
    h.trpc = createTrpcMock({
      queries: {
        'travelRequests.previewLine': {
          data: {
            derivedAmountMinor: '28000',
            basis: 'PER_DIEM',
            days: 4,
            dailyRateMinor: '7000',
            edgeDaysHalved: false,
            city: 'Toronto',
          },
        },
      },
    });
    show();
    change('450');
    expect(liveWarning()).toHaveTextContent(/280/);
  });

  it('prefers the derivation the line RECORDED, once it has been overridden', () => {
    h.trpc = createTrpcMock({
      queries: {
        'travelRequests.previewLine': {
          onCall: (_input, opts) => {
            // Not even asked: the line already knows what it displaced.
            expect((opts as { enabled: boolean }).enabled).toBe(false);
          },
          data: { derivedAmountMinor: '28000' },
        },
      },
    });
    show({ basis: 'MANUAL', amountMinor: '45000', derivedAmountMinor: '30000' });
    change('500');
    expect(liveWarning()).toHaveTextContent(/300/);
  });

  it('asks for no note on a line the policy never priced', async () => {
    const user = userEvent.setup();
    show({ basis: 'MANUAL', payload: {} });
    await user.clear(overrideBox());
    await user.type(overrideBox(), '450');
    expect(liveWarning()).toBeNull();
    expect(detailBox()).not.toHaveAttribute('aria-required');
    await user.tab();
    expect(onUpdate).toHaveBeenCalledWith({ amountMinor: 45000n });
  });
});

describe('the kind decides the fields', () => {
  it('opens a flight picker on an airfare line and nothing else', () => {
    show({ kind: 'AIRFARE', payload: {} });
    expect(screen.getByTestId('flight-picker')).toBeInTheDocument();
    expect(screen.queryByTestId('stay-picker')).toBeNull();
  });

  it('opens a stay picker on a lodging line', () => {
    show({ kind: 'LODGING', payload: {} });
    expect(screen.getByTestId('stay-picker')).toBeInTheDocument();
  });

  it('opens the attendees editor on a department meal', () => {
    show({ kind: 'DEPARTMENT_MEAL', payload: { attendees: [], occurrencesPerDay: 1, days: 1 } });
    expect(screen.getByText('travel.attendees.heading')).toBeInTheDocument();
  });

  it('offers cap × days fields on a car line, and no picker', () => {
    // There is no car engine on the travel integration, so this kind never gets a picker —
    // and saying so beats a search button that returns nothing forever.
    show({ kind: 'CAR_RENTAL', payload: { days: 4, dailyCapMinor: '6000' } });
    expect(screen.getByLabelText('travel.line.days')).toBeInTheDocument();
    expect(screen.queryByTestId('flight-picker')).toBeNull();
    expect(screen.queryByTestId('stay-picker')).toBeNull();
  });

  it('offers no picker and no fields on a plain standard line', () => {
    show();
    expect(screen.queryByTestId('flight-picker')).toBeNull();
    expect(screen.queryByLabelText('travel.line.days')).toBeNull();
  });

  it('seeds the attendees editor from the stored payload, tolerating a malformed one', () => {
    // Strict on write, forgiving on read — which is what makes a drawer render the
    // forty-nine lines it understands instead of failing on the fiftieth.
    show({ kind: 'DEPARTMENT_MEAL', payload: { attendees: 'not an array' } });
    expect(screen.getByText('travel.attendees.none')).toBeInTheDocument();
  });
});
