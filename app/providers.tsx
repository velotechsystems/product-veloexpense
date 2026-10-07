'use client';

import { SessionProvider } from 'next-auth/react';
import { TRPCProvider } from '@/lib/trpc/client';

/**
 * Client-side providers wrapped around every page. The Radix Themes
 * `<Theme>` wrapper is gone — shadcn / Tailwind 4 styling is purely CSS;
 * no JS runtime theme provider needed.
 */
export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <SessionProvider>
      <TRPCProvider>{children}</TRPCProvider>
    </SessionProvider>
  );
}
