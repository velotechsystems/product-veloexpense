import { Card, IdentityBanner, initialsFromDisplayName } from '@expenseos/design-system';
import { getTranslations } from 'next-intl/server';
import { PanelBoundary } from '@/components/PanelBoundary';
// VeloExpense: Next's own `Link` — VeloExpense's `@/i18n/navigation` is one module that
// also exports the client hooks, so a server component cannot import it; URLs carry no
// locale here, so the two are the same link.
import Link from 'next/link';
import { pageTitle } from '@/lib/i18n/page-title';
import { shellContext } from '@/server/shell';
import { MyExpenseReportsCard } from './cards/MyExpenseReportsCard';
import { MyTravelRequestsCard } from './cards/MyTravelRequestsCard';
import { ReportsToApproveCard } from './cards/ReportsToApproveCard';
import { IdentityChips } from './IdentityChips';
import { SmallScreenNotice } from './SmallScreenNotice';
import { selectDashboardCards } from './selectDashboardCards';
import { SetupChecklist } from './SetupChecklist';

// VeloExpense: UD-16 — every route names itself (scripts/check-page-titles.mjs).
export function generateMetadata() {
  return pageTitle('title.dashboard');
}

/**
 * The home page.
 *
 * It said "Your dashboard is coming soon. Use the sidebar to navigate." — the first screen
 * every user saw after signing in, at GA (GA readiness report F02).
 *
 * THE PAGE COMPOSES SIBLINGS. It resolves the two things only a server can know — who the
 * reader is and what their workspace has installed — and then hands each panel its own
 * space and its own boundary. It does not fetch panel data itself: every query on this
 * screen belongs to the panel that renders its result, so a panel's data is a panel's
 * mock, and no fetch here can fail above a boundary.
 *
 * READING ORDER, top to bottom: identity → what needs me → my things. Decreasing
 * actionability, and it ends there — the tile pair and the personal spend card that used
 * to close the page are gone, superseded by the three previews below, which say the same
 * things in the reader's own records rather than as a number with no row behind it.
 * Retiring them also took the product's only unbounded, undated spend scan
 * (`analytics.dashboard({})` → an `expense.findMany` with no `take` and no date bound,
 * plus every row of `FxRate`) off the post-login path for every user on every sign-in.
 * That is the SPEND scan, and the claim stops there: `expenses.list` — mounted below —
 * still reaches an untaken `fxRate.findMany` through `readerTotalsFor` to convert report
 * totals into the reader's currency. One such read on this path, not none, and not the two
 * there were before `expenseApprovals.myTasks` shed its unread rollup.
 *
 * NO `dashboard/error.tsx`. A route boundary would catch the same errors at the same
 * granularity as `(app)/error.tsx` already does — the whole page — and buy no containment
 * at all. Containment is per-panel, so it is `<PanelBoundary>`, inside the page. An
 * unreachable second error page is an untested liability that rots.
 *
 * Ported from ExpenseOS (550b2945) in place of VeloExpense's home page (w4-09, d72).
 * VeloExpense, each marked below: the session, `RbacUser`, active modules and
 * `canSeeOthers` come from the request's shell context (server/shell.ts), which has resolved
 * them all; the face has no photo (VeloExpense keeps none) and the band's link is
 * VeloExpense's `/preferences` (ExpenseOS's `/profile`); VeloExpense's setup checklist sits
 * above the cards (`SetupChecklist`, d72); the travel card since w6-02.
 */
export default async function DashboardPage({
  searchParams,
}: {
  // VeloExpense: the checklist's Hide / Show form reports a refusal as `?error=`.
  searchParams: Promise<{ error?: string }>;
}) {
  const shell = await shellContext();
  if (!shell) return null;
  // VeloExpense: ExpenseOS's `session.user`, from the shell.
  const session = { user: shell.user };
  const { error } = await searchParams;

  const tNav = await getTranslations('nav.items');

  /**
   * The `h1`'s text, resolved from the SESSION and from nothing else.
   *
   * WHY NOT THE FRESH PROFILE, WHICH `IdentityChips` IS ALREADY FETCHING. Because this
   * heading sits above every boundary on the page, and a value fetched above every
   * boundary is a value whose failure has nowhere to land except `(app)/error.tsx` — the
   * whole page. `qa-engineer` put the invariant the other way round and it is the same
   * statement: "either the `h1` renders in `page.tsx` outside every boundary … or 'the
   * dashboard keeps exactly one `h1` and it is the user's name' is a hope rather than an
   * invariant". `auth()` has already resolved by the time this line runs, so there is no
   * failure mode left to contain.
   *
   * THE COST, WHICH IS THE AVATAR AND NOT THE NAME. `token.name` is recomposed from
   * `firstName` + `lastName` on EVERY jwt refresh (`auth.ts:663`, in the `else if
   * (token.email)` branch that runs per request), so a name corrected in the directory
   * surfaces here without a re-login. `token.picture` is not: it is set once at sign-in
   * (`auth.ts:595`) and the refresh branch does not even select `avatarUrl`. So a reader
   * who uploads a photo keeps the old face — or none — on this band until they sign in
   * again. That is the accepted cost, it has its own follow-up ticket, and it is NOT
   * fixed here: refreshing `picture` in the callback changes every avatar in the product,
   * which is not a change that should ride in on a dashboard header.
   */
  const name = session.user.name || session.user.email || '';
  const initials = initialsFromDisplayName(name, session.user.email ?? '');
  // VeloExpense: no profile photos; the band draws the initials.
  const avatarUrl: string | null = null;

  /**
   * Visibility, never reachability.
   *
   * `activeModuleSlugs` returns a set. It is emphatically NOT `requireActiveModule`, which
   * is `if (!(await isModuleActive(db, slug))) notFound()` — calling that here for `travel`
   * would 404 the entire post-login landing page for every workspace that has not
   * installed travel. The predicates themselves live in `selectDashboardCards`, pure and
   * exhaustively tested, because the module-off branches are unreachable from Playwright.
   *
   * `resolveRbacUser` goes through the Redis cache like every other caller. The 300s
   * staleness window is accepted here on purpose: a card that lingers for five minutes
   * after a role change is a cosmetic wrong, and the server re-checks on the way in.
   */
  // VeloExpense: resolved once per request by the shell, not here.
  const { rbac, activeModules } = shell;
  const cards = selectDashboardCards({ activeModules, permissions: rbac.permissions });

  /**
   * The third gate the small-screen notice needs, and the only one this page did not already
   * hold. It is `(app)/layout.tsx`'s own derivation, shared rather than copied: `cache()` makes
   * a COLD load of this route run the underlying indexed count ONCE for the layout and the page
   * together, so the notice adds no query to the post-login path. See `../canSeeOthers`.
   *
   * THE DEDUPE IS PER-REQUEST, SO IT DOES NOT COVER A CLIENT-SIDE NAVIGATION, and the sentence
   * above should not be read as "free everywhere". Arriving here from a sidebar tap, the App
   * Router reuses the already-rendered `(app)` layout segment and re-renders only this page —
   * there is no layout call in that pass for `cache()` to dedupe against, so this resolves to
   * one `db.user.count` the route did not previously pay. It is a single indexed count and it
   * is not worth engineering away; it is written down because the line above, read alone,
   * claims a guarantee that only holds on the cold path.
   *
   * It is resolved properly rather than passed as `false` because `/users` is `desktop`-ruled
   * and carries no `requires` — for a reader with no admin, audit, config, NetSuite or AP
   * permission it is the ONLY destination they lose below `lg`, so `false` would silently
   * withhold the notice from every manager with reports while their sidebar told them, one
   * screen away, that something WAS hidden. And `true` would be the D7 violation outright:
   * every employee without reports would be told they are missing a page they were never
   * entitled to.
   */
  // VeloExpense: the shell's, as the sidebar reads it.
  const { canSeeOthers } = shell;

  return (
    // The three `data-dashboard-*` attributes publish the server's gating decision to the
    // DOM. They outlive the cards that read them: an E2E assertion on card copy proves
    // the card rendered, while these prove the DECISION was the server's — including the
    // negative case, where there is no card to find and "absent" and "not yet loaded"
    // otherwise look identical.
    <div
      className="flex flex-col gap-4"
      data-dashboard-travel={String(cards.showTravel)}
      data-dashboard-approvals={String(cards.showApprovals)}
      data-dashboard-expenses={String(cards.showExpenses)}
    >
      {/* ── Small-screen signpost ────────────────────────────────
          ABOVE THE IDENTITY BAND AND ABOVE EVERY CARD, because it is a claim about this whole
          screen and the one below it: a reader who meets it after three previews has already
          formed the impression it exists to correct. It renders only below `lg` (`lg:hidden`,
          inside the component) and only for a reader who ACTUALLY loses nav destinations there
          — ADR-0005 D7. For an ordinary employee the predicate is false and this is nothing at
          all, which is the intended outcome rather than a gap.

          It is a CLIENT component mounted from this server page, and that is not a style
          choice: the predicate lives in `Sidebar.tsx`, which is `'use client'`, so calling it
          from here would hit React's client-reference proxy and throw on every request. The
          component's own header has the detail. Nothing is fetched for it — all three props are
          values this page had already resolved. */}
      <SmallScreenNotice rbac={rbac} canSeeOthers={canSeeOthers} activeModules={activeModules} />

      {/* ── Identity ─────────────────────────────────────────────
          The band the reader lands on, and the one `h1` inside `<main>`.

          THE CONSTRAINT IS "ONE `h1` INSIDE `<main>`, AND IT IS THE READER'S NAME" — NOT
          "one `h1` on the page", which this route has never satisfied and does not satisfy
          now. `TopBar.tsx:121` renders `{left ?? <h1>{title}</h1>}` for every `(app)`
          route and this page pushes no `left` slot, so "Dashboard" has preceded whatever
          the page's own first heading was since the top bar shipped. The greeting that
          used to sit here was the SECOND `h1` in the document, not the first, and the
          claim this comment previously made — that the only heading a screen reader found
          after sign-in belonged to the tile section that used to close this page — was
          false when it was written.
          Both existing e2e assertions passed because they matched by accessible name;
          nothing in the repo counted `h1`s.

          The outline is therefore two landmarks deep and that is the correct shape: the
          top bar's `h1` is in `<header>`, this one is in `<main id="main-content">`
          (`AppShell.tsx:130`, the skip link's target at `:95`). Demoting this heading to
          `h2` to make the document singular would assert that the reader's name is a
          SUBSECTION of the top bar, which it is not — the top bar is not even inside
          `<main>`. The heading outline describes the content's structure, not the chrome's
          position. AND, said plainly because the record deserves it: no WCAG 2.2 success
          criterion caps a document at one `h1`, the HTML spec permits one per sectioning
          root, and this document has two landmarks. This is a best-practice preference,
          not a conformance failure.

          THE BAND IS PAGE-OWNED CHROME AND SITS OUTSIDE EVERY BOUNDARY. The navy region,
          the face and the heading all render from the session, which has already resolved,
          so the band can never draw half-finished and no panel failure can leave `<main>`
          with zero headings. Only the chips are fetched, and they are the only thing under
          a boundary here.

          `border-white/40` ON THE ACTION, NEVER `/20`. The origin file (`my-info/page.tsx`,
          since deleted) had `/20`, which measures 1.88:1 against `--color-brand-navy` and
          fails SC 1.4.11's 3:1 for a non-text control boundary. `/40` is 3.66:1. The file is
          gone, but the value survives it in git history and in the design mockups — copying
          `/20` back from either silently undoes the fix.

          No `alt` for the face: `IdentityBanner` hides the avatar subtree from the
          accessibility tree itself, because the name is printed as a heading immediately
          beside it. No `statusBadge`: see `IdentityChips`.

          `einc-tap-slop` ON THE ACTION, AND IT IS ENROLMENT RATHER THAN DECORATION. The
          control is `px-3 py-1.5 text-xs`, which computes to 30px tall — 14px under WCAG
          2.2 SC 2.5.5's 44px and under the Apple HIG minimum. The part worth writing down
          is why no gate said so: a control that declares NO slop class has no `::after`,
          so `e2e/tap-targets.mobile.spec.ts` reads `floored.vertical === false`, the floor
          lane skips it entirely and the negative-probe lane merely confirms it reaches
          nowhere. It shipped a 30px target with every assertion in that file green about
          it. Adding the class is what puts it in the census; the 44px claim is then
          measured off the rendered pseudo-element there rather than asserted here.

          VERTICAL ONLY (`einc-tap-slop`, never `-both`), which is the recipe's ruling in
          `packages/design-system/src/globals.css` and not a preference: horizontal slop
          overflows sideways and, painting above its neighbour, wins that neighbour's tap.
          The neighbour here is the `min-w-0 flex-1` name column `IdentityBanner` relies on
          to wrap rather than overflow — the one box on this band that must not have a hit
          region laid over it. `-both` would buy nothing anyway: this control is already
          wider than 44px, and the recipe's `min-width` resolves to `max(control, 44px)`.
          Neither variant paints a pixel — the whole recipe sits inside
          `@media (pointer: coarse)`, so with a mouse this element is untouched.

          The slop overflows the control by 7px a side, and an ancestor clipping overflow
          clips the extra hit area with it — the `overflow-hidden` on the `Card` below is
          the one to watch. It does not bite here: the band's own `pt-7` puts 28px above
          this `self-start` control before the card's edge is reached. */}
      <Card className="overflow-hidden p-0">
        <IdentityBanner
          nameAs="h1"
          name={name}
          initials={initials}
          avatarUrl={avatarUrl}
          action={
            <Link
              // VeloExpense: ExpenseOS's `/profile` is VeloExpense's `/preferences`.
              href="/preferences"
              className="einc-tap-slop rounded-md border border-white/40 px-3 py-1.5 font-semibold text-white text-xs transition hover:bg-white/10"
            >
              {tNav('myProfile')}
            </Link>
          }
        >
          {/* An async server component passed as a child element, not awaited inline
              above: the page's own render does not wait on the profile fetch, and the
              chips catch their own failure besides. The boundary is the backstop under
              that catch, and `fallback={null}` is deliberate — the standard error face is
              a bordered box with a page-reloading Retry button, which is the wrong
              picture inside a navy band and the wrong offer for a department label. */}
          <PanelBoundary fallback={null}>
            <IdentityChips />
          </PanelBoundary>
        </IdentityBanner>
      </Card>

      {/* VeloExpense (d72): VeloExpense's setup checklist, above ExpenseOS's cards — it renders
          only for an admin while setup has steps left, and nothing otherwise. Under its own
          boundary like every fetching panel here, so a failed setup read cannot take the
          band or the cards with it. */}
      <PanelBoundary>
        <SetupChecklist error={error} />
      </PanelBoundary>

      {/* ── What needs me ────────────────────────────────────────
          First, above the reader's own things, because it is the only panel on the page
          holding work that OTHER people are waiting on.

          Gated on `showApprovals` — `P.expense.report.approve` AND the expense-management
          module — which is DELIBERATELY NARROWER than `/expenses/approvals` itself, where
          `reimburse` and `readAll` also get in. A reimburse-only AP clerk keeps the inbox
          and gets no card, because the card is about work waiting on *your decision*. Do
          not widen it to match the page. Deciding it on the server is what makes the gate
          more than cosmetic: a reader who fails it is never sent the queue's rows at all.

          Unlike travel, this card would not paint an error panel if it were mounted
          ungated — `myTasks` returns an empty queue rather than throwing. It is gated
          anyway, because an empty approvals card shown to somebody who cannot approve
          anything tells them they are caught up on a job they do not have. */}
      {cards.showApprovals && (
        <PanelBoundary>
          <ReportsToApproveCard />
        </PanelBoundary>
      )}

      {/* ── My things ────────────────────────────────────────────
          Gated on `showExpenses` — the expense-management module AND
          `P.expense.report.readOwn` — where the two halves guard two DIFFERENT failures,
          neither of which the other prevents:

            · `/expenses` opens with `requireActiveModule`, which is `notFound()`. With the
              module switched off, every row's link and the "View all" footer are 404s.
            · `expenses.list` — the card's only query since its header badge came off —
              is `withPermission(readOwn)`, and that middleware THROWS rather than
              returning empty. A role authored without `readOwn` gets
              `common.panelUnavailable` with a Retry that cannot succeed — here, on the
              first screen after sign-in.

          This card was previously mounted ungated, under a comment claiming
          `selectDashboardCards` gates only the cards whose destinations can 404. That was
          wrong twice over: this card's destination can 404 too, and a 404 was never the
          only way a card breaks. Deciding it on the server means a reader who fails either
          half is never sent the card's rows at all. */}
      {cards.showExpenses && (
        <PanelBoundary>
          <MyExpenseReportsCard />
        </PanelBoundary>
      )}

      {/* The travel card IS gated, on both halves of `showTravel` — module active AND a
          travel permission. Not because its rows would leak anything (every travel
          procedure re-authorizes, and `listOwn` is narrowed to `submitterId`), but
          because those procedures sit behind `moduleActive('travel')`, which THROWS
          rather than returning empty: mounted on a travel-off workspace the card would
          paint an error panel on the first screen after sign-in. The gate is decided on
          the server, so a reader who fails it is never sent the card's data at all. */}
      {cards.showTravel && (
        <PanelBoundary>
          <MyTravelRequestsCard />
        </PanelBoundary>
      )}
    </div>
  );
}
