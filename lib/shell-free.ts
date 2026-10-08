/**
 * Paths where the app shell is NOT drawn: no session, or a single-purpose flow — sign-in,
 * sign-up, the emailed approve link and the invite page.
 *
 * ExpenseOS needs no such list: its shell is the `(app)` route group's layout, so a page
 * outside the group simply has none. VeloExpense's shell is drawn by the ROOT layout (its
 * pages are not grouped yet), and the root layout cannot see the path, so the decision is
 * made client-side by `app/(app)/ShellGate.tsx`. Kept from the #147 shell (lib/nav/sections.ts).
 *
 * The sign-in page in particular must stay bare for a signed-in reader too: it must not
 * show a tenant's name to whoever can reach it (BR-4, e2e/invite-flow.spec.ts).
 */
export const SHELL_FREE = [/^\/login(?:\/|$)/, /^\/signup(?:\/|$)/, /^\/approve(?:\/|$)/, /^\/invite(?:\/|$)/];
export const shellFree = (pathname: string) => SHELL_FREE.some((re) => re.test(pathname));
