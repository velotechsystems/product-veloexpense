'use client';
/**
 * One sidebar row. Client-side only because "which page am I on" is
 * `usePathname()`; the icon, label and badge arrive pre-rendered from the server.
 *
 * 2026 guide (VeloCRM's sidebar): the active row is the brand-50 tint with
 * primary text and NO side bar — ExpenseOS's 3px left accent is the one part of
 * its row that does not carry over. `aria-current="page"` is what a screen
 * reader announces; the tint is for everybody else.
 *
 * `prefetch={false}`: the sidebar puts up to 22 links in the viewport of every
 * page, and Next prefetches each visible link. These routes are all dynamic with
 * no `loading.tsx`, so a prefetch renders down through the ROOT layout — which
 * reads the session, the branding and this sidebar's own context from the
 * database. That was ~20 server renders per page view, most of them thrown away
 * (the pseudo-locale crawl's server log showed the aborted streams). A sidebar
 * click is one ordinary navigation instead.
 */
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { isActive } from '@/lib/nav/sections';

export function NavLink({
  href,
  exact,
  children,
}: {
  href: string;
  exact: boolean;
  children: React.ReactNode;
}) {
  const active = isActive(href, exact, usePathname() ?? '');
  return (
    <Link
      href={href}
      prefetch={false}
      aria-current={active ? 'page' : undefined}
      className={
        active
          ? 'flex items-center gap-3 rounded-lg bg-sidebar-accent px-3 py-2 text-sm font-semibold text-sidebar-accent-foreground'
          : 'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground'
      }
    >
      {children}
    </Link>
  );
}
