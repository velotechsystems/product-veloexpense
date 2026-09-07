/**
 * VX1-6 — the workbench shell. Everything under /expenses is behind the auth
 * proxy already (proxy.ts redirects to /login), so this only supplies chrome.
 *
 * VX4-10 part 2 catalogued the one word here that is copy. "VeloExpense" below is
 * NOT catalogued and never will be: it is the product's name, and a product name
 * that changes language is a different product. It is therefore part of every
 * crawled page's irreducible floor, in the same family as `Intl` output on
 * /preferences — a string the ratchet counts and no catalogue should hold.
 */
import Link from 'next/link';
import { uiText } from '@/lib/i18n/catalog/ui';
import { readerPrefs } from '@/lib/i18n/request';

export default async function ExpensesLayout({ children }: { children: React.ReactNode }) {
  const prefs = await readerPrefs();
  return (
    <div className="flex min-h-full flex-1 flex-col">
      <header className="border-b border-border">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between gap-4 px-6 py-3">
          <Link href="/expenses" className="text-sm font-semibold tracking-tight">
            VeloExpense
          </Link>
          <nav className="flex items-center gap-4 text-sm text-muted-foreground">
            <Link className="hover:text-foreground" href="/expenses">
              {uiText('nav.reports', prefs.locale)}
            </Link>
          </nav>
        </div>
      </header>
      <main className="flex-1">{children}</main>
    </div>
  );
}
