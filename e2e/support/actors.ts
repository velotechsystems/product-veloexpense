import type { BrowserContext, Page } from '@playwright/test';

/**
 * Signing in as somebody specific.
 *
 * Most specs run on the storage state the auth setup recorded, which is one admin. A flow
 * that crosses people cannot use it: an expense report is submitted by one person and
 * decided by another, and a test that does both as an admin proves nothing about the
 * handoff — the interesting failures are all in who is allowed to see what, and when.
 *
 * The accounts are the seeded QA users (`packages/db/prisma/seed-data/test-users.json`),
 * which exist in local and dev and never in prod.
 *
 * VeloExpense: the demo tenant's seeded people (`scripts/seed.mjs`), whose sessions
 * `e2e/auth.setup.ts` mints into `e2e/.auth/` — there is no password sign-in to drive (SSO is
 * invite-only). Six of ExpenseOS's nine actors have a VeloExpense person, plus `approver`; the
 * three left out are named below the table, with why. `employee` and `apClerk` report to
 * `manager`, and `expenseAdmin` to `admin` (seed.mjs), as ExpenseOS's do.
 */

export const ACTORS = {
  admin: 'admin@demo.test',
  manager: 'manager@demo.test',
  employee: 'employee@demo.test',
  /** VeloExpense: the demo tenant's owner, who approves the admin's reports (`approver.json`). */
  approver: 'owner@demo.test',
  // VeloExpense: the role-matrix people, ExpenseOS's three for the system roles nobody above
  // holds — seeded and placed as ExpenseOS places them (`scripts/seed.mjs`).
  expenseAdmin: 'expense-admin@demo.test',
  apClerk: 'ap-clerk@demo.test',
  /**
   * The top of the org chart. `executive` has NO manager on purpose, so their approvals
   * cannot route relative to them.
   */
  executive: 'executive@demo.test',
} as const;

// VeloExpense: ExpenseOS's remaining actors are not here. `cardAdmin` holds a role whose
// screens (virtual cards) VeloExpense does not have; `usEmployee` exists for a US legal entity
// VeloExpense does not seed; and `cfo` is the fallback approver ExpenseOS's seeded workflows
// name, where VeloExpense's default workflow falls back to the System Administrator role.

export type Actor = keyof typeof ACTORS;

/** Where `actors.setup.ts` leaves each actor's session.
 *  VeloExpense: where `e2e/auth.setup.ts` does — the admin's is `state.json`. */
export function stateFileFor(actor: Actor): string {
  return actor === 'admin' ? 'e2e/.auth/state.json' : `e2e/.auth/${actor}.json`;
}

/**
 * Adopt an actor's session.
 *
 * NOT a form submission. `actors.setup.ts` signs each actor in once for the whole run and
 * saves their cookies; this loads them. The lifecycle specs cross two or three people per
 * test, so driving the form each time meant a dozen logins per run against one `next dev`
 * server — which produced sign-in timeouts and no other symptom, reading as broken
 * authentication rather than as a saturated server answering the same form repeatedly.
 *
 * The dashboard is still visited and verified: a cookie that the server no longer accepts
 * has to fail HERE, loudly, rather than three steps later as an empty list that looks like
 * a permissions bug.
 */
export async function signIn(page: Page, actor: Actor): Promise<void> {
  const { readFileSync } = await import('node:fs');
  /**
   * Typed off `BrowserContext['addCookies']` rather than `page.context.prototype`, which is
   * a getter and carries no prototype — so the old form resolved to `unknown` and the cast
   * silently stopped meaning anything. It typechecks now, which is the point: this file was
   * never typechecked at all until `tsconfig.e2e.json` existed.
   */
  type Cookies = Parameters<BrowserContext['addCookies']>[0];
  const state = JSON.parse(readFileSync(stateFileFor(actor), 'utf8')) as { cookies: Cookies };

  // Leave the app before swapping identity: clearing cookies under a live page cancels
  // whatever it still has in flight, and the next navigation inherits the abort.
  await page.goto('about:blank');
  await page.context().clearCookies();
  await page.context().addCookies(state.cookies);

  await page.goto('/dashboard');
  await page.waitForURL('**/dashboard', { timeout: 60_000 });
}

/**
 * Sign out, so nothing is carried into the next identity.
 *
 * Kept separate from `signIn` because a spec that asserts what an ANONYMOUS visitor sees
 * needs it on its own.
 */
export async function signOut(page: Page): Promise<void> {
  await page.goto('about:blank');
  await page.context().clearCookies();
}

/** Become somebody else. The handoff every approval flow needs. */
export async function switchTo(page: Page, actor: Actor): Promise<void> {
  await signOut(page);
  await signIn(page, actor);
}
