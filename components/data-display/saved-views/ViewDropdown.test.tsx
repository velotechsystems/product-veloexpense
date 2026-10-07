import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { DropdownView } from './types';
import { ViewDropdown } from './ViewDropdown';

/**
 * The saved-view selector, which was at 4.8% branch coverage.
 *
 * Its structure encodes a rule that is easy to lose in a refactor: a SYSTEM view can
 * never be a default and can never be renamed or deleted, so those controls must be
 * absent from its row rather than merely disabled — a delete button on a built-in view
 * is an action with nothing sensible to do. User views get all three, and the pinned
 * ones sort above the rest so somebody's default is the first thing under "My views".
 */

type V = DropdownView<'name' | 'status'>;

const system = (id: string, name: string): V =>
  ({ id, name, kind: 'system', filters: [], scope: undefined }) as unknown as V;
const user = (id: string, name: string, pinned = false): V =>
  ({ id, name, kind: 'user', pinned, filters: [], scope: undefined }) as unknown as V;

function setup(views: V[], activeId = 'all') {
  const handlers = {
    onSelect: vi.fn<(id: string) => void>(),
    onSaveAsNew: vi.fn(),
    onRenameView: vi.fn<(id: string, name: string) => void>(),
    onDeleteView: vi.fn<(id: string, name: string) => void>(),
    onTogglePinned: vi.fn<(id: string) => void>(),
  };
  const utils = render(
    <ViewDropdown views={views} activeId={activeId} activeName="All" {...handlers} />,
  );
  return { ...handlers, ...utils };
}

/** The trigger, addressed positionally — "All" also names a system view row inside the
 *  open menu, so a name query matches two buttons once it is open. */
const trigger = (container: HTMLElement) => container.querySelector('button') as HTMLElement;

const open = async (container: HTMLElement) => {
  await userEvent.click(trigger(container));
};

describe('opening and closing', () => {
  it('starts closed', () => {
    setup([system('all', 'All')]);
    expect(screen.queryByText('Defaults')).not.toBeInTheDocument();
  });

  it('opens on click', async () => {
    const { container } = setup([system('all', 'All')]);
    await open(container);
    expect(screen.getByText('Defaults')).toBeInTheDocument();
  });

  it('closes on a second click', async () => {
    const { container } = setup([system('all', 'All')]);
    await open(container);
    await userEvent.click(trigger(container));
    expect(screen.queryByText('Defaults')).not.toBeInTheDocument();
  });

  it('closes when the backdrop is clicked', async () => {
    const { container } = setup([system('all', 'All')]);
    await open(container);
    await userEvent.click(container.querySelector('button.fixed') as HTMLElement);
    expect(screen.queryByText('Defaults')).not.toBeInTheDocument();
  });
});

describe('sections', () => {
  it('shows only Defaults when there are no user views', async () => {
    const { container } = setup([system('all', 'All')]);
    await open(container);
    expect(screen.getByText('Defaults')).toBeInTheDocument();
    expect(screen.queryByText('My views')).not.toBeInTheDocument();
  });

  it('adds My views once the user has one', async () => {
    const { container } = setup([system('all', 'All'), user('u1', 'Mine')]);
    await open(container);
    expect(screen.getByText('My views')).toBeInTheDocument();
  });

  it('lists pinned user views above unpinned ones', async () => {
    // Somebody's default should be the first thing under "My views".
    const { container } = setup([
      system('all', 'All'),
      user('u1', 'Zeta'),
      user('u2', 'Alpha', true),
    ]);
    await open(container);
    const names = screen.getAllByText(/Zeta|Alpha/).map((n) => n.textContent);
    expect(names).toEqual(['Alpha', 'Zeta']);
  });

  it('always offers a way to save the current filters', async () => {
    const { container, onSaveAsNew } = setup([system('all', 'All')]);
    await open(container);
    await userEvent.click(screen.getByText('Save current as new view'));
    expect(onSaveAsNew).toHaveBeenCalledOnce();
    // …and it closes behind you.
    expect(screen.queryByText('Defaults')).not.toBeInTheDocument();
  });
});

describe('a system view row', () => {
  it('offers no default toggle', async () => {
    // One default per resource, and a built-in cannot be it.
    const { container } = setup([system('all', 'All')]);
    await open(container);
    expect(screen.queryByLabelText('Set as default')).not.toBeInTheDocument();
  });

  it('offers neither rename nor delete', async () => {
    const { container } = setup([system('all', 'All')]);
    await open(container);
    expect(screen.queryByLabelText('Rename')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Delete')).not.toBeInTheDocument();
  });

  it('can still be selected', async () => {
    const { container, onSelect } = setup([system('all', 'All'), system('mine', 'Mine')]);
    await open(container);
    await userEvent.click(screen.getByText('Mine'));
    expect(onSelect).toHaveBeenCalledWith('mine');
  });

  it('closes the menu on selection', async () => {
    const { container } = setup([system('all', 'All'), system('mine', 'Mine')]);
    await open(container);
    await userEvent.click(screen.getByText('Mine'));
    expect(screen.queryByText('Defaults')).not.toBeInTheDocument();
  });
});

describe('a user view row', () => {
  it('offers all three controls', async () => {
    const { container } = setup([system('all', 'All'), user('u1', 'Mine')]);
    await open(container);
    expect(screen.getByLabelText('Set as default')).toBeInTheDocument();
    expect(screen.getByLabelText('Rename')).toBeInTheDocument();
    expect(screen.getByLabelText('Delete')).toBeInTheDocument();
  });

  it('labels the toggle by what clicking it will do', async () => {
    const { container } = setup([system('all', 'All'), user('u1', 'Mine', true)]);
    await open(container);
    expect(screen.getByLabelText('Default view — click to unset')).toBeInTheDocument();
  });

  it('reports a pin toggle without selecting the view', async () => {
    // The click is stopped from propagating on purpose — pinning a view you are not
    // looking at should not navigate you to it.
    const { container, onTogglePinned, onSelect } = setup([
      system('all', 'All'),
      user('u1', 'Mine'),
    ]);
    await open(container);
    await userEvent.click(screen.getByLabelText('Set as default'));
    expect(onTogglePinned).toHaveBeenCalledWith('u1');
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('passes the current name to a rename so the dialog can prefill', async () => {
    const { container, onRenameView, onSelect } = setup([system('all', 'All'), user('u1', 'Mine')]);
    await open(container);
    await userEvent.click(screen.getByLabelText('Rename'));
    expect(onRenameView).toHaveBeenCalledWith('u1', 'Mine');
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('passes the name to a delete so the confirmation can name it', async () => {
    const { container, onDeleteView, onSelect } = setup([system('all', 'All'), user('u1', 'Mine')]);
    await open(container);
    await userEvent.click(screen.getByLabelText('Delete'));
    expect(onDeleteView).toHaveBeenCalledWith('u1', 'Mine');
    expect(onSelect).not.toHaveBeenCalled();
  });
});

describe('the active view', () => {
  it('is marked in the list', async () => {
    const { container } = setup([system('all', 'All'), user('u1', 'Mine')], 'u1');
    await open(container);
    expect(container.textContent).toContain('●');
  });

  it('is marked even when it is a system view', async () => {
    const { container } = setup([system('all', 'All')], 'all');
    await open(container);
    expect(container.textContent).toContain('●');
  });

  it('marks nothing when the active id matches no view', async () => {
    const { container } = setup([system('all', 'All')], 'ghost');
    await open(container);
    expect(container.textContent).not.toContain('●');
  });
});
