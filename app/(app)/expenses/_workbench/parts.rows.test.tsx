import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
// VeloExpense: ExpenseOS's combobox is an <input placeholder>; the kit's is a button.
import { getAllComboboxesByPlaceholder, queryComboboxByPlaceholder } from '@/test-utils/kitCombobox';
// VeloExpense: ExpenseOS's catalogue locale — what next-intl reports on every ported screen
// (i18n/request.ts) — named rather than spelled, for check-i18n's IL-1 scan.
import { DEFAULT_LOCALE as CATALOG_LOCALE } from '@expenseos/i18n';

/**
 * The workbench's row-level pieces: the left-pane expense row, a saved line item, a
 * draft line, and the attendee editor.
 *
 * The theme across all four is that a figure on screen must never contradict what the
 * server holds:
 *
 *   · **A foreign expense with no FX rate says so.** It is EXCLUDED from the report
 *     total, which is a different fact from converting to zero — and the version this
 *     replaces let an unconverted amount go quietly missing.
 *   · **A category change commits on its own.** It used to be folded into the amount
 *     commit, which silently returned when switching into mileage with no distance yet —
 *     so nothing was written and the row kept showing the old figure.
 *   · **Switching distance unit converts a MEASURED distance and reinterprets a typed
 *     one.** 100 km measured by the route IS 62.14 mi; somebody who typed 100 and
 *     pressed MI meant a hundred miles.
 *   · **A tip field starts BLANK, never "0.00".** The server treats `tip <= 0` as no tip,
 *     and a seeded zero also breaks typing — the first keystroke appends to it.
 */

const h = vi.hoisted(() => ({
  calls: {} as Record<string, unknown[]>,
  errors: {} as Record<string, string>,
  directory: [] as { id: string; name: string; email: string }[],
  /** Whether address lookup is on — the route dropdown appears only then. */
  lookup: false,
  /** Whether a browser key is set too, so a line may draw (and rebuild) its map. */
  map: false,
  /** What address search suggests, whatever is typed. */
  places: [] as { placeId: string; description: string }[],
  /** What a press of Calculate brings back; null leaves the request in flight. */
  routes: null as unknown[] | null,
  /** The person's previous routes, as `mileageRoute.recentRoutes` answers. */
  recent: [] as unknown[],
  /**
   * Hold every `expenses.*` write in flight until the test settles it: `mutate` records
   * the call and queues its callbacks in `settle` instead of running them.
   */
  deferred: false,
  settle: [] as (() => void)[],
}));

/** One stable `t`, so memo/effect deps do not churn. */
const t = (key: string, values?: Record<string, unknown>) =>
  values ? `${key}:${Object.values(values).join(',')}` : key;
t.has = () => false;

vi.mock('next-intl', () => ({ useTranslations: () => t, useLocale: () => 'en' }));

vi.mock('@/lib/trpc/client', () => {
  const procedure = (name: string) => ({
    useQuery: (_input?: unknown, qopts?: { enabled?: boolean }) => {
      if (name === 'attendeeDirectory') return { data: h.directory, isLoading: false };
      // The route workspace's footer price: answered, so Use this route is not held.
      if (name === 'mileagePreview' && qopts?.enabled !== false) {
        return { data: { ok: true, amountMinor: '28800' }, isLoading: false, error: null };
      }
      return { data: undefined, isLoading: false, isFetching: false, error: null };
    },
    useMutation: (opts?: {
      onSuccess?: () => void;
      onError?: (e: Error) => void;
      onSettled?: () => void;
    }) => ({
      isPending: false,
      // Per-call callbacks matter here: the editor passes `onError` at the CALL site so
      // a failed line create keeps its own row rather than clearing every draft.
      mutate: (
        vars: unknown,
        perCall?: { onSuccess?: () => void; onError?: (e: Error) => void },
      ) => {
        h.calls[name] ??= [];
        h.calls[name].push(vars);
        const finish = () => {
          const msg = h.errors[name];
          if (msg) {
            opts?.onError?.(new Error(msg));
            perCall?.onError?.(new Error(msg));
          } else {
            opts?.onSuccess?.();
            perCall?.onSuccess?.();
          }
          opts?.onSettled?.();
        };
        if (h.deferred) h.settle.push(finish);
        else finish();
      },
      // The route workspace's one write awaits its result: same record and same error
      // stub as `mutate`, and react-query's hook-level callbacks around it.
      mutateAsync: async (vars: unknown) => {
        h.calls[name] ??= [];
        h.calls[name].push(vars);
        const msg = h.errors[name];
        if (msg) {
          const e = new Error(msg);
          opts?.onError?.(e);
          opts?.onSettled?.();
          throw e;
        }
        opts?.onSuccess?.();
        opts?.onSettled?.();
        return undefined;
      },
    }),
  });
  const router = new Proxy({} as Record<string, unknown>, {
    get: (_t, key: string) => procedure(key),
  });
  return {
    trpc: {
      expenses: router,
      mileageRoute: {
        status: {
          useQuery: () => ({
            data: { available: h.lookup, mapAvailable: h.lookup && h.map },
            isLoading: false,
          }),
        },
        // Recorded, so "the read-only row never asks for the browser key" is a count.
        mapConfig: {
          useQuery: () => {
            h.calls.mapConfig ??= [];
            h.calls.mapConfig.push(undefined);
            return { data: { browserApiKey: 'browser-key', region: null }, isError: false };
          },
        },
        // FR-3's line path: recorded, and answered with a path to draw — what every other
        // answer does is `RouteLine.test.tsx`'s.
        lineRoutePath: {
          useMutation: () => ({
            isPending: false,
            mutateAsync: (vars: unknown) => {
              h.calls.lineRoutePath ??= [];
              h.calls.lineRoutePath.push(vars);
              return Promise.resolve({ encodedPolyline: 'drawn' });
            },
          }),
        },
        recentRoutes: {
          useQuery: () => ({ data: { routes: h.recent }, isLoading: false, error: null }),
        },
        searchPlaces: {
          // Recorded only while enabled: a disabled query sends nothing, and "did focus
          // send an address search?" is the question some tests ask.
          useQuery: (input: unknown, opts?: { enabled?: boolean }) => {
            if (opts?.enabled !== false) {
              h.calls.searchPlaces ??= [];
              h.calls.searchPlaces.push(input);
            }
            return { data: { items: h.places, error: null }, isFetching: false, error: null };
          },
        },
        computeRoutes: {
          // The workspace awaits each lookup; with no routes set it stays in flight.
          useMutation: () => ({
            isPending: false,
            mutateAsync: (vars: unknown) => {
              h.calls.computeRoutes ??= [];
              h.calls.computeRoutes.push(vars);
              return h.routes ? Promise.resolve({ routes: h.routes }) : new Promise(() => {});
            },
          }),
        },
        // A drop's conversion; no test here drags, so it is never answered.
        pointToPlace: {
          useMutation: () => ({ isPending: false, mutateAsync: () => new Promise(() => {}) }),
        },
        // A reopened route's points; no test here reopens one with points.
        viaLocations: {
          useMutation: () => ({ isPending: false, mutateAsync: () => new Promise(() => {}) }),
        },
      },
    },
  };
});

/** The small line map, stood in for: the real one needs Google's script. */
vi.mock('./RouteLineMap', () => ({
  default: (props: { encodedPolyline: string }) => (
    <div data-testid="line-map" data-path={props.encodedPolyline} />
  ),
}));

vi.mock('@/components/attachments/AttachmentViewer', () => ({
  AttachmentDocument: () => null,
  useViewerZoom: () => [1, vi.fn()],
  ZoomControls: () => null,
}));

import { ExpenseEditor, ExpenseListRow } from './parts';

const CAD = { id: 'cur-cad', code: 'CAD', symbol: '$', exponent: 2 };

const CATEGORIES = [
  { value: 'cat-meals', label: 'Meals', acceptsTip: true },
  { value: 'cat-taxi', label: 'Ground' },
  { value: 'cat-mileage', label: 'Mileage', isMileage: true },
];

const line = (over: Record<string, unknown> = {}) => ({
  id: 'line-1',
  categoryId: 'cat-taxi',
  category: {
    id: 'cat-taxi',
    label: { en: 'Ground' },
    icon: '🚕',
    color: '#2563eb',
    isMileage: false,
  },
  amountMinor: '4500',
  mileageDistance: null,
  mileageUnit: null,
  mileageRoute: null,
  receipts: [],
  kind: 'STANDARD',
  payload: null,
  ...over,
});

const expense = (over: Record<string, unknown> = {}) =>
  ({
    id: 'exp-1',
    merchant: 'City Cab',
    date: new Date('2026-08-01T00:00:00Z').toISOString(),
    amountMinor: '4500',
    currencyId: 'cur-cad',
    currency: CAD,
    homeCurrency: null,
    homeAmountMinor: null,
    placeText: null,
    purpose: null,
    explanation: null,
    paymentMethod: 'OUT_OF_POCKET',
    lineItems: [line()],
    receipts: [],
    attendees: [],
    allocations: [],
    taxGstHstMinor: null,
    taxQstMinor: null,
    taxPstMinor: null,
    recoverableGstHstMinor: null,
    recoverableQstMinor: null,
    taxSource: 'CALCULATED',
    subtotalMinor: null,
    fxRate: null,
    ...over,
  }) as never;

function renderEditor(over: Record<string, unknown> = {}, props: Record<string, unknown> = {}) {
  return render(
    <ExpenseEditor
      expense={expense(over)}
      violations={[]}
      currencySymbol="$"
      editable
      categoryItems={CATEGORIES}
      locale={CATALOG_LOCALE}
      onChange={vi.fn()}
      entityRecovers
      {...props}
    />,
  );
}

const sent = (name: string) => (h.calls[name] ?? []) as Record<string, unknown>[];

/** Pick a combobox option by its visible label. */
async function pick(
  user: ReturnType<typeof userEvent.setup>,
  placeholder: string,
  option: string | RegExp,
  index = 0,
) {
  // VeloExpense: the kit Combobox's trigger, by its placeholder (test-utils/kitCombobox).
  const boxes = getAllComboboxesByPlaceholder(placeholder);
  await user.click(boxes[index]);
  await user.click(await screen.findByRole('option', { name: option }));
}

beforeEach(() => {
  h.calls = {};
  h.errors = {};
  h.directory = [];
  h.lookup = false;
  h.map = false;
  h.places = [];
  h.routes = null;
  h.recent = [];
  h.deferred = false;
  h.settle = [];
});

/** A previous route as `mileageRoute.recentRoutes` returns it: Home → Office, 12 km. */
const PREVIOUS_ROUTE = {
  stops: [
    { placeId: 'home', description: 'Home' },
    { placeId: 'office', description: 'Office' },
  ],
  legs: [{ fromPlaceId: 'home', toPlaceId: 'office', meters: 12_000 }],
  routeLabel: 'Hwy 2',
  routeIndex: 0,
  routeCount: 2,
  distance: { KM: '12.00', MI: '7.46' },
};

/** A route as `mileageRoute.computeRoutes` returns it, for the stops p1 → p2. */
const wireRoute = (index: number, label: string | null) => ({
  index,
  label,
  totalMeters: 400_000 + index * 10_000,
  distance: `${400 + index * 10}.00`,
  durationSeconds: 14_400,
  legs: [{ fromPlaceId: 'p1', toPlaceId: 'p2', meters: 400_000 + index * 10_000 }],
  encodedPolyline: 'enc',
});

// ── The left-pane row ─────────────────────────────────────────────────────────

describe('<ExpenseListRow>', () => {
  const row = (over: Record<string, unknown> = {}, props: Record<string, unknown> = {}) =>
    render(
      <ul>
        <ExpenseListRow
          expense={expense(over)}
          locale={CATALOG_LOCALE}
          active={false}
          violationCount={0}
          onSelect={vi.fn()}
          {...props}
        />
      </ul>,
    );

  it('leads with the date and the vendor', () => {
    row();
    expect(screen.getByText('Aug 1')).toBeInTheDocument();
    expect(screen.getByText('City Cab')).toBeInTheDocument();
  });

  it('wraps a long vendor name instead of cutting it off', () => {
    /**
     * The vendor cell used to be `truncate`. In a pane this narrow that put the ellipsis
     * straight through the identifying part of the name — card feeds and receipt
     * extraction produce things like "SQ *THE COFFEE SHOP 4155551234 SAN FRANCISCO CA",
     * where everything distinguishing sits past the cut.
     *
     * Asserted on the classes rather than on geometry, because jsdom has no layout: there
     * are no real widths here, so nothing can be measured overflowing. What can be pinned
     * is the intent — no `truncate`, and `break-words` so one unbroken token breaks rather
     * than pushing the amount out of the row.
     */
    row({ merchant: 'SQ *THE COFFEE SHOP 4155551234 SAN FRANCISCO CA' });
    const cell = screen.getByText('SQ *THE COFFEE SHOP 4155551234 SAN FRANCISCO CA');
    expect(cell.className).not.toContain('truncate');
    expect(cell.className).toContain('break-words');
  });

  it('formats the date in UTC, so it does not shift a day', () => {
    /**
     * The expense date is a calendar date stored at UTC midnight, and the editor's input
     * reads it back with `toISOString`. Formatting the label in local time moves it a day
     * for anybody behind UTC — the list and the field would disagree.
     */
    row({ date: new Date('2026-08-01T00:00:00Z').toISOString() });
    expect(screen.getByText('Aug 1')).toBeInTheDocument();
  });

  it('says so plainly when there is no vendor yet', () => {
    row({ merchant: null });
    expect(screen.getByText('line.noMerchant')).toBeInTheDocument();
  });

  it('counts unresolved violations, and shows nothing at zero', () => {
    row({}, { violationCount: 3 });
    expect(screen.getByLabelText('line.violation')).toHaveTextContent('3');

    cleanup();
    row();
    expect(screen.queryByLabelText('line.violation')).not.toBeInTheDocument();
  });

  it('shows the home-currency equivalent for a foreign expense', () => {
    row({
      currency: { id: 'cur-usd', code: 'USD', symbol: '$', exponent: 2 },
      amountMinor: '10000',
      homeCurrency: 'CAD',
      homeAmountMinor: '13700',
      fxRate: '1.37',
    });
    expect(screen.getByText('≈ 137.00 CAD')).toBeInTheDocument();
  });

  it('says a rate is MISSING rather than converting to nothing', () => {
    /**
     * The expense is excluded from the report total when there is no rate. Rendering it
     * as zero — or omitting the line — is how a foreign charge goes quietly missing,
     * which is the failure this replaces.
     */
    row({
      currency: { id: 'cur-eur', code: 'EUR', symbol: '€', exponent: 2 },
      amountMinor: '5000',
      homeCurrency: 'CAD',
      homeAmountMinor: null,
      fxRate: null,
    });
    expect(screen.getByText('workbench.fxNoRate:EUR')).toBeInTheDocument();
  });

  it('shows no conversion at all when the expense is already in the home currency', () => {
    // Nothing to convert, so no second line — the figure above is the figure.
    row({ homeCurrency: 'CAD', homeAmountMinor: '4500', fxRate: '1' });
    expect(screen.queryByText(/^≈/)).not.toBeInTheDocument();
    expect(screen.queryByText(/fxNoRate/)).not.toBeInTheDocument();
  });

  it('pills each distinct category once, however many lines share it', () => {
    // Three dinners on one expense is one "Meals" pill, not three.
    row({
      lineItems: [
        line({ id: 'a' }),
        line({ id: 'b' }),
        line({
          id: 'c',
          categoryId: 'cat-meals',
          category: {
            id: 'cat-meals',
            label: { en: 'Meals' },
            icon: '🍽️',
            color: '#111111',
            isMileage: false,
          },
        }),
      ],
    });
    expect(screen.getAllByText('Ground')).toHaveLength(1);
    expect(screen.getByText('Meals')).toBeInTheDocument();
  });

  it('counts attendees and receipts only when there are some', () => {
    row({
      attendees: [{ id: 'a1', name: 'Ada', company: null, isExternal: false }],
      receipts: [{ id: 'r1' }, { id: 'r2' }],
    });
    expect(screen.getByText('1')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();

    cleanup();
    row();
    // Neither count renders for an expense with no attendees and no receipts.
    expect(screen.queryByText('1')).not.toBeInTheDocument();
    expect(screen.queryByText('2')).not.toBeInTheDocument();
  });

  it('shows the tax total only when there is tax', () => {
    row({ taxGstHstMinor: '585', taxQstMinor: '100' });
    expect(screen.getByText(/workbench.taxLabel/)).toHaveTextContent('$6.85 CAD');
  });

  /**
   * Every figure on this row — the amount, the converted equivalent, the tax —
   * went through a local `money()` helper that called a formatter which pasted
   * the stored symbol in front of `toLocaleString(undefined, …)`. `undefined` is
   * the RUNTIME's locale, not the reader's, so a French-Canadian reviewing this
   * list saw American money; and the leading-symbol template could not produce
   * the trailing-symbol form at all.
   *
   * Asserted per figure and in both locales. A single-locale test would pass on
   * a build that hardcodes `en` — which is exactly the build being replaced.
   */
  describe('every figure follows the READER, not the runtime', () => {
    /** Intl groups fr-CA with a NO-BREAK space; escaped so a review can see it. */
    const NBSP = '\u00A0';
    /** Testing Library's default normalizer collapses U+00A0 to an ASCII space,
     *  which would hide the separator this is asserting on. Trim only. */
    const EXACT = { normalizer: (str: string) => str.trim() };

    it('renders the row amount with the symbol on the locale’s side', () => {
      row({ amountMinor: '1079900' }, { locale: 'fr-CA' });
      expect(screen.getByText(`10${NBSP}799,00${NBSP}$ CAD`, EXACT)).toBeInTheDocument();
      // The ASCII-space form must NOT match; if it starts to, the normalizer has
      // been reintroduced and the assertion above proves nothing.
      expect(screen.queryByText('10 799,00 $ CAD', EXACT)).not.toBeInTheDocument();
      cleanup();

      row({ amountMinor: '1079900' }, { locale: CATALOG_LOCALE });
      expect(screen.getByText('$10,799.00 CAD', EXACT)).toBeInTheDocument();
      expect(screen.queryByText(`10${NBSP}799,00${NBSP}$ CAD`, EXACT)).not.toBeInTheDocument();
    });

    it('gives the SAME amount two DIFFERENT strings in en and fr-CA', () => {
      // The assertion no single-locale build can satisfy, whichever it picks.
      // Read off raw `textContent` so nothing normalizes the separator away.
      const fr = row({ amountMinor: '1079900' }, { locale: 'fr-CA' }).container.textContent;
      cleanup();
      const en = row({ amountMinor: '1079900' }, { locale: CATALOG_LOCALE }).container.textContent;
      expect(fr).not.toBe(en);
      expect(fr).toContain(`10${NBSP}799,00${NBSP}$`);
      expect(en).toContain('$10,799.00');
    });

    it('follows the reader for the tax figure too', () => {
      row({ taxGstHstMinor: '585', taxQstMinor: '100' }, { locale: 'fr-CA' });
      // Raw `textContent`, not `toHaveTextContent`: that matcher normalizes
      // whitespace and would collapse U+00A0 to an ASCII space — the separator
      // under test.
      expect(screen.getByText(/workbench.taxLabel/).textContent).toContain(`6,85${NBSP}$ CAD`);
      expect(screen.getByText(/workbench.taxLabel/).textContent).not.toContain('6,85 $ CAD');
    });

    it('follows the reader for the converted foreign equivalent too', () => {
      // The second line under a foreign charge — the figure the employee is
      // actually paid. It reads through the same helper as the amount above it.
      row(
        {
          currency: { id: 'cur-usd', code: 'USD', symbol: '$', exponent: 2 },
          amountMinor: '10000',
          homeCurrency: 'CAD',
          homeAmountMinor: '13700',
          fxRate: '1.37',
        },
        { locale: 'fr-CA' },
      );
      expect(screen.getByText(`≈ 137,00 CAD`, EXACT)).toBeInTheDocument();
      expect(screen.queryByText('≈ 137.00 CAD', EXACT)).not.toBeInTheDocument();
    });
  });

  it('offers a checkbox only where the list is selectable', () => {
    row({}, { selectable: true, selected: false, onToggleSelected: vi.fn() });
    expect(screen.getByRole('checkbox')).toBeInTheDocument();

    cleanup();
    row();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });
});

// ── A saved line item ─────────────────────────────────────────────────────────

describe('a saved line item', () => {
  it('commits a category change on its own, with no amount', async () => {
    /**
     * The change used to be folded into the amount commit, which returned silently when
     * switching into mileage with no distance yet — nothing was written and the row kept
     * showing the old figure. The server owns what a line of the new kind should hold.
     */
    const user = userEvent.setup();
    renderEditor();
    await pick(user, 'addLine.categoryPlaceholder', 'Meals');
    expect(sent('lineItemUpdate')).toContainEqual({ id: 'line-1', categoryId: 'cat-meals' });
  });

  it('writes nothing when the category is cleared', async () => {
    // A line IS a category plus an amount; a cleared selection is not a state worth
    // persisting.
    const user = userEvent.setup();
    renderEditor();
    const box = getAllComboboxesByPlaceholder('addLine.categoryPlaceholder')[0];
    await user.click(box);
    await user.keyboard('{Escape}');
    expect(sent('lineItemUpdate')).toHaveLength(0);
  });

  it('carries no amount across the mileage boundary', async () => {
    /**
     * A typed amount is not a distance. The commit is the category ALONE — the server
     * clears the columns that no longer apply and re-derives the rest, which is why the
     * row does not try to guess what a mileage line of this amount would mean.
     */
    const user = userEvent.setup();
    renderEditor();
    expect(screen.getByLabelText('line.amount')).toHaveValue('45.00');
    await pick(user, 'addLine.categoryPlaceholder', 'Mileage');
    expect(sent('lineItemUpdate').at(-1)).toEqual({ id: 'line-1', categoryId: 'cat-mileage' });
  });

  it('surfaces a refused reprice on the row rather than keeping the old figure', async () => {
    /**
     * Switching an existing line into mileage can be refused — a traveller with no
     * country, or a country with no rate in force. Invisibly keeping the old amount is
     * worse than an error, because it looks like it worked.
     */
    h.errors.lineItemUpdate = 'No country on the traveller — cannot resolve a mileage rate.';
    const user = userEvent.setup();
    renderEditor();
    await pick(user, 'addLine.categoryPlaceholder', 'Mileage');
    expect(await screen.findByRole('alert')).toHaveTextContent('No country on the traveller');
  });

  it('saves the amount on blur', async () => {
    const user = userEvent.setup();
    renderEditor();
    const amount = screen.getByLabelText('line.amount');
    await user.clear(amount);
    await user.type(amount, '62.50');
    await user.tab();
    expect(sent('lineItemUpdate').at(-1)).toMatchObject({ id: 'line-1', amountMinor: '6250' });
  });

  it('marks an empty amount, because a line needs one', async () => {
    const user = userEvent.setup();
    renderEditor();
    const amount = screen.getByLabelText('line.amount');
    await user.clear(amount);
    expect(amount.className).toContain('border-destructive');
  });

  it('deletes the line', async () => {
    const user = userEvent.setup();
    renderEditor();
    // The header's delete is first; the row's own is next.
    await user.click(screen.getAllByRole('button', { name: 'actions.delete' })[1]);
    expect(sent('lineItemRemove')[0]).toEqual({ id: 'line-1' });
  });

  it('offers a tip field only where the category takes one', async () => {
    /**
     * `acceptsTip` on the category is what makes the field exist. Without the gate a tip
     * appears on a software renewal, and an approver has to ask about it.
     */
    renderEditor({ lineItems: [line({ categoryId: 'cat-meals' })] });
    expect(screen.getByLabelText(/lineKinds.tip/)).toBeInTheDocument();

    cleanup();
    renderEditor();
    expect(screen.queryByLabelText(/lineKinds.tip/)).not.toBeInTheDocument();
  });

  it('starts the tip field blank rather than at zero', async () => {
    /**
     * `tipMinorOf` returns 0n for a line with no tip. Seeding "0.00" misrepresents it —
     * the server treats `tip <= 0` as no tip — and breaks typing, because the first
     * keystroke appends to the zero and yields NaN.
     */
    renderEditor({ lineItems: [line({ categoryId: 'cat-meals' })] });
    expect(screen.getByLabelText(/lineKinds.tip/)).toHaveValue('');
  });

  it('commits the tip on blur, nulling it when emptied', async () => {
    const user = userEvent.setup();
    renderEditor({ lineItems: [line({ categoryId: 'cat-meals' })] });
    const tip = screen.getByLabelText(/lineKinds.tip/);
    await user.type(tip, '5.00');
    await user.tab();
    expect(sent('lineItemUpdate').at(-1)).toMatchObject({ tipMinor: '500' });

    await user.clear(tip);
    await user.tab();
    expect(sent('lineItemUpdate').at(-1)).toMatchObject({ tipMinor: null });
  });

  it('drops the tip when the category stops accepting one', async () => {
    // Otherwise the field disappears with a value still in it, and the next commit
    // would carry a tip the new category has no place for.
    const user = userEvent.setup();
    renderEditor({ lineItems: [line({ categoryId: 'cat-meals' })] });
    await user.type(screen.getByLabelText(/lineKinds.tip/), '5.00');
    await pick(user, 'addLine.categoryPlaceholder', 'Ground');
    expect(screen.queryByLabelText(/lineKinds.tip/)).not.toBeInTheDocument();
  });
});

// ── Mileage on a saved line ───────────────────────────────────────────────────

/**
 * A saved mileage line is LOCKED until Edit route, and Save is its one write (FR-6).
 *
 * Every stop edit, unit switch and blur used to autosave, so a route half-way through
 * being changed reached the server — "my route changed under me" (#577/#578). These pin
 * the replacement: nothing is written while the line is being edited, Cancel writes
 * nothing and puts the stored line back, and Save sends exactly one update carrying the
 * distance, the unit and the route together.
 */
describe('a mileage line', () => {
  const mileage = (over: Record<string, unknown> = {}) =>
    line({
      categoryId: 'cat-mileage',
      category: {
        id: 'cat-mileage',
        label: { en: 'Mileage' },
        icon: '🚗',
        color: '#111',
        isMileage: true,
      },
      mileageDistance: '100',
      mileageUnit: 'KM',
      ...over,
    });

  /** A route measured by an earlier lookup, stored with the line. */
  const MEASURED = {
    stops: [
      { description: 'Halifax', placeId: 'p1' },
      { description: 'Truro', placeId: 'p2' },
    ],
  };

  const editRoute = () => screen.getByRole('button', { name: 'route.editRoute' });
  const saveButton = () => screen.getByRole('button', { name: 'addLine.saveEdit' });
  const cancelButton = () => screen.getByRole('button', { name: 'addLine.cancel' });
  const distance = () => screen.getByLabelText('line.distance');

  it('shows a distance rather than an amount', () => {
    // The amount is derived server-side from the rate in force, so it is not typed.
    renderEditor({ lineItems: [mileage()] });
    expect(distance()).toHaveValue('100');
  });

  describe('once saved', () => {
    it('is locked: distance and unit disabled, and Edit route the only control', () => {
      renderEditor({ lineItems: [mileage()] });
      expect(distance()).toBeDisabled();
      // The unit is locked with the route: switching it would change the claim.
      expect(screen.getByRole('button', { name: 'KM' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'MI' })).toBeDisabled();
      expect(editRoute()).toBeEnabled();
      expect(screen.queryByRole('button', { name: 'addLine.saveEdit' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'addLine.cancel' })).not.toBeInTheDocument();
    });

    it("keeps its stored unit when the owner's new lines open in miles (FR-11 1.A)", () => {
      // The owner's default is for a NEW line only; nothing re-defaults a saved one.
      renderEditor({ mileageDefaultUnit: 'MI', lineItems: [mileage()] });
      expect(screen.getByRole('button', { name: 'KM' })).toHaveAttribute('aria-pressed', 'true');
      expect(screen.getByRole('button', { name: 'MI' })).toHaveAttribute('aria-pressed', 'false');
      expect(distance()).toHaveValue('100');
    });

    it('says which route Edit route would change, because the locked fields are skipped', () => {
      // Disabled inputs leave the tab order and many screen readers pass over them, so
      // the one focusable control carries the route and the distance as its description.
      renderEditor({ lineItems: [mileage({ mileageRoute: MEASURED })] });
      expect(editRoute()).toHaveAccessibleDescription(
        'route.lockedSummary:Halifax → Truro,line.distanceValue:100,line.km',
      );
    });

    it('with lookup on, shows no stop fields of its own: the route has its own control', () => {
      // A route with no legs cannot vouch for the distance, so this line is on the typed
      // path — and its stops are still never editable fields on the row.
      h.lookup = true;
      renderEditor({ lineItems: [mileage({ mileageRoute: MEASURED })] });
      expect(screen.queryByLabelText('from')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'calculate' })).not.toBeInTheDocument();
      expect(screen.getByRole('combobox', { name: 'route.dropdownLabel' })).toBeInTheDocument();
    });
  });

  describe('in Edit mode', () => {
    it('writes NOTHING on a typed distance, its blur, or a unit switch', async () => {
      const user = userEvent.setup();
      renderEditor({ lineItems: [mileage()] });
      await user.click(editRoute());
      expect(distance()).toBeEnabled();

      await user.clear(distance());
      await user.type(distance(), '150');
      // The blur that used to autosave.
      await user.tab();
      await user.click(screen.getByRole('button', { name: 'MI' }));

      expect(sent('lineItemUpdate')).toHaveLength(0);
    });

    it('Cancel puts the stored line back and sends nothing', async () => {
      const user = userEvent.setup();
      renderEditor({ lineItems: [mileage()] });
      await user.click(editRoute());
      await user.clear(distance());
      await user.type(distance(), '150');
      await user.tab();
      await user.click(screen.getByRole('button', { name: 'MI' }));

      await user.click(cancelButton());

      expect(sent('lineItemUpdate')).toHaveLength(0);
      expect(distance()).toHaveValue('100');
      expect(distance()).toBeDisabled();
      expect(screen.getByRole('button', { name: 'KM' })).toHaveAttribute('aria-pressed', 'true');
      expect(editRoute()).toBeInTheDocument();
    });

    it('Save sends exactly ONE update with distance, unit and route, then locks again', async () => {
      const user = userEvent.setup();
      renderEditor({ lineItems: [mileage()] });
      await user.click(editRoute());
      await user.clear(distance());
      await user.type(distance(), '150');
      await user.click(screen.getByRole('button', { name: 'MI' }));

      await user.click(saveButton());

      expect(sent('lineItemUpdate')).toEqual([
        {
          id: 'line-1',
          categoryId: 'cat-mileage',
          mileageDistance: '150',
          mileageUnit: 'MI',
          // No `mileageRoute` key: only the workspace's accept writes the route.
        },
      ]);
      expect(distance()).toBeDisabled();
      expect(distance()).toHaveValue('150');
      expect(editRoute()).toBeInTheDocument();
    });

    it('offers Save only once the distance is valid AND differs from the stored line', async () => {
      const user = userEvent.setup();
      renderEditor({ lineItems: [mileage()] });
      await user.click(editRoute());
      expect(saveButton()).toBeDisabled();

      await user.clear(distance());
      expect(saveButton()).toBeDisabled();
      // The same distance, written differently, is not a change.
      await user.type(distance(), '100.00');
      expect(saveButton()).toBeDisabled();

      await user.clear(distance());
      await user.type(distance(), '101');
      expect(saveButton()).toBeEnabled();
    });

    it('reinterprets a TYPED distance when the unit changes', async () => {
      /**
       * Somebody who typed 100 and pressed MI meant a hundred miles — converting it would
       * be the app deciding they meant something else.
       */
      const user = userEvent.setup();
      renderEditor({ lineItems: [mileage({ mileageRoute: null })] });
      await user.click(editRoute());
      await user.click(screen.getByRole('button', { name: 'MI' }));
      expect(distance()).toHaveValue('100');
      expect(sent('lineItemUpdate')).toHaveLength(0);

      await user.click(saveButton());
      expect(sent('lineItemUpdate')).toEqual([
        expect.objectContaining({ mileageDistance: '100', mileageUnit: 'MI' }),
      ]);
    });

    it('converts a MEASURED distance when the unit changes, and back exactly', async () => {
      /**
       * 100 km measured by the route IS 62.14 mi — the same journey. Switching back lands
       * on the stored figure itself rather than on 62.14 mi converted again, so a round
       * trip is not a "change" for Save to offer.
       */
      const user = userEvent.setup();
      renderEditor({ lineItems: [mileage({ mileageRoute: MEASURED })] });
      await user.click(editRoute());

      await user.click(screen.getByRole('button', { name: 'MI' }));
      expect(distance()).toHaveValue('62.14');
      await user.click(screen.getByRole('button', { name: 'KM' }));
      expect(distance()).toHaveValue('100');
      expect(saveButton()).toBeDisabled();

      await user.click(screen.getByRole('button', { name: 'MI' }));
      await user.click(saveButton());
      // The route is left as stored: an absent key, never a copy sent back.
      expect(sent('lineItemUpdate')).toEqual([
        { id: 'line-1', categoryId: 'cat-mileage', mileageDistance: '62.14', mileageUnit: 'MI' },
      ]);
    });

    it('keeps Edit mode, with the changes, when the server refuses the save', async () => {
      h.errors.lineItemUpdate = 'No mileage rate in force for CA on this date.';
      const user = userEvent.setup();
      renderEditor({ lineItems: [mileage()] });
      await user.click(editRoute());
      await user.clear(distance());
      await user.type(distance(), '150');
      await user.click(saveButton());

      expect(await screen.findByRole('alert')).toHaveTextContent('No mileage rate in force');
      expect(distance()).toBeEnabled();
      expect(distance()).toHaveValue('150');
      expect(saveButton()).toBeInTheDocument();
      expect(sent('lineItemUpdate')).toHaveLength(1);
    });

    it('takes focus into the line on Edit, and back to Edit route on Cancel and Save', async () => {
      // The pressed button disappears each time; without this, focus falls to the page.
      const user = userEvent.setup();
      renderEditor({ lineItems: [mileage()] });
      await user.click(editRoute());
      expect(distance()).toHaveFocus();

      await user.click(cancelButton());
      expect(editRoute()).toHaveFocus();

      await user.click(editRoute());
      await user.clear(distance());
      await user.type(distance(), '150');
      await user.click(saveButton());
      expect(editRoute()).toHaveFocus();
    });

    it('a category change cancels the edit first, then writes the category ALONE', async () => {
      // Never the half-edited distance or unit along with it.
      const user = userEvent.setup();
      renderEditor({ lineItems: [mileage()] });
      await user.click(editRoute());
      await user.clear(distance());
      await user.type(distance(), '150');
      await user.click(screen.getByRole('button', { name: 'MI' }));

      await pick(user, 'addLine.categoryPlaceholder', 'Ground');

      expect(sent('lineItemUpdate')).toEqual([{ id: 'line-1', categoryId: 'cat-taxi' }]);
    });

    it('a change to ANOTHER mileage category leaves the line locked on its stored figures', async () => {
      // The row stays a mileage row, so this is where a surviving edit would show: the
      // draft 150 MI must be gone, not carried into the new category's line.
      const user = userEvent.setup();
      renderEditor(
        { lineItems: [mileage()] },
        {
          categoryItems: [
            ...CATEGORIES,
            { value: 'cat-mileage-truck', label: 'Mileage (truck)', isMileage: true },
          ],
        },
      );
      await user.click(editRoute());
      await user.clear(distance());
      await user.type(distance(), '150');
      await user.click(screen.getByRole('button', { name: 'MI' }));

      await pick(user, 'addLine.categoryPlaceholder', 'Mileage (truck)');

      expect(sent('lineItemUpdate')).toEqual([{ id: 'line-1', categoryId: 'cat-mileage-truck' }]);
      expect(distance()).toHaveValue('100');
      expect(distance()).toBeDisabled();
      expect(screen.getByRole('button', { name: 'KM' })).toHaveAttribute('aria-pressed', 'true');
      expect(editRoute()).toBeInTheDocument();
    });

    it('ends when the report turns read-only, so it never comes back in Edit', async () => {
      const user = userEvent.setup();
      const { rerender } = renderEditor({ lineItems: [mileage()] });
      await user.click(editRoute());
      await user.clear(distance());
      await user.type(distance(), '150');

      const editor = (editable: boolean) => (
        <ExpenseEditor
          expense={expense({ lineItems: [mileage()] })}
          violations={[]}
          currencySymbol="$"
          editable={editable}
          categoryItems={CATEGORIES}
          locale={CATALOG_LOCALE}
          onChange={vi.fn()}
          entityRecovers
        />
      );
      rerender(editor(false));
      rerender(editor(true));

      expect(editRoute()).toBeInTheDocument();
      expect(distance()).toBeDisabled();
      expect(distance()).toHaveValue('100');
      expect(sent('lineItemUpdate')).toHaveLength(0);
    });
  });

  it('opens straight in Edit when there is no saved distance — Save, and no Cancel', async () => {
    // A line just switched into a mileage category: there is nothing to lock, and no
    // stored line to cancel back to.
    const user = userEvent.setup();
    renderEditor({ lineItems: [mileage({ mileageDistance: null, mileageUnit: null })] });
    expect(distance()).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'route.editRoute' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'addLine.cancel' })).not.toBeInTheDocument();
    expect(saveButton()).toBeDisabled();

    await user.type(distance(), '80');
    await user.tab();
    expect(sent('lineItemUpdate')).toHaveLength(0);

    await user.click(saveButton());
    expect(sent('lineItemUpdate')).toEqual([
      expect.objectContaining({ mileageDistance: '80', mileageUnit: 'KM' }),
    ]);
  });

  it('sends ONE update however often Save is pressed before the refetch lands', async () => {
    /**
     * A line with no saved distance stays in Edit until the refetch brings the distance it
     * was just given, so between the success and the refetch its draft still differs from
     * the server's copy. Save used to be enabled again there, and a second press sent a
     * second write; a double-click got two before `isPending` re-rendered.
     */
    h.deferred = true;
    const user = userEvent.setup();
    const { rerender } = renderEditor({
      lineItems: [mileage({ mileageDistance: null, mileageUnit: null })],
    });
    await user.type(distance(), '80');

    await user.dblClick(saveButton());
    expect(sent('lineItemUpdate')).toHaveLength(1);

    // The write succeeds; the refetch has not landed yet.
    act(() => {
      for (const finish of h.settle.splice(0)) finish();
    });
    expect(saveButton()).toBeDisabled();
    await user.click(saveButton());
    expect(sent('lineItemUpdate')).toHaveLength(1);

    // The refetch brings the saved distance, and the line locks on it.
    rerender(
      <ExpenseEditor
        expense={expense({ lineItems: [mileage({ mileageDistance: '80' })] })}
        violations={[]}
        currencySymbol="$"
        editable
        categoryItems={CATEGORIES}
        locale={CATALOG_LOCALE}
        onChange={vi.fn()}
        entityRecovers
      />,
    );
    expect(editRoute()).toBeInTheDocument();
    expect(distance()).toHaveValue('80');
  });

  describe('with address lookup on', () => {
    /** Toronto → Ottawa, 100 km by its one leg: the line's distance is what its legs say. */
    const LEGS = [{ fromPlaceId: 'p1', toPlaceId: 'p2', meters: 100_000 }];
    const ROUTED = {
      stops: [
        { placeId: 'p1', description: 'Toronto' },
        { placeId: 'p2', description: 'Ottawa' },
      ],
      legs: LEGS,
      routeLabel: 'Hwy 401',
      routeIndex: 1,
      routeCount: 3,
    };
    const POINTS = [{ lat: 44.5, lng: -77.1, leg: 0 }];
    /**
     * A line carrying the drawn path and lat/lng points stored geometry once had. The server
     * no longer sends them; nothing here may read or write them back.
     */
    const OLD_KEYS = {
      ...ROUTED,
      encodedPolyline: 'stored',
      passThrough: POINTS,
    };

    const routeLine = (over: Record<string, unknown> = {}) =>
      mileage({ mileageRoute: ROUTED, ...over });
    const dropdown = () => screen.getByRole('combobox', { name: 'route.dropdownLabel' });
    async function choose(user: ReturnType<typeof userEvent.setup>, option: RegExp | string) {
      await user.click(dropdown());
      await user.click(await screen.findByRole('option', { name: option }));
    }
    const useButton = () => screen.getByRole('button', { name: 'route.picker.useRoute' });

    it('a line measured by its legs has no lock: no Edit, no Save, no stop fields', () => {
      h.lookup = true;
      renderEditor({ lineItems: [routeLine()] });
      expect(screen.queryByRole('button', { name: 'route.editRoute' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'line.editDistance' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'addLine.saveEdit' })).not.toBeInTheDocument();
      expect(screen.queryByLabelText('from')).not.toBeInTheDocument();
      expect(screen.queryByLabelText('line.distance')).not.toBeInTheDocument();
      // The dropdown's closed state reads the route; the unit toggle is live.
      expect(dropdown()).toHaveTextContent('route.previousRouteEnds:Toronto,Ottawa');
      expect(dropdown()).toHaveTextContent('route.picker.via:Hwy 401');
      expect(screen.getByRole('button', { name: 'MI' })).toBeEnabled();
      expect(screen.getByText('100')).toBeInTheDocument();
    });

    it('KM/MI shows the other unit from the legs and writes NOTHING; back is exact', async () => {
      h.lookup = true;
      const user = userEvent.setup();
      renderEditor({ lineItems: [routeLine()] });
      const amount = screen.getByLabelText('line.amount').textContent;

      await user.click(screen.getByRole('button', { name: 'MI' }));
      // 100 000 m is 62.137… mi.
      expect(screen.getByText('62.14')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'MI' })).toHaveAttribute('aria-pressed', 'true');
      // The claim is in the rule's unit: its price does not move.
      expect(screen.getByLabelText('line.amount').textContent).toBe(amount);

      await user.click(screen.getByRole('button', { name: 'KM' }));
      // The stored figure itself, not 62.14 mi converted back.
      expect(screen.getByText('100')).toBeInTheDocument();

      expect(sent('lineItemUpdate')).toHaveLength(0);
      expect(sent('mileagePreview')).toHaveLength(0);
    });

    it('an override line (distance not the legs) renders the typed path with the lock', async () => {
      h.lookup = true;
      const user = userEvent.setup();
      renderEditor({ lineItems: [routeLine({ mileageDistance: '120' })] });
      const edit = screen.getByRole('button', { name: 'line.editDistance' });
      expect(distance()).toBeDisabled();
      expect(distance()).toHaveValue('120');
      expect(screen.getByRole('button', { name: 'MI' })).toBeDisabled();
      // The route control is still there; changing the route is the workspace's job.
      expect(dropdown()).toBeInTheDocument();

      await user.click(edit);
      await user.clear(distance());
      await user.type(distance(), '125');
      await user.click(saveButton());
      // The typed path's Save never carries the route.
      expect(sent('lineItemUpdate')).toEqual([
        { id: 'line-1', categoryId: 'cat-mileage', mileageDistance: '125', mileageUnit: 'KM' },
      ]);
    });

    it('a category change writes the category ALONE, never the route', async () => {
      h.lookup = true;
      const user = userEvent.setup();
      renderEditor({ lineItems: [routeLine({ mileageRoute: OLD_KEYS })] });
      await pick(user, 'addLine.categoryPlaceholder', 'Ground');
      expect(sent('lineItemUpdate')).toEqual([{ id: 'line-1', categoryId: 'cat-taxi' }]);
    });

    it('Change route reopens the line as stored with ONE request, and an unchanged accept is ONE update writing it back', async () => {
      h.lookup = true;
      h.routes = [wireRoute(0, 'Hwy 401')];
      const user = userEvent.setup();
      renderEditor({ lineItems: [routeLine({ mileageRoute: OLD_KEYS })] });
      await choose(user, 'changeRoute');

      expect(screen.getByRole('dialog')).toBeInTheDocument();
      expect(screen.getByLabelText('from')).toHaveValue('Toronto');
      expect(screen.getByLabelText('to')).toHaveValue('Ottawa');
      // The stored path is not reused: the stops are routed once.
      expect(sent('computeRoutes')).toEqual([{ placeIds: ['p1', 'p2'], unit: 'KM' }]);

      await screen.findByRole('radio');
      await user.click(useButton());
      const updates = sent('lineItemUpdate');
      expect(updates).toHaveLength(1);
      // Unchanged: the route as stored and its stored distance (spec FR-4 step 5), with none
      // of the old geometry keys the line still carried.
      expect(updates[0]).toMatchObject({
        id: 'line-1',
        categoryId: 'cat-mileage',
        mileageDistance: '100.00',
        mileageUnit: 'KM',
      });
      expect(updates[0]?.mileageRoute).toEqual(ROUTED);
      expect(sent('computeRoutes')).toHaveLength(1);
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      // Focus returns to the line's dropdown (NFR-12).
      await waitFor(() => expect(dropdown()).toHaveFocus());
    });

    it('Change route on a line saved without a path opens on its named stops with ONE request', async () => {
      h.lookup = true;
      const user = userEvent.setup();
      renderEditor({ lineItems: [routeLine()] });
      await choose(user, 'changeRoute');
      expect(sent('computeRoutes')).toEqual([{ placeIds: ['p1', 'p2'], unit: 'KM' }]);
    });

    it('Change route opens again when picked a second time in a row', async () => {
      h.lookup = true;
      const user = userEvent.setup();
      renderEditor({ lineItems: [routeLine({ mileageRoute: OLD_KEYS })] });
      await choose(user, 'changeRoute');
      await user.keyboard('{Escape}');
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      await choose(user, 'changeRoute');
      expect(screen.getByRole('dialog')).toBeInTheDocument();
      expect(sent('lineItemUpdate')).toHaveLength(0);
    });

    it('a previous route is routed by its stops with ONE request, and writes nothing Google drew', async () => {
      // Even were an entry to carry the old geometry keys, it is reused by its stops.
      h.lookup = true;
      h.recent = [{ ...PREVIOUS_ROUTE, encodedPolyline: 'prev', passThrough: [] }];
      h.routes = [
        {
          ...wireRoute(0, 'Hwy 2'),
          legs: [{ fromPlaceId: 'home', toPlaceId: 'office', meters: 12_500 }],
          totalMeters: 12_500,
        },
      ];
      const user = userEvent.setup();
      renderEditor({ lineItems: [routeLine()] });
      await choose(user, /previousRouteEnds:Home,Office/);
      expect(sent('computeRoutes')).toEqual([{ placeIds: ['home', 'office'], unit: 'KM' }]);

      await screen.findByRole('radio');
      await user.click(useButton());
      const [update] = sent('lineItemUpdate');
      expect(update?.mileageRoute).toMatchObject({ stops: PREVIOUS_ROUTE.stops });
      expect(JSON.stringify(update)).not.toMatch(/encodedPolyline|passThrough|via/);
    });

    it('with no saved distance, the line is the dropdown alone: no Save, no typed box', () => {
      h.lookup = true;
      renderEditor({ lineItems: [mileage({ mileageDistance: null, mileageUnit: null })] });
      expect(dropdown()).toBeInTheDocument();
      expect(screen.queryByLabelText('line.distance')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'addLine.saveEdit' })).not.toBeInTheDocument();
    });

    it('a read-only line keeps its text summary: no dropdown, no map, no key read, no path call', () => {
      h.lookup = true;
      h.map = true;
      renderEditor(
        {
          lineItems: [
            routeLine({ mileageRoute: OLD_KEYS, kind: 'MILEAGE' }),
            routeLine({ id: 'line-2', kind: 'MILEAGE' }),
          ],
        },
        { editable: false },
      );
      expect(screen.queryByRole('combobox', { name: 'route.dropdownLabel' })).toBeNull();
      expect(screen.queryByTestId('line-map')).toBeNull();
      expect(sent('mapConfig')).toHaveLength(0);
      expect(sent('lineRoutePath')).toHaveLength(0);
    });

    it('each writer line with a browser key asks for its path once and draws it — never the stored one', async () => {
      h.lookup = true;
      h.map = true;
      renderEditor({
        lineItems: [routeLine({ mileageRoute: OLD_KEYS }), routeLine({ id: 'line-2' })],
      });
      await waitFor(() => expect(screen.getAllByTestId('line-map')).toHaveLength(2));
      for (const map of screen.getAllByTestId('line-map')) {
        expect(map).toHaveAttribute('data-path', 'drawn');
      }
      expect(sent('lineRoutePath')).toEqual([{ lineItemId: 'line-1' }, { lineItemId: 'line-2' }]);
    });
  });
});

// ── Draft rows ────────────────────────────────────────────────────────────────

describe('a draft line', () => {
  const addDraft = async (user: ReturnType<typeof userEvent.setup>) => {
    renderEditor({ lineItems: [] });
    await user.click(screen.getByRole('button', { name: /drawer.addLine/ }));
  };

  it('commits the moment a non-mileage category is chosen — there is no Add button', async () => {
    /**
     * The amount is optional server-side, so the row commits on the category alone and
     * the amount is typed into the real line. One gesture fewer, and it is the point at
     * which the line's own fields (a tip) can appear at all.
     */
    const user = userEvent.setup();
    await addDraft(user);
    await pick(user, 'addLine.categoryPlaceholder', 'Ground');
    expect(sent('lineItemCreate')[0]).toMatchObject({ expenseId: 'exp-1', categoryId: 'cat-taxi' });
  });

  it('offers no save button for a category that already committed', async () => {
    // A button that does nothing.
    const user = userEvent.setup();
    await addDraft(user);
    expect(screen.queryByRole('button', { name: 'addLine.save' })).not.toBeInTheDocument();
  });

  it('makes a mileage row collect its distance first', async () => {
    /**
     * The SERVER draws this line, not the component: `computeLineFinancials` refuses a
     * mileage line with no distance, and the flag that allows one exists only for
     * switching an EXISTING line.
     */
    const user = userEvent.setup();
    await addDraft(user);
    await pick(user, 'addLine.categoryPlaceholder', 'Mileage');
    expect(sent('lineItemCreate')).toHaveLength(0);
    expect(await screen.findByRole('button', { name: 'addLine.save' })).toBeDisabled();
  });

  it('saves a mileage row with its distance AND its unit', async () => {
    /**
     * The unit travels with the distance. It used not to be captured at all, so the
     * server fell back to the RULE's unit and a distance meant as miles was priced as
     * kilometres.
     */
    const user = userEvent.setup();
    await addDraft(user);
    await pick(user, 'addLine.categoryPlaceholder', 'Mileage');
    await user.type(screen.getByLabelText('line.distance'), '120');
    await user.click(screen.getByRole('button', { name: 'addLine.save' }));
    expect(sent('lineItemCreate')[0]).toMatchObject({
      categoryId: 'cat-mileage',
      mileageDistance: '120',
      mileageUnit: 'KM',
    });
  });

  it("opens a mileage row in the expense owner's unit, and saves it in that unit (FR-11)", async () => {
    const user = userEvent.setup();
    renderEditor({ lineItems: [], mileageDefaultUnit: 'MI' });
    await user.click(screen.getByRole('button', { name: /drawer.addLine/ }));
    await pick(user, 'addLine.categoryPlaceholder', 'Mileage');
    expect(screen.getByRole('button', { name: 'MI' })).toHaveAttribute('aria-pressed', 'true');
    await user.type(screen.getByLabelText('line.distance'), '75');
    await user.click(screen.getByRole('button', { name: 'addLine.save' }));
    expect(sent('lineItemCreate')[0]).toMatchObject({ mileageDistance: '75', mileageUnit: 'MI' });
  });

  it('omits the route when no stop was named', async () => {
    const user = userEvent.setup();
    await addDraft(user);
    await pick(user, 'addLine.categoryPlaceholder', 'Mileage');
    await user.type(screen.getByLabelText('line.distance'), '120');
    await user.click(screen.getByRole('button', { name: 'addLine.save' }));
    expect(sent('lineItemCreate')[0]).not.toHaveProperty('mileageRoute');
  });

  it('keeps the row and shows the reason when the create is refused', async () => {
    /**
     * The draft used to be discarded synchronously right after `mutate()` — before the
     * write was known — so a rejected create took the typed values with it and showed
     * nothing at all.
     */
    h.errors.lineItemCreate = 'No country on the traveller — cannot resolve a mileage rate.';
    const user = userEvent.setup();
    await addDraft(user);
    await pick(user, 'addLine.categoryPlaceholder', 'Mileage');
    await user.type(screen.getByLabelText('line.distance'), '120');
    await user.click(screen.getByRole('button', { name: 'addLine.save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('No country on the traveller');
    // …and the row is still there, with its distance.
    expect(screen.getByDisplayValue('120')).toBeInTheDocument();
  });

  it('drops the row on cancel', async () => {
    const user = userEvent.setup();
    await addDraft(user);
    await user.click(screen.getByRole('button', { name: 'addLine.cancel' }));
    expect(queryComboboxByPlaceholder('addLine.categoryPlaceholder')).not.toBeInTheDocument();
  });

  /**
   * FR-1 and FR-5: with lookup on, a mileage draft is the route dropdown alone, and the
   * workspace it opens creates the line in one call — or, cancelled, takes the draft away.
   */
  describe('with address lookup on', () => {
    const routeDropdown = () => screen.getByRole('combobox', { name: 'route.dropdownLabel' });
    const homeOffice = (index: number, meters: number) => ({
      ...wireRoute(index, `Hwy ${index}`),
      totalMeters: meters,
      legs: [{ fromPlaceId: 'home', toPlaceId: 'office', meters }],
    });
    async function mileageDraft(user: ReturnType<typeof userEvent.setup>, over = {}) {
      h.lookup = true;
      renderEditor({ lineItems: [], ...over });
      await user.click(screen.getByRole('button', { name: /drawer.addLine/ }));
      await pick(user, 'addLine.categoryPlaceholder', 'Mileage');
    }
    async function chooseRoute(user: ReturnType<typeof userEvent.setup>, option: RegExp | string) {
      await user.click(routeDropdown());
      await user.click(await screen.findByRole('option', { name: option }));
    }
    const useButton = () => screen.getByRole('button', { name: 'route.picker.useRoute' });

    it('shows the route dropdown alone — no stops, Calculate, unit toggle, Add line or Cancel', async () => {
      const user = userEvent.setup();
      await mileageDraft(user);
      expect(routeDropdown()).toBeInTheDocument();
      expect(screen.queryByLabelText('from')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'calculate' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'KM' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'addLine.save' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'addLine.cancel' })).not.toBeInTheDocument();
      expect(sent('lineItemCreate')).toHaveLength(0);
    });

    it('creates the line in ONE call with the previous route as stored, then drops the draft', async () => {
      h.recent = [PREVIOUS_ROUTE];
      h.routes = [homeOffice(0, 13_000), homeOffice(1, 12_000)];
      const user = userEvent.setup();
      await mileageDraft(user);
      // No fresh path came with the previous route, so it is routed by its stops.
      await chooseRoute(user, /previousRouteEnds:Home,Office/);
      expect(sent('computeRoutes')).toEqual([{ placeIds: ['home', 'office'], unit: 'KM' }]);
      await screen.findAllByRole('radio');
      await user.click(useButton());

      expect(sent('lineItemCreate')).toEqual([
        {
          expenseId: 'exp-1',
          categoryId: 'cat-mileage',
          mileageDistance: '12.00',
          mileageUnit: 'KM',
          // Accepted unchanged: the entry as stored (spec FR-4), not the fresh answer.
          mileageRoute: {
            stops: PREVIOUS_ROUTE.stops,
            legs: [{ fromPlaceId: 'home', toPlaceId: 'office', meters: 12_000 }],
            routeLabel: 'Hwy 2',
            routeIndex: 0,
            routeCount: 2,
          },
        },
      ]);
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(screen.queryByPlaceholderText('addLine.categoryPlaceholder')).not.toBeInTheDocument();
      // The dropdown went with the draft, so focus goes to the control that stays.
      await waitFor(() =>
        expect(screen.getByRole('button', { name: /drawer.addLine/ })).toHaveFocus(),
      );
    });

    it('a previous route with the old geometry keys is routed by its stops, and none is written', async () => {
      h.recent = [
        {
          ...PREVIOUS_ROUTE,
          encodedPolyline: 'stored',
          routeFetchedAt: '2026-10-10T08:00:00.000Z',
        },
      ];
      h.routes = [homeOffice(0, 12_000)];
      const user = userEvent.setup();
      await mileageDraft(user);
      await chooseRoute(user, /previousRouteEnds:Home,Office/);
      expect(sent('computeRoutes')).toEqual([{ placeIds: ['home', 'office'], unit: 'KM' }]);
      await screen.findByRole('radio');
      await user.click(useButton());

      const [create] = sent('lineItemCreate');
      expect(create).toMatchObject({ mileageRoute: { stops: PREVIOUS_ROUTE.stops } });
      expect(JSON.stringify(create)).not.toMatch(/encodedPolyline|routeFetchedAt|passThrough|via/);
    });

    it('a double press of Use this route is ONE create', async () => {
      h.recent = [PREVIOUS_ROUTE];
      h.routes = [homeOffice(0, 12_000)];
      const user = userEvent.setup();
      await mileageDraft(user);
      await chooseRoute(user, /previousRouteEnds:Home,Office/);
      await screen.findByRole('radio');
      const use = useButton();
      await act(async () => {
        use.click();
        use.click();
      });
      expect(sent('lineItemCreate')).toHaveLength(1);
    });

    it('Cancel writes nothing, takes the draft away and gives focus to Add line', async () => {
      h.recent = [PREVIOUS_ROUTE];
      const user = userEvent.setup();
      await mileageDraft(user);
      await chooseRoute(user, /previousRouteEnds:Home,Office/);
      await user.click(screen.getByRole('button', { name: 'addLine.cancel' }));

      expect(sent('lineItemCreate')).toHaveLength(0);
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(screen.queryByPlaceholderText('addLine.categoryPlaceholder')).not.toBeInTheDocument();
      await waitFor(() =>
        expect(screen.getByRole('button', { name: /drawer.addLine/ })).toHaveFocus(),
      );
    });

    it('a refused create keeps the workspace open with the reason, and the draft stays', async () => {
      h.errors.lineItemCreate = 'No country on the traveller — cannot resolve a mileage rate.';
      h.recent = [PREVIOUS_ROUTE];
      h.routes = [homeOffice(0, 12_000)];
      const user = userEvent.setup();
      await mileageDraft(user);
      await chooseRoute(user, /previousRouteEnds:Home,Office/);
      await screen.findByRole('radio');
      await user.click(useButton());

      const dialog = screen.getByRole('dialog');
      expect(within(dialog).getByRole('alert')).toHaveTextContent('No country on the traveller');
      // The draft is still there behind the workspace (inert while it is open).
      // VeloExpense: the kit's category picker is a button carrying `data-placeholder`, and
      // the Radix dialog hides everything behind it from role queries, so it is found in
      // the DOM directly.
      expect(
        document.querySelector('[data-placeholder="addLine.categoryPlaceholder"]'),
      ).toBeInTheDocument();
    });

    it("opens and prices in the expense owner's default unit", async () => {
      h.recent = [PREVIOUS_ROUTE];
      h.routes = [homeOffice(0, 12_000)];
      const user = userEvent.setup();
      await mileageDraft(user, { mileageDefaultUnit: 'MI' });
      await chooseRoute(user, /previousRouteEnds:Home,Office/);
      expect(sent('computeRoutes')).toEqual([{ placeIds: ['home', 'office'], unit: 'MI' }]);
      await screen.findByRole('radio');
      await user.click(useButton());
      expect(sent('lineItemCreate')[0]).toMatchObject({
        mileageUnit: 'MI',
        mileageDistance: '7.46',
      });
    });
  });
});

// ── Attendees ─────────────────────────────────────────────────────────────────

describe('the attendee editor', () => {
  /** The editor only renders when a line's category requires attendees. */
  const withAttendees = (attendees: Record<string, unknown>[] = []) =>
    renderEditor({
      attendees,
      lineItems: [
        line({
          category: {
            id: 'cat-meals',
            label: { en: 'Meals' },
            icon: '🍽️',
            color: '#111',
            isMileage: false,
            requiresAttendees: true,
          },
        }),
      ],
    });

  it('lists the people already on the expense, labelled by side', () => {
    /**
     * Internal versus external is the distinction the tax and the policy care about, so
     * it is on the row rather than inferred from whether a company is filled in.
     */
    withAttendees([
      { id: 'a1', name: 'Ada Lovelace', company: null, isExternal: false },
      { id: 'a2', name: 'Bob Vendor', company: 'Acme', isExternal: true },
    ]);
    expect(screen.getByText('Ada Lovelace')).toBeInTheDocument();
    expect(screen.getByText('attendee.internal')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Bob Vendor')).toBeInTheDocument();
    expect(screen.getByText('attendee.external')).toBeInTheDocument();
  });

  it('shows an employee as text, not as editable fields', () => {
    // Their name comes from the directory; letting it be retyped invites a second
    // spelling of the same person.
    withAttendees([{ id: 'a1', name: 'Ada Lovelace', company: null, isExternal: false }]);
    expect(screen.queryByDisplayValue('Ada Lovelace')).not.toBeInTheDocument();
  });

  it('adds an external attendee as a blank pair of fields', async () => {
    const user = userEvent.setup();
    withAttendees();
    await user.click(screen.getByRole('button', { name: /attendee.addExternal/ }));
    expect(screen.getByPlaceholderText('attendee.name')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('attendee.company')).toBeInTheDocument();
  });

  it('writes nothing for a row with no name yet', async () => {
    // A blank row is a row somebody is still typing into.
    const user = userEvent.setup();
    withAttendees();
    await user.click(screen.getByRole('button', { name: /attendee.addExternal/ }));
    await user.click(screen.getByPlaceholderText('attendee.name'));
    await user.tab();
    const attendees = (sent('updateExpense').at(-1)?.attendees ?? []) as unknown[];
    expect(attendees).toEqual([]);
  });

  it('keeps a company only for an external attendee', async () => {
    /**
     * An employee never carries one, so an internal row with a stray company would put
     * a vendor name against a colleague.
     */
    const user = userEvent.setup();
    withAttendees();
    await user.click(screen.getByRole('button', { name: /attendee.addExternal/ }));
    await user.type(screen.getByPlaceholderText('attendee.name'), 'Bob Vendor');
    await user.type(screen.getByPlaceholderText('attendee.company'), 'Acme');
    await user.tab();
    expect(sent('updateExpense').at(-1)?.attendees).toEqual([
      { name: 'Bob Vendor', company: 'Acme', isExternal: true },
    ]);
  });

  it('searches the directory only once the query is worth a round trip', async () => {
    // Two characters: a one-letter search returns most of the company.
    const user = userEvent.setup();
    h.directory = [{ id: 'u-1', name: 'Grace Hopper', email: 'grace@e.inc' }];
    withAttendees();
    await user.type(screen.getByPlaceholderText('attendee.searchPlaceholder'), 'g');
    expect(screen.queryByText('Grace Hopper')).not.toBeInTheDocument();
  });

  it('adds a picked employee as internal, and clears the search', async () => {
    const user = userEvent.setup();
    h.directory = [{ id: 'u-1', name: 'Grace Hopper', email: 'grace@e.inc' }];
    withAttendees();
    const search = screen.getByPlaceholderText('attendee.searchPlaceholder');
    await user.type(search, 'grace');
    const hit = await screen.findByText('Grace Hopper');
    await user.click(hit);
    expect(sent('updateExpense').at(-1)?.attendees).toEqual([
      { name: 'Grace Hopper', company: null, isExternal: false },
    ]);
    expect(search).toHaveValue('');
  });

  it('removes a row', async () => {
    const user = userEvent.setup();
    withAttendees([{ id: 'a1', name: 'Ada Lovelace', company: null, isExternal: false }]);
    await user.click(screen.getByRole('button', { name: 'attendee.remove' }));
    expect(sent('updateExpense').at(-1)?.attendees).toEqual([]);
  });
});
