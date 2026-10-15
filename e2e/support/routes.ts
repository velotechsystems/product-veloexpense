import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * VeloExpense: ExpenseOS's `e2e/support/routes.ts` (1e682dd6), ported with the mobile crawl.
 * `APP_DIR` and `OUTSIDE_SHELL` are VeloExpense's (marked). VeloExpense's desktop crawl
 * (`e2e/crawl.spec.ts`) keeps its own route list for now.
 *
 * Route discovery for the crawlers — one copy, shared.
 *
 * `crawl.spec.ts`, `crawl-roles.spec.ts` and `interact-roles.spec.ts` each carried their
 * own transcription of the walk below plus their own copy of the exclusion set, and the
 * copies had drifted: the same set was named `UNAUTHENTICATED` in one file and
 * `OUTSIDE_SHELL` in the other two, and `interact-roles.spec.ts` was one entry short of
 * the other two (it never picked up `/offline`). Three crawlers that each believe a
 * different thing about what "every route" means is a gate that cannot be read, so the
 * walk and the set live here and the specs import them.
 *
 * What deliberately did NOT move: `LOCALE` and report-file naming. `crawl.spec.ts`
 * hardcodes `'en'`; the two role specs read `E2E_LOCALE`. Hoisting that would make
 * `crawl.spec.ts` silently start honouring `E2E_LOCALE` — a behaviour change, not a
 * refactor — so each spec keeps its own.
 */

/** The App Router tree the crawlers walk. Relative to the repo root, which is Playwright's cwd.
 *  VeloExpense: `app`, which has no `[locale]` segment (ExpenseOS: `apps/web/src/app/[locale]`). */
export const APP_DIR = 'app';

/**
 * Every static page route under `[locale]`, as a URL path.
 *
 * Discovered from the filesystem rather than listed, so a new page is covered the day it
 * lands instead of the day someone remembers this file.
 *
 * Note the shape of the recursion: a route is emitted for a SUBDIRECTORY that holds a
 * `page.tsx`, so `[locale]/page.tsx` at the walk root is never discovered and `/` is not
 * in any of the arrays below. The `route === '/' ? '' : route` guards in the callers are
 * therefore defensive rather than live — kept because the `|| '/'` fallback here would
 * start producing `/` the moment this walk is called with a different root.
 */
export function discoverRoutes(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (!statSync(full).isDirectory()) continue;
    // (group) folders are organisational and contribute nothing to the URL.
    const segment = entry.startsWith('(') && entry.endsWith(')') ? '' : `/${entry}`;
    if (readdirSync(full).includes('page.tsx')) {
      out.push(`${prefix}${segment}` || '/');
    }
    out.push(...discoverRoutes(full, `${prefix}${segment}`));
  }
  return out;
}

/** Every discovered route, deduped and sorted — static and dynamic together. */
export const ALL_ROUTES: readonly string[] = [...new Set(discoverRoutes(APP_DIR))].sort();

/**
 * The subset a crawler can navigate to directly.
 *
 * Dynamic segments need a real id, so they are covered by following links instead — the
 * flow specs do that.
 */
export const STATIC_ROUTES: readonly string[] = ALL_ROUTES.filter((r) => !r.includes('['));

/**
 * Routes that intentionally live outside the authenticated shell — do not crawl them with
 * a signed-in actor.
 *
 * `/login` would sign the actor out. The password flows (`/reset-password`,
 * `/change-password`) are token-gated and session-free, and visiting one mid-crawl would
 * start a password reset — after which every later route reports as broken. `/offline`
 * has no shell to report on, and is covered per locale by `pwa.spec.ts` instead.
 *
 * NOT the auth gate's public allow-list. That is `PUBLIC_PATHS` in
 * `apps/web/auth.config.ts`, pinned by its own equality test — the two lists have
 * different meanings and different sizes, and neither one may be edited to match the
 * other.
 */
export const OUTSIDE_SHELL: ReadonlySet<string> = new Set([
  // VeloExpense: the routes `lib/shell-free.ts` renders outside the shell — sign-in, sign-up
  // and its verification, the emailed approval link, and the invitation — plus `/`, which only
  // redirects. ExpenseOS: `/login`, `/reset-password`, `/change-password`, `/offline`, which
  // VeloExpense does not have (SSO is invite-only; there is no offline page).
  '/',
  '/login',
  '/signup',
  '/signup/verify',
  '/approve',
  '/invite/accept',
]);

/**
 * The routes a signed-in crawler should walk: static, minus the shell exclusions.
 *
 * `alsoExclude` lets one caller drop a route the others still walk — the mobile crawl
 * needs the set minus `/enroll-mfa`, and must not perturb the desktop crawl to get it.
 * A fresh Set is built per call and a fresh array returned, so `OUTSIDE_SHELL` is never
 * mutated and no caller can see another caller's extras.
 */
export function crawlableRoutes(alsoExclude: Iterable<string> = []): string[] {
  const excluded = new Set<string>([...OUTSIDE_SHELL, ...alsoExclude]);
  return STATIC_ROUTES.filter((r) => !excluded.has(r));
}
