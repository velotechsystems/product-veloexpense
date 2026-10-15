/**
 * The one ignore list for console errors the crawlers see — one copy, shared.
 *
 * WHY IT MOVED HERE. This list existed verbatim in three specs at once
 * (`crawl.spec.ts`, `crawl-roles.spec.ts`, `crawl-mobile.spec.ts`), which is the same drift
 * class `routes.ts` was created to end and a worse instance of it: `crawl-mobile.spec.ts`
 * documented a cross-file coupling ("read `crawl.spec.ts`'s note before adding to it") that
 * nothing enforced, and the incident that note memorialises WAS a divergent ignore list.
 * Three crawlers that each believe a different thing about what counts as noise is a gate
 * that cannot be read.
 *
 * KEEP THIS LIST SHORT. An ignore entry is a decision to stop looking, and it costs more
 * than it saves. The two entries a reader will reach for first are both refused below, with
 * the reason each was refused.
 *
 * ─── `MISSING_MESSAGE`: TRIED ONCE, COST TWO LIVE BUGS ───────────────────────────────────
 *
 * `MISSING_MESSAGE` used to be on this list, on the reasoning that "next-intl warns for a
 * key it renders anyway; the used-keys check owns that".
 *
 * Both halves were wrong, and it cost two live bugs.
 *
 * `check-used-keys` scans for LITERAL keys, so it cannot see an interpolated one —
 * `t(`catTitle.${key}`)` is invisible to it. And next-intl does not render those anyway:
 * a missing key raises, the component throws, and the page goes blank. So the static
 * check does not own this case, and the only layer that could see it was told to look
 * away.
 *
 * Two shipped that way: `notifications.prefs.catTitle.budgetThreshold` (every user's
 * notification preferences threw) and `workflows.subject.TRAVEL_REQUEST` (the approval
 * workflows admin page threw). Both were sitting in the crawl's console output, ignored.
 *
 * ─── `ResizeObserver loop …`: REFUSED FOR THE PHONE CRAWL ────────────────────────────────
 *
 * `ResizeObserver loop completed with undelivered notifications` IS DELIBERATELY NOT HERE,
 * and it is the entry a future reader will most want to add, because it is famous as benign
 * noise on desktop. At `mobile-390`'s 664px-tall viewport it is not noise: it is what a
 * layout oscillating between two sizes sounds like, which is precisely the class of phone
 * defect `crawl-mobile.spec.ts` exists to catch. Leave it off.
 *
 * ─── A FAILED FAVICON LOAD IS NOT ON THIS LIST EITHER ────────────────────────────────────
 *
 * `app/icon.png` is meant to be on every page, so a 404 for it is a finding (spec FR-6).
 * `crawl-roles.spec.ts` does ignore it, on its own and deliberately — so that spec EXTENDS
 * this list at its use site rather than this list carrying the entry for all three. Moving
 * it in here would silently start ignoring a real finding in the other two crawlers, which
 * is the drift this file exists to prevent, running in the other direction.
 *
 * ─── WHAT DID NOT MOVE ───────────────────────────────────────────────────────────────────
 *
 * Each spec keeps its own `page.on('console')` listener body and its own report plumbing.
 * `crawl-mobile.spec.ts` additionally keeps `carveOutDoubleReport`, which is about a gated
 * route's 404 being logged twice and has nothing to do with noise. Hoisting those would be
 * a behaviour change to two green desktop crawlers dressed up as a refactor.
 */
export const IGNORED_CONSOLE: readonly RegExp[] = [
  /Download the React DevTools/i,
  /\[HMR\]/i,
  /\[Fast Refresh\]/i,
  /react-devtools/i,
];
