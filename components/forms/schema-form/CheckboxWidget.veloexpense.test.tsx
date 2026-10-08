import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { SchemaForm } from '.';

/**
 * VeloExpense: the schema form's yes/no field must be NAMED. Not in ExpenseOS.
 *
 * Base UI renders the box as a <span role="checkbox"> with an id of its own, so the
 * Field's <label for={id}> labels nothing; the admin-lookup drawers' "Active" and
 * "Reclaims ITCs" were checkboxes with no accessible name. The kit's CheckboxWidget now
 * names the box with the schema title (lib-ui-kit, "VeloExpense kit:").
 */
describe('a boolean field', () => {
  it('is a checkbox named by its title, and toggles', async () => {
    const onChange = vi.fn();
    render(
      <SchemaForm
        schema={{ type: 'object', properties: { active: { type: 'boolean', title: 'Active' } } }}
        uiSchema={{ 'ui:submitButtonOptions': { norender: true } }}
        formData={{ active: true }}
        onChange={onChange}
        onSubmit={() => {}}
      />,
    );
    const box = screen.getByRole('checkbox', { name: 'Active' });
    expect(box).toBeChecked();
    await userEvent.click(box);
    expect(onChange).toHaveBeenLastCalledWith({ active: false });
  });
});
