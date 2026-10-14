import '@testing-library/jest-dom/vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { restorePointer, stubDevice } from '@/test-utils/pointer';

/**
 * "Reports to approve" — the queue waiting on the reader's decision, on the landing page.
 *
 * Its siblings `MyExpenseReportsCard.test.tsx` and `MyTravelRequestsCard.test.tsx` pin the
 * shape all three cards share (real row links, footer absent when empty, skeleton never a
 * zero, error face rather than an empty one). Repeating all of that here would be noise,
 * so what this file leans on is the part that is THE APPROVER'S:
 *
 *   THE HEADER IS A COUNT AND NEVER A TOTAL. This is the highest-stakes number on the
 *   page — "how much is waiting on my signature" — and it is the one card whose five rows
 *   routinely come from several submitters in several currencies. Adding minor units
 *   across them is GA readiness report F54, and the "dominant currency + excluded count"
 *   treatment the other two cards use understates a LIABILITY. So there is an assertion
 *   below that no money reaches the header at all, and it is meant to fail loudly if
 *   anybody ever adds one.
 *
 *   THE QUEUE IS DEDUPED AND EXPLICITLY ORDERED. `myTasks` is a task list — a parallel
 *   gate can put two of the reader's decidable tasks on one report, which is right in the
 *   inbox and is the same link twice here — and it concatenates `assigned` then
 *   `claimable`, so its `items` are not globally ordered. The card owns both fixes.
 *
 *   AN APPROVER WITH NOTHING PENDING STILL GETS A CARD. An absent card is
 *   indistinguishable from absent permission, a failed query, or a bug.
 *
 * And the row target is a real `<a>` to `/expenses/approvals?report=<id>`, never
 * `onRowClick`: `DataTable` puts that handler on a `<tr>` with no `tabIndex`, no
 * `onKeyDown` and no `role`, which no keyboard can reach.
 */

const h: {
  tasks: unknown;
  isError: boolean;
  isPending: boolean;
  refetches: number;
} = {
  tasks: undefined,
  isError: false,
  isPending: false,
  refetches: 0,
};

vi.mock('next-intl', () => ({
  useTranslations: (ns?: string) => {
    const fn = (k: string, v?: Record<string, unknown>) =>
      v ? `${ns}.${k}:${Object.values(v).join(',')}` : `${ns}.${k}`;
    return fn;
  },
  useLocale: () => 'en',
}));
vi.mock('@/i18n/navigation', () => ({
  Link: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children?: React.ReactNode;
    className?: string;
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('@/lib/trpc/client', () => ({
  trpc: {
    expenseApprovals: {
      myTasks: {
        useQuery: () => ({
          data: h.tasks,
          isError: h.isError,
          isPending: h.isPending,
          refetch: () => {
            h.refetches += 1;
          },
        }),
      },
    },
  },
}));

const { ReportsToApproveCard } = await import('./ReportsToApproveCard');

/**
 * Dates are pinned to NOON UTC, never midnight.
 *
 * A midnight-UTC date renders as the previous day everywhere west of UTC, so an assertion
 * on one passes in CI and fails on a laptop in Toronto.
 */
const task = (over: Record<string, unknown> = {}, report: Record<string, unknown> = {}) => ({
  taskId: over.taskId ?? '01924b1e-7c2a-7f3d-9c4e-000000000001',
  label: null,
  report: {
    id: '01924b1e-7c2a-7f3d-9c4e-5a6b7c8d9e0f',
    number: 'EXP-000001',
    title: 'Toronto client visit',
    status: 'SUBMITTED',
    totalMinor: '42550',
    submittedAt: new Date('2026-08-20T12:00:00.000Z'),
    currency: { code: 'CAD', symbol: '$' },
    submitter: { id: 'u-2', firstName: 'Ada', lastName: 'Lovelace', email: 'ada@e.inc' },
    ...report,
  },
  ...over,
});

/** The procedure's envelope: rows plus the queue's own aggregate. */
const payload = (items: unknown[], over: Record<string, unknown> = {}) => ({
  items,
  count: items.length,
  capped: false,
  cappedAt: 5000,
  homeCurrency: 'CAD',
  byCurrency: [],
  homeTotalMinor: '0',
  excludedCount: 0,
  ...over,
});

/** The card's header row in `SectionCard`: the `h2`'s block and whatever sits beside it. */
const headerOf = () => {
  const heading = screen.getByRole('heading', { level: 2 });
  return heading.closest('div')?.parentElement as HTMLElement;
};

beforeEach(() => {
  h.tasks = payload([task()]);
  h.isError = false;
  h.isPending = false;
  h.refetches = 0;
});

/** FILE-LEVEL, because the leak it cleans up crosses files: `vi.restoreAllMocks()` does not
 *  undo a `vi.stubGlobal`, so one phone test would leave a phone-shaped `matchMedia` behind
 *  for whatever the same worker picks up next. The `stubDevice` call itself is NOT file
 *  level — see the phone block below. */
afterEach(restorePointer);

describe('the reports-to-approve card', () => {
  it('draws a row per report waiting on the reader', () => {
    h.tasks = payload([
      task({ taskId: 't1' }, { id: 'r1', number: 'EXP-000001', title: 'Toronto client visit' }),
      task({ taskId: 't2' }, { id: 'r2', number: 'EXP-000002', title: 'Vendor summit' }),
    ]);
    render(<ReportsToApproveCard />);
    expect(screen.getAllByRole('row')).toHaveLength(3); // header + 2
    expect(screen.getByRole('link', { name: /Toronto client visit/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Vendor summit/ })).toBeInTheDocument();
  });

  it('names the submitter, because every row is somebody else’s report', () => {
    h.tasks = payload([
      task(
        {},
        { submitter: { id: 'u-2', firstName: 'Ada', lastName: 'Lovelace', email: 'a@e.inc' } },
      ),
    ]);
    render(<ReportsToApproveCard />);
    expect(screen.getByText('Ada Lovelace')).toBeInTheDocument();
  });

  it('prints the ISO code on every total', () => {
    /** Five rows from five submitters is the NORMAL case here, so two currencies under one
     *  `$` is the normal failure (F54) rather than the edge one. */
    h.tasks = payload([
      task(
        { taskId: 't1' },
        { id: 'r1', totalMinor: '42550', currency: { code: 'CAD', symbol: '$' } },
      ),
      task(
        { taskId: 't2' },
        { id: 'r2', totalMinor: '10000', currency: { code: 'USD', symbol: '$' } },
      ),
    ]);
    render(<ReportsToApproveCard />);
    expect(screen.getByText('CAD 425.50')).toBeInTheDocument();
    expect(screen.getByText('USD 100.00')).toBeInTheDocument();
  });

  // ── The queue: deduped, and ordered on purpose ──────────────────────────────

  it('shows one row for a report the reader holds two pending tasks on', () => {
    /**
     * THE ONE THAT MATTERS. A parallel gate legitimately gives the reader two decidable
     * tasks on one report, and the inbox is right to render both — two decisions, two
     * sets of buttons. This card's row is a LINK TO A REPORT, so the same report twice is
     * the same link twice. The dedupe is here rather than in `myTasks`, which the inbox
     * shares: narrowing the procedure would fix the card by breaking the inbox.
     */
    h.tasks = payload([
      task({ taskId: 't1' }, { id: 'r1', number: 'EXP-000001' }),
      task({ taskId: 't2' }, { id: 'r1', number: 'EXP-000001' }),
      task({ taskId: 't3' }, { id: 'r2', number: 'EXP-000002' }),
    ]);
    render(<ReportsToApproveCard />);
    expect(screen.getAllByRole('row')).toHaveLength(3); // header + 2 REPORTS, not 3 tasks
    expect(screen.getAllByRole('link', { name: /EXP-000001/ })).toHaveLength(1);
  });

  it('orders by submittedAt, oldest first — not by the order the procedure concatenated', () => {
    /**
     * `myTasks` returns `assigned` then `claimable` and orders only WITHIN each half, so
     * arrival order is an accident of that concatenation. The card states its own order:
     * longest wait at the top, which is the approver's actual question. The fixture is
     * deliberately in the wrong order to begin with.
     */
    h.tasks = payload([
      task(
        { taskId: 't1' },
        { id: 'r1', number: 'EXP-NEW', submittedAt: new Date('2026-08-28T12:00:00.000Z') },
      ),
      task(
        { taskId: 't2' },
        { id: 'r2', number: 'EXP-OLD', submittedAt: new Date('2026-07-02T12:00:00.000Z') },
      ),
      task(
        { taskId: 't3' },
        { id: 'r3', number: 'EXP-MID', submittedAt: new Date('2026-08-11T12:00:00.000Z') },
      ),
    ]);
    render(<ReportsToApproveCard />);
    const links = screen.getAllByRole('link');
    expect(links[0]).toHaveTextContent('EXP-OLD');
    expect(links[1]).toHaveTextContent('EXP-MID');
    expect(links[2]).toHaveTextContent('EXP-NEW');
  });

  it('sorts a report with no submission date LAST, and renders it without inventing one', () => {
    /** It cannot be ranked by how long it has waited; guessing it is the oldest would push
     *  it above reports that genuinely are. */
    h.tasks = payload([
      task({ taskId: 't1' }, { id: 'r1', number: 'EXP-NODATE', submittedAt: null }),
      task(
        { taskId: 't2' },
        { id: 'r2', number: 'EXP-DATED', submittedAt: new Date('2026-08-11T12:00:00.000Z') },
      ),
    ]);
    render(<ReportsToApproveCard />);
    const links = screen.getAllByRole('link');
    expect(links[0]).toHaveTextContent('EXP-DATED');
    expect(links[1]).toHaveTextContent('EXP-NODATE');
    const row = screen.getByRole('link', { name: /EXP-NODATE/ }).closest('tr') as HTMLElement;
    expect(within(row).getByText('—')).toBeInTheDocument();
  });

  it('draws at most five rows', () => {
    h.tasks = payload(
      Array.from({ length: 9 }, (_, i) =>
        task(
          { taskId: `t${i}` },
          {
            id: `r${i}`,
            number: `EXP-00000${i}`,
            submittedAt: new Date(`2026-08-0${i + 1}T12:00:00.000Z`),
          },
        ),
      ),
    );
    render(<ReportsToApproveCard />);
    expect(screen.getAllByRole('row')).toHaveLength(6); // header + 5
    // The five OLDEST, because the order is the card's own decision and the preview is
    // the top of it: the ninth-newest is not on screen.
    expect(screen.queryByText('EXP-000008')).not.toBeInTheDocument();
  });

  // ── The row target ──────────────────────────────────────────────────────────

  it('links each row into the inbox’s deep link, named after its report', () => {
    /** `/expenses/approvals?report=<id>` is the param `ExpenseApprovalsInbox` already
     *  reads through `useDeepLink('report')`, so the row opens the review drawer without
     *  this card importing a byte of it. Five links all reading "View" would be a screen
     *  reader being told nothing five times, so the anchor wraps title AND number. */
    h.tasks = payload([
      task({ taskId: 't1' }, { id: 'r1', number: 'EXP-000001', title: 'Client visit' }),
      task({ taskId: 't2' }, { id: 'r2', number: 'EXP-000002', title: 'Client visit' }),
    ]);
    render(<ReportsToApproveCard />);
    // `\s*` rather than a literal space: the two lines are separate text nodes and jsdom,
    // which does no layout, joins them without one.
    expect(screen.getByRole('link', { name: /Client visit\s*EXP-000001/ })).toHaveAttribute(
      'href',
      '/expenses/approvals?report=r1',
    );
    expect(screen.getByRole('link', { name: /Client visit\s*EXP-000002/ })).toHaveAttribute(
      'href',
      '/expenses/approvals?report=r2',
    );
  });

  it('reaches the row link by keyboard and follows it on Enter', async () => {
    /**
     * The whole reason no card passes `onRowClick`: that handler sits on a `<tr>` with no
     * `tabIndex`, no `onKeyDown` and no `role`, so the row is unreachable by keyboard —
     * WCAG 2.1.1. This asserts the replacement actually works, so the prohibition is
     * enforced by a test rather than only by a comment and an ADR.
     */
    const user = userEvent.setup();
    const activated: string[] = [];
    document.addEventListener('click', (e) => {
      const a = (e.target as HTMLElement).closest('a');
      if (a) activated.push(a.getAttribute('href') ?? '');
    });
    render(<ReportsToApproveCard />);

    /** The stops in front of the anchor are `ColumnHeader`'s `aria-disabled` label
     *  buttons, one per column — a pre-existing wart of the shared header, not this
     *  card's to fix. What matters is that the row's target IS reachable. */
    for (let i = 0; i < 12 && document.activeElement?.tagName !== 'A'; i += 1) {
      await user.tab();
    }
    expect(document.activeElement).toBe(screen.getByRole('link', { name: /EXP-000001/ }));

    await user.keyboard('{Enter}');
    expect(activated).toContain('/expenses/approvals?report=01924b1e-7c2a-7f3d-9c4e-5a6b7c8d9e0f');
  });

  it('puts nothing clickable on the row itself', async () => {
    /** The negative half of the rule. A `<tr>` that navigates is a target the keyboard
     *  cannot reach and the pointer cursor lies about, so the row outside the anchor does
     *  nothing at all: clicking the submitter's name is a click on text. */
    const user = userEvent.setup();
    const activated: string[] = [];
    document.addEventListener('click', (e) => {
      const a = (e.target as HTMLElement).closest('a');
      if (a) activated.push(a.getAttribute('href') ?? '');
    });
    render(<ReportsToApproveCard />);

    const row = screen.getByRole('link', { name: /EXP-000001/ }).closest('tr') as HTMLElement;
    expect(row).not.toHaveAttribute('tabindex');
    expect(row.className).not.toMatch(/cursor-pointer/);

    await user.click(within(row).getByText('Ada Lovelace'));
    expect(activated).toEqual([]);
  });

  // ── The header: a count, and never a total ──────────────────────────────────

  it('counts REPORTS, matching the rows beneath it rather than the task list', () => {
    /** `data.count` counts TASKS over the same materialized array — neither number is
     *  more accurate, but only one of them agrees with a list of reports. */
    h.tasks = payload(
      [
        task({ taskId: 't1' }, { id: 'r1' }),
        task({ taskId: 't2' }, { id: 'r1' }),
        task({ taskId: 't3' }, { id: 'r2' }),
      ],
      { count: 3 },
    );
    render(<ReportsToApproveCard />);
    expect(screen.getByText('dashboard.cards.approvals.count:2')).toBeInTheDocument();
    expect(screen.queryByText('dashboard.cards.approvals.count:3')).not.toBeInTheDocument();
  });

  it('calls the count a FLOOR when the server capped the pool', () => {
    /** `myTasks` materializes at most `APPROVAL_POOL_CAP` tasks per pool and says so. A
     *  truncated number presented as the answer is a wrong number stated confidently. */
    h.tasks = payload([task()], { capped: true, cappedAt: 5000 });
    render(<ReportsToApproveCard />);
    expect(screen.getByText('dashboard.cards.approvals.countCapped:1')).toBeInTheDocument();
    expect(screen.queryByText('dashboard.cards.approvals.count:1')).not.toBeInTheDocument();
  });

  it('NEVER puts money in the header, whatever the queue is worth', () => {
    /**
     * NON-NEGOTIABLE, and the reason this assertion is on the header element rather than
     * on a particular string. `myTasks` hands the card a home-currency rollup and both
     * sibling cards render theirs — this one must not. It is the highest-stakes figure on
     * the page ("how much is waiting on my signature"), its rows routinely span several
     * submitters' currencies (F54), and the "dominant + excluded" fallback the other cards
     * use understates a LIABILITY. Counting is the only claim that is true in every mix.
     */
    h.tasks = payload(
      [
        task(
          { taskId: 't1' },
          { id: 'r1', totalMinor: '42550', currency: { code: 'CAD', symbol: '$' } },
        ),
        task(
          { taskId: 't2' },
          { id: 'r2', totalMinor: '900000', currency: { code: 'USD', symbol: '$' } },
        ),
      ],
      { homeTotalMinor: '1242550', byCurrency: [{ code: 'CAD' }, { code: 'USD' }] },
    );
    render(<ReportsToApproveCard />);
    const header = headerOf();
    expect(header).toHaveTextContent('dashboard.cards.approvals.count:2');
    expect(header.textContent ?? '').not.toMatch(/\d[.,]\d\d/); // no minor units
    expect(header.textContent ?? '').not.toMatch(/CAD|USD|\$/);
    // The per-row figures are untouched: one report in one currency is a safe claim.
    expect(screen.getByText('CAD 425.50')).toBeInTheDocument();
  });

  // ── The other faces ─────────────────────────────────────────────────────────

  it('still draws a CARD for an approver with nothing pending', () => {
    /**
     * THE EMPTY CARD, NOT THE ABSENT ONE. An absent card is indistinguishable from absent
     * permission, a failed query, or a bug — an approver used to three cards who sees two
     * concludes the page is broken, not that they are caught up. And no call to action:
     * there is nothing to do about being finished, so "View all" is passed from the
     * non-empty branch only rather than linking into a queue just declared empty.
     */
    h.tasks = payload([]);
    render(<ReportsToApproveCard />);
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(
      'dashboard.cards.approvals.title',
    );
    expect(screen.getByText('dashboard.cards.approvals.empty')).toBeInTheDocument();
    expect(screen.getByText('dashboard.cards.approvals.emptyHint')).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    // And no count badge: "0 reports" beside "nothing is waiting on you" says it twice.
    expect(screen.queryByText(/approvals\.count/)).not.toBeInTheDocument();
  });

  it('pins the view-all link at the 44px floor rather than leaving it to the padding', () => {
    /**
     * NOT A VIOLATION TODAY, AND THAT IS THE WHOLE REASON TO ASSERT IT. `py-3` on `text-sm`
     * computes to exactly 44px, so this link meets WCAG 2.2 SC 2.5.5 by coincidence of two
     * values that neither mention it. `min-h-11` states the floor, so a later type-scale or
     * padding change has something to break against.
     *
     * It would otherwise break SILENTLY rather than loudly, which is the part that makes a
     * class worth spending: `e2e/tap-targets.mobile.spec.ts` only measures controls that
     * declare a floor — with no slop class there is no `::after` to read, `floored.vertical`
     * is `false`, and its floor lane skips the control. A drift under 44px here would be
     * reported by nothing at all.
     *
     * ASSERTED ON THE CLASS, the same way `page.test.tsx` asserts the identity band's
     * `border-white/40`: jsdom applies no stylesheet, so nothing here can measure a height.
     * The class IS the claim, and `e2e/crawl-mobile.spec.ts` sees the consequence.
     *
     * PINNED ON ALL THREE CARDS rather than once on a sibling, which is the exception to
     * this file's rule of leaning on `MyExpenseReportsCard.test.tsx` for the shared shape.
     * The three footers are three separate class-string literals with no shared constant
     * between them, so a test on one card says nothing whatsoever about the other two.
     */
    render(<ReportsToApproveCard />);
    const viewAll = screen.getByRole('link', { name: 'dashboard.cards.approvals.viewAll' });
    expect(viewAll).toHaveClass('min-h-11');
    // Beside `py-3`, never instead of it: `min-height` only raises the used height, so
    // dropping the padding would shrink what is drawn while leaving this green.
    expect(viewAll).toHaveClass('py-3');
  });

  it('shows a skeleton, and never a zero, while the query is in flight', () => {
    h.isPending = true;
    h.tasks = undefined;
    render(<ReportsToApproveCard />);
    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-busy', 'true');
    expect(status).toHaveTextContent('dashboard.cards.approvals.loading');
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.queryByText(/approvals\.count:0/)).not.toBeInTheDocument();
    expect(screen.queryByText('dashboard.cards.approvals.empty')).not.toBeInTheDocument();
  });

  it('says the section failed — not that the reader is caught up — and offers a retry', async () => {
    /** The dangerous confusion on THIS card specifically: an error rendered as the empty
     *  state tells an approver their queue is clear when it may be full. */
    const user = userEvent.setup();
    h.isError = true;
    render(<ReportsToApproveCard />);
    expect(screen.getByText('common.panelUnavailable')).toBeInTheDocument();
    expect(screen.queryByText('dashboard.cards.approvals.empty')).not.toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(headerOf().textContent ?? '').not.toMatch(/approvals\.count/);

    await user.click(screen.getByRole('button', { name: 'common.retry' }));
    expect(h.refetches).toBe(1);
  });
});

/**
 * The same queue below the compact breakpoint, where the card list replaces the table.
 *
 * `layout` is not passed by the card, so the real gate is exercised — the card tree is
 * reached because `MOBILE.title` is named, not because a test forced it. No new i18n key:
 * each field row's `<dt>` is the column's own already-translated `label`.
 */
describe('the reports-to-approve card on a phone', () => {
  /** In THIS block's own `beforeEach`, never at file level. A file-level stub would convert
   *  every desktop assertion above into a phone one without changing a line of them, and the
   *  suite would stay green while measuring something nobody wrote it to measure. */
  beforeEach(() => stubDevice('phone'));

  it('replaces the table with one card per queued report', () => {
    h.tasks = payload([
      task({ taskId: 't1' }, { id: 'r1', number: 'EXP-000001', title: 'Toronto client visit' }),
      task({ taskId: 't2' }, { id: 'r2', number: 'EXP-000002', title: 'Ottawa summit' }),
    ]);
    render(<ReportsToApproveCard />);

    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(
      screen.getByRole('listitem', { name: /Toronto client visit\s*EXP-000001/ }),
    ).toBeInTheDocument();
  });

  it('names the submitter under the title, and prints the money as a field and not a badge', () => {
    /**
     * THE SLOT ASSIGNMENT IS THE DECISION THIS TEST EXISTS FOR, and it is the one a future
     * reader is most likely to want to reverse.
     *
     *   · the submitter is the SUBTITLE — an attribution under the report's name, which is
     *     how the inbox already reads it; as a `<dt>`/`<dd>` pair it would be one more
     *     labelled row competing with the money;
     *   · the card has NO BADGE AT ALL. There is no status column to put in it (every row in
     *     a pending queue is awaiting the reader, so five identical pills are noise), and the
     *     money is not a substitute: a badge is where a reader looks for STATE. Putting the
     *     highest-stakes figure on the page in the loudest slot on the card, in a list that
     *     routinely holds several submitters' currencies, is how F54 comes back.
     *
     * The header count is untouched by any of this and is deliberately NOT in scope of the
     * query below — `within(card)` is what keeps the two apart.
     */
    render(<ReportsToApproveCard />);
    const card = screen.getByRole('listitem', { name: /Toronto client visit\s*EXP-000001/ });

    expect(card.querySelector('[data-dt-card-slot="subtitle"]')).toHaveTextContent('Ada Lovelace');
    expect(card.querySelector('[data-dt-card-slot="badge"]')).toBeNull();

    expect([...card.querySelectorAll('dt')].map((n) => n.textContent)).toEqual([
      'expenses.columns.total',
      'expenses.approvals.submitted',
    ]);
    // NBSP → space: `Intl` separates the ISO code from the number with U+00A0, and reading
    // `textContent` bypasses the whitespace normalisation Testing Library's text queries do.
    const values = [...card.querySelectorAll('dd')].map((n) =>
      n.textContent?.replace(/\u00a0/g, ' '),
    );
    expect(values).toEqual(['CAD 425.50', 'Aug 20, 2026']);
  });

  it('keeps the row link as the card title, with no row-open button around it', () => {
    /** No `onRowClick` on a card either — the frame's `onRowClick` arm wraps the title slot
     *  in a `<button>`, and the column's `<a>` nested in one is two controls fighting for a
     *  single tap. Without the handler the anchor IS the card's floored tap target, and it
     *  still points at the deep link the inbox reads. */
    render(<ReportsToApproveCard />);
    const card = screen.getByRole('listitem', { name: /EXP-000001/ });

    expect(within(card).getByRole('link')).toHaveAttribute(
      'href',
      '/expenses/approvals?report=01924b1e-7c2a-7f3d-9c4e-5a6b7c8d9e0f',
    );
    expect(within(card).queryByRole('button')).toBeNull();
  });
});
