import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTrpcMock, type TrpcMockConfig } from '@/test-utils/trpc';

/**
 * /admin/per-diem-rates — the lodging and meals allowances the approval engine's
 * `overPerDiem` condition is measured against.
 *
 * A rate is money, and money on this page is entered in MAJOR units, stored in MINOR,
 * and scaled by the rate's OWN currency scope rather than the org's. That makes one
 * mistake possible and invisible: a ¥7,500 Tokyo rate typed against a two-decimal
 * assumption becomes ¥75, every Tokyo trip breaches per-diem, and nothing on screen
 * looks wrong. Both directions of that conversion are pinned per currency.
 *
 * The rest of the suite is about the rate being FINDABLE and RETIRABLE: a two-letter
 * country (the engine matches on the ISO code, not "United States"), a location filter
 * that matches either half, and a delete that is actually reachable.
 */

const h = vi.hoisted(() => ({
  trpc: undefined as unknown,
  topBar: {} as Record<string, ReactNode>,
}));

/** One stable `t` per namespace — the column memo lists it as a dep. */
const translators = new Map<string, (k: string, v?: Record<string, unknown>) => string>();

vi.mock('next-intl', () => ({
  useLocale: () => 'en',
  useTranslations: (ns?: string) => {
    const key = ns ?? '';
    let t = translators.get(key);
    if (!t) {
      const fn = (k: string, values?: Record<string, unknown>) => {
        const full = ns ? `${ns}.${k}` : k;
        return values ? `${full}:${Object.values(values).join(',')}` : full;
      };
      (fn as { has?: () => boolean }).has = () => false;
      t = fn;
      translators.set(key, t);
    }
    return t;
  },
}));
vi.mock('@/lib/trpc/client', () => ({
  get trpc() {
    return h.trpc;
  },
}));
// VeloExpense: the shell lives at app/(app) (no [locale] segment).
vi.mock('@/app/(app)/TopBar', () => ({
  setTopBarSlot: (slot: string, node: ReactNode) => {
    h.topBar[slot] = node;
  },
  useTopBarSlots: () => undefined,
}));
/** The Combobox becomes a native select; Base UI's popup has its own suite. */
vi.mock('@expenseos/design-system', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@expenseos/design-system')>()),
  Combobox: ({
    id,
    items,
    value,
    onValueChange,
    placeholder,
  }: {
    id?: string;
    items: { value: string; label: string }[];
    value: string | null;
    onValueChange: (v: string | null) => void;
    placeholder?: string;
  }) => (
    <select
      id={id}
      aria-label={placeholder ?? id}
      value={value ?? ''}
      onChange={(e) => onValueChange(e.target.value === '' ? null : e.target.value)}
    >
      <option value="">{placeholder ?? '—'}</option>
      {items.map((i) => (
        <option key={i.value} value={i.value}>
          {i.label}
        </option>
      ))}
    </select>
  ),
}));

import { PerDiemRatesAdmin } from './PerDiemRatesAdmin';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const OPTIONS = {
  categories: [
    { id: 'cat-meals', label: { en: 'Meals' } },
    { id: 'cat-lodging', label: { en: 'Lodging' } },
  ],
  jobLevels: [{ id: 'jl-1', code: 'L3', label: { en: 'Senior' }, sortOrder: 1 }],
  legalEntities: [{ id: 'le-1', label: { en: 'Carmigo Canada' } }],
  businessUnits: [{ id: 'bu-1', label: { en: 'Retail' } }],
  currencies: [
    { id: 'cur-cad', code: 'CAD', symbol: '$' },
    { id: 'cur-jpy', code: 'JPY', symbol: '¥' },
  ],
};

const rate = (over: Record<string, unknown> = {}) => ({
  id: 'r1',
  country: 'US',
  city: 'New York',
  categoryId: 'cat-meals',
  amountMinor: '7500',
  firstLastDay: false,
  // Midday, so the local-time formatting in the validity column cannot shift the
  // date across a day boundary and make the assertions timezone-dependent.
  effectiveFrom: '2026-01-01T12:00:00.000Z',
  effectiveTo: null,
  jobLevelId: null,
  legalEntityId: null,
  businessUnitId: null,
  currencyId: null,
  ...over,
});

function setTrpc(rates: unknown[] = [rate()], over: TrpcMockConfig = {}) {
  h.trpc = createTrpcMock({
    ...over,
    queries: {
      'policies.perDiemRate.list': { data: rates },
      'policies.perDiemRate.options': { data: OPTIONS },
      ...over.queries,
    },
  });
}

const show = (canManage = true) => render(<PerDiemRatesAdmin canManage={canManage} />);
const showTopBar = () => render(<div>{h.topBar.right}</div>);

const rowTexts = () =>
  screen
    .getAllByRole('row')
    .slice(1)
    .map((r) => r.textContent ?? '')
    .filter((s) => s.length > 0);

const sel = (label: RegExp | string) => screen.getByLabelText(label) as HTMLSelectElement;
const saveButton = () => screen.getByRole('button', { name: 'perDiem.save' });

/** Fill the minimum a rate needs, so a test about one field is about that field. */
async function fillRequired(
  user: ReturnType<typeof userEvent.setup>,
  over: { country?: string; city?: string; amount?: string } = {},
) {
  await user.type(screen.getByLabelText(/perDiem\.field\.country/), over.country ?? 'jp');
  await user.type(screen.getByLabelText(/perDiem\.field\.city/), over.city ?? 'Tokyo');
  await user.selectOptions(sel(/perDiem\.field\.categoryPlaceholder/), 'cat-meals');
  await user.type(screen.getByLabelText(/perDiem\.field\.amount/), over.amount ?? '75');
  fireEvent.change(screen.getByLabelText(/perDiem\.field\.effectiveFrom/), {
    target: { value: '2026-03-01' },
  });
}

async function openNew(user: ReturnType<typeof userEvent.setup>) {
  showTopBar();
  await user.click(screen.getByRole('button', { name: /perDiem\.add/ }));
  await screen.findByLabelText(/perDiem\.field\.country/);
}

beforeEach(() => {
  h.topBar = {};
});
afterEach(() => {
  h.trpc = undefined;
  vi.restoreAllMocks();
});

// ── The table ─────────────────────────────────────────────────────────────────

describe('the rate list', () => {
  it('reads a rate out as location, category and amount', () => {
    setTrpc();
    show();
    const row = rowTexts()[0];
    expect(row).toContain('US · New York');
    expect(row).toContain('Meals');
    expect(row).toContain('$75.00');
  });

  it('formats the amount with the scoped currency’s own scale', () => {
    /**
     * ¥7,500 is 7500 minor units, not 750,000. Formatting a yen rate as if it had
     * cents shows ¥75.00 for a ¥7,500 allowance, and every Tokyo trip then reads as
     * a per-diem breach.
     */
    setTrpc([rate({ currencyId: 'cur-jpy', amountMinor: '7500' })]);
    show();
    expect(rowTexts()[0]).toContain('¥7,500');
  });

  it('falls back to the policy currency for a rate with no currency scope', () => {
    setTrpc();
    show();
    expect(rowTexts()[0]).toContain('$75.00');
  });

  it('says a rate with no scope applies to everyone', () => {
    setTrpc();
    show();
    expect(screen.getByText('perDiem.scope.all')).toBeInTheDocument();
  });

  it('names each scope a rate carries', () => {
    setTrpc([rate({ jobLevelId: 'jl-1', legalEntityId: 'le-1', businessUnitId: 'bu-1' })]);
    show();
    expect(screen.getByText('L3 · perDiem.scope.le · perDiem.scope.bu')).toBeInTheDocument();
  });

  it('dashes a job level that no longer exists rather than printing its id', () => {
    setTrpc([rate({ jobLevelId: 'gone' })]);
    show();
    expect(rowTexts()[0]).toContain('—');
  });

  it('says a rate with no end date is ongoing', () => {
    setTrpc();
    show();
    expect(screen.getByText(/perDiem\.ongoing/)).toBeInTheDocument();
  });

  it('shows both ends of a closed window', () => {
    setTrpc([rate({ effectiveTo: '2026-12-31T12:00:00.000Z' })]);
    show();
    expect(rowTexts()[0]).toContain('Jan 1, 2026 – Dec 31, 2026');
  });

  it('says so when there are no rates', () => {
    setTrpc([]);
    show();
    expect(screen.getByText('perDiem.emptyTitle')).toBeInTheDocument();
    expect(screen.getByText('perDiem.emptyBody')).toBeInTheDocument();
  });

  it('narrows on the country or the city, since either is how you look one up', async () => {
    const user = userEvent.setup();
    setTrpc([rate(), rate({ id: 'r2', country: 'JP', city: 'Tokyo' })]);
    show();
    const filter = async (value: string) => {
      const header = screen.getByText('perDiem.col.location').closest('th') as HTMLElement;
      const buttons = within(header).getAllByRole('button', { name: 'table.colMenu.menu' });
      await user.click(buttons[buttons.length - 1]);
      await user.click(await screen.findByText('table.colMenu.filter'));
      await user.type(await screen.findByPlaceholderText('table.colMenu.value'), value);
      await user.click(screen.getByText('table.colMenu.apply'));
    };
    await filter('tokyo');
    expect(rowTexts()).toHaveLength(1);
    expect(screen.getByText('JP · Tokyo')).toBeInTheDocument();
  });
});

// ── Who may edit ──────────────────────────────────────────────────────────────

describe('authoring permission', () => {
  it('offers no Add button to a reader', () => {
    setTrpc();
    show(false);
    showTopBar();
    expect(screen.queryByRole('button', { name: /perDiem\.add/ })).not.toBeInTheDocument();
  });

  it('offers no row menu to a reader, and no editor on a row click', async () => {
    const user = userEvent.setup();
    setTrpc();
    show(false);
    expect(screen.queryByRole('button', { name: 'perDiem.actions' })).not.toBeInTheDocument();
    await user.click(screen.getByText('US · New York'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('retires a rate from the row menu', async () => {
    // The kebab is the only affordance for delete; a row click opens the editor.
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc([rate()], { mutations: { 'policies.perDiemRate.delete': { onCall } } });
    show();
    await user.click(screen.getByRole('button', { name: 'perDiem.actions' }));
    await user.click(await screen.findByText('perDiem.delete'));
    expect(onCall).toHaveBeenCalledWith({ id: 'r1' });
  });

  it('opens the editor on a row click for an author', async () => {
    const user = userEvent.setup();
    setTrpc();
    show();
    await user.click(screen.getByText('US · New York'));
    expect(await screen.findByText('perDiem.edit')).toBeInTheDocument();
  });
});

// ── The drawer ────────────────────────────────────────────────────────────────

describe('authoring a rate', () => {
  it('will not save without a location, a category, an amount and a start', async () => {
    const user = userEvent.setup();
    setTrpc([]);
    show();
    await openNew(user);
    expect(saveButton()).toBeDisabled();
    await fillRequired(user);
    expect(saveButton()).toBeEnabled();
  });

  it('insists on a two-letter country, because the engine matches the ISO code', async () => {
    /**
     * "United States" would be truncated to "UN" by the input and then match nothing —
     * a rate that exists, looks right, and never applies.
     */
    const user = userEvent.setup();
    setTrpc([]);
    show();
    await openNew(user);
    await fillRequired(user, { country: 'U' });
    expect(saveButton()).toBeDisabled();
  });

  it('uppercases the country as it is typed', async () => {
    const user = userEvent.setup();
    setTrpc([]);
    show();
    await openNew(user);
    await user.type(screen.getByLabelText(/perDiem\.field\.country/), 'jp');
    expect((screen.getByLabelText(/perDiem\.field\.country/) as HTMLInputElement).value).toBe('JP');
  });

  it('will not save a city of only spaces', async () => {
    const user = userEvent.setup();
    setTrpc([]);
    show();
    await openNew(user);
    await fillRequired(user, { city: '   ' });
    expect(saveButton()).toBeDisabled();
  });

  it('stores the amount in minor units of the policy currency by default', async () => {
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc([], { mutations: { 'policies.perDiemRate.create': { onCall } } });
    show();
    await openNew(user);
    await fillRequired(user, { amount: '75' });
    await user.click(saveButton());
    expect((onCall.mock.calls[0]?.[0] as { amountMinor: bigint }).amountMinor).toBe(7500n);
  });

  it('stores the amount in minor units of the SCOPED currency', async () => {
    /**
     * The whole point of the currency scope. Yen has no minor unit, so ¥7,500 is 7500
     * — scaling it by 100 would create a rate a hundred times too high, which nothing
     * on the list would reveal.
     */
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc([], { mutations: { 'policies.perDiemRate.create': { onCall } } });
    show();
    await openNew(user);
    await user.selectOptions(sel(/perDiem\.field\.policyCurrency/), 'cur-jpy');
    await fillRequired(user, { amount: '7500' });
    await user.click(saveButton());
    const patch = onCall.mock.calls[0]?.[0] as { amountMinor: bigint; currencyId: string };
    expect(patch.amountMinor).toBe(7500n);
    expect(patch.currencyId).toBe('cur-jpy');
  });

  it('shows a stored amount back in major units of its own currency', async () => {
    // The other half of the same conversion — re-saving an edit must not shift it.
    const user = userEvent.setup();
    setTrpc([rate({ currencyId: 'cur-jpy', amountMinor: '7500' })]);
    show();
    await user.click(screen.getByText('US · New York'));
    expect(
      (await screen.findByLabelText(/perDiem\.field\.amount/)) as HTMLInputElement,
    ).toHaveValue('7500');
  });

  it('trims and uppercases the location on the way out', async () => {
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc([], { mutations: { 'policies.perDiemRate.create': { onCall } } });
    show();
    await openNew(user);
    await fillRequired(user, { city: '  Tokyo  ' });
    await user.click(saveButton());
    expect(onCall.mock.calls[0]?.[0]).toMatchObject({ country: 'JP', city: 'Tokyo' });
  });

  it('sends no end date as null rather than an invalid one', async () => {
    // `new Date('')` is Invalid Date, and an invalid timestamp reaching Prisma throws.
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc([], { mutations: { 'policies.perDiemRate.create': { onCall } } });
    show();
    await openNew(user);
    await fillRequired(user);
    await user.click(saveButton());
    const patch = onCall.mock.calls[0]?.[0] as { effectiveFrom: Date; effectiveTo: unknown };
    expect(patch.effectiveTo).toBeNull();
    expect(patch.effectiveFrom.toISOString()).toContain('2026-03-01');
  });

  it('carries the closing date when one is given', async () => {
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc([], { mutations: { 'policies.perDiemRate.create': { onCall } } });
    show();
    await openNew(user);
    await fillRequired(user);
    fireEvent.change(screen.getByLabelText(/perDiem\.field\.effectiveTo/), {
      target: { value: '2026-06-30' },
    });
    await user.click(saveButton());
    expect(
      (onCall.mock.calls[0]?.[0] as { effectiveTo: Date }).effectiveTo.toISOString(),
    ).toContain('2026-06-30');
  });

  it('carries the first/last-day rule', async () => {
    // Travel days are usually allowanced at a fraction; the flag is what says so.
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc([], { mutations: { 'policies.perDiemRate.create': { onCall } } });
    show();
    await openNew(user);
    await fillRequired(user);
    await user.click(screen.getByText('perDiem.field.firstLastDay'));
    await user.click(saveButton());
    expect((onCall.mock.calls[0]?.[0] as { firstLastDay: boolean }).firstLastDay).toBe(true);
  });

  it('carries every scope the author chose', async () => {
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc([], { mutations: { 'policies.perDiemRate.create': { onCall } } });
    show();
    await openNew(user);
    await fillRequired(user);
    await user.selectOptions(sel(/perDiem\.scope\.anyLevel/), 'jl-1');
    const anys = screen.getAllByLabelText('perDiem.scope.any');
    await user.selectOptions(anys[0], 'le-1');
    await user.selectOptions(anys[1], 'bu-1');
    await user.click(saveButton());
    expect(onCall.mock.calls[0]?.[0]).toMatchObject({
      jobLevelId: 'jl-1',
      legalEntityId: 'le-1',
      businessUnitId: 'bu-1',
    });
  });

  it('loads an existing rate into the form', async () => {
    const user = userEvent.setup();
    setTrpc([rate({ jobLevelId: 'jl-1', firstLastDay: true })]);
    show();
    await user.click(screen.getByText('US · New York'));
    expect((await screen.findByLabelText(/perDiem\.field\.city/)) as HTMLInputElement).toHaveValue(
      'New York',
    );
    expect(sel(/perDiem\.scope\.anyLevel/).value).toBe('jl-1');
    expect((screen.getByLabelText(/perDiem\.field\.effectiveFrom/) as HTMLInputElement).value).toBe(
      '2026-01-01',
    );
  });

  it('updates an existing rate by id, not by creating a second one', async () => {
    const updated = vi.fn();
    const created = vi.fn();
    const user = userEvent.setup();
    setTrpc([rate()], {
      mutations: {
        'policies.perDiemRate.update': { onCall: updated },
        'policies.perDiemRate.create': { onCall: created },
      },
    });
    show();
    await user.click(screen.getByText('US · New York'));
    await user.click(await screen.findByRole('button', { name: 'perDiem.save' }));
    expect(created).not.toHaveBeenCalled();
    expect(updated.mock.calls[0]?.[0]).toMatchObject({ id: 'r1' });
  });

  it('says it is saving while in flight', async () => {
    const user = userEvent.setup();
    setTrpc([rate()], { mutations: { 'policies.perDiemRate.update': { isPending: true } } });
    show();
    await user.click(screen.getByText('US · New York'));
    expect(await screen.findByRole('button', { name: 'perDiem.saving' })).toBeDisabled();
  });

  it('closes without saving on cancel', async () => {
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc([], { mutations: { 'policies.perDiemRate.create': { onCall } } });
    show();
    await openNew(user);
    await user.click(screen.getByRole('button', { name: 'perDiem.cancel' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(onCall).not.toHaveBeenCalled();
  });
});

// ── Before the reference data arrives ─────────────────────────────────────────

describe('the moment before the options load', () => {
  /**
   * The rate list and the scoping options are two queries, and the second is the slower
   * one — it reads four lookup tables. So there is a real window where a rate is on
   * screen and nothing is known about the ids it points at, and every label map, every
   * picker and the currency the amount is formatted in all resolve through that missing
   * data.
   *
   * Whatever it does then, it must not be throw: the table is the page.
   */
  const withoutOptions = (rates: unknown[] = [rate()]) => {
    h.trpc = createTrpcMock({
      queries: {
        'policies.perDiemRate.list': { data: rates },
        'policies.perDiemRate.options': { isLoading: true, data: undefined },
      },
    });
  };

  it('still lists the rates', () => {
    withoutOptions();
    show();
    expect(rowTexts()).toHaveLength(1);
    expect(screen.getByText(/New York/)).toBeInTheDocument();
  });

  it('dashes a category it cannot name yet, rather than printing its id', () => {
    /** `cat-meals` in the Category column is worse than a dash: it looks like data. */
    withoutOptions();
    show();
    expect(screen.queryByText('cat-meals')).not.toBeInTheDocument();
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });

  it('formats the amount in the policy currency rather than crashing on an unknown one', () => {
    /**
     * `currencyFor` resolves through the same options map. A scoped rate whose currency
     * has not loaded falls back to CAD — two decimals — which is right for CAD and wrong
     * for JPY, but the alternative is a blank row.
     */
    withoutOptions([rate({ currencyId: 'cur-jpy', amountMinor: '7500' })]);
    show();
    expect(screen.getByText(/75\.00/)).toBeInTheDocument();
  });

  it('opens the editor with empty pickers instead of refusing to open', async () => {
    /** An author who clicks Add during that window gets a form they can start typing
     *  into, not a dead button. */
    const user = userEvent.setup();
    withoutOptions();
    show();
    await openNew(user);
    expect(screen.getByLabelText(/perDiem\.field\.country/)).toBeInTheDocument();
    // The category picker exists and offers only its placeholder.
    expect(sel(/perDiem\.field\.categoryPlaceholder/).options).toHaveLength(1);
  });
});
