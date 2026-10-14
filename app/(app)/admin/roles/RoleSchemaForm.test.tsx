import '@testing-library/jest-dom/vitest';
import type { WidgetProps } from '@rjsf/utils';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { moduleOf, PermissionsWidget } from './RoleSchemaForm';

/**
 * The permission picker behind the Role Builder.
 *
 * A role is a list of permission codes and there are hundreds of them, so the picker is
 * the only thing standing between an admin and a role assembled by accident. Three
 * properties make it usable, and each is a way of being wrong:
 *
 *   · **Grouped by module, sorted inside each group.** An unsorted flat list of three
 *     hundred codes is a list nobody audits, and a role nobody audits is a role that
 *     quietly grants `admin.*`.
 *   · **The emitted array is sorted.** It is compared against what was stored to decide
 *     whether anything changed; an order that depends on click sequence makes an untouched
 *     role look edited every time it is opened.
 *   · **Select-all and Clear are scoped to ONE module** and disabled when they would do
 *     nothing — a "Select all" that grants every permission in the product is one click
 *     from a superuser.
 */

const CATALOG = [
  'vcc.card.issue',
  'vcc.card.freeze',
  'admin.user.read',
  'admin.role.update',
  'expense.submit',
];

function renderWidget(over: Record<string, unknown> = {}) {
  const onChange = vi.fn();
  // Built as an object and cast once: `{...(… as never)}` is not spreadable, and the real
  // WidgetProps carries twenty RJSF fields this widget never reads.
  const props = {
    value: [],
    onChange,
    options: { catalog: CATALOG, selectAllLabel: 'All', clearAllLabel: 'None' },
    ...over,
  } as unknown as WidgetProps;
  render(<PermissionsWidget {...props} />);
  return { onChange };
}

/**
 * The fieldset for one module, found by its heading.
 *
 * `getAllBy`, because the heading nests a span for the count inside the one holding the
 * module name, so both normalise to the module text. They are in the same fieldset, so
 * either match resolves to the same group.
 */
const groupOf = (mod: string) => {
  const heading = screen.getAllByText(mod)[0];
  return (heading.closest('fieldset') ?? heading.closest('div')) as HTMLElement;
};

describe('moduleOf', () => {
  it('buckets a code by its first segment', () => {
    expect(moduleOf('vcc.card.issue')).toBe('vcc');
  });

  it('treats a code with no dot as its own module', () => {
    /** A permission that has not been namespaced yet still has to land somewhere; dropping
     *  it would make it unreachable in the picker and so ungrantable. */
    expect(moduleOf('legacy')).toBe('legacy');
  });
});

describe('how the catalog is laid out', () => {
  it('groups by module and counts what is granted in each', async () => {
    renderWidget({ value: ['vcc.card.issue'] });
    expect(groupOf('vcc')).toBeInTheDocument();
    expect(groupOf('admin')).toBeInTheDocument();
    // One of vcc's two granted; the count is per module, not for the whole catalog.
    // `getAllBy` because the count text matches at two nesting levels of the heading.
    expect(within(groupOf('vcc')).getAllByText('(1 / 2)').length).toBeGreaterThan(0);
    expect(within(groupOf('admin')).getAllByText('(0 / 2)').length).toBeGreaterThan(0);
  });

  it('states the overall total, so a role’s size is visible at a glance', async () => {
    /** "247 / 312" is the difference between a role somebody reviewed and a role somebody
     *  accepted. */
    renderWidget({ value: ['vcc.card.issue', 'expense.submit'] });
    expect(screen.getByText('2 / 5')).toBeInTheDocument();
  });

  it('renders every code in the catalog', async () => {
    renderWidget();
    for (const code of CATALOG) expect(screen.getByText(code)).toBeInTheDocument();
  });

  it('survives a value that is not an array', async () => {
    /** RJSF hands back whatever the form data holds, and a role saved before the field
     *  existed has `undefined` there. Throwing would take the whole builder down. */
    expect(() => renderWidget({ value: undefined })).not.toThrow();
    expect(screen.getByText('0 / 5')).toBeInTheDocument();
  });
});

describe('picking permissions', () => {
  it('adds a code, sorted', async () => {
    /** The emitted array is compared against what was stored; an order that depends on
     *  click sequence makes an untouched role look edited every time it is opened. */
    const user = userEvent.setup();
    const { onChange } = renderWidget({ value: ['vcc.card.issue'] });
    await user.click(screen.getByText('admin.role.update'));
    expect(onChange).toHaveBeenCalledWith(['admin.role.update', 'vcc.card.issue']);
  });

  it('removes a code that was already granted', async () => {
    const user = userEvent.setup();
    const { onChange } = renderWidget({ value: ['vcc.card.issue', 'expense.submit'] });
    await user.click(screen.getByText('vcc.card.issue'));
    expect(onChange).toHaveBeenCalledWith(['expense.submit']);
  });

  it('grants a whole module without touching the others', async () => {
    /** Scoped on purpose: a "Select all" that granted every permission in the product is
     *  one click from a superuser nobody meant to create. */
    const user = userEvent.setup();
    const { onChange } = renderWidget({ value: ['expense.submit'] });
    await user.click(within(groupOf('vcc')).getByRole('button', { name: 'All' }));
    expect(onChange).toHaveBeenCalledWith(['expense.submit', 'vcc.card.freeze', 'vcc.card.issue']);
  });

  it('clears a whole module without touching the others', async () => {
    const user = userEvent.setup();
    const { onChange } = renderWidget({
      value: ['vcc.card.issue', 'vcc.card.freeze', 'expense.submit'],
    });
    await user.click(within(groupOf('vcc')).getByRole('button', { name: 'None' }));
    expect(onChange).toHaveBeenCalledWith(['expense.submit']);
  });

  it('disables Select-all once the module is fully granted', async () => {
    /** A live button that does nothing invites a second look at whether it worked. */
    renderWidget({ value: ['vcc.card.issue', 'vcc.card.freeze'] });
    expect(within(groupOf('vcc')).getByRole('button', { name: 'All' })).toBeDisabled();
    expect(within(groupOf('vcc')).getByRole('button', { name: 'None' })).toBeEnabled();
  });

  it('disables Clear when the module grants nothing', async () => {
    renderWidget({ value: [] });
    expect(within(groupOf('vcc')).getByRole('button', { name: 'None' })).toBeDisabled();
    expect(within(groupOf('vcc')).getByRole('button', { name: 'All' })).toBeEnabled();
  });
});

describe('a role somebody may only read', () => {
  it('offers no bulk actions', async () => {
    renderWidget({ readonly: true, value: ['vcc.card.issue'] });
    expect(within(groupOf('vcc')).getByRole('button', { name: 'All' })).toBeDisabled();
    expect(within(groupOf('vcc')).getByRole('button', { name: 'None' })).toBeDisabled();
  });

  it('shows the grants but does not let them be changed', async () => {
    /** A seeded role is readable by design — seeing what "AP Clerk" grants is how somebody
     *  decides whether to copy it. */
    renderWidget({ disabled: true, value: ['vcc.card.issue'] });
    for (const box of screen.getAllByRole('checkbox')) {
      expect(box).toHaveAttribute('aria-disabled', 'true');
    }
    expect(screen.getByText('vcc.card.issue')).toBeInTheDocument();
  });
});
