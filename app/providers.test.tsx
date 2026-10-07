import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

/**
 * The two client providers every page is wrapped in (VeloExpense: no locale segment; app/layout.tsx).
 *
 * Small, and load-bearing in a way that only shows up when the ORDER is wrong: the tRPC
 * provider's error handling reads the session to decide whether an UNAUTHORIZED response
 * means "sign in again", so `SessionProvider` has to be outside it. Nested the other way
 * the app still renders and still fetches — it just stops recovering from an expired
 * session, which is the failure nobody notices until a token ages out in production.
 *
 * There is no theme provider on purpose: styling is CSS, and a JS runtime theme wrapper
 * would put a hydration boundary around every page for nothing.
 */

const order: string[] = [];

vi.mock('next-auth/react', () => ({
  SessionProvider: ({ children }: { children: React.ReactNode }) => {
    order.push('session');
    return <div data-testid="session">{children}</div>;
  },
}));
vi.mock('@/lib/trpc/client', () => ({
  TRPCProvider: ({ children }: { children: React.ReactNode }) => {
    order.push('trpc');
    return <div data-testid="trpc">{children}</div>;
  },
}));

import { Providers } from './providers';

describe('<Providers>', () => {
  it('renders what it wraps', () => {
    render(
      <Providers>
        <span>the page</span>
      </Providers>,
    );
    expect(screen.getByText('the page')).toBeInTheDocument();
  });

  it('puts the session outside tRPC, not beside it', () => {
    /**
     * The tRPC provider's onError decides whether a failure means the session ended. A
     * session provider nested INSIDE it is not in scope for that decision, and the app
     * quietly stops recovering from an expired token.
     */
    render(
      <Providers>
        <span>the page</span>
      </Providers>,
    );
    const session = screen.getByTestId('session');
    const trpc = screen.getByTestId('trpc');
    expect(session.contains(trpc)).toBe(true);
    expect(trpc.contains(session)).toBe(false);
  });

  it('adds no third wrapper of its own', () => {
    /** Styling is CSS. A runtime theme provider here would be a hydration boundary around
     *  every page in the app, bought for nothing. */
    const { container } = render(
      <Providers>
        <span>the page</span>
      </Providers>,
    );
    expect(container.querySelectorAll('div')).toHaveLength(2);
  });
});
