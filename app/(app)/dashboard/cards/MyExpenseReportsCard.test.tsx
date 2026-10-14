import '@testing-library/jest-dom/vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { restorePointer, stubDevice } from '@/test-utils/pointer';

/**
 * "My expense reports" — the reader's five most recent reports on the landing page.
 *
 * Four things here are worth more than the rendering itself:
 *
 *   1. THE COLUMN ORDER IS ASSERTED, because nothing else in the product asserts one. The
 *      card hands `createDataTableState` a synthetic array built from `COLUMN_ORDER` and
 *      never the real `columns`, so the two can silently disagree and only `COLUMN_ORDER`
 *      reaches the screen. Reading the header row back is the only way to know which of
 *      them the reader actually got.
 *   2. THE ROW TARGET IS A REAL LINK. `DataTable`'s `onRowClick` puts a click handler on a
 *      `<tr>` with no `tabIndex`, no `onKeyDown` and no `role` — unreachable by keyboard.
 *      The keyboard case below is what keeps the prohibition enforced by a test rather than
 *      by a comment.
 *   3. EVERY ROW LINK IS NAMED AFTER ITS ROW. Five links all called "View" is a screen
 *      reader hearing the same word five times.
 *   4. THE FOOTER IS ABSENT WHEN THE SECTION IS EMPTY. A "view all" under "no reports"
 *      points at a listing the reader was just told is empty.
 *
 * THERE IS NO HEADER BADGE TO TEST, AND ITS ABSENCE IS DELIBERATE. The count-and-total
 * badge that used to sit beside the title, and the `expenses.summaryOwn` query behind it,
 * are both gone from this card — see the component's docstring for the rule and for why
 * the approvals card kept its own badge. The procedure itself is NOT deleted and has no UI
 * caller by design; `landingAggregates.db.test.ts` is what covers it now.
 */

const h: {
  reports: unknown;
  reportsError: boolean;
  reportsPending: boolean;
  refetches: number;
} = {
  reports: [],
  reportsError: false,
  reportsPending: false,
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
    expenses: {
      list: {
        useQuery: () => ({
          data: h.reports,
          isError: h.reportsError,
          isPending: h.reportsPending,
          refetch: () => {
            h.refetches += 1;
          },
        }),
      },
    },
  },
}));

const { MyExpenseReportsCard } = await import('./MyExpenseReportsCard');

/**
 * `updatedAt` is pinned to NOON UTC, never midnight.
 *
 * A midnight-UTC timestamp renders as the previous day everywhere west of UTC, so a date
 * assertion on one would pass in CI and fail on a laptop in Toronto. Noon is the same
 * calendar day in every timezone this product runs in.
 */
const report = (over: Record<string, unknown> = {}) => ({
  id: 'r1',
  number: 'EXP-0001',
  title: 'Client visit, Montréal',
  status: 'SUBMITTED',
  currency: { code: 'CAD', symbol: '$' },
  totalMinor: '125000',
  homeCurrency: 'CAD',
  homeTotalMinor: '125000' as string | null,
  expenseCount: 3,
  updatedAt: new Date('2026-03-04T12:00:00.000Z'),
  ...over,
});

beforeEach(() => {
  h.reports = [report()];
  h.reportsError = false;
  h.reportsPending = false;
  h.refetches = 0;
});

/**
 * FILE-LEVEL, and it has to be — unlike the `stubDevice` call itself, which does not.
 *
 * `vi.restoreAllMocks()` does not undo a `vi.stubGlobal`, so one phone test leaves a
 * phone-shaped `matchMedia` behind for every test the same worker picks up next, in this
 * file and in whatever file runs after it. That leak crosses files; a path-filtered run
 * cannot reproduce the failure it causes. The stub is scoped to the phone block below
 * precisely because the opposite mistake — stubbing at file level — would silently convert
 * every desktop assertion above into a phone one and leave the suite green while measuring
 * something nobody wrote it to measure.
 */
afterEach(restorePointer);

describe('the my-expense-reports card', () => {
  it('draws its columns in COLUMN_ORDER, with Status LAST', () => {
    /**
     * THE ONLY ASSERTION IN THE PRODUCT ON A COLUMN ORDER, and the card is the reason it
     * has to exist. `createDataTableState` takes `columnOrder` from the array it is handed,
     * and this card hands it `COLUMN_ORDER.map((id) => ({ id }))` — the real `columns`
     * array never reaches it. So the two lists can drift apart in either direction and
     * nothing but the rendered header row says which one the reader got.
     *
     * Status LAST, matching `MyTravelRequestsCard`'s `destination · dates · budget ·
     * status`: the two "my things" cards stack on the landing page and a reader scanning
     * down them should find the same kind of column in the same place on both. Reordering
     * `columns` without reordering `COLUMN_ORDER` leaves this green ONLY because the
     * assertion reads the DOM rather than either array.
     *
     * Accessible names, not text content — the header cell's name is what a screen-reader
     * user hears announced for every cell in the column beneath it.
     */
    render(<MyExpenseReportsCard />);
    const headers = screen.getAllByRole('columnheader');
    expect(headers).toHaveLength(4);
    for (const [i, name] of [
      'expenses.columns.report',
      'expenses.columns.total',
      'expenses.columns.updated',
      'expenses.columns.status',
    ].entries()) {
      expect(headers[i]).toHaveAccessibleName(name);
    }
  });

  it('draws a row per report, newest first, in the order the server sent', () => {
    h.reports = [
      report({ id: 'r1', number: 'EXP-0001', title: 'Bravo' }),
      report({ id: 'r2', number: 'EXP-0002', title: 'Alpha' }),
    ];
    render(<MyExpenseReportsCard />);
    const links = screen.getAllByRole('link');
    // `sortMode="external"` — the server ordered by updatedAt desc and the table must not
    // re-sort. Alphabetical would put "Alpha" first.
    expect(links[0]).toHaveTextContent('Bravo');
    expect(links[1]).toHaveTextContent('Alpha');
  });

  it('draws at most five rows', () => {
    h.reports = Array.from({ length: 8 }, (_, i) =>
      report({ id: `r${i}`, number: `EXP-000${i}`, title: `Report ${i}` }),
    );
    render(<MyExpenseReportsCard />);
    expect(screen.getAllByRole('row')).toHaveLength(6); // header + 5
  });

  it('gives every row link an accessible name that identifies its report', () => {
    /** Five links all reading "View" is a screen reader being told nothing five times. The
     *  anchor wraps the title AND the number, so each name is unique by construction. */
    h.reports = [
      report({ id: 'r1', number: 'EXP-0001', title: 'Client visit' }),
      report({ id: 'r2', number: 'EXP-0002', title: 'Client visit' }),
    ];
    render(<MyExpenseReportsCard />);
    // `\s*` rather than a literal space: the two lines are separate text nodes and jsdom,
    // which does no layout, joins them without one. What matters is that the name carries
    // BOTH the title and the number, so the two rows are distinguishable by name alone.
    expect(screen.getByRole('link', { name: /Client visit\s*EXP-0001/ })).toHaveAttribute(
      'href',
      '/expenses/r1',
    );
    expect(screen.getByRole('link', { name: /Client visit\s*EXP-0002/ })).toHaveAttribute(
      'href',
      '/expenses/r2',
    );
  });

  it('reaches the row link by keyboard and follows it on Enter', async () => {
    /**
     * The whole reason no card passes `onRowClick`. `DataTable` puts that handler on the
     * `<tr>` with no `tabIndex`, no `onKeyDown` and no `role`, so the row is unreachable by
     * keyboard — a WCAG 2.1.1 failure. This asserts the replacement actually works, so the
     * prohibition is enforced by a test and not only by a comment.
     */
    const user = userEvent.setup();
    const activated: string[] = [];
    document.addEventListener('click', (e) => {
      const a = (e.target as HTMLElement).closest('a');
      if (a) activated.push(a.getAttribute('href') ?? '');
    });
    render(<MyExpenseReportsCard />);

    /**
     * Tab forward until focus lands on an anchor. The stops in front of it are
     * `ColumnHeader`'s label buttons — one per column, `aria-disabled`, focusable on every
     * DataTable in the product. That is a pre-existing wart of the shared header and not
     * this card's to fix; what this asserts is that the row's target IS reachable, which
     * `onRowClick` on a bare `<tr>` never was.
     */
    for (let i = 0; i < 12 && document.activeElement?.tagName !== 'A'; i += 1) {
      await user.tab();
    }
    expect(document.activeElement).toBe(screen.getByRole('link', { name: /EXP-0001/ }));

    await user.keyboard('{Enter}');
    expect(activated).toContain('/expenses/r1');
  });

  it('puts NO badge beside the title — no count, no total, in any state', () => {
    /**
     * The rule, asserted rather than left to the absence of a test. This card's header is
     * its title and nothing else; `ReportsToApproveCard` is the only card on the page that
     * still carries a badge, because its count is an obligation rather than a summary of
     * the listing underneath it. See the component docstring, and D8 in the dashboard ADR.
     *
     * Asserted STRUCTURALLY, on `SectionCard`'s header bar, rather than by querying for the
     * four messages that were just deleted from the catalog. A "no such text" assertion
     * against deleted keys passes forever whatever gets added back; the header bar holding
     * exactly one child — the heading's wrapper — fails the moment anything is passed to
     * `headerRight` again, whatever it says.
     */
    h.reports = Array.from({ length: 5 }, (_, i) => report({ id: `r${i}` }));
    render(<MyExpenseReportsCard />);
    const heading = screen.getByRole('heading', { level: 2 });
    expect(heading).toHaveTextContent('dashboard.cards.expenses.title');
    const headerBar = heading.parentElement?.parentElement;
    expect(headerBar?.childElementCount).toBe(1);
  });

  it('renders a report with no expenses and a zero total rather than filtering it out', () => {
    /** A RETURNED report emptied of its lines is exactly this shape, and it is the row the
     *  reader most needs to see: it is theirs, it is open, and it is worth nothing yet. */
    h.reports = [
      report({ status: 'RETURNED', totalMinor: '0', homeTotalMinor: '0', expenseCount: 0 }),
    ];
    render(<MyExpenseReportsCard />);
    const row = screen.getByRole('link', { name: /EXP-0001/ }).closest('tr');
    expect(row).not.toBeNull();
    expect(within(row as HTMLElement).getByText('CAD 0.00')).toBeInTheDocument();
  });

  it('shows the empty face and NO footer when there is nothing to preview', () => {
    /** THE TRAP. "View all" under "no reports" links the reader into a listing they have
     *  just been told is empty. The footer is passed from the non-empty branch only. */
    h.reports = [];
    render(<MyExpenseReportsCard />);
    expect(screen.getByText('dashboard.cards.expenses.empty')).toBeInTheDocument();
    expect(screen.getByText('dashboard.cards.expenses.emptyHint')).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
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
     */
    render(<MyExpenseReportsCard />);
    const viewAll = screen.getByRole('link', { name: 'dashboard.cards.expenses.viewAll' });
    expect(viewAll).toHaveClass('min-h-11');
    // Beside `py-3`, never instead of it: `min-height` only raises the used height, so
    // dropping the padding would shrink what is drawn while leaving this green.
    expect(viewAll).toHaveClass('py-3');
  });

  it('shows a skeleton, and never an empty face, while the rows are in flight', () => {
    /**
     * ONE QUERY DECIDES THIS NOW. While the header badge read a second query, `pending` was
     * the OR of both, so the skeleton stayed up until the SLOWER of the two resolved. The
     * rows are the whole card, so the skeleton clears when they arrive.
     */
    h.reportsPending = true;
    h.reports = undefined;
    render(<MyExpenseReportsCard />);
    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-busy', 'true');
    expect(status).toHaveTextContent('dashboard.cards.expenses.loading');
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.queryByText('dashboard.cards.expenses.empty')).not.toBeInTheDocument();
  });

  it('says the section failed — not that it is empty — and offers a retry', async () => {
    /**
     * THE ROWS ARE THE ONLY THING THAT CAN FAIL THE CARD, which is a narrowing. Until the
     * header badge came off, an `expenses.summaryOwn` that failed on its own replaced a
     * perfectly good set of rows with this panel; there is no longer a second query that
     * can blank a card whose rows arrived intact.
     */
    const user = userEvent.setup();
    h.reportsError = true;
    render(<MyExpenseReportsCard />);
    expect(screen.getByText('common.panelUnavailable')).toBeInTheDocument();
    expect(screen.queryByText('dashboard.cards.expenses.empty')).not.toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'common.retry' }));
    // One query, one refetch — and no second refetch to fire at a query nothing reads.
    expect(h.refetches).toBe(1);
  });
});

/**
 * The same five rows below the compact breakpoint, where the table is off-screen and the
 * card list takes its place.
 *
 * `layout` IS NOT PASSED by the card, so these tests exercise the real gate —
 * `layout === 'auto' && isCompact && mobile.title !== undefined` (`DataTable.tsx:159-160`)
 * — rather than short-circuiting it with `layout="cards"`. A config that stopped naming a
 * title would silently keep rendering the table here, and that is exactly the regression
 * worth catching.
 *
 * Every assertion below is about a slot's CONTENT, never about a new string: the `<dt>`
 * term of each field row is the column's own `label`, already translated, so this phase
 * adds no i18n key in either locale.
 */
describe('the my-expense-reports card on a phone', () => {
  beforeEach(() => stubDevice('phone'));

  it('replaces the table with one card per report', () => {
    h.reports = [
      report({ id: 'r1', number: 'EXP-0001', title: 'Client visit' }),
      report({ id: 'r2', number: 'EXP-0002', title: 'Hotel, Quebec' }),
    ];
    render(<MyExpenseReportsCard />);

    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    // Named by the title slot alone (`aria-labelledby`), which is the report's own anchor —
    // not by everything inside the card, which would announce five values run together.
    expect(screen.getByRole('listitem', { name: /Client visit\s*EXP-0001/ })).toBeInTheDocument();
  });

  it('carries the total and the updated date as labelled rows, and the status as the badge', () => {
    /**
     * THE CARD IS THE SAME FOUR FACTS AS THE TABLE, redistributed — nothing is dropped on
     * the way down. The two `<dt>` terms are asserted as a LIST, in order, because that is
     * simultaneously the claim that the fields are `total` then `updated` and the claim
     * that each term is the column's existing translated label rather than a new key.
     *
     * The status is read off the badge slot specifically, not merely found somewhere in the
     * card: `badge` ignores column visibility where a field row does not, so which slot it
     * landed in is the whole point of configuring it as a badge.
     */
    render(<MyExpenseReportsCard />);
    const card = screen.getByRole('listitem', { name: /Client visit, Montréal\s*EXP-0001/ });

    expect([...card.querySelectorAll('dt')].map((n) => n.textContent)).toEqual([
      'expenses.columns.total',
      'expenses.columns.updated',
    ]);
    // NBSP → space. `Intl.NumberFormat` separates the ISO code from the number with U+00A0,
    // and reading `textContent` bypasses the whitespace normalisation Testing Library's own
    // text queries apply — so without this the failure message prints two identical strings.
    expect(
      [...card.querySelectorAll('dd')].map((n) => n.textContent?.replace(/\u00a0/g, ' ')),
    ).toEqual(['CAD 1,250.00', 'Mar 4, 2026']);
    expect(card.querySelector('[data-dt-card-slot="badge"]')).toHaveTextContent(
      'expenses.status.submitted',
    );
  });

  it('keeps the row link as the card title, with no row-open button around it', () => {
    /**
     * The prohibition on `onRowClick` survives the trip to a card, and it has to: the card
     * frame's `onRowClick` arm wraps the title slot in a `<button>`, and an `<a>` nested
     * inside a button is two controls fighting for one tap. Without the handler the frame
     * takes its other arm, where the column's own anchor IS the card's 44px tap target.
     */
    render(<MyExpenseReportsCard />);
    const card = screen.getByRole('listitem', { name: /EXP-0001/ });

    expect(within(card).getByRole('link')).toHaveAttribute('href', '/expenses/r1');
    expect(within(card).queryByRole('button')).toBeNull();
  });

  it('draws its cards without the dev scan reporting the title anchor', () => {
    /**
     * PINS PHASE 1 FROM THE CONSUMER SIDE, and it is the one assertion here that is about
     * all three cards rather than this one. `devWarnCards` scans the mounted card list and
     * warns about interactive content inside a slot, because a card slot is a value and not
     * a control. The title anchor is the exemption: it is the only way into the row, the
     * frame floors it at 44px, and warning about it would be telling the author to delete
     * the card's only navigation.
     *
     * A warning here is a finding, not noise to be suppressed at the card — it would mean
     * the exemption's four conditions stopped matching what these cards render.
     *
     * THE TABLE CHECK IS WHAT KEEPS THIS CASE FROM GOING HOLLOW. `devWarnCards` only runs
     * from the card tree, so if the phone stub ever stopped working and the TABLE mounted
     * instead, the scan would never run, the filter would find nothing and this case would
     * pass green while measuring the opposite of what it claims. Its siblings assert the
     * same thing for their own reasons; this one needs it to have a subject at all.
     */
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    render(<MyExpenseReportsCard />);

    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(warn.mock.calls.filter(([first]) => String(first).startsWith('[DataTable]'))).toEqual(
      [],
    );
    warn.mockRestore();
  });
});
