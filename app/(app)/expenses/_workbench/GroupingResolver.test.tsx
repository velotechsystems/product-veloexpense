import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { GroupingResolver, suggestionKey } from './GroupingResolver';

/**
 * The question asked when the automatic pass declines to merge.
 *
 * What has to be right: "one expense" moves the OTHER documents onto the suggested
 * survivor (so the kept expense is the one whose total is the charged amount), and
 * "separate charges" writes nothing at all — the documents already sit apart, which is
 * what the answer means.
 */

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string, v?: Record<string, unknown>) =>
    v ? `${key}:${Object.values(v).join(',')}` : key,
  useLocale: () => 'en',
}));

function suggestion(over: Record<string, unknown> = {}) {
  return {
    reason: 'same vendor and date, 17.00 tip on 113.00 (15%)',
    confident: true,
    // The card copy's expense: its total is what was actually charged.
    suggestedExpenseId: 'e-card',
    documents: [
      {
        receiptId: 'r-bill',
        expenseId: 'e-bill',
        filename: 'bill.pdf',
        vendor: 'Joe’s Pizza',
        date: '2026-08-05',
        time: null,
        transactionId: null,
        total: 113,
        currencyCode: 'CAD',
        kind: 'ITEMIZED_BILL',
        expenseMerchant: 'Joe’s Pizza',
        expenseDate: '2026-08-05T00:00:00.000Z',
      },
      {
        receiptId: 'r-card',
        expenseId: 'e-card',
        filename: 'slip.jpg',
        vendor: 'Joe’s Pizza',
        date: '2026-08-05',
        time: '19:44',
        transactionId: 'A-1001',
        total: 130,
        currencyCode: 'CAD',
        kind: 'CARD_COPY',
        expenseMerchant: 'Joe’s Pizza',
        expenseDate: '2026-08-05T00:00:00.000Z',
      },
    ],
    ...over,
  } as never;
}

describe('GroupingResolver', () => {
  it('shows both files with the figures the question turns on', () => {
    render(
      <GroupingResolver suggestions={[suggestion()]} onMerge={vi.fn()} onKeepApart={vi.fn()} />,
    );
    expect(screen.getByText('bill.pdf')).toBeInTheDocument();
    expect(screen.getByText('slip.jpg')).toBeInTheDocument();
    // The totals are why they look alike.
    expect(screen.getByText(/113\.00 CAD/)).toBeInTheDocument();
    expect(screen.getByText(/130\.00 CAD/)).toBeInTheDocument();
  });

  it('names the field that would have settled it automatically', () => {
    // One document prints a reference number and the other does not, which is exactly
    // why the veto could not decide. Saying so beats hiding it.
    render(
      <GroupingResolver suggestions={[suggestion()]} onMerge={vi.fn()} onKeepApart={vi.fn()} />,
    );
    expect(screen.getByText('withId:A-1001')).toBeInTheDocument();
    expect(screen.getByText('noId')).toBeInTheDocument();
  });

  it('moves the OTHER documents onto the suggested survivor', async () => {
    const onMerge = vi.fn();
    render(
      <GroupingResolver suggestions={[suggestion()]} onMerge={onMerge} onKeepApart={vi.fn()} />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'same' }));
    // Only the bill moves; the card copy's expense is the one kept.
    expect(onMerge).toHaveBeenCalledWith(['r-bill'], 'e-card');
  });

  it('answers "separate" with the pair key and nothing else', async () => {
    const onKeepApart = vi.fn();
    const onMerge = vi.fn();
    render(
      <GroupingResolver suggestions={[suggestion()]} onMerge={onMerge} onKeepApart={onKeepApart} />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'different' }));
    expect(onKeepApart).toHaveBeenCalledWith('r-bill|r-card');
    expect(onMerge).not.toHaveBeenCalled();
  });

  it('recommends merging only when the evidence agrees', () => {
    const { unmount } = render(
      <GroupingResolver suggestions={[suggestion()]} onMerge={vi.fn()} onKeepApart={vi.fn()} />,
    );
    expect(screen.getByText('recommendMerge')).toBeInTheDocument();
    unmount();

    render(
      <GroupingResolver
        suggestions={[suggestion({ confident: false })]}
        onMerge={vi.fn()}
        onKeepApart={vi.fn()}
      />,
    );
    expect(screen.queryByText('recommendMerge')).toBeNull();
  });

  it('disables both answers while a move is in flight', () => {
    render(
      <GroupingResolver
        suggestions={[suggestion()]}
        onMerge={vi.fn()}
        onKeepApart={vi.fn()}
        busy
      />,
    );
    expect(screen.getByRole('button', { name: 'same' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'different' })).toBeDisabled();
  });

  it('renders nothing when there is nothing to ask', () => {
    const { container } = render(
      <GroupingResolver suggestions={[]} onMerge={vi.fn()} onKeepApart={vi.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});

describe('suggestionKey', () => {
  it('is stable whichever order the documents come back in', () => {
    const forward = suggestion();
    const reversed = suggestion({
      documents: [...(suggestion() as never as { documents: unknown[] }).documents].reverse(),
    });
    expect(suggestionKey(forward)).toBe(suggestionKey(reversed));
  });
});
