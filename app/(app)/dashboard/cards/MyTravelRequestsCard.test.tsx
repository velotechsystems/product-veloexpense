import '@testing-library/jest-dom/vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { restorePointer, stubDevice } from '@/test-utils/pointer';

/**
 * "My travel requests" — the reader's five most recent trips on the landing page.
 *
 * Its sibling `MyExpenseReportsCard.test.tsx` pins the shape both cards share (real row
 * links, footer absent when empty, skeleton never an empty face, no header badge).
 * Repeating all of that here would be noise, so what this file leans on is the part that is
 * TRAVEL'S: the budget a ROW prints. A travel request has no stored total — the figure is
 * `approvedTotalMinor` once an approver snapshots one and the sum of the budget lines until
 * then — and `travel/_shared.ts` owns that rule so this card and `/travel` cannot disagree
 * about what a trip costs.
 *
 * WHAT USED TO BE THE HEART OF THIS FILE WENT WITH THE HEADER BADGE. Six tests here pinned
 * the WORD on the header's money — *requested* when nothing in the set was approved,
 * *approved* when all of it was, *budget* for a mixture — plus the excluded-count caveat and
 * the count taken from the aggregate rather than the capped rows. The badge was removed
 * knowingly: the operator was asked about that exact disclosure and confirmed. With it went
 * the only figure on this card that summed across currencies, and every row still prints
 * its own currency with its ISO code, so nothing is left for a caveat to qualify. Do not
 * reinstate a word-on-the-money test without reinstating the badge; see the component
 * docstring and D8 in the dashboard ADR.
 *
 * And the row target is a real `<a>` to `/travel?request=<id>`, never `onRowClick`:
 * `DataTable` puts that handler on a `<tr>` with no `tabIndex`, no `onKeyDown` and no
 * `role`, which no keyboard can reach.
 */

const h: {
  requests: unknown;
  requestsError: boolean;
  requestsPending: boolean;
  refetches: number;
} = {
  requests: { items: [] },
  requestsError: false,
  requestsPending: false,
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
    travelRequests: {
      listOwn: {
        useQuery: () => ({
          data: h.requests,
          isError: h.requestsError,
          isPending: h.requestsPending,
          refetch: () => {
            h.refetches += 1;
          },
        }),
      },
    },
  },
}));

const { MyTravelRequestsCard } = await import('./MyTravelRequestsCard');

/**
 * Dates are pinned to NOON UTC, never midnight.
 *
 * A midnight-UTC date renders as the previous day everywhere west of UTC, so an assertion
 * on one passes in CI and fails on a laptop in Toronto. The card formats in UTC for the
 * same reason the list page does, but the fixture should not depend on that being right.
 */
const request = (over: Record<string, unknown> = {}) => ({
  id: '01924b1e-7c2a-7f3d-9c4e-5a6b7c8d9e0f',
  number: 'TRV-000001',
  status: 'SUBMITTED',
  destinationLabel: 'Montréal, QC, Canada',
  departDate: new Date('2026-09-01T12:00:00.000Z'),
  returnDate: new Date('2026-09-04T12:00:00.000Z'),
  approvedTotalMinor: null as bigint | null,
  budgetLines: [{ id: 'l1', amountMinor: 30000n }],
  currency: { code: 'CAD', symbol: '$' },
  ...over,
});

beforeEach(() => {
  h.requests = { items: [request()] };
  h.requestsError = false;
  h.requestsPending = false;
  h.refetches = 0;
});

/** FILE-LEVEL, because the leak it cleans up crosses files: `vi.restoreAllMocks()` does not
 *  undo a `vi.stubGlobal`, so one phone test would leave a phone-shaped `matchMedia` behind
 *  for whatever the same worker picks up next. The `stubDevice` call itself is NOT file
 *  level — see the phone block below. */
afterEach(restorePointer);

describe('the my-travel-requests card', () => {
  it('draws its columns in COLUMN_ORDER, with Status LAST', () => {
    /**
     * GUARDED HERE AS WELL AS ON THE SIBLING CARD, and not merely for symmetry: this order
     * is the one `MyExpenseReportsCard` was reordered to MATCH. The two cards stack on the
     * landing page, so a silent change here un-aligns a pair that was deliberately aligned,
     * and the assertion on the other card would stay green while it happened.
     *
     * The mechanism is the same trap too: `createDataTableState` gets
     * `COLUMN_ORDER.map((id) => ({ id }))` and never the real `columns` array, so only the
     * rendered header row says which of the two lists the reader actually got.
     */
    render(<MyTravelRequestsCard />);
    const headers = screen.getAllByRole('columnheader');
    expect(headers).toHaveLength(4);
    for (const [i, name] of [
      'travel.columns.destination',
      'travel.columns.dates',
      'travel.columns.budget',
      'travel.columns.status',
    ].entries()) {
      expect(headers[i]).toHaveAccessibleName(name);
    }
  });

  it('puts NO badge beside the title — no count, no money, in any state', () => {
    /**
     * Asserted structurally on `SectionCard`'s header bar rather than by querying for the
     * eight messages just deleted from the catalog: a "no such text" assertion against
     * deleted keys passes forever whatever comes back. One child — the heading's wrapper —
     * fails the moment anything is passed to `headerRight` again, whatever it says.
     */
    h.requests = { items: Array.from({ length: 5 }, (_, i) => request({ id: `r${i}` })) };
    render(<MyTravelRequestsCard />);
    const heading = screen.getByRole('heading', { level: 2 });
    expect(heading).toHaveTextContent('dashboard.cards.travel.title');
    expect(heading.parentElement?.parentElement?.childElementCount).toBe(1);
  });

  it('draws a row per request, in the order the server sent', () => {
    h.requests = {
      items: [
        request({ id: 'r1', number: 'TRV-000001', destinationLabel: 'Vancouver' }),
        request({ id: 'r2', number: 'TRV-000002', destinationLabel: 'Halifax' }),
      ],
    };
    render(<MyTravelRequestsCard />);
    const links = screen.getAllByRole('link');
    // `sortMode="external"` — the server ordered by `createdAt desc` and the table must
    // not re-sort. Alphabetical would put Halifax first.
    expect(links[0]).toHaveTextContent('Vancouver');
    expect(links[1]).toHaveTextContent('Halifax');
  });

  it('draws at most five rows', () => {
    h.requests = {
      items: Array.from({ length: 9 }, (_, i) =>
        request({ id: `r${i}`, number: `TRV-00000${i}`, destinationLabel: `City ${i}` }),
      ),
    };
    render(<MyTravelRequestsCard />);
    expect(screen.getAllByRole('row')).toHaveLength(6); // header + 5
  });

  it('links each row to the trip, and names the link after its destination', () => {
    /** Five links all reading "View" is a screen reader being told nothing five times.
     *  The anchor wraps the destination AND the number, so two trips to the same city are
     *  still distinguishable by name alone. */
    h.requests = {
      items: [
        request({ id: 'r1', number: 'TRV-000001', destinationLabel: 'Montréal' }),
        request({ id: 'r2', number: 'TRV-000002', destinationLabel: 'Montréal' }),
      ],
    };
    render(<MyTravelRequestsCard />);
    // `\s*` rather than a literal space: the two lines are separate text nodes and jsdom,
    // which does no layout, joins them without one.
    expect(screen.getByRole('link', { name: /Montréal\s*TRV-000001/ })).toHaveAttribute(
      'href',
      '/travel?request=r1',
    );
    expect(screen.getByRole('link', { name: /Montréal\s*TRV-000002/ })).toHaveAttribute(
      'href',
      '/travel?request=r2',
    );
  });

  it('reaches the row link by keyboard and follows it on Enter', async () => {
    /**
     * The whole reason no card passes `onRowClick`: that handler sits on a `<tr>` with no
     * `tabIndex`, no `onKeyDown` and no `role`, so the row is unreachable by keyboard —
     * WCAG 2.1.1. This asserts the replacement actually works, so the prohibition is
     * enforced by a test rather than only by a comment.
     */
    const user = userEvent.setup();
    const activated: string[] = [];
    document.addEventListener('click', (e) => {
      const a = (e.target as HTMLElement).closest('a');
      if (a) activated.push(a.getAttribute('href') ?? '');
    });
    render(<MyTravelRequestsCard />);

    /** The stops in front of the anchor are `ColumnHeader`'s `aria-disabled` label
     *  buttons, one per column — a pre-existing wart of the shared header, not this
     *  card's to fix. What matters is that the row's target IS reachable. */
    for (let i = 0; i < 12 && document.activeElement?.tagName !== 'A'; i += 1) {
      await user.tab();
    }
    expect(document.activeElement).toBe(screen.getByRole('link', { name: /TRV-000001/ }));

    await user.keyboard('{Enter}');
    expect(activated).toContain('/travel?request=01924b1e-7c2a-7f3d-9c4e-5a6b7c8d9e0f');
  });

  it('sums the budget lines for a trip nobody has approved yet', () => {
    /** `approvedTotalMinor` is null until an approver snapshots one. A blank until then
     *  would hide the number the decision is about. */
    h.requests = {
      items: [
        request({
          approvedTotalMinor: null,
          budgetLines: [
            { id: 'l1', amountMinor: 30000n },
            { id: 'l2', amountMinor: 12550n },
          ],
        }),
      ],
    };
    render(<MyTravelRequestsCard />);
    const row = screen.getByRole('link', { name: /TRV-000001/ }).closest('tr');
    expect(within(row as HTMLElement).getByText('CAD 425.50')).toBeInTheDocument();
  });

  it('shows what was approved once it has been, not what was asked for', () => {
    h.requests = {
      items: [
        request({ approvedTotalMinor: 20000n, budgetLines: [{ id: 'l1', amountMinor: 30000n }] }),
      ],
    };
    render(<MyTravelRequestsCard />);
    expect(screen.getByText('CAD 200.00')).toBeInTheDocument();
    expect(screen.queryByText('CAD 300.00')).not.toBeInTheDocument();
  });

  // ── The other four faces ────────────────────────────────────────────────────

  it('shows the empty face and NO footer when there is nothing to preview', () => {
    /** THE TRAP. "View all" under "no trips" links the reader into a listing they have
     *  just been told is empty. The footer is passed from the non-empty branch only. */
    h.requests = { items: [] };
    render(<MyTravelRequestsCard />);
    expect(screen.getByText('dashboard.cards.travel.empty')).toBeInTheDocument();
    expect(screen.getByText('dashboard.cards.travel.emptyHint')).toBeInTheDocument();
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
    render(<MyTravelRequestsCard />);
    const viewAll = screen.getByRole('link', { name: 'dashboard.cards.travel.viewAll' });
    expect(viewAll).toHaveClass('min-h-11');
    // Beside `py-3`, never instead of it: `min-height` only raises the used height, so
    // dropping the padding would shrink what is drawn while leaving this green.
    expect(viewAll).toHaveClass('py-3');
  });

  it('shows a skeleton, and never an empty face, while the rows are in flight', () => {
    /** ONE QUERY DECIDES THIS NOW. While the header badge read `summaryOwn`, `pending` was
     *  the OR of both queries and the skeleton stayed up until the SLOWER of the two
     *  resolved. The rows are the whole card, so it clears when they arrive. */
    h.requestsPending = true;
    h.requests = undefined;
    render(<MyTravelRequestsCard />);
    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-busy', 'true');
    expect(status).toHaveTextContent('dashboard.cards.travel.loading');
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.queryByText('dashboard.cards.travel.empty')).not.toBeInTheDocument();
  });

  it('says the section failed — not that it is empty — and offers a retry', async () => {
    /** THE ROWS ARE THE ONLY THING THAT CAN FAIL THE CARD, which is a narrowing: until the
     *  badge came off, a `summaryOwn` that failed on its own replaced a perfectly good set
     *  of rows with this panel. */
    const user = userEvent.setup();
    h.requestsError = true;
    render(<MyTravelRequestsCard />);
    expect(screen.getByText('common.panelUnavailable')).toBeInTheDocument();
    expect(screen.queryByText('dashboard.cards.travel.empty')).not.toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'common.retry' }));
    // One query, one refetch — and no second refetch aimed at a query nothing reads.
    expect(h.refetches).toBe(1);
  });
});

/**
 * The same five trips below the compact breakpoint, where the card list replaces the table.
 *
 * `layout` is not passed by the card, so the real gate is exercised — the card tree is
 * reached because `MOBILE.title` is named, not because a test forced it. No new i18n key is
 * involved: each field row's `<dt>` is the column's own already-translated `label`.
 */
describe('the my-travel-requests card on a phone', () => {
  /** In THIS block's own `beforeEach`, never at file level. A file-level stub would convert
   *  every desktop assertion above into a phone one without changing a line of them, and
   *  the suite would stay green while measuring something nobody wrote it to measure. */
  beforeEach(() => stubDevice('phone'));

  it('replaces the table with one card per trip, titled by the destination', () => {
    /** The title is the card's accessible name and its only navigation affordance, so it has
     *  to be the string a person recognises the row by. A phone list reading TRV-000001 /
     *  TRV-000002 is a list of nothing — which is what naming the LISTITEM, rather than
     *  merely finding the text, pins here. */
    h.requests = {
      items: [
        request({ id: 'r1', number: 'TRV-000001', destinationLabel: 'Montréal, QC, Canada' }),
        request({ id: 'r2', number: 'TRV-000002', destinationLabel: 'Halifax, NS, Canada' }),
      ],
    };
    render(<MyTravelRequestsCard />);

    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(
      screen.getByRole('listitem', { name: /Montréal, QC, Canada\s*TRV-000001/ }),
    ).toBeInTheDocument();
  });

  it('carries the dates and the budget as labelled rows, and the status as the badge', () => {
    /**
     * WHAT `/travel`'s OWN CARD ASSERTS, for the same reason: a card that silently drops the
     * status is worse than a table the reader has to scroll sideways, and the dates and the
     * money are the same class of loss.
     *
     * The two `<dt>` terms are asserted as an ordered list, which is simultaneously the
     * claim that the fields are `dates` then `budget` and the claim that each term is the
     * column's existing translated label rather than a key this phase invented.
     *
     * The number is absent from the field rows and present in the title, because this card
     * has no `number` COLUMN — it is the second line of the destination cell. That is the
     * one place this config differs from `/travel`'s `MOBILE_MINE`.
     */
    render(<MyTravelRequestsCard />);
    const card = screen.getByRole('listitem', { name: /Montréal, QC, Canada\s*TRV-000001/ });

    expect([...card.querySelectorAll('dt')].map((n) => n.textContent)).toEqual([
      'travel.columns.dates',
      'travel.columns.budget',
    ]);
    // NBSP → space: `Intl` separates the ISO code from the number with U+00A0, and reading
    // `textContent` bypasses the whitespace normalisation Testing Library's text queries do.
    const values = [...card.querySelectorAll('dd')].map((n) =>
      n.textContent?.replace(/\u00a0/g, ' '),
    );
    // `Intl.formatRange` collapses the parts the two ends share, in the locale's own idiom
    // ("Sep 1 – 4, 2026", "1 au 4 septembre 2026"), which is why this card formats a RANGE
    // rather than two dates with a dash between them. Asserted loosely on the ends, so an
    // ICU revision to the separator does not fail a test about the card's field rows.
    expect(values[0]).toMatch(/Sep 1\s*.\s*4, 2026/);
    expect(values[1]).toBe('CAD 300.00');
    expect(card.querySelector('[data-dt-card-slot="badge"]')).toHaveTextContent(
      'travel.status.SUBMITTED',
    );
  });

  it('keeps the row link as the card title, with no row-open button around it', () => {
    /** No `onRowClick` on a card either: the frame's `onRowClick` arm wraps the title slot in
     *  a `<button>`, and the column's `<a>` nested in one is two controls fighting for a
     *  single tap. Without the handler the anchor IS the card's floored tap target. */
    render(<MyTravelRequestsCard />);
    const card = screen.getByRole('listitem', { name: /TRV-000001/ });

    expect(within(card).getByRole('link')).toHaveAttribute(
      'href',
      '/travel?request=01924b1e-7c2a-7f3d-9c4e-5a6b7c8d9e0f',
    );
    expect(within(card).queryByRole('button')).toBeNull();
  });
});
