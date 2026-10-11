import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ExpenseListRow } from './parts';
import { RECEIPT_DRAG_TYPE } from './receiptDrag';
// VeloExpense: ExpenseOS's catalogue locale — what next-intl reports on every ported screen
// (i18n/request.ts) — named rather than spelled, for check-i18n's IL-1 scan.
import { DEFAULT_LOCALE as CATALOG_LOCALE } from '@expenseos/i18n';

/**
 * The expense row as a drop target.
 *
 * Three things are easy to get wrong and invisible when they are: dropping a receipt
 * back onto the expense it already belongs to (a pointless round-trip through the
 * server), reacting to a drag that isn't ours (a file from the desktop), and offering
 * the affordance on a report nobody may edit.
 */

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
  useLocale: () => 'en',
}));
vi.mock('@/lib/categoryColor', () => ({ categoryPillStyle: () => ({}) }));

function expense(over: Record<string, unknown> = {}) {
  return {
    id: 'e-target',
    merchant: 'Hilton',
    date: '2026-08-05T00:00:00.000Z',
    amountMinor: '41000',
    currency: { code: 'CAD', symbol: '$' },
    lineItems: [],
    receipts: [],
    ...over,
  } as never;
}

/** A drag carrying our payload. jsdom builds no DataTransfer, so it is supplied. */
function receiptDrag(payload: Record<string, unknown>) {
  const store = new Map<string, string>([[RECEIPT_DRAG_TYPE, JSON.stringify(payload)]]);
  return {
    dataTransfer: {
      types: [...store.keys()],
      getData: (t: string) => store.get(t) ?? '',
      setData: () => {},
      dropEffect: 'none',
    },
  };
}

function row(onReceiptDrop?: (p: never) => void) {
  return render(
    <ul>
      <ExpenseListRow
        expense={expense()}
        locale={CATALOG_LOCALE}
        active={false}
        violationCount={0}
        onSelect={() => {}}
        onReceiptDrop={onReceiptDrop as never}
      />
    </ul>,
  );
}

describe('ExpenseListRow as a receipt drop target', () => {
  it('accepts a receipt dragged from another expense', () => {
    const onDrop = vi.fn();
    row(onDrop);
    const li = screen.getByRole('listitem');
    fireEvent.drop(li, receiptDrag({ receiptId: 'r-1', fromExpenseId: 'e-other' }));
    expect(onDrop).toHaveBeenCalledWith(
      expect.objectContaining({ receiptId: 'r-1', fromExpenseId: 'e-other' }),
    );
  });

  it('ignores a drop from the expense it is already on', () => {
    const onDrop = vi.fn();
    row(onDrop);
    fireEvent.drop(
      screen.getByRole('listitem'),
      receiptDrag({ receiptId: 'r-1', fromExpenseId: 'e-target' }),
    );
    expect(onDrop).not.toHaveBeenCalled();
  });

  it('ignores a drag that is not one of ours', () => {
    const onDrop = vi.fn();
    row(onDrop);
    fireEvent.drop(screen.getByRole('listitem'), {
      dataTransfer: { types: ['Files'], getData: () => '', setData: () => {} },
    });
    expect(onDrop).not.toHaveBeenCalled();
  });

  it('is not a drop target at all without a handler — a read-only report', () => {
    row(undefined);
    // Nothing to assert on the callback, so assert the row does not claim the drop:
    // an unhandled dragover leaves `defaultPrevented` false, which is what tells the
    // browser this is not a drop point.
    const li = screen.getByRole('listitem');
    const evt = new Event('dragover', { bubbles: true, cancelable: true });
    Object.defineProperty(evt, 'dataTransfer', {
      value: { types: [RECEIPT_DRAG_TYPE], getData: () => '', setData: () => {} },
    });
    li.dispatchEvent(evt);
    expect(evt.defaultPrevented).toBe(false);
  });

  it('claims the drop while one of ours is over it', () => {
    row(vi.fn());
    const li = screen.getByRole('listitem');
    const evt = new Event('dragover', { bubbles: true, cancelable: true });
    Object.defineProperty(evt, 'dataTransfer', {
      value: { types: [RECEIPT_DRAG_TYPE], getData: () => '', setData: () => {}, dropEffect: '' },
    });
    li.dispatchEvent(evt);
    expect(evt.defaultPrevented).toBe(true);
  });
});
