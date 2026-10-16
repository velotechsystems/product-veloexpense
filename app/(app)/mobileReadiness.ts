import { SUPPORTED_LOCALES } from '@expenseos/i18n/locales';

/**
 * Route disposition on a small screen — the app's ONE source of truth for which routes
 * have a phone layout and which do not.
 *
 * ─── WHY THIS FILE EXISTS, AND WHY IT IS HERE AND NOT IN THE DESIGN SYSTEM ───────────────
 *
 * Eleven downstream page tasks each rule one or more routes. Without a registry each of
 * them would express its ruling as a bespoke condition inside its own page — eleven
 * mechanisms, eleven test shapes, and no way to ask the codebase "which routes are
 * desktop-only?" other than by reading eleven files. One table answers that question, and
 * `mobileReadiness.test.ts` holds it to `docs/design/pwa.md`'s Page-readiness table so the
 * documented answer and the shipped answer cannot drift.
 *
 * It lives in `apps/web`, NOT in `packages/design-system`, and that is a ruling rather than
 * a convenience. Route knowledge is application knowledge: the design system renders a
 * sidebar, it does not know that `/admin/roles` is a role builder. Putting the table in the
 * shared package would make it a third source of truth alongside this app's router and the
 * markdown table, would turn each of the eleven page tasks into a shared-package change
 * with every consumer's blast radius, and would put the `data-testid` this feature is
 * addressed by outside `scripts/check-e2e-ids.mjs`, which scans `apps/web/src` only.
 *
 * ─── PLAIN DATA. NO REACT, NO next-intl ──────────────────────────────────────────────────
 *
 * This module must stay importable from a Node-environment test. `Sidebar.nav.test.ts` runs
 * under `// @vitest-environment node` and imports the nav data to check it; the moment this
 * file reaches React or next-intl, that file fails AT IMPORT TIME, several layers away from
 * the edit that caused it. `@expenseos/i18n/locales` is the one import, and it is a frozen
 * array of two strings — see the locale-stripping note below for why it is worth the edge.
 *
 * ─── THE MATCH: EXACT, OR LONGEST PREFIX ON A SEGMENT BOUNDARY ───────────────────────────
 *
 * Exact wins; otherwise the LONGEST listed prefix that ends on a `/` boundary wins. Both
 * halves are load-bearing:
 *
 *   · Longest-prefix, so `/expenses` → `limited` and `/expenses/all` → `desktop` can coexist
 *     with the more specific row deciding. A first-match or a shortest-match rule would let
 *     the general row silently swallow the specific one, and which one wins would depend on
 *     object key order.
 *   · SEGMENT BOUNDARY, so a listed `/travel` never claims `/travel-agency`. A naive
 *     `startsWith` does claim it, silently, and the failure mode is a page nobody can open
 *     on a phone for a reason no one can find. `dispositionFor` requires the character after
 *     the prefix to be `/` or nothing at all.
 *
 * ─── UNLISTED RESOLVES `limited`, NOT `ready` ────────────────────────────────────────────
 *
 * The default is the honest one. `ready` would be a claim — "this page has been looked at on
 * a phone and works" — made on behalf of 51 routes nobody has looked at yet. `limited` says
 * only "reachable, not yet ruled", which is exactly what `docs/design/pwa.md` records for
 * them. It is also the safe default in the direction that matters: an unlisted route renders
 * its page rather than being hidden behind a notice, so a mistake here can never take a
 * surface away from someone.
 *
 * ─── THE GATE IS COSMETIC ────────────────────────────────────────────────────────────────
 *
 * Nothing in this file is a permission. `CLAUDE.md`'s "Server is authoritative; UI gating is
 * cosmetic" holds without exception: ruling a route `desktop` changes what the phone shows
 * first, it does not change who may open the route. Server-side RBAC and module gating are
 * untouched, and "Continue anyway" always works. Do not grow a server-side check, a
 * middleware branch or a redirect out of this table.
 */

/**
 * Disposition vocabulary, per `docs/design/pwa.md` ruling 1.
 *
 *   · `ready`   — a real phone surface; nothing is suppressed.
 *   · `limited` — reachable and usable, with known rough edges. Renders normally.
 *   · `desktop` — no phone layout. `DesktopOnlyNotice` suppresses the page below `lg` and
 *                 offers a way through.
 */
export type Disposition = 'ready' | 'limited' | 'desktop';

/** Route prefix → disposition. Keys are locale-free app paths with a leading `/`. */
export type DispositionTable = Readonly<Record<string, Disposition>>;

/** What an unlisted route resolves to. See the header. */
export const DEFAULT_DISPOSITION: Disposition = 'limited';

/**
 * The shipped table. Four rows, and every disposition in the vocabulary is represented.
 *
 * TEN ROWS as of P03 — T04's one, P01's five, P02's three and P03's one. The paragraphs that
 * follow record why this table shipped with a row at all rather than empty (still the only
 * reason the mechanism has ever been through its own gate), then P01's five rows, then P02's
 * three, then P03's one and how little it does.
 *
 * T04 built the mechanism and shipped ONE row deliberately — shipping it empty was the
 * alternative and it was rejected under an explicit exception: an empty table means
 * `DesktopOnlyNotice` is never rendered by anything, the census's `desktop-notice` branch
 * never fires, and `mobileReadiness.test.ts`'s parity check compares an empty set against
 * an empty set and passes on a parser that reads nothing at all. A gate that has never been
 * through its own subject is not a gate. The eleven page tasks fill the rest of the table
 * in: P01 was the first of them (the five auth routes) P02 added three more, and P03 adds one.
 *
 * `/admin/roles` was the right single row for T04, and the reason is availability rather than
 * taste. `/ledger/*` and `/admin/assistant-feedback` are module-gated — they answer 404 on
 * a stock seed, so they can never exercise the notice branch in CI or on dev. `/admin/roles`
 * is not module-gated, answers 200 for an admin on a stock seed, and P10 was going to rule
 * it `desktop` anyway (`docs/design/pwa.md`'s `/admin/*` glob row). It was split out of that
 * glob in T04's commit; P10 rules the remaining 24 in the batches below.
 *
 * ─── WHY A `limited` ROW IS WRITTEN DOWN AT ALL ──────────────────────────────────────────
 *
 * `limited` is also `DEFAULT_DISPOSITION`, so `/delegations` would resolve to `limited` with
 * no row here at all, and the row changes NOTHING about what any consumer renders — the two
 * consumers both act on `desktop` only. It is here because a ruling and a default are not
 * the same claim. The parity block in `mobileReadiness.test.ts` enforces ruled-row for
 * registry-row in BOTH directions: a route that carries a real disposition in
 * `docs/design/pwa.md` must have an entry here, and a route with an entry here must not
 * still be `unruled` there. Omitting this row to "save" a redundant lookup would make the
 * markdown ruling unenforceable, which is the one thing the registry exists to prevent.
 *
 * ─── THE FOUR P01 ROWS ───────────────────────────────────────────────────────────────────
 *
 * All four are `ready`, and all four are UNSHELLED routes — they live under `[locale]`, not
 * under `(app)`, so neither `Sidebar` nor `DesktopOnlyNotice` ever sees them. Their rulings
 * are a record of what was measured and fixed, not a switch that turns anything on.
 *
 * `/notifications` — `ready`, P02, AND IT IS THE FIRST `ready` ROW ON A SHELLED `(app)`
 * ROUTE — P01's four `ready` rows are unshelled auth pages that neither `Sidebar` nor
 * `DesktopOnlyNotice` ever sees. Read the next three paragraphs before adding another one.
 *
 * `/dashboard` — `ready`, P02 ruled it `limited` and `pwa-dashboard-card-lists` PROMOTED
 * IT. Read the promotion beside the reason it replaced, because the reason is what lets a
 * later reader judge the promotion. P02's `limited` was one card, and this paragraph keeps
 * it: the page mounts `ReportsToApproveCard`, whose `DataTable` put submitter (180px) and
 * total (140px) at x >= 260 — off-screen at every phone width — and that card's flow is
 * triage, not navigation. An approver could see THAT there were four reports waiting and
 * not WHAT they are, which is the flow suppressed rather than a detail lost. UX,
 * arbitrating: "a wrong `limited` costs one revisit. A wrong `ready` retires the route from
 * the follow-up list while an approver still cannot read an amount on a phone." Two
 * specialists refused `ready` independently and a Round-2 arbitration held the refusal, so
 * the reduction was recorded rather than inherited, and it stood until the gap it named was
 * closed.
 *
 * IT IS CLOSED. All three cards now take T03's `DataTableMobileConfig`, so below the
 * compact breakpoint each renders a stacked card list, and the approvals card carries
 * `submitter` in the subtitle slot and `total` in a field row — the two facts P02 measured
 * as suppressed. Desktop is unchanged above the breakpoint. THE MITIGATION P02 RULED OUT IS
 * STILL RULED OUT AND WAS NOT THE ONE TAKEN, which is worth naming so nobody spends an
 * afternoon on it: seeding `columnVisibility` in `createDataTableState` is viewport-agnostic
 * state, so hiding those columns for the phone would hide them ON DESKTOP TOO. What landed
 * is T03's DataTable phone behaviour (`pwa-datatable-mobile`) — the fix P02 named and did
 * not have.
 *
 * WHAT THE WORD `ready` RESTS ON HERE IS A LOCAL RUN ON A DEVELOPER MACHINE, NOT CI, AND
 * `docs/design/pwa.md`'s row is where that is written out in full. Read it before citing
 * this line. In short: the five in-scope specs were run at this task's ship gate on
 * 2026-09-17 against a `next start` build on the task port — 246 passed, 0 failed, 0
 * skipped, 0 flaky — and the `e2e-nightly.yml` run this project's own standard asks for
 * DOES NOT EXIST, because that workflow has been exceeding its 60-minute job cap and
 * reporting `cancelled` since 2026-09-16. Nothing on CI has verified this change. And, as
 * everywhere else in this table, `ready` IS A RULING AND NOT A DEVICE PASS: ruling 9 stands
 * unchanged at `android: unverified`, no phone has been near this route, and a reader who
 * takes "ruled `ready`" for "tested on a device" is reading in something that is not there.
 *
 * `/delegations` — `limited`, P02, AND THE REASON IS ONE OF ITS TWO PRIMARY FLOWS RATHER
 * THAN A ROUGH EDGE ON BOTH. This is the first row in this table whose disposition is set by
 * a NAMED BLOCKER on another task, so read what it does and does not claim:
 *
 *   · "set a delegation" IS completable on a phone as of this commit. The route's labelled
 *     top-bar control was over `TopBar.tsx`'s below-`lg` ration — one icon-only 32x32
 *     control with a 44x44 hit area, or nothing — and since nothing in that file clips, the
 *     row was laid out at full width and painted over the route title, worst in FR-CA where
 *     the label is longer. It is now one element with a responsive box and a
 *     `max-lg:sr-only` label, so the accessible name is unchanged at every width. IT SHIPS
 *     32x44 AND NOT THE RATION'S 44x44, and the horizontal half is a recorded shortfall
 *     rather than a met claim: the slop is the vertical-only `einc-tap-slop` off the
 *     `size="sm"` cva variant, because the right zone's gutter is 6px (`gap-1.5`) and a
 *     horizontal hit region here would reach 6px into the same 6px strip
 *     `NotificationBell`'s `einc-tap-slop-both` trigger already reaches into — the bell is
 *     later in DOM order and wins it, leaving this control an effective 38px across. That
 *     gap is RECORDED in `docs/design/pwa.md`'s tap-target table (remedy at the container:
 *     widen the right zone's gutter; owner whoever owns that zone) rather than closed here.
 *     Inside the
 *     drawer, the two date inputs were a two-column grid at 360px and every field was 40px;
 *     the pair stacks below `sm` and the fields floor at 44px below `lg`.
 *     `e2e/delegations.mobile.spec.ts` completes the flow, in BOTH locales.
 *   · "end a delegation" IS NOT, and it is BLOCKED ON T03 (`pwa-datatable-mobile`, PR #479),
 *     which is not in this branch's history. Revoking runs through `RowActionsMenu` inside
 *     the shared `DataTable`, and that trigger is 24 x 24 WITH NO SLOP CLASS AT ALL — worse
 *     than the `icon-xs` call sites already tabled in `docs/design/pwa.md`, which at least
 *     ship 24 x 44 and so meet the floor on the slopped axis. It meets it on neither. No
 *     DataTable phone behaviour exists here to fix it against, so the gap is RECORDED (in
 *     that doc's tap-target table, owner T03) rather than worked around. Do not build a
 *     bespoke phone revoke path on this route to close it.
 *
 * That split is why the row is `limited` and not `ready`, and it is also why `limited` here
 * carries a flow spec even though a `limited` row owes none: the half that works is worth
 * proving, and the half that does not is worth naming.
 *
 * SO WHY LIST A ROUTE AT THE DEFAULT DISPOSITION AT ALL, given `DEFAULT_DISPOSITION` is
 * already `limited` and this row changes no lookup's answer? Because parity is ruled-row
 * for registry-row in both directions (`mobileReadiness.test.ts`): `docs/design/pwa.md`
 * carries the ruling a human made, and a ruled row there with no counterpart here is a
 * red. The row is what separates "somebody looked at this on a phone and these are the
 * rough edges" from "nobody has looked yet" — the two states the unlisted default cannot
 * tell apart. Every future `limited` ruling owes a row for the same reason.
 *
 * A `ready` row CHANGES NO RENDERING. `limited` and `ready` both render the page untouched
 * — `dispositionFor` is only consulted by `DesktopOnlyNotice` (suppress or not) and by
 * `Sidebar`'s `phoneHiddenRoutes`, which filters on `disposition === 'desktop'` alone. So
 * this row is not a switch; it exists because the parity check in `mobileReadiness.test.ts`
 * is ruled-row ↔ registry-row, and the `ready` claim in the markdown table needs its
 * counterpart here or the suite goes red. Registry row and doc row are one edit.
 *
 * `ready` IS THE ONLY DISPOSITION THAT MAKES A POSITIVE CLAIM, SO IT IS THE ONLY ONE THAT
 * OWES A TEST. `limited` claims only that the page renders and has rough edges — which is
 * also what the unlisted default says, and is why a `limited` row owes no spec beyond the
 * rough edges it names; `desktop` says "no phone layout" and is proved by the notice
 * rendering. `ready` says
 * somebody looked at this page on a phone and it works, and nothing in this module can
 * establish that. For these page tasks it is defined as: the mobile crawl is green at 360,
 * 390 and 412; the primary flow completes in the route's `*.mobile.spec.ts`; and the
 * route's primary-action controls pass `e2e/tap-targets.mobile.spec.ts`. `/notifications`
 * has all three (`e2e/notifications.mobile.spec.ts`, and its "Load more" entry in the
 * tap-target gate). DO NOT add a `ready` row for a route that does not — a `ready` with no
 * spec behind it is a documentation claim wearing a registry's clothes, and `limited` is
 * the honest answer instead.
 *
 * `/profile` → `ready` is P03's row, the second `ready` row on a shelled `(app)` route after
 * P02's `/notifications`, and the row most easily misread. IT BUYS NOTHING AT RUNTIME. `DesktopOnlyNotice` renders for `desktop`
 * and for nothing else, and `limited` — what `/profile` resolved to yesterday, by absence —
 * does not render it either. No pixel and no request differs because this line exists. What
 * differs is the RECORD: the route leaves the `unruled` backlog in `docs/design/pwa.md` and
 * says a person looked at it on a small screen and ruled it. It does not say a phone was
 * involved; the device cells in that document are still `<pending>`, and a reader who takes
 * "ruled `ready`" for "tested `ready`" is reading in something that is not there.
 *
 * It is also a row whose route is only PARTLY ready. `/profile`'s personal-API-key section
 * renders a reduced face below `lg` (ADR-0007) — section-level `limited` inside a `ready`
 * route. This table has no vocabulary for that and deliberately gains none: three
 * dispositions, whole routes, per ADR-0005 D2. A fourth column, or a `ready (mostly)`, would
 * make every one of the remaining page tasks negotiate its own gradations against a matcher
 * that resolves prefixes and knows nothing about sections. A route that needed a disposition
 * per section is a route to rule `limited`.
 *
 * `/travel` — `limited`, P09, AND IT IS THE FIRST ROW IN THIS TABLE WHOSE DISPOSITION IS SET
 * BY AN ABSENCE OF EVIDENCE RATHER THAN BY A DEFECT. Read that distinction before citing the
 * row, because it is the whole of its value as a precedent.
 *
 *   · EVERY DEFECT P09 FOUND LANDS IN P09'S OWN DIFF. Both travel drawers carried an
 *     unconditional `min-w-[42rem]` — 672px, and `min-width` beats `max-width` in a CSS
 *     conflict, so every phone viewport in scope laid the panel out at 672px and BOTH primary
 *     flows opened inside it. The panel is `fixed top-0 right-0`, so that is not a scrollbar
 *     anywhere — it is 312px of the panel PAINTED OFF THE LEFT OF THE SCREEN at 360, 282px at
 *     390, 260px at 412, which is exactly why the crawl reads this route at 0px. Both are
 *     now `min-w-full max-w-full md:min-w-[42rem]`. The three `RequestTable`s took T03's
 *     `DataTableMobileConfig`, the create form's three- and two-column rows stack below `sm`,
 *     the variance table gained a scroller, two controls reached the 44px floor — the
 *     `CityPicker` suggestion row and the `LineBlock` trash — and a third traded horizontal
 *     reach for the top bar's ration: the create control ships 32 × 44, which is a NEW
 *     horizontal shortfall this branch introduced and the `/travel` row records as one.
 *   · WHAT IS MISSING IS A RUN, NOT A FIX. No clause of the `ready` bar above was EVALUATED
 *     in P09. The crawl is structurally blind to both flows — `DrawerContent` mounts
 *     through `DrawerPortal`, so the panel is outside `main#main-content` and the only
 *     overflow gate read this route at 0px before the change and reads 0px after it — and
 *     the other two clauses, `e2e/travel.mobile.spec.ts` and the two `/travel` lanes in
 *     `e2e/tap-targets.mobile.spec.ts`, were authored by P09 itself and NEITHER RAN:
 *     Playwright browsers do not install on the authoring machine and `ci.yml` runs no E2E.
 *   · SO THE ROW CARRIES A COUNTABLE PROMOTION TRIGGER instead of a revisit, and it is in the
 *     `docs/design/pwa.md` Notes cell: one `e2e-nightly.yml` run at or after P09 lands on
 *     `main` showing six passed, zero skipped, zero flaky for the flow spec in EACH of the
 *     three phone projects, plus both tap-target lanes, with the TASK ID and the RUN ID
 *     recorded in the cell on the day the word changes — never a commit SHA, which a squash
 *     merge makes meaningless.
 *
 * **The precedent this sets is about evidence NOT YET GATHERED, never about evidence that
 * cannot be gathered.** A later page task citing this row as authority for "E2E is
 * undischargeable here" is citing a premise `/travel` does not contain: the run exists, on a
 * clock this task did not control.
 *
 * The row also keeps `/admin/travel-categories` at arm's length, which is worth stating
 * because the two read as neighbours. They are not: `dispositionFor`'s matcher is exact-or-
 * prefix-on-a-segment-boundary, `'/admin/travel-categories'` neither equals `'/travel'` nor
 * starts with `'/travel/'`, and it carries its own exact P10 key. `/travel` rules exactly one
 * route with exactly one key.
 * ─── P10'S FIRST TWO ROWS, AND WHY THE GRAPH EDITOR CARRIES NO ROW ───────────────────────
 *
 * `/users` is the employee directory — a DataTable whose phone form is T03's work and whose
 * toolbar is the product's `size="xs"` (28px) call site. `/admin/approval-workflows` is the
 * workflow list, and it is the row that also rules the GRAPH EDITOR beneath it.
 *
 * **`/admin/approval-workflows/[id]` gets no key of its own, deliberately, and that is
 * load-bearing rather than an omission somebody should tidy up.** It inherits `desktop` from
 * the static parent above through `dispositionFor`'s longest-prefix-on-a-segment-boundary
 * match, which is what lets P10 rule forty routes with thirty-nine keys. Adding the fortieth
 * key would not be a harmless belt-and-braces: `docs/design/pwa.md`'s Page-readiness table
 * has no row for the dynamic child, so `mobileReadiness.test.ts`'s registry↔docs parity
 * check — which runs in BOTH directions — would go red on a key that changes no behaviour at
 * all. `mobileReadiness.test.ts` pins the inheritance, and pins the absence of the key, for
 * exactly this reason.
 *
 * Both rows are cosmetic in the sense the header states: the graph editor is still reachable
 * from a phone through "Continue anyway", and `e2e/tap-targets.mobile.spec.ts` goes on
 * measuring both pages from behind the notice (`pastNotice: true`) rather than retiring the
 * gates — they carry the only phone-reachable 28px controls the product has, and PIN-1 and
 * PIN-3 are characterization pins that must stay observable.
 *
 * ─── P10'S 22 NON-GATED `/admin/*` ROWS, AND THE FIRST SECTION THAT EMPTIES ───────────────
 *
 * Every remaining `(app)/admin/` route that is not `/admin/roles` (ruled by T04), not
 * `/admin/approval-workflows` (ruled above), and not `/admin/assistant-feedback` (module-gated
 * on `anthropic`, ruled in its own batch). Twenty-two keys, written alphabetically because
 * there is no other order a reader can check a list this long against — the enumeration is
 * `(app)/admin/`'s own directory listing minus three names, and alphabetical is the only
 * arrangement in which "is X here?" is answerable without reading all of it.
 *
 * All twenty-two are NOT module-gated: `compliance-audit` and `expense-management`, the two
 * module slugs their nav sections carry, are both in `DEFAULT_ACTIVE_MODULES`
 * (`apps/web/src/server/platform/bootstrap.ts:187`), so each answers 200 for an admin on a
 * stock seed and genuinely exercises the notice branch. None of them belongs in
 * `e2e/support/mobile-census.ts`'s `MAY_BE_GATED`, which stays the two entries it has.
 *
 * **THIS IS THE BATCH THAT EMPTIES A NAV SECTION, AND THAT IS THE USER-VISIBLE EVENT.**
 * COMPLIANCE & AUDIT holds exactly four items — `/admin/policies`, `/admin/audit-trail`,
 * `/admin/fraud-detection`, `/admin/control-evaluation` — and all four are here, so below
 * `lg` the section has nothing left in it and `Sidebar`'s `max-lg:hidden` branch fires for
 * the first time in the product's life. `Sidebar.nav.test.ts`'s "empties no section" case was
 * written to go red on exactly this commit and is inverted here to name the section rather
 * than deleted; ADMINISTRATION and NETSUITE do NOT empty in this batch — ADMINISTRATION keeps
 * `/admin/assistant-feedback`, which the next batch takes.
 *
 * THREE OF THESE ROWS CARRY MEASUREMENTS THAT THE RULING RETIRES RATHER THAN REPAIRS.
 * T02's crawl measured `/admin/api-keys` 100px over at 360 and 70px at 390, and
 * `/admin/control-evaluation` 21px over at 360 and clean at 390 — the second- and
 * fourth-widest overflows in the app. Not one line of layout changed here. The pages
 * overflow exactly as much as they did; they are simply no longer the first thing a phone
 * reader is shown, and the crawl no longer measures them. `docs/design/pwa.md`'s rows say so
 * in those words, because a row that reads as "fixed" is a row that loses the debt.
 *
 * `/admin/per-diem-rates` is the one route in this batch with a live e2e gate on it:
 * `e2e/combobox-popup-width.spec.ts` opens its "Add rate" drawer at 1280 AND at 375. Its
 * fixture now steps past the notice at 375 and asserts the notice's ABSENCE at 1280 — the
 * second half being what proves the suppression is width-conditional rather than blanket.
 *
 * ─── P10'S 11 MODULE-GATED ROWS: RULED, NOT GATE-VERIFIED ────────────────────────────────
 *
 * `/admin/assistant-feedback` and all eleven `/ledger/*` routes. They are the last batch, and
 * they are the one batch whose ruling NOTHING CAN OBSERVE, which is why it is written down
 * here in those words rather than left for a reader to infer from a green run.
 *
 * Each of the eleven answers 404 on a stock seed, in every environment, because its page
 * calls `requireActiveModule` for a module that is not in `DEFAULT_ACTIVE_MODULES`
 * (`apps/web/src/server/platform/bootstrap.ts:187`):
 *
 *   · `/admin/assistant-feedback` → module slug **`assistant`**
 *     (`admin/assistant-feedback/page.tsx:21`, via `ASSISTANT_MODULE_SLUG` =
 *     `packages/assistant/src/catalog.ts:33`). `anthropic` is the INTEGRATION that module
 *     requires, not the module — the two are different slugs in different registries, and
 *     the distinction matters here because the Notes cell in `docs/design/pwa.md` names one
 *     of them and a reader will go looking for it.
 *   · the eleven `/ledger/*` routes → module slug **`netsuite-gl`**
 *     (`netsuite/_page.tsx:18` for the seven reference caches, and `sync/page.tsx:17`,
 *     `posting/page.tsx:18`, `settings/page.tsx:17` each calling it directly). `netsuite`
 *     is again the INTEGRATION, which is what PROVIDES `netsuite-gl`.
 *
 * SO THE RULING IS RECORDED, NOT GATE-VERIFIED, and that is a weaker claim than every other
 * row in this table carries. A route that 404s can never reach `DesktopOnlyNotice`: the
 * layout that mounts the notice never renders. `e2e/crawl-mobile.spec.ts` classifies all
 * eleven `gated` on the RESPONSE STATUS, before it ever looks for a notice, and emits no
 * screenshot — so a green crawl says these routes were unreachable, not that the ruling
 * works. The rows below are what a workspace that DOES activate the module would get.
 *
 * NOTHING IS ADDED TO `MAY_BE_GATED` in `e2e/support/mobile-census.ts`, and there is nothing
 * to add: its two patterns — `/^\/netsuite\//` and `/^\/admin\/assistant-feedback$/` —
 * already name exactly these eleven routes. A third entry would be a duplicate route list in
 * the e2e tree, which is the thing that list exists to avoid.
 *
 * **THIS BATCH EMPTIES THE LAST TWO SECTIONS.** ADMINISTRATION's fourteenth item was
 * `/admin/assistant-feedback` — the one the previous batch deliberately left alone — and
 * NETSUITE's ten are all of it, so below `lg` both headings now have nothing under them and
 * `Sidebar`'s `max-lg:hidden` branch wraps all three of COMPLIANCE & AUDIT, ADMINISTRATION
 * and NETSUITE. `Sidebar.nav.test.ts`'s two exact-equality cases are updated there, not
 * relaxed.
 *
 * ─── P10'S LAST FOUR ROWS: THE WIDEST OVERFLOW, AND THE SEGMENT-BOUNDARY PAIR ─────────────
 *
 * `/expenses/all`, `/virtual-cards/statements`, `/virtual-cards/import` and
 * `/virtual-cards/import-cards` — the only four rows in this table under neither `/admin`
 * nor `/netsuite`, which is why they are their own batch and their own group below.
 *
 * ALL FOUR ARE GATE-VERIFIABLE, unlike the eleven above. `/expenses/all` gates on the
 * `expense-management` module (`expenses/all/page.tsx:19`) and the other three on
 * `virtual-credit-cards` (`virtual-cards/statements/page.tsx:19`, `import/page.tsx:18`,
 * `import-cards/page.tsx:20`); BOTH slugs are in `DEFAULT_ACTIVE_MODULES`
 * (`apps/web/src/server/platform/bootstrap.ts:187-198`), so each answers 200 on a stock
 * seed for a reader holding the route's permission and genuinely reaches the notice branch.
 *
 * `/expenses/all` CARRIES THE WIDEST OVERFLOW IN THE APP, AND THE RULING RETIRES THE
 * MEASUREMENT RATHER THAN REPAIRING IT. T02's crawl measured it **127px over at 360 and
 * 97px at 390** — wider than `/admin/api-keys` (100/70) and than every other route measured.
 * Not one line of layout changed here either. The page overflows by exactly as much as it
 * did; a phone reader now meets `DesktopOnlyNotice` first and the mobile crawl stops
 * measuring the route at all. Anyone bringing the AP expense view back to a phone inherits
 * 127px of horizontal overflow, unresolved.
 *
 * IT ALSO COEXISTS WITH `/expenses`, AND THAT IS THE LONGEST-PREFIX RULE EARNING ITS KEEP.
 * `/expenses` is P05's and carries its own `limited` key as of that batch — it was `unruled`,
 * with no key here at all, on the day this row landed. `/expenses/all` is a MORE SPECIFIC
 * path under it, and the header's longest-prefix match is what lets the specific ruling
 * decide without the general row either swallowing it or being swallowed by it. That reads
 * more sharply now than it did then: the contest is between TWO REAL KEYS rather than
 * between one key and the default, which is the shape the rule was actually written for. Note also what the key does NOT reach:
 * `/expenses/approvals` and `/expenses/[reportId]` are not under `/expenses/all`, so P05's
 * and P06's lanes are untouched.
 *
 * `/virtual-cards/import` AND `/virtual-cards/import-cards` ARE THE REAL-WORLD INSTANCE OF
 * THE HAZARD THE SEGMENT-BOUNDARY RULE EXISTS FOR. They are two different pages — bulk
 * TRANSACTION import (`vcc.transaction.import`) and bulk CARD import (`vcc.card.issue`) —
 * whose paths differ by a hyphen and a word. A bare `startsWith` makes the first key claim
 * the second, and here both happen to be `desktop`, so the mis-match would be INVISIBLE
 * today and would surface the day somebody rules one of them differently. That is exactly
 * the failure the rule was written against, so it is pinned against the SHIPPED table in
 * `mobileReadiness.test.ts` rather than only against an injected one.
 *
 * THIS BATCH EMPTIES NO SECTION, and that is worth saying because the previous two did.
 * Two of the four are nav destinations — `/expenses/all` in EXPENSE MANAGEMENT and
 * `/virtual-cards/statements` in VIRTUAL CARDS — and both sections keep phone-visible items
 * (`/expenses` and `/travel`; `/virtual-cards`, `/virtual-cards/requests` and
 * `/virtual-cards/transactions`). The other two are reachable by URL and from inside the
 * card surfaces, not from `SECTIONS`. `Sidebar.nav.test.ts`'s emptied-sections equality is
 * therefore unchanged at three; its hidden-destinations equality grows by the two nav rows.
 *
 * ─── P05'S TWO ROWS, AND THE ONE THAT IS `limited` FOR A REASON NOT ABOUT ITS PAGE ────
 *
 * `/expenses` and `/expenses/approvals`, both `limited`. The second is an ordinary ruling:
 * the approver queue rendered a ~920px desktop table inside a ~330px viewport until P05's
 * first commit gave it T03's card tree, and what it ships with is NAMED in
 * `docs/design/pwa.md`'s row rather than closed — bulk approve left unreachable, no card
 * kebab (a refusal, not a gap), and a user's own saved views cloaked along with the pill bar.
 *
 * `/expenses` IS THE ONE WORTH READING TWICE. The page itself needed no code change — T03
 * already shipped its phone mechanism — and two specialists measured it phone-complete. It
 * is `limited` anyway, and the reason is this table's matcher rather than a finding against
 * the route:
 *
 *   `/expenses/[reportId]` IS P06'S, IT IS UNASSESSED, AND IT INHERITS WHATEVER THIS ROW
 *   CARRIES. A key spelled `/expenses/[reportId]` would not help, and that is the finding
 *   that decided the ruling rather than a footnote to it: `dispositionFor` matches raw path
 *   strings, so such a key matches the literal string `/expenses/[reportId]` — which no
 *   browser ever requests — and never `/expenses/0199c7b4-…`, which every reader requests.
 *   Real report URLs would go on resolving through `/expenses`. So a `ready` here would not
 *   be a claim about `/expenses`; it would be an unmeasured `ready` asserted over a
 *   1,984-line three-pane workbench nobody has opened at 360px, which is exactly what the
 *   `ready`-owes-a-test rule above refuses.
 *
 * THE ASYMMETRY IS WHY `limited` IS THE SAFE HALF OF THE CHOICE. If P06's assessment agrees,
 * promoting this row is one word on evidence already written down in `docs/design/pwa.md`.
 * If it disagrees, a shipped `ready` could not be retracted surgically — this registry has
 * no way to demote the child alone — so the retraction would take P05's measured ruling with
 * it. P06 owns the promotion; do not take it early.
 *
 * `/expenses/all` KEEPS ITS `desktop`, and the longest-prefix rule is the whole reason the
 * new general key cannot swallow it. `/expenses/approvals` gets a key of its own rather than
 * inheriting one, because a ruling and an inherited answer are not the same claim — the same
 * argument the `limited` rows above are written down for. `mobileReadiness.test.ts` pins all
 * of it, and pins the INHERITED route by the `prefix` it resolves through rather than by its
 * disposition: `limited` is also `DEFAULT_DISPOSITION`, so a disposition-only assertion here
 * would be hollow from birth, in the exact way the `/dashboard` half of `reads the SHIPPED
 * table` was hollowed by P02.
 *
 * ─── P07'S TWO ROWS, AND THE TWO ROUTES BENEATH THEM THAT GET NO KEY ─────────────────────
 *
 * `/virtual-cards` and `/virtual-cards/requests` -> `ready`. They are the third and fourth
 * `ready` rows on a shelled `(app)` route, and they are the FIRST `ready` rows in this table
 * that sit above other routes. That is the fact a reader needs about them: `ready` is the
 * only disposition that makes a positive claim, and this is the first time one is inherited.
 *
 * Both rows carry the three things the `ready` paragraph above demands, and each of the three
 * is a FILE rather than an assertion: the mobile crawl walks both routes at 360, 390 and 412
 * (`e2e/crawl-mobile.spec.ts`, over the three projects in `e2e/support/phone-projects.ts`);
 * the primary flow is written in `e2e/virtual-cards.mobile.spec.ts` and
 * `e2e/virtual-card-requests.mobile.spec.ts`, both of which run EN and FR-CA; and both routes
 * have entries in `e2e/tap-targets.mobile.spec.ts` (control floors of 5 and 4).
 *
 * WHAT THAT IS NOT IS A GREEN RUN. None of those three files has been executed on the build
 * machine — there are no Playwright browsers on it and TLS blocks the download — so CI is the
 * gate and this row's `ready` rests on a suite nobody here has watched pass. It is also still
 * a RULING RATHER THAN A DEVICE PASS, exactly as `/profile`'s paragraph above says: no phone
 * has been near these screens and `docs/design/pwa.md`'s device cells are still `<pending>`.
 * "From P07" in that document carries both caveats in full.
 *
 * **`/virtual-cards/[cardId]` GETS NO KEY, AND THAT IS THE RULING RATHER THAN AN OMISSION
 * SOMEBODY SHOULD TIDY UP.** It resolves `ready` through `/virtual-cards` by the same
 * longest-prefix-on-a-segment-boundary match that lets `/admin/approval-workflows` rule the
 * graph editor beneath it, and it IS MEASURED, so that inherited `ready` is a claim somebody
 * made rather than one the matcher made for them: `e2e/virtual-cards.mobile.spec.ts` drives
 * it at every phone width in both locales and measures `main` AND the workbench's own
 * horizontal scroller (`ResizablePanels` carries `overflow-x-auto`, so a main-only
 * measurement is structurally blind to spill inside it), and `e2e/tap-targets.mobile.spec.ts`
 * gates it at a floor of 5. The crawl never sees this route — it walks STATIC routes only —
 * which is exactly why the spec had to. `mobileReadiness.test.ts` pins the resolution AND the
 * absence of the key, for the reason ADR-0005's D2 addendum gives: the edit this guards
 * against is a well-intentioned one.
 *
 * ─── P08'S ONE ROW, AND WHY A KEY HERE IS A RULING AND NOT THE FENCE P07 REFUSED ────────
 *
 * `/virtual-cards/transactions` → `limited`, and it is the SECOND static route P07's `ready`
 * reached without ruling. P07 was asked for a `limited` FENCE KEY on it — a key whose only
 * job was to stop a positive claim P07 never intended from reaching a route P07 never
 * examined — and refused it. That refusal was right and is not reversed here. A fence key
 * needs a ruled row to pair with or the parity check goes red, and P07 had no ruling to put
 * in one; the key it was offered would have written a disposition nobody had measured into
 * this route's own backlog entry.
 *
 * P08 OWNS THE ROUTE AND MEASURED IT, so the row this key pairs with carries a ruling rather
 * than a placeholder, and BOTH LAND IN ONE COMMIT. That pairing — registry key in,
 * Page-readiness row out of `unruled`, same commit — is the observable difference between a
 * ruling and a fence, and ADR-0005's D2 addendum for P08 states it as a rule rather than
 * leaving it to be re-derived. Do not read this key as P07's refusal being overturned; read
 * it as the condition that refusal was waiting on.
 *
 * WHAT IT IS RULED ON, each item a file rather than an assertion: the route is static, so
 * `e2e/crawl-mobile.spec.ts` walks it at 360, 390 and 412 for horizontal overflow and a clean
 * console; `e2e/virtual-card-transactions.mobile.spec.ts` drives four legs in EN and FR-CA
 * across the three phone projects — the route fits up every clipping ancestor, a cardholder
 * reads their own charges, a receipt attaches, and the reduced coding face is visible and
 * never empty; and `e2e/tap-targets.mobile.spec.ts` carries a bespoke lane for the charge
 * row's open affordance and the receipt attach control, TWO censuses rather than one because
 * the stacked panes are a screenful each.
 *
 * WHY `limited` AND NOT `ready`, which is the word it inherited: `ready` is defined above as
 * three things, and the third is the operator's, not this task's. No phone has been near
 * these screens — `docs/design/pwa.md`'s device cells for this route are `<pending>` — and
 * the reduced coding face below `lg` is a REDUCTION with named omissions rather than the
 * desktop flow made narrow. A route whose phone surface is deliberately smaller than its
 * desktop one is the definition of `limited` in the vocabulary above. The row in
 * `docs/design/pwa.md` enumerates what is omitted and what would move this to `ready`.
 *
 * ─── P11'S FIRST ROW: `/analytics` → `limited`, AND WHY NOT `desktop` ────────────────────
 *
 * `/analytics` — `limited`, P11, AND `desktop` WAS THE ALTERNATIVE AND IS REFUSED. The
 * refusal is an access-equity one rather than a matter of taste. `analytics.dashboard.view`
 * sits on `collectEmployeeBase` (`packages/rbac/src/systemRoles.ts:295-323`), and that
 * grant's own comment records why it stays after the card it was granted for was deleted:
 * `/analytics` "is now the only place that view lives" for an employee's own spend, for 907
 * of roughly 1,050 seeded users. So a `desktop` ruling would put a notice in front of the
 * ONLY phone-reachable view of their own spend that ~86% of seeded users have — to fix rough
 * edges that all live in the chart and filter layers. The Dashboard tab is the tab the route
 * opens on, and its KPI-card layer is usable at 360. The trade `desktop` makes is therefore
 * "some numbers need a tap, a scroll or an export to read exactly" for "no numbers at all
 * without an explicit opt-through", and that is disproportionate.
 *
 * THE CASE AGAINST THIS ROW, STATED AND ANSWERED: the ruling is cosmetic in BOTH directions
 * (`DesktopOnlyNotice.tsx:52-55`, and "THE GATE IS COSMETIC" at the top of this file) —
 * server RBAC is untouched and "Continue anyway" always works — so `desktop` would be a wall
 * in front of the path and not a lockout, which is a real weakening of the argument above.
 * It is still refused, on `/dashboard`'s asymmetry: a wrong `limited` costs one revisit,
 * while a wrong `desktop` retires the route from the follow-up list while a reader still
 * cannot read their own spend on a phone. The cheaper mistake is the one to make.
 *
 * THE ROUGH EDGES ARE THREE, NOT FOUR. `ux-ui-designer` named four; phase 3's
 * transaction-table card opt-in closed one of them (the off-screen `amount` column) before
 * this row was written, so it is not in the inventory and must not be added back:
 *
 *   · THE DASHBOARD CHARTS CARRY NO ON-SCREEN, HOVER-FREE EXACT VALUE. All five — the
 *     monthly-trend line and the four breakdowns (category, department, business unit,
 *     employee) — put their figures in the recharts `<Tooltip>`
 *     (`AnalyticsDashboard.tsx:792,814,830,846,872`) and nowhere else inside the card. "Hover is the only way to read a value" would be FALSE as
 *     stated — `ExportMenu` → CSV / Excel / PDF (`:656-692`) carries every one of these
 *     breakdowns as exact numbers. Hover is the only INLINE, ON-SCREEN way, and that is the
 *     version this row claims.
 *   · `PeriodAnalysis` FORCES EVERY CATEGORY LABEL ONTO THE X-AXIS. `CategoryChart` sets
 *     `interval={0}` with `angle={-20}` and `fontSize={10}` (`PeriodAnalysis.tsx:345-350`)
 *     over up to ten categories, so labels plausibly collide at 360-412. Backstopped rather
 *     than fatal: `CategoryTable` prints the same values and does not depend on the chart
 *     rendering legibly.
 *   · THE FILTER BAR IS TWO CONTROL HEIGHTS, NOT ONE, AND BOTH ARE UNDER 44. The bar
 *     (`AnalyticsDashboard.tsx:413-483`) is a `flex flex-wrap` row; both call sites pass
 *     `h-8`, and only one of them wins. `Input`'s base is `h-10`, a HEIGHT, so `h-8`
 *     overrides it and the two date fields predict 32px. `MultiSelectDropdown`'s trigger is
 *     `min-h-10` (`packages/design-system/src/components/forms/MultiSelectDropdown.tsx:57`),
 *     and `min-height` and `height` are DIFFERENT tailwind-merge groups, so `h-8` does not
 *     override it and the dimension dropdowns predict 40px. The bar predicts a multi-row
 *     stack at all three phone widths. It carries EIGHT dropdowns on the Dashboard tab and
 *     seven elsewhere — `months` is filtered out off-dashboard (`:439`) — so "seven
 *     controls" is wrong for the tab the route opens on.
 *
 * NOTHING ON THIS ROUTE HAS BEEN MEASURED IN A BROWSER, AND NOTHING IN THIS ROW MAY BE READ
 * AS IF IT HAD. Every figure above is DERIVED FROM SOURCE — from the class strings, from a
 * tailwind-merge result run against this repo's own copy, from the recharts props — and not
 * from a run. Where P10's rows cite measurements ("127px over at 360"), this one cites none,
 * because there are none: `e2e/analytics.mobile.spec.ts` was written and typechecked in the
 * phase before this one and has NOT yet been run. Its first run's annotations are where this
 * route's geometry comes from; the predictions above are predictions, and whoever runs it
 * should replace them with what it reports rather than confirm them from this paragraph.
 *
 * Also do not go looking for the widths in `BudgetChart.tsx` when reading this row: that
 * component is not on this route — it lives under `(app)/budgets/`, and this route's budget
 * TAB renders `BudgetVsActual`. The axis widths that belong to `/analytics` are `70` ×4 and
 * `120` (employee) on the Dashboard tab, `70` on Period (`PeriodAnalysis.tsx:352`) and `84`
 * in `BudgetVsActual.tsx:256`.
 *
 * THE INVENTORY IS HELD RATHER THAN ASSERTED, which is what makes this row different from a
 * paragraph of prose about a page. `e2e/analytics.mobile.spec.ts` drives all three tabs,
 * measures every `ResponsiveContainer`, contains the card list three ways, and pins these
 * three edges as CHARACTERIZATIONS in its `PinnedEdge` shape (PIN-A, PIN-B, PIN-C). A pin
 * reddens in both directions, so CLOSING one of these edges reddens that file and forces
 * this row to move in the same change. An inventory that lives only in markdown is an
 * assertion nothing holds; this one is held. That file's `tables === 0` assertion is also
 * the only thing in the repository that would catch phase 3's card opt-in going inert.
 *
 * ─── P11'S SECOND ROW: `/budgets` → `limited`, AND WHY NOT `ready` ──────────────────────
 *
 * `/budgets` is the FIRST row in this table written from a measured run rather than from a
 * reading, and the triad `ready` is defined by — mobile crawl green at 360/390/412, the
 * primary flow completing in the route's own spec, tap targets passing — MECHANICALLY HOLDS
 * for it. It is still `limited`, and the reason the operator refused `ready` is that one leg
 * of that triad passed BY NOT LOOKING.
 *
 * THE TAP-TARGET LEG IS STRUCTURALLY BLIND TO THIS ROUTE'S EDIT DRAWER. The create/edit
 * drawer (`budgets/BudgetsPage.tsx`) is built out of the design system's base `Input`, which
 * is `h-10` — 40px, 4px under the 44px floor — and carries no `einc-tap-slop`
 * (`packages/design-system/src/components/ui/input.tsx:31`). `e2e/tap-targets.mobile.spec.ts`
 * derives `floored` from a control's `::after` pseudo-element
 * (`e2e/support/tap-targets.ts:606-609`), so a control with no `::after` reports
 * `floored.vertical === false` and the floor lane SKIPS it rather than failing it. Fourteen
 * `Input` controls sit in that drawer — the twelve-month `grid-cols-4` grid, the spread-total
 * field and the notes field, plus one percent field per alert threshold — and
 * `e2e/budgets.mobile.spec.ts` measured the twelve month fields at 40px in all three phone
 * projects. `ux-ui-designer` named VIEW + EDIT as this route's primary flow, so those
 * controls are inside the primary flow, and the gate that is supposed to guard the floor
 * cannot see any of them.
 *
 * SO THE SHORTFALL IS APP-WIDE AND T04 OWNS IT, which is the other half of why this row is
 * `limited` rather than a defect filed against `/budgets`. Nothing this route can do closes
 * it: the height is the primitive's, every consumer inherits it, and asserting 44 here would
 * report a design-system gap as a `/budgets` regression. `e2e/budgets.mobile.spec.ts` pins it
 * at the SHORTFALL instead — green means measured and still short — so the day the primitive
 * reaches 44 that pin reddens and this row moves with it.
 *
 * WHAT THE CARD OPT-IN DID ACHIEVE, SAID IN THE SAME BREATH, because a reader must not take
 * this row for "the opt-in fell short". THE LIST SURFACE IS COMPLETE. Phase 2's
 * `mobile={{ title, subtitle, fields, rowActions }}` opt-in (`BudgetsPage.tsx:615`) mounts
 * T03's card tree and retires the table tree — witnessed directly, cards present and
 * `tables === 0` — the list contains itself three ways (`main#main-content`, the list's own
 * scroller, and no card painting outside it), the view→edit flow completes with the saved
 * change READ BACK FROM THE DATABASE rather than inferred from a drawer closing, and the
 * card's row-actions kebab reaches 44 × 44 ON ITS OWN PAINTED BOX (`triggerSize="touch"` →
 * `RowActionsMenu.tsx:65`'s `h-11 w-11`). That last one is asserted as a DIRECT BOX
 * MEASUREMENT and not through the floor lane, for exactly the blindness described above: the
 * opt-in fixed the product and left the gate just as blind, so a floor-lane enrolment would
 * have skipped the fixed control as readily as it skips the short ones. All of it is green at
 * 360, 390 and 412. `/budgets` is `limited` because of the EDIT half, not the list half. */
export const MOBILE_READINESS: DispositionTable = Object.freeze({
  '/admin/roles': 'desktop',
  '/login': 'ready',
  '/enroll-mfa': 'ready',
  '/change-password': 'ready',
  '/reset-password': 'ready',
  '/notifications': 'ready',
  '/dashboard': 'ready',
  '/delegations': 'limited',
  '/travel': 'limited',
  '/profile': 'ready',
  '/users': 'desktop',
  '/admin/approval-workflows': 'desktop',
  '/admin/api-keys': 'desktop',
  '/admin/audit-trail': 'desktop',
  '/admin/authentication': 'desktop',
  '/admin/business-units': 'desktop',
  '/admin/control-evaluation': 'desktop',
  '/admin/departments': 'desktop',
  '/admin/expense-categories': 'desktop',
  '/admin/fiscal-years': 'desktop',
  '/admin/fraud-detection': 'desktop',
  '/admin/fx-rates': 'desktop',
  '/admin/integrations': 'desktop',
  '/admin/job-levels': 'desktop',
  '/admin/legal-entities': 'desktop',
  '/admin/mileage-rates': 'desktop',
  '/admin/modules': 'desktop',
  '/admin/notification-templates': 'desktop',
  '/admin/per-diem-rates': 'desktop',
  '/admin/platform': 'desktop',
  '/admin/policies': 'desktop',
  '/admin/policy-rules': 'desktop',
  '/admin/policy-violations': 'desktop',
  '/admin/travel-categories': 'desktop',
  // VeloExpense: VeloExpense's own screens, ruled here as each is found not to fit a phone.
  // `/admin/compliance` (phone e2e 3): a dense findings table (860px) and a header whose actions
  // the kit's `PageHeader` will not let shrink — 57px past a 360 viewport. Ruled `desktop`, as
  // ExpenseOS rules its dense `/admin/*` tables; the `PageHeader` half is a lib-ui-kit fix.
  '/admin/compliance': 'desktop',
  // The module-gated routes: P10's eleven, plus `/ledger/expense-categories`, added
  // 2026-09-24 with its page (netsuite-report-expense-category), and `/ledger/tax-groups`,
  // added 2026-09-29 with its page (netsuite-tax-group-rates), on the same ruling and for
  // the same reason as their sibling reference caches. Grouped rather than merged into the
  // alphabetical block above because "module-gated" is the fact a reader needs about them —
  // the ruling is recorded and not gate-verified, per the header. Alphabetical within the
  // group.
  '/admin/assistant-feedback': 'desktop',
  '/ledger/business-units': 'desktop',
  '/ledger/classes': 'desktop',
  '/ledger/departments': 'desktop',
  '/ledger/expense-categories': 'desktop',
  '/ledger/gl-accounts': 'desktop',
  '/ledger/locations': 'desktop',
  '/ledger/posting': 'desktop',
  '/ledger/people': 'desktop',
  '/ledger/settings': 'desktop',
  '/ledger/subsidiaries': 'desktop',
  '/ledger/sync': 'desktop',
  '/ledger/tax-groups': 'desktop',
  '/ledger/vendors': 'desktop',
  // P10's last four. Grouped rather than merged into the alphabetical block above because
  // they are the only rows in this table that live under neither `/admin` nor `/netsuite`,
  // and because two of them are the segment-boundary pair the matcher's `-`-vs-`/` rule
  // exists for. Alphabetical within the group. See the header note above.
  '/expenses/all': 'desktop',
  '/virtual-cards/import': 'desktop',
  '/virtual-cards/import-cards': 'desktop',
  '/virtual-cards/statements': 'desktop',
  // P05's two and P06's one. A group of their own for the same reason P10's last four are
  // one: they live under neither `/admin` nor `/netsuite`. All three are `limited`, and
  // `/expenses` is `limited` for a STRUCTURAL reason rather than a finding against the page
  // — see the header note above. `/expenses/all` above keeps its own longer key and is
  // untouched by these three.
  '/expenses': 'limited',
  '/expenses/approvals': 'limited',
  /**
   * P06's ruling on the expense-report workbench, and the only key in this table with a
   * dynamic segment. Written with the literal `[reportId]` segment because that is the one
   * string both halves of the parity gate admit: the Page-readiness row in
   * `docs/design/pwa.md` names the route that way.
   *
   * THIS KEY IS INERT AT RUNTIME, AND THAT IS PRECISELY WHY THE VALUE IS `limited`.
   * `dispositionFor` matches literal path text and no real URL contains a `[`, so no
   * `/expenses/<uuid>` ever reaches this row. What answers for those URLs is `/expenses`
   * above — P05's key, by longest prefix, reporting `prefix: '/expenses'`. A `ready` here
   * would make this file declare one thing in its table and answer another to every caller
   * that asks; `limited` is the only value that leaves it telling the truth.
   *
   * THE TWO ROWS AGREE, AND THAT AGREEMENT IS THE POINT. P06 shipped first and asked P05
   * for it in as many words (`docs/design/pwa.md`, this route's Page-readiness row): a
   * `desktop` ruling on `/expenses` would have mounted `DesktopOnlyNotice` over a report a
   * submitter can in fact submit. P05 ruled `limited`, which is the word this row carries,
   * so the inherited answer and the documented ruling are the same claim. KEEP THEM IN
   * STEP — promoting either row alone re-opens exactly the gap this note closes.
   *
   * The route is genuinely assessed, not unlooked-at — `docs/design/pwa.md`, "What P06
   * assessed — the workbench on a phone", records what the phone path does and what it
   * suppresses.
   *
   * Teaching the matcher dynamic segments is P17 (lane A): an ADR-0005 D2 change with
   * eleven tasks' blast radius. Do not do it from a page task. Until it lands, this key
   * records a ruling and changes no lookup's answer.
   */
  '/expenses/[reportId]': 'limited',
  // P07's two. Grouped rather than merged above because they are the first `ready` rows that
  // sit ABOVE other routes: `/virtual-cards/[cardId]` inherits `ready` from the first key
  // here and deliberately carries none of its own, while the three `desktop` rows just above
  // are more specific paths under the same parent and keep their own rulings by longest
  // prefix. `/virtual-cards/transactions` inherited that `ready` too until P08 ruled it, one
  // key below. See the header note and ADR-0005's D2 addenda for P07 and P08.
  '/virtual-cards': 'ready',
  '/virtual-cards/requests': 'ready',

  // P11's two rows, grouped on their own because they are ruled from different evidence and
  // a reader should not take one for the other — see the two P11 sections in the header.
  // `/analytics` is the only row in this table ruled from source reading; `/budgets` is the
  // first ruled from a measured run, and is `limited` for the edit drawer rather than for
  // the list the card opt-in fixed.
  '/analytics': 'limited',
  '/budgets': 'limited',
  /**
   * P08's ruling on the charges list, and THE FIRST KEY IN THIS TABLE THAT CHANGES WHAT A
   * LOOKUP ANSWERS. Read that before reading anything else about it, because every other
   * `limited` row in this table is inert and this one is not.
   *
   *   `dispositionFor('/virtual-cards/transactions')` answered
   *   `{ disposition: 'ready', prefix: '/virtual-cards' }` before this commit and answers
   *   `{ disposition: 'limited', prefix: '/virtual-cards/transactions' }` after it.
   *
   * `/expenses`, `/expenses/[reportId]` and the rest are written down while
   * resolving to `DEFAULT_DISPOSITION` either way — their rows record a claim and move no
   * answer. This row does move one: it REDUCES an inherited positive claim. P07's `ready` on
   * the parent reached this route by longest prefix without P07 having examined it, and this
   * key is the ruling that replaces the inherited word with a measured one.
   *
   * IT STILL RENDERS NOTHING DIFFERENTLY, and the two facts are not in tension. No consumer
   * distinguishes `ready` from `limited`: `DesktopOnlyNotice` branches on `desktop`,
   * `Sidebar`'s `phoneHiddenRoutes` filters on `desktop`, and the phone suite's only
   * disposition branch is `expectedClassificationFor` (`e2e/support/mobile-census.ts:230`).
   * So the ANSWER changes and no BEHAVIOUR does — which is why `mobileReadiness.test.ts`
   * pins the full `{ disposition, prefix }` pair against the shipped table. A
   * disposition-only assertion would be satisfied by the absence of this key, since
   * `limited` is also `DEFAULT_DISPOSITION`; only `prefix` tells a measured ruling apart
   * from an unlisted route. ADR-0005's D2 addendum for P08 makes that mandatory.
   *
   * KEEP THIS ROW AND ITS PAGE-READINESS ROW IN STEP. They landed in one commit on purpose —
   * that pairing is what makes this a ruling rather than the fence P07 refused — and the
   * parity check in `mobileReadiness.test.ts` goes red in both directions if either moves
   * without the other.
   */
  '/virtual-cards/transactions': 'limited',
});

/** The result of a lookup: what the route is, and WHICH key said so. */
export interface DispositionMatch {
  disposition: Disposition;
  /**
   * The registry key that matched, normalized, or `null` for an unlisted route.
   *
   * The caller needs this and not just the disposition: `DesktopOnlyNotice` persists a
   * reader's "Continue anyway" against the MATCHED PREFIX, so continuing past
   * `/admin/roles` also covers `/admin/roles/anything` — one decision about one feature,
   * rather than the same notice again on the next click.
   */
  prefix: string | null;
}

/** The locale segments the router strips. Sourced, not transcribed — see `normalizePath`. */
const LOCALE_SEGMENTS: ReadonlySet<string> = new Set<string>(SUPPORTED_LOCALES);

/**
 * A path as this table understands it: leading `/`, no locale segment, no trailing `/`, no
 * query and no hash.
 *
 * LOCALE STRIPPING IS DEFENSIVE, NOT DECORATIVE. `usePathname` from `@/i18n/navigation`
 * already hands back a locale-free path, so on the app's own call sites this is a no-op. It
 * is here for the two callers that are not that: a test naming a real URL, and any future
 * caller reading `window.location.pathname` — for which an unstripped `/en/admin/roles`
 * resolves to `limited` and the notice silently never shows. Sourced from
 * `SUPPORTED_LOCALES` rather than a literal `['en','fr-CA']` so adding a locale does not
 * leave a third place to remember.
 */
export function normalizePath(path: string): string {
  const withoutQuery = path.split(/[?#]/, 1)[0] ?? '';
  const segments = withoutQuery.split('/').filter(Boolean);
  if (segments.length > 0 && LOCALE_SEGMENTS.has(segments[0] as string)) segments.shift();
  return segments.length === 0 ? '/' : `/${segments.join('/')}`;
}

/**
 * Resolve one path against the table.
 *
 * `table` IS INJECTABLE, AND THAT IS A REQUIREMENT RATHER THAN A STYLE PREFERENCE. The
 * shipped table has forty-five rows as of P10's last batch. Every test of the MATCHER —
 * longest-prefix, segment boundaries, locale stripping — needs routes it controls, or it is
 * really a test of whatever the registry happens to contain this week, going red on an
 * unrelated page task's commit. It is what lets `Sidebar.nav.test.ts` exercise the nav
 * filter without depending on the shipped contents at all.
 */
export function dispositionFor(
  path: string,
  table: DispositionTable = MOBILE_READINESS,
): DispositionMatch {
  const target = normalizePath(path);
  let best: string | null = null;

  for (const rawKey of Object.keys(table)) {
    const key = normalizePath(rawKey);
    // Exact, or a prefix that ends on a segment boundary. `/travel` must not claim
    // `/travel-agency`; a bare `startsWith` does, and does it silently.
    const matches = target === key || (key === '/' ? true : target.startsWith(`${key}/`));
    if (!matches) continue;
    if (best === null || key.length > best.length) best = key;
  }

  if (best === null) return { disposition: DEFAULT_DISPOSITION, prefix: null };
  // Non-null by construction: `best` is a normalized key, and every key normalizes to
  // itself in a well-formed table (`mobileReadiness.test.ts` asserts that of the shipped
  // one). An injected table with a denormalized key still resolves — the lookup is done
  // against the raw keys below.
  const raw = Object.keys(table).find((k) => normalizePath(k) === best) as string;
  return { disposition: table[raw] as Disposition, prefix: best };
}
