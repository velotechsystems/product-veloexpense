import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTrpcMock, type QueryStub } from '@/test-utils/trpc';

/**
 * f26 — the receipts address on /preferences (card) and under the report list (hint).
 *
 * Defended here:
 *   · the card shows the address, a copy button that copies THAT address, and the send-from
 *     sentence naming the reader's own sign-in email — the half that makes the address work;
 *   · where the environment receives no mail the card SAYS so, and the hint says nothing;
 *   · a reader refused the procedure (no `createOwn`) gets neither face;
 *   · a failed fetch is an error line, not the "not set up" sentence — those are different
 *     facts, and the second one would be false.
 */

const h = vi.hoisted(() => ({ trpc: undefined as unknown }));

vi.mock('next-intl', () => ({
  useLocale: () => 'en',
  useTranslations: (ns: string) => {
    const t = (k: string, v?: Record<string, unknown>) =>
      v ? `${ns}.${k}:${Object.values(v).join(',')}` : `${ns}.${k}`;
    t.has = () => false;
    t.rich = (k: string, v: Record<string, unknown>) => {
      const mono = v.mono as (c: string) => unknown;
      return [`${ns}.${k}:`, mono(String(v.address)), ` ${String(v.email)}`];
    };
    return t;
  },
}));
vi.mock('@/lib/trpc/client', () => ({
  get trpc() {
    return h.trpc;
  },
}));

import { ReceiptsEmailCard, ReceiptsEmailHint } from './ReceiptsEmailAddress';

const ADDRESS = 'receipts@acme.mail.dev.example';
const ME = 'jose@acme.test';

function setQuery(stub: QueryStub) {
  h.trpc = createTrpcMock({ queries: { 'receiptsEmail.mine': stub } });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ReceiptsEmailCard', () => {
  it('shows the address and the sign-in email it must be sent from', () => {
    setQuery({ data: { address: ADDRESS, sendFrom: ME } });
    render(<ReceiptsEmailCard />);
    expect(screen.getByTestId('receipts-email-address')).toHaveTextContent(ADDRESS);
    expect(screen.getByTestId('receipts-email-send-from')).toHaveTextContent(
      `expenses.receiptsEmail.sendFrom:${ME}`,
    );
    expect(screen.queryByTestId('receipts-email-not-configured')).toBeNull();
  });

  it('copies exactly the address', async () => {
    setQuery({ data: { address: ADDRESS, sendFrom: ME } });
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<ReceiptsEmailCard />);
    await userEvent.click(screen.getByRole('button', { name: 'expenses.receiptsEmail.copy' }));
    expect(writeText).toHaveBeenCalledWith(ADDRESS);
    expect(await screen.findByRole('button', { name: 'expenses.receiptsEmail.copied' })).toBeInTheDocument();
  });

  it('says so when copying fails, rather than nothing', async () => {
    setQuery({ data: { address: ADDRESS, sendFrom: ME } });
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    render(<ReceiptsEmailCard />);
    await userEvent.click(screen.getByRole('button', { name: 'expenses.receiptsEmail.copy' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('expenses.receiptsEmail.copyFailed');
  });

  it('says receipts by email is not set up where there is no address', () => {
    setQuery({ data: { address: null, reason: 'NOT_CONFIGURED' } });
    render(<ReceiptsEmailCard />);
    expect(screen.getByTestId('receipts-email-not-configured')).toHaveTextContent(
      'expenses.receiptsEmail.notConfigured',
    );
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('renders nothing for a reader the procedure refuses', () => {
    setQuery({ isError: true, error: { message: 'x', data: { code: 'FORBIDDEN' } } as never });
    const { container } = render(<ReceiptsEmailCard />);
    expect(container).toBeEmptyDOMElement();
  });

  it('reports a failed fetch as a failure, not as "not set up"', () => {
    setQuery({ isError: true, error: { message: 'boom', data: { code: 'INTERNAL_SERVER_ERROR' } } as never });
    render(<ReceiptsEmailCard />);
    expect(screen.getByRole('alert')).toHaveTextContent('expenses.receiptsEmail.loadFailed');
    expect(screen.queryByTestId('receipts-email-not-configured')).toBeNull();
  });

  it('renders nothing while loading', () => {
    setQuery({ isLoading: true });
    const { container } = render(<ReceiptsEmailCard />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('ReceiptsEmailHint', () => {
  it('names the address and the send-from email', () => {
    setQuery({ data: { address: ADDRESS, sendFrom: ME } });
    render(<ReceiptsEmailHint />);
    const hint = screen.getByTestId('receipts-email-hint');
    expect(hint).toHaveTextContent(ADDRESS);
    expect(hint).toHaveTextContent(ME);
  });

  it('is silent where there is no address', () => {
    setQuery({ data: { address: null, reason: 'NOT_CONFIGURED' } });
    const { container } = render(<ReceiptsEmailHint />);
    expect(container).toBeEmptyDOMElement();
  });

  it('is silent for a reader the procedure refuses', () => {
    setQuery({ isError: true, error: { message: 'x', data: { code: 'FORBIDDEN' } } as never });
    const { container } = render(<ReceiptsEmailHint />);
    expect(container).toBeEmptyDOMElement();
  });
});
