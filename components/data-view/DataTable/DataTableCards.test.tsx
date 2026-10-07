/**
 * The card renderer — `<DataTable layout="cards">`.
 *
 * A third file alongside `DataTable.test.tsx` (the table's own contract,
 * unmodified by this work) and `DataTable.layout.test.tsx` (which tree
 * mounts). This one is about what a card IS.
 *
 * The two rules from the layout suite carry over verbatim:
 *
 *   - Never assert on the cloak classes. `CARDS_ONLY` / `TABLE_ONLY` exist
 *     only to suppress a pre-hydration flash in a real browser; pinning
 *     `toHaveClass('md:hidden')` would re-couple the suite to the CSS
 *     mechanism the single-tree design removed.
 *   - Assert on ROLES. `list` / `listitem` / `status` / accessible names are
 *     what a screen reader and a user both get, and they survive any
 *     restyling of the card.
 *
 * Everything here drives the PUBLIC component. `DataTableCards` is not
 * exported from either barrel and is not imported directly — a test that
 * reached past `DataTable()` would be testing a tree no page can mount.
 */

import '@testing-library/jest-dom/vitest';
import { COMPACT_QUERY } from '@expenseos/design-system';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DataTable } from './DataTable';
import {
  type ColumnDef,
  createDataTableState,
  type DataTableLabels,
  type DataTableMobileConfig,
  type DataTableState,
} from './types';

const LABELS: DataTableLabels = {
  colMenu: {
    menu: 'menu',
    sortAsc: 'asc',
    sortDesc: 'desc',
    filter: 'filter',
    hide: 'hide',
    cancel: 'cancel',
    clear: 'clear',
    apply: 'apply',
    value: 'value',
    resize: 'resize',
    removeFilter: 'removeFilter',
    op_contains: 'contains',
    op_doesNotContain: 'doesNotContain',
    op_equals: 'equals',
    op_doesNotEqual: 'doesNotEqual',
    op_startsWith: 'startsWith',
    op_endsWith: 'endsWith',
    op_isEmpty: 'isEmpty',
    op_isNotEmpty: 'isNotEmpty',
    op_isAnyOf: 'isAnyOf',
    op_isNoneOf: 'isNoneOf',
  },
  settings: {
    trigger: 'settings',
    columns: 'Columns',
    density: 'Density',
    densityCompact: 'Compact',
    densityNormal: 'Normal',
    densityComfortable: 'Comfortable',
    resetDefaults: 'Reset',
  },
  selectAll: 'Select all',
  loading: 'Loading…',
  endOfList: 'End of list',
};

interface Row {
  id: string;
  name: string;
  merchant: string;
  amount: string;
  status: string;
  project: string;
}
type Col = 'name' | 'merchant' | 'amount' | 'status' | 'project';

const COLS: ColumnDef<Row, Col>[] = [
  { id: 'name', label: 'Name', hideable: false, cell: (r) => r.name },
  { id: 'merchant', label: 'Merchant', cell: (r) => r.merchant },
  { id: 'amount', label: 'Amount', cell: (r) => <span>{r.amount}</span> },
  // Stands in for a real status column: a BADGE, never a bare colour.
  { id: 'status', label: 'Status', cell: (r) => <span data-badge>{r.status}</span> },
  { id: 'project', label: 'Project', cell: (r) => r.project },
];

const ROWS: Row[] = [
  {
    id: '1',
    name: 'Q3 travel',
    merchant: 'Ada Lovelace',
    amount: '$120.00',
    status: 'Approved',
    project: 'Apollo',
  },
  {
    id: '2',
    name: 'Client dinner',
    merchant: 'Grace Hopper',
    amount: '$240.00',
    status: 'Pending',
    project: 'Gemini',
  },
];

const MOBILE: DataTableMobileConfig<Row, Col> = {
  title: 'name',
  subtitle: 'merchant',
  badge: 'status',
  fields: ['amount', 'project'],
};

type HarnessProps = {
  rows?: Row[];
  mobile?: DataTableMobileConfig<Row, Col>;
  columns?: ColumnDef<Row, Col>[];
  initial?: Partial<DataTableState<Col>>;
  labels?: DataTableLabels;
  loading?: boolean;
  selectable?: boolean;
  renderEmpty?: () => React.ReactNode;
  onRowClick?: (row: Row) => void;
  onLoadMore?: () => void;
  hasNextPage?: boolean;
  groupKeyFor?: (row: Row, groupBy: Col) => string;
  groupLabelFor?: (key: string, groupBy: Col) => string;
  groupCountLabel?: (count: number) => string;
};

function Harness(props: HarnessProps) {
  const cols = props.columns ?? COLS;
  const [state, setState] = useState<DataTableState<Col>>(() =>
    createDataTableState(cols as never, props.initial ?? {}),
  );
  return (
    <DataTable<Row, Col>
      layout="cards"
      columns={cols}
      rows={props.rows ?? ROWS}
      rowKey={(r) => r.id}
      state={state}
      onStateChange={setState}
      labels={props.labels ?? LABELS}
      mobile={props.mobile ?? MOBILE}
      loading={props.loading}
      selectable={props.selectable}
      renderEmpty={props.renderEmpty}
      onRowClick={props.onRowClick}
      onLoadMore={props.onLoadMore}
      hasNextPage={props.hasNextPage}
      groupKeyFor={props.groupKeyFor}
      groupLabelFor={props.groupLabelFor}
      groupCountLabel={props.groupCountLabel}
      // Off unless a test is specifically about the sentinel: the observer
      // is the one piece of this tree that needs a stubbed global.
      disableInfiniteScroll={!props.onLoadMore}
    />
  );
}

/** The card whose title is `name`. Cards are named by their title node
 *  (`aria-labelledby`), so this is also how a screen-reader user finds one. */
function cardNamed(name: string) {
  return screen.getByRole('listitem', { name });
}

describe('<DataTable> card anatomy', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('renders a list of cards, one per row, each named by its title', () => {
    render(<Harness />);
    expect(screen.getByRole('list')).toBeInTheDocument();
    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(2);
    // The name is the TITLE, not a concatenation of every value on the card.
    // Both cards carry a merchant, an amount, a status and a project; none of
    // that may leak into the announced name.
    expect(items[0]).toHaveAccessibleName('Q3 travel');
    expect(items[1]).toHaveAccessibleName('Client dinner');
  });

  it('renders title, subtitle, badge and field rows through the column cells', () => {
    render(<Harness />);
    const card = cardNamed('Q3 travel');
    expect(card).toHaveTextContent('Q3 travel'); // title
    expect(card).toHaveTextContent('Ada Lovelace'); // subtitle
    expect(card).toHaveTextContent('Approved'); // badge
    // Field rows carry the column's LABEL and the column's own `cell` output.
    expect(card).toHaveTextContent('Amount');
    expect(card).toHaveTextContent('$120.00');
    expect(card).toHaveTextContent('Project');
    expect(card).toHaveTextContent('Apollo');
  });

  it('renders the badge as the column rendered it, not as a colour-only dot', () => {
    // SC 1.4.1: the card must not degrade a status badge into a coloured
    // marker. Whatever the column's `cell` produced is what ships.
    const { container } = render(<Harness />);
    expect(container.querySelectorAll('[data-badge]')).toHaveLength(2);
  });

  it('never renders a table in card mode', () => {
    render(<Harness />);
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.queryByRole('row')).not.toBeInTheDocument();
    expect(screen.queryByRole('cell')).not.toBeInTheDocument();
  });

  it('falls back to a visible column when mobile.title names one that is not built', () => {
    /**
     * `mobile.title` is checked against the `ColumnId` UNION, which is not
     * the live `columns` array — a page that builds a column behind a
     * permission or a flag can name a title that types fine and is simply
     * absent this render.
     *
     * The card's accessible name comes from the title node
     * (`aria-labelledby`), so a title that resolved to nothing would leave
     * every card unnamed while `hasCardConfig` still routed the page into
     * the card branch. The miss therefore falls through to the same chain an
     * unconfigured page uses: the first column the user can see.
     */
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cols = COLS.filter((c) => c.id !== 'name');
    render(<Harness columns={cols} mobile={{ ...MOBILE, title: 'name' }} />);

    // `merchant` is now first in the column order, so it is the headline.
    const card = cardNamed('Ada Lovelace');
    expect(card).toBeInTheDocument();
    // Both cards are named — the point of the fallback is that none of them
    // came back with an empty accessible name.
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(cardNamed('Grace Hopper')).toBeInTheDocument();
  });
});

describe('<DataTable> card field rows vs. column visibility', () => {
  it('drops a field whose column the user hid on the desktop', () => {
    render(<Harness initial={{ columnVisibility: { project: false } }} />);
    const card = cardNamed('Q3 travel');
    expect(card).toHaveTextContent('Amount');
    expect(card).toHaveTextContent('$120.00');
    expect(card).not.toHaveTextContent('Project');
    expect(card).not.toHaveTextContent('Apollo');
  });

  it('keeps title and badge when their columns are hidden — a card always has identity', () => {
    render(
      <Harness initial={{ columnVisibility: { name: false, status: false, merchant: false } }} />,
    );
    // Named by the title even though the title column is hidden.
    const card = cardNamed('Q3 travel');
    expect(card).toHaveTextContent('Approved');
    // The SUBTITLE is not exempt — only title and badge are.
    expect(card).not.toHaveTextContent('Ada Lovelace');
  });

  it('renders cleanly with ZERO field rows when every configured field is hidden', () => {
    // The accepted degenerate case. No synthesised fallback row: the person
    // asked for those columns to be gone, and a card with a title and a
    // badge is still a card.
    render(<Harness initial={{ columnVisibility: { amount: false, project: false } }} />);
    const card = cardNamed('Q3 travel');
    expect(card).toHaveTextContent('Q3 travel');
    expect(card).toHaveTextContent('Approved');
    expect(card).not.toHaveTextContent('Amount');
    expect(card).not.toHaveTextContent('Project');
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });

  it('never writes column visibility back from the card tree', () => {
    // The whole reason `DataTableCards` has no `onStateChange`: a phone must
    // not be able to rewrite the desktop layout of a saved view. Rendering
    // is a pure read, so nothing reaches the consumer's setter.
    const onStateChange = vi.fn();
    const state = createDataTableState(COLS as never, {
      columnVisibility: { project: false },
    }) as DataTableState<Col>;
    render(
      <DataTable<Row, Col>
        layout="cards"
        columns={COLS}
        rows={ROWS}
        rowKey={(r) => r.id}
        state={state}
        onStateChange={onStateChange}
        labels={LABELS}
        mobile={MOBILE}
        disableInfiniteScroll
      />,
    );
    expect(onStateChange).not.toHaveBeenCalled();
  });
});

describe('<DataTable> card empty and loading faces', () => {
  it('shows the loading label while the first page is in flight', () => {
    render(<Harness rows={[]} loading />);
    expect(screen.getByText('Loading…')).toBeInTheDocument();
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
  });

  it('shows the default empty text when there are no rows', () => {
    render(<Harness rows={[]} />);
    expect(screen.getByText('No results.')).toBeInTheDocument();
  });

  it('honours the consumer renderEmpty template, exactly as the table does', () => {
    render(<Harness rows={[]} renderEmpty={() => <p>Nothing to approve.</p>} />);
    expect(screen.getByText('Nothing to approve.')).toBeInTheDocument();
    expect(screen.queryByText('No results.')).not.toBeInTheDocument();
  });
});

describe('<DataTable> card result-count live region', () => {
  it('is mounted before it has anything to say, and stays quiet on first paint', () => {
    render(<Harness />);
    // Present from the first commit — a live region inserted alongside its
    // own text is not reliably announced.
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
  });

  it('announces the new count when the row set changes', () => {
    const { rerender } = render(<Harness />);
    rerender(<Harness rows={[ROWS[0]]} />);
    expect(screen.getByRole('status')).toHaveTextContent('1 result');
  });

  it('uses the caller label seam when one is supplied', () => {
    const labels: DataTableLabels = {
      ...LABELS,
      cards: { resultCount: (n) => `${n} résultats` },
    };
    const { rerender } = render(<Harness labels={labels} />);
    rerender(<Harness labels={labels} rows={[ROWS[0]]} />);
    expect(screen.getByRole('status')).toHaveTextContent('1 résultats');
  });
});

describe('<DataTable> card row actions and selection', () => {
  it('renders the kebab with a default accessible name when rowActions is configured', () => {
    render(
      <Harness
        mobile={{
          ...MOBILE,
          rowActions: () => [{ id: 'open', icon: null, label: 'Open', onClick: () => {} }],
        }}
      />,
    );
    expect(screen.getAllByRole('button', { name: 'Row actions' })).toHaveLength(2);
  });

  it('gives the kebab a real 44px hit area, not a 44px box around a 24px one', () => {
    /**
     * The inherited tap-target ruling, cashed.
     *
     * Phase 3 reserved a 44×44 slot around the design system's 24×24
     * trigger and left a note that `RowActionsMenu.triggerSize` was what
     * would make the box more than a promise. The distinction is the whole
     * point: a finger that lands 16px from the glyph hits the wrapper, and
     * the wrapper is not the button. So the assertion is on the BUTTON, and
     * it checks the wrapper is gone as well — two nested 44px boxes would
     * pass a naive size check while leaving the next reader to guess which
     * one carries the target.
     *
     * Classes rather than measurements because jsdom has no layout engine;
     * `h-11` IS 2.75rem. Not the cloak-class exception QA barred — that rule
     * is about `CARDS_ONLY` / `TABLE_ONLY`, which are inert here and encode
     * a mechanism; a tap target's size is an outcome.
     */
    render(
      <Harness
        mobile={{
          ...MOBILE,
          rowActions: () => [{ id: 'open', icon: null, label: 'Open', onClick: () => {} }],
        }}
      />,
    );
    const kebab = screen.getAllByRole('button', { name: 'Row actions' })[0];
    expect(kebab).toHaveClass('h-11', 'w-11');
    expect(kebab).not.toHaveClass('h-6', 'w-6');
    // No redundant tap-box wrapper left behind.
    expect(kebab?.parentElement).not.toHaveClass('h-11');
  });

  it('renders no selection checkbox on `selectable` alone', () => {
    // Ruling: selection on a card needs a SECOND, card-scoped opt-in. A page
    // that ticks rows with no bulk bar sized for 360px has a dead control.
    render(<Harness selectable />);
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });

  it('renders the selection checkbox when the page opts in for cards too', () => {
    render(<Harness selectable mobile={{ ...MOBILE, selectable: true }} />);
    expect(screen.getAllByRole('checkbox', { name: 'Select row' })).toHaveLength(2);
  });
});

describe('<DataTable> card infinite-scroll sentinel', () => {
  /**
   * QA's top silent risk, pinned.
   *
   * The table roots its `IntersectionObserver` at `<Scroll2D>` via
   * `scrollRef`. The card tree does not render `<Scroll2D>`, so before this
   * phase the ref was never attached and `root` fell back to the viewport —
   * an observer rooted at a viewport the sentinel is not laid out against
   * either fires on the first frame and pulls every page at once, or never
   * fires and pagination stops with no symptom.
   *
   * jsdom has no `IntersectionObserver`, so the stub that captures the
   * constructor's `root` IS the test.
   */
  function stubIntersectionObserver() {
    const roots: Array<Element | Document | null> = [];
    class Stub {
      constructor(_cb: IntersectionObserverCallback, options?: IntersectionObserverInit) {
        roots.push((options?.root as Element | null) ?? null);
      }
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords() {
        return [];
      }
    }
    vi.stubGlobal('IntersectionObserver', Stub);
    return roots;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('roots the observer at the card list scroll container, not at a dead ref', () => {
    const roots = stubIntersectionObserver();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    render(<Harness onLoadMore={() => {}} hasNextPage />);

    expect(roots).toHaveLength(1);
    const root = roots[0];
    // A real element, not the viewport — and specifically the element the
    // card list lives inside, so the observer can actually see the sentinel.
    // Asserted by containment rather than by class or DOM position, so this
    // survives any restyling of the wrapper.
    expect(root).toBeInstanceOf(HTMLElement);
    expect((root as HTMLElement).contains(screen.getByRole('list'))).toBe(true);

    // And the unattached-ref alarm did NOT fire — if it had, `root` would be
    // null and pagination would be silently broken.
    expect(warn).not.toHaveBeenCalled();
  });

  it('renders no sentinel when the consumer disabled infinite scroll', () => {
    const roots = stubIntersectionObserver();
    render(<Harness />);
    expect(roots).toHaveLength(0);
  });
});

describe('<DataTable> card dev warnings', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('names the column when a field cell renders interactive content', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cols: ColumnDef<Row, Col>[] = COLS.map((c) =>
      c.id === 'project'
        ? {
            ...c,
            cell: (r: Row) => (
              <button type="button" onClick={() => {}}>
                {r.project}
              </button>
            ),
          }
        : c,
    );
    render(<Harness columns={cols} />);

    const messages = warn.mock.calls.map((c) => String(c[0]));
    expect(messages.some((m) => m.includes('"project"'))).toBe(true);
    // ONE warning for the column, not one per card — the column is the unit
    // of repair, so it is the unit of reporting.
    expect(messages.filter((m) => m.includes('"project"'))).toHaveLength(1);
  });

  it('stays silent for a card whose slots are all plain values', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    render(<Harness />);
    expect(warn).not.toHaveBeenCalled();
  });

  it('does not mistake the title’s own row-open button for cell content', () => {
    // `onRowClick` wraps the title in a button; the dev scan must look
    // INSIDE the slot, not at the affordance the card put around it.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    render(<Harness onRowClick={() => {}} />);
    expect(warn).not.toHaveBeenCalled();
  });

  it('stays silent when a click-less card’s title column is the link into the row', () => {
    // The shape `/dashboard` is about to ship: no `onRowClick`, so the title
    // column renders the anchor that opens the row, and the title slot floors
    // that anchor at 44px. It is the card's tap target, not a control nested
    // inside one — warning about it would be asking the author to delete the
    // only navigation the card has.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cols: ColumnDef<Row, Col>[] = COLS.map((c) =>
      c.id === 'name' ? { ...c, cell: (r: Row) => <a href={`/rows/${r.id}`}>{r.name}</a> } : c,
    );
    render(<Harness columns={cols} />);
    expect(warn).not.toHaveBeenCalled();
  });

  it('still names the title column when a click-less card puts a button in it', () => {
    // The exemption is navigation only. A <button> in the title is an action,
    // and an action belongs in `mobile.rowActions`, where the card builds it a
    // 44px trigger of its own instead of letting it share the title's.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cols: ColumnDef<Row, Col>[] = COLS.map((c) =>
      c.id === 'name'
        ? {
            ...c,
            cell: (r: Row) => (
              <button type="button" onClick={() => {}}>
                {r.name}
              </button>
            ),
          }
        : c,
    );
    render(<Harness columns={cols} />);

    const messages = warn.mock.calls.map((c) => String(c[0]));
    expect(messages.some((m) => m.includes('card title column "name"'))).toBe(true);
  });

  it('names the offending id when mobile.title is not one of the columns', () => {
    // The fallback keeps the cards named (see the anatomy suite); the
    // warning is what tells the author their headline is a column they did
    // not choose, which is otherwise invisible on a desktop review.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cols = COLS.filter((c) => c.id !== 'name');
    render(<Harness columns={cols} mobile={{ ...MOBILE, title: 'name' }} />);
    const messages = warn.mock.calls.map((c) => String(c[0]));
    expect(messages.some((m) => m.includes('mobile.title names column "name"'))).toBe(true);
    // Once per offending id, not once per card.
    expect(messages.filter((m) => m.includes('mobile.title names column'))).toHaveLength(1);
  });

  it('warns when mobile.fields exceeds the three the card can carry', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    render(<Harness mobile={{ ...MOBILE, fields: ['amount', 'project', 'merchant', 'status'] }} />);
    const messages = warn.mock.calls.map((c) => String(c[0]));
    expect(messages.some((m) => m.includes('mobile.fields lists 4 columns'))).toBe(true);
  });
});

describe('<DataTable> card accessibility', () => {
  it('has no axe violations on a populated card list', async () => {
    const { container } = render(
      <Harness
        onRowClick={() => {}}
        selectable
        mobile={{
          ...MOBILE,
          selectable: true,
          rowActions: () => [{ id: 'open', icon: null, label: 'Open', onClick: () => {} }],
        }}
      />,
    );
    const results = await axe(container);
    // Asserted on the violation list rather than through `toHaveNoViolations`
    // so the expectation type-checks under Vitest's `expect` (jest-axe ships
    // its matcher declaration against the Jest namespace). The rule ids are
    // what a failure needs to name anyway.
    expect(results.violations.map((v) => v.id)).toEqual([]);
  });

  it('has no axe violations on the empty face', async () => {
    const { container } = render(<Harness rows={[]} />);
    const results = await axe(container);
    expect(results.violations.map((v) => v.id)).toEqual([]);
  });
});

describe('<DataTable> grouped cards', () => {
  /**
   * Grouping in card mode, drawn from the SAME `groupRows` partition the
   * table's `<GroupHeaderRow>`s are drawn from. What is worth pinning here is
   * not the partition — `groupRows.test.ts` owns that — but the two things
   * only this tree decides: the shape the groups take in a list, and whether
   * the header a thumb has to hit is actually hittable.
   */
  function grouped(props: HarnessProps = {}) {
    const { initial, groupKeyFor, groupLabelFor, ...rest } = props;
    return render(
      <Harness
        {...rest}
        initial={{ groupBy: 'status', ...initial }}
        groupKeyFor={groupKeyFor ?? ((r) => r.status)}
        groupLabelFor={groupLabelFor ?? ((k) => k)}
      />,
    );
  }

  it('renders one region per group, each named by its label', () => {
    grouped();
    expect(screen.getByRole('region', { name: 'Approved' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Pending' })).toBeInTheDocument();
  });

  it('gives each group its OWN list, so the item count is the group’s', () => {
    /**
     * Not one flat list with header items wedged between the cards. A group
     * header is not a list item, and smuggling it in as one makes every
     * "list, N items" count wrong by the number of groups — which is the
     * summary a screen-reader user navigates a card list by.
     */
    grouped();
    expect(screen.getAllByRole('list')).toHaveLength(2);
    for (const list of screen.getAllByRole('list')) {
      expect(within(list).getAllByRole('listitem')).toHaveLength(1);
    }
  });

  it('is a 44px tap target, and the whole bar is the target', () => {
    // jsdom has no layout engine, so the class IS the size here — the same
    // way the sheet triggers are pinned in the design system.
    grouped();
    const header = screen.getByRole('button', { name: /Approved/ });
    expect(header).toHaveClass('min-h-11');
    expect(header).toHaveClass('w-full');
  });

  it('reports its own state through aria-expanded, and collapses on tap', async () => {
    grouped();
    const header = screen.getByRole('button', { name: /Approved/ });
    expect(header).toHaveAttribute('aria-expanded', 'true');
    await userEvent.click(header);
    expect(screen.getByRole('button', { name: /Approved/ })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    // The header stays and the cards go — the header alone documents that the
    // group exists, exactly as the table's collapsed group does.
    expect(screen.getByRole('region', { name: 'Approved' })).toBeInTheDocument();
    expect(screen.queryByRole('listitem', { name: 'Q3 travel' })).not.toBeInTheDocument();
    expect(screen.getByRole('listitem', { name: 'Client dinner' })).toBeInTheDocument();
  });

  it('opens a group that arrived collapsed from the desktop', async () => {
    /**
     * The reason the collapse toggle is a write seam at all. A group
     * collapsed on a desktop survives the breakpoint flip in `state`, and an
     * inert header would leave the reader looking at a bar over rows they
     * cannot reach.
     */
    grouped({ initial: { collapsedGroups: new Set(['Approved']) } });
    expect(screen.queryByRole('listitem', { name: 'Q3 travel' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Approved/ }));
    expect(screen.getByRole('listitem', { name: 'Q3 travel' })).toBeInTheDocument();
  });

  it('formats the count through groupCountLabel, and falls back to the number', () => {
    // Asserted inside the header rather than as its accessible NAME:
    // `dom-accessibility-api` concatenates adjacent inline children with no
    // separator, so the name it computes here is "Approved1 items" while a
    // real browser inserts the boundary space. Pinning the library's
    // concatenation would be pinning the wrong thing — what matters is that
    // the consumer's formatter is what renders, and that the fallback is the
    // bare number the table also falls back to.
    grouped({ groupCountLabel: (n) => `${n} items` });
    expect(
      within(screen.getByRole('button', { name: /Approved/ })).getByText('1 items'),
    ).toBeInTheDocument();
    cleanup();
    grouped();
    expect(
      within(screen.getByRole('button', { name: /Approved/ })).getByText('1'),
    ).toBeInTheDocument();
  });

  it('still draws whole cards — grouping changes the frame, not the card', () => {
    grouped();
    const card = cardNamed('Q3 travel');
    expect(card).toHaveTextContent('Ada Lovelace'); // subtitle
    expect(card).toHaveTextContent('$120.00'); // field
    expect(card).toHaveTextContent('Approved'); // badge
  });

  it('has no axe violations grouped', async () => {
    const { container } = grouped();
    const results = await axe(container);
    expect(results.violations.map((v) => v.id)).toEqual([]);
  });
});

describe('<DataTable> card cell context', () => {
  it('tells the cell it is being drawn as a card', () => {
    /**
     * `ctx.compact` is the seam a cell that embeds a control beside its value
     * uses to drop it — the identity column's row kebab is the one in the
     * product, and in a card it would be a second, 24px menu beside the
     * card's own 44px one. The table leaves it undefined.
     */
    const seen: Array<boolean | undefined> = [];
    const cols: ColumnDef<Row, Col>[] = COLS.map((c) =>
      c.id === 'name'
        ? {
            ...c,
            cell: (r, ctx) => {
              seen.push(ctx.compact);
              return r.name;
            },
          }
        : c,
    );
    render(<Harness columns={cols} />);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((v) => v === true)).toBe(true);
  });
});

/**
 * WHICH TREE MOUNTS, given the opt-in.
 *
 * These belong next to `DataTable.layout.test.tsx`, which owns "which tree
 * mounts" as a subject — and they are here instead because that file is
 * pinned byte-identical for this epic. They are about the card CONFIG, which
 * is this file's subject, so the seam is defensible either way.
 *
 * The rule: cards are per-page opt-in. `layout: 'auto'` on a narrow viewport
 * reaches the card tree only when `mobile` names the card's columns; without
 * it the table keeps its horizontal scroller. Ungated, every unconfigured
 * listing in the product rendered one column per card below 768px and
 * dropped the rest — silently, and with no gesture that could reach them.
 */
describe('<DataTable> card mode is opt-in', () => {
  function stubMatchMedia(compact: boolean) {
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

  /** `layout` is not on `HarnessProps`, and `Harness` substitutes `MOBILE`
   *  whenever `mobile` is omitted — which is exactly the state these tests
   *  need to be able to produce. So this block drives `<DataTable>` directly. */
  function Auto(props: { mobile?: DataTableMobileConfig<Row, Col>; layout?: 'auto' | 'cards' }) {
    const [state, setState] = useState<DataTableState<Col>>(() =>
      createDataTableState(COLS as never, {}),
    );
    return (
      <DataTable<Row, Col>
        layout={props.layout ?? 'auto'}
        columns={COLS}
        rows={ROWS}
        rowKey={(r) => r.id}
        state={state}
        onStateChange={setState}
        labels={LABELS}
        mobile={props.mobile}
        disableInfiniteScroll
      />
    );
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps the TABLE on a narrow viewport when the page has not opted in', () => {
    /**
     * Done-when 3: "a table without it falls back to a horizontal scroll
     * container, never overflowing the page." The scroller is the table tree
     * inside `<Scroll2D>`; what is assertable in jsdom is that the table is
     * what mounted, and that no card list did.
     */
    stubMatchMedia(true);
    render(<Auto />);
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
    // Every column is still on screen — the loss this gate exists to stop.
    for (const col of COLS) {
      expect(screen.getByRole('columnheader', { name: col.label })).toBeInTheDocument();
    }
  });

  it('mounts cards on a narrow viewport once the page HAS opted in', () => {
    stubMatchMedia(true);
    render(<Auto mobile={MOBILE} />);
    expect(screen.getByRole('list')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('keeps the table at desktop width even with a config', () => {
    stubMatchMedia(false);
    render(<Auto mobile={MOBILE} />);
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
  });

  it('judges the opt-in on `title`, not on a non-empty `fields`', () => {
    // An empty field list is legal and documented — every configured column
    // hidden by the reader leaves a title-and-badge card. Dropping such a
    // page back to the table would punish it for exercising a setting.
    stubMatchMedia(true);
    render(<Auto mobile={{ title: 'name', fields: [] }} />);
    expect(screen.getByRole('list')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('still lets layout="cards" force the card tree with no config at all', () => {
    /**
     * The explicit request wins over the opt-in gate: `'cards'` means "this
     * surface is card-shaped at every width", and the fallback title exists
     * precisely to keep it rendering something recognisable. The card stories
     * and most of this file depend on it.
     */
    stubMatchMedia(false);
    render(<Auto layout="cards" />);
    expect(screen.getByRole('list')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });
});
