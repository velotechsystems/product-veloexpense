/**
 * The phone-project names, in one place — the list `playwright.config.ts` declares and every
 * consumer reads.
 *
 * ─── WHY THIS FILE EXISTS ────────────────────────────────────────────────────────────────
 *
 * Until P02 there were two phone projects and FOUR copies of that fact: the `projects` array
 * in `playwright.config.ts`, and a hand-kept `const PHONE_PROJECTS = ['mobile-360',
 * 'mobile-390']` in each of `e2e/desktop-notice.spec.ts`, `e2e/tap-targets.mobile.spec.ts`
 * and `e2e/support/safe-area.ts`. All three copies carried a comment saying, in as many
 * words, that a third project added to the config and not added there should "fail loudly"
 * rather than pass quietly — and none of them had any mechanism that would. The failure mode
 * they were describing is silent in every direction that matters:
 *
 *   · A project missing from `safe-area.ts` throws on first use — loud, but only once a
 *     phone spec actually runs, which needs a database, a server and a browser.
 *   · A project missing from `desktop-notice.spec.ts` is worse than loud: `expectsNotice()`
 *     returns `false` for it, so the new project asserts the DESKTOP half — the notice is
 *     absent and the page renders — at a phone width. That is green, and it is backwards.
 *   · A project missing from `tap-targets.mobile.spec.ts`'s `assertProject` call fails, but
 *     with a message about a config spec-list problem, several files from the edit.
 *
 * So the list moved here and the copies became imports. What cannot be an import is the
 * `projects` array itself: Playwright needs `name:` to be a literal (it is what `--project=`
 * matches, and what the artifact directories under `e2e/.artifacts/mobile/` are named), and
 * a config that computed its project names from this array would be harder to read than the
 * duplication it removed. That one remaining duplication is checked by text instead —
 * `scripts/check-phone-projects.mjs`, which is the guard those three comments were
 * anticipating. It runs with no browser and no database, which is the only reason it can be
 * the build-time proof that a newly declared phone project is wired to anything at all.
 *
 * ─── WHAT THE NAMES MEAN, AND DO NOT MEAN ────────────────────────────────────────────────
 *
 * Every name is a WIDTH in CSS pixels, never a handset. `mobile-412` in particular is the
 * 412 layout width and not an Android device: ruling 9 in `docs/design/pwa.md` keeps
 * `android: unverified` because nobody has run this on an Android phone, and naming a
 * project for one would be a coverage claim nothing in this repo backs. The widths are
 * chosen as the narrow end, the primary target and the wide end of the phone field.
 *
 * Kept in declaration order, which is also the order the projects appear in the config and
 * the order `npm run test:e2e:mobile` names them. Nothing depends on the order; keeping it
 * makes the three lists diffable against each other by eye.
 */
export const PHONE_PROJECTS = ['mobile-360', 'mobile-390', 'mobile-412'] as const;
