import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { rememberInterruptedWork } from '@/lib/interruptedWork';

/**
 * The notice that ends the silence.
 *
 * The reported defect was that an expiry mid-action "silently dropped the attempted action —
 * a typed justification was lost, an Approve click never landed" (GA readiness report F16,
 * blocker B7). Not knowing was the defect.
 *
 * It DISCLOSES and does not replay: re-issuing a mutation after re-auth is how a claim gets
 * approved twice. So the assertions below are about what it SAYS, and about the absence of any
 * control that would redo the action.
 */

vi.mock('next-intl', () => ({
  useTranslations: (ns?: string) => (key: string) => (ns ? `${ns}.${key}` : key),
}));

const { InterruptedWorkNotice } = await import('./InterruptedWorkNotice');

beforeEach(() => sessionStorage.clear());

describe('<InterruptedWorkNotice>', () => {
  it('renders nothing when no expiry interrupted anything', () => {
    // The overwhelmingly common case; it must add nothing to the page.
    const { container } = render(<InterruptedWorkNotice />);
    expect(container).toBeEmptyDOMElement();
  });

  it('says the action was NOT applied', () => {
    rememberInterruptedWork({ path: 'expenseApprovals.decide', url: '/en/expenses' });
    render(<InterruptedWorkNotice />);
    expect(screen.getByText('security.interrupted.message')).toBeInTheDocument();
  });

  it('hands back the words that were typed', () => {
    // The genuinely unrecoverable part of the loss.
    rememberInterruptedWork({
      path: 'expenseApprovals.decide',
      typedText: 'Rejecting: no receipt attached',
      url: '/en/expenses',
    });
    render(<InterruptedWorkNotice />);
    expect(screen.getByText('Rejecting: no receipt attached')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'security.interrupted.copy' })).toBeInTheDocument();
  });

  it('offers NO retry — it must not redo a financial action', () => {
    /**
     * The load-bearing negative. "We kept your work" must not become "we did it again while
     * you were away": re-issuing an approval or a card issue after re-auth is how something
     * happens twice. Telling them is ours; deciding is theirs.
     */
    rememberInterruptedWork({
      path: 'expenseApprovals.decide',
      typedText: 'anything',
      url: '/en/expenses',
    });
    render(<InterruptedWorkNotice />);
    expect(screen.queryByRole('button', { name: /retry|again|resubmit/i })).not.toBeInTheDocument();
  });

  it('shows no quote block when there was nothing typed', () => {
    // An Approve click carries no words; an empty quote would read as lost text.
    rememberInterruptedWork({ path: 'expenseApprovals.decide', url: '/en/expenses' });
    render(<InterruptedWorkNotice />);
    expect(screen.queryByText('security.interrupted.yourText')).not.toBeInTheDocument();
  });

  it('clears the record, so a later navigation does not repeat the message', () => {
    rememberInterruptedWork({ path: 'a.b', url: '/en/x' });
    render(<InterruptedWorkNotice />);
    expect(sessionStorage.getItem('expenseos.interruptedWork')).toBeNull();
  });
});
