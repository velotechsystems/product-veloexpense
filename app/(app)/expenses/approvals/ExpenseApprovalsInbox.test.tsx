import '@testing-library/jest-dom/vitest';
import { COMPACT_QUERY } from '@expenseos/design-system';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTrpcMock, type TrpcMockConfig } from '@/test-utils/trpc';

/**
 * /expenses/approvals — the approver's inbox, in three views.
 *
 * The views are not cosmetic: each answers a different question and the wrong wiring
 * between them hands somebody authority they do not have.
 *
 *   · **Pending** is what the caller can decide, so it is the only view with selection
 *     and the only one offering bulk approve.
 *   · **My team** is every report from a direct report, wherever the workflow routed
 *     it. Those rows are keyed by REPORT id, not by a task the caller owns — passing
 *     one through as a task would light up Approve on a report that is not theirs to
 *     decide.
 *   · **Decided by me** is history; it has nothing to act on.
 *
 * Deep-linking is the other risk: a notification links here with `?report=`, and the
 * drawer has to open on that id whether or not the row is in the loaded queue. Opening
 * only on a match makes the newest notification — the one about the thing you were
 * just looking at — the one that appears to do nothing.
 */

const h = vi.hoisted(() => ({
  trpc: undefined as unknown,
  params: new URLSearchParams(),
  drawer: null as Record<string, unknown> | null,
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
vi.mock('next/navigation', () => ({ useSearchParams: () => h.params }));
/** The drawer has its own suite; here only the props it is handed matter. */
vi.mock('./ApproverReportDrawer', () => ({
  ApproverReportDrawer: (props: Record<string, unknown>) => {
    h.drawer = props;
    return <div data-testid="drawer" />;
  },
}));

import { ExpenseApprovalsInbox } from './ExpenseApprovalsInbox';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const report = (over: Record<string, unknown> = {}) => ({
  id: 'rep-1',
  number: 'EXP-1042',
  title: 'Toronto client visit',
  status: 'SUBMITTED',
  submittedAt: '2026-07-28T12:00:00.000Z',
  totalMinor: '125000',
  currency: { code: 'CAD', symbol: '$' },
  submitter: { id: 'u-1', firstName: 'Dana', lastName: 'Patel', email: 'dana@e.inc' },
  ...over,
});

const pending = (over: Record<string, unknown> = {}) => ({
  taskId: 'task-1',
  label: null,
  report: report(),
  ...over,
});

const decided = (over: Record<string, unknown> = {}) => ({
  taskId: 'task-9',
  decision: 'APPROVED',
  decidedAt: '2026-07-30T12:00:00.000Z',
  report: report({ status: 'APPROVED' }),
  ...over,
});

const team = (over: Record<string, unknown> = {}) => ({
  report: report({ id: 'rep-7', number: 'EXP-2001', title: 'Yul trip' }),
  pendingWith: { firstName: 'Sam', lastName: 'Ito', email: 'sam@e.inc' },
  lastDecision: null,
  ...over,
});

function setTrpc(
  data: { pending?: unknown[]; decided?: unknown[]; team?: unknown[] } = {},
  over: TrpcMockConfig = {},
) {
  h.trpc = createTrpcMock({
    ...over,
    queries: {
      'expenseApprovals.myTasks': { data: { items: data.pending ?? [pending()] } },
      'expenseApprovals.myDecided': { data: { items: data.decided ?? [decided()] } },
      'expenseApprovals.myTeam': { data: { items: data.team ?? [team()] } },
      ...over.queries,
    },
  });
}

const show = (canReimburse = false) =>
  render(<ExpenseApprovalsInbox canReimburse={canReimburse} />);

const rowTexts = () =>
  screen
    .getAllByRole('row')
    .slice(1)
    .map((r) => r.textContent ?? '')
    .filter((s) => s.length > 0);

/**
 * Switch queue through the saved-views dropdown.
 *
 * The three queues were three toggle buttons above the bar; they are system views now, so
 * getting to one is: open the dropdown (its trigger is labelled with the ACTIVE view), then
 * pick the row. The row is the LAST match because when the target is already active the
 * trigger carries the same name, and the row is rendered after it.
 */
const toView = async (user: ReturnType<typeof userEvent.setup>, which: string) => {
  const trigger = screen.getAllByRole('button', {
    name: /expenses\.approvals\.view(Pending|Decided|Team)/,
  })[0];
  await user.click(trigger);
  const rows = await screen.findAllByRole('button', { name: `expenses.approvals.${which}` });
  await user.click(rows[rows.length - 1]);
};

/** A second pending task, from a different submitter, for the filter tests. */
const other = () =>
  pending({
    taskId: 'task-2',
    report: report({
      id: 'rep-2',
      number: 'EXP-2001',
      title: 'Yul trip',
      submitter: { id: 'u-2', firstName: 'Sam', lastName: 'Ito', email: 's@e.inc' },
    }),
  });

async function filterColumn(
  user: ReturnType<typeof userEvent.setup>,
  column: string,
  value: string,
) {
  const header = screen.getByText(column).closest('th') as HTMLElement;
  const buttons = within(header).getAllByRole('button', { name: 'table.colMenu.menu' });
  await user.click(buttons[buttons.length - 1]);
  await user.click(await screen.findByText('table.colMenu.filter'));
  await user.type(await screen.findByPlaceholderText('table.colMenu.value'), value);
  await user.click(screen.getByText('table.colMenu.apply'));
}

beforeEach(() => {
  h.params = new URLSearchParams();
  h.drawer = null;
});
afterEach(() => {
  h.trpc = undefined;
  vi.restoreAllMocks();
});

// ── The pending queue ─────────────────────────────────────────────────────────

describe('the pending queue', () => {
  it('reads a task out as report, submitter, total and when it was filed', () => {
    setTrpc();
    show();
    const row = rowTexts()[0];
    expect(row).toContain('Toronto client visit');
    expect(row).toContain('EXP-1042');
    expect(row).toContain('Dana Patel');
    expect(row).toContain('$1,250.00');
    expect(row).toContain('Jul 28, 2026');
  });

  it('dashes a report that has no submitted date', () => {
    // A recalled-and-resubmitted report can be in the queue before the stamp lands.
    setTrpc({ pending: [pending({ report: report({ submittedAt: null }) })] });
    show();
    expect(rowTexts()[0]).toContain('—');
  });

  it('says the queue is empty in its own words', () => {
    setTrpc({ pending: [] });
    show();
    expect(screen.getByText('expenses.approvals.emptyTitle')).toBeInTheDocument();
    expect(screen.getByText('expenses.approvals.emptyBody')).toBeInTheDocument();
  });

  it('narrows on the report title or number', async () => {
    const user = userEvent.setup();
    setTrpc({ pending: [pending(), other()] });
    show();
    await filterColumn(user, 'expenses.columns.report', 'exp-2001');
    expect(rowTexts()).toHaveLength(1);
    expect(screen.getByText('Yul trip')).toBeInTheDocument();
  });

  it('narrows on the submitter', async () => {
    // The other half of "whose report was that" — you have one or the other.
    const user = userEvent.setup();
    setTrpc({ pending: [pending(), other()] });
    show();
    await filterColumn(user, 'expenses.approvals.submitter', 'dana');
    expect(rowTexts()).toHaveLength(1);
    expect(screen.getByText('Toronto client visit')).toBeInTheDocument();
  });
});

// ── Switching views ───────────────────────────────────────────────────────────

describe('the three views', () => {
  it('only asks for the view it is showing', () => {
    /**
     * All three queries are declared unconditionally; without the `enabled` gate the
     * inbox fires three requests to render one table.
     */
    const tasks = vi.fn();
    const dec = vi.fn();
    const tm = vi.fn();
    setTrpc(
      {},
      {
        queries: {
          'expenseApprovals.myTasks': { data: { items: [pending()] }, onCall: tasks },
          'expenseApprovals.myDecided': { data: { items: [decided()] }, onCall: dec },
          'expenseApprovals.myTeam': { data: { items: [team()] }, onCall: tm },
        },
      },
    );
    show();
    expect(tasks.mock.calls[0]?.[1]).toMatchObject({ enabled: true });
    expect(dec.mock.calls[0]?.[1]).toMatchObject({ enabled: false });
    expect(tm.mock.calls[0]?.[1]).toMatchObject({ enabled: false });
  });

  it('shows the approver’s own decision and its date in the decided view', async () => {
    const user = userEvent.setup();
    setTrpc();
    show();
    await toView(user, 'viewDecided');
    expect(
      screen.getByText('expenses.approvals.decision.approved · Jul 30, 2026'),
    ).toBeInTheDocument();
  });

  it('dashes a decided row whose decision did not come back', async () => {
    const user = userEvent.setup();
    setTrpc({ decided: [decided({ decision: undefined, decidedAt: null })] });
    show();
    await toView(user, 'viewDecided');
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('says who a team report is waiting on', async () => {
    const user = userEvent.setup();
    setTrpc();
    show();
    await toView(user, 'viewTeam');
    expect(screen.getByText('expenses.approvals.awaitingName:Sam Ito')).toBeInTheDocument();
  });

  it('says who last decided a team report once nobody holds it', async () => {
    const user = userEvent.setup();
    setTrpc({
      team: [
        team({
          pendingWith: null,
          lastDecision: {
            by: { firstName: 'Sam', lastName: 'Ito', email: 'sam@e.inc' },
            decision: 'APPROVED',
          },
        }),
      ],
    });
    show();
    await toView(user, 'viewTeam');
    expect(
      screen.getByText('expenses.approvals.decidedByName.approved:Sam Ito'),
    ).toBeInTheDocument();
  });

  it('dashes a team report that has neither', async () => {
    const user = userEvent.setup();
    setTrpc({ team: [team({ pendingWith: null, lastDecision: null })] });
    show();
    await toView(user, 'viewTeam');
    expect(rowTexts()[0]).toContain('—');
  });

  it('gives each empty view its own words', async () => {
    const user = userEvent.setup();
    setTrpc({ decided: [], team: [] });
    show();
    await toView(user, 'viewDecided');
    expect(screen.getByText('expenses.approvals.decidedEmptyTitle')).toBeInTheDocument();
    expect(screen.getByText('expenses.approvals.decidedEmptyBody')).toBeInTheDocument();
    await toView(user, 'viewTeam');
    expect(screen.getByText('expenses.approvals.teamEmptyTitle')).toBeInTheDocument();
    expect(screen.getByText('expenses.approvals.teamEmptyBody')).toBeInTheDocument();
  });
});

// ── Selection and bulk approve ────────────────────────────────────────────────

describe('bulk approve', () => {
  it('is offered only in the pending view', async () => {
    /**
     * The other two views hold reports the caller has no pending task on, so a
     * selection there is a selection of things they cannot decide.
     */
    const user = userEvent.setup();
    setTrpc();
    show();
    expect(screen.getAllByRole('checkbox', { name: 'table.misc.selectRow' })).toHaveLength(1);
    await toView(user, 'viewTeam');
    expect(
      screen.queryByRole('checkbox', { name: 'table.misc.selectRow' }),
    ).not.toBeInTheDocument();
  });

  it('drops a selection made in the pending view when the view changes', async () => {
    // Otherwise the toolbar keeps counting rows that are no longer on screen.
    const user = userEvent.setup();
    setTrpc();
    show();
    await user.click(screen.getByRole('checkbox', { name: 'table.misc.selectRow' }));
    expect(screen.getByRole('button', { name: /table\.misc\.selected/ })).toBeInTheDocument();
    await toView(user, 'viewDecided');
    expect(screen.queryByRole('button', { name: /table\.misc\.selected/ })).not.toBeInTheDocument();
  });

  it('approves the selected tasks by task id', async () => {
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc({}, { mutations: { 'expenseApprovals.decideBulk': { onCall } } });
    show();
    await user.click(screen.getByRole('checkbox', { name: 'table.misc.selectRow' }));
    await user.click(screen.getByRole('button', { name: /table\.misc\.selected/ }));
    await user.click(await screen.findByText(/expenses\.approvals\.approveSelected/));
    expect(onCall).toHaveBeenCalledWith({ taskIds: ['task-1'] });
  });

  it('reports what went through and what did not', async () => {
    /**
     * A bulk approve is partial by nature — a task somebody else decided in the
     * meantime is skipped, and silence about it reads as success.
     */
    const user = userEvent.setup();
    setTrpc(
      {},
      {
        mutations: {
          'expenseApprovals.decideBulk': {
            outcome: 'success',
            data: { approved: ['task-1'], skipped: ['task-2'] },
          },
        },
      },
    );
    show();
    await user.click(screen.getByRole('checkbox', { name: 'table.misc.selectRow' }));
    await user.click(screen.getByRole('button', { name: /table\.misc\.selected/ }));
    await user.click(await screen.findByText(/expenses\.approvals\.approveSelected/));
    expect(
      await screen.findByText('expenses.approvals.bulkApproved:1 expenses.approvals.bulkSkipped:1'),
    ).toBeInTheDocument();
  });

  it('clears the last result once a fresh selection begins', async () => {
    // A stale "2 approved" above a new selection is a claim about the wrong rows.
    const user = userEvent.setup();
    setTrpc(
      {},
      {
        mutations: {
          'expenseApprovals.decideBulk': {
            outcome: 'success',
            data: { approved: ['task-1'], skipped: [] },
          },
        },
      },
    );
    show();
    await user.click(screen.getByRole('checkbox', { name: 'table.misc.selectRow' }));
    await user.click(screen.getByRole('button', { name: /table\.misc\.selected/ }));
    await user.click(await screen.findByText(/expenses\.approvals\.approveSelected/));
    expect(await screen.findByText('expenses.approvals.bulkApproved:1')).toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: 'table.misc.selectRow' }));
    expect(screen.queryByText('expenses.approvals.bulkApproved:1')).not.toBeInTheDocument();
  });
});

// ── Opening a report ──────────────────────────────────────────────────────────

describe('opening a report', () => {
  it('hands the drawer the report and the caller’s task on it', async () => {
    const user = userEvent.setup();
    setTrpc();
    show();
    await user.click(screen.getByText('Toronto client visit'));
    expect(h.drawer).toMatchObject({ reportId: 'rep-1', taskId: 'task-1', isAcknowledge: false });
  });

  it('opens a team report WITHOUT a task, so Approve does not light up', async () => {
    /**
     * Team rows are keyed by report id because the caller has no task of their own on
     * them. Passing that key through as a taskId would offer a decision on somebody
     * else's report.
     */
    const user = userEvent.setup();
    setTrpc();
    show();
    await toView(user, 'viewTeam');
    await user.click(screen.getByText('Yul trip'));
    expect(h.drawer).toMatchObject({ reportId: 'rep-7', taskId: undefined });
  });

  it('tells the drawer when the task is an acknowledgement, not a decision', async () => {
    // An acknowledgement has no reject; offering one would be a decision it cannot make.
    const user = userEvent.setup();
    setTrpc({ pending: [pending({ label: 'acknowledge' })] });
    show();
    await user.click(screen.getByText('Toronto client visit'));
    expect(h.drawer).toMatchObject({ isAcknowledge: true });
  });

  it('passes the reimburse permission through', async () => {
    const user = userEvent.setup();
    setTrpc();
    show(true);
    await user.click(screen.getByText('Toronto client visit'));
    expect(h.drawer).toMatchObject({ canReimburse: true });
  });

  it('opens a deep-linked report straight away', () => {
    h.params = new URLSearchParams('report=rep-1&n=1');
    setTrpc();
    show();
    expect(h.drawer).toMatchObject({ reportId: 'rep-1', taskId: 'task-1' });
  });

  it('opens a deep-linked report that is not in the loaded queue', () => {
    /**
     * Otherwise the newest notification — the one about the report you were just
     * looking at, which the cached list has not caught up with — is the one that
     * appears to do nothing.
     */
    h.params = new URLSearchParams('report=rep-999&n=1');
    setTrpc();
    show();
    expect(h.drawer).toMatchObject({ reportId: 'rep-999', taskId: undefined });
  });

  it('closes without leaving the deep link to re-open it', async () => {
    const user = userEvent.setup();
    h.params = new URLSearchParams('report=rep-1&n=1');
    setTrpc();
    show();
    expect(screen.getByTestId('drawer')).toBeInTheDocument();
    (h.drawer?.onClose as () => void)();
    // Any interaction, to flush the close through React. The queue's name now appears
    // twice — on the saved-views trigger and on its own filter pill — so this takes the
    // first rather than asserting there is only one.
    await user.click(screen.getAllByRole('button', { name: 'expenses.approvals.viewPending' })[0]);
    expect(screen.queryByTestId('drawer')).not.toBeInTheDocument();
  });
});

/**
 * /expenses/approvals below `md` — the approver's queue as cards.
 *
 * Without `mobile`, `<DataTable>`'s `compact` never fires and this page
 * renders its full desktop `<table>` uncloaked at every width: roughly 920px
 * of declared column widths inside a ~330px phone content box. An approver
 * deciding a claim between meetings is the person this route exists for, so
 * that is not a cosmetic gap.
 *
 * What is pinned HERE is the wiring a screenshot cannot see: which columns a
 * card borrows in each of the three queues, that the queue itself is still
 * switchable once the pill bar is cloaked, that no checkbox and no kebab
 * appeared, and that every string on the compact chrome came out of the
 * catalog. Real geometry at 360/390 is the browser suite's half.
 *
 * ── The F43 guard ───────────────────────────────────────────────────
 *
 * `<FilterSheet>` and `<SortSheet>` default every label to English INSIDE the
 * design system, as literals. `check-used-keys` cannot see a literal, so a
 * page that mounts either sheet without its bag ships English chrome to a
 * French reader and no gate in the repo says a word. Under this file's
 * next-intl mock a catalog key renders as the key itself, so the two are
 * trivially distinguishable.
 *
 * ── The namespace trap ──────────────────────────────────────────────
 *
 * This suite's mock PREFIXES every key with its namespace (`ns.key`), unlike
 * `ExpenseReportsList.test.tsx`'s, which drops the namespace. The sheet label
 * hooks call `useTranslations('table')`, so the strings to assert here are
 * `table.mobile.filtersTrigger` and friends — NOT the bare `mobile.*` the
 * `/expenses` suite asserts. Copying those assertions across fails.
 */
describe('<ExpenseApprovalsInbox> on a phone', () => {
  /** Answer `matchMedia` as a phone. Only `COMPACT_QUERY` flips, so no
   *  unrelated probe inside the design system is accidentally answered. */
  function stubCompact(compact: boolean) {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query === COMPACT_QUERY ? compact : false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }));
  }

  function renderCompact(data: Parameters<typeof setTrpc>[0] = {}) {
    stubCompact(true);
    setTrpc(data);
    return show();
  }

  /**
   * Switch queue the way a phone has to: through the filter sheet.
   *
   * The saved-views dropdown and the `queue` pill both live in the pill bar,
   * which is cloaked below `md` — so on a phone the sheet is the ONLY control
   * for the page's most-used choice. `queue` is an enum field, and an enum
   * value chip is not editable in place (only text ops are), so the honest
   * gesture is: drop the clause naming the current queue, then name the new
   * one from the same Add-filter pill the desktop bar uses. `view` reads the
   * SAME clause array either control writes to, which is the whole point.
   */
  const toQueueViaSheet = async (user: ReturnType<typeof userEvent.setup>, queue: string) => {
    // The trigger counts clause GROUPS, and the queue clause is itself the
    // one filter this page opens with.
    await user.click(screen.getByRole('button', { name: 'table.mobile.filtersWithCount:1' }));
    const sheet = await screen.findByRole('dialog');
    await user.click(within(sheet).getByRole('button', { name: 'table.filters.removeValue' }));
    await user.click(within(screen.getByRole('dialog')).getByText('table.filters.addFilter'));
    // The Add-filter popover is portaled, so it is addressed from the document.
    await user.selectOptions(await screen.findByLabelText('table.filters.field'), 'queue');
    await user.selectOptions(screen.getByLabelText('table.filters.value'), queue);
    await user.click(screen.getByRole('button', { name: 'table.filters.add' }));
    await user.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'table.mobile.done' }),
    );
  };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders cards, not a table', () => {
    renderCompact({ pending: [pending(), other()] });
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });

  it('borrows report, submitter, status and the pending queue’s own two fields', () => {
    /**
     * `title: 'report'` and `badge: 'status'` ignore column visibility by
     * design — a card with neither is not a card. `subtitle: 'submitter'` is
     * what an approver triages by first ("whose is this?"), and it gives the
     * card the "<report> — <person>" shape the card renderer's own anatomy
     * note describes.
     */
    renderCompact();
    const card = screen.getByRole('listitem', { name: /Toronto client visit/ });
    expect(card).toHaveTextContent('Toronto client visit'); // title: report
    expect(card).toHaveTextContent('EXP-1042');
    expect(card).toHaveTextContent('Dana Patel'); // subtitle: submitter
    expect(card).toHaveTextContent('expenses.status.submitted'); // badge: status
    expect(card).toHaveTextContent('expenses.columns.total'); // field: total
    expect(card).toHaveTextContent('$1,250.00');
    expect(card).toHaveTextContent('expenses.approvals.submitted'); // field: submitted
    expect(card).toHaveTextContent('Jul 28, 2026');
  });

  it('swaps the third field for the decision in the decided queue', async () => {
    /**
     * `fields` is view-dependent for the same reason `columns` is: `decided`
     * has no definition outside this view, and "when it was filed" is not
     * what somebody reading their own decision history is looking for.
     */
    const user = userEvent.setup();
    renderCompact();
    await toQueueViaSheet(user, 'decided');
    const card = await screen.findByRole('listitem', { name: /Toronto client visit/ });
    expect(card).toHaveTextContent('expenses.approvals.decidedColumn');
    expect(card).toHaveTextContent('expenses.approvals.decision.approved · Jul 30, 2026');
    expect(card).toHaveTextContent('expenses.columns.total');
    expect(card).not.toHaveTextContent('expenses.approvals.submitted');
  });

  it('swaps it for who is holding the report in the team queue', async () => {
    const user = userEvent.setup();
    renderCompact();
    await toQueueViaSheet(user, 'team');
    const card = await screen.findByRole('listitem', { name: /Yul trip/ });
    expect(card).toHaveTextContent('expenses.approvals.withColumn');
    expect(card).toHaveTextContent('expenses.approvals.awaitingName:Sam Ito');
    expect(card).not.toHaveTextContent('expenses.approvals.submitted');
  });

  it('switches queue from the sheet — the only control a phone has for it', async () => {
    /**
     * The queue is not a narrowing of one dataset: it chooses which QUERY
     * runs. The pill bar that carries both the `queue` pill and the
     * saved-views dropdown is cloaked below `md`, so if the sheet could not
     * reach the clause, two of this page's three queues would be unreachable
     * on a phone entirely.
     */
    const user = userEvent.setup();
    renderCompact();
    expect(screen.getByRole('listitem', { name: /Toronto client visit/ })).toBeInTheDocument();
    await toQueueViaSheet(user, 'team');
    expect(await screen.findByRole('listitem', { name: /Yul trip/ })).toBeInTheDocument();
    expect(
      screen.queryByRole('listitem', { name: /Toronto client visit/ }),
    ).not.toBeInTheDocument();
  });

  it('opens the drawer from the card — the only way to decide on a phone', async () => {
    // Tapping the title IS the primary flow here, and it is the only one:
    // there is no kebab and no card checkbox, so a decision cannot be reached
    // without the drawer that shows the policy violations and the receipts.
    const user = userEvent.setup();
    renderCompact();
    await user.click(screen.getByText('Toronto client visit'));
    expect(h.drawer).toMatchObject({ reportId: 'rep-1', taskId: 'task-1', isAcknowledge: false });
  });

  it('offers no per-card checkbox — bulk approve stays a desktop affordance', () => {
    /**
     * `mobile.selectable` is a SECOND opt-in on top of the table's
     * `selectable`, and this page sets only the latter. The toolbar's
     * bulk-approve trigger is not laid out for 360px, and ticking rows that
     * nothing can then act on is worse than not ticking them. The gap is
     * NAMED, not silently closed with a control that goes nowhere.
     */
    renderCompact();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });

  it('draws no row-actions kebab on a card, deliberately', () => {
    /**
     * Not an omission. A quick Approve from a card would let somebody decide
     * a financial approval without ever opening the drawer that shows the
     * policy violations and the missing-receipt state — a review bypass
     * dressed as a convenience. The desktop table has no per-row menu for the
     * same reason. Whoever reads this as a gap: it is closed on purpose.
     */
    renderCompact();
    expect(screen.queryByRole('button', { name: 'table.misc.rowActions' })).not.toBeInTheDocument();
  });

  it('puts filter and sort within reach, at 44px, in place of the cloaked pill bar', () => {
    // Cards have no column headers, so the two affordances the table hangs
    // off a `<th>` have nowhere to live; these are where they go.
    renderCompact();
    const filters = screen.getByRole('button', { name: 'table.mobile.filtersWithCount:1' });
    const sort = screen.getByRole('button', { name: 'table.mobile.sortTrigger' });
    expect(filters).toHaveClass('h-11');
    expect(sort).toHaveClass('h-11');
    // THE F43 GUARD — see the note above this block. The design system's own
    // English defaults must not be what a reader sees.
    expect(screen.queryByRole('button', { name: 'Filters · 1' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sort' })).not.toBeInTheDocument();
  });

  it('labels the sheet CONTENTS from the catalog too, not just the triggers', async () => {
    // A trigger can be right while everything behind it is English — the
    // sheet takes two separate bags (`labels` for the pill chrome it shares
    // with the bar, `sheetLabels` for the frame that only exists below `md`)
    // and forgetting either is silent.
    const user = userEvent.setup();
    renderCompact();
    await user.click(screen.getByRole('button', { name: 'table.mobile.filtersWithCount:1' }));
    const sheet = await screen.findByRole('dialog');
    expect(within(sheet).getByText('table.filters.addFilter')).toBeInTheDocument();
    expect(within(sheet).getByRole('button', { name: 'table.mobile.done' })).toBeInTheDocument();
    expect(within(sheet).queryByText('Add filter')).not.toBeInTheDocument();
    expect(within(sheet).queryByRole('button', { name: 'Done' })).not.toBeInTheDocument();
  });

  it('says plainly that nothing here sorts, rather than offering a dead field', async () => {
    /**
     * No column on this page declares `sortable`, so the desktop header
     * offers no sort either and `sortSheetOptions` — the SAME resolver the
     * header calls — returns nothing. The sheet says so, in the reader's own
     * language, instead of listing a field that would move an indicator and
     * reorder nothing (F04 by another route). Built off the resolver so that
     * the day a column here gains sorting, both surfaces gain it together.
     */
    const user = userEvent.setup();
    renderCompact();
    await user.click(screen.getByRole('button', { name: 'table.mobile.sortTrigger' }));
    const sheet = await screen.findByRole('dialog');
    expect(within(sheet).getByText('table.mobile.sortEmpty')).toBeInTheDocument();
    expect(within(sheet).queryAllByRole('radio')).toHaveLength(0);
    expect(
      within(sheet).queryByText('Nothing on this list can be sorted.'),
    ).not.toBeInTheDocument();
  });

  it('keeps the pill bar as the ONLY filter frame at desktop width', () => {
    // One frame at a time. The bar is a horizontal strip with no room below
    // `md`; the sheet is that strip stacked. Both at once would be two filter
    // editors on one screen writing to one clause array.
    stubCompact(false);
    setTrpc();
    show();
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /table\.mobile\.filters/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'table.mobile.sortTrigger' }),
    ).not.toBeInTheDocument();
    expect(screen.getByText('table.filters.addFilter')).toBeInTheDocument();
  });
});
