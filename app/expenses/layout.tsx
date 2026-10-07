/**
 * VX1-6 — the workbench's frame. Everything under /expenses is behind the auth
 * proxy already (proxy.ts redirects to /login).
 *
 * It used to draw its own header — "VeloExpense" and one "Reports" link — the only
 * section of the product with any chrome at all. The app shell (components/app-shell)
 * replaced it for every page, so what is left is the `<main>` landmark these pages
 * rely on: unlike the rest of the product, the pages under /expenses do not render
 * their own.
 */
export default function ExpensesLayout({ children }: { children: React.ReactNode }) {
  return <main className="flex-1">{children}</main>;
}
