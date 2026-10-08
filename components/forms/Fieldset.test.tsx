import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { Fieldset } from './Fieldset';

/**
 * The "group of related fields" anatomy, which was 6.7% covered.
 *
 * Two of its rules are accessibility contracts rather than styling, and both are the
 * kind that break silently: the group must keep a real `<legend>` so a screen reader
 * announces what the fields belong to, and collapsing must never hide validation
 * problems — a collapsed group whose errors went with it is a form that cannot be
 * submitted and will not say why.
 */

describe('accessible name', () => {
  it('keeps a real legend even though the visible title is a styled row', () => {
    // The legend is sr-only; removing it in favour of the styled header would leave the
    // group unnamed for anybody not looking at it.
    render(
      <Fieldset title="Tax posting">
        <input aria-label="gst" />
      </Fieldset>,
    );
    const legend = document.querySelector('legend');
    expect(legend?.textContent).toBe('Tax posting');
  });

  it('labels the fieldset by its legend', () => {
    render(
      <Fieldset title="Tax posting">
        <input aria-label="gst" />
      </Fieldset>,
    );
    const fs = document.querySelector('fieldset') as HTMLElement;
    const legend = document.querySelector('legend') as HTMLElement;
    // aria-labelledby points at the id the title span carries, not at the legend node.
    expect(fs.getAttribute('aria-labelledby')).toBeTruthy();
    expect(legend).toBeInTheDocument();
  });

  it('renders no legend when there is no title', () => {
    // Array-of-objects items have no title; an empty legend would announce nothing.
    render(
      <Fieldset>
        <input aria-label="x" />
      </Fieldset>,
    );
    expect(document.querySelector('legend')).toBeNull();
    expect(document.querySelector('fieldset')?.getAttribute('aria-labelledby')).toBeNull();
  });
});

describe('collapsing', () => {
  it('is expanded on mount by default', () => {
    render(
      <Fieldset title="Advanced" collapsible>
        <input aria-label="inner" />
      </Fieldset>,
    );
    expect(screen.getByLabelText('inner')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Advanced/ })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });

  it('honours defaultCollapsed', () => {
    render(
      <Fieldset title="Advanced" collapsible defaultCollapsed>
        <input aria-label="inner" />
      </Fieldset>,
    );
    expect(screen.queryByLabelText('inner')).not.toBeInTheDocument();
  });

  it('toggles the body and reports state through aria-expanded', async () => {
    render(
      <Fieldset title="Advanced" collapsible>
        <input aria-label="inner" />
      </Fieldset>,
    );
    const toggle = screen.getByRole('button', { name: /Advanced/ });
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByLabelText('inner')).not.toBeInTheDocument();
    await userEvent.click(toggle);
    expect(screen.getByLabelText('inner')).toBeInTheDocument();
  });

  it('has no toggle at all when it is not collapsible', () => {
    render(
      <Fieldset title="Plain">
        <input aria-label="inner" />
      </Fieldset>,
    );
    expect(screen.queryByRole('button', { name: /Plain/ })).not.toBeInTheDocument();
  });
});

describe('errors', () => {
  it('shows group errors', () => {
    render(
      <Fieldset title="Scope" errors={['Pick at least one business unit']}>
        <input aria-label="x" />
      </Fieldset>,
    );
    expect(screen.getByText('Pick at least one business unit')).toBeInTheDocument();
  });

  it('keeps errors visible while collapsed', () => {
    /**
     * The rule that matters. Errors live OUTSIDE the collapsible body on purpose:
     * collapsing a group must never hide a validation problem, or the form refuses to
     * submit with nothing on screen explaining it.
     */
    render(
      <Fieldset title="Scope" collapsible defaultCollapsed errors={['Required']}>
        <input aria-label="inner" />
      </Fieldset>,
    );
    expect(screen.queryByLabelText('inner')).not.toBeInTheDocument();
    expect(screen.getByText('Required')).toBeInTheDocument();
  });

  it('renders nothing for an empty error list', () => {
    const { container } = render(
      <Fieldset title="Scope" errors={[]}>
        <input aria-label="x" />
      </Fieldset>,
    );
    expect(container.querySelector('ul')).toBeNull();
  });
});

describe('description', () => {
  it('stays visible when collapsed by default', () => {
    // It is usually the cue for whether to expand at all.
    render(
      <Fieldset title="Advanced" description="Rarely needed" collapsible defaultCollapsed>
        <input aria-label="inner" />
      </Fieldset>,
    );
    expect(screen.getByText('Rarely needed')).toBeInTheDocument();
  });

  it('can be hidden when collapsed on request', () => {
    render(
      <Fieldset
        title="Advanced"
        description="Rarely needed"
        collapsible
        defaultCollapsed
        hideDescriptionWhenCollapsed
      >
        <input aria-label="inner" />
      </Fieldset>,
    );
    expect(screen.queryByText('Rarely needed')).not.toBeInTheDocument();
  });

  it('reappears when expanded', async () => {
    render(
      <Fieldset
        title="Advanced"
        description="Rarely needed"
        collapsible
        defaultCollapsed
        hideDescriptionWhenCollapsed
      >
        <input aria-label="inner" />
      </Fieldset>,
    );
    await userEvent.click(screen.getByRole('button', { name: /Advanced/ }));
    expect(screen.getByText('Rarely needed')).toBeInTheDocument();
  });
});

describe('chrome', () => {
  it('draws a card border by default and none when flat', () => {
    const { container, unmount } = render(
      <Fieldset title="T">
        <input aria-label="x" />
      </Fieldset>,
    );
    expect(container.querySelector('fieldset')?.className).toContain('border-border');
    unmount();
    // `flat` blends into surrounding chrome — a Drawer that already has a border.
    const flat = render(
      <Fieldset title="T" variant="flat">
        <input aria-label="x" />
      </Fieldset>,
    );
    expect(flat.container.querySelector('fieldset')?.className).not.toContain('border-border');
  });

  it('marks a required group', () => {
    render(
      <Fieldset title="Scope" required>
        <input aria-label="x" />
      </Fieldset>,
    );
    expect(screen.getByText('(required)')).toBeInTheDocument();
  });

  it('renders an actions slot', () => {
    render(
      <Fieldset title="Item" actions={<button type="button">Remove</button>}>
        <input aria-label="x" />
      </Fieldset>,
    );
    expect(screen.getByRole('button', { name: 'Remove' })).toBeInTheDocument();
  });

  it('renders a tooltip trigger when given help text', () => {
    render(
      <Fieldset title="Scope" tooltip="Which entities this applies to">
        <input aria-label="x" />
      </Fieldset>,
    );
    expect(screen.getByLabelText('More information')).toBeInTheDocument();
  });
});
