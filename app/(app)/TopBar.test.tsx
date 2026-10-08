import '@testing-library/jest-dom/vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The top bar: the page's title, and the two zones pages mount their own controls into.
 *
 * The slot store is a MODULE-LEVEL external store rather than context, and deliberately
 * so: a page commits new JSX on many renders, and context would subscribe the writer to
 * its own write — the infinite-loop shape. What has to hold:
 *
 *   · **Every page's slots are cleared when it unmounts.** A stale "Add rule" button
 *     left over from the previous route is a control that acts on a page nobody is
 *     looking at.
 *   · **The title comes from the LONGEST matching route.** `/expenses/approvals` and
 *     `/expenses` both match the second, so a shortest-first match would title the
 *     approvals queue "Expense reports".
 *   · **A page that supplies its own left slot replaces the title**, rather than
 *     rendering beside it.
 */

const h = vi.hoisted(() => ({ pathname: '/expenses', ported: undefined as string[] | undefined }));

vi.mock('@/i18n/navigation', () => ({
  usePathname: () => h.pathname,
}));
vi.mock('next-intl', () => ({
  useTranslations: (ns?: string) => {
    const t = (key: string) => (ns ? `${ns}.${key}` : key);
    t.has = () => false;
    return t;
  },
  useLocale: () => 'en',
}));
// Both are independent surfaces with their own tests and their own queries.
vi.mock('./NotificationBell', () => ({ NotificationBell: () => <div>bell</div> }));
vi.mock('@/components/assistant/AssistantLauncher', () => ({
  AssistantLauncher: () => <div>assistant</div>,
}));
/**
 * VeloExpense: the top bar titles only ported screens (`veloexpenseNav.ts`). This file
 * tests ExpenseOS's titling as ExpenseOS does — every route a ported screen — unless a
 * case sets `h.ported` to VeloExpense's real list.
 */
vi.mock('./veloexpenseNav', () => ({
  isPortedScreen: (pathname: string) => h.ported?.includes(pathname) ?? true,
}));

import { setTopBarSlot, TopBar, useTopBarSlots } from './TopBar';

/**
 * Publishes into a slot and draws nothing — the third spelling of "nothing" the shell
 * cannot see. `netsuite/NetSuiteSyncControl.tsx:129` is the live instance.
 */
function RendersNothing() {
  return null;
}

/** A page that publishes slots for as long as it is mounted. */
function FakePage({ right, left }: { right?: React.ReactNode; left?: React.ReactNode }) {
  useTopBarSlots(() => ({ right, left }), [right, left]);
  return null;
}

const title = () => screen.queryByRole('heading')?.textContent;

beforeEach(() => {
  h.pathname = '/expenses';
  h.ported = undefined;
});
afterEach(() => {
  // The store outlives any one render; leaving a slot set would leak into the next test.
  act(() => {
    setTopBarSlot('left', null);
    setTopBarSlot('center', null);
    setTopBarSlot('right', null);
  });
  vi.restoreAllMocks();
});

describe('the title', () => {
  it("VeloExpense: draws no heading over a page that is not a port, which has its own", () => {
    h.ported = [];
    render(<TopBar />);
    expect(screen.queryByRole('heading')).not.toBeInTheDocument();
  });

  it('names the page from its route', () => {
    render(<TopBar />);
    expect(title()).toBe('nav.items.expenseReports');
  });

  it('prefers the longest matching route, not the first', () => {
    /**
     * `/expenses/approvals` starts with `/expenses`. Matching the shorter one would
     * title the approvals queue "Expense reports" — the classic prefix-match bug.
     */
    h.pathname = '/expenses/approvals';
    render(<TopBar />);
    expect(title()).toBe('nav.items.approvalsQueue');
  });

  it('keeps the section title on a record page underneath it', () => {
    // `/expenses/<id>` is still the expenses section.
    h.pathname = '/expenses/01931f7c-0000-7000-8000-000000000000';
    render(<TopBar />);
    expect(title()).toBe('nav.items.expenseReports');
  });

  it('distinguishes the sub-sections of virtual cards', () => {
    h.pathname = '/virtual-cards/transactions';
    render(<TopBar />);
    expect(title()).toBe('nav.items.cardTransactions');
  });

  it('says nothing for a route it does not know', () => {
    /**
     * An empty title is the honest answer. Falling back to the first segment would
     * print a raw slug where a translated name belongs.
     */
    h.pathname = '/something-new';
    render(<TopBar />);
    expect(title()).toBe('');
  });

  it('does not match a route that merely shares a prefix string', () => {
    // `/travel-agency` is not `/travel`.
    h.pathname = '/travel-agency';
    render(<TopBar />);
    expect(title()).toBe('');
  });

  /**
   * Every destination the sidebar offers has to name itself.
   *
   * The map is maintained by hand, and a nav item added without its entry fails in one
   * of two ways, neither of which looks like a missing map:
   *
   *   · it has NO prefix in the map, so the header renders an EMPTY `<h1>` — the page
   *     appears to have lost its title, and an empty heading is also what a screen
   *     reader announces for the page;
   *   · it sits UNDER a route that IS in the map, so it silently inherits that route's
   *     title and claims to be a different page — `/expenses/all` titled "My Expense
   *     Reports" is indistinguishable from `/expenses` by its header.
   *
   * Both were live on dev: Travel Categories and NetSuite ▸ Business Units rendered a
   * blank title, and All expenses called itself My Expense Reports.
   */
  it.each([
    ['/expenses/all', 'nav.items.allExpenses'],
    ['/admin/travel-categories', 'nav.items.travelCategories'],
    ['/ledger/business-units', 'nav.items.nsBusinessUnits'],
  ])('names %s rather than inheriting or blanking', (pathname, expected) => {
    h.pathname = pathname;
    render(<TopBar />);
    expect(title()).toBe(expected);
  });
});

describe('the slots pages mount into', () => {
  it('shows a page’s action on the right', async () => {
    render(
      <>
        <TopBar />
        <FakePage right={<button type="button">Add rule</button>} />
      </>,
    );
    expect(await screen.findByRole('button', { name: 'Add rule' })).toBeInTheDocument();
  });

  it('lets a page replace the title entirely', async () => {
    // A record page shows a breadcrumb where the section title would be.
    render(
      <>
        <TopBar />
        <FakePage left={<span>Report EXP-1 › Lines</span>} />
      </>,
    );
    expect(await screen.findByText('Report EXP-1 › Lines')).toBeInTheDocument();
    // The heading is gone entirely — the slot replaces it rather than hiding it.
    expect(screen.queryByRole('heading')).not.toBeInTheDocument();
  });

  it('clears a page’s slots when that page goes away', async () => {
    /**
     * The failure this prevents: navigating from Policy rules to the audit trail and
     * still seeing "Add rule" — a button that acts on a page nobody is on.
     */
    const view = render(
      <>
        <TopBar />
        <FakePage right={<button type="button">Add rule</button>} />
      </>,
    );
    await screen.findByRole('button', { name: 'Add rule' });
    view.rerender(<TopBar />);
    expect(screen.queryByRole('button', { name: 'Add rule' })).not.toBeInTheDocument();
  });

  it('takes the newest page’s slots when one replaces another', async () => {
    const view = render(
      <>
        <TopBar />
        <FakePage right={<button type="button">Add rule</button>} />
      </>,
    );
    await screen.findByRole('button', { name: 'Add rule' });
    view.rerender(
      <>
        <TopBar />
        <FakePage right={<button type="button">Add budget</button>} />
      </>,
    );
    expect(await screen.findByRole('button', { name: 'Add budget' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add rule' })).not.toBeInTheDocument();
  });

  it('can be set imperatively, for a surface that is not a page', async () => {
    render(<TopBar />);
    act(() => setTopBarSlot('center', <span>saving…</span>));
    expect(await screen.findByText('saving…')).toBeInTheDocument();
  });

  it('does not touch a zone the page said nothing about', async () => {
    /**
     * A page that publishes only `right` must not blank the centre — the two are set by
     * different owners.
     */
    function OnlyRight() {
      useTopBarSlots(() => ({ right: <span>mine</span> }), []);
      return null;
    }
    render(<TopBar />);
    act(() => setTopBarSlot('center', <span>kept</span>));
    render(<OnlyRight />);
    expect(await screen.findByText('mine')).toBeInTheDocument();
    expect(screen.getByText('kept')).toBeInTheDocument();
  });

  it('publishes a centre slot through the same hook', async () => {
    /**
     * `left` and `right` had tests and `center` did not, so the hook's third branch was
     * never taken. It is the zone a page uses for a search box or a wizard's step
     * indicator — the one control a reader looks for at the top of the screen.
     */
    function WithCentre() {
      useTopBarSlots(() => ({ center: <span>step 2 of 4</span> }), []);
      return null;
    }
    render(
      <>
        <TopBar />
        <WithCentre />
      </>,
    );
    expect(await screen.findByText('step 2 of 4')).toBeInTheDocument();
  });

  it('blanks a centre slot the page publishes as null', async () => {
    /** Publishing `center: null` is how a page says "nothing here" — distinct from not
     *  mentioning the zone, which leaves whatever another owner put there. */
    function ClearsCentre() {
      useTopBarSlots(() => ({ center: null }), []);
      return null;
    }
    render(<TopBar />);
    act(() => setTopBarSlot('center', <span>stale</span>));
    expect(screen.getByText('stale')).toBeInTheDocument();
    render(<ClearsCentre />);
    await waitFor(() => expect(screen.queryByText('stale')).not.toBeInTheDocument());
  });

  it('re-publishes when the page’s own deps change', async () => {
    function Counting({ n }: { n: number }) {
      useTopBarSlots(() => ({ right: <span>count {n}</span> }), [n]);
      return null;
    }
    const view = render(
      <>
        <TopBar />
        <Counting n={1} />
      </>,
    );
    await screen.findByText('count 1');
    view.rerender(
      <>
        <TopBar />
        <Counting n={2} />
      </>,
    );
    expect(await screen.findByText('count 2')).toBeInTheDocument();
  });

  it('always shows the bell, whatever the page publishes', () => {
    // It is the shell's own, not a page's, so no page can displace it.
    render(<TopBar />);
    expect(screen.getByText('bell')).toBeInTheDocument();
  });
});

describe('the assistant launcher', () => {
  /**
   * Gated on the module, not merely on what the panel would say once opened.
   *
   * It used to render unconditionally and explain itself when opened — the reasoning being
   * that a control saying "an administrator can install this" teaches somebody who to ask.
   * A workspace that has deliberately switched the module off is not waiting to be told,
   * and an entry point to a feature nobody there can use reads as a broken button.
   *
   * The set is the same one that gates the sidebar's module-bound sections, resolved
   * server-side in `(app)/layout.tsx`.
   */
  it('appears when the assistant module is active', () => {
    render(<TopBar activeModules={new Set(['assistant'])} />);
    expect(screen.getByText('assistant')).toBeInTheDocument();
  });

  it('is absent when the module is switched off', () => {
    render(<TopBar activeModules={new Set(['expense-management'])} />);
    expect(screen.queryByText('assistant')).not.toBeInTheDocument();
  });

  it('is absent when no module set has been resolved yet', () => {
    /** Undefined reads as "no module is on" — the safe direction for a gate, and what a
     *  caller that has not threaded the prop gets. */
    render(<TopBar />);
    expect(screen.queryByText('assistant')).not.toBeInTheDocument();
  });

  it('does not take the bell down with it', () => {
    /** The bell is core, not module-bound; one gate must not swallow the other. */
    render(<TopBar activeModules={new Set()} />);
    expect(screen.getByText('bell')).toBeInTheDocument();
    expect(screen.queryByText('assistant')).not.toBeInTheDocument();
  });
});

describe('the sidebar controls', () => {
  it('offers the pin toggle only when the shell can act on it', () => {
    render(<TopBar />);
    expect(screen.queryByRole('button', { name: /Sidebar/ })).not.toBeInTheDocument();
  });

  it('says it will collapse a pinned sidebar, and expand an unpinned one', async () => {
    /**
     * One button, two meanings — and the label is the only thing that says which,
     * since the icon is the whole control.
     */
    const onToggle = vi.fn();
    const user = userEvent.setup();
    const view = render(<TopBar collapsed={false} onToggleCollapsed={onToggle} />);
    await user.click(screen.getByRole('button', { name: 'nav.collapseSidebar' }));
    expect(onToggle).toHaveBeenCalled();
    view.rerender(<TopBar collapsed onToggleCollapsed={onToggle} />);
    expect(screen.getByRole('button', { name: 'nav.expandSidebar' })).toBeInTheDocument();
  });

  it('opens the off-canvas nav from the hamburger', async () => {
    const onMenu = vi.fn();
    const user = userEvent.setup();
    render(<TopBar onMenu={onMenu} />);
    await user.click(screen.getByRole('button', { name: 'nav.openMenu' }));
    expect(onMenu).toHaveBeenCalled();
  });

  it('renders no hamburger when there is no nav to open', () => {
    render(<TopBar collapsed onToggleCollapsed={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'nav.openMenu' })).not.toBeInTheDocument();
  });
});

describe('the page-chrome box in the right zone', () => {
  /**
   * The box exists only when a page put something in it.
   *
   * It is a flex child of a `gap-1.5` row, so an unconditional one costs every route that
   * publishes no `right` slot a zero-width item plus that gap — 6px of dead space to the
   * left of the notification bell, on the large majority of pages.
   *
   * `right != null` catches TWO of the three spellings of "nothing", and the cases below
   * pin all three — the two it catches as the behaviour we want, the third as a cost we
   * are knowingly paying:
   *
   *   · **absent** — around thirty routes publish no `right` slot at all;
   *   · **an explicit `null`** — `admin/notification-templates` publishes `{ right: null }`;
   *   · **an element that RENDERS nothing** — a component returning `null`, or
   *     `right: cond && <X/>` yielding `false`. Non-null from the shell's side, so the box
   *     is rendered and the 6px is still paid. `netsuite/NetSuiteSyncControl.tsx:129`
   *     returns `null` for a viewer without `netsuite.sync`, and its two publishers
   *     (`netsuite/NetSuiteReferenceList.tsx:545`,
   *     `netsuite/sync/NetSuiteSyncDashboard.tsx:62`) publish it unconditionally, so this
   *     is live on exactly the read-only viewers of those two routes.
   *
   * The third is not detectable from the shell — whether an element renders anything is
   * decided by React while rendering it — so `right != null` is the implementation and the
   * cost is recorded rather than hidden. Do NOT make that case go green by weakening the
   * condition; if the third spelling is ever fixed it will be by changing the publishers,
   * and the case below is the thing that will then have to be rewritten on purpose.
   *
   * Structure, not geometry: jsdom cannot lay anything out, so what a unit test can say is
   * whether the box is in the tree. The 6px it costs when it should not be there is
   * measured in `e2e/topbar-overlap.spec.ts`; this is the cheap tripwire that keeps the
   * condition from being deleted as redundant.
   */
  const pageBox = (container: HTMLElement) =>
    container.querySelector('[data-zone="right"] > [data-chrome="page"]');

  it('is absent when no page published a right slot', () => {
    const { container } = render(<TopBar />);
    expect(container.querySelector('[data-zone="right"]')).toBeInTheDocument();
    expect(pageBox(container)).toBeNull();
  });

  it('is absent when a page publishes `right: null`', async () => {
    /** `NotificationTemplatesAdmin.tsx` does exactly this. */
    function PublishesNull() {
      useTopBarSlots(() => ({ right: null }), []);
      return null;
    }
    const { container } = render(
      <>
        <TopBar />
        <PublishesNull />
      </>,
    );
    await waitFor(() => expect(pageBox(container)).toBeNull());
  });

  /** The third spelling: non-null to the shell, nothing on the screen. */
  const rendersNothing: [string, React.ReactNode][] = [
    // `NetSuiteSyncControl.tsx:129` — `if (!canSync) return null` for a viewer without
    // `netsuite.sync`, published unconditionally by two NetSuite routes.
    ['a component that returns null', <RendersNothing key="component" />],
    // `false != null`, and `useTopBarSlots`'s `?? null` only normalises nullish values.
    ['a false-guarded `cond && <X/>`', false],
  ];

  /**
   * CHARACTERIZATION, not an endorsement — see the third bullet in the block comment above.
   *
   * Both cases publish something the shell reads as non-null and that draws nothing, so the
   * box is rendered and the row's `gap-1.5` costs its 6px anyway. That is the honest current
   * behaviour, and it is why the box condition is described as catching two spellings rather
   * than all three. A green here means the limitation is still exactly as documented; it does
   * not mean the limitation is fine.
   */
  it.each(rendersNothing)('renders the box anyway for %s (known 6px cost)', async (_l, node) => {
    const { container } = render(
      <>
        <TopBar />
        <FakePage right={node} />
      </>,
    );
    await waitFor(() => expect(pageBox(container)).not.toBeNull());
    // Rendered, and empty: the flex item exists with nothing in it.
    expect(pageBox(container)).toBeEmptyDOMElement();
  });

  it('is present as soon as a page publishes anything', async () => {
    const { container } = render(
      <>
        <TopBar />
        <FakePage right={<button type="button">Add budget</button>} />
      </>,
    );
    await screen.findByRole('button', { name: 'Add budget' });
    const box = pageBox(container);
    expect(box).not.toBeNull();
    expect(box).toContainElement(screen.getByRole('button', { name: 'Add budget' }));
  });

  it('goes away again when the publishing page unmounts', async () => {
    const { container, rerender } = render(
      <>
        <TopBar />
        <FakePage right={<button type="button">Add budget</button>} />
      </>,
    );
    await screen.findByRole('button', { name: 'Add budget' });
    expect(pageBox(container)).not.toBeNull();
    rerender(<TopBar />);
    await waitFor(() => expect(pageBox(container)).toBeNull());
  });

  /**
   * The shell's own box is NOT conditional, and that asymmetry is the point: the bell and
   * the launcher are what the right zone is for, and they keep their width whatever a page
   * mounts beside them.
   */
  it('never removes the shell’s own box', () => {
    const { container } = render(<TopBar />);
    expect(
      container.querySelector('[data-zone="right"] > [data-chrome="shell"]'),
    ).toBeInTheDocument();
  });
});
