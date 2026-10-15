// @vitest-environment node

import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import en from '@expenseos/i18n/catalogs/en/nav';
import frCA from '@expenseos/i18n/catalogs/fr-CA/nav';
import { describe, expect, it, vi } from 'vitest';

// Sidebar is a client component; `@/i18n/navigation` reaches next-intl's client
// navigation, which reaches `next/navigation` and cannot load outside a Next runtime.
// Nothing here renders — only the SECTIONS data is under test — so the module is
// stubbed rather than the test being moved into a browser environment.
vi.mock('@/i18n/navigation', () => ({
  Link: 'a',
  usePathname: () => '/',
}));

const { SECTIONS, phoneHiddenRoutes } = await import('./Sidebar');
const { titleKeyForPath } = await import('./pageTitle');
const { PORTED_SCREENS, VELOEXPENSE_ITEMS, VELOEXPENSE_ROUTES, veloExpenseRoute } = await import(
  './veloexpenseNav'
);
const { MOBILE_READINESS } = await import('./mobileReadiness');

import type { DispositionTable } from './mobileReadiness';

/**
 * Every nav key resolves to a real catalog entry, in every locale.
 *
 * next-intl renders a missing key as the key itself, so a sidebar entry with no
 * catalog line ships a menu item literally labelled `nav.items.assistantFeedback`.
 * Nothing catches it: the key is a string, so the typecheck is happy, and the
 * i18n coverage script only compares locales against each other — a key missing
 * from BOTH is perfectly consistent.
 *
 * That is exactly how it happened: the entry existed, at the nav ROOT, while
 * Sidebar and TopBar both read `nav.items.*`.
 */

const CATALOGS = { en, 'fr-CA': frCA } as const;

describe('sidebar nav keys', () => {
  const itemKeys = [
    ...SECTIONS.flatMap((s) => s.items.map((i) => i.key)),
    // VeloExpense: its own items read the same catalog (veloexpenseNav.ts).
    ...Object.values(VELOEXPENSE_ITEMS)
      .flat()
      .map((i) => i.key),
  ];
  const sectionKeys = SECTIONS.flatMap((s) => (s.sectionKey ? [s.sectionKey] : []));

  it('has something to check', () => {
    // A guard on the guard: if SECTIONS ever stops being reachable, the loops below
    // would pass vacuously and this file would prove nothing.
    expect(itemKeys.length).toBeGreaterThan(20);
    expect(sectionKeys.length).toBeGreaterThan(3);
  });

  it('opens HOME, and the whole navigation, with Dashboard', () => {
    /**
     * Position is the feature. The dashboard is where a reader lands, so it has to be the
     * first thing they see in the menu they landed beside — an entry three rows down reads
     * as one more report screen. Nothing else pins ORDER, so a tidy-up that re-sorted the
     * HOME items alphabetically would move it and no other test would notice.
     */
    expect(SECTIONS[0]?.sectionKey).toBe('home');
    expect(SECTIONS[0]?.items[0]?.key).toBe('dashboard');
    expect(SECTIONS[0]?.items[0]?.to).toBe('/dashboard');
  });

  for (const [locale, catalog] of Object.entries(CATALOGS)) {
    it(`resolves every item key in ${locale}`, () => {
      const missing = itemKeys.filter((k) => !(k in (catalog.items ?? {})));
      expect(missing).toEqual([]);
    });

    it(`resolves every section key in ${locale}`, () => {
      const missing = sectionKeys.filter((k) => !(k in (catalog.sections ?? {})));
      expect(missing).toEqual([]);
    });
  }

  it('gates /expenses/all on the same disjunction the page enforces', () => {
    // expenses/all/page.tsx admits `report.read.all || report.reimburse`. Naming only
    // one of them here hid the entry from a reader who could open the page by URL.
    const item = SECTIONS.flatMap((s) => s.items).find((i) => i.key === 'allExpenses');
    expect(item?.requires).toEqual(['expense.report.read.all', 'expense.report.reimburse']);
  });

  it('gates /admin/api-keys on the same disjunction the page enforces', () => {
    // admin/api-keys/page.tsx admits `admin.apiKey.create || admin.apiKey.list` and mounts
    // one half per permission. Naming only `list` — as this entry did while the page was a
    // log alone — hid the menu from a `create`-only holder who can open the page by URL and
    // mint a platform key from it: the /expenses/all defect, one route over.
    const item = SECTIONS.flatMap((s) => s.items).find((i) => i.key === 'apiManagement');
    expect(item?.requires).toEqual(['admin.apiKey.create', 'admin.apiKey.list']);
  });

  it('has no duplicate item keys', () => {
    // Two entries sharing a key means one of them is silently mislabelled.
    // VeloExpense: among the entries that can show together. A VeloExpense item may reuse
    // the label of the ExpenseOS item it stands in for while that one is hidden (`null`).
    const showable = [
      ...SECTIONS.flatMap((s) => s.items)
        .filter((i) => veloExpenseRoute(i.to) !== null)
        .map((i) => i.key),
      ...Object.values(VELOEXPENSE_ITEMS)
        .flat()
        .map((i) => i.key),
    ];
    const seen = new Set<string>();
    const dupes: string[] = [];
    for (const k of showable) {
      if (seen.has(k)) dupes.push(k);
      seen.add(k);
    }
    expect(dupes).toEqual([]);
  });
});

/**
 * Every nav destination must be a route that exists.
 *
 * Six items pointed at `/dashboard`, so clicking them silently rendered the dashboard
 * placeholder: a menu that lied about what the product has. The sharpest of them was
 * `notifications`, whose page WORKED and was simply unreachable from the navigation (GA
 * readiness report F01).
 *
 * The existing checks in this file assert every LABEL resolves in both catalogs. Nothing
 * asserted the same about destinations, which is how a `to:` could point anywhere at all —
 * so this walks the App Router directory the same way Next does.
 */
describe('every nav destination resolves to a real route', () => {
  // Derived from THIS FILE, not from `process.cwd()` — vitest runs from the repo root,
  // so a cwd-relative path silently resolves to nothing and the check passes vacuously.
  // VeloExpense: the pages are under `app/`, beside this route group rather than inside it
  // (ExpenseOS's live in `(app)/`), so the walk starts one level up.
  const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

  /** Does `/a/b` exist as a page, allowing for route groups and dynamic segments? */
  const routeExists = (to: string, { dynamic = true } = {}): boolean => {
    const segments = to.split('/').filter(Boolean);
    const walk = (dir: string, rest: string[]): boolean => {
      if (rest.length === 0) return existsSync(join(dir, 'page.tsx'));
      const [head, ...tail] = rest;
      const direct = join(dir, head);
      if (existsSync(direct) && walk(direct, tail)) return true;
      // A route group `(x)` is transparent in the URL, and a dynamic `[id]` matches
      // anything — both are how Next resolves, so both are how this resolves.
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const isGroup = entry.name.startsWith('(') && entry.name.endsWith(')');
        const isDynamic = entry.name.startsWith('[');
        if (isGroup && walk(join(dir, entry.name), rest)) return true;
        if (dynamic && isDynamic && walk(join(dir, entry.name), tail)) return true;
      }
      return false;
    };
    return walk(APP_DIR, segments);
  };

  it('has a page behind every item', () => {
    // VeloExpense: at the path VeloExpense serves it from; an item mapped to `null` is not
    // shown at all (veloexpenseNav.ts), and the next case keeps those `null`s honest.
    const broken = SECTIONS.flatMap((s) => s.items)
      .map((i) => ({ key: i.key, to: veloExpenseRoute(i.to) }))
      .filter((i): i is { key: string; to: string } => i.to !== null && !routeExists(i.to))
      .map((i) => `${i.key} → ${i.to}`);
    expect(broken, 'nav items pointing at a route that does not exist').toEqual([]);
  });

  it('VeloExpense: hides an item as "not ported" only while its page really is missing', () => {
    /**
     * The map only shrinks. A screen ported to its ExpenseOS path must delete its `null`,
     * or its menu entry stays hidden over a page that works — the quiet opposite of F01.
     */
    const stale = Object.entries(VELOEXPENSE_ROUTES)
      // Its OWN page, not a dynamic segment that happens to match: `/expenses/all` resolves
      // to VeloExpense's `/expenses/[reportId]`, which is a report, not the list.
      .filter(([from, to]) => to === null && routeExists(from, { dynamic: false }))
      .map(([from]) => from);
    expect(stale, '`null` entries whose page now exists — delete them').toEqual([]);
  });

  it('VeloExpense: maps only routes the menu has', () => {
    const menu = new Set(SECTIONS.flatMap((s) => s.items.map((i) => i.to)));
    expect(Object.keys(VELOEXPENSE_ROUTES).filter((r) => !menu.has(r))).toEqual([]);
  });

  it("VeloExpense: has a page behind every VeloExpense item, in a section that exists", () => {
    const sectionKeys = new Set(SECTIONS.map((s) => s.sectionKey));
    expect(Object.keys(VELOEXPENSE_ITEMS).filter((k) => !sectionKeys.has(k))).toEqual([]);
    const broken = Object.values(VELOEXPENSE_ITEMS)
      .flat()
      .filter((i) => !routeExists(i.to))
      .map((i) => `${i.key} → ${i.to}`);
    expect(broken).toEqual([]);
  });

  it('VeloExpense: never offers two entries for one VeloExpense page', () => {
    const tos = [
      ...SECTIONS.flatMap((s) => s.items.map((i) => veloExpenseRoute(i.to))),
      ...Object.values(VELOEXPENSE_ITEMS)
        .flat()
        .map((i) => i.to),
    ].filter((to): to is string => to !== null);
    expect(tos.filter((to, n) => tos.indexOf(to) !== n)).toEqual([]);
  });

  it('points exactly one item — Dashboard — at /dashboard', () => {
    /**
     * NARROWED, not deleted. This read `toEqual([])`: no item may point at `/dashboard`
     * at all. That was right when `/dashboard` was a placeholder and SIX items were parked
     * on it, each silently rendering a page that was not the feature its label named (GA
     * readiness F01) — and the route-exists check above cannot catch that shape, because a
     * placeholder is a real page, it just is not the feature.
     *
     * `/dashboard` is now a feature of its own, so exactly one item is allowed to point at
     * it: the Dashboard item. The assertion is an allowlist of one rather than an empty
     * list, so the guard still fails the moment a SECOND item is parked there — which is
     * the regression it was written to catch, and the reason it was narrowed instead of
     * removed. Deleting the case to let the Dashboard item land is how the six came back.
     */
    const parked = SECTIONS.flatMap((s) => s.items)
      .filter((i) => i.to === '/dashboard')
      .map((i) => i.key);
    expect(parked, 'items pointing at /dashboard — only `dashboard` may').toEqual(['dashboard']);
  });

  it('never lists two items pointing at the same place', () => {
    /**
     * `apiManagement` and `apiKeyLog` both pointed at `/admin/api-keys`, with the same
     * permission — so Administration showed two entries going to the same screen, one of them
     * labelled "API Management" for what is a read-only request log (GA readiness report
     * F01/F47). #334 removed four dead links and left this duplicate.
     *
     * The existing guards could not catch it: the route EXISTS, and it is not `/dashboard`.
     * Two names for one destination is its own defect — the reader cannot tell which to
     * click, and one of the two names describes something the product does not have.
     */
    const byTo = new Map<string, string[]>();
    for (const item of SECTIONS.flatMap((s) => s.items)) {
      byTo.set(item.to, [...(byTo.get(item.to) ?? []), item.key]);
    }
    const shared = [...byTo.entries()]
      .filter(([, keys]) => keys.length > 1)
      .map(([to, keys]) => `${to} ← ${keys.join(', ')}`);
    expect(shared, 'two nav items pointing at one destination').toEqual([]);
  });

  it('has neither a route nor a nav item for /my-info', () => {
    /**
     * THE HALF-REVERT GUARD, IN THE ONE DIRECTION NOTHING ELSE COVERS.
     *
     * `/my-info` was deleted whole: the route, both catalogs, the nav item and the title
     * entry. The two guards above already fail a PARTIAL restore — `has a page behind
     * every item` fails a nav item with no route, and `$to titles itself $key` fails one
     * with no `pageTitle` entry — but a COMPLETE restore of both halves satisfies every
     * check in this file, and re-creating a page ADR-0002's exit condition retired should
     * not be something a refactor can do quietly.
     *
     * Deliberately narrow. The general form — "no nav-less route, no route-less item" —
     * would need an allowlist (`/profile`, `/change-password`, `/enroll-mfa` are all
     * legitimately nav-less) longer than the check itself, and it would rot. This names
     * one route, has no maintenance surface, and dies naturally the day somebody
     * deliberately rebuilds `/my-info` and deletes these five lines to say so.
     *
     * `proves the check can fail` below stops the first assertion passing vacuously.
     */
    expect(routeExists('/my-info')).toBe(false);
    expect(SECTIONS.flatMap((s) => s.items).map((i) => i.to)).not.toContain('/my-info');
  });

  it('proves the check can fail', () => {
    // Otherwise a broken `routeExists` would report a clean nav forever.
    expect(routeExists('/definitely-not-a-route')).toBe(false);
    expect(routeExists('/expenses')).toBe(true);
  });
});

/**
 * Every destination the sidebar offers names ITSELF in the top bar.
 *
 * `ROUTE_TITLE_KEYS` is maintained by hand, and a nav item added without its entry
 * does not fail loudly. It fails in one of two silent ways:
 *
 *   · no entry, and no entry above it either → the header renders an EMPTY heading,
 *     so the page looks like it lost its title and a screen reader announces nothing;
 *   · no entry, but a SHORTER route matches by prefix → it inherits that route's
 *     title and claims to be a different page.
 *
 * Both shipped: Travel Categories and NetSuite > Business Units rendered blank, and
 * All expenses called itself "My Expense Reports" because `/expenses` claimed it.
 * Asserting the title key equals the nav item's OWN key catches both at once, and
 * catches them for every item added later.
 */
describe('the top bar titles every nav destination', () => {
  /**
   * Routes whose page mounts its own `left` slot, which REPLACES the route-derived
   * title. They are exempt by design, not by oversight — keep the list short, and
   * only add a route after checking on screen that it does title itself.
   */
  const SELF_TITLING = new Set(['/analytics']);

  const destinations = SECTIONS.flatMap((s) => s.items.map((i) => ({ key: i.key, to: i.to })));

  it('has something to check', () => {
    expect(destinations.length).toBeGreaterThan(20);
  });

  it.each(destinations.filter((d) => !SELF_TITLING.has(d.to)))(
    '$to titles itself $key',
    ({ key, to }) => {
      expect(titleKeyForPath(to)).toBe(key);
    },
  );
  // VeloExpense: the top bar titles only PORTED screens (veloexpenseNav.ts), and each of
  // those must title itself like any ExpenseOS destination above.
  it.each(PORTED_SCREENS.map((to) => ({ to })))('VeloExpense: ported $to has a title', ({ to }) => {
    expect(titleKeyForPath(to)).not.toBeNull();
  });
});

/**
 * The small-screen nav filter, as pure arithmetic.
 *
 * ─── WHY THE TABLE IS INJECTED AND NOT READ ──────────────────────────────────────────────
 *
 * The case that ships visibly broken is the EMPTY SECTION: hide every phone-visible item in a
 * section and it renders below `lg` as a heading with nothing under it, on every phone, until
 * somebody looks. When this block was written that case could not be produced from the
 * shipped registry at all — it held one row — and a test that waited for it to become
 * producible would be a test that starts working, unannounced, on whichever page task tipped
 * the count. So the arithmetic is driven by tables this file builds, and it stays that way
 * now that the registry CAN produce it: a matcher test pinned to the shipped contents goes
 * red on somebody else's commit for reasons they cannot see.
 *
 * The shipped registry gets exactly two assertions, and both are now about CONTENTS rather
 * than wiring, because the contents became the news: WHICH sections it empties (COMPLIANCE &
 * AUDIT, ADMINISTRATION and NETSUITE, as of P10's last batch) and WHICH nav destinations it
 * takes off a phone. Both are exact equalities, both grow once per batch, and both are meant
 * to be read on the commit that moves them.
 */
describe('the small-screen nav filter', () => {
  const TABLE: DispositionTable = Object.freeze({
    '/admin/roles': 'desktop',
    '/expenses/all': 'desktop',
    '/analytics': 'limited',
  });

  it('hides only the routes ruled `desktop`', () => {
    const { hidden } = phoneHiddenRoutes(
      ['/dashboard', '/admin/roles', '/analytics', '/expenses/all'],
      TABLE,
    );
    expect([...hidden].sort()).toEqual(['/admin/roles', '/expenses/all']);
  });

  it('does NOT hide a route ruled `limited`', () => {
    // `limited` is the default for everything unruled. If it hid anything, one page task's
    // honest "rough edges" note would blank half the menu.
    expect(phoneHiddenRoutes(['/analytics'], TABLE).hidden.size).toBe(0);
    expect(phoneHiddenRoutes(['/analytics'], TABLE).allHidden).toBe(false);
  });

  it('reports a section emptied when every one of its items was hidden', () => {
    const { hidden, allHidden } = phoneHiddenRoutes(['/admin/roles', '/expenses/all'], TABLE);
    expect(hidden.size).toBe(2);
    expect(allHidden).toBe(true);
  });

  it('does not report it emptied while one item survives', () => {
    expect(phoneHiddenRoutes(['/admin/roles', '/dashboard'], TABLE).allHidden).toBe(false);
  });

  it('never reports an EMPTY section as emptied', () => {
    /**
     * The vacuous case, and it matters: `[] .every(...)` is true, so the naive form marks a
     * section with no items at all as "all hidden" and attaches `max-lg:hidden` to something
     * the module/RBAC gate already dropped. Harmless today, and exactly the kind of quiet
     * wrongness that becomes load-bearing when somebody reuses the flag.
     */
    expect(phoneHiddenRoutes([], TABLE)).toEqual({ hidden: new Set(), allHidden: false });
  });

  it('honours prefix matching, so a child route hides with its parent', () => {
    expect(phoneHiddenRoutes(['/admin/roles/new'], TABLE).hidden.has('/admin/roles/new')).toBe(
      true,
    );
    // …and a hyphenated neighbour does not. The segment-boundary rule, seen from the nav.
    expect(phoneHiddenRoutes(['/admin/roles-report'], TABLE).hidden.size).toBe(0);
  });

  it('reads the shipped registry when no table is injected', () => {
    expect(phoneHiddenRoutes(['/admin/roles']).hidden.has('/admin/roles')).toBe(true);
    expect(phoneHiddenRoutes(['/dashboard']).hidden.size).toBe(0);
  });

  it('names every section the registry empties today: COMPLIANCE & AUDIT, ADMINISTRATION, the ledger section', () => {
    /**
     * INVERTED ONCE, THEN GROWN ONCE. Both movements are the news, and neither weakened it.
     *
     * This case read `toEqual([])` from the day it was written until the batch that ruled the
     * 22 non-gated `/admin/*` routes `desktop`. It was BUILT to go red on that commit: "the
     * day a page task tips a section over, this goes red and points at the section — which is
     * the moment somebody needs to look at `max-lg:hidden` on it rather than discover a blank
     * heading on a phone." Somebody looked; the answer became `['complianceAudit']`.
     *
     * THE LIST IS NOW THREE, AND THAT IS ITS FINAL SHAPE FOR P10. The module-gated batch —
     * `/admin/assistant-feedback` plus all ten `/ledger/*` — takes the last two. Written out
     * so a reader can check the arithmetic rather than trust it:
     *
     *   · COMPLIANCE & AUDIT holds exactly four items (`/admin/policies`,
     *     `/admin/audit-trail`, `/admin/fraud-detection`, `/admin/control-evaluation`), all
     *     four ruled by the 22-row batch.
     *   · ADMINISTRATION holds fourteen. Thirteen went in that batch or earlier; the
     *     fourteenth is `/admin/assistant-feedback`, and it is in this one.
     *   · NETSUITE holds exactly the eleven `/ledger/*` routes, and this batch is all
     *     eleven. (This line read "ten" and "all ten" from the day it was written. It was a
     *     miscount, not drift: all eleven rows landed together in #488, and the assertion
     *     below has listed eleven ever since. Corrected by T07 because that task's arithmetic
     *     case a few lines down pins the eleven, and the two would otherwise contradict each
     *     other in adjacent comments.)
     *
     * So below `lg` three sections lose every item they hold. WHAT HAPPENS TO THEM NEXT
     * CHANGED IN THIS COMMIT: `Sidebar` used to wrap each such section — heading included — in
     * `max-lg:hidden`, so the whole thing vanished. T07 deleted that wrapper (ADR-0009, and the
     * addendum under ADR-0005 D6 which the wrapper clause is superseded by). The heading now
     * renders at every width and the section carries a disclosure that reveals its rows in
     * place; `Sidebar.test.tsx` pins the wrapper count at 0. Order is SECTIONS order, not
     * alphabetical, because that is the order the filter reports and it reads down the menu.
     *
     * THE LIST STAYS AN EXACT EQUALITY. P10 adds nothing further, but P02 through P11 will
     * each move rows, and a section emptying is the most user-visible consequence a ruling
     * has — an equality is what forces somebody to read the change instead of letting it
     * accumulate under a `toContain`. Update it to what is true at the commit; do not weaken
     * it, and do not delete the case.
     *
     * WHAT THIS CASE CANNOT SEE, and it matters for the two sections added here: eleven of the
     * rows behind them are module-gated and answer 404 on a stock seed, so no environment
     * renders ADMINISTRATION's fourteenth item or any NETSUITE item in the first place. This
     * is arithmetic over the SECTIONS data with every module notionally on. It is the right
     * claim to pin — the nav a workspace with NetSuite installed would get — but it is not a
     * claim that anybody has seen these two sections empty. See `mobileReadiness.ts`'s
     * "recorded, not gate-verified" note.
     *
     * Stated on the DATA rather than on a render, so it covers every section at once and does
     * not depend on which permissions a rendered fixture happens to hold. Note the two are
     * genuinely different claims: a section can be emptied HERE and not produce a wrapper in
     * a render whose fixture never had those items in the first place.
     */
    const emptied = SECTIONS.filter(
      (s) =>
        phoneHiddenRoutes(
          s.items.map((i) => i.to),
          MOBILE_READINESS,
        ).allHidden,
    ).map((s) => s.sectionKey ?? '(unlabelled)');
    expect(emptied, 'sections with no phone-visible items left').toEqual([
      'complianceAudit',
      'administration',
      'ledger',
    ]);
  });

  it('names every section with a phone-hidden item today, which is a longer list', () => {
    /**
     * BESIDE THE CASE ABOVE, NEVER INSTEAD OF IT. The two look alike and answer different
     * questions, and T07 is the task that makes the difference matter.
     *
     *   · The case above answers `allHidden` — a heading with NOTHING under it. Three
     *     sections. That is the most user-visible consequence a `desktop` ruling has, and it
     *     is the trigger for the next signposting task, so it stays pinned at three and is
     *     deliberately not made resilient.
     *   · This case answers `hidden.size > 0` — ANY loss at all. Six sections. That is the
     *     set that renders a disclosure control below `lg`, because the control's condition
     *     is `phone.hidden.size > 0` and nothing else (see `Sidebar.tsx`: gating it on a
     *     minimum count or on `!allHidden` is what returns ADMINISTRATION to a labelled
     *     empty heading, which is the defect ADR-0005 D6 exists to prevent).
     *
     * Re-pointing the case above at this list would retire the three-section claim silently
     * and nobody would notice until a future page task emptied a fourth section to no alarm.
     * So: two cases, two lists, and when they converge it will be because every section lost
     * everything, which is worth being told about twice.
     *
     * EXACT EQUALITY, in SECTIONS order, for the same reason every other list in this
     * describe is exact: a section acquiring or losing its control is a change to what the
     * reader is shown, and it should be read on the commit that moves it.
     */
    const signposted = SECTIONS.filter(
      (s) =>
        phoneHiddenRoutes(
          s.items.map((i) => i.to),
          MOBILE_READINESS,
        ).hidden.size > 0,
    ).map((s) => s.sectionKey ?? '(unlabelled)');
    expect(signposted, 'sections that render a disclosure control below `lg`').toEqual([
      'home',
      'expenseManagement',
      'vcc',
      'complianceAudit',
      'administration',
      'ledger',
    ]);
  });

  it('counts what each section loses below `lg`, and what they lose in total', () => {
    /**
     * THE ARITHMETIC, PER SECTION, MEASURED — not carried from any plan.
     *
     * The count is what the control's label says out loud: `nav.sectionHiddenToggle` renders
     * `{count, plural, …}` from `phone.hidden.size` for THAT section. So a wrong count here
     * is a wrong sentence on screen, and it is the one number in this feature a reader can
     * check against the rows they see appear when they tap.
     *
     * ALL EIGHT SECTIONS, including the two that lose nothing. APPROVALS and FINANCE &
     * REPORTING at `0` are the D7 half of the claim — a section that lost nothing renders no
     * control and says nothing — and pinning them at zero is what makes a control appearing
     * there fail here rather than on somebody's phone.
     *
     * The denominators are `items.length` from `SECTIONS` — the product's items with every
     * module notionally on, NOT what any one reader sees. A reader's own count is
     * post-RBAC and post-module and is necessarily smaller; `Sidebar.test.tsx` is where that
     * distinction is pinned on a render. This is the whole-product arithmetic, and it is the
     * arithmetic `docs/design/pwa.md` records.
     *
     * Measured at `8eeb60c0` (58 registry rows — 41 `desktop`, 9 `limited`, 8 `ready`):
     * 1 + 8 + 1 + 0 + 0 + 4 + 14 + 11 = 39 nav destinations off a phone.
     *
     * 2026-09-24 (netsuite-report-expense-category): NETSUITE gains `/ledger/expense-categories`,
     * ruled `desktop` like its sibling caches, so 11 → 12 there and 39 → 40 in total.
     *
     * 2026-09-29 (netsuite-tax-group-rates): NETSUITE gains `/ledger/tax-groups`, ruled
     * `desktop` on the same grounds, so 12 → 13 there and 40 → 41 in total.
     */
    const lost = SECTIONS.map(
      (s) =>
        [
          s.sectionKey ?? '(unlabelled)',
          phoneHiddenRoutes(
            s.items.map((i) => i.to),
            MOBILE_READINESS,
          ).hidden.size,
          s.items.length,
        ] as const,
    );
    expect(lost, 'per section: [key, hidden below `lg`, items in total]').toEqual([
      ['home', 1, 3],
      ['expenseManagement', 8, 10],
      ['vcc', 1, 4],
      ['approvals', 0, 2],
      ['financeReporting', 0, 2],
      ['complianceAudit', 4, 4],
      ['administration', 14, 14],
      ['ledger', 13, 13],
    ]);
    expect(
      lost.reduce((n, [, hidden]) => n + hidden, 0),
      'nav destinations a phone reader loses across the whole menu',
    ).toBe(41);
  });

  it('records the two `desktop` routes no nav affordance can reach', () => {
    /**
     * RECORDED, NOT FIXED — and that is an operator decision, not an oversight.
     *
     * `/virtual-cards/import` and `/virtual-cards/import-cards` are ruled `desktop` and have
     * NO nav item at any width, so no affordance derived from the nav — this task's
     * per-section disclosure included — can reach them. Coverage is therefore 39 of the 41
     * `desktop` rows, and the operator accepted that ceiling explicitly ("39 is good enough")
     * rather than it being missed quietly. Whether those two warrant nav entries is an
     * information-architecture decision for whoever owns VIRTUAL CARDS' nav.
     *
     * DO NOT make this go green by adding nav items. If it goes red, a new `desktop` row has
     * appeared that no nav item points at: read it, decide whether that route should be
     * reachable, and either add it to this list with a reason or give it a nav home. The
     * `desktop` ruling itself is `mobileReadiness.ts`'s to make and not this file's to
     * question — a task whose subject is the consequence of a decision may not edit the
     * decision.
     */
    // VeloExpense: and VeloExpense's own screens' nav items (`veloexpenseNav.ts`), which the
    // sidebar renders in the same sections and through the same phone filter — the first
    // VeloExpense row ruled `desktop`, `/admin/compliance` (phone e2e 3), is reached from there.
    const navDestinations = new Set([
      ...SECTIONS.flatMap((s) => s.items.map((i) => i.to)),
      ...Object.values(VELOEXPENSE_ITEMS).flatMap((items) => items.map((i) => i.to)),
    ]);
    const unreachable = Object.entries(MOBILE_READINESS)
      .filter(([, disposition]) => disposition === 'desktop')
      .map(([to]) => to)
      .filter((to) => !navDestinations.has(to));
    expect(unreachable, '`desktop` rows with no nav item at any width').toEqual([
      '/virtual-cards/import',
      '/virtual-cards/import-cards',
    ]);
  });

  it('hides at least one real nav destination — the guard on the guard', () => {
    // If the registry stopped intersecting the nav at all, every assertion above about the
    // real table would pass vacuously and `moreOnLargerScreen` would never render for anyone.
    //
    // EXACT EQUALITY, AND IT STAYS EXACT. This list grows once per page task, and each growth
    // is a nav destination that disappears from a phone — the most user-visible consequence a
    // ruling has. A `toContain` would let the next batch of rows land without anybody reading
    // them, which is the review this line exists to force. Update it to what is true at the
    // commit; do not weaken it.
    //
    // Order is NAV order, not registry order: `phoneHiddenRoutes` filters `all`, which is
    // `SECTIONS` flattened, and the registry is written alphabetically. So the list below
    // reads down the menu — `/users` in HOME; `/expenses/all` and seven rate/category/policy
    // admins in EXPENSE MANAGEMENT; `/virtual-cards/statements` in VIRTUAL CARDS; all four of
    // COMPLIANCE & AUDIT; all fourteen of ADMINISTRATION; and all eleven of NETSUITE.
    // 1 + 8 + 1 + 4 + 14 + 11 = 39, which is what `counts what each section loses` pins per
    // section. ("all ten of NETSUITE" here was the same miscount corrected above.)
    //
    // TWO ENTRIES LAND IN THIS COMMIT, both from P10's last batch: `/expenses/all` and
    // `/virtual-cards/statements`. NEITHER EMPTIES ITS SECTION, which is why the
    // emptied-sections equality above is unchanged at three — EXPENSE MANAGEMENT keeps
    // `/expenses` and `/travel`, and VIRTUAL CARDS keeps `/virtual-cards`,
    // `/virtual-cards/requests` and `/virtual-cards/transactions`.
    //
    // THIRTY-NINE OF THE FORTY-ONE `desktop` REGISTRY ROWS APPEAR HERE. The two that do not
    // are `/virtual-cards/import` and `/virtual-cards/import-cards` — no sidebar item points at
    // either at any width, so no nav-derived affordance reaches them. That is recorded by
    // the `records the two desktop routes no nav affordance can reach` case above, and it is
    // accepted, not fixed. Measured at `8eeb60c0`: 58 registry rows — 41 `desktop`,
    // 9 `limited`, 8 `ready`.
    //
    // This note read "thirty-eight of the forty-five registry keys" and named the four unshelled
    // auth routes and the email decision page among the absent. Both halves are stale: the
    // registry has grown three times in the four days before this edit, and those rows are
    // ruled `ready` or `limited` (or, for the decision page, removed), so they are not
    // candidates for a list of what a phone LOSES at all.
    // Re-measure at the commit rather than trusting this paragraph — it has been wrong twice.
    //
    // TWELVE OF THE THIRTY-NINE ARE ROUTES NOBODY CAN REACH ON A STOCK SEED.
    // `/admin/assistant-feedback` is module-gated on `assistant` and the eleven `/ledger/*`
    // on `netsuite-gl`; neither slug is in `DEFAULT_ACTIVE_MODULES`, so those pages 404 and
    // their nav items are dropped by the module gate long before this filter is consulted.
    // They belong in this list all the same — it is arithmetic over the SECTIONS data, which
    // is the nav a workspace WITH those modules on would get — but a green run here is not
    // evidence that anybody has seen them hidden. `mobileReadiness.ts` says so in those words.
    //
    // 2026-09-24 (netsuite-report-expense-category): `/ledger/expense-categories` lands
    // after `/ledger/vendors`, where its nav item sits — 40 entries, twelve of them NETSUITE.
    //
    // 2026-09-29 (netsuite-tax-group-rates): `/ledger/tax-groups` lands last, after
    // `/ledger/locations`, where its nav item sits — 41 entries, thirteen of them NETSUITE.
    const all = SECTIONS.flatMap((s) => s.items.map((i) => i.to));
    expect([...phoneHiddenRoutes(all, MOBILE_READINESS).hidden]).toEqual([
      '/users',
      '/expenses/all',
      '/admin/per-diem-rates',
      '/admin/fx-rates',
      '/admin/mileage-rates',
      '/admin/expense-categories',
      '/admin/travel-categories',
      '/admin/policy-rules',
      '/admin/policy-violations',
      '/virtual-cards/statements',
      '/admin/policies',
      '/admin/audit-trail',
      '/admin/fraud-detection',
      '/admin/control-evaluation',
      '/admin/roles',
      '/admin/business-units',
      '/admin/legal-entities',
      '/admin/departments',
      '/admin/job-levels',
      '/admin/fiscal-years',
      '/admin/api-keys',
      '/admin/assistant-feedback',
      '/admin/notification-templates',
      '/admin/modules',
      '/admin/integrations',
      '/admin/authentication',
      '/admin/approval-workflows',
      '/admin/platform',
      '/ledger/sync',
      '/ledger/posting',
      '/ledger/people',
      '/ledger/settings',
      '/ledger/gl-accounts',
      '/ledger/vendors',
      '/ledger/expense-categories',
      '/ledger/classes',
      '/ledger/departments',
      '/ledger/business-units',
      '/ledger/subsidiaries',
      '/ledger/locations',
      '/ledger/tax-groups',
    ]);
  });
});

/**
 * The per-section disclosure control has a label, in both locales, at the nav ROOT.
 *
 * `nav.sectionHiddenToggle` is the one string T07 adds, and it is deliberately ONE FLAT KEY
 * rather than one per section or one per state: `check-used-keys.mjs` resolves literal keys
 * only and skips computed ones, so a key assembled at runtime would ship `MISSING_MESSAGE`
 * past every gate in the repo and render the raw key on a button — the `nav.items.*` failure
 * this file's first describe exists to catch, one level up in the catalog.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO: parse the ICU. This repo's standing rule is that a
 * malformed message reaches the UI and gets REPORTED rather than being blocked by a gate, so
 * there is no ICU-parse assertion here and none should be added. The claim is presence and
 * non-emptiness in both catalogs — which is what `check-coverage` cannot make, because it
 * compares the locales against each other and a key missing from BOTH is perfectly
 * consistent.
 */
describe('the disclosure control has a label in every locale', () => {
  for (const [locale, catalog] of Object.entries(CATALOGS)) {
    it(`resolves nav.sectionHiddenToggle in ${locale}`, () => {
      const label = catalog.sectionHiddenToggle;
      // Flat, at the nav root, beside `moreOnLargerScreen` — not nested under `sections`,
      // where `check-used-keys` would not find it and the component would not read it.
      expect('sectionHiddenToggle' in catalog).toBe(true);
      expect(typeof label).toBe('string');
      expect(String(label).trim().length).toBeGreaterThan(0);
    });
  }

  it('does not ship the EN string as the FR-CA translation', () => {
    // `check-coverage` compares KEY SETS, so an FR-CA line copy-pasted from EN passes it and
    // every other gate, and the button reads English on a French phone. The two strings for
    // this key are genuinely different sentences; asserting inequality costs nothing and is
    // the only cheap check that notices a paste.
    expect(frCA.sectionHiddenToggle).not.toBe(en.sectionHiddenToggle);
  });
});
