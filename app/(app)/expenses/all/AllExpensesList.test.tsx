import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTrpcMock, type TrpcMockConfig } from '@/test-utils/trpc';

/**
 * /expenses/all — AP's cross-report expense view.
 *
 * The page exists to answer "which expenses are missing a receipt" without opening
 * thirty reports one at a time, so the suite is built around the three things that
 * makes possible:
 *
 *   · **Missing is impossible to miss, and one click away.** The receipt column names
 *     the absence rather than showing a zero, and the filter reaches the SERVER so the
 *     count is of every expense, not the page that happens to be loaded.
 *   · **A chase only goes out for receipts that are actually missing.** Asking somebody
 *     for a receipt they already filed is a confusing message to receive, so the bulk
 *     action counts the chaseable SUBSET of the selection and says so when the subset
 *     is empty.
 *   · **The row is the way out.** Clicking anywhere in it — and the report-number link
 *     within it — carries `?expense=` so the workbench lands on the charge that was
 *     clicked; on a twelve-expense claim the report's first line is almost never the
 *     one being asked about.
 */

const h = vi.hoisted(() => ({
  trpc: undefined as unknown,
  /** What the export menu handed to the browser. */
  downloads: [] as Array<{ filename: string; csv: string }>,
  /** Every href the locale-aware router was asked to navigate to. */
  pushes: [] as string[],
}));

// The export menu's real builder runs; only the browser hand-off is intercepted.
vi.mock('@/lib/exportCsv', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  downloadCsv: (filename: string, csv: string) => {
    h.downloads.push({ filename, csv });
  },
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
/**
 * `@/i18n/navigation` destructures next-intl's `createNavigation`, which imports
 * `next/navigation` as a bare specifier from inside node_modules — where `vi.mock`
 * does not reach. Mocking this module is what keeps the import out of the graph.
 */
vi.mock('@/i18n/navigation', () => ({
  useRouter: () => ({
    push: (href: string) => {
      h.pushes.push(href);
    },
  }),
  Link: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

import { AllExpensesList } from './AllExpensesList';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const expense = (over: Record<string, unknown> = {}) => ({
  id: 'exp-1',
  date: '2026-07-28T12:00:00.000Z',
  merchant: 'Canoe',
  amountMinor: '12500',
  currency: { code: 'CAD', symbol: '$' },
  receiptCount: 0,
  categoryLabel: { en: 'Meals' },
  report: {
    id: 'rep-1',
    number: 'EXP-1042',
    status: 'SUBMITTED',
    submitter: { id: 'u-1', firstName: 'Dana', lastName: 'Patel', email: 'dana@e.inc' },
  },
  ...over,
});

const report = (over: Record<string, unknown> = {}) => ({ ...expense().report, ...over });

/** One charge per status, so a union of three is three rows and not four. */
const fourStatuses = () => [
  expense({ id: 'exp-s', merchant: 'Canoe', report: report({ status: 'SUBMITTED' }) }),
  expense({
    id: 'exp-a',
    merchant: 'Air Canada',
    report: report({ id: 'rep-2', number: 'EXP-1043', status: 'APPROVED' }),
  }),
  expense({
    id: 'exp-r',
    merchant: 'Via Rail',
    report: report({ id: 'rep-3', number: 'EXP-1044', status: 'RETURNED' }),
  }),
  expense({
    id: 'exp-x',
    merchant: 'Petro-Canada',
    report: report({ id: 'rep-4', number: 'EXP-1045', status: 'REJECTED' }),
  }),
];

function setTrpc(items: unknown[] = [expense()], over: TrpcMockConfig = {}) {
  h.trpc = createTrpcMock({
    ...over,
    queries: {
      'expenseApprovals.expenses': {
        // The PAGED shape. This list is cursor-paginated now: it took 200 rows and stopped,
        // with nothing on screen saying it had truncated (GA readiness report F19).
        data: { pages: [{ items, nextCursor: null }] },
        ...over.queries?.['expenseApprovals.expenses'],
      },
      ...over.queries,
    },
  });
}

/**
 * A mount with NOTHING on the filter bar.
 *
 * The list opens on three statuses now, so a fixture that is REIMBURSED, REJECTED, or a
 * status this build does not know is filtered out before the test can assert anything about
 * how it RENDERS. Changing such a fixture to a status that survives the default would
 * weaken the test into asserting the default; clearing the bar leaves it asserting what it
 * was written to assert.
 *
 * A pinned view with no clauses is a real user state — clear the bar, save it, pin it — and
 * a pinned view replaces the opening default outright.
 */
function setTrpcUnfiltered(items: unknown[] = [expense()], over: TrpcMockConfig = {}) {
  setTrpc(items, {
    ...over,
    queries: {
      'savedViews.list': {
        data: [{ id: 'uv-clear', name: 'Everything', pinned: true, state: { filters: [] } }],
      },
      ...over.queries,
    },
  });
}

const show = () => render(<AllExpensesList />);

/** A spy shaped like the `onCall` hook the tRPC mock takes. */
type OnCall = ReturnType<typeof vi.fn<(...args: unknown[]) => void>>;

const rowTexts = () =>
  screen
    .getAllByRole('row')
    .slice(1)
    .map((r) => r.textContent ?? '')
    .filter((s) => s.length > 0);

/**
 * A filter-bar pill, found by the bold field label it leads with.
 *
 * Scoped rather than queried globally: the pills carry the same column NAMES the table
 * headers do, so a bare `getByText` is ambiguous.
 */
const pillFor = (fieldLabel: string): HTMLElement =>
  screen
    .getAllByText(fieldLabel)
    .map((el) => el.parentElement)
    .find((el): el is HTMLElement => el?.tagName === 'SPAN' && !el.closest('th')) as HTMLElement;

const statusPill = () => pillFor('expenses.columns.status');

/** The value chips on the status pill, in the order they are drawn. */
const statusChips = () =>
  within(statusPill()).getAllByRole('button', { name: 'table.filters.removeValue' });

/**
 * The preset the date pill is SET to.
 *
 * Not `getByText('Last 90 days')`: the `within` editor renders every preset in
 * `DATE_PRESETS` as an `<option>`, so the words are on the page whichever one is chosen —
 * an assertion on them passes just as happily against a twelve-month default.
 */
const datePreset = () =>
  within(pillFor('expenses.columns.date')).getByRole('combobox') as HTMLSelectElement;

/** Tick a row's selection checkbox — the first cell, not the row itself. */
const selectRow = async (user: ReturnType<typeof userEvent.setup>, index: number) => {
  await user.click(screen.getAllByRole('checkbox', { name: 'table.misc.selectRow' })[index]);
};

/** Open the bulk menu and fire its single action. */
async function requestReceipts(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: /table\.misc\.selected/ }));
  await user.click(await screen.findByText(/expenses\.allExpenses\.requestReceipts/));
}

afterEach(() => {
  h.trpc = undefined;
  h.downloads = [];
  h.pushes = [];
  vi.restoreAllMocks();
});

// ── The list ──────────────────────────────────────────────────────────────────

describe('the expense list', () => {
  it('reads an expense out with its report, submitter and amount', () => {
    setTrpc();
    show();
    const row = rowTexts()[0];
    expect(row).toContain('EXP-1042');
    expect(row).toContain('Dana Patel');
    expect(row).toContain('Canoe');
    expect(row).toContain('$125.00');
  });

  it('names a missing receipt rather than showing a zero', () => {
    // The reason the page exists — a 0 in a count column is easy to read past.
    setTrpc();
    show();
    expect(screen.getByText('expenses.allExpenses.missing')).toBeInTheDocument();
  });

  it('counts the receipts an expense does have', () => {
    setTrpc([expense({ receiptCount: 2 })]);
    show();
    expect(screen.getByText('expenses.allExpenses.receiptCount:2')).toBeInTheDocument();
    expect(screen.queryByText('expenses.allExpenses.missing')).not.toBeInTheDocument();
  });

  it('links the report number to the clicked expense, not the report’s first line', async () => {
    /**
     * The number used to be plain text, so a screen whose whole job is "find the charge
     * somebody is asking about" could not be used to go and look at it.
     */
    setTrpc();
    show();
    expect(screen.getByRole('link', { name: 'EXP-1042' })).toHaveAttribute(
      'href',
      '/expenses/rep-1?expense=exp-1',
    );
  });

  it('opens the clicked row’s expense from anywhere in the row, not just the number', async () => {
    /**
     * Every row is painted with `cursor-pointer`, so the list already looked clickable
     * while only the report-number link — a sliver of a full-width row — actually went
     * anywhere. A click that lands beside it reads as a broken page, not a missed link.
     *
     * Two rows on two different reports: the handler has to carry the row it was given,
     * not the first one it rendered.
     */
    const user = userEvent.setup();
    setTrpc([
      expense(),
      expense({
        id: 'exp-2',
        merchant: 'Air Canada',
        report: { ...expense().report, id: 'rep-2', number: 'EXP-1043' },
      }),
    ]);
    show();
    await user.click(screen.getByText('Air Canada'));
    expect(h.pushes).toEqual(['/expenses/rep-2?expense=exp-2']);
  });

  it('does not navigate away when a row is ticked for a receipt chase', async () => {
    /**
     * Selection and navigation share the row. Ticking three boxes to chase them in one
     * go must not fire the workbench on the first tick — that abandons the selection
     * and the page it was made on.
     */
    const user = userEvent.setup();
    setTrpc();
    show();
    await selectRow(user, 0);
    expect(h.pushes).toEqual([]);
  });

  it('dashes a charge with no merchant and no category', () => {
    // An imported card charge often has neither until somebody codes it.
    setTrpc([expense({ merchant: null, categoryLabel: null })]);
    show();
    expect(rowTexts()[0]).toContain('—');
  });

  it('shows the report’s own status, since an expense has none of its own', async () => {
    /**
     * Asserts the TRANSLATED label, not the English status key. It used to assert
     * 'Reimbursed' — which is the defect: the badge rendered its title-case status literal,
     * so a fr-CA screen showed "Reimbursed" among French tiles while the filter beside it said
     * "Remboursé" (GA readiness report F43).
     *
     * REIMBURSED is now filtered out by the opening default, so the mount is cleared rather
     * than the fixture changed. This is regression cover for a RENDERING defect: swapping in
     * a status that survives the default would leave it asserting the default instead, and
     * REIMBURSED is the exact status the original defect was reported against.
     */
    setTrpcUnfiltered([expense({ report: report({ status: 'REIMBURSED' }) })]);
    show();
    expect(await screen.findByText('expenses.status.reimbursed')).toBeInTheDocument();
    expect(screen.queryByText('Reimbursed')).not.toBeInTheDocument();
  });

  it('falls back to Submitted for a status it does not recognise', async () => {
    /**
     * A new status shipping server-side must not render an empty badge — and the fallback's
     * label must be translated too, not a MISSING_MESSAGE on `status.something_new`.
     *
     * Cleared mount, for the same reason as the test above and then some: a status this
     * build does not know is not in `DEFAULT_STATUSES` either, so the opening default hides
     * it. That is the allowlist's accepted cost, spelled out on `defaultFilters` — and it is
     * why this test has to reach past the default to say anything about the badge at all.
     */
    setTrpcUnfiltered([expense({ report: report({ status: 'SOMETHING_NEW' }) })]);
    show();
    expect(await screen.findByText('expenses.status.submitted')).toBeInTheDocument();
  });

  it('says so when nothing matches', () => {
    setTrpc([]);
    show();
    expect(screen.getByText('expenses.allExpenses.emptyTitle')).toBeInTheDocument();
    expect(screen.getByText('expenses.allExpenses.emptyBody')).toBeInTheDocument();
  });
});

// ── Narrowing ─────────────────────────────────────────────────────────────────

describe('saved views', () => {
  /**
   * The page's most-used filter used to be a toggle button beside the bar, which made it
   * the one thing on the page that could not be saved, renamed, pinned as somebody's
   * default, or combined with anything else and kept. These cover the machinery that
   * replaced it.
   */

  const userView = (over: Record<string, unknown> = {}) => ({
    id: 'uv-1',
    name: 'Dana’s chase list',
    pinned: false,
    state: {
      filters: [{ id: 'f1', field: 'merchant', op: 'contains', value: 'Air' }],
      visibleColumns: ['date', 'merchant'],
      sort: { field: 'amount', dir: 'desc' },
      density: 'compact',
    },
    ...over,
  });

  const withViews = (views: unknown[], over: TrpcMockConfig = {}) =>
    setTrpc([expense(), expense({ id: 'exp-2', merchant: 'Air Canada' })], {
      ...over,
      queries: { 'savedViews.list': { data: views }, ...over.queries },
    });

  const openViews = async (user: ReturnType<typeof userEvent.setup>, activeName: string) =>
    user.click(screen.getByRole('button', { name: activeName }));

  it('applies a saved view’s filters, sort and columns', async () => {
    const user = userEvent.setup();
    withViews([userView()]);
    show();
    await openViews(user, 'expenses.allExpenses.viewDefault');
    await user.click(await screen.findByRole('button', { name: 'Dana’s chase list' }));
    // The stored text filter narrows the loaded rows in the browser.
    expect(rowTexts()).toHaveLength(1);
    expect(rowTexts()[0]).toContain('Air Canada');
  });

  it('ignores a view id that is not in the list', async () => {
    // A stale id from a deleted view must not blank the page.
    const user = userEvent.setup();
    withViews([]);
    show();
    await openViews(user, 'expenses.allExpenses.viewDefault');
    expect(screen.getByText('expenses.allExpenses.viewMissingReceipt')).toBeInTheDocument();
  });

  it('opens on a pinned view instead of the opening default', async () => {
    /**
     * "Unless there's a change in the saved filter" is the whole rule: the pre-filled
     * window and statuses are what the page does when nobody has said otherwise, and
     * somebody who pinned a view has said otherwise. It replaces BOTH clauses.
     */
    withViews([userView({ pinned: true })]);
    show();
    await waitFor(() => expect(rowTexts()).toHaveLength(1));
    expect(rowTexts()[0]).toContain('Air Canada');
  });

  it('saves the current filters as a new view', async () => {
    const onCall = vi.fn();
    const user = userEvent.setup();
    vi.spyOn(window, 'prompt').mockReturnValue('Receipts to chase');
    withViews([], { mutations: { 'savedViews.create': { onCall } } });
    show();
    await openViews(user, 'expenses.allExpenses.viewDefault');
    await user.click(await screen.findByText('Save current as new view'));
    expect(onCall.mock.calls[0][0]).toMatchObject({
      resource: 'expenses',
      name: 'Receipts to chase',
    });
  });

  it('saves nothing when the name prompt is dismissed', async () => {
    const onCall = vi.fn();
    const user = userEvent.setup();
    vi.spyOn(window, 'prompt').mockReturnValue(null);
    withViews([], { mutations: { 'savedViews.create': { onCall } } });
    show();
    await openViews(user, 'expenses.allExpenses.viewDefault');
    await user.click(await screen.findByText('Save current as new view'));
    expect(onCall).not.toHaveBeenCalled();
  });

  it('renames a view, and leaves it alone on cancel or on the same name', async () => {
    const onCall = vi.fn();
    const user = userEvent.setup();
    const prompt = vi.spyOn(window, 'prompt');
    withViews([userView()], { mutations: { 'savedViews.update': { onCall } } });
    show();
    await openViews(user, 'expenses.allExpenses.viewDefault');

    prompt.mockReturnValue(null);
    await user.click((await screen.findAllByLabelText('Rename'))[0]);
    expect(onCall).not.toHaveBeenCalled();

    prompt.mockReturnValue('Dana’s chase list');
    await user.click(screen.getAllByLabelText('Rename')[0]);
    expect(onCall).not.toHaveBeenCalled();

    prompt.mockReturnValue('AP chase list');
    await user.click(screen.getAllByLabelText('Rename')[0]);
    expect(onCall).toHaveBeenCalledWith({ id: 'uv-1', name: 'AP chase list' });
  });

  it('deletes a view only once it is confirmed', async () => {
    const onCall = vi.fn();
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    withViews([userView()], { mutations: { 'savedViews.delete': { onCall } } });
    show();
    await openViews(user, 'expenses.allExpenses.viewDefault');
    await user.click((await screen.findAllByLabelText('Delete'))[0]);
    expect(onCall).not.toHaveBeenCalled();

    confirm.mockReturnValue(true);
    await user.click(screen.getAllByLabelText('Delete')[0]);
    expect(onCall).toHaveBeenCalledWith({ id: 'uv-1' });
  });
});

describe('narrowing the list', () => {
  /**
   * The page used to carry its own strip of controls above the table — a `Missing receipt`
   * toggle and two bare date inputs — beside a filter bar that could not reach either
   * column. Two filter UIs, one of which could not be saved, shared, or read back from a
   * view. There is one now, and `Missing receipt` is a system view.
   */

  /** The arguments the last query was made with. */
  const queryArgs = (onCall: OnCall) =>
    onCall.mock.calls.at(-1)?.[0] as {
      from?: Date;
      to?: Date;
      missingReceipt?: boolean;
    };

  const withOnCall = (onCall: OnCall, items: unknown[] = [expense()]) =>
    setTrpc(items, {
      queries: {
        'expenseApprovals.expenses': {
          data: { pages: [{ items, nextCursor: null }] },
          onCall,
        },
      },
    });

  /** Pick a view out of the saved-views dropdown by its name. The trigger is labelled
   *  with the ACTIVE view, so opening it means clicking that. */
  const pickView = async (user: ReturnType<typeof userEvent.setup>, name: string) => {
    await user.click(screen.getByRole('button', { name: 'expenses.allExpenses.viewDefault' }));
    await user.click(await screen.findByRole('button', { name }));
  };

  it('opens on the last ninety days, without being asked', async () => {
    /**
     * Twelve months of every status was not wrong to LOOK at; it was wrong to OPEN on. AP's
     * first question is about work in flight, and a year of settled history is what the
     * reader had to narrow past to reach it, every session.
     *
     * The window is asserted as a BAND, not pinned to a date. Fake timers are forbidden in
     * this file — the component debounces its filters, and `vi.useFakeTimers` without
     * `userEvent.setup({ advanceTimers })` deadlocks every interaction in the suite. A band
     * of one month either side is wide enough that no real clock falls outside it and
     * narrow enough to fail the moment the token goes back to a year.
     */
    const onCall: OnCall = vi.fn();
    withOnCall(onCall);
    show();
    const args = queryArgs(onCall);
    expect(args.from).toBeInstanceOf(Date);
    const months =
      (Date.now() - (args.from as Date).getTime()) / ((1000 * 60 * 60 * 24 * 365.25) / 12);
    expect(months).toBeGreaterThan(2.5);
    expect(months).toBeLessThan(3.5);
  });

  it('says on the bar that it is doing it', async () => {
    /**
     * A PRE-FILLED CLAUSE, not a hidden floor. A default buried in the query leaves "why is
     * this expense not in the list" with no answer on screen.
     */
    withOnCall(vi.fn() as OnCall);
    show();
    expect(datePreset().value).toBe('last90');
    // …and it is the words the reader sees, not just the token underneath them.
    expect(
      within(datePreset()).getByRole('option', { name: 'Last 90 days', selected: true }),
    ).toBeInTheDocument();
  });

  it('opens on the three statuses that are still in flight', async () => {
    /**
     * The queue holds what is still MOVING. REJECTED and REIMBURSED are both finished work,
     * and the second of them is the bulk of any list older than a quarter.
     *
     * Named POSITIVELY — three statuses, not two exclusions. "Not rejected, not reimbursed"
     * describes the same set only by accident of today's enum.
     */
    withOnCall(vi.fn() as OnCall, fourStatuses());
    show();
    expect(rowTexts()).toHaveLength(3);
    expect(screen.getByText('Canoe')).toBeInTheDocument(); // SUBMITTED
    expect(screen.getByText('Air Canada')).toBeInTheDocument(); // APPROVED
    expect(screen.getByText('Via Rail')).toBeInTheDocument(); // RETURNED
    expect(screen.queryByText('Petro-Canada')).not.toBeInTheDocument(); // REJECTED
  });

  it('says that on the bar too, as one pill with three removable values', async () => {
    /**
     * The second half of "a clause, not a hidden floor". Three `equals` clauses on one field
     * are drawn as ONE pill reading "Status is Submitted or Approved or Returned", so the
     * reader can see the whole sentence and take any single word out of it.
     */
    withOnCall(vi.fn() as OnCall, fourStatuses());
    show();
    const pill = statusPill();
    expect(within(pill).getByText('expenses.status.submitted')).toBeInTheDocument();
    expect(within(pill).getByText('expenses.status.approved')).toBeInTheDocument();
    expect(within(pill).getByText('expenses.status.returned')).toBeInTheDocument();
    expect(statusChips()).toHaveLength(3);
  });

  it('drops one status when its value comes off the pill, and keeps the rest', async () => {
    const user = userEvent.setup();
    withOnCall(vi.fn() as OnCall, fourStatuses());
    show();
    await user.click(statusChips()[0]); // SUBMITTED
    expect(statusChips()).toHaveLength(2);
    expect(rowTexts()).toHaveLength(2);
    expect(screen.queryByText('Canoe')).not.toBeInTheDocument();
  });

  it('returns every status when the whole pill goes, and leaves the window alone', async () => {
    /**
     * The two default clauses are independent. Taking the status pill off must not quietly
     * widen the date window with it — that would turn "show me everything in flight AND
     * settled" into an unbounded query nobody asked for.
     */
    const user = userEvent.setup();
    const onCall: OnCall = vi.fn();
    withOnCall(onCall, fourStatuses());
    show();
    const removeBlock = within(statusPill()).getByRole('button', {
      name: 'table.filters.removeCondition',
    });
    await user.click(removeBlock);
    expect(rowTexts()).toHaveLength(4);
    expect(screen.getByText('Petro-Canada')).toBeInTheDocument();
    expect(datePreset().value).toBe('last90');
    await waitFor(() => expect(queryArgs(onCall).from).toBeInstanceOf(Date));
  });

  it('clears the statuses as well as the window on the all-time view', async () => {
    // `All time` means all of it — both clauses, not just the one with a date on it.
    const user = userEvent.setup();
    withOnCall(vi.fn() as OnCall, fourStatuses());
    show();
    await pickView(user, 'expenses.allExpenses.viewAllTime');
    await waitFor(() => expect(rowTexts()).toHaveLength(4));
  });

  it('puts the default back unchanged when the default view is picked', async () => {
    /**
     * `sys:default` is the opening default written out as a view, and the two are built from
     * the same `statusClauses` for exactly this reason: clicking the view the list already
     * opens on must not silently widen the window or change the statuses. A second,
     * hand-written copy of the clauses is the kind of thing that drifts by one token and
     * nobody notices for a year.
     */
    const user = userEvent.setup();
    const onCall: OnCall = vi.fn();
    withOnCall(onCall, fourStatuses());
    show();
    await pickView(user, 'expenses.allExpenses.viewAllTime');
    await waitFor(() => expect(rowTexts()).toHaveLength(4));
    // The dropdown trigger carries the ACTIVE view's name, so it reads `All time` now.
    await user.click(screen.getByRole('button', { name: 'expenses.allExpenses.viewAllTime' }));
    await user.click(
      await screen.findByRole('button', { name: 'expenses.allExpenses.viewDefault' }),
    );
    await waitFor(() => expect(rowTexts()).toHaveLength(3));
    expect(datePreset().value).toBe('last90');
    await waitFor(() => expect(queryArgs(onCall).from).toBeInstanceOf(Date));
  });

  it('filters the statuses over the rows it has, not over the ones it has not fetched', async () => {
    /**
     * The ACCEPTED limitation of the status half of the default, pinned so that a reader in
     * eighteen months can tell it was chosen rather than missed.
     *
     * `date` is a completeness guarantee: it is a query argument, so every matching row is
     * reachable by paging. `status` is not. `expenseApprovals.expenses` takes a single
     * optional status, not a set, and widening it is a backend change that was ruled out of
     * scope — so the status clauses run over the rows already FETCHED. The reader sees a
     * filter of a prefix, not a prefix of the filter.
     *
     * The truncation hides itself, which is why it is written down rather than left to be
     * discovered: status correlates with age, the sort is date-descending, so the client
     * filter's yield is highest on page one and falls thereafter. Page one looks the most
     * complete this list will ever look.
     *
     * Do NOT "fix" this by adding a `status` branch to `queryArgs`. That loop keeps one
     * value per field, so three status clauses would reach the server as one and silently
     * narrow the list to a single status — worse than the client filter, not better.
     */
    const onCall: OnCall = vi.fn();
    const page = [
      expense({ id: 'p-1', merchant: 'Still moving', report: report({ status: 'SUBMITTED' }) }),
      ...['a', 'b', 'c'].map((k) =>
        expense({
          id: `p-${k}`,
          merchant: `Settled ${k}`,
          report: report({ id: `rep-${k}`, number: `EXP-20${k}`, status: 'REIMBURSED' }),
        }),
      ),
    ];
    withOnCall(onCall, page);
    show();
    // The server is never told about status — there is no such argument in the call.
    expect(queryArgs(onCall)).not.toHaveProperty('status');
    // …so it returned a page that is three-quarters settled, and the browser dropped it.
    expect(rowTexts()).toHaveLength(1);
    expect(rowTexts()[0]).toContain('Still moving');
    // The window DID reach the server. That half of the default is complete; this half is
    // complete only over what has been loaded.
    expect(queryArgs(onCall).from).toBeInstanceOf(Date);
  });

  it('widens to everything when the window is cleared', async () => {
    const user = userEvent.setup();
    const onCall: OnCall = vi.fn();
    withOnCall(onCall);
    show();
    await user.click(screen.getByText('table.misc.clearFilters'));
    // The clauses reach the query through a 300 ms debounce.
    await waitFor(() => expect(queryArgs(onCall).from).toBeUndefined());
    expect(queryArgs(onCall).to).toBeUndefined();
  });

  it('asks the SERVER for the receiptless ones, from a saved view', async () => {
    /**
     * Filtering the loaded page would answer "which of the first 200 expenses are missing a
     * receipt", which is a different and much less useful question — and this list is paged.
     */
    const user = userEvent.setup();
    const onCall: OnCall = vi.fn();
    withOnCall(onCall);
    show();
    await pickView(user, 'expenses.allExpenses.viewMissingReceipt');
    await waitFor(() => expect(queryArgs(onCall).missingReceipt).toBe(true));
    // …and the view carries the window with it: a chase list of receipts missing since
    // 2023 is not a work queue.
    expect(queryArgs(onCall).from).toBeInstanceOf(Date);
  });

  it('sends no receipt filter at all by default', () => {
    // `missingReceipt: false` would be a filter for expenses that HAVE receipts.
    const onCall: OnCall = vi.fn();
    withOnCall(onCall);
    show();
    expect(queryArgs(onCall).missingReceipt).toBeUndefined();
  });

  it('keeps showing every row when the receipt filter is on', async () => {
    /**
     * The trap in moving these two fields onto the bar: the client-side pass filters on a
     * row's TEXT, and neither `date` nor `receipt` has any. Running them twice would drop
     * every row on the floor — the list would go empty the moment somebody used the very
     * filter the page exists for.
     */
    const user = userEvent.setup();
    withOnCall(vi.fn() as OnCall, [expense(), expense({ id: 'exp-2', merchant: 'Air Canada' })]);
    show();
    await pickView(user, 'expenses.allExpenses.viewMissingReceipt');
    expect(rowTexts()).toHaveLength(2);
  });

  it('reads "not missing" as the other side of the enum', async () => {
    /**
     * The server used to treat `missingReceipt: false` and "unset" as the same request,
     * which was fine for a two-state toggle and wrong once a bar can express both sides.
     * A filter for "has a receipt" that silently returned everything would be worse than
     * not offering it.
     */
    const user = userEvent.setup();
    const onCall: OnCall = vi.fn();
    setTrpc([expense()], {
      queries: {
        'expenseApprovals.expenses': {
          data: { pages: [{ items: [expense()], nextCursor: null }] },
          onCall,
        },
        'savedViews.list': {
          data: [
            {
              id: 'uv-has',
              name: 'Has a receipt',
              pinned: false,
              // "receipt doesNotEqual missing" is the other side of a two-value enum.
              state: {
                filters: [{ id: 'f1', field: 'receipt', op: 'doesNotEqual', value: 'missing' }],
              },
            },
          ],
        },
      },
    });
    show();
    await user.click(screen.getByRole('button', { name: 'expenses.allExpenses.viewDefault' }));
    await user.click(await screen.findByRole('button', { name: 'Has a receipt' }));
    await waitFor(() => expect(queryArgs(onCall).missingReceipt).toBe(false));
  });

  it('drops the window entirely on the all-time view', async () => {
    const user = userEvent.setup();
    const onCall: OnCall = vi.fn();
    withOnCall(onCall);
    show();
    await pickView(user, 'expenses.allExpenses.viewAllTime');
    await waitFor(() => expect(queryArgs(onCall).from).toBeUndefined());
  });

  it('ignores a date clause nobody has finished typing', async () => {
    /**
     * `on` with an empty value resolves to no bounds at all. Sending `from: undefined`
     * rather than an Invalid Date is the difference between "no window yet" and a query
     * the server cannot answer.
     */
    const onCall: OnCall = vi.fn();
    setTrpc([expense()], {
      queries: {
        'expenseApprovals.expenses': {
          data: { pages: [{ items: [expense()], nextCursor: null }] },
          onCall,
        },
        'savedViews.list': {
          data: [
            {
              id: 'uv-half',
              name: 'Half typed',
              pinned: true,
              state: { filters: [{ id: 'f1', field: 'date', op: 'on', value: '' }] },
            },
          ],
        },
      },
    });
    show();
    await waitFor(() => expect(queryArgs(onCall).from).toBeUndefined());
    expect(queryArgs(onCall).to).toBeUndefined();
  });

  it('narrows on every text column the bar offers, not just the merchant', async () => {
    /**
     * `fieldText` is what a clause compares against, and a field it does not answer for
     * silently matches nothing — so a filter on the report number or the category would
     * empty the list rather than narrow it.
     */
    for (const [field, value, expected] of [
      ['report', 'EXP-1042', 'Canoe'],
      ['category', 'Meals', 'Canoe'],
      ['submitter', 'Dana', 'Canoe'],
    ] as const) {
      cleanup();
      setTrpc([expense(), expense({ id: 'exp-2', merchant: 'Air Canada' })], {
        queries: {
          'savedViews.list': {
            data: [
              {
                id: `uv-${field}`,
                name: field,
                pinned: true,
                state: { filters: [{ id: 'f1', field, op: 'contains', value }] },
              },
            ],
          },
        },
      });
      show();
      await waitFor(() => expect(rowTexts().length).toBeGreaterThan(0));
      expect(rowTexts()[0], field).toContain(expected);
    }
  });

  it('honours the negative and exact operators too', async () => {
    // A bar that offers four operators and applies one is worse than a bar that offers one.
    for (const [op, value, expected] of [
      ['doesNotContain', 'Air', 'Canoe'],
      ['equals', 'air canada', 'Air Canada'],
      ['doesNotEqual', 'canoe', 'Air Canada'],
    ] as const) {
      cleanup();
      setTrpc([expense(), expense({ id: 'exp-2', merchant: 'Air Canada' })], {
        queries: {
          'savedViews.list': {
            data: [
              {
                id: `uv-${op}`,
                name: op,
                pinned: true,
                state: { filters: [{ id: 'f1', field: 'merchant', op, value }] },
              },
            ],
          },
        },
      });
      show();
      await waitFor(() => expect(rowTexts()).toHaveLength(1));
      expect(rowTexts()[0], op).toContain(expected);
    }
  });

  it('narrows in the browser on the text columns', async () => {
    const user = userEvent.setup();
    setTrpc([expense(), expense({ id: 'exp-2', merchant: 'Air Canada' })]);
    show();
    const header = screen.getByText('expenses.columns.merchant').closest('th') as HTMLElement;
    const buttons = within(header).getAllByRole('button', { name: 'table.colMenu.menu' });
    await user.click(buttons[buttons.length - 1]);
    await user.click(await screen.findByText('table.colMenu.filter'));
    await user.type(await screen.findByPlaceholderText('table.colMenu.value'), 'canoe');
    await user.click(screen.getByText('table.colMenu.apply'));
    expect(rowTexts()).toHaveLength(1);
    expect(screen.getByText('Canoe')).toBeInTheDocument();
  });
});

// ── Sorting ───────────────────────────────────────────────────────────────────

describe('sorting', () => {
  const sortBy = async (user: ReturnType<typeof userEvent.setup>, column: string) => {
    // Scoped to a `<th>`: the filter bar renders column NAMES on its pills, so a bare
    // `getByText` now finds the date pill as well as the date header.
    const header = screen
      .getAllByText(column)
      .map((el) => el.closest('th'))
      .find(Boolean) as HTMLElement;
    await user.click(within(header).getAllByRole('button', { name: 'table.colMenu.menu' })[0]);
  };

  it('sorts amounts numerically, not as text', async () => {
    /**
     * The amounts are BigInt strings. Comparing them as strings puts "9" above "10",
     * which is exactly backwards for the largest-charge question this column is for.
     */
    const user = userEvent.setup();
    setTrpc([
      expense({ id: 'a', amountMinor: '900', merchant: 'Nine' }),
      expense({ id: 'b', amountMinor: '10000', merchant: 'Hundred' }),
    ]);
    show();
    await sortBy(user, 'expenses.columns.amount');
    expect(rowTexts()[0]).toContain('Nine');
    await sortBy(user, 'expenses.columns.amount');
    expect(rowTexts()[0]).toContain('Hundred');
  });

  it('sorts by date, receipt count and status', async () => {
    const user = userEvent.setup();
    setTrpc([
      expense({ id: 'a', date: '2026-07-28T12:00:00.000Z', receiptCount: 2, merchant: 'Later' }),
      expense({
        id: 'b',
        date: '2026-01-02T12:00:00.000Z',
        receiptCount: 0,
        merchant: 'Earlier',
        report: { ...expense().report, status: 'APPROVED' },
      }),
    ]);
    show();
    await sortBy(user, 'expenses.columns.date');
    expect(rowTexts()[0]).toContain('Earlier');
    await sortBy(user, 'expenses.allExpenses.receiptColumn');
    expect(rowTexts()[0]).toContain('Earlier');
    await sortBy(user, 'expenses.columns.status');
    expect(rowTexts()[0]).toContain('Earlier');
  });

  it('sorts by submitter name, not by the id behind it', async () => {
    const user = userEvent.setup();
    setTrpc([
      expense({
        id: 'a',
        merchant: 'Zed',
        report: {
          ...expense().report,
          submitter: { id: 'u-9', firstName: 'Zoe', lastName: 'Adams', email: 'z@e.inc' },
        },
      }),
      expense({
        id: 'b',
        merchant: 'Abe',
        report: {
          ...expense().report,
          submitter: { id: 'u-1', firstName: 'Abe', lastName: 'Yates', email: 'a@e.inc' },
        },
      }),
    ]);
    show();
    await sortBy(user, 'expenses.approvals.submitter');
    expect(rowTexts()[0]).toContain('Abe');
  });
});

// ── Chasing receipts ──────────────────────────────────────────────────────────

describe('requesting receipts', () => {
  it('counts only the chaseable rows in the action’s label', async () => {
    /**
     * A selection of rows that all have receipts offers nothing, and the label is the
     * only warning before the click.
     */
    const user = userEvent.setup();
    setTrpc([expense(), expense({ id: 'exp-2', receiptCount: 3 })]);
    show();
    await selectRow(user, 0);
    await selectRow(user, 1);
    await user.click(screen.getByRole('button', { name: /table\.misc\.selected/ }));
    expect(await screen.findByText('expenses.allExpenses.requestReceipts:1')).toBeInTheDocument();
  });

  it('chases only the expenses that are actually missing one', async () => {
    const onCall: OnCall = vi.fn();
    const user = userEvent.setup();
    setTrpc([expense(), expense({ id: 'exp-2', receiptCount: 3 })], {
      mutations: { 'expenseApprovals.chaseReceipts': { onCall } },
    });
    show();
    await selectRow(user, 0);
    await selectRow(user, 1);
    await requestReceipts(user);
    expect(onCall).toHaveBeenCalledWith({ expenseIds: ['exp-1'] });
  });

  it('says there was nothing to chase instead of sending an empty request', async () => {
    const onCall: OnCall = vi.fn();
    const user = userEvent.setup();
    setTrpc([expense({ receiptCount: 3 })], {
      mutations: { 'expenseApprovals.chaseReceipts': { onCall } },
    });
    show();
    await selectRow(user, 0);
    await requestReceipts(user);
    expect(onCall).not.toHaveBeenCalled();
    expect(await screen.findByText('expenses.allExpenses.chaseNone')).toBeInTheDocument();
  });

  it('reports how many people were nudged, and about how much', async () => {
    // "Sent" alone does not tell AP whether the nudge covered what they selected.
    const user = userEvent.setup();
    setTrpc([expense()], {
      mutations: {
        'expenseApprovals.chaseReceipts': {
          outcome: 'success',
          data: { reports: 2, expenses: 5, skipped: 0 },
        },
      },
    });
    show();
    await selectRow(user, 0);
    await requestReceipts(user);
    expect(await screen.findByText('expenses.allExpenses.chaseSent:5,2')).toBeInTheDocument();
  });

  it('says nothing was sent when the server chased nobody', async () => {
    const user = userEvent.setup();
    setTrpc([expense()], {
      mutations: {
        'expenseApprovals.chaseReceipts': {
          outcome: 'success',
          data: { reports: 0, expenses: 0, skipped: 1 },
        },
      },
    });
    show();
    await selectRow(user, 0);
    await requestReceipts(user);
    expect(await screen.findByText('expenses.allExpenses.chaseNone')).toBeInTheDocument();
  });

  it('drops the selection once the nudge is away', async () => {
    // Leaving it ticked invites sending the same nudge twice.
    const user = userEvent.setup();
    setTrpc([expense()], {
      mutations: {
        'expenseApprovals.chaseReceipts': {
          outcome: 'success',
          data: { reports: 1, expenses: 1, skipped: 0 },
        },
      },
    });
    show();
    await selectRow(user, 0);
    await requestReceipts(user);
    expect(screen.queryByRole('button', { name: /table\.misc\.selected/ })).not.toBeInTheDocument();
  });

  it('reports a refused chase rather than looking like it worked', async () => {
    const user = userEvent.setup();
    setTrpc([expense()], {
      mutations: {
        'expenseApprovals.chaseReceipts': {
          outcome: 'error',
          error: { message: 'You cannot chase this report' },
        },
      },
    });
    show();
    await selectRow(user, 0);
    await requestReceipts(user);
    expect(await screen.findByText('You cannot chase this report')).toBeInTheDocument();
  });

  it('offers no bulk action until something is selected', () => {
    setTrpc();
    show();
    expect(screen.queryByRole('button', { name: /table\.misc\.selected/ })).not.toBeInTheDocument();
  });
});

// ── The pill operators the column menu does not reach ─────────────────────────

describe('narrowing by exclusion', () => {
  /**
   * The column menu offers `contains`; the pill bar offers the other three. All four are
   * hand-written here, and an operator that silently matches everything is worse than one
   * that matches nothing — the reader believes they have narrowed the list and reads the
   * wrong rows as the answer.
   */
  const addPill = async (
    user: ReturnType<typeof userEvent.setup>,
    field: string,
    op: string,
    value: string,
  ) => {
    await user.click(screen.getByRole('button', { name: /(?:Add filter|filters\.addFilter)/ }));
    await user.selectOptions(await screen.findByLabelText(/(?:^Field$|filters\.field)/), field);
    await user.selectOptions(screen.getByLabelText(/(?:^Operator$|filters\.operator)/), op);
    await user.type(screen.getByLabelText(/(?:^Value$|filters\.value$)/), value);
    await user.click(screen.getByRole('button', { name: /(?:^Add$|filters\.add$)/ }));
  };

  const twoMerchants = () => [expense(), expense({ id: 'exp-2', merchant: 'Air Canada' })];

  it('excludes on a substring', async () => {
    const user = userEvent.setup();
    setTrpc(twoMerchants());
    show();
    await addPill(user, 'merchant', 'doesNotContain', 'canoe');
    expect(rowTexts()).toHaveLength(1);
    expect(screen.getByText('Air Canada')).toBeInTheDocument();
  });

  it('matches a whole merchant name, case-insensitively', async () => {
    const user = userEvent.setup();
    setTrpc(twoMerchants());
    show();
    await addPill(user, 'merchant', 'equals', 'canoe');
    expect(rowTexts()).toHaveLength(1);
    expect(screen.getByText('Canoe')).toBeInTheDocument();
  });

  it('excludes a whole merchant name', async () => {
    const user = userEvent.setup();
    setTrpc(twoMerchants());
    show();
    await addPill(user, 'merchant', 'doesNotEqual', 'canoe');
    expect(rowTexts()).toHaveLength(1);
    expect(screen.getByText('Air Canada')).toBeInTheDocument();
  });

  it('excludes one submitter without excluding the report they filed', async () => {
    /** "Everybody but Dana" is how a reviewer takes their own claims out of the queue. */
    const user = userEvent.setup();
    setTrpc([
      expense(),
      expense({
        id: 'exp-2',
        report: {
          id: 'rep-2',
          number: 'EXP-1043',
          status: 'SUBMITTED',
          submitter: { id: 'u-2', firstName: 'Bo', lastName: 'Chen', email: 'bo@e.inc' },
        },
      }),
    ]);
    show();
    await addPill(user, 'submitter', 'doesNotContain', 'dana');
    expect(rowTexts()).toHaveLength(1);
    expect(screen.getByText('Bo Chen')).toBeInTheDocument();
  });
});

// ── One field, several values ─────────────────────────────────────────────────

describe('narrowing to several values on one field', () => {
  /**
   * The bar has always DRAWN this. `FilterPillBar` groups same-field, same-operator clauses
   * into one block and renders a literal "or" between the value chips — so "Status is
   * Submitted or Approved" is a sentence the reader can see on screen. The matcher under it
   * narrowed SUCCESSIVELY, though: the second chip intersected with the first, no row can be
   * two statuses at once, and the list went blank. A bar that says "or" and means "and" is
   * worse than one that offers neither.
   *
   * The rule these pin down is the one `clausesToServerFilters` already encodes: within a
   * field, `equals` clauses OR; across fields, clauses AND. Negatives keep ANDing — "not
   * Canoe or not Air Canada" is every row, which is not what anybody typed.
   *
   * Clauses arrive here as a PINNED VIEW rather than as the opening default, even now that
   * the default carries status clauses of its own: a pinned view REPLACES the default, so
   * each of these drives exactly the clauses it names and nothing else. This is the matcher
   * under test, not the default over it.
   */

  const withPinnedFilters = (items: unknown[], filters: unknown[]) =>
    setTrpc(items, {
      queries: {
        'savedViews.list': {
          data: [{ id: 'uv-or', name: 'pinned', pinned: true, state: { filters } }],
        },
      },
    });

  it('shows the submitted, approved and returned charges, not none of them', async () => {
    withPinnedFilters(fourStatuses(), [
      { id: 'f1', field: 'status', op: 'equals', value: 'SUBMITTED' },
      { id: 'f2', field: 'status', op: 'equals', value: 'APPROVED' },
      { id: 'f3', field: 'status', op: 'equals', value: 'RETURNED' },
    ]);
    show();
    await waitFor(() => expect(rowTexts()).toHaveLength(3));
    expect(screen.getByText('Canoe')).toBeInTheDocument();
    expect(screen.getByText('Air Canada')).toBeInTheDocument();
    expect(screen.getByText('Via Rail')).toBeInTheDocument();
    // The one status nobody asked for is the one that is gone.
    expect(screen.queryByText('Petro-Canada')).not.toBeInTheDocument();
  });

  it('unions on any field, not only on status', async () => {
    // `merchant`, `category`, `report` and `submitter` have been filterable all along, and
    // each one emptied the list the moment a second value went on its pill.
    withPinnedFilters(fourStatuses(), [
      { id: 'f1', field: 'merchant', op: 'equals', value: 'Canoe' },
      { id: 'f2', field: 'merchant', op: 'equals', value: 'Via Rail' },
    ]);
    show();
    // Asserted through the ROWS, not `getByText`: the merchant pills on the bar carry these
    // same two names as value chips.
    await waitFor(() => expect(rowTexts()).toHaveLength(2));
    expect(rowTexts().join('|')).toContain('Canoe');
    expect(rowTexts().join('|')).toContain('Via Rail');
  });

  it('still intersects across two different fields', async () => {
    // The other half of the rule. Widening within a field must not widen between them.
    withPinnedFilters(fourStatuses(), [
      { id: 'f1', field: 'status', op: 'equals', value: 'SUBMITTED' },
      { id: 'f2', field: 'status', op: 'equals', value: 'APPROVED' },
      { id: 'f3', field: 'merchant', op: 'contains', value: 'Air' },
    ]);
    show();
    await waitFor(() => expect(rowTexts()).toHaveLength(1));
    expect(screen.getByText('Air Canada')).toBeInTheDocument();
  });

  it('keeps two exclusions on one field meaning neither, not either', async () => {
    /**
     * The trap in grouping by field: OR the negatives too and "not Canoe or not Air Canada"
     * matches every row, so the reader's exclusion silently stops excluding.
     */
    withPinnedFilters(fourStatuses(), [
      { id: 'f1', field: 'merchant', op: 'doesNotEqual', value: 'Canoe' },
      { id: 'f2', field: 'merchant', op: 'doesNotEqual', value: 'Air Canada' },
    ]);
    show();
    await waitFor(() => expect(rowTexts()).toHaveLength(2));
    expect(screen.getByText('Via Rail')).toBeInTheDocument();
    expect(screen.getByText('Petro-Canada')).toBeInTheDocument();
  });

  it('narrows on the status the reader picks off the bar', async () => {
    /**
     * Status is a pill-bar field now, and it compares against the ENUM the server sends
     * rather than the badge's translated label — a filter that matched "Approved" would stop
     * matching the moment the reader switched to fr-CA.
     */
    const user = userEvent.setup();
    // Cleared bar: the opening default already carries APPROVED, and adding a fourth
    // `equals` clause to that pill would UNION with it rather than narrow to it. What is
    // under test here is that the enum select is wired end to end and compares against the
    // enum — the default's own behaviour is covered in "narrowing the list".
    setTrpcUnfiltered(fourStatuses());
    show();
    await waitFor(() => expect(rowTexts()).toHaveLength(4));
    await user.click(screen.getByRole('button', { name: /(?:Add filter|filters\.addFilter)/ }));
    await user.selectOptions(await screen.findByLabelText(/(?:^Field$|filters\.field)/), 'status');
    await user.selectOptions(screen.getByLabelText(/(?:^Value$|filters\.value$)/), 'APPROVED');
    await user.click(screen.getByRole('button', { name: /(?:^Add$|filters\.add$)/ }));
    expect(rowTexts()).toHaveLength(1);
    expect(screen.getByText('Air Canada')).toBeInTheDocument();
  });

  it('does not offer Draft, which could only ever return nothing', async () => {
    /**
     * The server never returns a draft report's expenses, so a Draft option is a control
     * whose only possible answer is an empty list with nothing on screen explaining why.
     */
    const user = userEvent.setup();
    setTrpc(fourStatuses());
    show();
    await user.click(screen.getByRole('button', { name: /(?:Add filter|filters\.addFilter)/ }));
    await user.selectOptions(await screen.findByLabelText(/(?:^Field$|filters\.field)/), 'status');
    const values = screen.getByLabelText(/(?:^Value$|filters\.value$)/) as HTMLSelectElement;
    const options = [...values.options].map((o) => o.value).filter(Boolean);
    expect(options).toEqual(['SUBMITTED', 'APPROVED', 'REJECTED', 'RETURNED', 'REIMBURSED']);
    // …and each one is named from the catalog the badge and the CSV already use.
    expect(within(values).getByText('expenses.status.approved')).toBeInTheDocument();
  });
});

// ── Export ────────────────────────────────────────────────────────────────────

describe('taking the list to a spreadsheet', () => {
  /**
   * This is the artefact AP actually chases receipts from — a list they work through
   * over a week, away from the app. So the file has to say what the screen says: the
   * report number that identifies the claim, the person to ask, and above all the
   * WORD for a missing receipt rather than a zero, which sorts and filters like any
   * other count.
   */
  const exportCsv = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(screen.getByRole('button', { name: 'table.export.trigger' }));
    await user.click(await screen.findByText('CSV'));
    return h.downloads.at(-1)?.csv ?? '';
  };

  it('names a missing receipt rather than exporting a zero', async () => {
    /** A `0` in a receipt-count column sorts and filters like any other number, and the
     *  one row that needs chasing stops standing out. */
    const user = userEvent.setup();
    setTrpc();
    show();
    const csv = await exportCsv(user);
    expect(csv).toContain('expenses.allExpenses.missing');
  });

  it('exports the count when the expense has receipts', async () => {
    const user = userEvent.setup();
    setTrpc([expense({ receiptCount: 3 })]);
    show();
    const csv = await exportCsv(user);
    expect(csv).toContain('3');
    expect(csv).not.toContain('expenses.allExpenses.missing');
  });

  it('carries the report number, the submitter and the category', async () => {
    const user = userEvent.setup();
    setTrpc();
    show();
    const csv = await exportCsv(user);
    expect(csv).toContain('EXP-1042');
    expect(csv).toContain('Dana Patel');
    expect(csv).toContain('Meals');
  });

  it('spells the status out rather than exporting the enum', async () => {
    const user = userEvent.setup();
    setTrpc();
    show();
    expect(await exportCsv(user)).toContain('expenses.status.submitted');
  });

  it('writes the amount with its currency, not as bare minor units', async () => {
    /** `12500` in a column headed "Amount" reads as twelve thousand five hundred
     *  dollars to anybody who did not write the schema. */
    const user = userEvent.setup();
    setTrpc();
    show();
    const csv = await exportCsv(user);
    expect(csv).toContain('125.00');
    expect(csv).not.toMatch(/(^|,)12500(,|$)/m);
  });

  it('leaves a merchantless, uncategorised charge empty rather than exporting the dash', async () => {
    /**
     * The table draws an em-dash so the row does not look broken. Exported, that dash is
     * a value: a merchant named "—" and a category named "—", both of which sort among
     * the real ones and defeat a filter for "uncategorised".
     */
    const user = userEvent.setup();
    setTrpc([expense({ merchant: null, categoryLabel: null })]);
    show();
    expect(await exportCsv(user)).not.toContain('—');
  });

  it('exports what the filter left, not the whole list', async () => {
    const user = userEvent.setup();
    setTrpc([expense(), expense({ id: 'exp-2', merchant: 'Air Canada' })]);
    show();
    const header = screen.getByText('expenses.columns.merchant').closest('th') as HTMLElement;
    const buttons = within(header).getAllByRole('button', { name: 'table.colMenu.menu' });
    await user.click(buttons[buttons.length - 1]);
    await user.click(await screen.findByText('table.colMenu.filter'));
    await user.type(await screen.findByPlaceholderText('table.colMenu.value'), 'canoe');
    await user.click(screen.getByText('table.colMenu.apply'));
    const csv = await exportCsv(user);
    expect(csv).toContain('Canoe');
    expect(csv).not.toContain('Air Canada');
  });
});

/*
 * VeloExpense: what a VeloExpense row can hold that an ExpenseOS one cannot — an expense with
 * no date yet, and a report from before numbering.
 */
describe('VeloExpense', () => {
  it('dashes an expense with no date, and exports it empty', async () => {
    // A VeloExpense expense may not have a date yet. `new Date(null)` would print 1970.
    setTrpc([expense({ date: null })]);
    show();
    expect(rowTexts()[0]).toContain('—');
    expect(rowTexts()[0]).not.toContain('1970');
  });

  it('dashes a report from before numbering, and still filters by report', async () => {
    // `report.number` is null on a report made before numbering; the link must not be empty
    // and a report filter must not throw on it.
    const user = userEvent.setup();
    setTrpc([
      expense({ report: report({ number: null }) }),
      expense({
        id: 'exp-2',
        merchant: 'Air Canada',
        report: report({ id: 'rep-2', number: 'EXP-1043' }),
      }),
    ]);
    show();
    expect(screen.getByRole('link', { name: '—' })).toHaveAttribute(
      'href',
      '/expenses/rep-1?expense=exp-1',
    );
    // Only this clause on the bar: clear the opening default, then add it.
    await user.click(screen.getByText('table.misc.clearFilters'));
    await user.click(screen.getByRole('button', { name: /(?:Add filter|filters\.addFilter)/ }));
    await user.selectOptions(await screen.findByLabelText(/(?:^Field$|filters\.field)/), 'report');
    await user.selectOptions(screen.getByLabelText(/(?:^Operator$|filters\.operator)/), 'contains');
    await user.type(screen.getByLabelText(/(?:^Value$|filters\.value$)/), '1043');
    await user.click(screen.getByRole('button', { name: /(?:^Add$|filters\.add$)/ }));
    expect(rowTexts()).toHaveLength(1);
    expect(rowTexts()[0]).toContain('Air Canada');
  });
});
