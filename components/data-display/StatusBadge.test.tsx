import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { StatusBadge } from './StatusBadge';
import type { WorkflowStatus } from './StatusBadge.types';

/**
 * The report status pill, as the kit colours it (d31).
 *
 * VeloExpense: ExpenseOS has no test for its StatusBadge. The kit's version keeps ExpenseOS's
 * API and maps each state to a kit Badge tone, so what is pinned here is that mapping — a tone
 * swapped by accident (Approved painted as a warning) is the regression that reads as a
 * different status — and that the words are the caller's translated label, never the key.
 */
const TONE_CLASS: Record<WorkflowStatus, string> = {
  Draft: 'bg-muted',
  Submitted: 'bg-primary/10',
  Approved: 'bg-success/10',
  Returned: 'bg-warning/10',
  Rejected: 'bg-destructive/10',
  Reimbursed: 'bg-secondary',
};

describe('StatusBadge', () => {
  it.each(Object.entries(TONE_CLASS))('colours %s with its kit tone', (status, cls) => {
    render(<StatusBadge status={status as WorkflowStatus} label={`label ${status}`} />);
    expect(screen.getByText(`label ${status}`).className).toContain(cls);
  });

  it('renders the translated label, not the status key', () => {
    render(<StatusBadge status="Approved" label="Approuvé" />);
    expect(screen.getByText('Approuvé')).toBeInTheDocument();
    expect(screen.queryByText('Approved')).toBeNull();
  });

  it('draws the outline appearance as a bordered, transparent pill', () => {
    render(<StatusBadge status="Draft" label="Brouillon" appearance="outline" />);
    const pill = screen.getByText('Brouillon');
    expect(pill.className).toContain('border-current');
    expect(pill.className).toContain('bg-transparent');
  });
});
