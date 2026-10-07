import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { Tooltip } from './tooltip';

/**
 * VeloExpense: ExpenseOS's `<Tooltip content>` call shape on the kit's Radix parts. Two ported
 * Expense-categories cells use it with `asChild`; both shapes must show the content on focus,
 * which is how a keyboard reader gets it.
 */
describe('Tooltip (ExpenseOS API on the kit)', () => {
  it('wraps plain children in its own trigger and shows the content on focus', async () => {
    render(<Tooltip content="Explained">?</Tooltip>);
    const trigger = screen.getByText('?');
    await userEvent.tab();
    expect(trigger.closest('button')).toHaveFocus();
    expect((await screen.findAllByText('Explained')).length).toBeGreaterThan(0);
  });

  it('with asChild, uses the child itself as the trigger', async () => {
    render(
      <Tooltip asChild content="Disagrees">
        <button type="button">warn</button>
      </Tooltip>,
    );
    const button = screen.getByRole('button', { name: 'warn' });
    expect(button.parentElement?.tagName).not.toBe('BUTTON');
    await userEvent.tab();
    expect(button).toHaveFocus();
    expect((await screen.findAllByText('Disagrees')).length).toBeGreaterThan(0);
  });
});
