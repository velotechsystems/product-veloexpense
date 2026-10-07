import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ScopeChip } from './ScopeChip';

/**
 * The high-level scope selector that filters BEFORE facet filters apply.
 *
 * Its one non-obvious rule is self-suppression: with a single available scope there is
 * nothing to switch between, so the chip renders nothing rather than a dead control. That
 * is what keeps "mine / team / all" from showing a stuck "Mine" chip to somebody whose
 * role only ever sees their own records.
 */

const label = (s: string) => ({ mine: 'Mine', team: 'My team', all: 'All' })[s] ?? s;

describe('self-suppression', () => {
  it('renders nothing when only one scope is available', () => {
    const { container } = render(
      <ScopeChip
        availableScopes={['mine']}
        current="mine"
        onChange={() => {}}
        scopeLabel={label}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when no scope is available', () => {
    const { container } = render(
      <ScopeChip availableScopes={[]} current="mine" onChange={() => {}} scopeLabel={label} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders once there is a choice to make', () => {
    render(
      <ScopeChip
        availableScopes={['mine', 'all']}
        current="mine"
        onChange={() => {}}
        scopeLabel={label}
      />,
    );
    expect(screen.getByRole('button', { name: /Mine/ })).toBeInTheDocument();
  });
});

describe('choosing a scope', () => {
  it('opens on click and lists every available scope', async () => {
    render(
      <ScopeChip
        availableScopes={['mine', 'team', 'all']}
        current="mine"
        onChange={() => {}}
        scopeLabel={label}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: /Mine/ }));
    expect(screen.getByRole('button', { name: /My team/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /All/ })).toBeInTheDocument();
  });

  it('reports the chosen scope and closes', async () => {
    const onChange = vi.fn<(s: string) => void>();
    render(
      <ScopeChip
        availableScopes={['mine', 'team']}
        current="mine"
        onChange={onChange}
        scopeLabel={label}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: /Mine/ }));
    await userEvent.click(screen.getByRole('button', { name: /My team/ }));
    expect(onChange).toHaveBeenCalledWith('team');
    expect(screen.queryByRole('button', { name: /My team/ })).not.toBeInTheDocument();
  });

  it('marks the current scope in the list', async () => {
    render(
      <ScopeChip
        availableScopes={['mine', 'team']}
        current="team"
        onChange={() => {}}
        scopeLabel={label}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: /My team/ }));
    // Two buttons now match "My team" — the trigger and the marked list row.
    const rows = screen.getAllByRole('button', { name: /My team/ });
    expect(rows.some((r) => r.textContent?.includes('●'))).toBe(true);
  });

  it('closes again on a second click of the trigger', async () => {
    render(
      <ScopeChip
        availableScopes={['mine', 'team']}
        current="mine"
        onChange={() => {}}
        scopeLabel={label}
      />,
    );
    const trigger = screen.getByRole('button', { name: /Mine/ });
    await userEvent.click(trigger);
    expect(screen.getByRole('button', { name: /My team/ })).toBeInTheDocument();
    await userEvent.click(trigger);
    expect(screen.queryByRole('button', { name: /My team/ })).not.toBeInTheDocument();
  });

  it('closes when the backdrop is clicked', async () => {
    const { container } = render(
      <ScopeChip
        availableScopes={['mine', 'team']}
        current="mine"
        onChange={() => {}}
        scopeLabel={label}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: /Mine/ }));
    const backdrop = container.querySelector('button.fixed') as HTMLElement;
    await userEvent.click(backdrop);
    expect(screen.queryByRole('button', { name: /My team/ })).not.toBeInTheDocument();
  });
});
