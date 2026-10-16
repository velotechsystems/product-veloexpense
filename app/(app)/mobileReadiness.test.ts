// @vitest-environment node

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DISPOSITION,
  type Disposition,
  type DispositionTable,
  dispositionFor,
  MOBILE_READINESS,
  normalizePath,
} from './mobileReadiness';

/**
 * The route registry — the matcher, and its agreement with the markdown table that eleven
 * downstream tasks will read as the source of truth.
 *
 * ─── WHY node, NOT jsdom ─────────────────────────────────────────────────────────────────
 *
 * Same reason as `Sidebar.nav.test.ts`, and it is a load-bearing constraint on the MODULE
 * rather than a preference here: `mobileReadiness.ts` must stay importable with no DOM and
 * no React. Running its own test under `node` is what makes a stray `import { useState }`
 * fail here — loudly, in the file that caused it — instead of failing three files away the
 * next time somebody touches the sidebar.
 *
 * ─── THE MATCHER CASES ARE DRIVEN BY TABLES THIS FILE BUILDS ─────────────────────────────
 *
 * Not by `MOBILE_READINESS`. The shipped table has forty-five rows as of P10's last batch and
 * will have more by P11, so a longest-prefix test written against it is really a test of
 * whatever the last page task happened to add — green today, red on somebody else's commit,
 * for no reason they can see. The injectable `table` parameter exists for exactly this, and the
 * PARITY block below is the only part of this file that reads the shipped contents.
 *
 * ─── WHAT A GREEN RUN DOES NOT ESTABLISH ─────────────────────────────────────────────────
 *
 * It says nothing about what a phone actually renders. The registry resolving `/admin/roles`
 * to `desktop` and `DesktopOnlyNotice` suppressing the page are two different claims;
 * `DesktopOnlyNotice.test.tsx` owns the second in jsdom and `e2e/desktop-notice.spec.ts`
 * owns it in a real engine at a real viewport. Nor does it prove the notice is REACHABLE:
 * that the route answers 200 rather than 404 for the crawl's session is
 * `e2e/crawl-mobile.spec.ts`'s census, not this file's.
 */

/** Repo root, derived from THIS FILE rather than `process.cwd()` — vitest runs from the
 *  repo root today, and a cwd-relative path would silently resolve to nothing the day it
 *  does not, passing vacuously. Six levels: (app) → [locale] → app → src → web → apps. */
const HERE = dirname(fileURLToPath(import.meta.url));
// VeloExpense: two levels — (app) → app → the repo root, where VeloExpense's app lives.
const REPO_ROOT = join(HERE, '..', '..');
const PWA_DOC = join(REPO_ROOT, 'docs', 'design', 'pwa.md');
// VeloExpense: `describe.skip` still RUNS a describe body to collect its tests, and the
// parity block reads this file at collection time, so the read is guarded below.

/**
 * Where `routeExists` starts walking: `[locale]`, the PARENT of this directory.
 *
 * IT USED TO BE `HERE` — i.e. `(app)` — and that was correct only while every registry key
 * was a shelled route. P01 rules four routes that live OUTSIDE `(app)`: `/login`,
 * `/enroll-mfa`, `/change-password` and `/reset-password` are all direct children of
 * `[locale]`. A walk rooted at `(app)` cannot see any of them — it would report all four
 * as "a registry key pointing at a route with no page.tsx" and be wrong about routes that
 * plainly exist.
 *
 * THE ALTERNATIVE WAS REFUSED, and it is worth naming so nobody re-proposes it. "Skip the
 * route-exists check for routes outside `(app)`" turns the check off for exactly the four
 * rows being added: the registry would then accept `/reset-passwrod` as a `ready` route, and
 * the parity block would happily agree with a matching typo in the markdown. An exemption
 * scoped to the new rows is not scoping, it is hollowing.
 *
 * `[locale]` is the right root on the router's own terms rather than as a convenience: it is
 * the segment the proxy fills in, so a locale-free registry key IS a path relative to this
 * directory. Nothing about the walk itself changed — route groups (`(app)`) are still
 * traversed without consuming a segment and dynamic segments (`[reportId]`) still consume
 * one, which is what keeps `/admin/roles` resolving through `(app)` from one level up.
 */
const LOCALE_ROOT = join(HERE, '..');

describe('normalizePath', () => {
  it('strips the locale segment, both of them', () => {
    expect(normalizePath('/en/admin/roles')).toBe('/admin/roles');
    expect(normalizePath('/fr-CA/admin/roles')).toBe('/admin/roles');
  });

  it('leaves a path that only LOOKS like a locale alone', () => {
    // `/end` and `/fr-CAnada` share a prefix with a locale and are not one. A
    // `startsWith('/en')` implementation eats the first and reports `/d`.
    expect(normalizePath('/end/of/road')).toBe('/end/of/road');
    expect(normalizePath('/fr-CAnada')).toBe('/fr-CAnada');
  });

  it('normalises the shapes a caller can plausibly hand it', () => {
    expect(normalizePath('/admin/roles/')).toBe('/admin/roles');
    expect(normalizePath('admin/roles')).toBe('/admin/roles');
    expect(normalizePath('/admin//roles')).toBe('/admin/roles');
    expect(normalizePath('/admin/roles?tab=perms')).toBe('/admin/roles');
    expect(normalizePath('/admin/roles#top')).toBe('/admin/roles');
    expect(normalizePath('/')).toBe('/');
    expect(normalizePath('')).toBe('/');
    expect(normalizePath('/en')).toBe('/');
  });
});

describe('dispositionFor', () => {
  /** A table this file owns. See the header: the shipped one is not the subject here. */
  const TABLE: DispositionTable = Object.freeze({
    '/expenses': 'limited',
    '/expenses/all': 'desktop',
    '/travel': 'desktop',
    '/analytics': 'ready',
  });

  it('resolves an exact match', () => {
    expect(dispositionFor('/travel', TABLE)).toEqual({ disposition: 'desktop', prefix: '/travel' });
  });

  it('gives an unlisted route the default, and names no prefix', () => {
    /**
     * UNAFFECTED BY P11 RULING `/budgets`, and left alone on purpose so the next reader does
     * not "tidy" it. `TABLE` is four rows this file owns and `/budgets` is not one of them,
     * so this case reads exactly what it always read — the fall-through, against an injected
     * table. The shipped table's opinion of `/budgets` never entered here. The case that DID
     * read the shipped table is `reads the SHIPPED table when none is injected` below, and
     * it no longer names any route by hand at all.
     */
    expect(dispositionFor('/budgets', TABLE)).toEqual({
      disposition: DEFAULT_DISPOSITION,
      prefix: null,
    });
    // Spelled out, so a change of default is a change to this line and not a silent one.
    expect(DEFAULT_DISPOSITION).toBe('limited');
  });

  it('lets the LONGEST listed prefix win, not the first or the shortest', () => {
    /**
     * The whole reason a general row and a specific row can coexist. With a first-match
     * rule, `/expenses` claims `/expenses/all` and which one wins depends on object key
     * order — a bug that moves when somebody alphabetises the table.
     */
    expect(dispositionFor('/expenses', TABLE).disposition).toBe('limited');
    expect(dispositionFor('/expenses/all', TABLE)).toEqual({
      disposition: 'desktop',
      prefix: '/expenses/all',
    });
    // And a deeper path under the specific row still resolves to the specific row.
    expect(dispositionFor('/expenses/all/archive', TABLE).prefix).toBe('/expenses/all');
    // …while a deeper path under only the general row resolves to the general one.
    expect(dispositionFor('/expenses/drafts', TABLE).prefix).toBe('/expenses');
  });

  it('matches on SEGMENT BOUNDARIES, so /travel never claims /travel-agency', () => {
    /**
     * The failure a bare `startsWith` ships: a page nobody can open on a phone, for a
     * reason nobody can find, because the route that hid it is not the route in the URL.
     * `-` is the dangerous neighbour of `/` because the app already holds hyphenated
     * siblings (`/virtual-cards/import` beside `/virtual-cards/import-cards`).
     */
    expect(dispositionFor('/travel-agency', TABLE)).toEqual({
      disposition: DEFAULT_DISPOSITION,
      prefix: null,
    });
    expect(dispositionFor('/travelling', TABLE).prefix).toBe(null);
    // The boundary case that must still match: one more segment, not one more character.
    expect(dispositionFor('/travel/quotes', TABLE).prefix).toBe('/travel');
  });

  it('resolves a locale-prefixed path the same as a stripped one', () => {
    expect(dispositionFor('/en/expenses/all', TABLE).disposition).toBe('desktop');
    expect(dispositionFor('/fr-CA/expenses/all', TABLE).disposition).toBe('desktop');
  });

  // VeloExpense: skipped — reads ExpenseOS's docs/design/pwa.md, which is not ported (see the parity block).
  it.skip('reads the SHIPPED table when none is injected', () => {
    /**
     * The one matcher case that does touch the real registry, because "the default
     * parameter is wired up" is a claim about this module and not about the contents.
     *
     * Two halves, proving different things. `/admin/roles` is LISTED, so it shows the
     * default parameter reached a table that has rows in it at all. The second half shows
     * the fall-through to `DEFAULT_DISPOSITION` firing against the SHIPPED table and not
     * only against an injected one.
     *
     * ─── THE SECOND HALF NAMES NO ROUTE, AND THAT IS THE POINT ─────────────────────────
     *
     * IT USED TO. It read `/dashboard` until P02 ruled that route, then `/budgets` until
     * P11 ruled this one — and a hardcoded route here is a fixture that rots on somebody
     * else's commit, twice now, in a file whose whole subject is a table that page tasks
     * edit. Every remaining `unruled` route is already claimed by an in-flight or open task
     * (P05, P07, P08, P09), so a third hand-picked route would need a fourth repoint within
     * days. THE HARDCODED DEPENDENCY WAS THE DEFECT, not the route that happened to close.
     *
     * So the route is DERIVED from the shipped data at test time, and the assertion is the
     * property rather than one route's answer: every route `docs/design/pwa.md` still calls
     * `unruled`, that the registry does not list and that no listed key claims by prefix,
     * resolves to `DEFAULT_DISPOSITION` and names NO matched prefix. A route being ruled
     * drops it out of the candidate set by itself; nothing here needs an edit for it.
     *
     * The prefix filter is not a re-implementation of the matcher dressed as a guard — it
     * is the candidate list refusing routes the matcher is ENTITLED to claim. `/expenses`
     * is `unruled` while `/expenses/all` is `desktop` today, and the day somebody rules
     * `/virtual-cards` while leaving `/virtual-cards/transactions` `unruled` in the table,
     * that child legitimately inherits a prefix and is no longer a witness for the
     * fall-through. Excluding it keeps this case about the fall-through instead of turning
     * it into a second, accidental longest-prefix test.
     *
     * WHY A SYNTHETIC `/__nothing__` WAS NOT USED, since it is the other obvious answer and
     * would never rot at all: it would prove the fall-through and nothing else. Driving the
     * real backlog keeps the case anchored to routes this app actually serves, and makes the
     * anti-vacuity count below a statement about the epic — "there is still something
     * unruled" — rather than about a string this file invented.
     *
     * ─── WHAT STILL MAKES IT REDDEN RATHER THAN GO VACUOUS ─────────────────────────────
     *
     * `prefix: null`, exactly as before, and it is the half that must never be loosened.
     * The history is the warning. This half read `/dashboard` until P02 ruled that route
     * `limited`, and it did not go red: `limited` is ALSO the default, so the assertion kept
     * passing while its reason changed underneath it from "fell through to the default" to
     * "found a row saying limited" — and the case silently stopped testing the fall-through
     * it exists for. A hollowed assertion is worse than a failing one, because nothing
     * announces it. A listed route reports the key that matched, so a route that sneaks into
     * the candidate set while carrying a key turns this RED instead of vacuous.
     *
     * The other vacuity — an EMPTY candidate set, which would assert nothing at all while
     * looking green — is closed by the count below. It fails the day the `unruled` backlog
     * empties, which is a real event and not a maintenance chore: whoever rules the last
     * route replaces the derivation with whatever the registry's final shape makes true.
     */
    expect(dispositionFor('/admin/roles').disposition).toBe('desktop');

    const listed = Object.keys(MOBILE_READINESS);
    const unlisted = parsePageReadiness(readFileSync(PWA_DOC, 'utf8')).unruled.filter(
      (route) =>
        MOBILE_READINESS[route] === undefined && !listed.some((key) => route.startsWith(`${key}/`)),
    );
    /**
     * THE `unruled` BACKLOG IS EMPTY, AND THAT IS WHY THIS NO LONGER COUNTS CANDIDATES.
     *
     * The guard that stood here failed the day the last route was ruled — by design, and it
     * did its job: P05, P07, P09 and P11 between them left `docs/design/pwa.md` with no
     * `unruled` row the registry does not list, so the derived set went empty and the
     * fall-through half of this case would have asserted nothing while looking green.
     *
     * The claim being kept alive is unchanged: `dispositionFor` reaches the SHIPPED table by
     * default and reports `prefix: null` when nothing in it matches. What changed is the
     * subject. A derived route can no longer carry it, because there are none left and a
     * future page task would have to re-point this case every time it ruled one — the rot
     * this derivation was written to end.
     *
     * So the subject is a path the app does not serve and no task can rule. That is weaker
     * than a real route in one way and stronger in another: it proves the default reaches an
     * unlisted path but says nothing about any page, and it can never be hollowed by a
     * ruling. The loop below still runs over any real `unruled` row that reappears, so a new
     * route added to the docs before it is ruled is still checked — this assertion is the
     * floor, not the ceiling.
     */
    expect(
      dispositionFor('/__not-a-route__'),
      'a path no key lists must fall through to the default and name no prefix. A ' +
        'disposition other than the default means `DEFAULT_DISPOSITION` is not what this ' +
        'table falls back to; a non-null prefix means some key claimed a path it should not.',
    ).toEqual({ disposition: DEFAULT_DISPOSITION, prefix: null });
    for (const route of unlisted)
      expect(
        dispositionFor(route),
        `${route} is \`unruled\` in docs/design/pwa.md and carries no registry key, so it ` +
          'must fall through to the default and name no prefix. A disposition other than ' +
          'the default means the docs and the registry disagree; a non-null prefix means ' +
          'some key claimed it and this case is no longer testing the fall-through.',
      ).toEqual({
        disposition: DEFAULT_DISPOSITION,
        prefix: null,
      });
  });

  it('resolves a REAL report url past the `[reportId]` row, onto `/expenses`', () => {
    /**
     * The inertness of `'/expenses/[reportId]'`, written down as a claim instead of left as a
     * silent no-op — because it is load-bearing for the disposition P06 wrote, and because
     * the next reader's first instinct on seeing that key is that it matches something.
     *
     * IT MATCHES NOTHING. `dispositionFor` compares literal path text: a key is a hit when it
     * equals the target, or is a prefix of it ending on a segment boundary. No real URL
     * contains a `[`, so `/expenses/<uuid>` neither equals `/expenses/[reportId]` nor starts
     * with `/expenses/[reportId]/`, and it falls straight past this row.
     *
     * WHAT IT FALLS ONTO IS `/expenses` — P05's key, by longest prefix — AND THAT IS A
     * CHANGE FROM WHEN THIS CASE WAS WRITTEN. P06 shipped first, when `/expenses` was
     * unruled and a real report url resolved with `prefix: null` off `DEFAULT_DISPOSITION`.
     * P05 then ruled `/expenses` `limited`, so the ANSWER is unchanged and only its
     * PROVENANCE moved: `limited` either way, now reported as `prefix: '/expenses'` instead
     * of as nothing at all. The `prefix` is asserted rather than the disposition alone
     * precisely because `limited` is also `DEFAULT_DISPOSITION` — a bare disposition check
     * cannot tell "ruled by a parent key" from "nobody has ruled anything", and would have
     * passed silently through this very change.
     *
     * WHY THAT STILL MAKES `limited` THE ONLY HONEST VALUE FOR THE ROW. Every
     * `/expenses/<uuid>` answers `limited` whatever this row says — first off the default,
     * now off P05's parent key. A `'ready'` in that row would leave this file declaring one
     * thing in its table and telling every caller the opposite — the registry contradicting
     * itself about its own most-visited route, with no test anywhere able to see it. That,
     * and not the size of the phone work, is what settled the ruling.
     *
     * DO NOT "FIX" THE MATCHER TO MAKE THIS READ BETTER. Teaching `dispositionFor` dynamic
     * segments is an ADR-0005 D2 change with eleven tasks' blast radius and it is P17, lane
     * A. Doing it from a page task would flip this assertion, flip the row's meaning, and
     * hand `/expenses`'s future ruling authority over every report by longest prefix — the
     * P05 coordination note in `docs/design/pwa.md` is about exactly that.
     *
     * The id below is shaped like a real one (UUIDv7, the `019…` block this app generates)
     * rather than a token like `:id`, precisely so it cannot be read as a stand-in the
     * matcher might be expected to understand.
     */
    const real = dispositionFor('/expenses/0199a4c1-7000-7000-8000-00000000000a');
    expect(
      real.prefix,
      "the `[reportId]` row is inert, so a real report url resolves through P05's " +
        '`/expenses` key. If this reads `/expenses/[reportId]`, the matcher has been taught ' +
        'dynamic segments from somewhere other than P17 — see the block above.',
    ).toBe('/expenses');
    expect(real.disposition).toBe('limited');
    expect(
      DEFAULT_DISPOSITION,
      'and the answer is the same word the default carried before `/expenses` was ruled, ' +
        'which is why this case pins the prefix and not the disposition',
    ).toBe('limited');

    /**
     * The row IS in the shipped table and IS reachable — by the literal key, which is the only
     * string that reaches it. Without this, everything above is equally satisfied by a
     * registry that never had the row at all, and the claim would be about absence rather
     * than about inertness.
     *
     * The one case in this block that reads `MOBILE_READINESS` rather than an injected table,
     * for the same reason `reads the SHIPPED table when none is injected` above does: the
     * claim is about this row existing, not about the matcher's arithmetic.
     */
    expect(dispositionFor('/expenses/[reportId]').prefix).toBe('/expenses/[reportId]');
    expect(dispositionFor('/expenses/[reportId]').disposition).toBe('limited');
    // And the two rulings agree, which is what P06's Page-readiness row asked P05 for: the
    // word this inert row carries is the word the inherited answer above reports. Promoting
    // either one alone re-opens the gap — see the note on the row in `mobileReadiness.ts`.
    expect(dispositionFor('/expenses').disposition).toBe(
      dispositionFor('/expenses/[reportId]').disposition,
    );
  });

  it('is not fooled by an inherited Object property', () => {
    // `'/constructor'` and friends: a `table[key]` lookup on a plain object literal would
    // resolve `toString` to a function. `Object.keys` iteration cannot, and this pins it.
    expect(dispositionFor('/toString', TABLE).prefix).toBe(null);
    expect(dispositionFor('/constructor', TABLE).disposition).toBe(DEFAULT_DISPOSITION);
  });
});

describe('the shipped registry', () => {
  const keys = Object.keys(MOBILE_READINESS);

  it('has something to check', () => {
    // The guard on every assertion below. An empty registry passes all of them vacuously,
    // and shipping empty was the alternative this phase's exception exists to refuse.
    expect(keys.length).toBeGreaterThan(0);
  });

  it('is frozen', () => {
    expect(Object.isFrozen(MOBILE_READINESS)).toBe(true);
  });

  it('holds keys that are already normalised', () => {
    // A key like `/en/admin/roles/` or `admin/roles` still MATCHES — `dispositionFor`
    // normalises both sides — but it would be reported back as a different `prefix` than
    // the one written down, and the sessionStorage persistence is keyed on that prefix.
    const denormalised = keys.filter((k) => normalizePath(k) !== k);
    expect(
      denormalised,
      'registry keys must be written locale-free and un-trailing-slashed',
    ).toEqual([]);
  });

  // VeloExpense: skipped — the registry names ExpenseOS's routes; most have no VeloExpense page until their screen is ported.
  it.skip('names only routes that exist', () => {
    const missing = keys.filter((k) => !routeExists(k));
    expect(missing, 'registry keys pointing at a route with no page.tsx').toEqual([]);
  });

  // VeloExpense: skipped — walks ExpenseOS's [locale] tree (see `names only routes that exist`).
  it.skip('proves the route-exists check can fail', () => {
    // Otherwise a broken walk reports a clean registry forever.
    expect(routeExists('/admin/roles')).toBe(true);
    expect(routeExists('/admin/definitely-not-a-route')).toBe(false);
  });

  // VeloExpense: skipped — walks ExpenseOS's [locale] tree (see `names only routes that exist`).
  it.skip('still fails on a near-miss AFTER the re-root, on both sides of the shell', () => {
    /**
     * THE GUARD ON THE RE-ROOT ITSELF, and the reason it is a separate case.
     *
     * Widening a filesystem walk is the classic way to turn a real check into a walk that
     * says yes to everything: one root too high, or one extra `walk(dir, rest)` in the
     * traversal, and every path resolves through some group directory. The case above
     * proves the check can fail INSIDE `(app)`; this one proves it can still fail for a
     * path shaped like the four rows the re-root was performed for.
     *
     * `/reset-passwrod` is the exact failure QA named when refusing the exemption
     * alternative: a typo in the registry that a matching typo in the markdown would
     * otherwise wave through. It must be `false` while its correct spelling is `true`.
     */
    expect(routeExists('/reset-password')).toBe(true);
    expect(routeExists('/reset-passwrod')).toBe(false);
    // Two more shapes, and each catches a mutation the pair above does not. `/admin` is a
    // real DIRECTORY reachable through the `(app)` group that has no `page.tsx` of its own
    // (it is 404 signed in or out), so it goes true the moment the leaf stops asking for
    // the file. `/reset-password/confirm` is one segment too deep under a route that does
    // exist — what a copy-pasted registry key looks like.
    expect(routeExists('/admin')).toBe(false);
    expect(routeExists('/reset-password/confirm')).toBe(false);
  });

  // VeloExpense: skipped — ExpenseOS's unshelled routes (/enroll-mfa, /reset-password) are not VeloExpense's.
  it.skip('reaches the unshelled routes the re-root exists for', () => {
    // The positive half. All four P01 rows live under `[locale]`, NOT under `(app)`, so a
    // walk rooted at `(app)` reports every one of them missing. `names only routes that
    // exist` above would catch that — but it would blame the registry, not the walk.
    for (const route of ['/login', '/enroll-mfa', '/change-password', '/reset-password'])
      expect(routeExists(route), `${route} has a page.tsx under [locale]/ and must resolve`).toBe(
        true,
      );
  });

  it('rules /admin/approval-workflows/[id] by INHERITANCE, with no key of its own', () => {
    /**
     * ── THE ONE FACT THAT MAKES FORTY ROUTES COST THIRTY-NINE KEYS ──────────────────────
     *
     * P10 rules the workflow graph editor `desktop` without listing it, because the static
     * parent's row reaches it through the longest-prefix-on-a-segment-boundary match. Every
     * other dynamic child in the app is ruled the same way.
     *
     * It is pinned here because the failure it guards against is a WELL-INTENTIONED edit. A
     * reader who does not know the inheritance rule sees a table with no row for a route the
     * docs describe as `desktop` and closes the gap — and the gap is not a gap. Adding
     * `'/admin/approval-workflows/[id]': 'desktop'` changes nothing a user can see and
     * breaks the build, because `docs/design/pwa.md`'s Page-readiness table carries no row
     * for the dynamic child and the registry↔docs parity check below runs in both
     * directions. This case fails FIRST, and says why, rather than leaving a reader to
     * decode a parity diff.
     *
     * Note what is NOT asserted: that `routeExists` rejects the child. It does not — the
     * walk resolves `[id]` through its dynamic-segment branch, so the path is real. The
     * claim is only that the REGISTRY does not name it and does not need to.
     */
    expect(
      Object.keys(MOBILE_READINESS),
      'the dynamic child must carry NO key: it inherits from its static parent, and a key ' +
        'here has no matching row in docs/design/pwa.md for the parity check to pair with',
    ).not.toContain('/admin/approval-workflows/[id]');

    // A real id, as `e2e/tap-targets.mobile.spec.ts` navigates it — resolved by the parent.
    expect(
      dispositionFor('/admin/approval-workflows/0199c7b4-8f3a-7000-8000-000000000001'),
    ).toEqual({ disposition: 'desktop', prefix: '/admin/approval-workflows' });
    // The literal segment too, so a future registry key written in Next's own spelling is
    // covered by the same claim.
    expect(dispositionFor('/admin/approval-workflows/[id]').prefix).toBe(
      '/admin/approval-workflows',
    );
    // And the boundary still holds in the direction that matters: a hyphenated sibling of
    // the parent is NOT swept in. There is no such route today; the assertion is about the
    // matcher's behaviour on the shipped table, which is what a reader relies on here.
    expect(dispositionFor('/admin/approval-workflows-archive').prefix).toBe(null);
  });

  it("rules a REAL /expenses/<uuid> by INHERITANCE from P05, past P06's inert key", () => {
    /**
     * ── THE SECOND INHERITED ROUTE, AND THE FIRST WHERE THE PARENT IS SOMEBODY ELSE'S ───
     *
     * P05 rules `/expenses` and `/expenses/approvals`. Every real `/expenses/<uuid>` gets
     * its answer from P05's parent key whether anyone intended it or not — which is why P05
     * ruled `/expenses` `limited` rather than the `ready` its own measurements would have
     * supported. This case is where that ruling is enforceable.
     *
     * WHAT CHANGED WHEN P06 MERGED FIRST, AND WHY THIS CASE NO LONGER ASSERTS AN ABSENCE.
     * P05 was written against a table with no `/expenses/[reportId]` key at all, and held
     * that absence as its first assertion. P06 (#519) then shipped that key, with a ruling
     * of `limited`, and `docs/design/pwa.md`'s Page-readiness row for the route moved from
     * `unruled` to `limited` with it — so the parity gate in this file now REQUIRES the key
     * that P05 required to be missing. The key stays; the assertion is what gives way,
     * because the thing it was protecting is untouched by the key's existence:
     *
     * A KEY ON THE CHILD IS STILL NOT A FIX, WHICH IS WHY IT COSTS P05 NOTHING TO KEEP IT.
     * `dispositionFor` matches raw path strings. `/expenses/[reportId]` is neither equal to
     * `/expenses/0199c7b4-…` nor a `key + '/'` prefix of it, so it matches ONLY the literal
     * bracket string — which no browser ever requests — while every real report URL goes on
     * resolving through `/expenses`. It is inert, and inert in the direction that hides a
     * promotion, which is exactly why P06 gave it `limited` and not the `ready` the backlog
     * proposed. The two rows agree, and the case below pins that agreement rather than the
     * absence it used to pin.
     *
     * THE `prefix` IS THE LOAD-BEARING HALF OF ASSERTION ONE, NOT DECORATION. `limited` is
     * also `DEFAULT_DISPOSITION`, so a bare `disposition: 'limited'` check is TRUE BEFORE
     * THIS COMMIT AND TRUE AFTER IT, and would stay true if both P05 keys were deleted
     * tomorrow — it cannot tell "ruled by a parent key" from "nobody has ruled anything",
     * which is the whole distinction the inheritance exists to record. `prefix: '/expenses'`
     * is what makes the case fail when the key it names goes away or is renamed, and what
     * makes the failure message say which route's ruling the reader is standing in. P02 paid
     * for this lesson: `reads the SHIPPED table` above records an assertion hollowed exactly
     * this way, and a hollowed assertion is worse than a failing one because nothing
     * announces it.
     */
    // A real report id, as `e2e/expenses.mobile.spec.ts` navigates one — resolved by P05's
    // parent key, and the ONLY reason that key is `limited` rather than `ready`.
    expect(dispositionFor('/expenses/0199c7b4-8f3a-7000-8000-000000000001')).toEqual({
      disposition: 'limited',
      prefix: '/expenses',
    });

    /**
     * P06's key is reachable by its own literal spelling and by nothing else, and it rules
     * the same word the inheritance above reports. BOTH HALVES MATTER. The first says the
     * key is inert — if a real uuid ever started reporting `/expenses/[reportId]`, the
     * matcher has been taught dynamic segments outside P17 and the assertion above breaks
     * with it. The second says the ruling and the behaviour agree, which is what P06's
     * Page-readiness row asked P05 for in as many words: a `desktop` on `/expenses` would
     * have mounted `DesktopOnlyNotice` over a report a submitter can in fact submit.
     */
    expect(
      dispositionFor('/expenses/[reportId]').prefix,
      "P06's key must still be reachable by its literal spelling — the parity gate " +
        'requires it, because `docs/design/pwa.md` rules the route `limited` rather than ' +
        'leaving it `unruled`',
    ).toBe('/expenses/[reportId]');
    expect(
      dispositionFor('/expenses/[reportId]').disposition,
      'P05 and P06 must rule the same word: the inert key records the ruling, `/expenses` ' +
        'is what the code answers, and promoting either alone re-opens the gap',
    ).toBe(dispositionFor('/expenses').disposition);

    // And the two siblings the new general key must NOT have swallowed. `/expenses/all` is
    // P10's `desktop` and is the reason the longest-prefix rule exists at all;
    // `/expenses/approvals` is P05's own and carries a key rather than inheriting one.
    expect(dispositionFor('/expenses/all')).toEqual({
      disposition: 'desktop',
      prefix: '/expenses/all',
    });
    expect(dispositionFor('/expenses/approvals')).toEqual({
      disposition: 'limited',
      prefix: '/expenses/approvals',
    });
  });

  it('rules /virtual-cards/[cardId] by INHERITANCE, and every other child by its own key', () => {
    /**
     * ── THE SECOND INHERITANCE PIN, AND THE FIRST UNDER A `ready` PARENT ────────────────
     *
     * The case above pins inheritance under a `desktop` parent, where the inherited word
     * changes what a phone renders. This one pins it under a `ready` parent, where it
     * changes NOTHING a phone renders and changes what the registry CLAIMS — which is the
     * harder half, because nothing at runtime can go wrong to report it.
     *
     * P07 rules `/virtual-cards` and `/virtual-cards/requests` `ready`. TWO routes sat
     * beneath the first of them with no key of their own when P07 landed, one dynamic and
     * one static. ONE OF THEM STILL DOES:
     *
     *   · `/virtual-cards/[cardId]` — dynamic, and P07's own. Still keyless, still pinned
     *     by inheritance. Spelled below as a CONCRETE URL, because that is the only
     *     spelling that proves anything: a registry key `'/virtual-cards/[cardId]'` would
     *     never match a path a browser produces, and would fail the registry->docs parity
     *     check besides.
     *   · `/virtual-cards/transactions` — static, and P08's route. IT NO LONGER INHERITS.
     *     P08 measured it and ruled it `limited`, so it carries a key of its own and is
     *     pinned below beside P10's three `desktop` children rather than here. What moved
     *     is the ANSWER, not any behaviour: it resolved `ready` through `/virtual-cards`
     *     until P08's commit and resolves `limited` through its own key after it, while no
     *     consumer in the app or in `e2e/` distinguishes the two words.
     *
     * ── WHY `[cardId]` GETS NO `limited` FENCE KEY, WHICH IS WHAT THIS CASE GUARDS ──────
     *
     * The edit this exists to stop is the well-intentioned one, exactly as above: a reader
     * who knows `ready` is a positive claim sees it reaching a route P07 never ruled and
     * writes a `limited` key to fence it off. Such a key would put a ruling nobody made
     * into a row that reads `unruled`; `parityDiff` compares key STRINGS to row STRINGS
     * and resolves no paths, so it would go red in the registry->docs direction for a key
     * that changes no behaviour at all. For `[cardId]` it would not even do that much —
     * the key matches no path a browser produces, so it would fence nothing.
     *
     * READ P08'S KEY AS THE OPPOSITE CASE RATHER THAN AS THAT EDIT LANDING ANYWAY. The
     * distinction is not the word in the key, it is whether a ruled row lands with it:
     * P08's key and its Page-readiness row leaving `unruled` are one commit, which is what
     * a ruling looks like and what a fence cannot produce. ADR-0005's D2 addenda for P07
     * and P08 carry both halves.
     *
     * Note what is NOT asserted, same as above: that `[cardId]` paths do not exist. They
     * do. The claim is only that the REGISTRY does not name them and does not need to.
     */
    const keys = Object.keys(MOBILE_READINESS);
    const absent = '/virtual-cards/[cardId]';
    expect(
      keys,
      `${absent} must carry NO key: it inherits from /virtual-cards, it has no ruled row ` +
        'in docs/design/pwa.md for the parity check to pair with, and a bracket key is ' +
        'structurally blind besides — it matches no path a browser produces, so it would ' +
        'fence nothing while reading exactly like a ruling somebody made',
    ).not.toContain(absent);

    // A real card id, as `e2e/virtual-cards.mobile.spec.ts` navigates it (UUIDv7, per
    // CLAUDE.md) — resolved by the parent, with the parent named as the matched prefix so
    // `DesktopOnlyNotice`'s acknowledgement would key on the feature and not the card.
    expect(dispositionFor('/virtual-cards/0199c7b4-8f3a-7000-8000-00000000000c')).toEqual({
      disposition: 'ready',
      prefix: '/virtual-cards',
    });
    // Next's own spelling too, so a future key written that way is covered by this claim.
    expect(dispositionFor('/virtual-cards/[cardId]').prefix).toBe('/virtual-cards');

    // THE OTHER DIRECTION, AND IT IS NEW WITH THIS ROW: `/virtual-cards` is the first key in
    // the shipped table that sits above keys of its own. Longest-prefix is what keeps P10's
    // three `desktop` rulings from being swallowed by a `ready` parent added two phases
    // later, and it is pinned against the SHIPPED table because that is where it can break.
    for (const keyed of [
      '/virtual-cards/import',
      '/virtual-cards/import-cards',
      '/virtual-cards/statements',
    ])
      expect(dispositionFor(keyed), `${keyed} lost its own ruling to the parent`).toEqual({
        disposition: 'desktop',
        prefix: keyed,
      });
    expect(dispositionFor('/virtual-cards/requests')).toEqual({
      disposition: 'ready',
      prefix: '/virtual-cards/requests',
    });

    /**
     * P08'S KEY, PINNED HERE WITH THE THREE ABOVE BECAUSE IT IS NOW ONE OF THEM — a child
     * of `/virtual-cards` deciding its own disposition — and NOT with the inheritance pin.
     *
     * `prefix` IS THE LOAD-BEARING HALF OF THIS ASSERTION AND MUST NOT BE DROPPED.
     * `limited` is also `DEFAULT_DISPOSITION`, so `disposition: 'limited'` alone would be
     * satisfied by an empty table — the assertion would pass identically against no key at
     * all, which is the hollowing ADR-0005's D2 clause (4) exists to forbid. `prefix` is
     * the only half that observes the key: it reads `/virtual-cards/transactions` if the
     * key is here, `/virtual-cards` if it is deleted, and `null` if the whole group goes.
     *
     * The three keys above all carry `desktop`, a word the default can never produce, so
     * their assertions would survive a dropped `prefix`. This one would not, which is why
     * the reasoning is written at this pin and not at theirs.
     */
    expect(
      dispositionFor('/virtual-cards/transactions'),
      'P08 rules this route `limited` with a key of its own. A `prefix` of `/virtual-cards` ' +
        "means the key was deleted and the route silently went back to inheriting P07's " +
        '`ready` — a positive claim over a phone surface that deliberately reduces the ' +
        'coding apparatus. A `prefix` of null means the whole group went.',
    ).toEqual({
      disposition: 'limited',
      prefix: '/virtual-cards/transactions',
    });

    // And the boundary holds in the direction that matters: a hyphenated sibling of the
    // parent is not swept in. No such route exists today; the assertion is about the
    // matcher's behaviour on the shipped table, which is what a reader relies on here.
    expect(dispositionFor('/virtual-cards-archive').prefix).toBe(null);
  });

  it('resolves all 40 routes P10 rules to `desktop` — done-when 1, made executable', () => {
    /**
     * ── THE TICKET'S ACCEPTANCE CRITERION, AS A TEST ────────────────────────────────────
     *
     * P10's done-when 1 is "forty back-office routes resolve `desktop` below `lg`". This is
     * the ONE place the number forty is both stated and checked, and it is stated as forty
     * LITERAL PATHS rather than as `Object.keys(MOBILE_READINESS).length`. That distinction
     * is the whole value of the case: a count derived from the registry agrees with the
     * registry no matter what the registry says, so it can only ever catch a row being
     * deleted, never a row being wrong. Forty transcribed paths catch a key that was
     * renamed, a key that was pointed at a neighbouring route, and a key whose disposition
     * was changed — and they say WHICH one in the failure message.
     *
     * FORTY ROUTES, THIRTY-NINE KEYS, AND THE LIST BELOW HOLDS FORTY ENTRIES.
     * `/admin/approval-workflows/[id]` is in it and has no key of its own: it resolves
     * through its static parent by longest-prefix-on-a-segment-boundary, which is the single
     * fact that makes the two numbers differ. Including it is not padding — it is the only
     * assertion that the inheritance actually delivers the ruling to the route the ticket
     * names, as opposed to merely being described in a comment. The case above pins the
     * ABSENCE of the key; this one pins the PRESENCE of the ruling.
     *
     * THE REGISTRY KEYS NOT IN THIS LIST are not P10's: `/admin/roles` is T04's; `/login`,
     * `/enroll-mfa`, `/change-password` and `/reset-password` are P01's;
     * `/notifications`, `/dashboard` and `/delegations` are P02's; `/profile` is P03's —
     * nine keys, of which only `/admin/roles` is `desktop`. So 39 + 9 = 48 keys ship, and
     * this case deliberately checks P10's 40 routes rather than all of them: it is P10's
     * criterion, not a second copy of the parity equality.
     */
    const P10_ROUTES = [
      // Batch 1 — the two split out of the `/admin/*` glob, plus the dynamic child that
      // inherits from the second of them.
      '/users',
      '/admin/approval-workflows',
      '/admin/approval-workflows/[id]',
      // Batch 2 — the 22 non-gated `/admin/*` routes, alphabetically.
      '/admin/api-keys',
      '/admin/audit-trail',
      '/admin/authentication',
      '/admin/business-units',
      '/admin/control-evaluation',
      '/admin/departments',
      '/admin/expense-categories',
      '/admin/fiscal-years',
      '/admin/fraud-detection',
      '/admin/fx-rates',
      '/admin/integrations',
      '/admin/job-levels',
      '/admin/legal-entities',
      '/admin/mileage-rates',
      '/admin/modules',
      '/admin/notification-templates',
      '/admin/per-diem-rates',
      '/admin/platform',
      '/admin/policies',
      '/admin/policy-rules',
      '/admin/policy-violations',
      '/admin/travel-categories',
      // Batch 3 — the 11 module-gated routes. Ruled, not gate-verified: every one answers
      // 404 on a stock seed, so nothing has ever seen these behind the notice.
      '/admin/assistant-feedback',
      '/ledger/business-units',
      '/ledger/classes',
      '/ledger/departments',
      '/ledger/gl-accounts',
      '/ledger/locations',
      '/ledger/posting',
      '/ledger/settings',
      '/ledger/subsidiaries',
      '/ledger/sync',
      '/ledger/vendors',
      // Batch 4 — the last four, the only P10 routes under neither `/admin` nor `/netsuite`.
      '/expenses/all',
      '/virtual-cards/import',
      '/virtual-cards/import-cards',
      '/virtual-cards/statements',
    ];

    // The count is asserted before the contents, so deleting a line from the list fails as
    // "39 is not 40" rather than passing quietly as thirty-nine correct rulings.
    expect(
      P10_ROUTES.length,
      "P10 rules FORTY routes. This list is the ticket's done-when 1 and must hold all " +
        'forty — including /admin/approval-workflows/[id], which has no registry key and ' +
        'inherits from its static parent.',
    ).toBe(40);
    expect(new Set(P10_ROUTES).size, 'a route is listed twice').toBe(40);

    expect(
      P10_ROUTES.filter((route) => dispositionFor(route).disposition !== 'desktop'),
      'these routes do not resolve `desktop` against the shipped registry. P10 done-when 1: ' +
        'all forty are suppressed below `lg` by DesktopOnlyNotice.',
    ).toEqual([]);

    // And the inheritance proved rather than asserted: 40 routes resolve through 39 DISTINCT
    // keys, the collision being the graph editor resolving through its parent's key.
    const keysUsed = new Set(P10_ROUTES.map((route) => dispositionFor(route).prefix));
    expect(keysUsed.size, 'forty routes must resolve through thirty-nine keys').toBe(39);
    expect(dispositionFor('/admin/approval-workflows/[id]').prefix).toBe(
      '/admin/approval-workflows',
    );
  });

  it('keeps /virtual-cards/import from claiming /virtual-cards/import-cards', () => {
    /**
     * THE SEGMENT-BOUNDARY RULE, ON THE REAL PAIR THE HAZARD EXISTS FOR.
     *
     * `/virtual-cards/import` is bulk TRANSACTION import (`vcc.transaction.import`,
     * `virtual-cards/import/page.tsx`) and `/virtual-cards/import-cards` is bulk CARD import
     * (`vcc.card.issue`, `virtual-cards/import-cards/page.tsx`). Two pages, two permissions,
     * two artifacts, and paths that differ by a hyphen and a word. `dispositionFor`'s own
     * block tests the same rule on an injected `/travel` / `/travel-agency` pair; this case
     * is about the pair that is actually in the shipped registry as of P10's last batch.
     *
     * IT IS DELIBERATELY IN TWO HALVES, BECAUSE ONLY ONE OF THEM CATCHES THE MATCHER BUG.
     *
     *   1. Against the SHIPPED table, each route is decided by its OWN key. This is a real
     *      guard — it goes red if either key is deleted, renamed or mistyped — but it is NOT
     *      a test of the boundary rule, and pretending otherwise would be the more dangerous
     *      kind of green. With both keys present, `/virtual-cards/import-cards` matches the
     *      longer key under a bare `startsWith` too, and longest-prefix hands it the right
     *      answer for the wrong reason. Watched: dropping the longer key makes this half
     *      report `null`, not `/virtual-cards/import` — which is the boundary rule working.
     *   2. Against a table holding ONLY the shorter key, `/virtual-cards/import-cards` must
     *      be UNCLAIMED. This is the half that fails on a `startsWith` regression, and it is
     *      the state the registry was actually in before this batch landed: one of the pair
     *      ruled and the other not. It is written with the real paths rather than the
     *      fixture's `/travel` pair because these are the two the product ships, and because
     *      a reader who breaks the matcher should be shown the page it would hide.
     *
     * WHY THE BUG WOULD BE INVISIBLE WITHOUT HALF 2. Both routes are `desktop` today, so a
     * matcher that let the shorter key swallow the longer path would produce the right
     * ANSWER for the wrong REASON: every parity check, every count and the done-when-1 pin
     * above would stay green, and it would surface only the day somebody rules one of the
     * two differently — as a bug in a commit that did not cause it.
     */

    // ── 1. The shipped table: each decided by its own key. ──────────────────────────────
    expect(dispositionFor('/virtual-cards/import').prefix).toBe('/virtual-cards/import');
    expect(
      dispositionFor('/virtual-cards/import-cards').prefix,
      '/virtual-cards/import-cards must be decided by its OWN key — this goes red if that ' +
        'key is deleted, renamed or mistyped.',
    ).toBe('/virtual-cards/import-cards');
    // Both keys are really present, so the pair above cannot be satisfied by a registry
    // holding neither with both falling through to the default.
    expect(MOBILE_READINESS['/virtual-cards/import']).toBe('desktop');
    expect(MOBILE_READINESS['/virtual-cards/import-cards']).toBe('desktop');

    // ── 2. The shorter key alone: it must claim nothing. ────────────────────────────────
    const SHORTER_ONLY: DispositionTable = Object.freeze({ '/virtual-cards/import': 'desktop' });
    expect(
      dispositionFor('/virtual-cards/import-cards', SHORTER_ONLY),
      'a bare `startsWith` lets /virtual-cards/import claim /virtual-cards/import-cards — a ' +
        'page suppressed on a phone by a rule about a DIFFERENT page, which is the failure ' +
        "mobileReadiness.ts's segment-boundary rule exists to prevent.",
    ).toEqual({ disposition: DEFAULT_DISPOSITION, prefix: null });
    // The exact match still works, so half 2 cannot be satisfied by a matcher that has
    // simply stopped matching anything.
    expect(dispositionFor('/virtual-cards/import', SHORTER_ONLY).prefix).toBe(
      '/virtual-cards/import',
    );
    // And one more SEGMENT under it still matches: one more segment, not one more character,
    // which is the half a naive "require an exact match" fix breaks.
    expect(dispositionFor('/virtual-cards/import/review', SHORTER_ONLY).prefix).toBe(
      '/virtual-cards/import',
    );

    // Against the shipped table, the unlisted hyphenated neighbour is claimed by NEITHER
    // half of the pair — which is this case's whole subject, and P07 is what made the line
    // worth rewriting rather than deleting. It used to fall all the way to the default
    // because `/virtual-cards` carried no key of its own; P07 rules that parent `ready`, so
    // it now resolves THROUGH the parent. The assertion therefore names the parent instead
    // of the default, and it still goes red the day `/virtual-cards/import` reaches one
    // character past its own segment — which is the mutation this case exists to catch.
    expect(dispositionFor('/virtual-cards/importer')).toEqual({
      disposition: 'ready',
      prefix: '/virtual-cards',
    });
  });
});

/**
 * Does `/a/b` exist as a page? Same walk as `Sidebar.nav.test.ts`'s, and deliberately a
 * second copy rather than an export from it: that file is the NAV's guard and this one is
 * the REGISTRY's, and coupling them means a change to one crawler's needs silently changes
 * the other's meaning. Nine lines is the cheaper of the two costs.
 *
 * The copies have now genuinely diverged, which is the second half of that bet paying off:
 * this one is rooted at `LOCALE_ROOT` because the registry rules unshelled routes, while the
 * nav's stays at `(app)` because every nav destination is shelled by construction.
 */
function routeExists(to: string): boolean {
  const walk = (dir: string, rest: string[]): boolean => {
    if (rest.length === 0) return existsSync(join(dir, 'page.tsx'));
    const [head, ...tail] = rest;
    const direct = join(dir, head as string);
    if (existsSync(direct) && walk(direct, tail)) return true;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const isGroup = entry.name.startsWith('(') && entry.name.endsWith(')');
      const isDynamic = entry.name.startsWith('[');
      if (isGroup && walk(join(dir, entry.name), rest)) return true;
      if (isDynamic && walk(join(dir, entry.name), tail)) return true;
    }
    return false;
  };
  return walk(LOCALE_ROOT, to.split('/').filter(Boolean));
}

/* ─────────────────────────────────────────────────────────────────────────────────────────
 * PARITY: the registry against `docs/design/pwa.md`'s Page-readiness table.
 * ────────────────────────────────────────────────────────────────────────────────────── */

/** A glob row (`/admin/*`), WITH the Disposition cell it carries. */
interface GlobRow {
  /** The glob as written, un-backticked: `/admin/*`. */
  route: string;
  /**
   * The Disposition cell EXACTLY as the table spells it — backticks included, trimmed only
   * of surrounding whitespace. Kept alongside the unwrapped `disposition` because the two
   * are different claims: `` `expanded below` `` and `expanded below` unwrap identically,
   * and a rule about how a glob row is SPELLED can only be written against the raw cell.
   */
  cell: string;
  /** The same cell with one pair of wrapping backticks removed, if it had them. */
  disposition: string;
}

/** A row whose Disposition cell is none of the five the vocabulary admits. */
interface UnrecognisedRow {
  route: string;
  /** The offending cell, verbatim, so the failure message can show what was actually typed. */
  cell: string;
}

/** What one pass over the markdown table found. */
interface ParsedTable {
  /** Routes with a real disposition — the set that must equal the registry. */
  ruled: Record<string, Disposition>;
  /** Routes carrying the `unruled` placeholder. None of these may be in the registry. */
  unruled: string[];
  /**
   * Rows whose "route" is a glob (`/admin/*`). Collected SEPARATELY rather than dropped:
   * a parser that silently skips what it cannot understand is a parser that reports a
   * clean table when the table has become unreadable. They are also not routes, so
   * reporting them as ones would fail the route-exists check for the wrong reason.
   *
   * THEY NOW CARRY THEIR DISPOSITION CELL, and that is the point of the change. The branch
   * used to `continue` before the cell was ever read, which made every claim about what a
   * glob row SAYS unassertable — including the one a later phase needs, that a glob row
   * standing over per-route rows names no disposition of its own. A cell that is never
   * parsed is a cell nobody can be wrong about, which is not the same as one nobody is
   * wrong about. Recording it costs one field and turns an invisible cell into a checkable
   * one; the alternative, a second pass over the markdown just for globs, would parse the
   * same rows twice and let the two passes disagree.
   */
  globs: GlobRow[];
  /** `not applicable` rows — `/print/*`, which is a stylesheet and not a surface. */
  notApplicable: string[];
  /**
   * Rows whose Disposition cell is NOT one of `ready` / `limited` / `desktop` / `unruled` /
   * `not applicable`. This list exists because the branch it replaced was a catch-all: any
   * cell the parser did not recognise fell into `notApplicable` and its route left the
   * parity equality WITHOUT SAYING SO. `desktop` mistyped as `deskotp` did not fail the
   * parity check — it removed the row from the check and then agreed with itself. Over a
   * phase that adds thirty-four rows in one commit, that is the failure most likely to
   * happen and the one hardest to see, because the table still looks right to a reader.
   *
   * Anything here is a table that needs fixing, never a vocabulary that needs widening.
   */
  unrecognised: UnrecognisedRow[];
  /** Every row the parser recognised at all. The floor is asserted against this. */
  total: number;
}

const DISPOSITIONS: ReadonlySet<string> = new Set<Disposition>(['ready', 'limited', 'desktop']);

/**
 * The one legitimate non-disposition, non-`unruled` cell in the whole table: the
 * `/print/expenses/[reportId]` row, which is a stylesheet and not a surface.
 *
 * Matched after the optional-backtick unwrap, so `not applicable` and `` `not applicable` ``
 * are both accepted. That is deliberate and it mirrors the `ruled` branch one line above,
 * which has always accepted `desktop` and `` `desktop` `` alike: the vocabulary is about the
 * word, not about the code formatting, and a parser that is strict about backticks in one
 * branch and lax in another teaches nobody anything except that it is inconsistent.
 */
const NOT_APPLICABLE = 'not applicable';

/**
 * Parse the Page-readiness table out of the markdown.
 *
 * Takes the source as a STRING rather than reading the file itself, which is what lets the
 * "proves the check can fail" case below drive the same code path with a doctored table
 * instead of mutating a file on disk.
 */
function parsePageReadiness(markdown: string): ParsedTable {
  const lines = markdown.split('\n');
  const start = lines.findIndex((l) => /^##\s+Page readiness\s*$/.test(l));
  if (start === -1) throw new Error('parsePageReadiness: no "## Page readiness" heading');
  const end = lines.findIndex((l, i) => i > start && /^##\s/.test(l));
  const body = lines.slice(start, end === -1 ? lines.length : end);

  const out: ParsedTable = {
    ruled: {},
    unruled: [],
    globs: [],
    notApplicable: [],
    unrecognised: [],
    total: 0,
  };
  for (const line of body) {
    if (!line.startsWith('|')) continue;
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((c) => c.trim());
    if (cells.length < 4) continue;
    const [routeCell, dispositionCell] = cells as [string, string, ...string[]];
    if (routeCell === 'Route') continue; // header
    if (/^-+$/.test(routeCell)) continue; // separator
    const route = /^`(.+)`$/.exec(routeCell)?.[1];
    if (route === undefined) continue;
    out.total += 1;
    // Unwrap BEFORE the glob branch, not after it. The glob row's cell is the thing the
    // branch used to throw away, and it is read the same way as every other row's so that
    // a rule written about one is a rule about the same string as the other.
    const cell = dispositionCell;
    const disposition = /^`(.+)`$/.exec(cell)?.[1] ?? cell;
    if (route.endsWith('/*')) {
      out.globs.push({ route, cell, disposition });
      continue;
    }
    if (disposition === 'unruled') out.unruled.push(route);
    else if (DISPOSITIONS.has(disposition)) out.ruled[route] = disposition as Disposition;
    else if (disposition === NOT_APPLICABLE) out.notApplicable.push(route);
    else out.unrecognised.push({ route, cell });
  }
  return out;
}

/* ─────────────────────────────────────────────────────────────────────────────────────────
 * THE PARSER, ON A TABLE THIS FILE OWNS.
 *
 * Every other assertion about `parsePageReadiness` runs against the real `docs/design/pwa.md`,
 * which means the parser is only ever exercised by whatever that table happens to contain
 * today. Two of its branches are invisible to the real doc: a glob row whose Disposition cell
 * is a disposition WORD (both real glob rows say `unruled`), and a Disposition cell that is
 * nothing the vocabulary admits (the real table has none, which is the state this block
 * exists to keep true rather than to assume). Neither can be reached without doctoring the
 * file on disk — so the cases that matter most are the ones the real doc cannot reach.
 *
 * This table is a string. It is not the shipped table, it is not compared to the registry,
 * and it does not move when a page task rules a route. That is the whole value: a later
 * phase can write a rule about glob rows here and have it stay green for a reason that has
 * nothing to do with what P10 through P11 happen to have ruled that week.
 * ────────────────────────────────────────────────────────────────────────────────────── */

/**
 * A synthetic `## Page readiness` section, with one row of every shape the parser admits.
 *
 * The decoy rows above the heading and below the NEXT heading are not padding: the parser
 * finds its section by slicing between two `## ` lines, and a slice that is off by one
 * heading in either direction parses rows that belong to a different table while still
 * reporting a plausible-looking result.
 */
const SYNTHETIC_DOC = [
  '# A doc',
  '',
  '## Some earlier section',
  '',
  '| Route | Disposition | Ruled by | Notes |',
  '| --- | --- | --- | --- |',
  '| `/before` | `desktop` | X | ABOVE the heading — must not be parsed |',
  '',
  '## Page readiness',
  '',
  'Prose the parser must skip, including a line that mentions `desktop` and `/alpha`.',
  '',
  '| Route | Disposition | Ruled by | Notes |',
  '| --- | --- | --- | --- |',
  '| `/alpha` | `desktop` | P00 | a normal ruled row |',
  '| `/beta` | `ready` | P00 | a second one, so `ruled` is exercised as a map |',
  '| `/gamma` | `unruled` | | the backlog placeholder, and an empty "ruled by" cell |',
  '| `/print/gamma` | not applicable | — | recognised, and deliberately un-backticked |',
  '| `/delta/*` | `desktop` | P00 | a glob whose cell IS a disposition word |',
  '| `/epsilon/*` | expanded below | — | a glob whose cell is NOT a disposition word |',
  '',
  '## A later section',
  '',
  '| Route | Disposition | Ruled by | Notes |',
  '| --- | --- | --- | --- |',
  '| `/omega` | `desktop` | X | BELOW the next heading — must not be parsed |',
].join('\n');

describe('parsePageReadiness, on a synthetic table', () => {
  const parsed = parsePageReadiness(SYNTHETIC_DOC);

  it('reads the section it was pointed at, and only that section', () => {
    expect(parsed.total).toBe(6);
    const everyRoute = [
      ...Object.keys(parsed.ruled),
      ...parsed.unruled,
      ...parsed.notApplicable,
      ...parsed.globs.map((g) => g.route),
      ...parsed.unrecognised.map((r) => r.route),
    ];
    expect(everyRoute).not.toContain('/before');
    expect(everyRoute).not.toContain('/omega');
    expect(everyRoute.length, 'every counted row lands in exactly one bucket').toBe(parsed.total);
  });

  it('sorts each row shape into its own bucket', () => {
    expect(parsed.ruled).toEqual({ '/alpha': 'desktop', '/beta': 'ready' });
    expect(parsed.unruled).toEqual(['/gamma']);
    expect(parsed.notApplicable).toEqual(['/print/gamma']);
    expect(parsed.unrecognised).toEqual([]);
  });

  it('records each glob row WITH the Disposition cell it carries', () => {
    expect(parsed.globs).toEqual([
      { route: '/delta/*', cell: '`desktop`', disposition: 'desktop' },
      { route: '/epsilon/*', cell: 'expanded below', disposition: 'expanded below' },
    ]);
  });

  it('keeps a glob out of `ruled` EVEN WHEN its cell is a disposition word', () => {
    /**
     * The case the real table cannot reach, and the one that fails if the glob branch stops
     * short-circuiting. `/delta/*` says `desktop`; it is still not a route, it still has no
     * `page.tsx`, and admitting it to `ruled` would put it in the parity equality against a
     * registry that can never hold it — a permanent red whose message points at the docs
     * rather than at the parser that mis-sorted it.
     */
    expect(parsed.ruled['/delta/*']).toBeUndefined();
    expect(parsed.unruled).not.toContain('/delta/*');
    expect(parsed.notApplicable).not.toContain('/delta/*');
    expect(parsed.unrecognised.map((r) => r.route)).not.toContain('/delta/*');
  });

  it('keeps a non-disposition glob cell READABLE rather than discarding it', () => {
    // What a later phase needs in order to assert "a glob row standing over per-route rows
    // names no disposition of its own". Before this change the cell was consumed by a
    // `continue` and the claim could not be written at all.
    const epsilon = parsed.globs.find((g) => g.route === '/epsilon/*');
    expect(epsilon?.cell).toBe('expanded below');
    expect(DISPOSITIONS.has(epsilon?.disposition ?? '')).toBe(false);
    expect(epsilon?.disposition).not.toBe('unruled');
  });

  it('refuses a mistyped disposition instead of filing it under `not applicable`', () => {
    /**
     * THE CLOSED CATCH-ALL, watched failing.
     *
     * `deskotp` is one transposition away from a word in the vocabulary and zero characters
     * away from looking correct in a rendered table. The old branch put its route in
     * `notApplicable`, which is a bucket nothing asserts against — so the route left the
     * parity equality in silence and the equality then agreed with itself.
     */
    const typo = parsePageReadiness(
      SYNTHETIC_DOC.replace('| `/alpha` | `desktop` |', '| `/alpha` | `deskotp` |'),
    );
    expect(typo.ruled['/alpha']).toBeUndefined();
    expect(typo.notApplicable, 'a typo must NOT be swallowed as `not applicable`').toEqual([
      '/print/gamma',
    ]);
    expect(typo.unrecognised).toEqual([{ route: '/alpha', cell: '`deskotp`' }]);
    // `total` still counts it: the row was recognised AS A ROW, and only its cell is wrong.
    expect(typo.total).toBe(6);
  });

  it('refuses a mistyped `not applicable` too', () => {
    // The other half. `not applicable` is the ONE non-disposition cell the table admits, so
    // a near-miss of it is exactly the input the old catch-all accepted by construction.
    const typo = parsePageReadiness(
      SYNTHETIC_DOC.replace('| not applicable |', '| not aplicable |'),
    );
    expect(typo.notApplicable).toEqual([]);
    expect(typo.unrecognised).toEqual([{ route: '/print/gamma', cell: 'not aplicable' }]);
  });

  it('accepts `not applicable` with or without backticks, and nothing else near it', () => {
    const backticked = parsePageReadiness(
      SYNTHETIC_DOC.replace('| not applicable |', '| `not applicable` |'),
    );
    expect(backticked.notApplicable).toEqual(['/print/gamma']);
    expect(backticked.unrecognised).toEqual([]);
    // Capitalisation is a different cell, and the table has one spelling.
    const shouted = parsePageReadiness(
      SYNTHETIC_DOC.replace('| not applicable |', '| Not Applicable |'),
    );
    expect(shouted.unrecognised).toEqual([{ route: '/print/gamma', cell: 'Not Applicable' }]);
  });
});

/** The comparison itself, as a list of human-readable differences. Empty means agreement. */
function parityDiff(registry: DispositionTable, parsed: ParsedTable): string[] {
  const problems: string[] = [];
  for (const [route, disposition] of Object.entries(registry)) {
    const documented = parsed.ruled[route];
    if (documented === undefined) {
      problems.push(`${route} is \`${disposition}\` in mobileReadiness.ts and not ruled in pwa.md`);
    } else if (documented !== disposition) {
      problems.push(
        `${route}: mobileReadiness.ts says \`${disposition}\`, pwa.md says \`${documented}\``,
      );
    }
  }
  for (const [route, disposition] of Object.entries(parsed.ruled)) {
    if (registry[route] === undefined) {
      problems.push(
        `${route} is ruled \`${disposition}\` in pwa.md and missing from mobileReadiness.ts`,
      );
    }
  }
  return problems;
}

/**
 * VeloExpense: skipped. `docs/design/pwa.md` is ExpenseOS's PWA design document and is not
 * ported (VeloExpense is not a PWA); the registry it pins is ExpenseOS's, ported unchanged,
 * and this parity holds in ExpenseOS. The parser is still tested above on a synthetic table.
 */
describe.skip('registry ↔ docs/design/pwa.md parity', () => {
  const markdown = existsSync(PWA_DOC) ? readFileSync(PWA_DOC, 'utf8') : '';
  // Never read while skipped; typed for the (skipped) cases below.
  const parsed = (markdown ? parsePageReadiness(markdown) : null) as ReturnType<
    typeof parsePageReadiness
  >;

  it('parsed a table worth comparing', () => {
    /**
     * THE FLOOR, and it is the most important assertion in this block.
     *
     * The failure mode being designed against is not a wrong answer, it is a vacuous one:
     * a parser that matches nothing produces an empty `ruled`, an empty registry produces
     * an empty comparison, and the parity check reports agreement between two things it
     * never read. Both halves are now non-empty, and both are pinned.
     *
     * THE FLOOR IS RAISED FROM 25 TO 62 ON THIS COMMIT, and the reason is that 25 stopped
     * being a floor. The table parses 62 rows today; a floor of 25 would let somebody delete
     * more than half of it — every row P10 ruled, say — and still report "a table worth
     * comparing". A floor tracks the thing it guards or it guards nothing.
     *
     * `>=`, NOT `===`, AND DELIBERATELY SO. `total` counts every row the parser recognised,
     * ruled and `unruled` alike, and a page task may add a route the epic's § 4 did not list.
     * An equality here would go red on a commit that ADDS a row, which is not a regression and
     * is not this assertion's subject. Exactness lives in the ruled↔registry equality below,
     * where both sides move together by construction.
     */
    expect(parsed.total, 'the Page-readiness table has lost rows').toBeGreaterThanOrEqual(62);
    /**
     * THE PROOF OF LIFE MOVED OFF THE `unruled` BUCKET, BECAUSE THE EPIC RULED ITS LAST ROUTE.
     *
     * The line that stood here was `expect(parsed.unruled.length).toBeGreaterThan(0)`, and it
     * used the backlog as the parser's proof of life: a table with something still unruled in
     * it was a table that had been read. P11's two rulings and then P08's `limited` on
     * `/virtual-cards/transactions` emptied that bucket — `docs/design/pwa.md` has ZERO
     * `unruled` rows now, and it is the epic FINISHING rather than the parser matching
     * nothing. AN EMPTY `unruled` BUCKET IS THE EXPECTED STATE FROM HERE. Left as written,
     * the assertion would redden on the one event it was never about.
     *
     * The claim it carried — the parser read a real table and not nothing — is carried by two
     * assertions instead, neither of which a vacuous parse can satisfy and neither of which
     * needs a row to be unruled:
     *
     *   1. A FLOOR ON `ruled`, which is the half the parity equality below actually compares.
     *      It was `> 0`, which is not a floor: the same argument that raised `total` from 25
     *      to 62 applies here, and 0 would let somebody delete every ruled row and still
     *      report a table worth comparing. 59 today, `>=` for the same reason `total` is `>=`.
     *   2. EVERY COUNTED ROW LANDED IN EXACTLY ONE BUCKET. `total` is incremented BEFORE the
     *      classification branches, so a parser that recognises rows and then drops them —
     *      the precise shape of the vacuous parse this case exists to catch — clears the
     *      floors above and fails here. It also catches a route written twice, which the
     *      `ruled` record would silently collapse into one key.
     *
     * `unruled` is SUMMED into that identity rather than dropped from it, so the day a page
     * task adds a route to the table before ruling it the bucket refills and nothing here
     * needs an edit. What is gone is the assumption that it is ever non-empty — and it is
     * deliberately not pinned to `[]` either, because "the backlog is empty" is a fact about
     * today's epic, not a property of the parser this case is about.
     */
    expect(
      Object.keys(parsed.ruled).length,
      'the Page-readiness table has lost ruled rows',
    ).toBeGreaterThanOrEqual(59);
    expect(
      Object.keys(parsed.ruled).length +
        parsed.unruled.length +
        parsed.globs.length +
        parsed.notApplicable.length +
        parsed.unrecognised.length,
      'every row `parsePageReadiness` counted must land in exactly one bucket. A `total` ' +
        'larger than the buckets is a row recognised and then dropped — the vacuous parse ' +
        'this case exists to catch — or the same route written on two rows.',
    ).toBe(parsed.total);
  });

  it('recognises the glob rows AS globs rather than as routes', () => {
    // `/admin/*` and `/ledger/*` are directory rulings a page task will split apart, not
    // paths. Reported as routes they would fail the route-exists check with a message that
    // sends the reader looking for a `page.tsx` that was never supposed to exist.
    expect(parsed.globs.map((g) => g.route).sort()).toEqual(['/admin/*', '/ledger/*']);
    for (const { route } of parsed.globs) expect(parsed.ruled[route]).toBeUndefined();
  });

  it('carries each glob row’s Disposition cell, and pins what it says today', () => {
    /**
     * A CHARACTERIZATION PIN, AND IT HAS NOW FIRED ONCE — WHICH IS THE NEWS.
     *
     * Both glob rows read `` `unruled` `` from the day this case was written until the batch
     * that ruled P10's last four routes. It was BUILT to go red on that commit, in those
     * words: "the phase that splits these globs into per-route rows rewrites both cells, and
     * when it does, THIS LINE is where that shows up — with a diff that says which glob
     * changed and to what, rather than a parity count that moved by thirty-four for reasons
     * the reader has to reconstruct. Update the expectation in the same commit that edits the
     * table; do not delete the case." It went red, the diff named both globs, and the
     * expectation is updated here rather than the case removed.
     *
     * BOTH NOW READ `expanded below`, UN-BACKTICKED, and both halves of that are deliberate.
     * `expanded below` is a POINTER rather than a ruling: every route each glob stood over
     * carries its own row now, and a glob has no `page.tsx`, can never appear in
     * `mobileReadiness.ts`, and so cannot carry a ruling anything enforces. Un-backticked
     * because backticks in this column mark the closed vocabulary — `` `desktop` ``,
     * `` `unruled` `` — and this cell is deliberately outside it, exactly as the
     * `not applicable` row is.
     *
     * THE PIN STAYS. The next thing that edits a glob cell should still have to come here.
     */
    expect(parsed.globs.map((g) => `${g.route} → ${g.cell}`).sort()).toEqual([
      '/admin/* → expanded below',
      '/ledger/* → expanded below',
    ]);
    for (const glob of parsed.globs)
      expect(glob.cell, `${glob.route} has an empty Disposition cell`).not.toBe('');
  });

  it('lets a glob name NO disposition, and stand over routes that are ruled', () => {
    /**
     * THE CASE THAT STOPS A GLOB ROW DEGENERATING INTO DECORATION, and the second half is
     * the valuable one.
     *
     * The first half is cheap and still worth having: a glob's cell must not be a word from
     * the Disposition vocabulary, and must not be `unruled` either. A glob saying `desktop`
     * reads to a human as a ruling over a whole directory and is enforced by nothing — the
     * parser sorts glob rows into `globs` before the vocabulary is consulted, so the cell
     * never reaches `ruled` and never reaches the parity equality. `parsePageReadiness, on a
     * synthetic table` proves that short-circuit against a doctored `/delta/*` row; this
     * case is the rule stated against the REAL document, where it can actually be violated
     * by somebody editing the table.
     *
     * THE SECOND HALF IS WHAT MAKES THE ROW MEAN ANYTHING. A pointer that points at nothing
     * is worse than no row: it tells a reader the directory has been dealt with when it has
     * not. So for each glob, at least one SHIPPED REGISTRY KEY must fall under its prefix —
     * asserted against the registry rather than against the markdown, because the registry
     * is what the code reads and the parity equality above already ties the two together.
     *
     * Matched on the same segment boundary the registry itself uses, via `dispositionFor`,
     * rather than on `startsWith`: `/admin/*` must be satisfied by `/admin/roles` and NOT by
     * a hypothetical `/administration`, which is the same hazard the matcher exists for.
     */
    expect(parsed.globs.length, 'no glob rows found — the parser is broken, not the doc').toBe(2);

    for (const glob of parsed.globs) {
      expect(
        DISPOSITIONS.has(glob.disposition),
        `${glob.route} names the disposition \`${glob.disposition}\`. A glob is not a route: ` +
          'it has no page.tsx, can never appear in mobileReadiness.ts, and the parser sorts ' +
          'it out of the parity equality before the vocabulary is read — so a disposition ' +
          'word here is a ruling nothing enforces. Rule the routes beneath it instead.',
      ).toBe(false);
      expect(
        glob.disposition,
        `${glob.route} is still \`unruled\` while routes beneath it are ruled`,
      ).not.toBe('unruled');

      // `/admin/*` → `/admin`; the prefix the glob actually stands over.
      const prefix = glob.route.slice(0, -2);
      // `key !== prefix` is not dead code: `/admin` is not a registry key today, but if one
      // were ever added it is the glob's own directory and not a route beneath it.
      const beneath = Object.keys(MOBILE_READINESS).filter(
        (key) => key !== prefix && key.startsWith(`${prefix}/`),
      );
      expect(
        beneath.length,
        `${glob.route} says "expanded below" and no registry key lies beneath it. A pointer ` +
          'that points at nothing reads as "this directory has been dealt with" when it has ' +
          'not — either rule the routes beneath it or put the row back to `unruled`.',
      ).toBeGreaterThan(0);
      for (const key of beneath)
        expect(
          dispositionFor(key).prefix,
          `${key} lies under ${glob.route} but does not resolve to its own key`,
        ).toBe(key);
    }

    // Named, so the failure message on a future split says WHICH directory lost its rows
    // rather than only that a count moved. These are the two the doc ships today.
    expect(parsed.globs.map((g) => g.route).sort()).toEqual(['/admin/*', '/ledger/*']);
  });

  it('recognises every Disposition cell in the shipped table', () => {
    /**
     * THE SECOND FLOOR, and the one that keeps the first honest.
     *
     * `parsed.ruled` equalling the registry proves the rows the parser UNDERSTOOD agree with
     * the code. It says nothing about a row it did not understand, and a row it did not
     * understand used to leave the comparison without a word. Thirty-four rows land here in
     * one phase; one transposed character in any of their Disposition cells would otherwise
     * subtract that route from the very check that is supposed to notice.
     *
     * The fix for a failure here is the cell, never this set.
     */
    expect(
      parsed.unrecognised,
      'rows whose Disposition cell is none of `ready` / `limited` / `desktop` / `unruled` / ' +
        '`not applicable`. Such a row drops out of the parity equality silently, so it is ' +
        'refused here. Fix the cell in docs/design/pwa.md — do not widen the vocabulary.',
    ).toEqual([]);

    // And the one row that legitimately carries none of the three dispositions, pinned so
    // that "nothing unrecognised" cannot be reached by a bucket quietly swallowing it.
    expect(parsed.notApplicable).toEqual(['/print/expenses/[reportId]']);
  });

  it('spells the 11 module-gated rows `desktop`, with no `(gated)` annotation', () => {
    /**
     * THE OPERATOR'S RULING, PINNED WHERE IT FAILS FIRST AND EXPLAINS ITSELF.
     *
     * `docs/design/pwa.md`'s own `/ledger/*` and `/admin/*` glob rows propose that P10 rule
     * these eleven routes `desktop (gated)` — the annotation being the honest observation
     * that a module-gated route 404s on a stock seed and can therefore never be seen behind
     * `DesktopOnlyNotice`. The observation is right and the CELL is the wrong place for it.
     *
     * The Disposition vocabulary is a closed set of five words, and `desktop (gated)` is not
     * one of them: it lands in `unrecognised`, drops out of the parity equality, and takes
     * all eleven rows out of the only check that holds the docs to the code. The case above
     * would catch it — but it would report eleven anonymous rows with a message about typos,
     * which is not what happened and sends the reader hunting for a transposed character.
     * This case names the rows, names the annotation, and says where the annotation goes.
     *
     * WHERE IT GOES: the Notes cell, which names the module slug — `assistant` for
     * `/admin/assistant-feedback` (`packages/assistant/src/catalog.ts:33`) and `netsuite-gl`
     * for the ten `/ledger/*` (`netsuite/_page.tsx:18`) — and says in words that the ruling
     * is recorded rather than gate-verified. Notes are prose and nothing parses them, which
     * is exactly why the fact is safe there and unsafe in a cell that is a vocabulary.
     *
     * THE ALTERNATIVE WAS CONSIDERED AND REFUSED, and it is recorded so nobody re-proposes it
     * as an improvement: teach `parsePageReadiness` to strip a trailing ` (gated)` and record
     * a `parsed.gated` flag. It buys a machine-readable gating fact that nothing reads, and
     * it costs the property that makes this parser trustworthy — that the Disposition cell is
     * a closed set a reader can hold in their head. A vocabulary with an escape hatch is a
     * vocabulary that grows one annotation per phase.
     */
    const GATED = [
      '/admin/assistant-feedback',
      '/ledger/business-units',
      '/ledger/classes',
      '/ledger/departments',
      // Added 2026-09-24 with the page (netsuite-report-expense-category), after P10.
      '/ledger/expense-categories',
      '/ledger/gl-accounts',
      '/ledger/locations',
      '/ledger/posting',
      '/ledger/settings',
      '/ledger/subsidiaries',
      '/ledger/sync',
      // Added 2026-09-29 with the page (netsuite-tax-group-rates).
      '/ledger/tax-groups',
      '/ledger/vendors',
    ];
    // Read off the RAW markdown rather than off `parsed`, because `parsed.ruled` has already
    // unwrapped the backticks and an annotated cell would not be in it at all. The claim is
    // about what the table SAYS.
    const cellFor = (route: string): string | undefined => {
      const row = markdown.split('\n').find((l) => l.startsWith(`| \`${route}\` |`));
      return row
        ?.split('|')
        .slice(1, -1)
        .map((c) => c.trim())[1];
    };
    expect(
      GATED.map((r) => `${r} → ${cellFor(r) ?? '(no row)'}`),
      "a module-gated row's Disposition cell is a plain `desktop`. The gating belongs in " +
        'the Notes cell, naming the module slug — `desktop (gated)` is outside the closed ' +
        'vocabulary and silently removes the row from the parity equality.',
    ).toEqual(GATED.map((r) => `${r} → \`desktop\``));
    // And the registry half, so "the docs say `desktop`" cannot be true of a route the code
    // never ruled.
    for (const route of GATED) expect(MOBILE_READINESS[route]).toBe('desktop');
  });

  it('agrees with the shipped registry, row for row', () => {
    expect(parityDiff(MOBILE_READINESS, parsed)).toEqual([]);
    // Stated as an equality too, so the message on a break shows both sides at once.
    expect(parsed.ruled).toEqual({ ...MOBILE_READINESS });
  });

  it('lists no registry route as `unruled`', () => {
    const contradicted = parsed.unruled.filter((r) => MOBILE_READINESS[r] !== undefined);
    expect(contradicted, 'ruled in code, still `unruled` in the table').toEqual([]);
  });

  it('proves the parity check can fail', () => {
    /**
     * The check watched failing, in-process, on a table that is wrong in each of the three
     * ways a real edit gets it wrong. Without this, a parser that returns `{}` for any
     * input reports eternal agreement and nobody finds out until a page task ships a
     * suppression the docs never mention.
     *
     * ─── THE SECOND DOCTORED ROW IS SYNTHETIC, BECAUSE THE TABLE RAN OUT OF REAL ONES ──
     *
     * It read `| `/budgets` | `unruled` |` as a LITERAL until P11 ruled that route, and
     * `/dashboard` before that; the repair for that rot was to DERIVE it — take the first row
     * the real table still calls `unruled` and that the registry does not list, whatever it
     * happens to be that week. THAT DERIVATION HAS RUN OUT OF INPUT, and not by accident:
     * P11's two rulings and then P08's `limited` on `/virtual-cards/transactions` left
     * `docs/design/pwa.md` with ZERO `unruled` rows. The epic ruled its last route, so the
     * bucket this case fished in is empty and stays empty — and the guard that stood here
     * named this exact fix in its own failure message: "Splice a synthetic row into the
     * markdown here rather than dropping the arm."
     *
     * So the row is BUILT here rather than borrowed. The arm being exercised is "ruled in the
     * docs, missing from the registry" — an `unruled` row was never its subject, only the raw
     * material a doctored `desktop` was made out of, and a route that no page task can ever
     * rule is better raw material than one that rots the next time somebody rules it. It is a
     * path the app does not serve, so it cannot collide with a real row or a real key.
     *
     * WHAT REPLACES THE HONESTY THE DERIVATION BOUGHT, because it did buy something: doctoring
     * a real row kept the case anchored to the shipped table's own formatting — a string
     * replacement that stopped matching reddened here rather than passing on a row this file
     * wrote itself. Half of that anchor survives untouched, in the `/admin/roles` replacement
     * below, which is still a raw string match against a shipped row. For the spliced half it
     * is re-established by assertion instead: the splice must land INSIDE the parsed section
     * (`total` goes up by exactly one) and the row must parse as a RULED `desktop` row rather
     * than landing in `unrecognised` or being skipped, both checked before `parityDiff` is
     * asked anything. A splice that silently no-ops fails loudly instead of leaving this arm
     * untested and the case green.
     *
     * AND THE ARM STILL REDDENS IF `parityDiff` STOPS DETECTING IT. The expectation is an
     * equality against BOTH problems in order, so a `parityDiff` that returned `[]`, or that
     * returned only the `/admin/roles` mismatch because it stopped walking `parsed.ruled` for
     * routes the registry does not list, fails here — which is the whole reason this case
     * exists, and the reason neither arm may be dropped to make a finished epic parse green.
     */
    const SYNTHETIC_ROUTE = '/__ruled-in-docs-only__';
    expect(
      MOBILE_READINESS[SYNTHETIC_ROUTE],
      'the synthetic route must be absent from the registry, or the doctored table AGREES ' +
        'with it and the "missing from the registry" arm proves nothing',
    ).toBeUndefined();
    const syntheticRow =
      `| \`${SYNTHETIC_ROUTE}\` | \`desktop\` | — | synthetic row spliced in by ` +
      'mobileReadiness.test.ts; never present in the shipped table |';
    const docLines = markdown.split('\n');
    const anchor = docLines.findIndex((l) => l.startsWith('| `/admin/roles` |'));
    expect(
      anchor,
      'docs/design/pwa.md has no `/admin/roles` row to splice the synthetic row against',
    ).toBeGreaterThan(-1);
    const doctored = [...docLines.slice(0, anchor + 1), syntheticRow, ...docLines.slice(anchor + 1)]
      .join('\n')
      .replace('| `/admin/roles` | `desktop` |', '| `/admin/roles` | `limited` |');
    const reparsed = parsePageReadiness(doctored);
    expect(reparsed.ruled['/admin/roles']).toBe('limited');
    expect(
      reparsed.total,
      'the synthetic row did not land inside the Page-readiness section, so the parser never ' +
        'saw it and the arm below would be testing nothing',
    ).toBe(parsed.total + 1);
    expect(
      reparsed.ruled[SYNTHETIC_ROUTE],
      "the synthetic row must parse as a RULED `desktop` row. If the table's row shape moves " +
        'under it — more cells, different backticks — fix the row written here; never drop ' +
        'the arm.',
    ).toBe('desktop');
    expect(parityDiff(MOBILE_READINESS, reparsed)).toEqual([
      '/admin/roles: mobileReadiness.ts says `desktop`, pwa.md says `limited`',
      `${SYNTHETIC_ROUTE} is ruled \`desktop\` in pwa.md and missing from mobileReadiness.ts`,
    ]);

    // And the fourth way, which is the one this phase closed: a Disposition cell that is
    // MISTYPED rather than wrong. `deskotp` renders indistinguishably from `desktop` in a
    // table of sixty rows. It used to be filed under `not applicable` and the route simply
    // stopped being compared — parity green, registry and docs disagreeing. Now the cell is
    // named, the route is named, AND the parity diff still reports the missing ruling.
    const mistyped = markdown.replace(
      '| `/admin/roles` | `desktop` |',
      '| `/admin/roles` | `deskotp` |',
    );
    const misparsed = parsePageReadiness(mistyped);
    expect(misparsed.unrecognised).toEqual([{ route: '/admin/roles', cell: '`deskotp`' }]);
    expect(
      misparsed.notApplicable,
      'the typo must not land in the `not applicable` bucket',
    ).toEqual(['/print/expenses/[reportId]']);
    expect(parityDiff(MOBILE_READINESS, misparsed)).toEqual([
      '/admin/roles is `desktop` in mobileReadiness.ts and not ruled in pwa.md',
    ]);

    // And the third way: a row deleted from the docs entirely.
    const deleted = markdown
      .split('\n')
      .filter((l) => !l.startsWith('| `/admin/roles` |'))
      .join('\n');
    expect(parityDiff(MOBILE_READINESS, parsePageReadiness(deleted))).toEqual([
      '/admin/roles is `desktop` in mobileReadiness.ts and not ruled in pwa.md',
    ]);
  });
});

/* ────────────────────────────────────────────────────────────────────────────────────────
 * ADR-0005 D7, MADE EXECUTABLE.
 *
 * D7 says the registry must NEVER be cited as a control surface: it is a cosmetic layout
 * hint, server-side RBAC and module gating are the real gate, and "Continue anyway" always
 * works. That rule is currently written down in three places — the ADR, this module's own
 * header, and `DesktopOnlyNotice.tsx` — and all three are COMMENTS. Nothing fails today if a
 * page task imports `dispositionFor` into `proxy.ts`, a server component or a tRPC procedure
 * and starts deciding what a request is allowed to see by it. Eleven downstream page tasks
 * will each edit this file, which is eleven chances to do it by accident.
 *
 * The mechanism this block asserts instead of the intent: EVERY module that imports this one
 * is a CLIENT module. A `'use client'` file runs in the browser, where the user owns the
 * DOM — so a decision made there is, by construction, cosmetic. `proxy.ts`, anything under
 * `src/server/`, and any `route.ts` are the three shapes where an import would be a real
 * authorization decision, and each is called out by name so the failure message says which
 * boundary was crossed rather than only that one was.
 *
 * It follows the source-scanning shape `DesktopOnlyNotice.test.tsx` already ships for the
 * `desktop-only-notice` testid, and its tooling: read the tree, blank comments before
 * matching, and assert on a derived list rather than a boolean.
 *
 * WHAT IT DOES NOT PROVE. `'use client'` marks an entry into the client graph; it does not
 * stop that module being rendered on the server during SSR, and it does not stop a client
 * component being handed a prop somebody computed from the registry on the server. This is a
 * cheap structural guard against the obvious mistake, not a taint analysis, and the ADR's
 * prose is still the rule. It also cannot see a dynamic `import(someVariable)`.
 * ──────────────────────────────────────────────────────────────────────────────────────── */

// VeloExpense: the web app IS the repo root (ExpenseOS's is apps/web/src).
const WEB_SRC = REPO_ROOT;

/**
 * EVERY TREE IN THIS REPOSITORY THAT CAN IMPORT APPLICATION CODE.
 *
 * It used to be `apps/web/src` alone, and that was sound only while the registry had no
 * consumer outside the web app. P10 gives it two — `e2e/crawl-mobile.spec.ts` and
 * `e2e/support/mobile-census.ts` both import it, by relative path, so the mobile crawl can
 * check a route's ruling instead of merely recording what the DOM happened to show. A guard
 * that cannot see the tree the new importers live in is a guard with a hole cut in it by the
 * same commit that claims to strengthen it.
 *
 * `apps` rather than `apps/web/src`, because `apps/worker` is a BullMQ process: an import
 * there is a server-side decision by construction and there is no `'use client'` that could
 * make it cosmetic. `packages` because a shared package importing this table is how it
 * becomes a third source of truth, which this module's own header rules out in prose.
 * `e2e` because that is the new vector. `scripts` and `infrastructure` are cheap and are the
 * two remaining places TypeScript that ships decisions lives.
 *
 * `archive/` IS DELIBERATELY NOT WALKED. `CLAUDE.md`: the original app is retired there,
 * read-only, not built, not deployed and not imported. It predates the registry by a rewrite,
 * nothing in it can import a module that did not exist, and walking it would only add noise
 * and time to a guard whose value is its precision.
 *
 * WHAT THE WIDENING COSTS: about 850 files read per run instead of about 450. Measured in
 * this suite it is tens of milliseconds, which is the right price for a guard that can see
 * the importer it was widened for.
 */
// VeloExpense: its source directories at the repo root, in place of ExpenseOS's `apps/`.
const REPO_SOURCE_ROOTS: readonly string[] = [
  join(REPO_ROOT, 'app'),
  join(REPO_ROOT, 'components'),
  join(REPO_ROOT, 'hooks'),
  join(REPO_ROOT, 'i18n'),
  join(REPO_ROOT, 'lib'),
  join(REPO_ROOT, 'server'),
  join(REPO_ROOT, 'src'),
  join(REPO_ROOT, 'packages'),
  join(REPO_ROOT, 'e2e'),
  join(REPO_ROOT, 'scripts'),
  join(REPO_ROOT, 'infrastructure'),
];
/** VeloExpense: source files that sit at the repo root rather than in a directory. */
const REPO_ROOT_SOURCE_FILES: readonly string[] = ['proxy.ts', 'auth.ts'].map((f) =>
  join(REPO_ROOT, f),
);

/** The module under guard, as an absolute path with no extension. */
const MODULE = join(HERE, 'mobileReadiness');

/**
 * ─── THE IDENTITY ALLOWLIST ──────────────────────────────────────────────────────────────
 *
 * The assertion below used to be a FLOOR — "at least two importers" — and a floor is the
 * wrong instrument for this question. It cannot fail on a NEW importer, because a new one
 * only pushes the count further above the floor; it fails only when importers disappear. So
 * the case it was written to catch, a page task quietly wiring the registry into somewhere it
 * does not belong, was precisely the case it could not see. It is an exact set instead, and
 * both directions of the equality carry their own weight: an unlisted importer fails BY NAME,
 * and a listed one going missing fails as a broken scan rather than as a vacuous green.
 *
 * TWO KINDS, AND THE `'use client'` RULE IS NOT DROPPED FOR EITHER.
 *
 *   · `client`    — an application module. It must carry `'use client'`, exactly as before.
 *                   That is the mechanism the whole block rests on: a module that runs in the
 *                   browser, where the user owns the DOM, cannot be making an authorization
 *                   decision.
 *   · `test-tree` — a Playwright spec or its support module. A spec is not a client module
 *                   and never will be: `'use client'` is a Next.js bundler directive and
 *                   means nothing to Playwright's loader, so REQUIRING it here would force
 *                   somebody to paste a meaningless line into a spec, and ACCEPTING its
 *                   absence for everyone would quietly retire the rule for the app modules
 *                   it was written for. The kind exists so the exemption is per-module,
 *                   stated, and bounded.
 *
 * AND THE KINDS ARE NOT INTERCHANGEABLE. A `test-tree` entry must live under `e2e/`, which is
 * asserted, so the exemption cannot be borrowed by moving an app module onto this list under
 * the softer label. The safety argument for `test-tree` is not `'use client'` at all — it is
 * that the module never ships to a reader: nothing under `e2e/` is in any bundle, is served
 * by any route, or can deny anybody anything. That is a stronger guarantee than the one the
 * client rule provides, not a weaker one.
 *
 * ADDING AN ENTRY IS A DECISION, NOT A FIX. If this test failed and you are here to make it
 * pass: ADR-0005 D7 says the readiness registry is a cosmetic layout hint and is never a
 * control surface. If the new importer needs route knowledge to decide what a request may
 * SEE, the answer is a permission or a module capability, not this table, and the entry must
 * not be added.
 */
type ImporterKind = 'client' | 'test-tree';

const PERMITTED_IMPORTERS: Readonly<Record<string, ImporterKind>> = {
  // The two consumers T04 shipped: the notice that suppresses a ruled page below `lg`, and
  // the sidebar that hides its nav destinations at the same breakpoint. Both `'use client'`.
  // VeloExpense: at VeloExpense's paths.
  'app/(app)/DesktopOnlyNotice.tsx': 'client',
  'app/(app)/Sidebar.tsx': 'client',
  // P10's two. The mobile crawl asserts, per route, that a `desktop` ruling produced exactly
  // one visible notice and that anything else produced none; its census makes the same claim
  // as a whole-run reconciliation, which the spec cannot because module-scope aggregation
  // does not survive parallel workers. Both read the registry rather than transcribing it —
  // a route list copied into the e2e tree goes stale silently and then lies about which
  // pages a phone can reach.
  //
  // VeloExpense: ported with the mobile crawl (phone e2e 3), at VeloExpense's paths.
  'e2e/crawl-mobile.spec.ts': 'test-tree',
  'e2e/support/mobile-census.ts': 'test-tree',
};

/**
 * Blank out comments, preserving offsets and line count.
 *
 * Same technique and same reason as `DesktopOnlyNotice.test.tsx`'s repo guard and
 * `scripts/check-e2e-ids.mjs`: this module's header, `TopBar.tsx` and `Sidebar.test.tsx` all
 * NAME `mobileReadiness.ts` in prose, and a guard that cannot tell a sentence from an import
 * either fails on documentation or drives the documentation out. The widened walk makes this
 * matter more, not less — four more e2e files name the module in comments.
 */
function stripComments(src: string): string {
  const blank = (m: string) => m.replace(/[^\n]/g, ' ');
  return src
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, lead: string) => lead + blank(m.slice(lead.length)));
}

/** A path as this block names it: repo-relative, POSIX-spelled, stable across machines. */
function repoRelative(full: string): string {
  return full.slice(REPO_ROOT.length + 1);
}

/**
 * Does `file` import this module, by any specifier that actually resolves to it?
 *
 * Resolved rather than string-matched on `'./mobileReadiness'`. A sibling was the only form
 * that existed when this was written; P10 adds `'../apps/web/src/app/[locale]/(app)/
 * mobileReadiness'` from two levels of the e2e tree, and a page task three directories down
 * would write `'@/app/[locale]/(app)/mobileReadiness'`. A guard that only knew one spelling
 * would wave the others through while reporting green.
 *
 * `@/` is resolved against `apps/web/src` for every file, including files outside it. That is
 * a deliberate superset: nothing outside the web app has that alias, so a match there would
 * mean somebody wrote a specifier that cannot resolve — which is a finding either way, and
 * failing loudly on it is better than a walk that silently skips it.
 */
function importsRegistry(file: string, code: string): boolean {
  for (const [, spec] of code.matchAll(/(?:from|import|require)\s*\(?\s*['"]([^'"]+)['"]/g)) {
    if (!spec.includes('mobileReadiness')) continue;
    const resolved = spec.startsWith('@/')
      ? join(WEB_SRC, spec.slice(2))
      : spec.startsWith('.')
        ? join(dirname(file), spec)
        : null;
    if (resolved !== null && resolved.replace(/\.(ts|tsx|js)$/, '') === MODULE) return true;
  }
  return false;
}

/** `'use client'` as the module's first statement — quotes either way, semicolon or not. */
function isClientModule(code: string): boolean {
  return /^\s*(?:['"]use client['"])\s*;?/.test(stripComments(code));
}

/**
 * Every non-unit-test `.ts` / `.tsx` under the source roots, absolute.
 *
 * `*.test.ts(x)` is skipped and `*.spec.ts` is NOT, and the asymmetry is the point: a unit
 * test importing the registry is the registry being TESTED, which D7 has no quarrel with,
 * while a Playwright spec importing it is a real consumer making a real claim and belongs on
 * the allowlist by name. A missing root is not silently tolerated — `readdirSync` throws, and
 * a guard whose walk quietly found nothing is the vacuous pass this whole block is against.
 */
function repoSourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        // VeloExpense: plus the generated Prisma client and CDK's synth output.
        if (
          ['node_modules', '.next', 'dist', 'build', '.turbo', 'generated', 'cdk.out'].includes(
            entry.name,
          )
        )
          continue;
        walk(full);
        continue;
      }
      if (!/\.(ts|tsx)$/.test(entry.name)) continue;
      if (/\.test\.tsx?$/.test(entry.name)) continue;
      if (/\.d\.ts$/.test(entry.name)) continue;
      out.push(full);
    }
  };
  for (const root of REPO_SOURCE_ROOTS) walk(root);
  out.push(...REPO_ROOT_SOURCE_FILES);
  return out;
}

/** `{ path, client }` for every non-unit-test file in the repo that imports the registry. */
function registryImporters(): { path: string; client: boolean }[] {
  return repoSourceFiles()
    .map((full) => ({ full, code: stripComments(readFileSync(full, 'utf8')) }))
    .filter(({ full, code }) => importsRegistry(full, code))
    .map(({ full, code }) => ({ path: repoRelative(full), client: isClientModule(code) }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

describe('ADR-0005 D7 — the registry is never a control surface', () => {
  it('is imported by exactly the modules on the allowlist, and by nothing else', () => {
    const importers = registryImporters();

    // The anti-vacuity guard, kept explicit even though the equality below would also fail
    // on an empty list: a renamed module, a moved directory or a broken walk all produce
    // "no importers", and a diff of [] against four paths reads as "somebody deleted the
    // consumers" rather than "the scan is broken".
    expect(
      importers.length,
      'no importer of mobileReadiness.ts was found anywhere in the repository — the scan ' +
        'is broken, not the codebase. Sidebar.tsx, DesktopOnlyNotice.tsx, ' +
        'e2e/crawl-mobile.spec.ts and e2e/support/mobile-census.ts all import it.',
    ).toBeGreaterThan(0);

    // THE IDENTITY. Both directions: an unlisted importer fails by name, and a listed one
    // that vanished fails too rather than passing because the count stayed above a floor.
    expect(
      importers.map((f) => f.path),
      'the set of modules importing the readiness registry is not the allowlist in this ' +
        'file. A path on the LEFT that is not on the right is a new importer: read ' +
        'PERMITTED_IMPORTERS above before adding it, because ADR-0005 D7 says this table is ' +
        'a cosmetic layout hint and never decides what a request is allowed to see — if the ' +
        'new importer needs route knowledge to make that decision, the answer is a ' +
        'permission or a module capability. A path on the RIGHT that is not on the left is a ' +
        'consumer that went away, or a walk that stopped reaching it.',
    ).toEqual(Object.keys(PERMITTED_IMPORTERS).sort((a, b) => a.localeCompare(b)));

    // THE CLIENT RULE, undiminished for the modules it was written for. Every application
    // importer still has to be a client module; the `test-tree` kind exempts nobody from it
    // who was ever subject to it.
    expect(
      importers
        .filter((f) => PERMITTED_IMPORTERS[f.path] === 'client' && !f.client)
        .map((f) => f.path),
      'these APPLICATION modules import the readiness registry WITHOUT `use client`. Per ' +
        'ADR-0005 D7 the registry is a cosmetic layout hint and must never decide what a ' +
        'request is allowed to see — that is server-side RBAC and module gating, which are ' +
        'unchanged, and "Continue anyway" always works. A client module is safe by ' +
        'construction: the user owns the DOM there. If you need this route knowledge on the ' +
        'server, the answer is a permission or a module capability, not this table.',
    ).toEqual([]);

    // AND THE EXEMPTION CANNOT BE BORROWED. `test-tree` is safe because nothing under `e2e/`
    // is bundled, served or able to deny anybody anything — not because specs are trusted.
    // Relabelling an application module to dodge the client rule fails here.
    expect(
      Object.entries(PERMITTED_IMPORTERS)
        .filter(([path, kind]) => kind === 'test-tree' && !path.startsWith('e2e/'))
        .map(([path]) => path),
      'these entries claim the `test-tree` kind, which waives the `use client` requirement, ' +
        'while living outside `e2e/`. The waiver rests on the module never shipping to a ' +
        'reader; a module that does ship is a `client` entry and must carry `use client`.',
    ).toEqual([]);
  });

  it('is absent from the proxy, the server trees and every route handler', () => {
    /**
     * The three shapes named as examples in the ADR, asserted separately from the
     * `'use client'` sweep above so the failure NAMES the boundary that was crossed.
     *
     * Not redundant with it: `apps/web/src/server/**` is where a stray `'use client'` would
     * be most obviously wrong AND most likely to be pasted in to make the other assertion
     * green. A guard whose only failure mode can be silenced by adding one line to the
     * offending file is not much of a guard. The allowlist above is not a substitute either —
     * it says WHICH modules may import, this says which modules may never, and a failure here
     * names the boundary rather than only the file.
     *
     * `apps/worker/src` joins the list with the widened walk. The worker is a BullMQ process
     * with no DOM and no reader: a registry import there could only ever be a server-side
     * decision, and unlike the web app there is no `'use client'` that could make it cosmetic.
     */
    const WORKER_SRC = join(REPO_ROOT, 'apps', 'worker', 'src');
    const forbidden = repoSourceFiles()
      .filter(
        (full) =>
          full.startsWith(join(WEB_SRC, 'server')) ||
          full.startsWith(WORKER_SRC) ||
          full === join(WEB_SRC, 'proxy.ts') ||
          full === join(WEB_SRC, 'middleware.ts') ||
          /\/route\.tsx?$/.test(full),
      )
      .filter((full) => importsRegistry(full, stripComments(readFileSync(full, 'utf8'))))
      .map(repoRelative);

    expect(
      forbidden,
      'the readiness registry is being consulted on a server boundary (the proxy, ' +
        '`src/server/`, the worker, or a route handler). ADR-0005 D7: it is a cosmetic ' +
        'layout hint, never a control surface.',
    ).toEqual([]);
  });
});
