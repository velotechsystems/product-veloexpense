'use client';
/**
 * The frame around every signed-in page: the sidebar at `lg` and up, a top bar
 * with a Menu button below it (ExpenseOS's `AppShell`: persistent sidebar on a
 * desktop, the same sidebar off-canvas on a phone).
 *
 * Client-side for two reasons and no others:
 *   · `shellFree(pathname)` — sign-in, sign-up, the emailed approve link and the
 *     invite page are single-purpose flows that draw no menu (`lib/nav/sections.ts`).
 *     The root layout cannot see the path, so the decision is made here.
 *   · The phone menu's open state. The bar stays above the open menu (it is a
 *     fixed 4rem, and the menu starts under it) so the button that opened it is
 *     the button that closes it; a tap outside or Escape closes it too. It is keyed BY PATH (`openAt`) rather than a
 *     boolean, so following a link closes it without an effect: the root layout
 *     persists across navigations, and a boolean would leave the menu covering
 *     the page the reader just asked for.
 *
 * The sidebar itself is server-rendered and arrives as a node. It is mounted twice
 * at most — the `lg:flex` copy is `display:none` below `lg`, so out of the
 * accessibility tree, and the phone copy exists only while open — so a reader
 * never meets two "Main navigation" landmarks.
 */
import { useState } from 'react';
import { usePathname } from 'next/navigation';
import { Menu, X } from 'lucide-react';
import { shellFree } from '@/lib/nav/sections';

export function ShellFrame({
  sidebar,
  brand,
  menuLabel,
  closeLabel,
  skipLabel,
  children,
}: {
  sidebar: React.ReactNode;
  brand: React.ReactNode;
  menuLabel: string;
  closeLabel: string;
  skipLabel: string;
  children: React.ReactNode;
}) {
  const pathname = usePathname() ?? '/';
  const [openAt, setOpenAt] = useState<string | null>(null);
  const open = openAt === pathname;

  if (shellFree(pathname)) return <>{children}</>;

  return (
    <div className="flex min-h-svh w-full flex-1">
      <a
        href="#main-content"
        className="sr-only z-50 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground focus:not-sr-only focus:absolute focus:top-2 focus:left-2"
      >
        {skipLabel}
      </a>
      <div className="sticky top-0 hidden h-svh w-60 shrink-0 lg:flex">{sidebar}</div>

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="sticky top-0 z-30 flex h-16 items-center justify-between gap-3 border-b border-border bg-background px-4 lg:hidden">
          {brand}
          <button
            type="button"
            aria-expanded={open}
            aria-controls="app-shell-mobile-nav"
            onClick={() => setOpenAt(open ? null : pathname)}
            className="inline-flex min-h-11 min-w-11 items-center justify-center gap-2 rounded-lg px-3 text-sm font-medium text-foreground hover:bg-muted"
          >
            {open ? <X aria-hidden className="size-5" /> : <Menu aria-hidden className="size-5" />}
            {open ? closeLabel : menuLabel}
          </button>
        </div>

        {open ? (
          <div
            className="fixed inset-x-0 top-16 bottom-0 z-20 lg:hidden"
            onKeyDown={(e) => {
              if (e.key === 'Escape') setOpenAt(null);
            }}
          >
            <div aria-hidden className="absolute inset-0 bg-black/40" onClick={() => setOpenAt(null)} />
            <div id="app-shell-mobile-nav" className="relative z-10 flex h-full w-72 max-w-[85vw] overflow-hidden">
              {sidebar}
            </div>
          </div>
        ) : null}

        {/* The page's one <main> landmark is the shell's, so no screen declares its
            own; "Skip to content" lands here. */}
        <main id="main-content" tabIndex={-1} className="flex min-w-0 flex-1 flex-col outline-none">
          {children}
        </main>
      </div>
    </div>
  );
}
