import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTrpcMock, type TrpcMockConfig } from '@/test-utils/trpc';

/**
 * Applying one statement page to the expenses it covers.
 *
 * A statement is not a receipt: a receipt evidences one charge, a statement evidences
 * several and is the only document that proves what was actually SETTLED — the rate
 * included, for a charge made in another currency. So it belongs on every expense it
 * covers, and each tick becomes a real copy of the file.
 *
 * That makes three things load-bearing, and they are what the tests pin:
 *
 *   · **A recommendation shows its reason.** The matched bank line sits beside the box,
 *     because a tick with no reason has to be verified by hand anyway — at which point
 *     the recommendation saved nobody anything.
 *   · **A refetch never re-ticks a box somebody cleared.** The seeding happens once;
 *     silently restoring a deliberate choice would attach a document to an expense the
 *     person had just decided it does not belong to.
 *   · **An expense that already carries the file is shown as covered, not offered.**
 *     Ticking it again would attach a second copy.
 */

const h = vi.hoisted(() => ({ trpc: undefined as unknown }));

vi.mock('@/lib/trpc/client', () => ({
  get trpc() {
    return h.trpc;
  },
}));
vi.mock('next-intl', () => ({
  useTranslations: () => {
    const t = (key: string, values?: Record<string, unknown>) =>
      values ? `${key}:${Object.values(values).join(',')}` : key;
    t.has = () => false;
    return t;
  },
  useLocale: () => 'en',
}));

import { StatementApplyDialog } from './StatementApplyDialog';

const target = (over: Record<string, unknown> = {}) => ({
  expenseId: 'e-1',
  merchant: 'Air Canada',
  amountMinor: '48210',
  currencyCode: 'CAD',
  recommended: true,
  alreadyHas: false,
  matchedLine: 'AIR CANADA 014 TORONTO',
  strength: 'amount',
  ...over,
});

const DATA = { filename: 'visa-july.pdf', items: [target()] };

function setTrpc(data: unknown = DATA, over: TrpcMockConfig = {}) {
  h.trpc = createTrpcMock({
    ...over,
    queries: {
      'expenses.statementTargets': { data, ...over.queries?.['expenses.statementTargets'] },
    },
  });
}

const show = () => {
  const onClose = vi.fn();
  const onApplied = vi.fn();
  const view = render(
    <StatementApplyDialog receiptId="rc-1" onClose={onClose} onApplied={onApplied} />,
  );
  return { ...view, onClose, onApplied };
};

const box = (name: string) => screen.getByLabelText(name) as HTMLElement;
const applyButton = () => screen.getByRole('button', { name: /^apply/ });

beforeEach(() => {
  setTrpc();
});
afterEach(() => {
  // The dialog portals outside the render container.
  cleanup();
  h.trpc = undefined;
  vi.restoreAllMocks();
});

describe('what it offers', () => {
  it('names the statement being applied', () => {
    show();
    expect(screen.getByText('title:visa-july.pdf')).toBeInTheDocument();
  });

  it('says it is loading rather than showing an empty list', () => {
    setTrpc(undefined, { queries: { 'expenses.statementTargets': { isLoading: true } } });
    show();
    expect(screen.getByText('loading')).toBeInTheDocument();
  });

  it('says plainly when the report has nothing to apply it to', () => {
    setTrpc({ filename: 'visa-july.pdf', items: [] });
    show();
    expect(screen.getByText('noExpenses')).toBeInTheDocument();
  });

  it('prints each expense with the amount and currency it was incurred in', () => {
    /**
     * The whole point of the statement is the settled figure, so a euro charge shown
     * in dollars would be the one document that contradicts itself.
     */
    setTrpc({
      filename: 'f.pdf',
      items: [target({ amountMinor: '5000', currencyCode: 'EUR' })],
    });
    show();
    expect(screen.getByText(/50\.00 EUR/)).toBeInTheDocument();
  });

  it('labels an expense with no merchant rather than leaving a blank line', () => {
    setTrpc({ filename: 'f.pdf', items: [target({ merchant: null })] });
    show();
    expect(screen.getByText('noMerchant')).toBeInTheDocument();
  });

  it('treats a whitespace-only merchant as no merchant', () => {
    setTrpc({ filename: 'f.pdf', items: [target({ merchant: '   ' })] });
    show();
    expect(screen.getByText('noMerchant')).toBeInTheDocument();
  });
});

describe('why a box is ticked', () => {
  it('shows the bank line the recommendation came from', () => {
    show();
    expect(screen.getByText(/matched:AIR CANADA 014 TORONTO/)).toBeInTheDocument();
  });

  it('says so when the merchant agreed too, not just the amount', () => {
    /**
     * Two charges for the same amount on the same statement are common; that the name
     * matched as well is the difference between a guess and a match.
     */
    setTrpc({ filename: 'f.pdf', items: [target({ strength: 'amount+merchant' })] });
    show();
    expect(screen.getByText(/merchantAgrees/)).toBeInTheDocument();
  });

  it('claims no reason when the match was not to a line', () => {
    setTrpc({ filename: 'f.pdf', items: [target({ matchedLine: null })] });
    show();
    expect(screen.queryByText(/^matched:/)).not.toBeInTheDocument();
  });

  it('ticks the recommendations to begin with', () => {
    show();
    expect(box('Air Canada')).toHaveAttribute('aria-checked', 'true');
  });

  it('leaves an unrecommended expense for the person to decide', () => {
    setTrpc({ filename: 'f.pdf', items: [target({ recommended: false })] });
    show();
    expect(box('Air Canada')).toHaveAttribute('aria-checked', 'false');
    expect(applyButton()).toBeDisabled();
  });

  it('counts what will be applied', () => {
    setTrpc({
      filename: 'f.pdf',
      items: [target(), target({ expenseId: 'e-2', merchant: 'Hertz' })],
    });
    show();
    expect(screen.getByText('apply:2')).toBeInTheDocument();
  });
});

describe('an expense that already carries it', () => {
  it('is shown as covered', () => {
    setTrpc({ filename: 'f.pdf', items: [target({ alreadyHas: true })] });
    show();
    expect(screen.getByText('alreadyHas')).toBeInTheDocument();
  });

  it('reads as ticked, because it is', () => {
    setTrpc({ filename: 'f.pdf', items: [target({ alreadyHas: true })] });
    show();
    expect(box('Air Canada')).toHaveAttribute('aria-checked', 'true');
  });

  it('cannot be ticked again — that would attach a second copy', () => {
    setTrpc({ filename: 'f.pdf', items: [target({ alreadyHas: true })] });
    show();
    // Base UI renders the box as a span, so "disabled" is the ARIA state.
    expect(box('Air Canada')).toHaveAttribute('aria-disabled', 'true');
  });

  it('is not counted among the ones about to be applied', async () => {
    /**
     * It is already covered, so counting it would promise work that isn't going to
     * happen — and with only covered expenses there is nothing to apply at all.
     */
    setTrpc({ filename: 'f.pdf', items: [target({ alreadyHas: true })] });
    show();
    expect(screen.getByText('apply:0')).toBeInTheDocument();
    expect(applyButton()).toBeDisabled();
  });
});

describe('choosing', () => {
  it('unticks a recommendation the person disagrees with', async () => {
    const user = userEvent.setup();
    show();
    await user.click(box('Air Canada'));
    expect(box('Air Canada')).toHaveAttribute('aria-checked', 'false');
  });

  it('keeps that choice when the recommendations arrive again', async () => {
    /**
     * The seeding runs once. A refetch that re-ticked a cleared box would attach the
     * document to an expense somebody had just decided it does not belong to.
     */
    const user = userEvent.setup();
    show();
    await user.click(box('Air Canada'));
    // A re-render with the same recommendations — the seeding effect must not re-fire.
    setTrpc();
    await user.click(screen.getByText('help'));
    expect(box('Air Canada')).toHaveAttribute('aria-checked', 'false');
  });

  it('ticks one the recommendations missed', async () => {
    const user = userEvent.setup();
    setTrpc({ filename: 'f.pdf', items: [target({ recommended: false })] });
    show();
    await user.click(box('Air Canada'));
    expect(applyButton()).toBeEnabled();
  });
});

describe('applying', () => {
  it('sends the statement and every expense that was ticked', async () => {
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc(
      {
        filename: 'f.pdf',
        items: [target(), target({ expenseId: 'e-2', merchant: 'Hertz' })],
      },
      { mutations: { 'expenses.statementApply': { onCall } } },
    );
    show();
    await user.click(applyButton());
    expect(onCall).toHaveBeenCalledWith({ receiptId: 'rc-1', expenseIds: ['e-1', 'e-2'] });
  });

  it('sends only the ones still ticked', async () => {
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc(
      {
        filename: 'f.pdf',
        items: [target(), target({ expenseId: 'e-2', merchant: 'Hertz' })],
      },
      { mutations: { 'expenses.statementApply': { onCall } } },
    );
    show();
    await user.click(box('Hertz'));
    await user.click(applyButton());
    expect(onCall).toHaveBeenCalledWith({ receiptId: 'rc-1', expenseIds: ['e-1'] });
  });

  it('tells the workbench to re-read, then closes', async () => {
    // The expenses now carry an attachment the workbench is still showing without.
    const user = userEvent.setup();
    setTrpc(DATA, { mutations: { 'expenses.statementApply': { outcome: 'success' } } });
    const { onApplied, onClose } = show();
    await user.click(applyButton());
    expect(onApplied).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('will not fire twice, and locks the boxes while it runs', () => {
    /**
     * Each tick is a file copy; a double submission is a duplicate attachment on every
     * expense in the list.
     */
    setTrpc(DATA, { mutations: { 'expenses.statementApply': { isPending: true } } });
    show();
    expect(screen.getByText('applying').closest('button')).toBeDisabled();
    expect(box('Air Canada')).toHaveAttribute('aria-disabled', 'true');
  });

  it('reports a refusal in the dialog and stays open', async () => {
    const user = userEvent.setup();
    setTrpc(DATA, {
      mutations: {
        'expenses.statementApply': {
          outcome: 'error',
          error: { message: 'That report has been submitted' },
        },
      },
    });
    const { onClose } = show();
    await user.click(applyButton());
    expect(await screen.findByText('That report has been submitted')).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('cancels without applying anything', async () => {
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc(DATA, { mutations: { 'expenses.statementApply': { onCall } } });
    const { onClose } = show();
    await user.click(screen.getByRole('button', { name: 'cancel' }));
    expect(onClose).toHaveBeenCalled();
    expect(onCall).not.toHaveBeenCalled();
  });
});
