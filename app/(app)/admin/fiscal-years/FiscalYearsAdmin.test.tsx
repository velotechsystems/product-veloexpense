import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTrpcMock, type TrpcMockConfig } from '@/test-utils/trpc';
import { FiscalYearsAdmin } from './FiscalYearsAdmin';

/**
 * /admin/fiscal-years.
 *
 * A fiscal year is what every period in the product is measured against, so the two
 * things worth pinning are the ones that decide which year "now" belongs to:
 *
 *   · **`isCurrent` is an admin flag, and the calendar is a fact.** They diverge every
 *     year-end. The page states the divergence (a "current by date" badge plus a
 *     one-click banner) rather than silently trusting either — and it fires
 *     `advanceCurrent` once on mount so the flag catches up between cron ticks.
 *   · **A range is validated before it is written.** `endDate <= startDate` is a year
 *     that contains nothing, and every budget and report keyed to it would find no
 *     period at all.
 *
 * The date prefill is the other half: an admin adding next year should not have to
 * work out that it starts the day after this one ended.
 */

const h = vi.hoisted(() => ({
  trpc: undefined as unknown,
  /** What the export menu handed to the browser. */
  downloads: [] as Array<{ filename: string; csv: string }>,
}));

// The export menu's real builder runs; only the browser hand-off is intercepted.
// VeloExpense: ExpenseOS's tests are bilingual, so they run with French switched ON here
// (VeloExpense ships with it off, `ENABLED_LOCALES`).
vi.mock('@expenseos/i18n/locales', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ENABLED_LOCALES: ['en', 'fr-CA'],
}));

vi.mock('@/lib/exportCsv', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  downloadCsv: (filename: string, csv: string) => {
    h.downloads.push({ filename, csv });
  },
}));

vi.mock('@/lib/trpc/client', () => ({
  get trpc() {
    return h.trpc;
  },
}));
vi.mock('next-intl', () => ({
  useLocale: () => 'en',
  useTranslations: (ns?: string) => {
    const t = (key: string, values?: Record<string, unknown>) => {
      const full = ns ? `${ns}.${key}` : key;
      return values ? `${full}:${Object.values(values).join(',')}` : full;
    };
    t.has = () => false;
    return t;
  },
}));
// VeloExpense: the shell lives at app/(app) (no [locale] segment).
vi.mock('@/app/(app)/TopBar', () => ({
  useTopBarSlots: (builder: () => { right?: unknown }) => {
    topBar.right = builder().right;
  },
}));

/** Whatever the page pushed into the global top bar (its "Add" button). */
const topBar: { right?: unknown } = {};

const iso = (d: string) => new Date(`${d}T00:00:00Z`);

const fy = (over: Record<string, unknown> = {}) => ({
  id: 'fy-2026',
  label: { en: 'FY2026', 'fr-CA': 'AF2026' },
  startDate: iso('2026-01-01'),
  endDate: iso('2026-12-31'),
  isCurrent: true,
  closed: false,
  externalIds: {},
  createdAt: iso('2026-01-01'),
  updatedAt: iso('2026-01-01'),
  ...over,
});

/** Today, so a fixture can be placed either side of it without hard-coding a date. */
const TODAY = new Date().toISOString().slice(0, 10);
const yearOf = (offset: number) => String(new Date().getUTCFullYear() + offset);

function setTrpc(over: TrpcMockConfig = {}) {
  h.trpc = createTrpcMock({
    ...over,
    queries: { 'appSettings.fiscalYears.list': { data: [fy()] }, ...over.queries },
  });
}

const show = (canEdit = true) => render(<FiscalYearsAdmin canEdit={canEdit} />);

/** Render the top-bar slot so its action is pressable. */
const showTopBar = () => render(<div>{topBar.right as never}</div>);

/** Open the kebab on the row whose label cell reads `label`. */
async function rowMenu(user: ReturnType<typeof userEvent.setup>, label: string) {
  const cell = screen.getByText(label).closest('div.flex') as HTMLElement;
  await user.click(within(cell).getByRole('button', { name: 'admin.common.rowActions' }));
}

beforeEach(() => {
  topBar.right = undefined;
  h.downloads = [];
});

afterEach(() => {
  h.trpc = undefined;
  vi.restoreAllMocks();
});

// ── The table ─────────────────────────────────────────────────────────────────

describe('the list', () => {
  it('shows each year with its range and state', () => {
    setTrpc();
    show();
    expect(screen.getByText('FY2026')).toBeInTheDocument();
    expect(screen.getByText('2026-01-01')).toBeInTheDocument();
    expect(screen.getByText('2026-12-31')).toBeInTheDocument();
    expect(screen.getByText('admin.fiscalYears.statusCurrent')).toBeInTheDocument();
  });

  it('names an unlabelled year rather than showing a blank cell', () => {
    setTrpc({ queries: { 'appSettings.fiscalYears.list': { data: [fy({ label: {} })] } } });
    show();
    expect(screen.getByText('admin.common.unnamed')).toBeInTheDocument();
  });

  it('distinguishes closed from merely not-current', () => {
    /**
     * Three states, not two: `current` is where new spend lands, `closed` refuses
     * postings, and `open` is a year that is neither — a future year, or last year
     * still being adjusted.
     */
    setTrpc({
      queries: {
        'appSettings.fiscalYears.list': {
          data: [
            fy({ id: 'a', label: { en: 'Closed' }, isCurrent: false, closed: true }),
            fy({ id: 'b', label: { en: 'Open' }, isCurrent: false, closed: false }),
          ],
        },
      },
    });
    show();
    expect(screen.getByText('admin.fiscalYears.statusClosed')).toBeInTheDocument();
    expect(screen.getByText('admin.fiscalYears.statusOpen')).toBeInTheDocument();
  });

  it('says so when there are no fiscal years at all', () => {
    setTrpc({ queries: { 'appSettings.fiscalYears.list': { data: [] } } });
    show();
    expect(screen.getByText('admin.fiscalYears.empty')).toBeInTheDocument();
  });

  it('counts what is listed', () => {
    setTrpc();
    show();
    expect(screen.getByText('table.misc.results:1')).toBeInTheDocument();
  });
});

// ── The calendar-vs-flag divergence ───────────────────────────────────────────

describe('the current-year divergence', () => {
  const spanningToday = (over: Record<string, unknown> = {}) =>
    fy({
      id: 'fy-now',
      label: { en: 'FY Now' },
      startDate: iso(`${yearOf(0)}-01-01`),
      endDate: iso(`${yearOf(1)}-12-31`),
      ...over,
    });

  it('badges a year that contains today but is not marked current', () => {
    /**
     * The end-of-year handoff window. Without the badge, an admin looking at the table
     * has no way to see that the flag and the calendar disagree — and every period
     * derived from "current" is quietly pointing at last year.
     */
    setTrpc({
      queries: {
        'appSettings.fiscalYears.list': { data: [spanningToday({ isCurrent: false })] },
      },
    });
    show();
    expect(screen.getByText('admin.fiscalYears.byDateBadge')).toBeInTheDocument();
  });

  it('does not badge the year that is already marked current', () => {
    // Agreement needs no annotation.
    setTrpc({
      queries: { 'appSettings.fiscalYears.list': { data: [spanningToday({ isCurrent: true })] } },
    });
    show();
    expect(screen.queryByText('admin.fiscalYears.byDateBadge')).not.toBeInTheDocument();
  });

  it('offers a one-click fix in a banner, not buried in a row menu', async () => {
    const onCall = vi.fn();
    setTrpc({
      queries: {
        'appSettings.fiscalYears.list': { data: [spanningToday({ isCurrent: false })] },
      },
      mutations: { 'appSettings.fiscalYears.setCurrent': { onCall } },
    });
    const user = userEvent.setup();
    show();
    await user.click(screen.getByRole('button', { name: /admin.fiscalYears.advance/ }));
    expect(onCall).toHaveBeenCalledWith({ id: 'fy-now' });
  });

  it('hides the banner from somebody who cannot fix it', () => {
    setTrpc({
      queries: {
        'appSettings.fiscalYears.list': { data: [spanningToday({ isCurrent: false })] },
      },
    });
    show(false);
    expect(screen.queryByText(/admin.fiscalYears.divergesText/)).not.toBeInTheDocument();
  });

  it('advances the flag once on mount, and only for somebody who may write', () => {
    /**
     * Idempotent and fired once: the same thing a nightly cron does, run here so the
     * dashboard is right between ticks. Firing it per render would be a write on every
     * keystroke in the table.
     */
    const onCall = vi.fn();
    setTrpc({ mutations: { 'appSettings.fiscalYears.advanceCurrent': { onCall } } });
    show();
    expect(onCall).toHaveBeenCalledTimes(1);

    cleanup();
    onCall.mockClear();
    setTrpc({ mutations: { 'appSettings.fiscalYears.advanceCurrent': { onCall } } });
    show(false);
    expect(onCall).not.toHaveBeenCalled();
  });

  it('does not advance anything before the years have loaded', () => {
    // There is nothing to advance to, and the call would race the first render.
    const onCall = vi.fn();
    setTrpc({
      queries: { 'appSettings.fiscalYears.list': { data: [], isLoading: true } },
      mutations: { 'appSettings.fiscalYears.advanceCurrent': { onCall } },
    });
    show();
    expect(onCall).not.toHaveBeenCalled();
  });
});

// ── Row actions ───────────────────────────────────────────────────────────────

describe('row actions', () => {
  it('offers view only to somebody who cannot edit', async () => {
    const user = userEvent.setup();
    setTrpc();
    show(false);
    await rowMenu(user, 'FY2026');
    expect(await screen.findByText('admin.common.view')).toBeInTheDocument();
    expect(screen.queryByText('admin.common.edit')).not.toBeInTheDocument();
    expect(screen.queryByText('admin.common.delete')).not.toBeInTheDocument();
  });

  it('offers "set current" only for a year that is not already current', async () => {
    // An action that would do nothing is an action that has to be explained.
    const user = userEvent.setup();
    setTrpc();
    show();
    await rowMenu(user, 'FY2026');
    expect(await screen.findByText('admin.common.edit')).toBeInTheDocument();
    expect(screen.queryByText('admin.fiscalYears.setCurrent')).not.toBeInTheDocument();
  });

  it('sets a different year current', async () => {
    const onCall = vi.fn();
    setTrpc({
      queries: {
        'appSettings.fiscalYears.list': {
          data: [
            fy({
              id: 'fy-2027',
              label: { en: 'FY2027' },
              isCurrent: false,
              // Away from today, so the divergence banner does not also render the label.
              startDate: iso('2020-01-01'),
              endDate: iso('2020-12-31'),
            }),
          ],
        },
      },
      mutations: { 'appSettings.fiscalYears.setCurrent': { onCall } },
    });
    const user = userEvent.setup();
    show();
    await rowMenu(user, 'FY2027');
    await user.click(await screen.findByText('admin.fiscalYears.setCurrent'));
    expect(onCall).toHaveBeenCalledWith({ id: 'fy-2027' });
  });

  it('refuses to delete the current year', async () => {
    /**
     * Deleting the year everything is posted against is not a mistake anybody recovers
     * from quickly, so the action is inert rather than merely confirmed.
     */
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const onCall = vi.fn();
    setTrpc({ mutations: { 'appSettings.fiscalYears.delete': { onCall } } });
    const user = userEvent.setup();
    show();
    await rowMenu(user, 'FY2026');
    await user.click(await screen.findByText('admin.common.delete'));
    expect(confirm).not.toHaveBeenCalled();
    expect(onCall).not.toHaveBeenCalled();
  });

  it('asks before deleting, naming the year', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const onCall = vi.fn();
    setTrpc({
      queries: {
        'appSettings.fiscalYears.list': {
          data: [
            fy({
              id: 'fy-2025',
              label: { en: 'FY2025' },
              isCurrent: false,
              startDate: iso('2020-01-01'),
              endDate: iso('2020-12-31'),
            }),
          ],
        },
      },
      mutations: { 'appSettings.fiscalYears.delete': { onCall } },
    });
    const user = userEvent.setup();
    show();
    await rowMenu(user, 'FY2025');
    await user.click(await screen.findByText('admin.common.delete'));
    expect(confirm).toHaveBeenCalledWith('admin.fiscalYears.confirmDelete:FY2025');
    expect(onCall).not.toHaveBeenCalled();
  });

  it('deletes once confirmed', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const onCall = vi.fn();
    setTrpc({
      queries: {
        'appSettings.fiscalYears.list': {
          data: [
            fy({
              id: 'fy-2025',
              label: { en: 'FY2025' },
              isCurrent: false,
              startDate: iso('2020-01-01'),
              endDate: iso('2020-12-31'),
            }),
          ],
        },
      },
      mutations: { 'appSettings.fiscalYears.delete': { onCall } },
    });
    const user = userEvent.setup();
    show();
    await rowMenu(user, 'FY2025');
    await user.click(await screen.findByText('admin.common.delete'));
    expect(onCall).toHaveBeenCalledWith({ id: 'fy-2025' });
  });
});

// ── The drawer ────────────────────────────────────────────────────────────────

describe('the drawer', () => {
  it('opens in view mode on a row click', async () => {
    const user = userEvent.setup();
    setTrpc();
    show();
    await user.click(screen.getByText('FY2026'));
    expect(await screen.findByText('AF2026')).toBeInTheDocument();
    expect(screen.getByText('admin.common.identity')).toBeInTheDocument();
  });

  it('switches to the form, pre-filled from the row', async () => {
    const user = userEvent.setup();
    setTrpc();
    show();
    await user.click(screen.getByText('FY2026'));
    await user.click(await screen.findByRole('button', { name: /admin.common.edit/ }));
    expect(await screen.findByDisplayValue('FY2026')).toBeInTheDocument();
    expect(screen.getByDisplayValue('AF2026')).toBeInTheDocument();
    expect(screen.getByLabelText(/admin\.fiscalYears\.startDate/)).toHaveValue('2026-01-01');
  });

  it('prefills a new year to start the day after the last one ended', async () => {
    /**
     * The whole point of the prefill: an admin adding next year should not have to work
     * out the boundary, and an off-by-one there leaves a day that belongs to no fiscal
     * year at all.
     */
    setTrpc();
    const user = userEvent.setup();
    show();
    showTopBar();
    await user.click(screen.getByRole('button', { name: /admin.fiscalYears.addFiscalYear/ }));
    expect(await screen.findByLabelText(/admin\.fiscalYears\.startDate/)).toHaveValue('2027-01-01');
    // …and runs exactly twelve months.
    expect(screen.getByLabelText(/admin\.fiscalYears\.endDate/)).toHaveValue('2027-12-31');
  });

  it('falls back to today when there is no prior year', async () => {
    setTrpc({ queries: { 'appSettings.fiscalYears.list': { data: [] } } });
    const user = userEvent.setup();
    show();
    showTopBar();
    await user.click(screen.getByRole('button', { name: /admin.fiscalYears.addFiscalYear/ }));
    expect(await screen.findByLabelText(/admin\.fiscalYears\.startDate/)).toHaveValue(TODAY);
  });

  it('keeps the twelve-month default when the start date is re-picked', async () => {
    const user = userEvent.setup();
    setTrpc({ queries: { 'appSettings.fiscalYears.list': { data: [] } } });
    show();
    showTopBar();
    await user.click(screen.getByRole('button', { name: /admin.fiscalYears.addFiscalYear/ }));
    const start = await screen.findByLabelText(/admin\.fiscalYears\.startDate/);
    // `fireEvent.change` in one step: typing a date character by character fires an
    // onChange per keystroke, and the intermediate values are not dates.
    fireEvent.change(start, { target: { value: '2030-04-01' } });
    expect(screen.getByLabelText(/admin\.fiscalYears\.endDate/)).toHaveValue('2031-03-31');
  });

  it('leaves an end date the admin chose alone', async () => {
    // Once they have expressed an opinion, re-deriving it would overwrite it.
    const user = userEvent.setup();
    setTrpc({ queries: { 'appSettings.fiscalYears.list': { data: [] } } });
    show();
    showTopBar();
    await user.click(screen.getByRole('button', { name: /admin.fiscalYears.addFiscalYear/ }));
    const end = await screen.findByLabelText(/admin\.fiscalYears\.endDate/);
    fireEvent.change(end, { target: { value: '2029-06-30' } });
    fireEvent.change(screen.getByLabelText(/admin\.fiscalYears\.startDate/), {
      target: { value: '2028-07-01' },
    });
    expect(screen.getByLabelText(/admin\.fiscalYears\.endDate/)).toHaveValue('2029-06-30');
  });
});

// ── Saving ────────────────────────────────────────────────────────────────────

describe('saving', () => {
  const openCreate = async (user: ReturnType<typeof userEvent.setup>) => {
    show();
    showTopBar();
    await user.click(screen.getByRole('button', { name: /admin.fiscalYears.addFiscalYear/ }));
    await screen.findByLabelText(/admin\.common\.labelEn/);
  };

  it('requires both labels, because the product ships in two languages', async () => {
    const onCall = vi.fn();
    setTrpc({
      queries: { 'appSettings.fiscalYears.list': { data: [] } },
      mutations: { 'appSettings.fiscalYears.create': { onCall } },
    });
    const user = userEvent.setup();
    await openCreate(user);
    await user.type(screen.getByLabelText(/admin\.common\.labelEn/), 'FY2030');
    await user.click(screen.getByRole('button', { name: 'admin.common.create' }));
    expect(await screen.findByText('admin.common.bothLabelsRequired')).toBeInTheDocument();
    expect(onCall).not.toHaveBeenCalled();
  });

  it('refuses a range that ends before it starts', async () => {
    /**
     * A year that contains nothing. Every budget and every report keyed to it would
     * find no period, and the failure would surface far from here.
     */
    const onCall = vi.fn();
    setTrpc({
      queries: { 'appSettings.fiscalYears.list': { data: [] } },
      mutations: { 'appSettings.fiscalYears.create': { onCall } },
    });
    const user = userEvent.setup();
    await openCreate(user);
    await user.type(screen.getByLabelText(/admin\.common\.labelEn/), 'FY2030');
    await user.type(screen.getByLabelText(/admin\.common\.labelFr/), 'AF2030');
    fireEvent.change(screen.getByLabelText(/admin\.fiscalYears\.endDate/), {
      target: { value: '2020-01-01' },
    });
    await user.click(screen.getByRole('button', { name: 'admin.common.create' }));
    expect(await screen.findByText('admin.fiscalYears.endAfterStart')).toBeInTheDocument();
    expect(onCall).not.toHaveBeenCalled();
  });

  it('refuses a missing date', async () => {
    const onCall = vi.fn();
    setTrpc({
      queries: { 'appSettings.fiscalYears.list': { data: [] } },
      mutations: { 'appSettings.fiscalYears.create': { onCall } },
    });
    const user = userEvent.setup();
    await openCreate(user);
    await user.type(screen.getByLabelText(/admin\.common\.labelEn/), 'FY2030');
    await user.type(screen.getByLabelText(/admin\.common\.labelFr/), 'AF2030');
    fireEvent.change(screen.getByLabelText(/admin\.fiscalYears\.startDate/), {
      target: { value: '' },
    });
    await user.click(screen.getByRole('button', { name: 'admin.common.create' }));
    expect(await screen.findByText('admin.fiscalYears.datesRequired')).toBeInTheDocument();
    expect(onCall).not.toHaveBeenCalled();
  });

  it('creates the year, trimming the labels and sending real dates', async () => {
    const onCall = vi.fn();
    setTrpc({
      queries: { 'appSettings.fiscalYears.list': { data: [] } },
      mutations: { 'appSettings.fiscalYears.create': { onCall } },
    });
    const user = userEvent.setup();
    await openCreate(user);
    await user.type(screen.getByLabelText(/admin\.common\.labelEn/), '  FY2030  ');
    await user.type(screen.getByLabelText(/admin\.common\.labelFr/), 'AF2030');
    await user.click(screen.getByRole('button', { name: 'admin.common.create' }));

    const payload = onCall.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.label).toEqual({ en: 'FY2030', 'fr-CA': 'AF2030' });
    expect(payload.startDate).toBeInstanceOf(Date);
    expect(payload.isCurrent).toBe(false);
    expect(payload.closed).toBe(false);
  });

  it('saves an edit as a patch against the row it opened', async () => {
    const onCall = vi.fn();
    setTrpc({ mutations: { 'appSettings.fiscalYears.update': { onCall } } });
    const user = userEvent.setup();
    show();
    await user.click(screen.getByText('FY2026'));
    await user.click(await screen.findByRole('button', { name: /admin.common.edit/ }));
    await user.click(await screen.findByRole('button', { name: 'admin.common.saveChanges' }));
    expect(onCall.mock.calls[0][0]).toMatchObject({ id: 'fy-2026' });
  });

  it('shows the server’s reason and keeps the form open', async () => {
    /**
     * Closing on failure discards what was typed and leaves somebody guessing whether
     * it saved — and the server's message here is the actionable part ("overlaps FY2027").
     */
    setTrpc({
      mutations: {
        'appSettings.fiscalYears.update': {
          outcome: 'error',
          // A real Error, because the page distinguishes one from an unknown rejection.
          error: new Error('Overlaps FY2027') as never,
        },
      },
    });
    const user = userEvent.setup();
    show();
    await user.click(screen.getByText('FY2026'));
    await user.click(await screen.findByRole('button', { name: /admin.common.edit/ }));
    await user.click(await screen.findByRole('button', { name: 'admin.common.saveChanges' }));
    expect(await screen.findByText('Overlaps FY2027')).toBeInTheDocument();
    expect(screen.getByDisplayValue('FY2026')).toBeInTheDocument();
  });

  it('closes without writing on cancel', async () => {
    const onCall = vi.fn();
    setTrpc({ mutations: { 'appSettings.fiscalYears.update': { onCall } } });
    const user = userEvent.setup();
    show();
    await user.click(screen.getByText('FY2026'));
    await user.click(await screen.findByRole('button', { name: /admin.common.edit/ }));
    await user.click(await screen.findByRole('button', { name: 'admin.common.cancel' }));
    expect(onCall).not.toHaveBeenCalled();
    expect(screen.queryByDisplayValue('AF2026')).not.toBeInTheDocument();
  });

  it('flags the year as current, or closed, from the form', async () => {
    const onCall = vi.fn();
    setTrpc({
      queries: { 'appSettings.fiscalYears.list': { data: [] } },
      mutations: { 'appSettings.fiscalYears.create': { onCall } },
    });
    const user = userEvent.setup();
    await openCreate(user);
    await user.type(screen.getByLabelText(/admin\.common\.labelEn/), 'FY2030');
    await user.type(screen.getByLabelText(/admin\.common\.labelFr/), 'AF2030');
    // VeloExpense: by role — the checkbox now carries its own name (f10), so the label
    // text matches both it and the hidden input the <label for> points at.
    await user.click(screen.getByRole('checkbox', { name: /admin\.fiscalYears\.currentFY/ }));
    await user.click(screen.getByRole('checkbox', { name: /admin\.fiscalYears\.closed/ }));
    await user.click(screen.getByRole('button', { name: 'admin.common.create' }));
    expect(onCall.mock.calls[0][0]).toMatchObject({ isCurrent: true, closed: true });
  });

  it('says it is saving rather than letting the button be pressed twice', async () => {
    setTrpc({ mutations: { 'appSettings.fiscalYears.update': { isPending: true } } });
    const user = userEvent.setup();
    show();
    await user.click(screen.getByText('FY2026'));
    await user.click(await screen.findByRole('button', { name: /admin.common.edit/ }));
    expect(await screen.findByRole('button', { name: 'admin.common.saving' })).toBeDisabled();
  });
});

// ── Filtering ─────────────────────────────────────────────────────────────────

describe('filtering', () => {
  const three = [
    fy({
      id: 'a',
      label: { en: 'FY2025' },
      isCurrent: false,
      closed: true,
      startDate: iso('2025-01-01'),
      endDate: iso('2025-12-31'),
    }),
    fy({ id: 'b', label: { en: 'FY2026' }, isCurrent: true }),
    fy({
      id: 'c',
      label: { en: 'FY2027' },
      isCurrent: false,
      closed: false,
      startDate: iso('2027-01-01'),
      endDate: iso('2027-12-31'),
    }),
  ];

  const rowNames = () =>
    screen
      .getAllByRole('row')
      .slice(1)
      .map((r) => r.querySelector('td')?.textContent?.trim())
      .filter(Boolean);

  const filterCol = async (
    user: ReturnType<typeof userEvent.setup>,
    column: string,
    pick: string,
  ) => {
    const header = screen.getByText(column).closest('th') as HTMLElement;
    const buttons = within(header).getAllByRole('button', { name: 'table.colMenu.menu' });
    await user.click(buttons[buttons.length - 1]);
    await user.click(await screen.findByText('table.colMenu.filter'));
    await screen.findByText('table.colMenu.apply');
    const all = screen.getAllByText(pick);
    await user.click(all[all.length - 1]);
    await user.click(screen.getByText('table.colMenu.apply'));
  };

  it('narrows to just the closed years', async () => {
    const user = userEvent.setup();
    setTrpc({ queries: { 'appSettings.fiscalYears.list': { data: three } } });
    show();
    await filterCol(user, 'admin.common.status', 'admin.fiscalYears.statusClosed');
    expect(rowNames()).toEqual(['FY2025']);
  });

  it('narrows to the current one', async () => {
    const user = userEvent.setup();
    setTrpc({ queries: { 'appSettings.fiscalYears.list': { data: three } } });
    show();
    await filterCol(user, 'admin.common.status', 'admin.fiscalYears.statusCurrent');
    expect(rowNames()).toEqual(['FY2026']);
  });

  it('narrows to the open ones — neither current nor closed', async () => {
    const user = userEvent.setup();
    setTrpc({ queries: { 'appSettings.fiscalYears.list': { data: three } } });
    show();
    await filterCol(user, 'admin.common.status', 'admin.fiscalYears.statusOpen');
    expect(rowNames()).toEqual(['FY2027']);
  });

  it('clears back to the whole list', async () => {
    const user = userEvent.setup();
    setTrpc({ queries: { 'appSettings.fiscalYears.list': { data: three } } });
    show();
    await filterCol(user, 'admin.common.status', 'admin.fiscalYears.statusClosed');
    expect(rowNames()).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'table.misc.clearFilters' }));
    expect(rowNames()).toHaveLength(3);
  });
});

// ── A year the seed never named ───────────────────────────────────────────────

describe('a year with no label and no external ids', () => {
  /**
   * `label` and `externalIds` are both `Json` columns and both null on a row a migration
   * wrote. A fiscal year is what every report, budget and posting period is dated
   * against, so a year nobody can open is a year nobody can close.
   */
  const bare = () => fy({ id: 'fy-legacy', label: null, externalIds: null, isCurrent: false });

  it('names it by its id rather than leaving the cell blank', () => {
    setTrpc({ queries: { 'appSettings.fiscalYears.list': { data: [bare()] } } });
    show();
    expect(screen.getByText('admin.common.unnamed')).toBeInTheDocument();
  });

  it('opens the view drawer with both halves of the name dashed', async () => {
    const user = userEvent.setup();
    setTrpc({ queries: { 'appSettings.fiscalYears.list': { data: [bare()] } } });
    show();
    await user.click(screen.getByText('admin.common.unnamed'));
    expect(await screen.findByText('admin.common.identity')).toBeInTheDocument();
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(2);
  });

  it('opens the edit form with empty label boxes rather than the string "null"', async () => {
    const user = userEvent.setup();
    setTrpc({ queries: { 'appSettings.fiscalYears.list': { data: [bare()] } } });
    show();
    await rowMenu(user, 'admin.common.unnamed');
    await user.click(await screen.findByText('admin.common.edit'));
    const en = (await screen.findByLabelText(/admin\.common\.labelEn/)) as HTMLInputElement;
    expect(en.value).toBe('');
  });
});

// ── Export ────────────────────────────────────────────────────────────────────

describe('exporting the calendar', () => {
  /**
   * The fiscal calendar is what an auditor reconciles a posting period against, and what
   * a NetSuite admin checks their own periods line up with. So the dates go out as ISO —
   * a locale-formatted date in a file read in two countries is two different days — and
   * the state goes out as a word rather than a pair of booleans nobody can interpret.
   */
  const exportCsv = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(screen.getByRole('button', { name: 'table.export.trigger' }));
    await user.click(await screen.findByText('CSV'));
    return h.downloads.at(-1)?.csv ?? '';
  };

  it('writes both ends of the year as ISO dates', async () => {
    const user = userEvent.setup();
    setTrpc();
    show();
    const csv = await exportCsv(user);
    expect(csv).toContain('2026-01-01');
    expect(csv).toContain('2026-12-31');
  });

  it('spells the state out rather than exporting two booleans', async () => {
    const user = userEvent.setup();
    setTrpc({
      queries: {
        'appSettings.fiscalYears.list': {
          data: [
            fy(),
            fy({ id: 'b', label: { en: 'FY2025' }, isCurrent: false, closed: true }),
            fy({ id: 'c', label: { en: 'FY2027' }, isCurrent: false, closed: false }),
          ],
        },
      },
    });
    show();
    const csv = await exportCsv(user);
    expect(csv).toContain('admin.fiscalYears.statusCurrent');
    expect(csv).toContain('admin.fiscalYears.statusClosed');
    expect(csv).toContain('admin.fiscalYears.statusOpen');
  });

  it('flattens the external ids into one readable cell', async () => {
    /** This is the column somebody uses to check the NetSuite period id matches. */
    const user = userEvent.setup();
    setTrpc({
      queries: {
        'appSettings.fiscalYears.list': {
          data: [fy({ externalIds: { netsuite: 'PER-2026', sap: 'FY26' } })],
        },
      },
    });
    show();
    const csv = await exportCsv(user);
    expect(csv).toContain('netsuite: PER-2026');
    expect(csv).toContain('sap: FY26');
  });

  it('leaves a year with no external ids empty rather than exporting braces', async () => {
    const user = userEvent.setup();
    setTrpc({ queries: { 'appSettings.fiscalYears.list': { data: [fy({ externalIds: null })] } } });
    show();
    const csv = await exportCsv(user);
    expect(csv).not.toContain('{}');
    expect(csv).not.toContain('undefined');
  });

  it('names an unlabelled year rather than exporting a blank cell', async () => {
    const user = userEvent.setup();
    setTrpc({ queries: { 'appSettings.fiscalYears.list': { data: [fy({ label: null })] } } });
    show();
    expect(await exportCsv(user)).toContain('admin.common.unnamed');
  });
});
