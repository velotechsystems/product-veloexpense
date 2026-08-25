/**
 * VX1-6 — the workbench shell. Everything under /expenses is behind the auth
 * proxy already (proxy.ts redirects to /login), so this only supplies chrome.
 */
import Link from 'next/link';

export default function ExpensesLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-full flex-1 flex-col">
      <header className="border-b border-border">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between gap-4 px-6 py-3">
          <Link href="/expenses" className="text-sm font-semibold tracking-tight">
            VeloExpense
          </Link>
          <nav className="flex items-center gap-4 text-sm text-muted-foreground">
            <Link className="hover:text-foreground" href="/expenses">
              Reports
            </Link>
          </nav>
        </div>
      </header>
      <main className="flex-1">{children}</main>
    </div>
  );
}
