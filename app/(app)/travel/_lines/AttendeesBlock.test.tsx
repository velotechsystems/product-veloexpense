import { DEFAULT_LOCALE } from '@/lib/i18n/locales';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A meal with people at it, priced per head.
 *
 * The arithmetic is the reason this is a KIND rather than a typed amount: three people
 * twice a day for four days is 24 covers, and nobody should be doing that multiplication
 * in their head into a single box. So the cases here are about the four facts reaching the
 * server intact, and about the two ways a naive editor would quietly inflate an estimate —
 * counting a half-typed row as a head, and committing on every keystroke.
 *
 * It writes on BLUR now, not from a Recalculate button: adding a person and tabbing away
 * has to re-price the line, because a roster that does not move the total is a roster
 * nobody trusts. Per-keystroke writes are still refused, for the reason above.
 */

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

import { AttendeesBlock } from './AttendeesBlock';

const onApply = vi.fn();

const show = (
  initial: {
    attendees: { name: string; company: string; isExternal: boolean }[];
    occurrencesPerDay: number;
    days: number;
  } = {
    attendees: [],
    occurrencesPerDay: 1,
    days: 1,
  },
  props: Record<string, unknown> = {},
) => render(<AttendeesBlock initial={initial} currencySymbol="$" onApply={onApply} {...props} />);

const person = (name: string, over: Record<string, unknown> = {}) => ({
  name,
  company: '',
  isExternal: false,
  ...over,
});

const addButton = () => screen.getByRole('button', { name: /travel\.attendees\.add/ });
const rateBox = () => screen.getByLabelText('travel.attendees.ratePerPerson');
/** The covers sentence: `attendees.covers` interpolates heads then covers. */
const covers = (heads: number, n: number) =>
  screen.getByText(`travel.attendees.covers:${heads},${n}`);
const names = () => screen.getAllByLabelText('travel.attendees.name') as HTMLInputElement[];

beforeEach(() => onApply.mockClear());
afterEach(cleanup);

describe('the roster', () => {
  it('says so when nobody is on it yet', () => {
    show();
    expect(screen.getByText('travel.attendees.none')).toBeInTheDocument();
  });

  it('seeds from the stored payload', () => {
    show({
      attendees: [person('Ada Lovelace', { company: 'Analytical Ltd', isExternal: true })],
      occurrencesPerDay: 2,
      days: 4,
    });
    expect(names()[0]).toHaveValue('Ada Lovelace');
    expect(screen.getByLabelText('travel.attendees.company')).toHaveValue('Analytical Ltd');
    expect(screen.getByRole('checkbox', { name: '' })).toBeChecked();
    expect(screen.getByLabelText('travel.attendees.occurrencesPerDay')).toHaveValue(2);
    expect(screen.getByLabelText('travel.attendees.days')).toHaveValue(4);
  });

  it('adds and removes rows', async () => {
    const user = userEvent.setup();
    show();
    await user.click(addButton());
    await user.click(addButton());
    expect(names()).toHaveLength(2);
    await user.click(screen.getAllByRole('button', { name: 'travel.attendees.remove' })[0]);
    expect(names()).toHaveLength(1);
  });

  it('removes the row that was asked for, not the one at that index', async () => {
    /**
     * The concrete bug a keyed-by-index list produces. Removing the first of three re-keys
     * the two below it, React reuses the DOM nodes, and the values shift up one person —
     * so the roster ends up naming the wrong people at the wrong companies.
     */
    const user = userEvent.setup();
    show({
      attendees: [person('First'), person('Second'), person('Third')],
      occurrencesPerDay: 1,
      days: 1,
    });
    await user.click(screen.getAllByRole('button', { name: 'travel.attendees.remove' })[0]);
    expect(names().map((n) => n.value)).toEqual(['Second', 'Third']);
  });
});

describe('the multiplication', () => {
  it('spells the covers out rather than only showing a total', async () => {
    // The whole reason the kind exists: a traveller can SEE that three people twice a day
    // for four days is 24 covers instead of having to trust a figure.
    const user = userEvent.setup();
    show({ attendees: [person('A'), person('B'), person('C')], occurrencesPerDay: 2, days: 4 });
    expect(covers(3, 24)).toBeInTheDocument();
    // And it follows the roster as it changes.
    await user.click(screen.getAllByRole('button', { name: 'travel.attendees.remove' })[0]);
    expect(covers(2, 16)).toBeInTheDocument();
  });

  it('does not count a half-typed row as a head', async () => {
    /**
     * The inflation this prevents. An empty row that counted would add one person's
     * allowance to the estimate the moment somebody pressed "add" and paused.
     */
    const user = userEvent.setup();
    show({ attendees: [person('A')], occurrencesPerDay: 1, days: 1 });
    await user.click(addButton());
    // Two rows on screen, ONE head counted.
    expect(names()).toHaveLength(2);
    expect(covers(1, 1)).toBeInTheDocument();
  });

  it('reads a blank or nonsense count as zero rather than NaN', async () => {
    const user = userEvent.setup();
    show({ attendees: [person('A')], occurrencesPerDay: 1, days: 1 });
    await user.clear(screen.getByLabelText('travel.attendees.days'));
    expect(covers(1, 0)).toBeInTheDocument();
  });
});

describe('applying', () => {
  it('commits on BLUR, never per keystroke', async () => {
    /**
     * Each write re-prices the line, so committing per letter would write a partly-typed
     * roster — and re-price against it — on every character. Tabbing away is the moment
     * the person is finished with the field.
     */
    const user = userEvent.setup();
    show({ attendees: [person('')], occurrencesPerDay: 1, days: 1 });
    await user.type(names()[0], 'Grace Hopper');
    expect(onApply).not.toHaveBeenCalled();
    await user.tab();
    expect(onApply).toHaveBeenCalledTimes(1);
  });

  it('re-prices the moment somebody is removed', async () => {
    // A head that left the meal changes the total, and there is no field to blur out of.
    const user = userEvent.setup();
    show({ attendees: [person('Ada'), person('Grace')], occurrencesPerDay: 1, days: 1 });
    await user.click(screen.getAllByRole('button', { name: 'travel.attendees.remove' })[0]);
    expect(onApply.mock.calls.at(-1)?.[0]).toMatchObject({
      attendees: [{ name: 'Grace' }],
    });
  });

  it('sends the four facts, trimmed, with only the named people', async () => {
    const user = userEvent.setup();
    show({
      attendees: [person('  Ada  ', { company: '  Analytical  ', isExternal: true }), person('')],
      occurrencesPerDay: 2,
      days: 3,
    });
    await user.click(names()[0]);
    await user.tab();
    expect(onApply).toHaveBeenCalledWith({
      attendees: [{ name: 'Ada', company: 'Analytical', isExternal: true }],
      occurrencesPerDay: 2,
      days: 3,
      // Blank means "resolve the allowance from the per-diem table" — typing one is the
      // override, not the normal path.
      ratePerPersonMinor: null,
    });
  });

  it('sends a typed rate as MINOR units', async () => {
    // A rate box that silently meant cents is how a $47.50 allowance becomes 47 cents.
    const user = userEvent.setup();
    show({ attendees: [person('Ada')], occurrencesPerDay: 1, days: 1 });
    await user.clear(rateBox());
    await user.type(rateBox(), '47.50');
    await user.tab();
    expect(onApply.mock.calls.at(-1)?.[0]).toMatchObject({ ratePerPersonMinor: '4750' });
  });

  it('drops a nonsense rate rather than sending NaN', async () => {
    const user = userEvent.setup();
    show({ attendees: [person('Ada')], occurrencesPerDay: 1, days: 1 });
    await user.clear(rateBox());
    await user.type(rateBox(), '-');
    await user.tab();
    expect(onApply.mock.calls.at(-1)?.[0]).toMatchObject({ ratePerPersonMinor: null });
  });

  it('sends nobody when nobody is named', async () => {
    // Not a refusal: an empty roster is a legitimate state to save while composing.
    const user = userEvent.setup();
    show();
    await user.click(addButton());
    await user.click(names()[0]);
    await user.tab();
    expect(onApply.mock.calls.at(-1)?.[0]).toMatchObject({ attendees: [] });
  });
});

describe('while the row is busy', () => {
  it('disables every control', async () => {
    show({ attendees: [person('Ada')], occurrencesPerDay: 1, days: 1 }, { disabled: true });
    expect(names()[0]).toBeDisabled();
    expect(screen.getByLabelText('travel.attendees.days')).toBeDisabled();
    expect(addButton()).toBeDisabled();
    expect(rateBox()).toBeDisabled();
  });
});

describe('the per-person rate', () => {
  /**
   * Pre-filled with the allowance the server resolved, because the point of showing the
   * multiplication is that somebody can check it. A traveller looking at a total used to
   * have three of the four numbers that made it and no way to see the fourth.
   */
  it('shows the resolved allowance', () => {
    show({ attendees: [], occurrencesPerDay: 1, days: 1 }, { perDiemRateMinor: '4750' });
    expect(rateBox()).toHaveValue(47.5);
  });

  it('prefers what the line already stores, so an override survives', () => {
    show(
      {
        attendees: [],
        occurrencesPerDay: 1,
        days: 1,
        ratePerPersonMinor: '6000',
      } as never,
      { perDiemRateMinor: '4750' },
    );
    expect(rateBox()).toHaveValue(60);
  });

  it('fills in once the resolved rate arrives', () => {
    /**
     * It is FETCHED, so the first render of a fresh line has none. Seeding only in
     * `useState` would leave that line's box permanently blank.
     */
    const { rerender } = render(
      <AttendeesBlock
        initial={{ attendees: [], occurrencesPerDay: 1, days: 1 }}
        currencySymbol="$"
        onApply={onApply}
      />,
    );
    expect(rateBox()).toHaveValue(null);
    rerender(
      <AttendeesBlock
        initial={{ attendees: [], occurrencesPerDay: 1, days: 1 }}
        currencySymbol="$"
        perDiemRateMinor="4750"
        onApply={onApply}
      />,
    );
    expect(rateBox()).toHaveValue(47.5);
  });

  it('does not overwrite a typed rate when the query settles', async () => {
    // An override the query settling could undo is not an override.
    const user = userEvent.setup();
    const { rerender } = render(
      <AttendeesBlock
        initial={{ attendees: [], occurrencesPerDay: 1, days: 1 }}
        currencySymbol="$"
        onApply={onApply}
      />,
    );
    await user.type(rateBox(), '99');
    rerender(
      <AttendeesBlock
        initial={{ attendees: [], occurrencesPerDay: 1, days: 1 }}
        currencySymbol="$"
        perDiemRateMinor="4750"
        onApply={onApply}
      />,
    );
    expect(rateBox()).toHaveValue(99);
  });

  it('counts the heads beside the rate, derived rather than typed', async () => {
    /**
     * A second place to type the head count would let it disagree with the roster about
     * who is going.
     */
    const user = userEvent.setup();
    show({ attendees: [person('Ada')], occurrencesPerDay: 1, days: 1 });
    expect(screen.getByText('travel.attendees.people').nextSibling).toHaveTextContent('1');
    await user.click(addButton());
    await user.type(names()[1], 'Grace');
    expect(screen.getByText('travel.attendees.people').nextSibling).toHaveTextContent('2');
  });
});
