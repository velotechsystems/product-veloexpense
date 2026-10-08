import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

/**
 * VeloExpense: the root layout draws the shell for every path, so the gate is what keeps a
 * signed-in reader's sign-in page bare (BR-4) — and what keeps ExpenseOS's two notices
 * outside the small-screen gate, as ExpenseOS's `(app)/layout.tsx` does.
 */
const h = vi.hoisted(() => ({ pathname: '/' }));
vi.mock('next/navigation', () => ({ usePathname: () => h.pathname }));
vi.mock('./AppShell', () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => <div data-testid="shell">{children}</div>,
}));
vi.mock('./InterruptedWorkNotice', () => ({ InterruptedWorkNotice: () => <p>interrupted-work</p> }));
vi.mock('./DesktopOnlyNotice', () => ({
  DesktopOnlyNotice: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="desktop-gate">{children}</div>
  ),
}));

import { ShellGate } from './ShellGate';

const shell = {} as Parameters<typeof ShellGate>[0]['shell'];

describe('ShellGate', () => {
  it('draws the shell, the notice outside the gate and the page inside it', () => {
    h.pathname = '/expenses';
    render(<ShellGate shell={shell}>page</ShellGate>);
    const frame = screen.getByTestId('shell');
    expect(frame).toHaveTextContent('interrupted-work');
    expect(screen.getByTestId('desktop-gate')).toHaveTextContent('page');
    expect(screen.getByTestId('desktop-gate')).not.toHaveTextContent('interrupted-work');
  });

  it.each(['/login', '/signup', '/approve/tok', '/invite/accept'])('leaves %s bare', (path) => {
    h.pathname = path;
    render(<ShellGate shell={shell}>page</ShellGate>);
    expect(screen.queryByTestId('shell')).not.toBeInTheDocument();
    expect(screen.getByText('page')).toBeInTheDocument();
  });
});
