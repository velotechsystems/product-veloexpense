import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

/**
 * The report's own posting control.
 *
 * What matters is what it REFUSES to offer. Pushing an unapproved report would put
 * an unauthorised claim in the ledger; re-pushing a synced one would double-post;
 * and clearing somebody's deliberate withholding from here would undo a decision
 * without showing it. Each of those is a button that must not be there.
 *
 * Ported from ExpenseOS's `NetSuitePush.test.tsx` (550b2945). VeloExpense (d38): the control
 * is a LINK to /admin/ledger-queue, not a push mutation, so ExpenseOS's "pushes the report
 * id" and "surfaces the resolution problem verbatim" have nothing to press; and its posted-
 * record link, paid/unpaid split and post warnings are NetSuite's, with no VeloExpense
 * source, so their tests are not carried over. Every refusal above is kept, on VeloExpense's
 * states: POSTED for SYNCED, CANCELLED for DENIED, and NEEDS_REVIEW (the ledger has it).
 */

vi.mock('next-intl', () => ({
  // Values ride along after a colon, so a test can see WHICH legal entity was named.
  useTranslations: () => (key: string, v?: Record<string, unknown>) =>
    v ? `${key}:${Object.values(v).join(',')}` : key,
}));
// VeloExpense: the link is the locale-aware `Link`; a plain anchor is enough here.
vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { LedgerPost, type LedgerPostState } from './LedgerPost';

const POSTED: LedgerPostState = {
  status: 'POSTED',
  attempts: 1,
  lastError: null,
  externalId: 'BILL-99',
  postedAt: '2026-08-06T12:00:00Z',
};

/** A state that has not reached the ledger: no external id, no posted stamp. */
const unposted = (over: Partial<LedgerPostState>): LedgerPostState => ({
  ...POSTED,
  externalId: null,
  postedAt: null,
  ...over,
});

function setup(over: Partial<Parameters<typeof LedgerPost>[0]> = {}) {
  render(<LedgerPost state={null} canOpenQueue postable {...over} />);
}

describe('LedgerPost', () => {
  it('renders NOTHING for a report that is not a liability yet', () => {
    // A DRAFT saying "not posted" would be noise on every report anyone started.
    const { container } = render(
      <LedgerPost state={null} canOpenQueue postable={false} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('offers the queue for an approved report the ledger does not have', () => {
    setup();
    expect(screen.getByText('state.NOT_POSTED')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /push/i })).toHaveAttribute(
      'href',
      '/admin/ledger-queue',
    );
  });

  it('will not offer a second post once posted — that is a double-post', () => {
    setup({ state: POSTED });
    expect(screen.getByText('state.POSTED')).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('will not re-push a WITHHELD report — that decision belongs to the queue', () => {
    setup({ state: unposted({ status: 'CANCELLED', lastError: 'Withheld by AP: wrong GL' }) });
    expect(screen.getByText('state.CANCELLED')).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('will not offer a post the ledger already accepted (NEEDS_REVIEW)', () => {
    // VeloExpense: accepted upstream, unrecorded here — a second post would duplicate it.
    setup({ state: { ...POSTED, status: 'NEEDS_REVIEW', postedAt: null } });
    expect(screen.getByText('state.NEEDS_REVIEW')).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('offers a RETRY after a failure, worded as one', () => {
    setup({ state: unposted({ status: 'FAILED', attempts: 3, lastError: 'no GL' }) });
    const link = screen.getByRole('link');
    expect(link).toHaveTextContent('retry');
    expect(link).toHaveAttribute('title', 'retryHelp');
    // The attempt count rides along, so a repeatedly-failing report looks like one.
    expect(screen.getByText(/×3/)).toBeInTheDocument();
    // The failure keeps its reason on the badge.
    expect(screen.getByTestId('ledger-report-state')).toHaveAttribute('title', 'no GL');
  });

  it('words a post that gave up (DEAD) as a retry too, in the failure tone', () => {
    setup({ state: unposted({ status: 'DEAD', attempts: 5 }) });
    expect(screen.getByRole('link')).toHaveTextContent('retry');
    expect(screen.getByTestId('ledger-report-state')).toHaveClass('bg-destructive/10');
  });

  it('shows no queue affordance without the permission', () => {
    setup({ canOpenQueue: false });
    expect(screen.getByText('state.NOT_POSTED')).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('gives every state a tone, so none comes out as the loudest thing on the page', () => {
    const statuses = [
      'PENDING',
      'PROCESSING',
      'POSTED',
      'FAILED',
      'DEAD',
      'CANCELLED',
      'NEEDS_REVIEW',
    ] as const;
    for (const status of statuses) {
      const { unmount } = render(
        <LedgerPost state={{ ...POSTED, status }} canOpenQueue={false} postable />,
      );
      expect(screen.getByTestId('ledger-report-state').className).toMatch(
        /bg-(success|secondary|primary|destructive|warning)/,
      );
      unmount();
    }
  });
});
