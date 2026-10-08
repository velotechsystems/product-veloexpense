'use client';

import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { shellFree } from '@/lib/shell-free';
import { AppShell, type AppShellProps } from './AppShell';
import { DesktopOnlyNotice } from './DesktopOnlyNotice';
import { InterruptedWorkNotice } from './InterruptedWorkNotice';

/**
 * VeloExpense: what ExpenseOS's `(app)/layout.tsx` renders, behind the one decision that
 * layout never had to make — whether this path gets a shell at all (`lib/shell-free.ts`).
 * Not in ExpenseOS. The root layout resolves the props on the server (server/shell.ts).
 */
export function ShellGate({
  shell,
  children,
}: {
  shell: Omit<AppShellProps, 'children'>;
  children: ReactNode;
}) {
  const pathname = usePathname() ?? '/';
  if (shellFree(pathname)) return <>{children}</>;
  return (
    <AppShell {...shell}>
      {/* ExpenseOS's `(app)/layout.tsx`: both notices stay OUTSIDE the small-screen gate,
          so a draft can still be offered back on a route the reader is looking at the
          notice for. (ExpenseOS's IdleTimeout is not ported: it is specific to ExpenseOS's
          sign-in.) */}
      <InterruptedWorkNotice />
      <DesktopOnlyNotice>{children}</DesktopOnlyNotice>
    </AppShell>
  );
}
