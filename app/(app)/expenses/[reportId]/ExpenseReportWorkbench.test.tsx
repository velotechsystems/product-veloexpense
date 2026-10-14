import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type * as React from 'react';
import { type ReactNode, useSyncExternalStore } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resizeDeviceTo, restorePointer, stubDevice, stubPointer } from '@/test-utils/pointer';
// VeloExpense: ExpenseOS's catalogue locale — what next-intl reports on every ported screen
// (i18n/request.ts) — named rather than spelled, for check-i18n's IL-1 scan.
import { DEFAULT_LOCALE as CATALOG_LOCALE } from '@expenseos/i18n';

/**
 * The three-pane expense-report workbench — the screen a claim is filed and decided on.
 *
 * All of the report-level chrome (title, total, status, submit / recall / delete, and the
 * approver's decide flow) is projected into the app-shell top bar, so the tests render
 * that slot alongside the page. What they protect:
 *
 *   · **The submit gate.** Four independent reasons to block, and each one has to be
 *     enforced here as well as server-side, because the button is the only place the
 *     person finds out. The subtlest is an unanswered grouping suggestion: the same
 *     charge on two expenses, each carrying the full total — an over-claim the approver
 *     cannot spot, because both entries look perfectly well-formed.
 *   · **A rejection needs a note.** Approving does not; rejecting somebody's expenses
 *     without saying why is the one decision that generates a second conversation.
 *   · **The selection survives a poll.** The report refetches every four seconds while
 *     extraction is pending, and the effect that picks the open expense re-runs each
 *     time — so it has to prefer what the person chose over the deep link that opened
 *     the page.
 */

const h = vi.hoisted(() => ({
  report: undefined as unknown,
  loading: false,
  grouping: [] as unknown[],
  /** The options each query hook was last called with, by procedure name — how a test
   *  sees whether a query would fire at all (`enabled`). */
  queryOpts: {} as Record<string, { enabled?: boolean } | undefined>,
  /** Mutation arguments, keyed by procedure name. */
  calls: {} as Record<string, unknown[]>,
  /** Procedures whose mutate/mutateAsync should fail — with a message, or with a whole
   *  tRPC-shaped error (`{ message, data }`) when the test is about what `data` carries. */
  errors: {} as Record<string, string | { message: string; data?: unknown }>,
  /** Procedures reporting `isPending`. */
  pending: {} as Record<string, boolean>,
  params: new URLSearchParams(),
  pushed: [] as string[],
  /** `router.replace` targets — how an approver leaves a decided report for the queue. */
  replaced: [] as string[],
  /** Every `utils.…` call the page made, as a dotted path (`expenseApprovals.myTasks.invalidate`). */
  utilsCalls: [] as string[],
  /** What a procedure's mutation resolves with, when the test cares (default `{ id: 'exp-new' }`). */
  results: {} as Record<string, unknown>,
  topBar: {} as { left?: ReactNode; center?: ReactNode; right?: ReactNode },
  /** The reader's locale, as next-intl would report it. Mutable so one test can
   *  render the same report to an `en` reader and a `fr-CA` one. */
  // VeloExpense: set to ExpenseOS's catalogue locale (CATALOG_LOCALE) in `beforeEach` — an
  // import cannot be read inside `vi.hoisted`, which runs before it.
  locale: '' as string,
  /** A REAL translator for the category-banner keys only, set by the one test that
   *  proves the banner reads the catalog (FR-CA) and not the English message function. */
  realT: undefined as undefined | ((key: string, values?: Record<string, unknown>) => string),
}));

/**
 * One stable `t` for the whole file, not a fresh closure per call.
 *
 * `useTopBarSlots` keys its effect on the caller's deps, and `t` is one of them. A new
 * function identity on every render re-runs the effect, which sets the harness's state,
 * which re-renders — an infinite loop that the real (memoised) next-intl hook does not
 * produce.
 */
const t = (key: string, values?: Record<string, unknown>) =>
  h.realT && key.startsWith('workbench.categoryProblem')
    ? h.realT(key, values)
    : values
      ? `${key}:${Object.values(values).join(',')}`
      : key;
// Policy labels are "not in the catalog" here on purpose (see `ViolationLine`); a server
// refusal's key IS, so `useRefusalText` renders it rather than the English message.
t.has = (key: string) => key.startsWith('refusals.');

// The i18n `Link` pulls next-intl's client navigation, which resolves `next/navigation`
// at module load and cannot be collected under vitest. Same stub the Sidebar tests use.
vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
  usePathname: () => '/en/expenses',
  // `useRouter` IS MOCKED HERE AND NOT UNDER `next/navigation`, and the placement is the
  // assertion. The component takes its router from this module so that next-intl re-applies
  // the locale; if someone moves that import back to `next/navigation`, the component gets
  // the mock below instead, `h.pushed` still fills, and every case here still passes while
  // the locale bug is back. Mocking it in the module the component must import from is what
  // makes that regression visible — `ExpenseReportsList.test.tsx` carries the same note.
  useRouter: () => ({
    push: (path: string) => h.pushed.push(path),
    replace: (path: string) => h.replaced.push(path),
  }),
}));
vi.mock('next-intl', () => ({
  useLocale: () => h.locale,
  useTranslations: () => t,
}));
vi.mock('next/navigation', () => ({
  // No `useRouter` here on purpose — see the note on the i18n mock above. `useSearchParams`
  // is correctly taken from `next/navigation`: it reads the query string, which carries no
  // locale segment.
  useSearchParams: () => h.params,
}));
/**
 * The top bar is a live slot, not a snapshot.
 *
 * The page projects its whole chrome — title, total, submit, the approver's decide
 * popovers — into the app shell, and those controls change the page's OWN state. A
 * one-time capture would render the bar as it looked before the first click and every
 * interaction after that would be against a stale tree. So the mock mirrors the real
 * hook (an effect keyed on the caller's deps) and pushes into React state that the
 * harness below renders.
 */
const slotStore = {
  slots: {} as Record<string, ReactNode>,
  listeners: new Set<() => void>(),
  set(next: Record<string, ReactNode>) {
    slotStore.slots = next;
    h.topBar = next;
    for (const l of slotStore.listeners) l();
  },
  subscribe(l: () => void) {
    slotStore.listeners.add(l);
    return () => {
      slotStore.listeners.delete(l);
    };
  },
  get() {
    return slotStore.slots;
  },
};

// VeloExpense: the shell's TopBar is `app/(app)/TopBar` (no locale segment).
vi.mock('../../TopBar', async () => {
  const { useEffect } = await import('react');
  return {
    useTopBarSlots: (builder: () => Record<string, ReactNode>, deps: unknown[]) => {
      // `deps` is forwarded verbatim, exactly as the real hook does.
      useEffect(() => {
        const next = builder();
        h.topBar = next;
        slotStore.set(next);
        // VeloExpense: ExpenseOS's mock forwards the caller's deps on purpose (see above).
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, deps);
    },
  };
});
vi.mock('@/components/comments/CommentThread', () => ({ CommentThread: () => null }));
vi.mock('@/components/attachments/AttachmentViewer', () => ({
  AttachmentDocument: () => null,
  useViewerZoom: () => [1, vi.fn()],
  ZoomControls: () => null,
}));
vi.mock('@/components/pickers/EntityPickers', () => ({
  UserCombobox: ({
    onValueChange,
    placeholder,
  }: {
    onValueChange: (v: string | null, item: unknown) => void;
    placeholder?: string;
  }) => (
    <button
      type="button"
      onClick={() => onValueChange('u-other', { value: 'u-other', label: 'Bob' })}
    >
      {placeholder}
    </button>
  ),
}));
// VeloExpense (d38): `LedgerPost`, ported from `NetSuitePush`.
vi.mock('./LedgerPost', () => ({ LedgerPost: () => null }));

vi.mock('@/lib/trpc/client', () => {
  /** The error a failing procedure produces, from whichever shape the test gave. */
  const failure = (name: string): Error | null => {
    const spec = h.errors[name];
    if (!spec) return null;
    if (typeof spec === 'string') return new Error(spec);
    return Object.assign(new Error(spec.message), { data: spec.data });
  };
  const procedure = (name: string) => ({
    useQuery: (_input?: unknown, opts?: { enabled?: boolean }) => {
      h.queryOpts[name] = opts;
      if (name === 'report') return { data: h.report, isLoading: h.loading };
      if (name === 'receiptGroupingSuggestions')
        return { data: { items: h.grouping }, isLoading: false, refetch: vi.fn() };
      if (name === 'categories') return { data: CATEGORIES, isLoading: false };
      return {
        data: undefined,
        isLoading: false,
        isFetching: false,
        error: null,
        refetch: vi.fn(),
      };
    },
    useMutation: (opts?: { onSuccess?: (d?: unknown) => void; onError?: (e: Error) => void }) => ({
      isPending: h.pending[name] ?? false,
      mutate: (
        vars: unknown,
        perCall?: { onSuccess?: (d?: unknown) => void; onError?: (e: Error) => void },
      ) => {
        h.calls[name] ??= [];
        h.calls[name].push(vars);
        const err = failure(name);
        if (err) {
          opts?.onError?.(err);
          perCall?.onError?.(err);
        } else {
          const result = h.results[name] ?? { id: 'exp-new' };
          opts?.onSuccess?.(result);
          perCall?.onSuccess?.(result);
        }
      },
      mutateAsync: async (vars: unknown) => {
        h.calls[name] ??= [];
        h.calls[name].push(vars);
        const err = failure(name);
        if (err) throw err;
        return { id: 'exp-new' };
      },
    }),
  });
  const router = new Proxy({} as Record<string, unknown>, {
    get: (_t, key: string) => {
      if (key === 'useUtils') {
        const utils = () => {
          const deep = (): unknown =>
            new Proxy(() => Promise.resolve(), {
              get: () => deep(),
              apply: () => Promise.resolve(),
            });
          return deep();
        };
        return utils;
      }
      return procedure(key);
    },
  });
  return {
    trpc: {
      // Records the path of every call (`expenses.list.invalidate`), so a test can tell
      // which caches an action marked stale.
      useUtils: () => {
        const deep = (path: string[]): unknown =>
          new Proxy(() => Promise.resolve(), {
            get: (_t, key) => deep([...path, String(key)]),
            apply: () => {
              h.utilsCalls.push(path.join('.'));
              return Promise.resolve();
            },
          });
        return deep([]);
      },
      expenses: router,
      expenseApprovals: router,
      mileageRoute: {
        status: { useQuery: () => ({ data: { available: false }, isLoading: false }) },
        searchPlaces: {
          useQuery: () => ({ data: { items: [], error: null }, isFetching: false, error: null }),
        },
        computeRoute: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
      },
    },
  };
});

import { ExpenseReportWorkbench } from './ExpenseReportWorkbench';

const CATEGORIES = [
  { id: 'cat-meals', label: { en: 'Meals' }, icon: null, isMileage: false, acceptsTip: true },
];

const CAD = { id: 'cur-cad', code: 'CAD', symbol: '$', exponent: 2 };

const expense = (over: Record<string, unknown> = {}) => ({
  id: 'exp-1',
  merchant: 'Corner Bistro',
  date: new Date('2026-08-01T00:00:00Z').toISOString(),
  amountMinor: '11500',
  currencyId: 'cur-cad',
  currency: CAD,
  placeText: null,
  purpose: null,
  explanation: null,
  paymentMethod: 'OUT_OF_POCKET',
  lineItems: [],
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
});

const report = (over: Record<string, unknown> = {}) => ({
  id: 'rep-1',
  title: 'August travel',
  status: 'DRAFT',
  currency: CAD,
  expenses: [expense()],
  violations: [],
  externalIds: [],
  entity: { itcRecoverable: true },
  extractionReviewThreshold: 0.8,
  // VeloExpense: `posting` (integration_post) where ExpenseOS has `netsuite`.
  posting: null,
  fxOverride: null,
  rollup: {
    homeTotalMinor: '11500',
    homeCurrency: 'CAD',
    recoverableTotalMinor: '0',
    multiCurrency: false,
    byCurrency: [],
    missingRates: [],
  },
  extraction: { inFlight: 0, stale: 0 },
  ...over,
});

/** One pair the automatic pass could not settle: same total, no transaction id. */
const SUGGESTION = {
  reason: 'sameTotal',
  confident: false,
  suggestedExpenseId: 'exp-1',
  documents: [
    {
      receiptId: 'r1',
      expenseId: 'exp-1',
      filename: 'bill.pdf',
      kind: 'ITEMIZED_BILL',
      total: 115,
      currencyCode: 'CAD',
      date: '2026-08-01',
      time: null,
      transactionId: null,
    },
    {
      receiptId: 'r2',
      expenseId: 'exp-2',
      filename: 'card.jpg',
      kind: 'CARD_COPY',
      total: 115,
      currencyCode: 'CAD',
      date: '2026-08-01',
      time: null,
      transactionId: null,
    },
  ],
};

const PROPS = {
  reportId: 'rep-1',
  isSubmitter: true,
  canEdit: true,
  canDelete: true,
  canSubmit: true,
  canApprove: false,
  isAcknowledge: false,
  canReimburse: false,
  canChase: false,
  canFxOverride: false,
  // VeloExpense (d38): ExpenseOS's `canPushNetsuite`.
  canOpenLedgerQueue: false,
};

/**
 * The slots, subscribed rather than lifted into a parent.
 *
 * A store with its own subscriber is what the real top bar is, and it matters here for
 * a mechanical reason: the page's effect re-runs on most renders (its deps include
 * objects react-query rebuilds each time), so pushing the slots into a PARENT's state
 * would re-render the page, re-run the effect, and loop. Notifying only this component
 * keeps the bar live without touching the page.
 */
function TopBarSlots() {
  const slots = useSyncExternalStore(slotStore.subscribe, slotStore.get, slotStore.get);
  return (
    <div data-testid="topbar">
      {slots.left}
      {slots.center}
      {slots.right}
    </div>
  );
}

/** The page plus its top-bar slots, wired the way the app shell wires them. */
type WorkbenchProps = React.ComponentProps<typeof ExpenseReportWorkbench>;

function Harness(props: Partial<WorkbenchProps>) {
  return (
    <>
      <ExpenseReportWorkbench {...PROPS} {...props} />
      <TopBarSlots />
    </>
  );
}

function show(over: Record<string, unknown> = {}, props: Partial<WorkbenchProps> = {}) {
  h.report = report(over);
  return render(<Harness {...props} />);
}

const sent = (name: string) => (h.calls[name] ?? []) as Record<string, unknown>[];
const topbar = () => screen.getByTestId('topbar');
/** The body-level row that holds Request receipts and Mark reimbursed at `lg` and up. */
const strip = () => screen.getByTestId('desktop-action-strip');

/** Intl groups fr-CA with a NO-BREAK space. Escaped rather than literal: a
 *  literal one is indistinguishable from an ASCII space in a diff. */
const NBSP = '\u00A0';

/**
 * Testing Library's DEFAULT normalizer collapses every run of whitespace to a
 * single ASCII space — and `\s` matches U+00A0, so `10 799,00 $` and
 * `10\u00A0799,00\u00A0$` compare equal under it. That is precisely the
 * distinction the money assertions exist to make, so they trim only.
 */
const EXACT = { normalizer: (str: string) => str.trim() };

beforeEach(() => {
  h.report = undefined;
  h.loading = false;
  h.grouping = [];
  h.queryOpts = {};
  h.calls = {};
  h.errors = {};
  h.pending = {};
  h.params = new URLSearchParams();
  h.pushed = [];
  h.replaced = [];
  h.utilsCalls = [];
  h.results = {};
  h.topBar = {};
  // Reset the implementation, not just the call history: `vi.clearAllMocks()`
  // leaves a locale set by a previous test in place, and every money assertion
  // in this file would then be measuring the wrong reader.
  h.locale = CATALOG_LOCALE;
  h.realT = undefined;
});

afterEach(() => vi.restoreAllMocks());
/**
 * Put `matchMedia` back, and forget the pointer the store resolved.
 *
 * Not optional and not covered by the line above it: `vi.restoreAllMocks()`
 * does NOT undo a `vi.stubGlobal`, so one coarse-pointer test here would
 * otherwise leave a phone-shaped `matchMedia` behind for every test that ran
 * after it in the same worker — a cross-file failure a path-filtered run cannot
 * reproduce. `restorePointer` also drops the parked `fetch` the busy tests
 * install, which is why it belongs in `afterEach` and nowhere else.
 */
afterEach(restorePointer);

// ── Loading and missing ───────────────────────────────────────────────────────

/**
 * Reading a report in the reader's own currency (GA readiness report F52).
 *
 * The audit looked for a display-currency toggle and found only the FX override, which
 * converts foreign LINES into the report's currency — the opposite direction. So a historical
 * USD report could not be read in CAD at all.
 *
 * Presentation only: the toggle never changes a stored figure, and the report stays filed and
 * posted in its own currency.
 */
describe('reading the total in another currency', () => {
  const WITH_ALT = {
    currency: { code: 'USD', symbol: '$' },
    viewInReaderCurrency: { currency: 'CAD', totalMinor: '138760', rate: '1.3876' },
  };

  it('offers the reader’s currency, and switches the total to it', async () => {
    const user = userEvent.setup();
    show(WITH_ALT);
    const toggle = await screen.findByRole('button', { name: 'CAD' });
    await user.click(toggle);
    // The converted figure, and the code beside it, both change.
    expect(await screen.findByRole('button', { name: 'USD' })).toBeInTheDocument();
  });

  it('offers nothing when no rate connects the two currencies', () => {
    // Not offered rather than offered and wrong.
    show({ currency: { code: 'USD', symbol: '$' }, viewInReaderCurrency: null });
    expect(screen.queryByRole('button', { name: 'CAD' })).not.toBeInTheDocument();
  });

  it('offers nothing on a response from before the field existed', () => {
    // A cached page across a deploy arrives with the field `undefined`, which an `!== null`
    // check would let through and then crash on.
    show({ currency: { code: 'USD', symbol: '$' } });
    expect(screen.queryByRole('button', { name: 'CAD' })).not.toBeInTheDocument();
  });
});

describe('before the report is there', () => {
  it('says it is loading', () => {
    h.loading = true;
    h.report = undefined;
    render(<ExpenseReportWorkbench {...PROPS} />);
    expect(screen.getByText('list.loading')).toBeInTheDocument();
  });

  it('says the record is gone, and offers a way out', () => {
    /**
     * Deleted from another tab, or a stale link. The intent here was always right — "a
     * blank three-pane shell would look like a rendering failure" — but what it rendered
     * was `drawer.fallback`, which is the string "Expense report": a TITLE reused as an
     * empty state. Opening a well-formed but nonexistent id therefore produced the
     * breadcrumb "Expense report" above an otherwise empty pane, with no message and no
     * way forward, which is exactly the rendering failure it set out to avoid (GA
     * readiness report F46).
     */
    h.report = undefined;
    render(<ExpenseReportWorkbench {...PROPS} />);
    expect(screen.getByText('notFound.recordTitle')).toBeInTheDocument();
    expect(screen.getByText('notFound.recordBody')).toBeInTheDocument();
    expect(screen.getByText('notFound.backToExpenses')).toBeInTheDocument();
  });

  it('projects nothing into the top bar without a report', () => {
    h.report = undefined;
    render(<ExpenseReportWorkbench {...PROPS} />);
    expect(h.topBar).toEqual({});
  });
});

// ── The expense list ──────────────────────────────────────────────────────────

describe('the expense list', () => {
  it('lists the report’s expenses and opens the first one', () => {
    show();
    expect(screen.getAllByText('Corner Bistro').length).toBeGreaterThan(0);
    // The centre pane shows an editor rather than the "pick one" prompt.
    expect(screen.queryByText('workbench.selectPrompt')).not.toBeInTheDocument();
  });

  it('says so when the report has no expenses, and prompts for a selection', () => {
    show({ expenses: [] });
    expect(screen.getByText('drawer.noExpenses')).toBeInTheDocument();
    expect(screen.getAllByText('workbench.selectPrompt').length).toBeGreaterThan(0);
  });

  it('moves the selection with the arrow keys and with j/k', async () => {
    /**
     * The list is what somebody works down while entering a receipt batch, so it takes
     * the keyboard. `j`/`k` because the people who use this most are the ones who never
     * left the home row.
     */
    const user = userEvent.setup();
    show({
      expenses: [
        expense({ id: 'exp-1', merchant: 'First' }),
        expense({ id: 'exp-2', merchant: 'Second' }),
      ],
    });
    await user.keyboard('{ArrowDown}');
    expect(screen.getAllByText('Second').length).toBeGreaterThan(1); // list row + editor header
    await user.keyboard('k');
    expect(screen.getAllByText('First').length).toBeGreaterThan(1);
  });

  it('does not steal a keystroke aimed at a field', async () => {
    // Typing "j" in the vendor box must type a j, not jump the selection.
    const user = userEvent.setup();
    show({
      expenses: [
        expense({ id: 'exp-1', merchant: 'First' }),
        expense({ id: 'exp-2', merchant: 'Second' }),
      ],
    });
    const vendor = screen.getByPlaceholderText('addLine.merchantPlaceholder');
    await user.click(vendor);
    await user.keyboard('j');
    expect(vendor).toHaveValue('Firstj');
  });

  it('stops at either end of the list rather than wrapping', async () => {
    const user = userEvent.setup();
    show({
      expenses: [
        expense({ id: 'exp-1', merchant: 'First' }),
        expense({ id: 'exp-2', merchant: 'Second' }),
      ],
    });
    await user.keyboard('{ArrowUp}');
    expect(screen.getAllByText('First').length).toBeGreaterThan(1);
    await user.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}');
    expect(screen.getAllByText('Second').length).toBeGreaterThan(1);
  });

  it('opens the expense a deep link asked for', () => {
    h.params = new URLSearchParams('expense=exp-2');
    show({
      expenses: [
        expense({ id: 'exp-1', merchant: 'First' }),
        expense({ id: 'exp-2', merchant: 'Second' }),
      ],
    });
    expect(screen.getAllByText('Second').length).toBeGreaterThan(1);
  });

  it('adds an expense and selects it', async () => {
    const user = userEvent.setup();
    show();
    await user.click(screen.getByRole('button', { name: /drawer.addExpense/ }));
    expect(sent('createExpense')[0]).toEqual({ reportId: 'rep-1' });
  });

  it('hides the add and upload controls on a filed report', () => {
    /**
     * Cosmetic — the procedures re-check — but offering an action that will be refused
     * is worse than not offering it.
     */
    show({ status: 'SUBMITTED' });
    expect(screen.queryByRole('button', { name: /drawer.addExpense/ })).not.toBeInTheDocument();
    expect(screen.queryByText('inbox.uploadReceipt')).not.toBeInTheDocument();
  });

  it('keeps the list editable on a RETURNED report', () => {
    // Returned means "it is yours again", so the whole editor comes back.
    show({ status: 'RETURNED' });
    expect(screen.getByRole('button', { name: /drawer.addExpense/ })).toBeInTheDocument();
  });
});

// ── Multi-select and bulk delete ──────────────────────────────────────────────

describe('selecting several expenses', () => {
  const two = {
    expenses: [
      expense({ id: 'exp-1', merchant: 'First' }),
      expense({ id: 'exp-2', merchant: 'Second' }),
    ],
  };

  it('selects all, then clears', async () => {
    const user = userEvent.setup();
    show(two);
    const all = screen.getByLabelText('drawer.selectAll');
    await user.click(all);
    expect(screen.getByText('selected:2')).toBeInTheDocument();
    await user.click(all);
    expect(screen.queryByText(/selected/)).not.toBeInTheDocument();
  });

  it('asks before deleting, and says how many', async () => {
    /**
     * Deleting expenses off a report is not undoable from the UI, and the count is the
     * part somebody checks — a stray select-all is exactly how this goes wrong.
     */
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const user = userEvent.setup();
    show(two);
    await user.click(screen.getByLabelText('drawer.selectAll'));
    await user.click(screen.getByRole('button', { name: /selected:2/ }));
    await user.click(await screen.findByText('drawer.deleteSelected:2'));
    expect(confirm).toHaveBeenCalledWith('drawer.confirmDeleteExpenses:2');
    expect(sent('deleteExpenses')).toHaveLength(0);
  });

  it('deletes the selected ones once confirmed', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const user = userEvent.setup();
    show(two);
    await user.click(screen.getByLabelText('drawer.selectAll'));
    await user.click(screen.getByRole('button', { name: /selected:2/ }));
    await user.click(await screen.findByText('drawer.deleteSelected:2'));
    expect(sent('deleteExpenses')[0]).toEqual({ ids: ['exp-1', 'exp-2'] });
  });

  it('offers no group actions on a filed report', () => {
    // A selection means nothing once the report is out of the submitter's hands.
    show({ ...two, status: 'SUBMITTED' });
    expect(screen.queryByLabelText('drawer.selectAll')).not.toBeInTheDocument();
  });
});

// ── The title ─────────────────────────────────────────────────────────────────

describe('the report title', () => {
  it('renames on Enter', async () => {
    const user = userEvent.setup();
    show();
    await user.dblClick(within(topbar()).getByText('August travel'));
    const box = within(topbar()).getByRole('textbox');
    await user.clear(box);
    await user.type(box, 'September travel{Enter}');
    expect(sent('updateReport')[0]).toEqual({ reportId: 'rep-1', title: 'September travel' });
  });

  it('abandons the edit on Escape', async () => {
    const user = userEvent.setup();
    show();
    await user.dblClick(within(topbar()).getByText('August travel'));
    const box = within(topbar()).getByRole('textbox');
    await user.clear(box);
    await user.type(box, 'Nope{Escape}');
    expect(sent('updateReport')).toHaveLength(0);
  });

  it('writes nothing for a blank or unchanged title', async () => {
    /**
     * A report with no title is unfindable in the list, and re-saving the same string
     * would invalidate the query and refetch for nothing.
     */
    const user = userEvent.setup();
    show();
    await user.dblClick(within(topbar()).getByText('August travel'));
    const box = within(topbar()).getByRole('textbox');
    await user.clear(box);
    await user.type(box, '   ');
    await user.click(within(topbar()).getByRole('button', { name: 'workbench.saveTitle' }));
    expect(sent('updateReport')).toHaveLength(0);
  });

  it('cancels from the ✗ button', async () => {
    const user = userEvent.setup();
    show();
    await user.dblClick(within(topbar()).getByText('August travel'));
    await user.click(within(topbar()).getByRole('button', { name: 'addLine.cancel' }));
    expect(within(topbar()).queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('is plain text on a report the caller cannot edit', () => {
    show({ status: 'SUBMITTED' });
    expect(within(topbar()).getByText('August travel')).toBeInTheDocument();
    expect(within(topbar()).queryByRole('button', { name: /workbench.editTitle/ })).toBeNull();
  });

  it('goes back to the list from the breadcrumb', async () => {
    const user = userEvent.setup();
    show();
    await user.click(within(topbar()).getByText('workbench.reportsCrumb'));
    expect(h.pushed).toContain('/expenses');
  });
});

// ── The total ─────────────────────────────────────────────────────────────────

describe('the total', () => {
  it('shows the home-currency figure with its code', () => {
    show();
    expect(within(topbar()).getByText('CAD')).toBeInTheDocument();
    expect(within(topbar()).getByText('$115.00')).toBeInTheDocument();
  });

  /**
   * The reported bug, at the render site the report was filed against.
   *
   * The total used to be built by a second formatter that pasted the stored
   * symbol in front of `toLocaleString(undefined, …)` — the RUNTIME's locale,
   * which on the server is the container's ICU default and in the browser is
   * whatever the reader happens to have set. A French-Canadian reader with an
   * English browser saw `$115.00`; the two sides of a hydration could disagree;
   * and a trailing-symbol locale was unreachable by construction.
   */
  it('renders the total in the READER’s locale, not the runtime’s', () => {
    h.locale = 'fr-CA';
    show();
    // Symbol trailing and a comma decimal. Exact, because `toContain('115')`
    // would pass just as happily on English output.
    expect(within(topbar()).getByText(`115,00${NBSP}$`, EXACT)).toBeInTheDocument();
    expect(within(topbar()).queryByText('$115.00')).not.toBeInTheDocument();
    cleanup();

    h.locale = CATALOG_LOCALE;
    show();
    expect(within(topbar()).getByText('$115.00')).toBeInTheDocument();
    expect(within(topbar()).queryByText(`115,00${NBSP}$`, EXACT)).not.toBeInTheDocument();
  });

  it('groups a five-figure total with U+00A0 in fr-CA and a comma in en', () => {
    // The figure from the bug report: 10 799,00 $ vs $10,799.00. The grouping
    // CHARACTER is the third independent difference, after symbol side and
    // decimal mark, and the one an ASCII-space assertion silently misses —
    // which is what `EXACT` is here to prevent.
    // The figure the top bar prints comes from the roll-up, not from the raw
    // expense rows, so that is where the amount goes.
    const big = {
      expenses: [expense({ amountMinor: '1079900' })],
      rollup: {
        homeTotalMinor: '1079900',
        homeCurrency: 'CAD',
        recoverableTotalMinor: '0',
        multiCurrency: false,
        byCurrency: [],
        missingRates: [],
      },
    };

    h.locale = 'fr-CA';
    show(big);
    expect(within(topbar()).getByText(`10${NBSP}799,00${NBSP}$`, EXACT)).toBeInTheDocument();
    // The same string with ASCII spaces must NOT be found. If this ever starts
    // matching, the normalizer is collapsing the separator and the assertion
    // above has stopped proving anything.
    expect(within(topbar()).queryByText('10 799,00 $', EXACT)).not.toBeInTheDocument();
    cleanup();

    h.locale = CATALOG_LOCALE;
    show(big);
    expect(within(topbar()).getByText('$10,799.00')).toBeInTheDocument();
    expect(within(topbar()).queryByText(`10${NBSP}799,00${NBSP}$`, EXACT)).not.toBeInTheDocument();
  });

  it('explains itself only when there is something to explain', () => {
    /**
     * A breakdown on a single-currency report with no recoverable tax is a tooltip that
     * repeats the number above it.
     */
    show();
    expect(within(topbar()).queryByText('workbench.fxReportTotal')).not.toBeInTheDocument();

    cleanup();
    show({
      rollup: {
        homeTotalMinor: '20000',
        homeCurrency: 'CAD',
        recoverableTotalMinor: '650',
        multiCurrency: true,
        byCurrency: [
          { code: 'USD', grossMinor: '10000', rate: '1.37', convertedMinor: '13700' },
          { code: 'EUR', grossMinor: '5000', rate: null, convertedMinor: null },
        ],
        missingRates: ['EUR'],
      },
    });
    const bar = topbar();
    expect(within(bar).getByText('workbench.fxReportTotal')).toBeInTheDocument();
    expect(within(bar).getByText('workbench.fxRecoverable')).toBeInTheDocument();
    expect(within(bar).getByText('workbench.fxMissingRate:1')).toBeInTheDocument();
    // A currency with no rate reads as an em dash, not as zero — it is EXCLUDED from
    // the total, which is a different fact from contributing nothing.
    expect(within(bar).getByText('—')).toBeInTheDocument();
  });

  /**
   * "The currency was not consistent between the total to be repaid and the combination
   * of CAD and USD expenses" (UAT A7).
   *
   * The arithmetic was already correct and already rendered — inside the total's HOVER
   * tooltip. Hover is invisible on a touch device and easy to miss on a desktop, so a
   * reader looking at one total above a list of CAD and USD lines had nothing tying the
   * two together. Not a wrong number; an unexplained one.
   *
   * It was answered with a standalone "By currency" panel under the header. That panel is
   * gone: the composition now sits ON the total — `CAD $237.00 (CAD 100.00 + USD 100.00 @
   * 1.37)` — which is always visible, is where the number is read, and costs no second bar.
   * The tooltip keeps the full reconciliation (the converted column, recoverable tax) for
   * anyone who wants it.
   */
  describe('how a mixed-currency report adds up, without hovering', () => {
    const MIXED = {
      rollup: {
        homeTotalMinor: '23700',
        homeCurrency: 'CAD',
        recoverableTotalMinor: '0',
        multiCurrency: true,
        byCurrency: [
          { code: 'CAD', grossMinor: '10000', rate: null, convertedMinor: '10000' },
          { code: 'USD', grossMinor: '10000', rate: '1.37', convertedMinor: '13700' },
        ],
        missingRates: [],
      },
    };

    /** Everything outside the top bar — the report body a reader looks at. */
    const body = () => {
      const bar = topbar();
      return {
        queryByText: (m: string) =>
          screen.queryAllByText(m).filter((el) => !bar.contains(el))[0] ?? null,
      };
    };

    /**
     * The composition beside the total, as opposed to the same figures inside the hover
     * tooltip — which still renders them, in its own converted-column layout. The two are
     * told apart by the class the inline fragment paints its amounts with.
     */
    const inline = (m: RegExp) =>
      within(topbar())
        .getAllByText(m)
        .find((el) => /text-foreground\/80|text-warning/.test(el.className));

    it('states each currency beside the total, not in a bar of its own', () => {
      show(MIXED);
      expect(inline(/CAD 100\.00/)).toBeDefined();
      expect(inline(/USD 100\.00/)).toBeDefined();
      // The panel that used to carry this is gone from the body entirely.
      expect(body().queryByText('workbench.fxByCurrency')).toBeNull();
    });

    it('marks the rate as provenance, so the eye lands on the amounts', () => {
      /**
       * `@ 1.37` is how the conversion was done, not money in the report. It renders in the
       * muted colour; the two amounts that add up do not.
       */
      show(MIXED);
      const rates = within(topbar()).getAllByText('workbench.fxRate:1.37');
      expect(rates.length).toBeGreaterThan(0);
      expect(rates.some((el) => el.className.includes('text-muted-foreground'))).toBe(true);
    });

    it('says nothing at all on a single-currency report', () => {
      // A breakdown of one currency is the number above it, printed twice.
      show();
      expect(within(topbar()).queryByText(/\(/)).not.toBeInTheDocument();
    });

    it('flags a currency it could not convert instead of quietly dropping it', () => {
      show({
        rollup: {
          ...MIXED.rollup,
          byCurrency: [
            { code: 'CAD', grossMinor: '10000', rate: null, convertedMinor: '10000' },
            { code: 'EUR', grossMinor: '5000', rate: null, convertedMinor: null },
          ],
          missingRates: ['EUR'],
        },
      });
      expect(inline(/EUR 50\.00/)?.className).toContain('text-warning');
      // …and the warning panel above still makes the stronger claim, that the total
      // shown is not the whole total.
      expect(screen.getByText('workbench.fxExcludedTitle')).toBeInTheDocument();
    });

    it('drops the composition while the reader is in their own currency', async () => {
      /**
       * The `@ rate` figures convert to the REPORT's currency, so the parenthetical
       * reconciles to the report total and not to the one on screen. Showing it there
       * would be an equation that does not balance.
       */
      show({
        ...MIXED,
        viewInReaderCurrency: { currency: 'USD', totalMinor: '17300', rate: '0.73' },
      });
      // Not yet toggled: the composition is there and reconciles to the report total.
      expect(inline(/CAD 100\.00/)).toBeDefined();

      const user = userEvent.setup();
      await user.click(within(topbar()).getByRole('button', { name: 'USD' }));
      expect(inline(/CAD 100\.00/)).toBeUndefined();
      // The toggle stays available, so the reader can come back.
      expect(within(topbar()).getByRole('button', { name: 'CAD' })).toBeInTheDocument();
    });
  });
});

// ── Violations ────────────────────────────────────────────────────────────────

describe('policy violations', () => {
  const v = (over: Record<string, unknown> = {}) => ({
    id: 'v1',
    ruleCode: 'RECEIPT_REQUIRED',
    severity: 'WARNING',
    message: 'A receipt is required',
    data: null,
    lineItemId: null,
    expenseId: 'exp-1',
    resolvedAt: null,
    ...over,
  });

  describe('a warning about the whole report (VeloExpense, d39)', () => {
    /**
     * VeloExpense's engine raises findings with no expense (a budget overage), and the
     * submit gate waits for a reason on every warning — so the report needs somewhere to
     * give one that is not an expense's "Explain this charge".
     */
    const reportWide = v({ id: 'rw1', expenseId: null, message: 'Over budget' });

    it('asks for a reason, and sends it through justifyViolation', async () => {
      const user = userEvent.setup();
      show({ violations: [reportWide, v()] });
      const banner = screen.getByTestId('report-findings');
      // Only the report-wide one: an expense's warning is answered on the expense.
      expect(within(banner).getAllByRole('listitem')).toHaveLength(1);
      const ack = within(banner).getByRole('button', { name: 'approvals.acknowledge' });
      expect(ack).toBeDisabled();
      await user.type(within(banner).getByRole('textbox'), 'Agreed with the budget owner');
      await user.click(ack);
      expect(sent('justifyViolation')[0]).toEqual({
        violationId: 'rw1',
        note: 'Agreed with the budget owner',
      });
    });

    it('says nothing once it has a reason, or when there is none', () => {
      show({ violations: [{ ...reportWide, resolvedAt: new Date().toISOString() }, v()] });
      expect(screen.queryByTestId('report-findings')).toBeNull();
    });

    it('is not offered on a report that can no longer be edited', () => {
      show({ status: 'SUBMITTED', violations: [reportWide] });
      expect(screen.queryByTestId('report-findings')).toBeNull();
    });
  });

  it('counts the unresolved ones in the top bar', () => {
    show({ violations: [v(), v({ id: 'v2', message: 'Over the limit' })] });
    expect(within(topbar()).getByText('workbench.violationsDetected:2')).toBeInTheDocument();
  });

  it('ignores a justified warning', () => {
    // A warning with a resolve note is an accepted exception, not an outstanding one.
    show({ violations: [v({ resolvedAt: new Date().toISOString() })] });
    expect(within(topbar()).queryByText(/violationsDetected/)).not.toBeInTheDocument();
  });

  /**
   * The label's VALUES, and the crash that came of forgetting them.
   *
   * Six `policy.labels.*` entries carry an ICU placeholder — "Receipt expected over
   * {threshold}". This component resolved them with `t(key)` and no values, which makes
   * next-intl throw FORMATTING_ERROR; and because that happens inside a `useMemo` during
   * render, the throw escaped as a render error and the whole report page went blank. On
   * the one screen the person opens to FIX the violation.
   *
   * Nothing here caught it, and the reason is three lines up in this file: the shared
   * mock sets `t.has = () => false`, so every test in the suite took the fallback branch
   * and the resolving branch was unreachable. These two tests are the first that enter it.
   */
  describe('resolving a violation label', () => {
    const originalHas = t.has;
    afterEach(() => {
      t.has = originalHas;
    });

    it('passes the payload through, so a placeholder is filled', () => {
      t.has = () => true;
      show({
        violations: [
          v({
            message: 'receiptThresholdWarn',
            data: { thresholdMinor: '2500', policyCurrency: 'CAD' },
          }),
        ],
      });
      /**
       * Scoped to the TOP BAR, which is where this component's own summary renders.
       *
       * `ViolationLine` in `_workbench/parts.tsx` shows the same label elsewhere on the
       * page and has always passed its values — so an unscoped `getAllByText` finds that
       * copy and passes even with this component's values dropped. Checked: it did.
       *
       * The mock renders `key:values`, so the threshold appearing here at all is proof
       * the values reached `t` from THIS call site.
       */
      expect(
        within(topbar()).getByText(/policy\.labels\.receiptThresholdWarn:.*25/),
      ).toBeInTheDocument();
    });

    it('renders a label whose payload is missing, rather than nothing at all', () => {
      /**
       * The degraded case, and it must stay degraded rather than fatal. `violationValues`
       * returns undefined when `data` carries no threshold, so the label goes out without
       * values — visibly imperfect, and still a report somebody can open and fix.
       *
       * The `try/catch` around the lookup in the component is the belt for the same
       * reason: a malformed catalog entry, a key that resolves to an object, any future
       * shape that makes formatting throw must cost the reader a bad LABEL and never the
       * page.
       */
      t.has = () => true;
      show({ violations: [v({ message: 'receiptThresholdWarn', data: null })] });
      expect(within(topbar()).getByText('workbench.violationsDetected:1')).toBeInTheDocument();
      expect(within(topbar()).getByText(/receiptThresholdWarn/)).toBeInTheDocument();
    });
  });

  it('counts a BLOCK whether or not it carries a note', () => {
    // A block is not waivable by explaining it.
    show({ violations: [v({ severity: 'BLOCK', resolvedAt: new Date().toISOString() })] });
    expect(within(topbar()).getByText('workbench.violationsDetected:1')).toBeInTheDocument();
  });

  it('reads two lines over the same limit as one issue', () => {
    /**
     * Deduped by (expense, message). Three line items over the per-transaction limit on
     * one dinner is one problem to fix, and "3 violations" sends somebody looking for
     * two more.
     */
    show({
      violations: [v({ id: 'a', lineItemId: 'l1' }), v({ id: 'b', lineItemId: 'l2' })],
    });
    expect(within(topbar()).getByText('workbench.violationsDetected:1')).toBeInTheDocument();
  });

  it('groups the hover list by expense, naming the vendor', () => {
    show({ violations: [v(), v({ id: 'v2', message: 'Over the limit' })] });
    const bar = topbar();
    expect(within(bar).getByText('Corner Bistro')).toBeInTheDocument();
    expect(within(bar).getByText('A receipt is required')).toBeInTheDocument();
    expect(within(bar).getByText('Over the limit')).toBeInTheDocument();
  });

  it('labels a violation on a deleted expense rather than dropping it', () => {
    show({ violations: [v({ expenseId: 'gone' })] });
    expect(within(topbar()).getByText('line.noMerchant')).toBeInTheDocument();
  });
});

// ── The submit gate ───────────────────────────────────────────────────────────

describe('submitting', () => {
  const submitButton = () => within(topbar()).getByRole('button', { name: 'drawer.submit' });

  const violation = (over: Record<string, unknown> = {}) => ({
    id: 'v1',
    ruleCode: 'X',
    severity: 'BLOCK',
    message: 'Nope',
    data: null,
    lineItemId: null,
    expenseId: 'exp-1',
    resolvedAt: null,
    ...over,
  });

  it('submits a clean report', async () => {
    const user = userEvent.setup();
    show();
    await user.click(submitButton());
    expect(sent('submit')[0]).toEqual({ reportId: 'rep-1' });
  });

  it('blocks on a BLOCK finding', () => {
    show({ violations: [violation()] });
    expect(submitButton()).toBeDisabled();
  });

  it('blocks on a warning nobody has justified, and unblocks once justified', () => {
    /**
     * A warning is submittable — but only once the submitter has written down why. That
     * is the whole point of the "Explain this charge" field.
     */
    show({ violations: [violation({ severity: 'WARNING' })] });
    expect(submitButton()).toBeDisabled();

    cleanup();
    show({ violations: [violation({ severity: 'WARNING', resolvedAt: 'now' })] });
    expect(submitButton()).toBeEnabled();
  });

  it('blocks an empty report, and says why', () => {
    show({ expenses: [] });
    expect(submitButton()).toBeDisabled();
    expect(submitButton()).toHaveAttribute('title', 'drawer.expenseRequired');
  });

  it('blocks an uncoded report and names the expenses to open', () => {
    /**
     * The whole point of moving this in front of the press.
     *
     * `submit` has refused an uncoded report since #390, but only AFTER the button, and
     * its sentence names the missing DIMENSIONS rather than which expense to open — so a
     * submitter with eleven lines was told "department, class" and left to hunt. Before
     * that guard existed these sailed through to APPROVED and failed weeks later at the
     * posting gate; dev still holds three such reports, stuck on retry, and retry cannot
     * fix them because the coding was never captured.
     */
    show({
      expenses: [expense({ id: 'exp-1', merchant: 'Corner Bistro' })],
      coding: {
        required: ['department', 'class'],
        missing: ['class'],
        uncodedExpenseIds: ['exp-1'],
      },
    });
    expect(submitButton()).toBeDisabled();
    expect(submitButton()).toHaveAttribute('title', 'workbench.codingRequiredTitle');
    expect(screen.getByText('workbench.codingRequiredTitle')).toBeInTheDocument();
    // The expense is NAMED, and pressing it is how the submitter gets to the allocation.
    expect(screen.getByRole('button', { name: 'Corner Bistro' })).toBeInTheDocument();
  });

  it('leaves a coded report alone', () => {
    show({ coding: { required: ['department', 'class'], missing: [], uncodedExpenseIds: [] } });
    expect(submitButton()).toBeEnabled();
    expect(screen.queryByText('workbench.codingRequiredTitle')).not.toBeInTheDocument();
  });

  it('requires no coding at all when NetSuite is not installed', () => {
    /**
     * The requirement is NetSuite's. An installation without the integration has nothing
     * to be coded FOR, and blocking submission there would invent a rule out of an absent
     * integration — so an expense with no allocation is submittable.
     */
    show({ coding: { required: [], missing: [], uncodedExpenseIds: [] } });
    expect(submitButton()).toBeEnabled();
  });

  describe('a category only an administrator can fix (FR-5)', () => {
    const TAXI = {
      categoryId: 'c-taxi',
      categoryLabel: 'Taxi',
      kind: 'none',
      expenseIds: ['exp-1', 'exp-2'],
    };
    const HOTEL = {
      categoryId: 'c-hotel',
      categoryLabel: 'Hotel',
      kind: 'ambiguous',
      count: 2,
      expenseIds: ['exp-3'],
    };
    const PARKING = {
      categoryId: 'c-parking',
      categoryLabel: 'Parking',
      kind: 'inactive',
      expenseIds: ['exp-3'],
    };
    const threeExpenses = [
      expense({ id: 'exp-1', merchant: 'Acme Diner' }),
      expense({ id: 'exp-2', merchant: 'Riverside Grill' }),
      expense({ id: 'exp-3', merchant: 'Sunset Inn' }),
    ];
    const categoryOnly = (problems: unknown[], affected: string[]) => ({
      required: ['department', 'class'],
      missing: [],
      uncodedExpenseIds: [],
      categoryProblems: problems,
      categoryAffectedExpenseIds: affected,
    });
    const banner = () =>
      screen.getByText('workbench.categoryProblemTitle').closest('div') as HTMLElement;

    it('groups the banner by category, each with its own expenses, and disables Submit', () => {
      show({
        expenses: threeExpenses,
        coding: categoryOnly([TAXI, HOTEL, PARKING], ['exp-1', 'exp-2', 'exp-3']),
      });
      expect(submitButton()).toBeDisabled();
      expect(submitButton()).toHaveAttribute('title', 'workbench.categoryProblemTitle');
      const items = within(banner()).getAllByRole('listitem');
      expect(items).toHaveLength(3);
      // The ICU arguments are {category} and {count}; the mock `t` prints their values.
      expect(
        within(items[0] as HTMLElement).getByText('workbench.categoryProblemNoMatch:Taxi'),
      ).toBeInTheDocument();
      expect(
        within(items[0] as HTMLElement)
          .getAllByRole('button')
          .map((b) => b.textContent),
      ).toEqual(['Acme Diner', 'Riverside Grill']);
      expect(
        within(items[1] as HTMLElement).getByText('workbench.categoryProblemAmbiguous:Hotel,2'),
      ).toBeInTheDocument();
      expect(
        within(items[1] as HTMLElement).getByRole('button', { name: 'Sunset Inn' }),
      ).toBeInTheDocument();
      expect(
        within(items[2] as HTMLElement).getByText('workbench.categoryProblemInactive:Parking'),
      ).toBeInTheDocument();
      // The admin page is NAMED, never linked: the submitter usually cannot open it.
      expect(within(banner()).getByText('workbench.categoryProblemBody:3')).toBeInTheDocument();
      expect(within(banner()).queryByRole('link')).not.toBeInTheDocument();
    });

    it('shows no dimensions banner for a report with only a category problem', () => {
      // The wrong-fixer case: "Missing required coding" would send the submitter to allocate.
      show({ expenses: threeExpenses, coding: categoryOnly([TAXI], ['exp-1', 'exp-2']) });
      expect(screen.queryByText('workbench.codingRequiredTitle')).not.toBeInTheDocument();
      expect(screen.getByText('workbench.categoryProblemTitle')).toBeInTheDocument();
      expect(submitButton()).toHaveAttribute('title', 'workbench.categoryProblemTitle');
    });

    it('shows an expense with both problems in both banners', () => {
      show({
        expenses: threeExpenses,
        coding: {
          required: ['department', 'class'],
          missing: ['class'],
          uncodedExpenseIds: ['exp-1'],
          categoryProblems: [TAXI],
          categoryAffectedExpenseIds: ['exp-1', 'exp-2'],
        },
      });
      expect(screen.getAllByRole('button', { name: 'Acme Diner' })).toHaveLength(2);
      // The dimensions arm keeps its place ahead of the category arm.
      expect(submitButton()).toHaveAttribute('title', 'workbench.codingRequiredTitle');
    });

    it('renders the French catalog in fr-CA, not the English refusal sentence', async () => {
      const { createTranslator } = await vi.importActual<typeof import('next-intl')>('next-intl');
      const fr = (await import('@expenseos/i18n/catalogs/fr-CA/expenses')).default;
      const real = createTranslator({ locale: 'fr-CA', messages: { expenses: fr } as never });
      h.realT = (key, values) =>
        (real as (k: string, v?: unknown) => string)(`expenses.${key}`, values);
      h.locale = 'fr-CA';
      show({
        expenses: threeExpenses,
        coding: categoryOnly([TAXI, HOTEL], ['exp-1', 'exp-2', 'exp-3']),
      });
      expect(
        screen.getByText('Certaines catégories nécessitent une intervention administrative'),
      ).toBeInTheDocument();
      expect(
        screen.getByText('« Taxi » ne correspond à aucune catégorie de dépense NetSuite.'),
      ).toBeInTheDocument();
      expect(
        screen.getByText('« Hotel » correspond à 2 catégories de dépense NetSuite.'),
      ).toBeInTheDocument();
      expect(screen.getByText(/\/admin\/expense-categories/)).toBeInTheDocument();
      expect(screen.queryByText(/matches no NetSuite expense category/)).not.toBeInTheDocument();
    });

    it('names the category in the reader’s language, from the report’s own line items', () => {
      /**
       * The server's `categoryLabel` is always English: the same value feeds the English
       * posting and submit refusals. Every problem category sits on one of the report's
       * line items, whose `category.label` carries both languages — so the banner reads
       * that, and keeps `categoryLabel` only as the fallback the tests above pin.
       */
      h.locale = 'fr-CA';
      show({
        expenses: [
          expense({
            id: 'exp-1',
            merchant: 'Acme Diner',
            lineItems: [
              {
                id: 'li-1',
                categoryId: 'c-meals',
                amountMinor: '11500',
                category: { id: 'c-meals', label: { en: 'Meals', 'fr-CA': 'Repas' } },
              },
            ],
          }),
        ],
        coding: categoryOnly(
          [{ categoryId: 'c-meals', categoryLabel: 'Meals', kind: 'none', expenseIds: ['exp-1'] }],
          ['exp-1'],
        ),
      });
      expect(
        within(banner()).getByText('workbench.categoryProblemNoMatch:Repas'),
      ).toBeInTheDocument();
      expect(
        within(banner()).queryByText('workbench.categoryProblemNoMatch:Meals'),
      ).not.toBeInTheDocument();
    });

    it('still renders a payload without the category fields, and blocks nothing on it', () => {
      show({ coding: { required: ['department', 'class'], missing: [], uncodedExpenseIds: [] } });
      expect(screen.queryByText('workbench.categoryProblemTitle')).not.toBeInTheDocument();
      expect(submitButton()).toBeEnabled();
    });
  });

  it('waits for a receipt that is still being read, and says so', () => {
    /**
     * A reading that lands after the press rewrites the amounts under the approver. The
     * server refuses the submit while one is in flight (`expenses.submit`), and the button
     * is disabled on the same count so nobody has to press to find out. The page polls
     * while it is non-zero, so this clears on its own.
     */
    show({ extraction: { inFlight: 2, stale: 0 } });
    expect(submitButton()).toBeDisabled();
    expect(submitButton()).toHaveAttribute('title', 'workbench.extractionPendingTitle:2');
    const panel = screen.getByTestId('extraction-pending');
    expect(within(panel).getByText('workbench.extractionPendingTitle:2')).toBeInTheDocument();
    expect(within(panel).getByText('workbench.extractionPendingBody:2')).toBeInTheDocument();
    expect(screen.queryByTestId('extraction-stale')).not.toBeInTheDocument();
  });

  it('lets a report go once the reading has landed', () => {
    show({ extraction: { inFlight: 0, stale: 0 } });
    expect(submitButton()).toBeEnabled();
    expect(screen.queryByTestId('extraction-pending')).not.toBeInTheDocument();
  });

  it('does not hold the report on a reading the worker abandoned, but says the amounts were never read', () => {
    /**
     * Fifteen minutes silent and the row stops holding the submit — a lost job must not
     * lock somebody out for an afternoon. What it cannot do is pretend the receipt was
     * read: the note is the only thing standing between an unread receipt and a submit.
     */
    show({ extraction: { inFlight: 0, stale: 1 } });
    expect(submitButton()).toBeEnabled();
    const note = screen.getByTestId('extraction-stale');
    expect(within(note).getByText('workbench.extractionStaleTitle:1')).toBeInTheDocument();
    expect(within(note).getByText('workbench.extractionStaleBody:1,15')).toBeInTheDocument();
  });

  it('blocks on an unanswered grouping suggestion', () => {
    /**
     * The one an approver cannot catch: the same charge sits on two expenses, each
     * carrying the full total, and both entries look perfectly well-formed. Asking
     * before submit is the only place it is visible.
     */
    h.grouping = [SUGGESTION];
    show();
    expect(submitButton()).toBeDisabled();
    expect(screen.getByText(/question/)).toBeInTheDocument();
  });

  it('unblocks once the pair is answered "separate charges"', async () => {
    /**
     * Nothing is written, because nothing needs writing — the documents already sit on
     * separate expenses, which is exactly what the answer means. It is a pre-flight
     * check, not a nag: a reload asks again.
     */
    h.grouping = [SUGGESTION];
    const user = userEvent.setup();
    show();
    await user.click(screen.getByRole('button', { name: 'different' }));
    expect(submitButton()).toBeEnabled();
  });

  describe('when a submission is refused', () => {
    /**
     * The report never leaves this page — `onSubmit` catches and stays put — but the only
     * thing a refusal used to render was a truncated `text-xs` span in the top bar,
     * sharing a slot with the violations badge. A message like "Report has unresolved
     * policy violations." was cut off mid-sentence, and somebody who pressed Submit and
     * looked away saw nothing at all. Reported as "it moved to the listing and the report
     * disappeared" — which is what a silent refusal feels like.
     */
    it('explains the refusal in the body, not only in the narrow top-bar slot', async () => {
      h.errors.submit = 'Report has unresolved policy violations.';
      const user = userEvent.setup();
      show();
      await user.click(submitButton());

      // TWO copies now, and that is the fix: the top bar keeps its one-line signal (that
      // slot is shared with the approver actions and was not repurposed) and the body
      // carries the explanation, where it cannot be clipped.
      const shown = await screen.findAllByText('Report has unresolved policy violations.');
      expect(shown.length).toBeGreaterThan(1);
      expect(screen.getByText('workbench.submitBlockedTitle')).toBeInTheDocument();
      expect(screen.getByText('workbench.submitBlockedFix')).toBeInTheDocument();
    });

    it('stays on the report rather than navigating to the list', async () => {
      /** Navigating away on a refusal is what makes it feel unrecoverable: the report is
       *  still a draft, but the person is looking at a list and cannot tell which row. */
      h.errors.submit = 'Report has no approver';
      const user = userEvent.setup();
      show();
      await user.click(submitButton());
      await screen.findAllByText('Report has no approver');
      expect(h.pushed).not.toContain('/expenses');
    });

    it('cannot be reached with a blocker the client already knows about', async () => {
      /**
       * The counterpart, and the reason this panel carries no violation list.
       *
       * `submitBlocked` disables the button when `blocking > 0 || unjustifiedWarnings > 0`,
       * so a refusal that HAS local violations to show is unreachable from here. Asserted
       * rather than assumed, because rendering that list was written first and only
       * checking this proved it was dead code.
       */
      h.errors.submit = 'Report has unresolved policy violations.';
      show({ violations: [violation({ severity: 'BLOCK' })] });
      expect(submitButton()).toBeDisabled();
    });
  });

  it('offers recall on a submitted report, not on a draft', async () => {
    const user = userEvent.setup();
    show({ status: 'SUBMITTED' });
    await user.click(within(topbar()).getByRole('button', { name: 'drawer.recall' }));
    expect(sent('recall')[0]).toEqual({ reportId: 'rep-1' });

    cleanup();
    show();
    expect(within(topbar()).queryByRole('button', { name: 'drawer.recall' })).toBeNull();
  });

  it('offers delete only on a draft, and only to somebody who may', async () => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    show();
    await user.click(within(topbar()).getByRole('button', { name: /drawer.deleteReport/ }));
    expect(sent('deleteReport')[0]).toEqual({ reportId: 'rep-1' });
    expect(h.pushed).toContain('/expenses');
    confirm.mockRestore();

    cleanup();
    show({}, { canDelete: false });
    expect(within(topbar()).queryByRole('button', { name: /drawer.deleteReport/ })).toBeNull();
  });

  describe('deleting a report is confirmed first', () => {
    /**
     * It used to fire straight from the button — one stray click took the report, its
     * expenses and its receipts, with no undo. The asymmetry was the tell: deleting
     * SELECTED EXPENSES two panels away already asked, so the cheaper action was guarded
     * and the irreversible one was not.
     */
    it('asks before deleting', async () => {
      const user = userEvent.setup();
      const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
      show();
      await user.click(within(topbar()).getByRole('button', { name: /drawer.deleteReport/ }));
      expect(confirm).toHaveBeenCalledWith('drawer.confirmDeleteReport');
      expect(sent('deleteReport')).toHaveLength(1);
      confirm.mockRestore();
    });

    it('deletes nothing when the answer is no', async () => {
      const user = userEvent.setup();
      const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
      show();
      await user.click(within(topbar()).getByRole('button', { name: /drawer.deleteReport/ }));
      expect(confirm).toHaveBeenCalled();
      expect(sent('deleteReport')).toHaveLength(0);
      // And the person stays where they were, rather than being sent to the list.
      expect(h.pushed).not.toContain('/expenses');
      confirm.mockRestore();
    });
  });
});

// ── The approver flow ─────────────────────────────────────────────────────────

describe('deciding as the approver', () => {
  const approver = { canApprove: true, canSubmit: false, taskId: 'task-1' };
  const showApprover = () => show({ status: 'SUBMITTED' }, approver);

  it('approves without demanding a note', async () => {
    // Agreement needs no justification; disagreement does.
    const user = userEvent.setup();
    showApprover();
    await user.click(within(topbar()).getByRole('button', { name: 'approvals.approve' }));
    expect(sent('decide')[0]).toEqual({ taskId: 'task-1', approve: true });
  });

  it('will not reject without a note', async () => {
    /**
     * The one decision that generates a second conversation. Refusing somebody's
     * expenses with no reason attached means they have to come and ask.
     */
    const user = userEvent.setup();
    showApprover();
    await user.click(within(topbar()).getByRole('button', { name: 'approvals.reject' }));
    const confirm = await screen.findByRole('button', { name: 'approvals.confirmReject' });
    expect(confirm).toBeDisabled();

    await user.type(
      screen.getByPlaceholderText('approvals.rejectNotePlaceholder'),
      'Missing receipts',
    );
    await user.click(screen.getByRole('button', { name: 'approvals.confirmReject' }));
    expect(sent('decide')[0]).toEqual({
      taskId: 'task-1',
      approve: false,
      note: 'Missing receipts',
    });
  });

  it('returns for edit with an optional note', async () => {
    // Returning is not a refusal — it is "fix this and resend", so the note is helpful
    // rather than mandatory.
    const user = userEvent.setup();
    showApprover();
    await user.click(within(topbar()).getByRole('button', { name: 'approvals.return' }));
    await user.click(await screen.findByRole('button', { name: 'approvals.confirmReturn' }));
    expect(sent('returnForEdit')[0]).toEqual({ reportId: 'rep-1', note: undefined });
  });

  it('reassigns the task to somebody else', async () => {
    const user = userEvent.setup();
    showApprover();
    await user.click(within(topbar()).getByRole('button', { name: 'approvals.reassign' }));
    await user.click(await screen.findByText('approvals.reassignPlaceholder'));
    // VeloExpense (d37): the reason is required, and travels with the reassignment.
    await user.type(
      screen.getByPlaceholderText('approvals.reassignNotePlaceholder'),
      'On leave until Monday',
    );
    await user.click(screen.getByRole('button', { name: 'approvals.confirmReassign' }));
    expect(sent('reassign')[0]).toEqual({
      taskId: 'task-1',
      toUserId: 'u-other',
      note: 'On leave until Monday',
    });
  });

  it('will not reassign without a reason (VeloExpense, d37)', async () => {
    // The submitter and the new approver both read why it moved; a blank says nothing.
    const user = userEvent.setup();
    showApprover();
    await user.click(within(topbar()).getByRole('button', { name: 'approvals.reassign' }));
    await user.click(await screen.findByText('approvals.reassignPlaceholder'));
    const confirm = screen.getByRole('button', { name: 'approvals.confirmReassign' });
    expect(confirm).toBeDisabled();
    await user.type(screen.getByPlaceholderText('approvals.reassignNotePlaceholder'), '   ');
    expect(confirm).toBeDisabled();
    expect(sent('reassign')).toHaveLength(0);
  });

  // VeloExpense: the receipt-view acknowledgement panel and its three cases went with the
  // ladder at the cutover (w4-00c, d57) — ExpenseOS's engine has no such step setting, and
  // Approve is again the one-press action it is in ExpenseOS.

  it('will not reassign to nobody', async () => {
    const user = userEvent.setup();
    showApprover();
    await user.click(within(topbar()).getByRole('button', { name: 'approvals.reassign' }));
    expect(await screen.findByRole('button', { name: 'approvals.confirmReassign' })).toBeDisabled();
  });

  it('offers nothing to decide without a task on this report', () => {
    /**
     * `canApprove` is a permission; the TASK is the authority. Somebody with the
     * permission but no pending task here is a bystander.
     */
    show({ status: 'SUBMITTED' }, { canApprove: true, taskId: undefined });
    expect(within(topbar()).queryByRole('button', { name: 'approvals.approve' })).toBeNull();
  });

  it('surfaces a refused decision', async () => {
    h.errors.decide = 'Task already decided';
    const user = userEvent.setup();
    showApprover();
    await user.click(within(topbar()).getByRole('button', { name: 'approvals.approve' }));
    expect(await within(topbar()).findByText('Task already decided')).toBeInTheDocument();
  });
});

// ── What the drawer could do, on the workbench ───────────────────────────────

/**
 * Request receipts, Mark reimbursed and Acknowledge — the three actions the approvals
 * drawer had and this page did not. Each sits in the one `actions` list, so the desktop
 * placements (the TopBar row, or the strip above the panes) and the phone bar all get it; each is shown by its own condition, which the page
 * resolves from the same checks the procedures run (see `page.test.tsx`).
 *
 * And what happens after: every action that finishes the approver's part — a decision, a
 * return, a reassignment, an acknowledgement, a payment — refreshes the queue's reads and
 * goes back to it with `replace`. Asking for receipts does not; it comes before deciding.
 */
describe('the drawer’s actions on the workbench', () => {
  const approver = { isSubmitter: false, canApprove: true, canSubmit: false, taskId: 'task-1' };
  const apClerk = {
    isSubmitter: false,
    canEdit: false,
    canDelete: false,
    canSubmit: false,
    canApprove: false,
    canReimburse: true,
  };
  const RECEIPT = {
    id: 'r1',
    filename: 'bill.pdf',
    url: 'https://files.example/bill.pdf',
    mimeType: 'application/pdf',
    extraction: null,
  };
  /** The queue reads the approvals inbox refreshes after a decision, plus the list. */
  const QUEUE_READS = [
    'expenseApprovals.myTasks.invalidate',
    'expenseApprovals.myDecided.invalidate',
    'expenseApprovals.myTeam.invalidate',
    'expenses.list.invalidate',
  ];
  const expectBackToQueue = () => {
    expect(h.replaced).toEqual(['/expenses/approvals']);
    expect(h.utilsCalls).toEqual(expect.arrayContaining(QUEUE_READS));
    // `replace`, never `push`: Back from the queue must not reopen a decided report.
    expect(h.pushed).toEqual([]);
  };

  describe('Request receipts', () => {
    it('sits in the strip above the panes at a desktop width, beside the bar’s decisions', () => {
      // The decisions stay in the bar; the request that comes before them does not.
      show({ status: 'SUBMITTED' }, { ...approver, canChase: true });
      expect(
        within(strip()).getByRole('button', { name: 'drawer.requestReceipts:1' }),
      ).toBeEnabled();
      expect(within(topbar()).queryByRole('button', { name: /drawer.requestReceipts/ })).toBeNull();
      expect(within(topbar()).getByRole('button', { name: 'approvals.approve' })).toBeEnabled();
      expect(within(strip()).queryByRole('button', { name: 'approvals.approve' })).toBeNull();
    });

    it('is offered to a chaser when an expense has no receipt, and asks for all of them', async () => {
      const user = userEvent.setup();
      show(
        {
          status: 'SUBMITTED',
          expenses: [expense(), expense({ id: 'exp-2', merchant: 'Taxi' })],
        },
        { ...approver, canChase: true },
      );
      await user.click(within(strip()).getByRole('button', { name: 'drawer.requestReceipts:2' }));
      expect(sent('chaseReceipts')[0]).toEqual({ expenseIds: ['exp-1', 'exp-2'] });
    });

    it('asks only for the expenses with no receipt', async () => {
      const user = userEvent.setup();
      show(
        {
          status: 'SUBMITTED',
          expenses: [expense({ receipts: [RECEIPT] }), expense({ id: 'exp-2', merchant: 'Taxi' })],
        },
        { ...approver, canChase: true },
      );
      await user.click(within(strip()).getByRole('button', { name: 'drawer.requestReceipts:1' }));
      expect(sent('chaseReceipts')[0]).toEqual({ expenseIds: ['exp-2'] });
    });

    it('is not offered when every expense has a receipt', () => {
      show(
        { status: 'SUBMITTED', expenses: [expense({ receipts: [RECEIPT] })] },
        { ...approver, canChase: true },
      );
      expect(screen.queryByRole('button', { name: /drawer.requestReceipts/ })).toBeNull();
    });

    it('is not offered to somebody the page says may not chase — the submitter included', () => {
      // The page folds `!isSubmitter` into `canChase`; the workbench reads only the flag.
      show({ status: 'SUBMITTED' }, { canChase: false });
      expect(screen.queryByRole('button', { name: /drawer.requestReceipts/ })).toBeNull();
    });

    it('stays on the page and says the receipts were asked for', async () => {
      h.results.chaseReceipts = { reports: 1, expenses: 1, skipped: [] };
      const user = userEvent.setup();
      show({ status: 'SUBMITTED' }, { ...approver, canChase: true });
      await user.click(within(strip()).getByRole('button', { name: 'drawer.requestReceipts:1' }));
      expect(await within(topbar()).findByRole('status')).toHaveTextContent('drawer.chaseSent:1');
      expect(h.replaced).toEqual([]);
      expect(h.pushed).toEqual([]);
      // Still deciding: the approver's buttons are all still there.
      expect(within(topbar()).getByRole('button', { name: 'approvals.approve' })).toBeEnabled();
    });

    it('says so when there was nothing it could ask for', async () => {
      h.results.chaseReceipts = { reports: 0, expenses: 0, skipped: [] };
      const user = userEvent.setup();
      show({ status: 'SUBMITTED' }, { ...approver, canChase: true });
      await user.click(within(strip()).getByRole('button', { name: 'drawer.requestReceipts:1' }));
      expect(await within(topbar()).findByRole('status')).toHaveTextContent('drawer.chaseNone');
      expect(h.replaced).toEqual([]);
    });
  });

  /*
   * VeloExpense (d71): no Mark reimbursed on the workbench. ExpenseOS's seven cases offer it
   * to an AP clerk on an APPROVED report; VeloExpense's reimbursement screen stays the one
   * place AP pays, as the approver drawer says. What holds here is that it is never offered.
   */
  describe('Mark reimbursed (VeloExpense, d71)', () => {
    it('is not offered, even to an AP clerk on an approved report', () => {
      show({ status: 'APPROVED' }, apClerk);
      expect(screen.queryByRole('button', { name: 'approvals.markReimbursed' })).toBeNull();
    });
  });

  describe('Acknowledge', () => {
    const acknowledger = { ...approver, isAcknowledge: true };

    it('is the only thing an acknowledge task offers', () => {
      // The engine refuses a reject on such a task; the drawer shows Acknowledge alone.
      show({ status: 'SUBMITTED' }, acknowledger);
      const bar = within(topbar());
      expect(bar.getByRole('button', { name: 'approvals.acknowledge' })).toBeEnabled();
      for (const name of [
        'approvals.approve',
        'approvals.reject',
        'approvals.return',
        'approvals.reassign',
      ]) {
        expect(bar.queryByRole('button', { name })).toBeNull();
      }
    });

    it('is never offered on an ordinary approval task', () => {
      show({ status: 'SUBMITTED' }, approver);
      expect(within(topbar()).queryByRole('button', { name: 'approvals.acknowledge' })).toBeNull();
    });

    it('is not offered without a task, whatever the flag says', () => {
      show({ status: 'SUBMITTED' }, { ...acknowledger, canApprove: false, taskId: undefined });
      expect(within(topbar()).queryByRole('button', { name: 'approvals.acknowledge' })).toBeNull();
    });

    it('acknowledges as an approve of the task, and goes back to the queue', async () => {
      const user = userEvent.setup();
      show({ status: 'SUBMITTED' }, acknowledger);
      await user.click(within(topbar()).getByRole('button', { name: 'approvals.acknowledge' }));
      expect(sent('decide')[0]).toEqual({ taskId: 'task-1', approve: true });
      expectBackToQueue();
    });
  });

  describe('back to the queue', () => {
    const showApprover = () => show({ status: 'SUBMITTED' }, approver);

    it('after an approval', async () => {
      const user = userEvent.setup();
      showApprover();
      await user.click(within(topbar()).getByRole('button', { name: 'approvals.approve' }));
      expectBackToQueue();
    });

    it('after a rejection', async () => {
      const user = userEvent.setup();
      showApprover();
      await user.click(within(topbar()).getByRole('button', { name: 'approvals.reject' }));
      await user.type(screen.getByPlaceholderText('approvals.rejectNotePlaceholder'), 'No');
      await user.click(screen.getByRole('button', { name: 'approvals.confirmReject' }));
      expectBackToQueue();
    });

    it('after a return', async () => {
      const user = userEvent.setup();
      showApprover();
      await user.click(within(topbar()).getByRole('button', { name: 'approvals.return' }));
      await user.click(await screen.findByRole('button', { name: 'approvals.confirmReturn' }));
      expectBackToQueue();
    });

    it('after a reassignment', async () => {
      const user = userEvent.setup();
      showApprover();
      await user.click(within(topbar()).getByRole('button', { name: 'approvals.reassign' }));
      await user.click(await screen.findByText('approvals.reassignPlaceholder'));
      // VeloExpense (d37): the reason is required, and travels with the reassignment.
      await user.type(
        screen.getByPlaceholderText('approvals.reassignNotePlaceholder'),
        'On leave until Monday',
      );
      await user.click(screen.getByRole('button', { name: 'approvals.confirmReassign' }));
      expectBackToQueue();
    });

    it('not after a refused decision — the reason stays on screen', async () => {
      // Two approvers on one pooled task: the second press is refused, and leaving would
      // hide why.
      h.errors.decide = 'Task already decided';
      const user = userEvent.setup();
      showApprover();
      await user.click(within(topbar()).getByRole('button', { name: 'approvals.approve' }));
      expect(await within(topbar()).findByText('Task already decided')).toBeInTheDocument();
      expect(h.replaced).toEqual([]);
      expect(h.utilsCalls).not.toContain('expenseApprovals.myTasks.invalidate');
    });

    it('not after a refused return or reassignment', async () => {
      h.errors.returnForEdit = 'Task already decided';
      h.errors.reassign = 'Task already decided';
      const user = userEvent.setup();
      showApprover();
      await user.click(within(topbar()).getByRole('button', { name: 'approvals.return' }));
      await user.click(await screen.findByRole('button', { name: 'approvals.confirmReturn' }));
      await user.click(within(topbar()).getByRole('button', { name: 'approvals.reassign' }));
      await user.click(await screen.findByText('approvals.reassignPlaceholder'));
      // VeloExpense (d37): the reason is required, and travels with the reassignment.
      await user.type(
        screen.getByPlaceholderText('approvals.reassignNotePlaceholder'),
        'On leave until Monday',
      );
      await user.click(screen.getByRole('button', { name: 'approvals.confirmReassign' }));
      expect(sent('returnForEdit')).toHaveLength(1);
      expect(sent('reassign')).toHaveLength(1);
      expect(h.replaced).toEqual([]);
    });

    it('not after the submitter recalls their own report', async () => {
      // Recall is the submitter's: it refreshes the report in place and goes nowhere.
      const user = userEvent.setup();
      show({ status: 'SUBMITTED' });
      await user.click(within(topbar()).getByRole('button', { name: 'drawer.recall' }));
      expect(sent('recall')[0]).toEqual({ reportId: 'rep-1' });
      expect(h.replaced).toEqual([]);
      expect(h.pushed).toEqual([]);
      expect(h.utilsCalls).not.toContain('expenseApprovals.myTasks.invalidate');
    });
  });
});

// ── A reader who did not file the report ─────────────────────────────────────

/**
 * The page admits everyone `canViewReport` admits — a direct manager (drafts included), an
 * approver, AP, an admin — and offers the write controls to the submitter only. The page
 * folds that into the props (`isSubmitter && <permission>`, see `page.test.tsx`); what is
 * pinned here is that the workbench, handed those props, shows such a reader nothing they
 * would be refused, and fires no query that would 403 for them.
 */
describe('a reader who did not file the report', () => {
  const reader = {
    isSubmitter: false,
    canEdit: false,
    canDelete: false,
    canSubmit: false,
    canApprove: false,
  };

  it('is offered no Recall on a submitted report', () => {
    show({ status: 'SUBMITTED' }, reader);
    expect(within(topbar()).queryByRole('button', { name: 'drawer.recall' })).toBeNull();
    expect(within(topbar()).queryByRole('button', { name: 'drawer.submit' })).toBeNull();
  });

  it('is offered no Submit and no Delete on a draft', () => {
    // A direct manager may open a subordinate's draft by URL; reading it is all they may do.
    show({}, reader);
    expect(within(topbar()).queryByRole('button', { name: 'drawer.submit' })).toBeNull();
    expect(within(topbar()).queryByRole('button', { name: /drawer.deleteReport/ })).toBeNull();
    expect(within(topbar()).queryByRole('button', { name: 'drawer.recall' })).toBeNull();
  });

  it('never asks for the grouping suggestions, which only the submitter may read', () => {
    /**
     * `receiptGroupingSuggestions` FORBIDS anyone but the submitter or a read-all holder.
     * It is gated on `canEdit`, so a manager who happened to hold `updateOwn` used to fire
     * a 403 on every open; with `canEdit` folded to the submitter, the query is off.
     */
    show({ status: 'SUBMITTED' }, reader);
    expect(h.queryOpts.receiptGroupingSuggestions?.enabled).toBe(false);

    cleanup();
    show({}, reader);
    expect(h.queryOpts.receiptGroupingSuggestions?.enabled).toBe(false);
  });

  it('still lets the submitter’s own draft ask for them', () => {
    // The other side of the line above: the gate moved to the submitter, not to nobody.
    show();
    expect(h.queryOpts.receiptGroupingSuggestions?.enabled).toBe(true);
  });
});

// ── Mileage on a read-only line ───────────────────────────────────────────────

/**
 * A submitted mileage line shows the claim behind its amount — distance, route, rate —
 * through the drawer's own `MileageLineDetail`. Before, the read-only row drew category and
 * amount only, so a desktop approver landing here saw LESS than the phone drawer showed.
 * One rendering rule for every read-only line: the submitter's own included.
 */
describe('a mileage line on a submitted report', () => {
  const mileageLine = (over: Record<string, unknown> = {}) => ({
    id: 'li-m',
    categoryId: 'c-mileage',
    kind: 'MILEAGE',
    payload: null,
    amountMinor: '8640',
    category: { id: 'c-mileage', label: { en: 'Mileage' }, icon: null },
    mileageDistance: '120.00',
    mileageUnit: 'KM',
    mileageYtdBefore: '400.00',
    mileageBreakdown: [
      { fromDistance: '0', rateMinor: '72', distance: '120.00', amountMinor: '8640' },
    ],
    // What a writer of the line is sent: the stored route as is, place ids and legs too.
    mileageRoute: {
      stops: [
        { description: 'Montréal', placeId: 'p-mtl' },
        { description: 'Québec', placeId: 'p-qc' },
      ],
      legs: [{ fromPlaceId: 'p-mtl', toPlaceId: 'p-qc', meters: 120000 }],
    },
    routeDistance: null,
    mileageRouteUnavailable: false,
    notes: null,
    ...over,
  });
  const submittedWith = (line: Record<string, unknown>) => ({
    status: 'SUBMITTED',
    expenses: [expense({ merchant: null, amountMinor: '8640', lineItems: [line] })],
  });

  it('shows the submitter their own line’s distance, route and rate', () => {
    show(submittedWith(mileageLine()));
    expect(screen.getByText('line.distanceValue:120.00,line.km')).toBeInTheDocument();
    expect(screen.getByText('Montréal → Québec')).toBeInTheDocument();
    expect(screen.getByText(/^line\.mileageRate:/)).toBeInTheDocument();
  });

  it('shows another reader the stops-only route and the claimed-vs-filed pair', () => {
    // What `expenses.report` sends a reader who cannot write the line.
    show(
      submittedWith(
        mileageLine({
          mileageYtdBefore: null,
          mileageRoute: { stops: [{ description: 'Montréal' }, { description: 'Québec' }] },
          routeDistance: '131.20',
        }),
      ),
      { isSubmitter: false, canEdit: false, canDelete: false, canSubmit: false },
    );
    expect(screen.getByText('line.mileageClaimed:120.00,line.km,131.20')).toBeInTheDocument();
    expect(screen.getByText('Montréal → Québec')).toBeInTheDocument();
    expect(screen.getByText(/^line\.mileageRate:/)).toBeInTheDocument();
  });

  it('says a route the server could not read is unavailable', () => {
    show(submittedWith(mileageLine({ mileageRoute: null, mileageRouteUnavailable: true })), {
      isSubmitter: false,
      canEdit: false,
      canDelete: false,
      canSubmit: false,
    });
    expect(screen.getByText('line.routeUnavailable')).toBeInTheDocument();
  });

  it('adds nothing to a line that is not mileage', () => {
    show({
      status: 'SUBMITTED',
      expenses: [
        expense({
          lineItems: [
            {
              id: 'li-1',
              categoryId: 'c-meals',
              kind: 'STANDARD',
              amountMinor: '11500',
              category: { id: 'c-meals', label: { en: 'Meals' }, icon: null },
              mileageDistance: null,
              mileageUnit: null,
              mileageBreakdown: null,
              mileageRoute: null,
              routeDistance: null,
              mileageRouteUnavailable: false,
            },
          ],
        }),
      ],
    });
    expect(screen.queryByText(/^line\.(distanceValue|mileageRate)/)).toBeNull();
  });
});

// ── The AP-only FX override ───────────────────────────────────────────────────

describe('the FX override', () => {
  const multi = {
    // The override is only offered while a decision is pending (see below).
    status: 'SUBMITTED',
    rollup: {
      homeTotalMinor: '20000',
      homeCurrency: 'CAD',
      recoverableTotalMinor: '0',
      multiCurrency: true,
      byCurrency: [
        { code: 'CAD', grossMinor: '5000', rate: null, convertedMinor: '5000' },
        { code: 'USD', grossMinor: '10000', rate: '1.37', convertedMinor: '13700' },
      ],
      missingRates: [],
    },
  };

  it('is offered to fxOverride holders on a multi-currency report only', () => {
    /**
     * A statement shows what the card actually charged; the daily table is an estimate.
     * Pinning the rate is how the two are reconciled — and it is the finance admin's
     * call, not the submitter's. Not AP's either: AP pays and posts the report, and the
     * role that does that must not also decide its amounts, so the page keys this on
     * `expense.report.fxOverride` rather than `reimburse`.
     */
    show(multi, { canFxOverride: true });
    expect(screen.getByRole('button', { name: 'workbench.fxOverride' })).toBeInTheDocument();

    cleanup();
    show(multi);
    expect(screen.queryByRole('button', { name: 'workbench.fxOverride' })).toBeNull();

    cleanup();
    show({}, { canFxOverride: true });
    expect(screen.queryByRole('button', { name: 'workbench.fxOverride' })).toBeNull();
  });

  it('is offered to a holder who neither filed the report nor holds a task on it', () => {
    /**
     * The finance admin who pins the rate is a READER of somebody else's report: not the
     * submitter (so none of the write controls), and with no decidable task (so no approver
     * mode). The page now admits that reader through `canViewReport` and folds
     * `isSubmitter` into the write flags — the override must not be folded in with them.
     */
    show(multi, {
      isSubmitter: false,
      canEdit: false,
      canDelete: false,
      canSubmit: false,
      canApprove: false,
      canFxOverride: true,
    });
    expect(screen.getByRole('button', { name: 'workbench.fxOverride' })).toBeInTheDocument();
  });

  it('is withdrawn once the report has been decided', () => {
    /**
     * The override restates the total the approver signs and NetSuite posts on
     * approval. The server refuses it outside SUBMITTED; the button follows, so AP is
     * not offered a control that can only fail.
     */
    for (const status of ['DRAFT', 'APPROVED', 'REIMBURSED']) {
      cleanup();
      show({ ...multi, status }, { canFxOverride: true });
      expect(screen.queryByRole('button', { name: 'workbench.fxOverride' })).toBeNull();
    }
  });

  it('refuses a rate that is not a positive number', async () => {
    // A zero or a stray character would silently convert the whole report to nothing.
    const user = userEvent.setup();
    show(multi, { canFxOverride: true });
    await user.click(screen.getByRole('button', { name: 'workbench.fxOverride' }));
    const rate = await screen.findByPlaceholderText('1.37');
    await user.type(rate, '0');
    expect(screen.getByRole('button', { name: 'workbench.fxOverrideSave' })).toBeDisabled();

    await user.clear(rate);
    await user.type(rate, 'abc');
    expect(screen.getByRole('button', { name: 'workbench.fxOverrideSave' })).toBeDisabled();
  });

  it('saves a rate against the foreign currency it applies to', async () => {
    const user = userEvent.setup();
    show(multi, { canFxOverride: true });
    await user.click(screen.getByRole('button', { name: 'workbench.fxOverride' }));
    await user.type(await screen.findByPlaceholderText('1.37'), '1.4012');
    await user.click(screen.getByRole('button', { name: 'workbench.fxOverrideSave' }));
    expect(sent('setFxOverride')[0]).toEqual({
      reportId: 'rep-1',
      rate: '1.4012',
      fromCurrency: 'USD',
    });
  });

  it("shows the server's refusal inside the popover, translated, and keeps it open", async () => {
    /**
     * The override is bounded to 2× the daily rate and to SUBMITTED reports (#506). The
     * popover used to have no `onError`: a refused rate left it open with nothing said,
     * indistinguishable from a click that had not registered. The sentence is the catalog
     * key the error names, with its figures — not the English message beside it.
     */
    const user = userEvent.setup();
    h.errors.setFxOverride = {
      message: 'Rate 13.7 is more than 2× away from the daily rate 1.37 for USD→CAD.',
      data: {
        refusal: {
          key: 'refusals.fx.rateFarFromDaily',
          params: { rate: '13.7', band: 2, reference: '1.37', from: 'USD', home: 'CAD' },
        },
      },
    };
    show(multi, { canFxOverride: true });
    await user.click(screen.getByRole('button', { name: 'workbench.fxOverride' }));
    await user.type(await screen.findByPlaceholderText('1.37'), '13.7');
    await user.click(screen.getByRole('button', { name: 'workbench.fxOverrideSave' }));

    expect(screen.getByRole('alert')).toHaveTextContent(
      'refusals.fx.rateFarFromDaily:13.7,2,1.37,USD,CAD',
    );
    expect(screen.queryByText(/away from the daily rate/)).not.toBeInTheDocument();
    // Still open, for the correction.
    expect(screen.getByRole('button', { name: 'workbench.fxOverrideSave' })).toBeInTheDocument();
  });

  it('clears an override back to the daily rate', async () => {
    const user = userEvent.setup();
    show({ ...multi, fxOverride: { rate: '1.37', fromCurrency: 'USD' } }, { canFxOverride: true });
    await user.click(screen.getByRole('button', { name: 'workbench.fxOverrideActive' }));
    await user.click(await screen.findByRole('button', { name: 'workbench.fxOverrideClear' }));
    expect(sent('setFxOverride')[0]).toEqual({ reportId: 'rep-1', rate: null });
  });

  it('offers nothing to clear when there is no override', async () => {
    const user = userEvent.setup();
    show(multi, { canFxOverride: true });
    await user.click(screen.getByRole('button', { name: 'workbench.fxOverride' }));
    expect(await screen.findByRole('button', { name: 'workbench.fxOverrideClear' })).toBeDisabled();
  });
});

// ── The MCP hand-off banner ───────────────────────────────────────────────────

describe('the upload hand-off', () => {
  it('explains a report of blank expenses that arrived from a link', () => {
    /**
     * An MCP client created the report and could not upload the files itself, so the
     * person was handed a link. Without the banner the page explains nothing: a report
     * of empty expenses looks like a bug rather than an invitation.
     */
    h.params = new URLSearchParams('upload=1&n=abc');
    show();
    expect(screen.getByText('handoff.title')).toBeInTheDocument();
  });

  it('is dismissible', async () => {
    const user = userEvent.setup();
    h.params = new URLSearchParams('upload=1&n=abc');
    show();
    await user.click(screen.getByRole('button', { name: 'handoff.dismiss' }));
    expect(screen.queryByText('handoff.title')).not.toBeInTheDocument();
  });

  it('never appears on a report nobody can add to', () => {
    h.params = new URLSearchParams('upload=1&n=abc');
    show({ status: 'SUBMITTED' });
    expect(screen.queryByText('handoff.title')).not.toBeInTheDocument();
  });

  it('does not appear without the link', () => {
    show();
    expect(screen.queryByText('handoff.title')).not.toBeInTheDocument();
  });
});

// ── The camera control, on the two entry points this page owns ────────────────

/**
 * On a coarse pointer each of this page's two receipt-upload entry points — the
 * hand-off banner's chip and the expense list header's chip — gains a "Take
 * photo" control beside it. `capture="environment"` FORCES the camera and
 * removes the library choice, which is why a phone needs a second control
 * rather than a second attribute on the one it already had.
 *
 * The first test here is the one that matters most, and it is not about the
 * camera: at a fine pointer each entry point renders EXACTLY ONE
 * `input[type=file]`, with the camera control absent from the DOM rather than
 * hidden. Eight E2E call sites address file inputs by page-wide ordinal, seven
 * of them in specs that have nothing to do with receipts, so emitting both and
 * hiding one breaks all eight at once with failures that read as product bugs.
 *
 * These two entry points had NO upload coverage at all before this — the
 * hand-off tests above assert the banner's title and its dismiss and nothing
 * else — so what follows is also their first test of actually picking a file.
 *
 * On a coarse pointer both pairs are ICON-ONLY, as sites 1 and 4 already were:
 * the operator's on-device review took the visible labels off, and the words
 * moved into `sr-only` spans. So the tests below check two separate things and
 * must not be allowed to blur into one — that nothing is PAINTED but the icon,
 * and that the accessible NAME is exactly what it was.
 *
 * Each row is located through its neighbouring BUTTON rather than through label
 * text, deliberately: on a coarse pointer both pickers read
 * `capture.chooseFile`, so text alone cannot tell the banner's pair from the
 * header's while the banner is on screen.
 */
describe('the receipt controls on a phone', () => {
  /** The `?upload=1` hand-off that puts the banner (site 2) on screen at all. */
  const withLink = () => {
    h.params = new URLSearchParams('upload=1&n=abc');
  };
  const handoffRow = () =>
    screen.getByRole('button', { name: 'handoff.dismiss' }).parentElement as HTMLElement;
  /**
   * The expenses-card header's control row.
   *
   * `closest` rather than `parentElement`: "Add expense" now sits inside its own
   * `hidden lg:contents` cloak, so its parent is that wrapper and not the row the
   * receipt controls share with it. `.flex` matches the row and not the `Button`
   * itself, whose own base class is `inline-flex`.
   */
  const headerRow = () =>
    screen
      .getByRole('button', { name: /drawer.addExpense/ })
      .closest('.flex.items-center.gap-2') as HTMLElement;
  const filesIn = (row: HTMLElement) => [
    ...row.querySelectorAll<HTMLInputElement>('input[type="file"]'),
  ];
  const labelsIn = (row: HTMLElement) => [...row.querySelectorAll('label')];
  /**
   * What a sighted user can read on a control: its text with every `sr-only`
   * span taken out.
   *
   * `toHaveTextContent` cannot answer this question — an `sr-only` name is in
   * `textContent` exactly as a visible label is, which is the whole point of it
   * — so an icon-only assertion written with `toHaveTextContent` would pass just
   * as happily against the labelled treatment this change removed.
   */
  const visibleText = (label: HTMLElement) =>
    [...label.childNodes]
      .filter((n) => !(n instanceof HTMLElement && n.classList.contains('sr-only')))
      .map((n) => n.textContent ?? '')
      .join('')
      .trim();

  /**
   * Pick a receipt and leave the upload running, so the busy state stays on
   * screen to be asserted.
   *
   * The PUT to the presigned URL is parked forever rather than resolved: the
   * point is the window in which both controls have to go quiet. `fetch` is
   * dropped again by this file's `afterEach(restorePointer)`.
   */
  async function startUpload(input: HTMLInputElement) {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>(() => {})),
    );
    await userEvent.upload(input, new File(['pixels'], 'receipt.png', { type: 'image/png' }));
    // Parked at the PUT, which is past `setUploadBusy(true)`.
    await waitFor(() => expect(sent('receiptUploadUrl')).toHaveLength(1));
  }

  it('renders one control per entry point on a desktop, with no capture anywhere', () => {
    stubPointer('fine');
    withLink();
    show();

    for (const row of [handoffRow(), headerRow()]) {
      // THE non-negotiable. Not "one visible input" — one input, full stop.
      expect(filesIn(row)).toHaveLength(1);
      expect(labelsIn(row)).toHaveLength(1);
      expect(filesIn(row)[0]).not.toHaveAttribute('capture');
    }
    // And today's wording, because a lone control is not a choice between
    // sources: "Choose file" would be answering a question nobody asked.
    expect(screen.getByText('handoff.action')).toBeInTheDocument();
    expect(screen.getByText('inbox.uploadReceipt')).toBeInTheDocument();
    expect(screen.queryByText('capture.takePhoto')).not.toBeInTheDocument();
    expect(screen.queryByText('capture.chooseFile')).not.toBeInTheDocument();

    /**
     * And "Add expense" keeps its visible label. It loses that label on a coarse
     * pointer through `pointer-coarse:sr-only`, which is inert here — so what
     * this pins is that the span is NOT plainly `sr-only`, which is the way the
     * change could have reached a desktop it was never meant to touch.
     */
    const addExpense = screen.getByRole('button', { name: /drawer.addExpense/ });
    const addExpenseLabel = within(addExpense).getByText('drawer.addExpense');
    expect(addExpenseLabel.className).toContain('pointer-coarse:sr-only');
    expect(addExpenseLabel.classList.contains('sr-only')).toBe(false);
  });

  it('adds a camera control before each picker on a phone, and relabels the pair', () => {
    stubPointer('coarse');
    withLink();
    show();

    for (const row of [handoffRow(), headerRow()]) {
      const inputs = filesIn(row);
      expect(inputs).toHaveLength(2);
      // Camera first: a phone's first target is the one a phone user wants.
      expect(inputs[0]).toHaveAttribute('capture', 'environment');
      expect(inputs[1]).not.toHaveAttribute('capture');

      const labels = labelsIn(row);
      expect(labels).toHaveLength(2);
      expect(labels[0]).toHaveTextContent('capture.takePhoto');
      // Two SOURCES, not one source and one outcome — the iOS/Android
      // convention, and the only wording that makes the camera control's
      // missing library choice legible.
      expect(labels[1]).toHaveTextContent('capture.chooseFile');
    }
    expect(screen.queryByText('handoff.action')).not.toBeInTheDocument();
    expect(screen.queryByText('inbox.uploadReceipt')).not.toBeInTheDocument();
  });

  it('paints nothing but the icon on either pair, and keeps both names', () => {
    stubPointer('coarse');
    withLink();
    show();

    for (const row of [handoffRow(), headerRow()]) {
      const labels = labelsIn(row);
      // Asserted before the loop below reads them: a `for` over an empty list
      // passes, and a row located by the wrong neighbour would give one.
      expect(labels).toHaveLength(2);
      const [camera, picker] = labels;

      // The change itself. Nothing legible on either control but its glyph —
      // both labelled pairs ran their rows past a phone's width.
      expect(visibleText(camera)).toBe('');
      expect(visibleText(picker)).toBe('');

      // And the name survives intact, from where sites 1 and 4 put theirs:
      // an `sr-only` span, so voice control's "tap Take photo" still matches.
      expect(within(camera).getByText('capture.takePhoto')).toHaveClass('sr-only');
      expect(within(picker).getByText('capture.chooseFile')).toHaveClass('sr-only');

      // Never `aria-label` — on a `<label>` it does nothing useful, and on the
      // input it would shadow the visible text a desktop still has.
      for (const label of labels) expect(label).not.toHaveAttribute('aria-label');
      for (const input of filesIn(row)) expect(input).not.toHaveAttribute('aria-label');
    }
  });

  it('keeps multi-file on the picker and never puts it on the camera', () => {
    stubPointer('coarse');
    withLink();
    show();

    for (const row of [handoffRow(), headerRow()]) {
      const [camera, picker] = filesIn(row);
      // `capture` returns exactly one image per invocation on iOS Safari and on
      // Android Chrome whatever `multiple` says, so the attribute would promise
      // a batch the camera cannot deliver.
      expect(camera).not.toHaveAttribute('multiple');
      expect(picker).toHaveAttribute('multiple');
    }
  });

  it('sizes both controls to a real 44px square and declines the invisible hit-slop', () => {
    stubPointer('coarse');
    withLink();
    show();

    for (const row of [handoffRow(), headerRow()]) {
      // Two 44px targets 8px apart in these rows are easy to mis-tap, and the
      // gap is coarse-scoped so a desktop's spacing is untouched.
      expect(row.className).toContain('pointer-coarse:gap-3');
      const labels = labelsIn(row);
      expect(labels).toHaveLength(2);
      for (const label of labels) {
        /**
         * Both dimensions, because an icon-only label's only laid-out child is
         * an 18px icon — an `sr-only` span is absolutely positioned at 1px
         * square and adds nothing to a flex box — so height alone would leave a
         * 44x18 target. `px-3` belongs to the LABELLED treatment a desktop
         * gets, and to the frame before the pair exists; it has no business on
         * a square.
         */
        expect(label.className).toContain('pointer-coarse:min-h-11');
        expect(label.className).toContain('pointer-coarse:min-w-11');
        expect(label.className).toContain('justify-center');
        expect(label.className).not.toContain('pointer-coarse:px-3');
        // Neither row is height-constrained, so the target is a real resize.
        // Slop on top would be a 56px tap area poking outside a visible chip,
        // stealing taps from the button each row sits beside.
        expect(label.className).not.toContain('pointer-coarse:after');
        expect(label.className).not.toContain('pointer-coarse:relative');
      }
    }
    /**
     * And the header row does NOT wrap any more. It used to have to: three
     * labelled controls ran ~365px and would not fit a phone. Icon-only makes
     * it three 44px squares and two 12px gaps, ~156px — and wrapping was never
     * safe here anyway, because this row is a fixed `h-12` inside an
     * `overflow-hidden` card and a second line had nowhere to go.
     */
    expect(headerRow().className).not.toContain('flex-wrap');
  });

  it('gives "Add expense" the same 44px square, without touching the desktop button', () => {
    stubPointer('coarse');
    show();

    const addExpense = screen.getByRole('button', { name: /drawer.addExpense/ });
    /**
     * The label is still the accessible name — `getByRole` above found the
     * button by it — and it is still in the DOM as text; it is the PAINTING
     * that stops, through `pointer-coarse:sr-only` on the span holding it.
     *
     * Which is why this assertion is a class list and reads identically at a
     * fine pointer, and it is not the usual mistake: this control's coarse
     * treatment is CSS, deliberately (nothing in `packages/design-system`
     * changes, and the button does not reflow a beat after the first paint), so
     * a class list is the only thing there is to assert. The pointer-sensitive
     * half of the contract is the desktop test above, which pins that this span
     * is not plainly `sr-only`. jsdom performs no layout and resolves no media
     * query, so 44px itself is unmeasurable here — see ADR-0003.
     */
    expect(within(addExpense).getByText('drawer.addExpense').className).toContain(
      'pointer-coarse:sr-only',
    );
    // `h-9` is 36px and loses to a min-height; `px-3` round a glyph is 42px
    // wide, so the min-width is what makes the last 2px.
    expect(addExpense.className).toContain('pointer-coarse:min-h-11');
    expect(addExpense.className).toContain('pointer-coarse:min-w-11');
    expect(addExpense).not.toHaveAttribute('aria-label');
  });

  it('leaves each row exactly one primary', () => {
    stubPointer('coarse');
    withLink();
    show();

    const bannerLabels = labelsIn(handoffRow());
    expect(bannerLabels).toHaveLength(2);
    const [bannerCamera, bannerPicker] = bannerLabels;
    // Losing the words did not lose the hierarchy: the banner is a call to
    // action, a filled square still reads as one with no text in it, and the
    // picker beside it stays outline. One primary, as before.
    expect(bannerCamera.className).toContain('bg-primary');
    expect(bannerPicker.className).not.toContain('bg-primary');
    expect(bannerPicker.className).toContain('border-input');

    const headerLabels = labelsIn(headerRow());
    expect(headerLabels).toHaveLength(2);
    const [headerCamera, headerPicker] = headerLabels;
    /**
     * The header's row already has a primary — "Add expense" — so neither of
     * these is filled. They are now the SAME square: the camera's only cue used
     * to be `font-semibold`, and with no visible text there is nothing for a
     * weight to distinguish, so order is the cue, exactly as at site 1. No text
     * left to weight or to size, either, so those utilities are gone.
     */
    expect(headerCamera.className).not.toContain('bg-primary');
    expect(headerCamera.className).toContain('border-input');
    expect(headerCamera.className).toBe(headerPicker.className);
    expect(headerCamera.className).not.toContain('font-semibold');
    expect(headerCamera.className).not.toContain('font-medium');
  });

  it('files a receipt taken with the camera', async () => {
    stubPointer('coarse');
    withLink();
    show();

    await startUpload(filesIn(handoffRow())[0]);

    // Receipt-first capture: an expense per file, then the upload, then attach.
    expect(sent('createExpense')[0]).toEqual({ reportId: 'rep-1' });
    // The link is bound to the declared size, so it must be the size of the body PUT —
    // read off the PUT itself, so a future client-side transform is caught here.
    const put = vi.mocked(fetch);
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    const init = put.mock.calls[0]?.[1] as RequestInit | undefined;
    const body = init?.body as File;
    expect(body.size).toBeGreaterThan(0);
    expect(sent('receiptUploadUrl')[0]).toEqual({
      expenseId: 'exp-new',
      filename: 'receipt.png',
      contentType: 'image/png',
      sizeBytes: body.size,
    });
  });

  it('quiets both controls of both rows while an upload runs on a phone', async () => {
    stubPointer('coarse');
    withLink();
    show();

    await startUpload(filesIn(handoffRow())[1]);

    /**
     * `disabled` on the inputs is not enough once there are two controls: a
     * person who taps the one they did NOT start the upload with gets silence
     * and nothing to explain it. So both labels of both rows go quiet, and say
     * so — reusing the drawer's existing "Uploading…" rather than translating
     * the same word a third time.
     */
    for (const row of [handoffRow(), headerRow()]) {
      const labels = labelsIn(row);
      expect(labels).toHaveLength(2);
      for (const label of labels) {
        expect(label).toHaveTextContent('drawer.uploading');
        expect(label).toHaveAttribute('aria-disabled', 'true');
        // What actually swallows the tap, and what explains it. No spinner:
        // this codebase has no `animate-spin` and no reduced-motion handling
        // anywhere, so motion here would open an obligation P04 is not paying.
        expect(label.className).toContain('pointer-events-none');
        expect(label.className).toContain('opacity-50');
      }
      for (const input of filesIn(row)) expect(input).toBeDisabled();
      /**
       * Scoped to the row, not asked of the page — and it has to be, from P04's
       * fourth site onward.
       *
       * The receipt pane in `_workbench/parts.tsx` is the fourth entry point,
       * it is on screen here (this suite renders the real pane, it does not
       * mock it), and on a coarse pointer it carries an icon-only pair with
       * these same two `sr-only` names. Its `uploading` is its own state and
       * has nothing to do with this page's `uploadBusy`, so it is still
       * offering "Take photo" while these two rows are busy — correctly. A
       * page-wide `queryByText` would read that as a failure of THESE controls
       * to go quiet, which is not what it was ever checking.
       */
      expect(within(row).queryByText('capture.takePhoto')).not.toBeInTheDocument();
      expect(within(row).queryByText('capture.chooseFile')).not.toBeInTheDocument();
    }
  });

  it('leaves the desktop busy state precisely as it was', async () => {
    stubPointer('fine');
    show();

    const before = labelsIn(headerRow())[0].className;
    await startUpload(filesIn(headerRow())[0]);

    const label = labelsIn(headerRow())[0];
    // Today's behaviour and not one thing more: the input goes disabled, and
    // the label keeps its wording and its classes. The relabel and the dimming
    // exist to answer "why did nothing happen when I tapped the other one",
    // and on a desktop there is no other one.
    expect(filesIn(headerRow())[0]).toBeDisabled();
    expect(label).toHaveTextContent('inbox.uploadReceipt');
    expect(label).not.toHaveAttribute('aria-disabled');
    expect(label.className).toBe(before);
    expect(screen.queryByText('drawer.uploading')).not.toBeInTheDocument();
  });
});

// ── The report chrome below `lg` ──────────────────────────────────────────────

/**
 * The relocation, and the reason it is the phase without which there is no Submit
 * button on a phone.
 *
 * This page publishes its ENTIRE chrome — total, status, and every action — into the
 * app-shell TopBar. ADR-0002 rations that slot below `lg` to one icon-only control or
 * nothing, and it measured this row at 532.813px (EN) / 677.156px (fr-CA) min-content
 * against a shared 238px budget at 360. So below `lg` the action row is mounted in the
 * body instead, and the rest of the published row is cloaked.
 *
 * WHY EVERY OTHER TEST IN THIS FILE STILL SEES THE TOP BAR: the root `matchMedia`
 * polyfill in `tests/setup.ts` answers `matches: false` to every query, so
 * `useIsBelowLg()` is `false` and the desktop tree is what renders. Nothing above this
 * line had to move.
 *
 * `stubDevice` rather than two hand-rolled stubs: a phone is coarse AND compact AND
 * below `lg`, and the seam answers all three coherently — `stubPointer('coarse')` on its
 * own used to hand a test a finger on a desktop-width viewport.
 */
describe('the report chrome below lg', () => {
  const phoneBar = () => screen.getByTestId('phone-action-bar');

  const BLOCKER = {
    id: 'v1',
    ruleCode: 'X',
    severity: 'BLOCK',
    message: 'Nope',
    data: null,
    lineItemId: null,
    expenseId: 'exp-1',
    resolvedAt: null,
  };

  it('moves the action row into the body and out of the top bar', () => {
    stubDevice('phone');
    show();

    expect(within(phoneBar()).getByRole('button', { name: 'drawer.submit' })).toBeInTheDocument();
    expect(
      within(phoneBar()).getByRole('button', { name: /drawer.deleteReport/ }),
    ).toBeInTheDocument();
    // ONE tree, not two: the row is relocated, not duplicated. A second copy would be a
    // second source of truth for what can be done to this report, and it would drift the
    // first time somebody added an action and updated one of them.
    expect(within(topbar()).queryByRole('button', { name: 'drawer.submit' })).toBeNull();
    expect(within(topbar()).queryByRole('button', { name: /drawer.deleteReport/ })).toBeNull();
  });

  it('leaves the desktop exactly where it was', () => {
    stubDevice('desktop');
    show();

    expect(within(topbar()).getByRole('button', { name: 'drawer.submit' })).toBeInTheDocument();
    expect(screen.queryByTestId('phone-action-bar')).toBeNull();
    expect(screen.queryByTestId('report-summary')).toBeNull();
  });

  it('cloaks the rest of the published row below lg and never above it', () => {
    /**
     * The chrome that is NOT relocated — total, status, external ids, NetSuite, print —
     * stays published at every width, so there is nothing to unmount and nothing to keep
     * in sync. What keeps it inside ADR-0002's ration is the cloak, and the cloak is on
     * the hook's branch rather than unconditional: CSS decides what is VISIBLE, JS
     * decides what is MOUNTED.
     */
    stubDevice('phone');
    show();
    expect(topbar().querySelector('.max-lg\\:hidden')).not.toBeNull();

    cleanup();
    stubDevice('desktop');
    show();
    expect(topbar().querySelector('.max-lg\\:hidden')).toBeNull();
  });

  describe('why Submit is disabled', () => {
    /**
     * It was a `title=` attribute, which is a hover tooltip — so on a phone the submitter
     * got a greyed button and no sentence, and a disabled control whose explanation
     * exists only on hover reads as a broken app.
     */
    it('is text under the button, not only a tooltip', () => {
      stubDevice('phone');
      show({ expenses: [] });

      const submit = within(phoneBar()).getByRole('button', { name: 'drawer.submit' });
      expect(submit).toBeDisabled();
      expect(screen.getByTestId('action-reason-submit')).toHaveTextContent(
        'drawer.expenseRequired',
      );
    });

    it('has a sentence for the arms that never had one', () => {
      /**
       * Three of the six reasons produced NO explanation at any width: a report blocked
       * only by violations, only by unjustified warnings, or only by an unanswered
       * duplicate pair. The list of violations itself is a separate piece of work — a
       * fifth banner in the body's existing stack — and naming the block is what this
       * change owes.
       */
      stubDevice('phone');
      show({ violations: [BLOCKER] });
      expect(screen.getByTestId('action-reason-submit')).toHaveTextContent(
        'workbench.submitBlockedViolations:1',
      );

      cleanup();
      stubDevice('phone');
      h.grouping = [SUGGESTION];
      show();
      expect(screen.getByTestId('action-reason-submit')).toHaveTextContent(
        'workbench.submitBlockedDuplicates:1',
      );
    });

    it('still answers the desktop tooltip with today’s words', () => {
      // The first three arms keep their order and their exact strings, so nothing a
      // desktop reader already relied on changed.
      stubDevice('desktop');
      show({ expenses: [] });
      expect(within(topbar()).getByRole('button', { name: 'drawer.submit' })).toHaveAttribute(
        'title',
        'drawer.expenseRequired',
      );
    });
  });

  describe('the summary in the body', () => {
    const MIXED = {
      rollup: {
        homeTotalMinor: '23700',
        homeCurrency: 'CAD',
        recoverableTotalMinor: '0',
        multiCurrency: true,
        byCurrency: [
          { code: 'CAD', grossMinor: '10000', rate: null, convertedMinor: '10000' },
          { code: 'USD', grossMinor: '10000', rate: '1.37', convertedMinor: '13700' },
        ],
        missingRates: [],
      },
    };

    it('renders the total where the top bar cannot', () => {
      stubDevice('phone');
      show();
      const summary = screen.getByTestId('report-summary');
      expect(within(summary).getByText('$115.00')).toBeInTheDocument();
      expect(within(summary).getByText('CAD')).toBeInTheDocument();
    });

    it('renders the by-currency composition rather than disclosing it', () => {
      /**
       * The defect this exists for is not a width problem: the composition and the
       * reconciliation are exposed on `group-hover`, and `hover` does not exist on a
       * touch device. On a phone these two numbers were unreachable, not merely
       * inconvenient.
       */
      stubDevice('phone');
      show(MIXED);
      const summary = screen.getByTestId('report-summary');
      expect(within(summary).getByText(/CAD 100\.00/)).toBeInTheDocument();
      expect(within(summary).getByText(/USD 100\.00/)).toBeInTheDocument();
      expect(within(summary).getByText('workbench.fxRate:1.37')).toBeInTheDocument();
      // Not behind a disclosure: no control has to be operated to reach them.
      expect(within(summary).queryByRole('button')).toBeNull();
    });
  });

  describe('the approver, on a phone', () => {
    const approver = { canApprove: true, canSubmit: false, taskId: 'task-1' };
    const showApprover = () => show({ status: 'SUBMITTED' }, approver);

    it('keeps Approve on a row of its own, away from Reject', () => {
      /**
       * The one layout rule that is not tradeable. Two destructive-adjacent controls
       * flanking the affirmative one at 44px each in a 360px bar is how a mis-tap
       * approves a claim. It costs one row of height.
       */
      stubDevice('phone');
      showApprover();
      const approve = within(phoneBar()).getByRole('button', { name: 'approvals.approve' });
      const reject = within(phoneBar()).getByRole('button', { name: 'approvals.reject' });
      expect(approve.parentElement?.contains(reject)).toBe(false);
    });

    it('decides through the same state and the same mutation', async () => {
      // Same state, same mutation, two containers: the note panel is one definition and
      // `confirmDecide` is the page's, not the container's.
      stubDevice('phone');
      const user = userEvent.setup();
      showApprover();

      await user.click(within(phoneBar()).getByRole('button', { name: 'approvals.reject' }));
      const confirm = await screen.findByRole('button', { name: 'approvals.confirmReject' });
      expect(confirm).toBeDisabled();

      await user.type(
        screen.getByPlaceholderText('approvals.rejectNotePlaceholder'),
        'Missing receipts',
      );
      await user.click(screen.getByRole('button', { name: 'approvals.confirmReject' }));
      expect(sent('decide')[0]).toEqual({
        taskId: 'task-1',
        approve: false,
        note: 'Missing receipts',
      });
    });

    it('gets Request receipts in the bar, and stays after asking', async () => {
      stubDevice('phone');
      h.results.chaseReceipts = { reports: 1, expenses: 1, skipped: [] };
      const user = userEvent.setup();
      show({ status: 'SUBMITTED' }, { ...approver, canChase: true });
      await user.click(
        within(phoneBar()).getByRole('button', { name: 'drawer.requestReceipts:1' }),
      );
      expect(sent('chaseReceipts')[0]).toEqual({ expenseIds: ['exp-1'] });
      expect(await screen.findByRole('status')).toHaveTextContent('drawer.chaseSent:1');
      expect(h.replaced).toEqual([]);
      // Relocated, not duplicated.
      expect(within(topbar()).queryByRole('button', { name: /drawer.requestReceipts/ })).toBeNull();
    });

    it('gets Acknowledge alone, as the primary, on an acknowledge task', async () => {
      stubDevice('phone');
      const user = userEvent.setup();
      show({ status: 'SUBMITTED' }, { ...approver, isAcknowledge: true });
      const bar = within(phoneBar());
      expect(bar.getAllByRole('button').map((b) => b.textContent)).toEqual([
        'approvals.acknowledge',
      ]);
      await user.click(bar.getByRole('button', { name: 'approvals.acknowledge' }));
      expect(sent('decide')[0]).toEqual({ taskId: 'task-1', approve: true });
      expect(h.replaced).toEqual(['/expenses/approvals']);
    });

    // VeloExpense (d71): ExpenseOS's phone case for Mark reimbursed is not carried — see the
    // 'Mark reimbursed' block above.

    it('goes back to the queue after a decision made from the bar', async () => {
      stubDevice('phone');
      const user = userEvent.setup();
      showApprover();
      await user.click(within(phoneBar()).getByRole('button', { name: 'approvals.approve' }));
      expect(h.replaced).toEqual(['/expenses/approvals']);
    });
  });

  it('degrades the control and never the call', async () => {
    /**
     * The confirmation moved onto the descriptor rather than onto one button's
     * `onClick`, so the guard cannot exist in one destination and be forgotten in the
     * other. Nothing about the mutation is phone-specific — same procedure, same input.
     */
    stubDevice('phone');
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    show();
    await user.click(within(phoneBar()).getByRole('button', { name: /drawer.deleteReport/ }));
    expect(confirm).toHaveBeenCalledWith('drawer.confirmDeleteReport');
    expect(sent('deleteReport')).toHaveLength(0);

    confirm.mockReturnValue(true);
    await user.click(within(phoneBar()).getByRole('button', { name: /drawer.deleteReport/ }));
    expect(sent('deleteReport')[0]).toEqual({ reportId: 'rep-1' });
    confirm.mockRestore();
  });
});

/**
 * The review path below `lg` — the two blockers a phone reader could not read, and the
 * sheet that made the third one legible.
 *
 * Same seam and same reason as the block above: `tests/setup.ts` answers `matches:
 * false` to every query, so every test before this line still renders the desktop tree
 * and nothing above had to move.
 */
describe('the review path below lg', () => {
  const twoExpenses = [
    expense({ id: 'exp-1', merchant: 'First' }),
    expense({ id: 'exp-2', merchant: 'Second' }),
  ];

  const violation = (over: Record<string, unknown> = {}) => ({
    id: 'v1',
    ruleCode: 'X',
    severity: 'BLOCK',
    message: 'perTransactionLimit',
    data: null,
    lineItemId: null,
    expenseId: 'exp-1',
    resolvedAt: null,
    ...over,
  });

  /** The paperclip on a row — below `lg` it is a control, not a count. */
  const receiptTrigger = (n = 0) =>
    screen.getAllByRole('button', { name: /workbench\.viewReceipts/ })[n];

  describe('the violations banner', () => {
    it('lists which violations block the report, with a row per expense', () => {
      /**
       * Above `lg` this list exists only as a `group-hover` panel on the top bar's
       * violations pill, and `group-hover` does not exist on a touch device. So the
       * submitter got a count, a greyed Submit and no way to learn what to fix — which
       * is the one bullet the plan says must not be the one that goes.
       */
      stubDevice('phone');
      show({
        expenses: twoExpenses,
        violations: [
          violation({ id: 'v1', expenseId: 'exp-1', message: 'perTransactionLimit' }),
          violation({ id: 'v2', expenseId: 'exp-2', message: 'receiptRequired' }),
        ],
      });

      const banner = screen.getByTestId('violations-banner');
      expect(within(banner).getByText('workbench.violationsDetected:2')).toBeInTheDocument();
      // One row per expense, each naming the merchant, each carrying its own labels.
      expect(within(banner).getByRole('button', { name: 'First' })).toBeInTheDocument();
      expect(within(banner).getByRole('button', { name: 'Second' })).toBeInTheDocument();
      expect(within(banner).getByText('perTransactionLimit')).toBeInTheDocument();
      expect(within(banner).getByText('receiptRequired')).toBeInTheDocument();
    });

    it('opens the expense a row names', async () => {
      // The same shape as the uncoded-expense blocker twelve lines above it: a warning
      // banner holding a list of rows, each a <button> that selects the expense.
      const user = userEvent.setup();
      stubDevice('phone');
      show({
        expenses: twoExpenses,
        violations: [violation({ expenseId: 'exp-2', message: 'receiptRequired' })],
      });

      await user.click(
        within(screen.getByTestId('violations-banner')).getByRole('button', { name: 'Second' }),
      );
      // List row + the editor header, which is how the other selection tests read it.
      expect(screen.getAllByText('Second').length).toBeGreaterThan(1);
    });

    it('groups by expense rather than per violation, and keeps a bad label visible', () => {
      /**
       * Two violations on one expense are one row with two labels, not two rows — the
       * deduped list every other count on this page is derived from.
       *
       * The label falls back to the raw message key here because the harness's `t.has`
       * answers false. That IS the behaviour being pinned: six of these labels carry an
       * ICU placeholder, and a label whose payload is missing renders its own key —
       * visibly wrong and fixable — rather than throwing out of a `useMemo` during
       * render and taking the whole report down with it.
       */
      stubDevice('phone');
      show({
        expenses: twoExpenses,
        violations: [
          violation({ id: 'v1', expenseId: 'exp-1', message: 'perTransactionLimit' }),
          violation({ id: 'v2', expenseId: 'exp-1', message: 'receiptRequired' }),
        ],
      });

      const banner = screen.getByTestId('violations-banner');
      expect(within(banner).getAllByRole('button', { name: 'First' })).toHaveLength(1);
      expect(within(banner).getByText('perTransactionLimit')).toBeInTheDocument();
      expect(within(banner).getByText('receiptRequired')).toBeInTheDocument();
    });

    it('is not a second copy of the desktop hover list', () => {
      /**
       * At `lg` and up the banner does not exist. Both faces in the DOM would put every
       * violation label into the accessibility tree twice, and a duplicated accessible
       * name is the test the relocation rule turns on.
       */
      stubDevice('desktop');
      show({
        expenses: twoExpenses,
        violations: [violation({ expenseId: 'exp-1', message: 'perTransactionLimit' })],
      });

      expect(within(topbar()).getByText('workbench.violationsDetected:1')).toBeInTheDocument();
      expect(screen.queryByTestId('violations-banner')).toBeNull();
      /**
       * One copy in the top bar's hover panel, one in the centre editor's own violation
       * list for the selected expense — the two that were there before this phase. The
       * banner would have been a third, and the count is what says it is absent rather
       * than merely unfound.
       */
      expect(screen.getAllByText('perTransactionLimit')).toHaveLength(2);
    });
  });

  describe('the receipt sheet', () => {
    it('gives every row a way into its receipts, attached or not', () => {
      /**
       * Rendered whether or not the expense has a receipt: below `lg` the receipt pane
       * is a sheet, so this is also the only route from an expense to the place a
       * receipt gets attached. A control that appears only once you have already done
       * the thing is not a route.
       *
       * A sibling of the row button, never a child — the badge it replaces lives inside
       * that button, and a button inside a button is invalid HTML.
       */
      stubDevice('phone');
      show({ expenses: twoExpenses });

      const triggers = screen.getAllByRole('button', { name: /workbench\.viewReceipts/ });
      expect(triggers).toHaveLength(2);
      for (const trigger of triggers) expect(trigger.querySelector('button')).toBeNull();
    });

    it('leaves the desktop row exactly as it was', () => {
      stubDevice('desktop');
      show({ expenses: twoExpenses });
      expect(screen.queryByRole('button', { name: /workbench\.viewReceipts/ })).toBeNull();
    });

    it('suspends the list keyboard while the sheet is open', async () => {
      /**
       * The handler exempts INPUT / TEXTAREA / SELECT — it asks "is this keystroke meant
       * for a field", which has no answer for "is this keystroke meant for the thing on
       * top". Nothing in the sheet is an INPUT, so ↓ reached the list, moved the
       * selection, and swapped the sheet's contents out from under whoever was reading
       * it.
       */
      const user = userEvent.setup();
      stubDevice('phone');
      show({ expenses: twoExpenses });

      // Sheet shut: the list still takes the keyboard, exactly as it always has.
      await user.keyboard('{ArrowDown}');
      expect(screen.getAllByText('Second').length).toBeGreaterThan(1);

      await user.click(receiptTrigger(0));
      await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());

      // Sheet open: ↓ and j are inert, and the selection the sheet is showing holds.
      await user.keyboard('{ArrowDown}');
      await user.keyboard('j');
      expect(screen.getAllByText('First').length).toBeGreaterThan(1);
    });

    it('gives the keyboard back when the window is widened out of the sheet', async () => {
      /**
       * THE REGRESSION, and it cost the reader the keyboard for the rest of the session.
       *
       * The suspension above was unconditional on the flag. The sheet, though, exists
       * only below `lg` — at `lg` and up `ReceiptPane` renders the third pane instead —
       * so widening the window past 1024px unmounted the sheet WITHOUT its Close ever
       * firing. Nothing else cleared the flag, so ↑/↓/j/k stayed suspended on a page with
       * no sheet on it and no way to open one.
       *
       * Two halves, and both are asserted here because either one alone leaves a live
       * wrong state behind: the handler now suspends only while `isBelowLg && sheet`, and
       * an effect drops the flag when the viewport stops being below `lg` — so narrowing
       * again does not re-open a sheet on an expense the reader has moved on from.
       *
       * `resizeDeviceTo` rather than a second `stubDevice`, because a second stub is a
       * fresh mount and a fresh mount never had the flag. The bug only exists ACROSS the
       * breakpoint.
       */
      const user = userEvent.setup();
      stubDevice('phone');
      show({ expenses: twoExpenses });

      await user.click(receiptTrigger(0));
      await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());

      // The window is dragged past 1024px. The sheet goes with it.
      act(() => resizeDeviceTo('desktop'));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

      // The list takes the keyboard again — this was dead before the gate was scoped.
      await user.keyboard('{ArrowDown}');
      expect(screen.getAllByText('Second').length).toBeGreaterThan(1);

      // And the flag did not survive the widening: narrowing back shows no sheet.
      act(() => resizeDeviceTo('phone'));
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });
});

/**
 * The expense list as a disclosure, below `lg` — the operator round's fourth finding.
 *
 * Below `lg` the three panes stack, so the list sits between the reader and the editor of
 * the expense they just picked: at 390 x 664 choosing a row pushed the thing they chose
 * off the bottom of the screen, under a list they were finished with. So the list is
 * CLOSED when the report opens, opens on a tap of its own header, and closes again as
 * soon as a row is chosen.
 *
 * Same seam and same reason as the two blocks above: `tests/setup.ts` answers
 * `matches: false` to every query, so every test before this line still renders the
 * desktop tree with the list open and nothing above had to move.
 *
 * jsdom applies no CSS, so "closed" here is a class and an `aria-expanded`, never a
 * `toBeVisible()`. That is the same limit `parts.limitedRegions.test.tsx` documents, and
 * it is why the geometry is answered on the stage rather than here.
 */
describe('the expense list below lg', () => {
  const twoExpenses = [
    expense({ id: 'exp-1', merchant: 'First' }),
    expense({ id: 'exp-2', merchant: 'Second' }),
  ];

  /** The pane header's disclosure control — below `lg` only. */
  const listToggle = () => screen.getByRole('button', { name: /workbench\.expensesToggle/ });
  const listPane = (container: HTMLElement) =>
    container.querySelector('#workbench-expense-list') as HTMLElement;

  it('opens closed, behind a header that says how much it is holding', () => {
    stubDevice('phone');
    const { container } = show({ expenses: twoExpenses });

    const toggle = listToggle();
    // The count is in the label because a closed pane has to say what it is hiding.
    expect(toggle).toHaveAccessibleName('workbench.expensesToggle:2');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveAttribute('aria-controls', 'workbench-expense-list');
    expect(listPane(container).className).toContain('hidden');
  });

  it('opens on a tap of the header, and closes on the next one', async () => {
    const user = userEvent.setup();
    stubDevice('phone');
    const { container } = show({ expenses: twoExpenses });

    await user.click(listToggle());
    expect(listToggle()).toHaveAttribute('aria-expanded', 'true');
    expect(listPane(container).className).not.toContain('hidden');

    await user.click(listToggle());
    expect(listToggle()).toHaveAttribute('aria-expanded', 'false');
    expect(listPane(container).className).toContain('hidden');
  });

  it('selects the expense a reader taps, and then gets out of the way', async () => {
    /**
     * THE TAP THAT DID NOT WORK. On the stage no row could be selected at all, and the
     * cause was geometric rather than behavioural: the editor pane overflowed a wrapper
     * that had been squeezed below its content, so it painted on top of the list and
     * `document.elementFromPoint` at the centre of a row returned the EDITOR's title.
     * jsdom does no layout and cannot see that — the class of bug is pinned by
     * `max-lg:shrink-0` on the pane wrapper and measured in a browser.
     *
     * What CAN be pinned here is the other half: the row's own handler selects, and
     * selecting closes the list so the editor is what the reader is left looking at.
     */
    const user = userEvent.setup();
    stubDevice('phone');
    const { container } = show({ expenses: twoExpenses });

    await user.click(listToggle());
    await user.click(within(listPane(container)).getByRole('button', { name: /Second/ }));

    // Selected: the editor header carries the merchant too, so the name is in the tree
    // more than once.
    expect(screen.getAllByText('Second').length).toBeGreaterThan(1);
    expect(listToggle()).toHaveAttribute('aria-expanded', 'false');
    expect(listPane(container).className).toContain('hidden');
  });

  it('closes the list when the paperclip opens a receipt, too', async () => {
    // The row's second affordance. Both go through the same helper so the collapse
    // cannot be implemented at one of them and forgotten at the other.
    const user = userEvent.setup();
    stubDevice('phone');
    const { container } = show({ expenses: twoExpenses });

    await user.click(listToggle());
    // Held by reference rather than re-queried: the sheet is modal, so once it is up
    // everything outside it is out of the accessibility tree and `getByRole` sees none
    // of this. The element and its attribute are still exactly where they were.
    const toggle = listToggle();
    await user.click(screen.getAllByRole('button', { name: /workbench\.viewReceipts/ })[1]);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(listPane(container).className).toContain('hidden');
  });

  it('keeps the rows mounted while closed, so widening the window loses nothing', () => {
    /**
     * `hidden`, not unmounted. The rows carry the pane's multi-select checkboxes, and a
     * JS branch would drop them out of the tree on a desktop resize across 1024px — a
     * reader who did nothing but widen a window would find their selection gone. This is
     * the same ruling the per-region cloaks follow, for the same reason.
     */
    stubDevice('phone');
    const { container } = show({ expenses: twoExpenses });
    expect(within(listPane(container)).getByRole('button', { name: /First/ })).toBeInTheDocument();
    expect(within(listPane(container)).getByRole('button', { name: /Second/ })).toBeInTheDocument();
  });

  it('leaves the desktop pane open, with no header toggle at all', () => {
    stubDevice('desktop');
    const { container } = show({ expenses: twoExpenses });

    expect(screen.queryByRole('button', { name: /workbench\.expensesToggle/ })).toBeNull();
    expect(screen.getByText('drawer.expenses')).toBeInTheDocument();
    // No class is added on the hook's other branch, so the desktop pane is byte-identical.
    expect(listPane(container).className).not.toContain('hidden');
  });
});

/**
 * "Add expense" below `lg` — the operator round's third request.
 *
 * The mechanism is CSS and jsdom applies no CSS, so every assertion here is about the
 * DOM and the CLASSES on it, exactly as `parts.limitedRegions.test.tsx` documents for
 * the per-region cloaks. `stubDevice` changes nothing about this control: it is not on
 * the `useIsBelowLg` branch and must not become so, because a JS branch would unmount
 * it on a desktop resize across 1024px. The device stub is here only to say plainly
 * that the answer does not depend on it.
 */
describe('the add-expense control below lg', () => {
  const addExpense = () => screen.getByRole('button', { name: /drawer.addExpense/ });
  /** The cloak wrapping a control, if it is inside one. */
  const cloak = (el: HTMLElement) => el.closest('[class*="lg:contents"]');

  it('cloaks "Add expense" with `hidden lg:contents`, at either device', () => {
    /**
     * The control creates an EMPTY expense, and every field that would make it a real
     * one is itself cloaked on a phone — so below `lg` the "+" was one tap to a blank
     * row a reader could not fill in. `hidden lg:contents` rather than `lg:block`: the
     * header's control row is a flex container, and a `block` wrapper would become its
     * flex item and take the button's own sizing out of the row's arithmetic.
     */
    for (const device of ['phone', 'desktop'] as const) {
      stubDevice(device);
      const view = show();
      const wrapper = cloak(addExpense());
      expect(wrapper).not.toBeNull();
      expect((wrapper as HTMLElement).className).toContain('hidden lg:contents');
      expect((wrapper as HTMLElement).className).not.toContain('lg:block');
      view.unmount();
    }
  });

  it('leaves the receipt controls beside it uncloaked — they are the phone capture path', () => {
    /**
     * P04's picker and camera create an expense FROM a document and the extraction fills
     * it, which is a capability a phone genuinely has. Cloaking them with the "+" would
     * take the whole of receipt capture off the route, and it is the one thing on this
     * header a phone user is most likely to be holding.
     */
    stubDevice('phone');
    show();
    const row = screen
      .getByRole('button', { name: /drawer.addExpense/ })
      .closest('.flex') as HTMLElement | null;
    const labels = [...(row?.querySelectorAll('label') ?? [])] as HTMLElement[];
    expect(labels.length).toBeGreaterThan(0);
    for (const label of labels) expect(cloak(label)).toBeNull();
  });

  it('is the only add-expense entry point, so nothing else offers it below lg', () => {
    /**
     * The empty state is prose with no control, and the hand-off banner offers upload
     * rather than "add". If a second entry point is ever added it has to be cloaked with
     * this one, and this is the assertion that will say so.
     */
    stubDevice('phone');
    show({ expenses: [] });
    expect(screen.getAllByRole('button', { name: /drawer.addExpense/ })).toHaveLength(1);
    expect(screen.getByText('drawer.noExpenses')).toBeInTheDocument();
  });

  it('still adds an expense when it is operated, with nothing phone-specific about the call', async () => {
    // SEC-1: degrade the control, never the call. Same procedure, same input, at both.
    const user = userEvent.setup();
    stubDevice('desktop');
    show();
    await user.click(addExpense());
    expect(sent('createExpense')[0]).toEqual({ reportId: 'rep-1' });
  });
});
