import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { DataTableToolbar } from './DataTableToolbar';

/**
 * The toolbar's layout is a rule the component enforces, so what's worth
 * pinning is the rule itself: the actions trigger is absent (not greyed) with
 * nothing selected, it counts the selection when it appears, the row count
 * carries no entity noun, and the left-to-right order doesn't drift.
 */

const ACTIONS = [{ id: 'a', label: 'Deactivate', onSelect: () => {} }];

describe('<DataTableToolbar>', () => {
  it('renders no actions trigger while nothing is selected', () => {
    render(<DataTableToolbar bulkActions={ACTIONS} selectedCount={0} resultCount={12} />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('shows the trigger, counting the selection, as soon as rows are selected', () => {
    render(<DataTableToolbar bulkActions={ACTIONS} selectedCount={3} resultCount={12} />);
    const trigger = screen.getByRole('button');
    expect(trigger).toHaveTextContent('3 selected');
    expect(trigger).toBeEnabled();
  });

  it('never says "Actions" — the count belongs on the control it applies to', () => {
    render(<DataTableToolbar bulkActions={ACTIONS} selectedCount={1} resultCount={4} />);
    expect(screen.queryByText('Actions')).not.toBeInTheDocument();
  });

  it('states the row count without an entity noun', () => {
    render(<DataTableToolbar resultCount={12} />);
    expect(screen.getByText('12 results')).toBeInTheDocument();
  });

  it("takes the host app's copy for both", () => {
    render(
      <DataTableToolbar
        bulkActions={ACTIONS}
        selectedCount={2}
        resultCount={7}
        bulkActionsLabel={(n) => `${n} sélectionné(s)`}
        resultLabel={(n) => `${n} résultats`}
      />,
    );
    expect(screen.getByText('7 résultats')).toBeInTheDocument();
    expect(screen.getByRole('button')).toHaveTextContent('2 sélectionné(s)');
  });

  it('orders the left cluster select-all → actions, so the checkbox owns what follows it', () => {
    render(
      <DataTableToolbar
        selectAllSlot={<input type="checkbox" aria-label="select all" />}
        bulkActions={ACTIONS}
        selectedCount={2}
      />,
    );
    const box = screen.getByLabelText('select all');
    const trigger = screen.getByRole('button');
    // Node order in the document, not visual order — the flex row follows it.
    expect(box.compareDocumentPosition(trigger)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it('replaces the count with the loading placeholder, not both', () => {
    render(<DataTableToolbar resultCount={12} loading loadingLabel="Loading…" />);
    expect(screen.getByText('Loading…')).toBeInTheDocument();
    expect(screen.queryByText('12 results')).not.toBeInTheDocument();
  });

  it('opens the action list from the trigger', async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(
      <DataTableToolbar
        bulkActions={[{ id: 'a', label: 'Deactivate', onSelect }]}
        selectedCount={2}
      />,
    );
    await user.click(screen.getByRole('button'));
    await user.click(await screen.findByText('Deactivate'));
    expect(onSelect).toHaveBeenCalledOnce();
  });

  it('honours a forced disable while an outer mutation is pending', () => {
    render(<DataTableToolbar bulkActions={ACTIONS} selectedCount={2} bulkActionsDisabled />);
    expect(screen.getByRole('button')).toBeDisabled();
  });

  /**
   * A CLASS PIN, and a deliberate one — jsdom has no layout, so this cannot assert that
   * the toolbar stops overflowing at 360px. What it can assert is that the three classes
   * that make it stop are still on the three boxes they were put on.
   *
   * It earns its place because of who this component belongs to. `DataTableToolbar` ships
   * from `@expenseos/design-system` to roughly thirty listing pages with no semver gate
   * between them — a workspace import resolved from source, so a class removed here is
   * live everywhere on the next build, and the only thing that would notice is a phone
   * viewport in an e2e run on one of those thirty routes. Same argument as the
   * `max-lg:hidden` pin in `Sidebar.test.tsx`.
   *
   * It lives beside the component rather than in `packages/design-system/tests/` because
   * every other assertion about this component's own markup already does, and splitting
   * one file's pins across two directories is how a reader stops finding them.
   *
   * The measurements, the reason it is a wrap rather than a scroll container, and the two
   * costs it accepts are in the comment above the row in `DataTableToolbar.tsx`. If this
   * fails, read that before deleting the class.
   */
  it('wraps below lg on the row and on both groups, so nothing is squeezed or cut', () => {
    const { container } = render(
      <DataTableToolbar
        selectAllSlot={<input type="checkbox" aria-label="select all" />}
        bulkActions={ACTIONS}
        selectedCount={2}
        resultCount={12}
        rightSlot={<button type="button">Export</button>}
      />,
    );
    const row = container.querySelector('div.min-h-10') as HTMLElement;
    expect(row).toBeInTheDocument();
    expect(row).toHaveClass('max-lg:flex-wrap');

    const [leading, trailing] = Array.from(row.children) as HTMLElement[];
    expect(leading).toHaveClass('max-lg:flex-wrap');
    expect(trailing).toHaveClass('max-lg:flex-wrap');

    // `max-lg:` and not `lg:` — the desktop toolbar is unchanged by this, and a plain
    // `flex-wrap` would re-flow the 1280px layout nobody asked to change.
    expect(row.className).not.toMatch(/(^|\s)flex-wrap(\s|$)/);
    expect(trailing.className).not.toMatch(/(^|\s)flex-wrap(\s|$)/);

    // Not a scroll container, on any of the three: an `overflow-*` here clips the menus
    // that `leftSlot` / `rightSlot` callers mount unportalled inside it.
    for (const el of [row, leading, trailing]) {
      expect(el.className).not.toMatch(/overflow-/);
    }
  });
});
