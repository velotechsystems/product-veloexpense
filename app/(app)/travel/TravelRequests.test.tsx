import '@testing-library/jest-dom/vitest';
import { COMPACT_QUERY } from '@expenseos/design-system';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * What is worth pinning on the list page is the SECTIONING, because that is the
 * part with a rule in it: a request you must act on renders in the approvals queue,
 * and must not also render in oversight. Both sections read from the same server
 * data, so the de-duplication is easy to lose and doubles every count when it goes.
 */

const queries: Record<string, unknown> = {};

vi.mock('@/lib/trpc/client', () => ({
  trpc: {
    useUtils: () => ({
      travelRequests: {
        listOwn: { invalidate: vi.fn() },
        summaryOwn: { invalidate: vi.fn() },
        myTasks: { invalidate: vi.fn() },
        listOversight: { invalidate: vi.fn() },
      },
    }),
    travelRequests: {
      listOwn: { useQuery: () => queries.listOwn ?? { data: { items: [] }, isLoading: false } },
      summaryOwn: {
        useQuery: () => queries.summaryOwn ?? { data: { count: 0 }, isLoading: false },
      },
      myTasks: { useQuery: () => queries.myTasks ?? { data: { items: [] }, isLoading: false } },
      listOversight: {
        useQuery: () => queries.listOversight ?? { data: { items: [] }, isLoading: false },
      },
    },
  },
}));

/**
 * Interpolation values are appended rather than dropped, so a count rendered through
 * `t('results', { count })` is OBSERVABLE. With a bare `(key) => key` the section header
 * printed the literal string "results" whatever the number was — and an assertion that
 * can only ever produce one value is not an assertion.
 */
vi.mock('next-intl', () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key} ${Object.values(values).join(' ')}` : key,
  useLocale: () => 'en',
}));

/** The page reads `?request=` now. No params here — the deep link has its own file. */
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams() }));

vi.mock('../TopBar', () => ({ setTopBarSlot: vi.fn() }));

/** The two drawers are covered by their own files; here they only have to record what
 *  the list handed them, which is the part the list decides. */
const opened: Array<{ id: string; taskId?: string }> = [];
vi.mock('./TravelRequestDrawer', () => ({
  TravelRequestDrawer: ({ request, taskId }: { request: { id: string }; taskId?: string }) => {
    opened.push({ id: request.id, taskId });
    return <div data-testid="detail-drawer">{request.id}</div>;
  },
}));
vi.mock('./NewTravelRequestDrawer', () => ({
  NewTravelRequestDrawer: () => <div data-testid="new-drawer" />,
}));

import { setTopBarSlot } from '../TopBar';
import { TravelRequests } from './TravelRequests';

function request(over: Record<string, unknown> = {}) {
  return {
    id: 'trv-1',
    number: 'TRV-000001',
    status: 'SUBMITTED',
    destinationLabel: 'Toronto, ON, Canada',
    departDate: '2026-09-01T00:00:00.000Z',
    returnDate: '2026-09-04T00:00:00.000Z',
    approvedTotalMinor: null,
    budgetLines: [{ id: 'l1', amountMinor: 30000n }],
    currency: { code: 'CAD', symbol: '$' },
    submitter: { id: 'u1', firstName: 'Ada', lastName: 'Lovelace', email: 'ada@e.inc' },
    ...over,
  };
}

describe('TravelRequests sectioning', () => {
  it('shows a request I must act on ONCE, in the approvals queue', () => {
    const r = request();
    queries.myTasks = { data: { items: [{ taskId: 'task-1', label: 'approve', request: r }] } };
    // The server returns it in oversight too — an approver is usually also the
    // manager. Rendering it twice would double every count on the page.
    queries.listOversight = { data: { items: [r] }, isLoading: false };
    queries.listOwn = { data: { items: [] }, isLoading: false };

    render(<TravelRequests />);
    expect(screen.getAllByText('TRV-000001')).toHaveLength(1);
    // Oversight is hidden entirely once its only row moved to the queue.
    expect(screen.queryByText('sections.oversight')).toBeNull();
  });

  it('keeps an oversight row that is not mine to act on', () => {
    queries.myTasks = { data: { items: [] } };
    queries.listOversight = { data: { items: [request()] }, isLoading: false };
    queries.listOwn = { data: { items: [] }, isLoading: false };

    render(<TravelRequests />);
    expect(screen.getByText('sections.oversight')).toBeTruthy();
  });
});

// ── What a row says ───────────────────────────────────────────────────────────

const setQueries = (over: {
  own?: unknown[];
  /** The server's count of ALL my requests. Defaults to the number handed to `own`,
   *  which is the ordinary case; pass it explicitly to model a caller past the cap. */
  ownCount?: number;
  tasks?: Array<{ taskId: string; label: string; request: unknown }>;
  oversight?: unknown[];
}) => {
  queries.listOwn = { data: { items: over.own ?? [] }, isLoading: false };
  queries.summaryOwn = {
    data: { count: over.ownCount ?? (over.own ?? []).length },
    isLoading: false,
  };
  queries.myTasks = { data: { items: over.tasks ?? [] }, isLoading: false };
  queries.listOversight = { data: { items: over.oversight ?? [] }, isLoading: false };
};

/**
 * The section whose heading reads `title`.
 *
 * Every query below is scoped to one: all three sections render at once and each owns
 * its own pill bar, its own table state and (for two of them) a traveller column — so an
 * unscoped `getByRole('button', {name: 'Add filter'})` finds three, and a filter applied
 * to the wrong one proves nothing.
 */
const sectionOf = (title: string) =>
  // `.rounded-md`, not `.flex.shrink-0`: the heading's own header bar carries both of
  // those classes too, so `closest` would stop one level short of the section.
  screen.getByText(title).closest('div.rounded-md') as HTMLElement;

/** Just the section HEADER's count, not the toolbar's — the toolbar reports the filtered
 *  rows inside the section, which is a different number on purpose. */
const sectionHeaderCount = (title: string) => {
  const heading = screen.getByText(title);
  return (heading.parentElement?.textContent ?? '').replace(title, '').trim();
};

const sectionRows = (title: string) =>
  within(sectionOf(title))
    .getAllByRole('row')
    .slice(1)
    .map((r) => r.textContent ?? '')
    .filter(Boolean);

beforeEach(() => {
  opened.length = 0;
});
afterEach(() => {
  queries.listOwn = undefined;
  queries.summaryOwn = undefined;
  queries.myTasks = undefined;
  queries.listOversight = undefined;
});

describe('the budget a row shows', () => {
  it('sums the lines while the request is still open', () => {
    /**
     * `approvedTotalMinor` is only set once somebody approves. Showing a blank until
     * then would hide the number the approval decision is ABOUT.
     */
    setQueries({
      own: [
        request({
          approvedTotalMinor: null,
          budgetLines: [
            { id: 'l1', amountMinor: 30000n },
            { id: 'l2', amountMinor: 12550n },
          ],
        }),
      ],
    });
    render(<TravelRequests />);
    expect(screen.getByText(/425\.50/)).toBeInTheDocument();
  });

  it('shows what was approved once it has been, not what was asked for', async () => {
    /** The two differ whenever an approver adjusted the trip down — and the approved
     *  figure is the one the traveller may spend. */
    setQueries({
      own: [
        request({ approvedTotalMinor: '20000', budgetLines: [{ id: 'l1', amountMinor: 30000n }] }),
      ],
    });
    render(<TravelRequests />);
    expect(screen.getByText(/200\.00/)).toBeInTheDocument();
    expect(screen.queryByText(/300\.00/)).not.toBeInTheDocument();
  });

  it('reads a zero-line request as nothing rather than crashing on an empty sum', () => {
    setQueries({ own: [request({ approvedTotalMinor: null, budgetLines: [] })] });
    render(<TravelRequests />);
    expect(screen.getByText(/0\.00/)).toBeInTheDocument();
  });
});

describe('the dates a row shows', () => {
  it('renders the departure in UTC, matching how the trip was budgeted', () => {
    /**
     * Rendering it in the reader's zone shifts it a day for anyone west of Greenwich,
     * and a trip that reads as starting a day earlier than it was approved for is a
     * support ticket.
     */
    setQueries({
      own: [
        request({
          departDate: '2026-09-01T00:00:00.000Z',
          returnDate: '2026-09-04T00:00:00.000Z',
        }),
      ],
    });
    render(<TravelRequests />);
    expect(screen.getByText(/9\/1\/2026\s*–\s*9\/4\/2026/)).toBeInTheDocument();
  });

  it('leaves an open-ended return as an ellipsis rather than as today', () => {
    setQueries({ own: [request({ returnDate: null })] });
    render(<TravelRequests />);
    expect(screen.getByText(/…/)).toBeInTheDocument();
  });
});

describe('who the table names', () => {
  it('leaves the traveller column off my own trips', () => {
    /** Every row is mine; a column repeating my name in each is a column of noise. */
    setQueries({ own: [request()] });
    render(<TravelRequests />);
    // Scoped: the approvals table below always renders and always names the traveller.
    expect(within(sectionOf('sections.mine')).queryByText('columns.traveller')).toBeNull();
  });

  it('names the traveller in the approvals queue', () => {
    setQueries({ tasks: [{ taskId: 'task-1', label: 'approve', request: request() }] });
    render(<TravelRequests />);
    const queue = within(sectionOf('sections.approvals'));
    expect(queue.getByText('columns.traveller')).toBeInTheDocument();
    expect(queue.getByText('Ada Lovelace')).toBeInTheDocument();
  });

  it('will not let the traveller or the dates be hidden, and leaves the budget hideable', async () => {
    /**
     * THE COLUMNS ARE PINNED FOR THE PHONE CARD, NOT FOR THE DESKTOP TABLE, and without this
     * test nothing stops a future edit dropping the flags silently.
     *
     * `DataTableCards` intersects BOTH `subtitle` and `fields` with the reader's live
     * `columnVisibility` (`DataTableCards.tsx:241`, `:265`), so hiding a column on the
     * desktop table takes it off the phone card too. `traveller` is the card's subtitle on
     * the two `showTraveller` sections and `dates` is a card field, so hiding either leaves
     * an approver a queue of trips with nobody attached to them, or a card that says where a
     * trip goes and never when. That is the failure `MOBILE_WITH_TRAVELLER` exists to
     * prevent, and `hideable: false` is what holds it — at the cost of a desktop capability,
     * which is a trade the operator made deliberately.
     *
     * `budget` is asserted in the OTHER direction in the same test, so the trade is pinned on
     * both sides: it is the one of the three a reader can lose without the card becoming
     * ambiguous, and quietly pinning it too would take a capability nobody agreed to give up.
     *
     * Asserted through the column menu rather than off the column definition, because the
     * menu item is what a reader actually reaches for — `DataTable.tsx:1039` passes
     * `hideable={def.hideable !== false}` down and `ColumnHeader.tsx:317` renders the item
     * only when it is true, so a flag that stopped reaching the header would still be red
     * here. Same idiom as `DataTable.test.tsx`'s column-header-menu block.
     */
    const user = userEvent.setup();

    /** One render per column, because two open popovers put two `hide` items on the page and
     *  the query below could not say which menu either belonged to. */
    const menuOffersHide = async (section: string, columnLabel: string) => {
      setQueries({ tasks: [{ taskId: 'task-1', label: 'approve', request: request() }] });
      render(<TravelRequests />);
      const th = within(sectionOf(section))
        .getAllByText(columnLabel)
        .map((node) => node.closest('th'))
        .find((node): node is HTMLTableCellElement => node != null);
      expect(th, `no column header for "${columnLabel}" in ${section}`).toBeTruthy();
      /** The LAST trigger carrying the menu label: on a sortable column the quick-sort arrow
       *  reuses `labels.menu` as its aria-label, so the first match sorts instead of opening
       *  anything. `DataTable.test.tsx` records the same trap. */
      const triggers = within(th as HTMLElement).queryAllByRole('button', { name: 'menu' });
      /** NO MENU AT ALL IS A STRONGER ANSWER THAN A MENU WITHOUT THE ITEM, not a miss.
       *  `ColumnHeader.tsx:209` renders the popover only for `filterable || hideable`, and
       *  `dates` is neither filterable nor sortable — so pinning it takes its whole column
       *  menu away. There is then nothing to click and nothing that could hide it. */
      if (triggers.length === 0) {
        cleanup();
        return false;
      }
      await user.click(triggers[triggers.length - 1]);
      const offered = screen.queryByText('hide') !== null;
      cleanup();
      return offered;
    };

    expect(
      await menuOffersHide('sections.approvals', 'columns.traveller'),
      'the traveller column offers Hide again, so `hideable: false` came off it. Hiding it ' +
        'strips the name from the phone approval cards as well as from this table, because ' +
        '`DataTableCards` intersects `subtitle` with `columnVisibility` — an approver would ' +
        'get a queue of trips with nobody attached to them.',
    ).toBe(false);

    expect(
      await menuOffersHide('sections.approvals', 'columns.dates'),
      'the dates column offers Hide again, so `hideable: false` came off it. `dates` is a ' +
        'card FIELD and `fields` is intersected with `columnVisibility` too, so hiding it ' +
        'here leaves a phone card that says where a trip goes and never when.',
    ).toBe(false);

    expect(
      await menuOffersHide('sections.approvals', 'columns.budget'),
      'the budget column no longer offers Hide. It is deliberately the one of the three a ' +
        'reader MAY lose — the card stays unambiguous without it — so pinning it too takes ' +
        'a desktop capability nobody agreed to give up.',
    ).toBe(true);
  });
});

describe('opening a request', () => {
  it('carries the task id for a row in the queue, so it can be decided', async () => {
    const user = userEvent.setup();
    setQueries({ tasks: [{ taskId: 'task-1', label: 'approve', request: request() }] });
    render(<TravelRequests />);
    await user.click(screen.getByText('TRV-000001'));
    expect(opened.at(-1)).toEqual({ id: 'trv-1', taskId: 'task-1' });
  });

  it('carries no task id for a row I am merely watching', async () => {
    /** A drawer that offered Approve on an oversight row would offer a decision the
     *  server refuses — and the reader would not know which of the two was wrong. */
    const user = userEvent.setup();
    setQueries({ oversight: [request()] });
    render(<TravelRequests />);
    await user.click(screen.getByText('TRV-000001'));
    expect(opened.at(-1)).toEqual({ id: 'trv-1', taskId: undefined });
  });

  it('carries no task id for my own trip', async () => {
    const user = userEvent.setup();
    setQueries({ own: [request()] });
    render(<TravelRequests />);
    await user.click(screen.getByText('TRV-000001'));
    expect(opened.at(-1)).toEqual({ id: 'trv-1', taskId: undefined });
  });

  it('re-reads the row from the live query rather than the one clicked', async () => {
    /**
     * The drawer holds a row captured at click time; an action taken inside it (a quote,
     * a reprice) changes the server's copy. Re-reading means the drawer reflects that
     * without being closed and reopened.
     */
    const user = userEvent.setup();
    setQueries({ own: [request()] });
    const view = render(<TravelRequests />);
    await user.click(screen.getByText('TRV-000001'));
    setQueries({ own: [request({ approvedTotalMinor: '99900' })] });
    view.rerender(<TravelRequests />);
    expect(screen.getByText(/999\.00/)).toBeInTheDocument();
  });
});

describe('narrowing a section', () => {
  /**
   * Six text operators and two enum ones, all hand-written. The pill bar belongs to ONE
   * section's table, so a filter applied in the queue must not narrow the trips below it.
   */
  const rows = [
    request({ id: 'a', number: 'TRV-000001', destinationLabel: 'Toronto, ON, Canada' }),
    request({
      id: 'b',
      number: 'TRV-000002',
      destinationLabel: 'Tokyo, Japan',
      status: 'APPROVED',
      submitter: { id: 'u2', firstName: 'Grace', lastName: 'Hopper', email: 'grace@e.inc' },
    }),
  ];

  const numbers = () => ['TRV-000001', 'TRV-000002'].filter((n) => screen.queryByText(n));

  const addPill = async (
    user: ReturnType<typeof userEvent.setup>,
    section: string,
    field: string,
    op: string,
    value: string,
    kind: 'text' | 'enum' = 'text',
  ) => {
    // The TRIGGER is inside the section; the form it opens is portalled to the document,
    // so only the first query is scoped.
    await user.click(
      within(sectionOf(section)).getByRole('button', { name: /(?:Add filter|filters\.addFilter)/ }),
    );
    await user.selectOptions(await screen.findByLabelText(/(?:^Field$|filters\.field)/), field);
    await user.selectOptions(screen.getByLabelText(/(?:^Operator$|filters\.operator)/), op);
    const control = screen.getByLabelText(/(?:^Value$|filters\.value$)/);
    if (kind === 'enum') await user.selectOptions(control, value);
    else await user.type(control, value);
    await user.click(screen.getByRole('button', { name: /(?:^Add$|filters\.add$)/ }));
  };

  const cases: Array<[string, string, string, string[]]> = [
    ['destination', 'contains', 'tokyo', ['TRV-000002']],
    ['destination', 'doesNotContain', 'tokyo', ['TRV-000001']],
    ['number', 'equals', 'trv-000001', ['TRV-000001']],
    ['number', 'doesNotEqual', 'trv-000001', ['TRV-000002']],
    ['number', 'startsWith', 'trv-00000', ['TRV-000001', 'TRV-000002']],
    ['number', 'endsWith', '2', ['TRV-000002']],
  ];

  for (const [field, op, value, expected] of cases) {
    it(`narrows on ${field} ${op}`, async () => {
      const user = userEvent.setup();
      setQueries({ own: rows });
      render(<TravelRequests />);
      await addPill(user, 'sections.mine', field, op, value);
      expect(numbers()).toEqual(expected);
    });
  }

  it('narrows by traveller, which is the column an approver scans', async () => {
    const user = userEvent.setup();
    setQueries({
      tasks: rows.map((r, i) => ({ taskId: `task-${i}`, label: 'approve', request: r })),
    });
    render(<TravelRequests />);
    await addPill(user, 'sections.approvals', 'traveller', 'contains', 'grace');
    expect(numbers()).toEqual(['TRV-000002']);
  });

  it('narrows to one status', async () => {
    const user = userEvent.setup();
    setQueries({ own: rows });
    render(<TravelRequests />);
    await addPill(user, 'sections.mine', 'status', 'equals', 'APPROVED', 'enum');
    expect(numbers()).toEqual(['TRV-000002']);
  });

  it('excludes one status', async () => {
    const user = userEvent.setup();
    setQueries({ own: rows });
    render(<TravelRequests />);
    await addPill(user, 'sections.mine', 'status', 'doesNotEqual', 'APPROVED', 'enum');
    expect(numbers()).toEqual(['TRV-000001']);
  });

  it('leaves the other sections alone', async () => {
    /** Each section owns its own pill bar and its own table state. A filter that leaked
     *  across them would empty a list the reader never touched. */
    const user = userEvent.setup();
    setQueries({
      own: [rows[0]],
      tasks: [{ taskId: 'task-1', label: 'approve', request: rows[1] }],
    });
    render(<TravelRequests />);
    await addPill(user, 'sections.mine', 'destination', 'contains', 'nowhere');
    // The narrowed section falls back to its empty text; the queue below is untouched.
    expect(sectionRows('sections.mine')).toEqual(['empty']);
    expect(sectionRows('sections.approvals')).toHaveLength(1);
  });
});

describe('sorting by budget', () => {
  it('orders by the amount, not by the formatted text', async () => {
    /**
     * `1,000.00` sorts before `200.00` as text. These are bigints because a budget can
     * exceed 2^53 in a minor-unit currency, so the comparison is hand-written.
     */
    const user = userEvent.setup();
    setQueries({
      own: [
        request({ id: 'a', number: 'TRV-000001', approvedTotalMinor: '100000' }),
        request({ id: 'b', number: 'TRV-000002', approvedTotalMinor: '20000' }),
      ],
    });
    render(<TravelRequests />);
    const mine = within(sectionOf('sections.mine'));
    const header = mine.getByText('columns.budget').closest('th') as HTMLElement;
    // This file's `t` mock drops the namespace, and `useTableLabels` scopes to
    // `table.colMenu` — so the label is the bare key within it.
    await user.click(within(header).getAllByRole('button', { name: 'menu' })[0]);
    expect(sectionRows('sections.mine')[0]).toContain('TRV-000002');
  });
});

describe('the empty states', () => {
  it('says something different in each section', () => {
    /** "No trips" and "nothing waiting on you" are different facts, and the second is
     *  the one an approver wants to be sure of. */
    setQueries({});
    render(<TravelRequests />);
    expect(screen.getByText('empty')).toBeInTheDocument();
    expect(screen.getByText('emptyApprovals')).toBeInTheDocument();
  });

  it('hides oversight entirely rather than showing an empty third table', () => {
    setQueries({});
    render(<TravelRequests />);
    expect(screen.queryByText('sections.oversight')).not.toBeInTheDocument();
  });
});

/**
 * NOTE on the toolbar, deliberately untested here.
 *
 * This page now wires `DataTableToolbar` (export + column settings + density) per
 * `docs/design/listing-standard.md`, which it had never had — it shipped with the pill
 * bar and the table only, so there was no export despite `exportValue` already being
 * declared on the budget column.
 *
 * There is no DOM test for it. The toolbar's controls render as generic popover triggers
 * with no stable accessible name in this environment, so any query for them would pass
 * or fail on design-system internals rather than on whether this page wires the toolbar
 * — and a test that passes for the wrong reason is worse than none. Its presence is held
 * by the typecheck and the build; its BEHAVIOUR is the design system's own tests.
 */

describe('the count on the "my trips" header', () => {
  /**
   * `listOwn` is capped at 500 rows. Counting the rows it returned would report what
   * fit, not what exists — so the header reads the server aggregate instead. The two
   * numbers are deliberately different here: a header that could only ever equal the row
   * count would pass this test no matter which source it read.
   */
  it('reports the server total, not the number of rows the cap let through', () => {
    setQueries({ own: [request(), request({ id: 'trv-2', number: 'TRV-000002' })], ownCount: 501 });
    render(<TravelRequests />);
    expect(sectionHeaderCount('sections.mine')).toBe('results 501');
    expect(sectionRows('sections.mine')).toHaveLength(2);
  });

  it('shows nothing rather than a zero while the aggregate is still loading', () => {
    /** A header that flashes "0" on every navigation reads as "you have no trips", which
     *  is a different claim from "we do not know yet". */
    queries.listOwn = { data: { items: [request()] }, isLoading: false };
    queries.summaryOwn = { data: undefined, isLoading: true };
    queries.myTasks = { data: { items: [] }, isLoading: false };
    queries.listOversight = { data: { items: [] }, isLoading: false };
    render(<TravelRequests />);
    expect(sectionHeaderCount('sections.mine')).toBe('');
  });
});

// ── The phone ─────────────────────────────────────────────────────────────────

/**
 * Answer `matchMedia` as a phone, and only for the one query the card switch
 * reads. Every other probe still gets `false`, so this does not accidentally
 * flip something unrelated inside the design-system primitives the page mounts.
 *
 * Note what this does NOT need to do: no test above it stubs `matchMedia` at
 * all, `useIsCompact` reads `false` when the function is absent, and so every
 * other assertion in this file is still made against the TABLE tree. The
 * desktop rendering is held unchanged by 300-odd tests that never saw this
 * block.
 */
function stubCompact() {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query === COMPACT_QUERY,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }));
}

describe('what a section becomes on a phone', () => {
  beforeEach(stubCompact);
  afterEach(() => vi.unstubAllGlobals());

  it('renders cards, titled by the destination rather than by the number', () => {
    /**
     * The title is the card's accessible name and its only navigation
     * affordance, so it has to be the string a person recognises the row by.
     * A phone list reading TRV-000001 / TRV-000002 / TRV-000003 is a list of
     * nothing — which is what asserting the BUTTON's name, and not merely the
     * presence of the text, pins here.
     */
    setQueries({ own: [request()] });
    render(<TravelRequests />);

    const section = within(sectionOf('sections.mine'));
    expect(section.queryByRole('table')).toBeNull();
    expect(section.getByRole('button', { name: 'Toronto, ON, Canada' })).toBeInTheDocument();
  });

  it('carries the destination, the dates and the status a reader came for', () => {
    /**
     * The named worse-than-overflow failure: a card that silently drops the
     * status is worse than a table the reader has to scroll sideways. The
     * budget and the number ride along in the same assertion because losing
     * either one is the same class of mistake.
     */
    setQueries({ own: [request()] });
    render(<TravelRequests />);

    const card = within(sectionOf('sections.mine')).getByRole('listitem', {
      name: 'Toronto, ON, Canada',
    });
    const text = card.textContent ?? '';
    expect(text).toMatch(/9\/1\/2026\s*–\s*9\/4\/2026/);
    expect(text).toContain('status.SUBMITTED');
    expect(text).toContain('300.00');
    expect(text).toContain('TRV-000001');
  });

  it("names the traveller on a card that is somebody else's trip, and not on mine", () => {
    /** Same rule the traveller COLUMN follows on the desktop: a name repeated on
     *  every one of my own rows is a line of noise. On a card it costs more than
     *  a column does, because the card has four lines and not seven.
     *
     *  NOT IN TENSION WITH `traveller` BEING `hideable: false`, though the two are
     *  easy to read as though they were. The pin decides whether the subtitle slot
     *  CAN be filled — `DataTableCards` intersects `subtitle` with the reader's
     *  `columnVisibility` (`DataTableCards.tsx:241`), so without it a reader who hid
     *  the column on the desktop table would get approval cards with nobody attached
     *  to them. This test is about whether the slot IS filled, which is the card
     *  CONFIG's choice per section: `MOBILE_MINE` omits it, `MOBILE_WITH_TRAVELLER`
     *  carries it. */
    setQueries({
      own: [request()],
      tasks: [{ taskId: 'task-1', label: 'approve', request: request({ id: 'trv-2' }) }],
    });
    render(<TravelRequests />);

    expect(within(sectionOf('sections.mine')).queryByText('Ada Lovelace')).toBeNull();
    expect(within(sectionOf('sections.approvals')).getByText('Ada Lovelace')).toBeInTheDocument();
  });

  it('opens the request from the card title, with the task id the section implies', async () => {
    const user = userEvent.setup();
    setQueries({ tasks: [{ taskId: 'task-1', label: 'approve', request: request() }] });
    render(<TravelRequests />);

    await user.click(
      within(sectionOf('sections.approvals')).getByRole('button', {
        name: 'Toronto, ON, Canada',
      }),
    );
    expect(opened.at(-1)).toEqual({ id: 'trv-1', taskId: 'task-1' });
  });
});

// ── The one control the top bar is allowed below `lg` ─────────────────────────

/**
 * `TopBar.tsx` rations this route's `right` slot below `lg`: at most ONE icon-only control,
 * 32x32 visual with a 44px vertical hit area, or nothing at all. A control carrying a TEXT
 * LABEL is over that ration, and nothing in `TopBar.tsx` clips — so the row lays out at full
 * width and paints over the route title, worst in FR-CA where `travel.new` is "Nouvelle
 * demande de voyage" (26) against a "Demandes de voyage" title (18).
 *
 * HOW THIS SEES A SLOT THE PAGE NEVER MOUNTS. `vi.mock('../TopBar')` above replaces
 * `setTopBarSlot` with a `vi.fn()`, so `TravelRequests` renders nothing into a top bar under
 * test — but a `vi.fn()` RECORDS its arguments, and the element is the second one. So the
 * page is rendered, the last non-null `right` slot is taken back out of `mock.calls`, the
 * page is unmounted, and that element is rendered on its own. `TravelRequests.tsx:163` is the
 * rule this exists to hold: ONE ELEMENT whose LABEL changes at `lg`, never a `max-lg:hidden`
 * labelled button beside an `lg:hidden` icon one — which jsdom, loading no stylesheet, would
 * put BOTH of in the accessibility tree.
 *
 * WHAT IT CAN AND CANNOT SEE. jsdom applies no Tailwind stylesheet, so nothing here computes
 * to 32px or to 44px and no assertion below claims it does; the classes are asserted on the
 * element that has to carry them, the same idiom as `DelegationsManager.test.tsx`'s block of
 * the same name. The rendered geometry belongs to `e2e/tap-targets.mobile.spec.ts`'s
 * `/travel` lane and to `e2e/travel.mobile.spec.ts`, in both locales.
 */
describe('the control the top bar publishes', () => {
  const published = () => {
    setQueries({ own: [request()] });
    render(<TravelRequests />);

    /** LAST non-null, not first: `vi.fn()` calls are not cleared between tests in this file,
     *  and the effect's own cleanup publishes `null` on every unmount. */
    const node = [...vi.mocked(setTopBarSlot).mock.calls]
      .reverse()
      .find(([area, slot]) => area === 'right' && slot != null)?.[1];
    expect(
      node,
      'TravelRequests published nothing into the top bar`s `right` slot. The effect at ' +
        'TravelRequests.tsx:187 is unconditional, so this is the mock, the effect or the ' +
        'slot name having moved — not a permission.',
    ).toBeTruthy();

    // Unmount the page before rendering the slot alone, so `getAllByRole` below is scoped to
    // the published element and cannot pick up a button from the list underneath it.
    cleanup();
    render(<div>{node}</div>);
    return screen.getAllByRole('button', { name: 'new' });
  };

  it('publishes exactly one button, not a labelled one and an icon one', () => {
    /**
     * Stated as a count so the reason is legible rather than inferred from a `getByRole`
     * that happens to be singular. Two branches is the plausible wrong answer — it is the
     * shape most responsive top-bar controls take — and this is where it fails.
     */
    expect(
      published(),
      'the top bar accepts ONE control below `lg`. jsdom applies no stylesheet, so a ' +
        '`max-lg:hidden` labelled branch and an `lg:hidden` icon branch would BOTH be in the ' +
        'accessibility tree and a phone reader would meet whichever one CSS left standing.',
    ).toHaveLength(1);
  });

  it('hides the label below lg without taking it out of the accessible name', () => {
    /**
     * `max-lg:sr-only` rather than `max-lg:hidden`, and rather than `sr-only lg:not-sr-only`:
     *
     *   · `hidden` removes the label from the accessibility tree too, and the control becomes
     *     an unlabelled icon in both locales;
     *   · `not-sr-only` sets `white-space: normal`, overriding the Button base's
     *     `whitespace-nowrap`, and would let the DESKTOP label wrap where today it cannot.
     *
     * The name is asserted first and the mechanism second — `published()` already found this
     * button BY its name, which is the accessible name surviving at every width.
     */
    const [button] = published();
    const label = screen.getByText('new');
    expect(label).toHaveClass('max-lg:sr-only');
    expect(label.tagName, 'the label is its own element, so only IT is hidden').toBe('SPAN');
    expect(button).toContainElement(label);
  });

  it('becomes a square control carrying exactly one, vertical-only, slop class below lg', () => {
    /**
     * The cva `size="sm"` variant is `einc-tap-slop h-9 rounded-md px-3 text-xs`, so below
     * `lg` the unprefixed `h-9` is overridden, a matching width is added and the horizontal
     * padding comes off — a 32x32 box in place of a 36px-tall labelled pill.
     *
     * THE SLOP CLASS COMES FROM THE CVA AND NOTHING MAY ADD A SECOND ONE, which is what the
     * `toEqual` below is for. `cn`/`twMerge` has no conflict map for these two — they are
     * hand-written CSS in `globals.css`, not Tailwind utilities — so an `einc-tap-slop-both`
     * in `className` would not REPLACE the cva's `einc-tap-slop`: both would land on the
     * element and stylesheet source order would decide the hit box. That is how the
     * `/delegations` control came to ship a horizontal reach it should not have had.
     *
     * Vertical-only is also right on the merits here: this lands beside `NotificationBell`'s
     * `einc-tap-slop-both` trigger across a 6px `gap-1.5` gutter, so a 6px-per-side horizontal
     * reach overlaps the bell's and the bell — later in DOM order — wins the shared strip. The
     * horizontal shortfall is RECORDED in `docs/design/pwa.md`'s tap-target table, not slopped
     * over, and `e2e/tap-targets.mobile.spec.ts` asserts it positively.
     */
    const [button] = published();
    expect(button).toHaveClass('max-lg:h-8', 'max-lg:w-8', 'max-lg:px-0');
    expect(button).toHaveClass('einc-tap-slop');
    expect(
      Array.from(button.classList).filter((c) => c.startsWith('einc-tap-slop')),
      'the published control must carry exactly one slop class, and it must be the ' +
        'vertical-only `einc-tap-slop` from the `size="sm"` cva variant. Two of them on one ' +
        'element is not a merge — twMerge does not know they conflict — it is a hit region ' +
        'decided by the order the rules happen to appear in globals.css.',
    ).toEqual(['einc-tap-slop']);
    /** The base's `gap-2` has nothing to space once the label is out of flow, so the glyph
     *  would otherwise sit off-centre in a 32px box. Read off the class list rather than
     *  through a CSS selector: a class containing a colon needs escaping in a selector, and
     *  getting that wrong reads as the class being absent. */
    const glyph = button.querySelector('svg');
    expect(glyph, 'the button lost its icon').not.toBeNull();
    expect(Array.from((glyph as SVGElement).classList)).toContain('max-lg:mr-0');
  });
});
