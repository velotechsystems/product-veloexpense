import { expect, type Page, test } from '@playwright/test';
import { signIn, stateFileFor } from './support/actors';
import { stepPastDesktopNotice } from './support/desktop-notice';
import { PHONE_PROJECTS } from './support/phone-projects';
import {
  assertCoarsePointer,
  assertProject,
  censusOf,
  describeCandidate,
  EPS,
  encloses,
  HIT_FLOOR_PX,
  openOverlap,
  type Probe,
  R3_REMEDY,
  type Rect,
  type TapCandidate,
  type TapCensus,
} from './support/tap-targets';
import { seedEmployeeActivity } from './support/seed-activity';
import { closeTestDb, testDb } from './support/test-db';
import { openExpenseList, reportTag } from './support/workbench';

/*
 * VeloExpense: ExpenseOS's `e2e/tap-targets.mobile.spec.ts` (1e682dd6), ported with the phone
 * projects (phone e2e 2), for the routes VeloExpense has as ExpenseOS's screens: the shell on
 * `/dashboard` (and its two card lanes), `/admin/approval-workflows/[id]`,
 * `/expenses/approvals`, `/expenses` and `/expenses/[reportId]`. Its gates, helpers, lanes,
 * comments and pins are ExpenseOS's. Left out, each a route VeloExpense does not have as
 * ExpenseOS's screen: `/analytics`, `/users`, `/notifications`, `/delegations`, `/travel`,
 * the three virtual-card routes and their transactions, and the unshelled auth pages (`/login`
 * and the blocked `/profile` passkey pair). The header below still describes them; read it as
 * ExpenseOS's record, and this note as what runs here.
 *
 * What changed is the plumbing, each marked "VeloExpense:":
 *   · URLs carry no locale segment;
 *   · `testDb` is an admin `pg` pool (see `e2e/support/test-db.ts`), so the two Prisma reads
 *     are SQL;
 *   · ExpenseOS's QA seed (`qa-activity.json`) is not VeloExpense's, so the rows its lanes
 *     borrow are built here once per file (`seedTapFixture`): the employee's draft report
 *     with one hotel line, and a submitted one waiting in the manager's queue.
 */

/**
 * The tap-target geometry gates: every coarse-pointer control reaches 44px on the axes the
 * slop floors, no control's hit region reaches into another's, and the one place the design
 * puts two hit regions edge to edge is edge to edge rather than overlapping.
 *
 * ─── WHAT A GREEN RUN ESTABLISHES ────────────────────────────────────────────────────────
 *
 * On eight routes that go through the census, at every width in `PHONE_PROJECTS`, with a
 * coarse primary pointer proven before anything else is measured:
 *
 *   · THE FLOOR. For every candidate, on every axis the pseudo-element declares a floor for,
 *     `measured box extent + measured slop >= 44`. The slop is read off the `::after`; 44 is
 *     the only number written down.
 *   · NO SLOP WHERE THERE IS NONE. On every side whose measured reach is nil, a point 2px
 *     outside the visible box does not resolve to that control.
 *   · R1, TWICE. Nine points strictly inside each control's own box resolve to it; and
 *     exhaustively over all pairs, no two hit rectangles overlap on the open interior.
 *   · THE DESIGNED TANGENCY, POSITIVELY. On `/users` the notification bell's hit region and
 *     its left neighbour's meet at a gap of 0 — touching, not overlapping, not separated.
 *   · ENROLMENT, on `/notifications`. The page's "Load more" button is 38px and carries the
 *     slop, so the floor lane above measures it. See that route's own test for why enrolment
 *     is the thing being asserted and why a green run on the other four says nothing about
 *     it.
 *
 * AND ON A SIXTH ROUTE THAT GOES THROUGH NONE OF THAT. `/delegations` never calls
 * `runUniversalGates`, and it is measured in two halves.
 *
 *   · THE PUBLISHED TOP-BAR CONTROL, censused BEFORE the drawer opens, asserted at 32 × 44:
 *     the vertical floor met by slop, and the HORIZONTAL SHORTFALL PINNED — the hit region
 *     is exactly the painted box, because a horizontal reach here would overlap
 *     `NotificationBell`'s across the right zone's 6px gutter and the bell would win it.
 *     The shortfall is recorded in `docs/design/pwa.md`, remedy at the container, and this
 *     assertion is what makes both re-breaking it and legitimately closing it deliberate.
 *   · THE DRAWER'S FOUR FIELDS, with the create drawer OPEN and no census at all: they are
 *     floored by their own painted height rather than by slop, so they have no `::after`
 *     for the floor lane to read, and R1 is meaningless while a modal covers the page behind
 *     it on purpose. Four border boxes, each hit-tested at its own centre.
 *
 * The reasoning is at that test, and none of it is interchangeable with anything above.
 *
 * AND ON A SEVENTH, IN TWO LANES OF ITS OWN. `/travel` also skips `runUniversalGates`, for
 * `/delegations`' first reason — the census is wanted for two named subjects and nothing
 * here is R1's business — and its two lanes land on DIFFERENT FLOOR MECHANISMS, which is the
 * fact worth carrying up here:
 *
 *   · THE PUBLISHED TOP-BAR CONTROL, at 32 × 44, the same shape and the same recorded
 *     horizontal shortfall as `/delegations` because it is literally the same fix.
 *   · THE CARD LIST'S TITLE BUTTON, floored by its OWN BOX (`min-h-11`) and not by slop, so
 *     it has NO `::after`, `floored.vertical` is false, and the floor lane above skips it.
 *     The enrolment doctrine every other lane in this file applies would be RED against this
 *     control while the control is compliant — and compliant in the better way, since a
 *     painted floor holds under a mouse and reaches over no neighbour. That lane measures
 *     the box height directly, and its header says so at length. Do not "unify" the two.
 *
 * AND `/dashboard` IS MEASURED TWICE, WHICH IS THE ONE ROUTE THAT APPEARS ON BOTH SIDES OF
 * THAT LINE. Both lanes are named here because the route's `ready` bar counts them as one
 * clause and a run that reports only one of them has not discharged it:
 *
 *   · THE SHELL CHROME, through `runUniversalGates` — the hamburger and the notification
 *     bell, the only `-both` population on a route that publishes nothing into the top bar.
 *   · THE CARD LIST'S TITLE LINK, through no gate at all, for the `/travel` lane-B reason:
 *     it is floored by its own box and carries no `::after`, so the universal floor lane
 *     structurally skips it. It is a LINK and not a button — the `/dashboard` cards pass no
 *     `onRowClick`, so the floor lands on the title SLOT and is inherited by the caller's
 *     `<a>` stretched inside it, which is a different arm of `DataTableCards` from the one
 *     `/travel` exercises. This lane runs ONCE PER ACTOR — `employee` and `manager` — and
 *     both runs are part of the clause: no single actor sees all three `/dashboard` cards
 *     with rows, so the approvals card's title is reachable only as `manager`. That lane's
 *     own header has the coverage table.
 *
 * Two lanes on one route, three test names, and neither lane subsumes the other.
 *
 * ─── WHY R1 NEEDS BOTH PASSES, WHICH IS THE DESIGN OF THIS FILE ──────────────────────────
 *
 * They catch different things and neither subsumes the other, which is not obvious until you
 * watch both fire.
 *
 * The NINE-POINT PASS is the only one that speaks to harm. It asks the question a user asks:
 * I aimed at this control — did I get it? It found the real defect on
 * `/admin/approval-workflows/[id]` (see PINNED, below), where all nine interior points of the
 * hamburger resolve to a different control entirely.
 *
 * The RECTANGLE PASS is the only one that can prove absence. R1 is a "may never" over a
 * CONTINUOUS region, and nine samples cannot establish a claim about a continuum — they
 * establish it about nine points. The node palette on that same route was the demonstration,
 * and it is worth keeping now that it has been fixed: ten 36px buttons stacked 4px apart, each
 * slopping 4px up and 4px down, so consecutive hit regions overlapped by 4px across their full
 * 191px width. Every one of the nine interior points of every one of those buttons resolved
 * correctly, because the overlap lived in the GUTTER BETWEEN the boxes and no interior point
 * is ever in a gutter. The nine-point pass was green on it; the rectangle pass was red. See
 * FIXED AT THE CONTAINER, below, for what closed it.
 *
 * ─── THE ONE HARDCODED NUMBER ────────────────────────────────────────────────────────────
 *
 * `HIT_FLOOR_PX = 44`, and `EPS = 0.5`. Nothing else. In particular there is NO size→slop
 * table in this file. There was a measured one available — `icon-sm` reaches 6px a side, `xs`
 * reaches 8, `sm` reaches 4 — and encoding it would have made the gate assert the
 * implementation against a transcript of itself. Every slop here is read off the
 * pseudo-element at run time and compared against a number that comes from WCAG rather than
 * from this repo. See the header of `e2e/support/tap-targets.ts` for how the rectangle is
 * derived, and for why no side is ever computed as `(44 - rendered) / 2`.
 *
 * ─── WHAT A GREEN RUN DOES NOT ESTABLISH — READ THIS BEFORE CITING THE FILE ──────────────
 *
 * IT IS EN-ONLY, AND THAT IS A NAMED BIAS RATHER THAN AN OVERSIGHT — and it is biased in the
 * DANGEROUS direction, so it is first. FR-CA strings run about 20% longer than EN. Longer
 * labels make control boxes wider and rows taller, which is what pushes neighbours together
 * and makes hit regions collide. FR-CA is therefore the LIKELIER R1 trigger, not the
 * unlikelier one, and this file does not look at it. The reason is budget, inherited: T02's
 * mobile crawl deferred the FR-CA phone axis for the same reason, and this work did not buy
 * it back. A green EN run is not locale coverage and must not be cited as any.
 *
 * IT SEES ONE VIEWPORT-FULL. Candidates must lie entirely inside the visual viewport, because
 * `elementFromPoint` cannot reach anything else. Controls below the fold are not measured.
 * The census returns how many were excluded for this reason and the gate prints it, so a
 * route whose controls scrolled out of reach reads as a shrunken population rather than as a
 * clean sweep. SEVEN OF THE EIGHT CENSUSED ROUTES DO NOT SCROLL, and none of them gates what is
 * off-screen. `/notifications` is the exception and it had to be: its pagination control
 * sits UNDER a full page of thirty rows, roughly 2000px down, so at 360×800 it is off-viewport
 * by construction and the census rejects it before any lane can measure it. That route sets
 * `scrollToEnd`, which parks the shell's scroller at its bottom before the census is taken —
 * the geometry is read in viewport coordinates either way, so a scrolled viewport is as
 * measurable as an unscrolled one. Scrolling is per-route and opt-in precisely so the other
 * four keep the simpler guarantee. `/delegations` takes neither branch — it censuses
 * nothing at all.
 *
 * R2 IS NOT GATED HERE, AND NO PART OF IT IS. R2's "neither control is destructive" clause is
 * machine-decidable only for the subset of controls that carry the `destructive` /
 * `destructive-outline` variants, and its other half — "otherwise un-undoable" — is not
 * decidable at all from the DOM: whether an action can be taken back is a fact about the
 * server, not about a class name. Rather than gate the easy half and let the file imply the
 * hard half is covered, R2 is a `(human)` review clause in full. When a reviewer sees two
 * controls' regions adjacent on a phone, R2 is theirs to apply, and this spec has no opinion.
 *
 * DISABLED CONTROLS ARE OBSTRUCTIONS BUT NOT VICTIMS, and the asymmetry is deliberate. A
 * disabled control can absorb a tap meant for its neighbour, so it stays in the census and
 * counts against others; it is not itself entitled to a 44px target, so the floor gate and
 * the victim half of R1 skip it. A `<Button disabled>` additionally carries
 * `disabled:pointer-events-none`, which means taps pass straight through it — so it is not
 * even an obstruction, and the census drops it at the hit-testability filter rather than by
 * stipulation.
 *
 * IT DOES NOT PROVE A TAP DOES ANYTHING. It proves where a tap LANDS. Whether the control
 * then works is every other spec in this suite.
 *
 * ITS CARD FIXTURE POSTS A PAN, DELIBERATELY. The `/virtual-cards` leg sends
 * `pan: uniquePan(), cvv: '123'` to `virtualCards.issue` and `E2E_CAPTURE=on` records that
 * request body in the trace, which is safe rather than overlooked: `uniquePan()`
 * (`e2e/support/vcc.ts:38`) builds a Luhn-valid `411111…` number in the reserved test range
 * that no real network will authorize, the same generator `issueCard` already types through
 * the issue drawer elsewhere in this suite.
 *
 * `/profile` IS A FIFTH ROUTE THAT IS BLOCKED, NOT DECLINED, and the distinction is the whole
 * reason this paragraph exists. It carries the product's one adjacent rename / DESTRUCTIVE
 * remove pair — precisely the R3 shape this file is named after — and it is missing from the
 * four above because no seeded actor has a passkey for the row to render, and seeding one
 * breaks sign-in for the entire suite. The guard that would measure it is written, named and
 * exported at the FOOT of this file, deliberately unwired, with the blockage and its unblock
 * spelled out there. "On eight routes", above, is a fact about what runs today. It is not a
 * finding that eight routes are the right number.
 *
 * ─── PINNED: TWO REAL DEFECTS THIS GATE FOUND, RECORDED RATHER THAN FIXED ───────────────
 *
 * Both are on `/admin/approval-workflows/[id]`, both were found by writing this file, and
 * neither is fixed — fixing either is a product change this branch did not cause and does not
 * own. They are pinned as CHARACTERIZATION: the gate asserts each is STILL PRESENT, so the day
 * someone fixes one the pin goes red and has to be deleted. A pin cannot rot into a permanent
 * excuse, and it is scoped to the defect that was measured rather than to a category — proven
 * twice on the pin that has since been deleted, once by making its defect worse and once by
 * fixing it, both recorded under FIXED AT THE CONTAINER below.
 *
 * READ THEM TOGETHER BEFORE READING THEM SEPARATELY. Two independent tap-target defects on one
 * route, plus the one recorded below as fixed, is not three coincidences; it is a graph editor
 * that has never been laid out for a 390px screen, and `mobileReadiness.ts` does not rule it at
 * all — the registry resolves it `limited` BY ABSENCE (ADR-0005 D2), which is the default and is
 * silent, and it is the census that classifies the route `phone`. `phone` is a crawl
 * classification (`e2e/support/mobile-census.ts`), not a `Disposition`; the three dispositions
 * are `ready | limited | desktop`. Whether the right answer is more container fixes or one
 * `desktop` ruling is not
 * this file's call, and the file takes no position beyond recording what is measurably true
 * today.
 *
 * ─── FIXED AT THE CONTAINER: THE NODE PALETTE'S GUTTER. DO NOT RE-ADD A PIN FOR IT ──────
 *
 * There was a third pin here — PIN-2, the node palette's 4px stack gutter. It is gone because
 * the shape it characterised is gone, not because the pin was inconvenient.
 *
 * WHAT IT WAS. `WorkflowEditor.tsx`'s `PaletteGroup` stacked `size="sm"` buttons (191x36,
 * `einc-tap-slop`, 4px up and 4px down) on `space-y-1`, with no gap at all between the section
 * header above and the first button. 8px of slop met a 4px gutter, so it showed up in both
 * passes at once: pass 2 saw consecutive buttons overlapping by 191x4px down the column, and
 * pass 1 saw each button's upward slop taking the bottom 4px of the 191x23 section header, so
 * three of that header's nine interior points resolved to the button. On a phone, tapping the
 * bottom of "Routing" inserted an `If` node. It was the only one of the three caused by this
 * branch's tap slop, which is why it is the only one this branch fixed.
 *
 * THE REMEDY, AND WHY IT IS NOT IN THE RECIPE. R3 on the container, exactly as the plan's risk
 * register said it would be: `space-y-2` on the button stack AND `space-y-2` on the group
 * wrapper, so the header/stack gap goes from 0 to 8px and the button gutter from 4 to 8. 4px
 * of slop each side now meets 8px of gutter and the hit regions end tangent instead of
 * overlapping. Nothing about `einc-tap-slop` changed — a slop recipe that has to shrink because
 * one container is tight stops being a 44px guarantee everywhere else.
 *
 * WHAT WAS OBSERVED, both against a dev server on :3118, `mobile-390`:
 *
 *   · BEFORE the fix, with the pin removed from the list and nothing else touched, the real
 *     defect surfaced in both passes at once — `26 R1 violation(s) … that are not pinned`.
 *     15 from pass 1: five section headers (`Routing`, `Approvals`, `Automation`, `Sub-flow`,
 *     `Terminals`) losing three interior points each, reported as
 *     `button "Routing" (unslopped 191x23) — a point strictly INSIDE its own box resolves to
 *     button "If" (einc-tap-slop 191x36) instead`. And 11 from pass 2 at 191x4px each,
 *     INCLUDING PAIRS PASS 1 CANNOT SEE: `button "If" and button "Switch" overlap by 191x4px`.
 *     Both are 36px with 4px of slop and a 4px gutter, so that overlap lies entirely between
 *     their boxes and all eighteen of their interior points resolved correctly — which is the
 *     proof that nine samples cannot stand in for a continuum.
 *   · AFTER the container fix, with the pin still in the list, the run went red on the pin
 *     itself: `the pinned defect "PIN-2 …" was NOT observed`, and NOTHING surfaced as an
 *     unpinned violation. Both shapes gone, in one edit, which is what earned the deletion.
 *
 * Earlier, the same pin had also been shown NOT to absorb a worse defect: tightening the stack
 * from `space-y-1` to `space-y-0` grew the overlaps from 191x4px to 191x8px, its matcher
 * stopped matching, and five violations surfaced as unpinned.
 *
 * With the pin deleted the route is green in both passes, verified rather than assumed. If you
 * are here because the palette went red again, the fix is that container's vertical rhythm; a
 * new pin would only re-record a defect somebody already closed.
 *
 * PIN-1 — THE HAMBURGER, THE BREADCRUMB AND THE RENAME BUTTON ARE ALL UNREACHABLE. Every
 * interior point of every control in the top bar's `left` zone resolves to a control the PAGE
 * published into the bar. The route mounts a four-button toolbar (Settings / Simulate / Save
 * draft / Publish, ~355px of unshrinkable chrome) into a zone measuring 302px at 390 and 272px
 * at 360, so it is laid out at full width and painted outside its box, travelling LEFT —
 * `Settings` measures a left edge of -38 at 390 and -68 at 360, off the screen — and as a
 * later grid sibling it paints above the left zone. A user on a phone cannot open the
 * navigation on this route. This is ADR-0002's documented residue ("page chrome painted over
 * the left zone's title") landing on CONTROLS rather than on a title, at a width the ADR's own
 * spec does not measure: `e2e/topbar-overlap.spec.ts` reports it at 1024 pinned. NOT caused by
 * the tap slop — the hamburger's overlap is 44x44, complete containment of its own box, and it
 * would be there with the whole change reverted.
 *
 * PIN-3 — REACT FLOW'S MINIMAP COVERS REACT FLOW'S ZOOM CONTROLS. All nine interior points of
 * `Zoom In`, `Fit View` and `Toggle Interactivity` resolve to the `<MiniMap>` SVG. Both
 * components default to the canvas's bottom-left corner and at 390px there is not room for
 * both. Also NOT caused by the tap slop — neither component carries a slop class.
 *
 * ─── FALSIFICATION: OBSERVED, NOT ASSUMED ────────────────────────────────────────────────
 *
 * Every gate was watched to fail, one break at a time, against a dev server on :3118. The
 * messages below are transcribed from those runs, not reasoned about.
 *
 * RED 1 — `einc-tap-slop` REMOVED from the `xs` size variant in
 * `packages/design-system/src/components/ui/button.tsx`, on `mobile-390`:
 *     > button "Show filters" (unslopped 132.3x28) at 228.7,158 on /users is an `h-7` control
 *     > with NO ::after at all — the 28px `xs` button is shipping a 28px tap target.
 *   Only `/users` went red; `/dashboard`, `/analytics` and the workflow editor stayed green,
 *   as did the tangency and both R1 passes in the same run. Removing slop cannot create an
 *   overlap, and that disjointness is why the floor lane and the R1 lane are both needed.
 *
 *   THE FIRST VERSION OF THIS ASSERTION FAILED WRONGLY AND THAT IS WHY IT LOOKS LIKE THIS. It
 *   selected its subject as "slopped and <= 30px tall", so deleting the class made the subject
 *   vanish and what went red was the anti-hollowing COUNT, with a message blaming a `desktop`
 *   ruling. True failure, wrong cause, and it would have sent the next reader to the wrong
 *   file. The subject is now found by `h-7` — the size utility — which survives the property
 *   under test regressing.
 *
 * RED 2 — the top bar's right zone widened from `gap-1.5` to `gap-3` in `TopBar.tsx`, on
 * `mobile-390`, `/users`:
 *     > the designed tangency is gone: the notification bell's hit region and button
 *     > "Add user" (einc-tap-slop 75.69x36) at 254.31,12's are 6px apart, not touching. The
 *     > boxes are 12px apart and the bell reaches 6px left.
 *     Expected 0, received 6.
 *   BOTH R1 PASSES STAYED GREEN, and the 44px floor stayed green. A wider gutter breaks
 *   nothing an overlap test can see — the regions simply stop touching — which is the entire
 *   argument for asserting the tangency POSITIVELY rather than only tolerating it.
 *
 * RED 3 and RED 4 both broke the node palette, whose defect has since been fixed at the
 * container and whose pin is gone. Their transcripts are kept — they are the only record of
 * both R1 passes firing on one mechanism, and of a pin declining to absorb a worse defect —
 * and they have moved up to FIXED AT THE CONTAINER, above, where the fix they belong to is.
 *
 * Every break was restored and re-run green.
 */

/** Matches `crawl-mobile.spec.ts`, `safe-area.mobile.spec.ts`, `scroll-lock.mobile.spec.ts`
 *  and `desktop-notice.spec.ts`. See the EN-only note in the header — it is a bias, not a
 *  shrug. */
// VeloExpense: ExpenseOS's `const LOCALE = 'en'` prefixed every path; VeloExpense's paths have
// no locale segment, so it is gone. The EN-only bias it names still holds: the suite runs in
// English.

/** `PHONE_PROJECTS` is imported from `support/phone-projects` rather than restated here —
 * it was a hand-kept copy of the config's list until P02, and `assertProject` below is only
 * as good as that list is current. `chromium` never collects this file:
 * `*.mobile.spec.ts` is in `PHONE_ONLY_SPEC_PATTERNS`, so it is in `chromium`'s
 * `testIgnore` by derivation. */

/**
 * The stable key of the workflow whose editor is measured, and NOT its id.
 *
 * `ApprovalWorkflow.id` is a UUIDv7 generated at seed time, so it differs between every
 * database this suite has ever run against; hardcoding one would pass on the machine it was
 * written on and 404 everywhere else. `key` is `@unique` and seeded from a literal, so it is
 * the stable handle. Resolved through the Prisma client, which is the convention
 * `e2e/topbar-overlap.spec.ts` already uses for exactly this — and the reason the runner
 * needs `DATABASE_URL` in the TEST process, not just in the server's.
 */
const WORKFLOW_KEY = 'expense-report-default';

/**
 * The stable key of the expense report whose workbench is measured, and NOT its id.
 *
 * Same reasoning as `WORKFLOW_KEY` above, one step weaker and therefore worth stating.
 * `ExpenseReport` has no `@unique` handle a human wrote: `number` is `@unique` but comes off
 * a Postgres sequence, so it differs per database, and `id` IS a fixed literal in
 * `packages/db/prisma/seed-data/qa-activity.json` — which is exactly the shape that looks
 * safe to hardcode and is not. Those ids are fixed so a re-seed UPDATES the same rows rather
 * than accumulating new ones; that is a seeding contract with the seeder, not one with this
 * suite, and a spec pinned to one would 404 the day the id block is renumbered while the
 * report it means sits right there. The TITLE is the literal a person wrote, the row is
 * upserted under it, and it is resolved through Prisma exactly as the workflow block above
 * resolves its key.
 *
 * THIS REPORT SPECIFICALLY, for two reasons: it is DRAFT, so `editable` is true and the
 * controls this block is about actually render; and it is `qa.employee`'s, which is why the
 * block adopts that session rather than the projects' inherited admin one.
 */
// VeloExpense: a prefix — `seedTapFixture` builds one per run with a unique suffix.
const REPORT_TITLE = 'QA — Draft ready to submit';
/** Its submitter, whose session that block adopts. See the `test.use` at the block itself. */
const REPORT_OWNER = 'employee' as const;

/**
 * The pair of utilities that declare a real 44px box instead of buying one with slop.
 *
 * Read as exact `classList` entries (`TapCandidate.classes` is `Array.from(el.classList)`),
 * never as substrings, so the subject is found by the thing the ruling names.
 */
const COARSE_MIN_H = 'pointer-coarse:min-h-11';
const COARSE_MIN_W = 'pointer-coarse:min-w-11';

/**
 * The P18 controls the `/expenses/[reportId]` block finds by name. EN only, like `SHELL_BELL`
 * below; they match the `expenses.drawer.addExpense`, `expenses.drawer.addLine` and
 * `expenses.actions.delete` catalog keys.
 */
const ADD_EXPENSE = 'Add expense';
const ADD_LINE = 'Add line';
const LINE_DELETE = 'Delete';

/* VeloExpense: ExpenseOS's `SHELL_BELL = 'Notifications'` is not here — its only callers are the
 * `/notifications` and auth-page lanes this port leaves out, and VeloExpense's top bar has no
 * bell yet (see the shell-chrome lane). */

interface RouteUnderTest {
  path: string;
  /** Printed in failure messages so a reader knows which population was expected here. */
  why: string;
  /**
   * Park the shell's scroller at its bottom before censusing. Off by default.
   *
   * Only `/notifications` needs it, and it needs it structurally rather than incidentally:
   * the control that route is here for sits below thirty list rows, so it is never in the
   * first viewport at any phone width and the census rejects it as off-viewport. See the
   * "IT SEES ONE VIEWPORT-FULL" note in the header. Do not switch it on for a route whose
   * subject is already on screen — an unscrolled census is the stronger measurement, because
   * it is the one a reader gets on arrival.
   */
  scrollToEnd?: boolean;
  /**
   * Query string, WITHOUT the leading `?`. Appended to the URL for the navigation only —
   * every failure message and the `[tap-targets]` console line keep the bare path, because
   * a query can carry a credential and a token does not belong in a log. No route uses it
   * today.
   *
   * ─── "NOT IN THE LOG" IS NOT "NOT CAPTURED ANYWHERE" ──────────────────────────────────
   *
   * This file has no capture kill-switch — `trace` is a worker-scoped option, and adding one
   * at file scope would turn off screenshots, video and traces for every route gate here — so
   * under `E2E_CAPTURE=on` (`npm run test:e2e:review`) the trace holds the navigated URL,
   * query and all. A route that puts a live credential here needs a reason that credential
   * is harmless in a trace, not just this path-only logging.
   */
  query?: string;
  /**
   * This route is ruled `desktop` in `mobileReadiness.ts`, so it renders the desktop-only
   * notice below `lg` and its page is suppressed behind it. Step past the notice and go on
   * measuring the page.
   *
   * ─── WHY A RULED ROUTE STAYS IN THIS FILE RATHER THAN LEAVING IT ─────────────────────
   *
   * Because the ruling is COSMETIC and the route is still reachable. "Continue anyway" is a
   * real control on a real handset, and a reader who uses it is on the page these gates
   * measure, with the same thumb and the same 44px. Deleting a gate when its route is ruled
   * would retire the only evidence the product has that the controls on that page clear the
   * floor, and would retire it at exactly the moment nobody is looking at the page any more
   * — which is when geometry rots unnoticed. The ruling changes who arrives, not what they
   * can hit when they do.
   *
   * It is opt-in per route and never inferred, because inferring it is the same mistake as
   * a helper that steps past the notice when it happens to be there: a gate that adapts to
   * the ruling cannot also test it. An entry whose `pastNotice` disagrees with what the
   * page does fails, in both directions — see `stepPastDesktopNotice`.
   */
  pastNotice?: boolean;
  /**
   * An interaction that has to happen before there is anything worth censusing, run after
   * the navigation guards and before the settle.
   *
   * DELIBERATELY RARE, and the file argues against it elsewhere: driving the React Flow
   * canvas to reach the array-field remove button was rejected precisely because it would
   * put an interaction on the critical path of a geometry gate. The one use below is
   * different in the way that matters — a single form submit whose response is decided by
   * the server on the first request, with an explicit wait for the resulting element,
   * rather than a sequence of canvas gestures. It is here because the control it reaches
   * DOES NOT EXIST in any state the page can be navigated to directly.
   */
  arrive?: (page: Page) => Promise<void>;
}

/** The shell's scrolling box — `AppShell`'s `main`, whose `id` is the skip link's target and
 *  therefore a seam the shell already maintains. `e2e/scroll-lock.mobile.spec.ts` drives the
 *  same element. */
const MAIN = '#main-content';

/** One violation of either R1 pass, in a shape a pin can match on. */
type Violation =
  | { kind: 'stolen'; victim: TapCandidate; probe: Probe; thief: TapCandidate | null }
  | { kind: 'overlap'; slopper: TapCandidate; victim: TapCandidate; ox: number; oy: number };

interface PinnedDefect {
  id: string;
  matches: (v: Violation) => boolean;
}

const round = (n: number): number => Math.round(n * 100) / 100;

/**
 * PASS 1 — nine points strictly inside each candidate's own box.
 *
 * A point is satisfied when it resolves to the candidate or to one of its descendants, OR to
 * a control fully CONTAINED in the candidate's box. The second clause is the composed-widget
 * exemption — a date input with a picker trigger sitting inside it, which is two of the
 * candidates on `/analytics` and two on `/admin/platform`. Containment is the discriminator
 * because slop reaches OUTSIDE a box by construction and can never be contained in one, so
 * the exemption cannot launder the thing this pass exists to catch.
 */
function stolenTaps(census: TapCensus): Violation[] {
  const out: Violation[] = [];
  for (const c of census.candidates) {
    if (c.disabled) continue; // an obstruction, but never a victim
    for (const p of c.interiorProbes) {
      if (p.isSelf || p.isContained) continue;
      out.push({
        kind: 'stolen',
        victim: c,
        probe: p,
        // The thief, when it is itself a censused control. `null` means the tap landed on
        // non-interactive chrome, which is a different failure — the control is covered by
        // something that will not act on the tap at all.
        thief: p.hitIndex === null ? null : (census.candidates[p.hitIndex] ?? null),
      });
    }
  }
  return out;
}

/**
 * PASS 2 — exhaustive over all ordered pairs.
 *
 * Ordered rather than unordered, because the disabled rule is asymmetric: a disabled control
 * still obstructs (so it may be the slopper) but is not entitled to protection (so it may not
 * be the victim). Evaluated on the OPEN interior with `EPS`, because the designed tangency in
 * the shell zone is two hit regions sharing an edge and a closed test calls that a violation.
 *
 * Only pairs where the SLOPPER has a pseudo-element are reported. Two unslopped controls
 * overlapping is a pre-existing layout fact that this change did not create and this gate has
 * no standing to fail on; the composed input/picker pairs are exactly that, and the
 * enclosure test drops them anyway.
 */
function regionOverlaps(census: TapCensus): Violation[] {
  const out: Violation[] = [];
  const list = census.candidates;
  for (const slopper of list) {
    if (!slopper.pseudo) continue;
    for (const victim of list) {
      if (victim === slopper) continue;
      if (victim.disabled) continue; // obstruction, not victim
      // Nesting is not a collision, and neither is a composed sub-control.
      if (encloses(slopper.box, victim.box) || encloses(victim.box, slopper.box)) continue;
      const o = openOverlap(slopper.hit, victim.hit);
      if (!o) continue;
      // Report each unordered pair once, unless only one direction is eligible.
      if (victim.pseudo && !victim.disabled && victim.index < slopper.index) continue;
      out.push({ kind: 'overlap', slopper, victim, ox: o.x, oy: o.y });
    }
  }
  return out;
}

function formatViolation(v: Violation, route: string): string {
  if (v.kind === 'stolen') {
    return (
      `TAP STOLEN on ${route}: ${describeCandidate(v.victim)}` +
      `${v.victim.zone ? ` [top-bar zone "${v.victim.zone}"]` : ''} — a point strictly INSIDE ` +
      `its own box, (${round(v.probe.x)}, ${round(v.probe.y)}), resolves to ` +
      `${v.thief ? describeCandidate(v.thief) : v.probe.hit}` +
      `${v.thief?.chrome ? ` [top-bar chrome "${v.thief.chrome}"]` : ''} instead. A user aiming ` +
      'at the first control gets the second one. ' +
      R3_REMEDY
    );
  }
  const axis = v.ox >= v.oy ? 'vertical (they are stacked)' : 'horizontal (they are in a row)';
  return (
    `HIT REGIONS OVERLAP on ${route}: ${describeCandidate(v.slopper)} and ` +
    `${describeCandidate(v.victim)} overlap by ${round(v.ox)}x${round(v.oy)}px. The offending ` +
    `axis is ${axis}. The first control's slop reaches ` +
    `up/down/left/right ${round(v.slopper.reach.up)}/${round(v.slopper.reach.down)}/` +
    `${round(v.slopper.reach.left)}/${round(v.slopper.reach.right)}px beyond its own box; the ` +
    `second's reaches ${round(v.victim.reach.up)}/${round(v.victim.reach.down)}/` +
    `${round(v.victim.reach.left)}/${round(v.victim.reach.right)}px. No interior point need ` +
    'be affected for this to be real — the overlap lives in the gutter between the two boxes, ' +
    'which is why the nine-point pass can be green while this is red. ' +
    R3_REMEDY
  );
}

// VeloExpense: no locale segment in the logged path.
/** The one census line this file prints for every lane, pass or fail: a population that
 *  quietly halved is the failure mode these gates cannot otherwise see. Same text as the one
 *  `runUniversalGates` emits, which the lanes that call this do not go through.
 *
 *  `path` defaults to `/travel` because the two `/travel` lanes were this helper's only
 *  callers when it was written and the route was baked into the string. The `/dashboard`
 *  card lane is the third caller and it is not on `/travel`; a default keeps the existing
 *  call sites untouched while making the line honest for the new one. Do not add a fourth
 *  caller without passing its own path — a census line naming the wrong route is worse than
 *  no census line, because it is believed. */
function logCensus(census: TapCensus, why: string, path = '/travel'): void {
  console.log(
    `[tap-targets] ${path} (${why}): ${census.candidates.length} candidates ` +
      `(rejected: ${census.rejected.offViewport} off-viewport, ` +
      `${census.rejected.clipped} clipped, ` +
      `${census.rejected.notHitTestable} not hit-testable, ` +
      `${census.rejected.invisible} invisible/non-HTML, ${census.rejected.zeroSize} zero-size)`,
  );
}

/**
 * The gates every route gets, in the order they have to run in.
 *
 * The coarse-pointer assertion is FIRST and is not negotiable about it: under a fine pointer
 * the `::after` does not exist, every slop reads 0, every floor assertion compares a control
 * against its own unslopped size and the file passes while proving nothing. The guard is what
 * stops a silent emulation regression from turning this into a green no-op.
 */
async function runUniversalGates(
  page: Page,
  route: RouteUnderTest,
  pins: readonly PinnedDefect[] = [],
): Promise<TapCensus> {
  // VeloExpense: no locale segment in a path.
  const url = route.path;
  // The query is on the navigation only; `url` — token-free — is what every message says.
  const response = await page.goto(route.query ? `${url}?${route.query}` : url, {
    waitUntil: 'domcontentloaded',
  });
  expect(response?.status(), `GET ${url} did not answer 200`).toBe(200);
  // Same guard `safe-area.mobile.spec.ts` uses: the service worker's offline fallback also
  // answers 200, and would otherwise be censused as a route with two controls on it.
  expect(
    await page.locator('[data-testid="offline-page"]').count(),
    `the service worker served the offline fallback in place of ${url}`,
  ).toBe(0);
  // A route ruled `desktop` in `mobileReadiness.ts` renders the notice and not its page
  // (ADR-0005 D3). Censusing the notice would be a handful of controls that pass trivially,
  // reported as coverage of a page nobody measured.
  //
  // Which side of that a route is on is DECLARED, per route, by `pastNotice` — never sniffed.
  // Both directions are checked and both fail loudly: a ruled route that shows no notice is
  // as much a finding as an unruled route that shows one. This runs BEFORE `arrive`, in the
  // slot the bare assertion used to occupy, because `arrive` drives controls that do not
  // exist while the notice is up.
  await stepPastDesktopNotice(page, { expect: route.pastNotice ? 'present' : 'absent' });

  // Whatever it takes to put the controls under test on the screen. See `arrive`.
  if (route.arrive) await route.arrive(page);

  // Settle: these routes fetch through tRPC and lay out again when the data lands. Measuring
  // mid-flight pairs a rectangle from before the reflow with one from after.
  await page.waitForLoadState('networkidle');

  if (route.scrollToEnd) {
    /**
     * Park the shell's scroller at its bottom, and prove it moved.
     *
     * `main#main-content` is the scroller, NOT the window — the shell is `h-dvh` and the
     * document does not scroll (measured in `e2e/scroll-lock.mobile.spec.ts`), so
     * `window.scrollTo` here moves nothing and would leave the census measuring the top of
     * the page while reporting a scrolled one. The assertion is what makes that failure
     * loud: a route that asked to scroll and did not is a route whose subject is still
     * off-viewport, and the only symptom further down would be a hollow-population message
     * blaming the page.
     *
     * `scrollTop` is set rather than wheeled: a wheel is asynchronous and momentum-scrolled,
     * and this needs to be at the end before the next line reads geometry, not on its way
     * there. One frame is then awaited so the scrolled layout is what `elementFromPoint`
     * hit-tests against.
     */
    const scrolled = await page.locator(MAIN).evaluate((el) => {
      el.scrollTop = el.scrollHeight;
      return { top: el.scrollTop, height: el.scrollHeight, client: el.clientHeight };
    });
    expect(
      scrolled.height,
      `${url} asked for scrollToEnd and ${MAIN} does not overflow at all (scrollHeight ` +
        `${scrolled.height} vs clientHeight ${scrolled.client}). Either the route stopped ` +
        'rendering the content that made it tall — for /notifications, an inbox with more ' +
        'than one page in it — or this route no longer needs to scroll and the flag should ' +
        'come off.',
    ).toBeGreaterThan(scrolled.client);
    expect(
      scrolled.top,
      `${MAIN} did not move on ${url}: scrollTop is still 0 with a scrollHeight of ` +
        `${scrolled.height}. The scroller is not this element any more, or something is ` +
        'holding it — the census below would silently measure the first viewport.',
    ).toBeGreaterThan(0);
    await page.evaluate(
      () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
    );
  }

  const census = await censusOf(page);

  // ── Gate 0: the pointer really is coarse. Everything below is vacuous without it. ──────
  await assertCoarsePointer(page, census);

  const label = `${url} (${route.why})`;
  // Printed on every run, pass or fail: a population that quietly halved is the failure mode
  // these gates cannot otherwise see.
  console.log(
    `[tap-targets] ${label}: ${census.candidates.length} candidates ` +
      `(rejected: ${census.rejected.offViewport} off-viewport, ` +
      `${census.rejected.clipped} clipped, ` +
      `${census.rejected.notHitTestable} not hit-testable, ` +
      `${census.rejected.invisible} invisible/non-HTML, ${census.rejected.zeroSize} zero-size)`,
  );
  expect(
    census.candidates.length,
    `${label} censused no interactive candidates at all. The page did not render, or the ` +
      'candidate selector stopped matching this design system.',
  ).toBeGreaterThan(0);

  // ── Gate 1: the floor, per axis the pseudo-element declares a floor for. ───────────────
  for (const c of census.candidates) {
    if (c.disabled) continue; // not entitled to a target
    if (c.floored.vertical) {
      const extent = c.box.b - c.box.t;
      const slop = c.hit.b - c.hit.t - extent;
      expect(
        round(extent + slop),
        `${describeCandidate(c)} on ${url} does not reach the ${HIT_FLOOR_PX}px floor on the ` +
          `VERTICAL axis: box ${round(extent)}px + slop ${round(slop)}px = ` +
          `${round(extent + slop)}px. The slop is read off the ::after, so either the ` +
          'pseudo-element is gone (the class was dropped, or the rule left the ' +
          '`@media (pointer: coarse)` block) or the control grew past what the floor covers.',
      ).toBeGreaterThanOrEqual(HIT_FLOOR_PX);
    }
    if (c.floored.horizontal) {
      const extent = c.box.r - c.box.l;
      const slop = c.hit.r - c.hit.l - extent;
      expect(
        round(extent + slop),
        `${describeCandidate(c)} on ${url} does not reach the ${HIT_FLOOR_PX}px floor on the ` +
          `HORIZONTAL axis: box ${round(extent)}px + slop ${round(slop)}px = ` +
          `${round(extent + slop)}px.`,
      ).toBeGreaterThanOrEqual(HIT_FLOOR_PX);
    }
  }

  // ── Gate 2: the negative probe, on every side that measured no reach. ─────────────────
  /**
   * Asserted as a NEGATIVE — "nothing 2px out here is me" — rather than as the positive
   * "2px out here is my ancestor", and the reason is measured rather than stylistic: for controls that
   * touch with no gutter, the positive form is FALSE for a correct layout. 2px to the right
   * of a button in a `gap-0` row is the next button, not the container, and a spec that
   * demanded the container would be red on a perfectly good row.
   */
  for (const c of census.candidates) {
    for (const { side, probes } of c.negativeProbes) {
      for (const p of probes) {
        if (p.hit === null) continue; // outside the viewport; nothing to say
        expect(
          p.isSelf,
          `${describeCandidate(c)} on ${url} reaches BEYOND its visible box on the ${side} ` +
            `side, where it measured no slop at all: the point (${round(p.x)}, ${round(p.y)}), ` +
            `${2}px outside the box, still resolves to this control. Either the ::after grew ` +
            'an axis it is not supposed to have — `einc-tap-slop` is vertical ONLY, and that ' +
            'is load-bearing for the icon sizes next to destructive removes — or the box ' +
            'moved out from under its own slop.',
        ).toBe(false);
      }
    }
  }

  // ── Gate 3: R1, both passes, with pins partitioned out. ───────────────────────────────
  const violations = [...stolenTaps(census), ...regionOverlaps(census)];
  const unpinned = violations.filter((v) => !pins.some((p) => p.matches(v)));
  const matchedPins = pins.filter((p) => violations.some((v) => p.matches(v)));

  expect(
    unpinned.map((v) => formatViolation(v, url)),
    `${unpinned.length} R1 violation(s) on ${label} that are not pinned.`,
  ).toEqual([]);

  // Every pin must still be observed. A pin that stopped matching is a defect that got fixed,
  // and the pin has to be deleted rather than left as a standing excuse for the next one.
  for (const p of pins) {
    expect(
      matchedPins.includes(p),
      `the pinned defect "${p.id}" was NOT observed on ${url}. If it was fixed, delete the ` +
        'pin from this spec — a pin is characterization of one measured defect, and one that ' +
        'no longer matches will silently absorb the next defect that looks like it.',
    ).toBe(true);
  }

  return census;
}
/* ──────────────────────────────────────────────────────────────────────────────────────────
 * `/travel`'s two lanes, and everything they need.
 *
 * Kept together here rather than scattered among the constants at the top of the file, for
 * the reason the blocked `/profile` block at the bottom states: a route's unit should move in
 * one piece. Nothing above uses any of it.
 * ────────────────────────────────────────────────────────────────────────────────────────── */


/**
 * VeloExpense: the rows ExpenseOS's lanes borrow from its QA seed (`qa-activity.json`), built
 * once per file by `seedEmployeeActivity` (`e2e/support/seed-activity.ts`). ExpenseOS's lanes
 * stay READ-ONLY over them, as they are over the seed:
 *
 *   · `draftTitle` — the employee's DRAFT report with one hotel line, the subject of
 *     `/expenses/[reportId]` and a row on the employee's `/expenses`;
 *   · a submitted report of the employee's, so the manager's `/expenses/approvals` queue and
 *     the dashboard's "Reports to approve" card have a row to render.
 */
let draftTitle = '';

async function seedTapFixture(browser: import('@playwright/test').Browser): Promise<void> {
  draftTitle = `${REPORT_TITLE} ${reportTag('taps')}`;
  await seedEmployeeActivity(browser, { draftTitle, queuedTitle: reportTag('taps queue') });
}

test.beforeAll(async ({ browser }) => {
  await seedTapFixture(browser);
});

test.afterAll(async () => {
  await closeTestDb();
});

test.describe('tap targets, coarse pointer', () => {
  // Fails in ~0ms rather than after a navigation, and names the project. `page` is
  // destructured only because `beforeEach` needs a fixture argument to receive `testInfo`
  // in the second position.
  test.beforeEach(async ({ page }, testInfo) => {
    void page;
    assertProject(testInfo, PHONE_PROJECTS);
  });

  test('the shell chrome: both axes floored, on the route with no page chrome', async ({
    page,
  }) => {
    const census = await runUniversalGates(page, {
      path: '/dashboard',
      why: 'the shell controls, on a route that publishes no top-bar slot',
    });

    /**
     * The anti-hollowing guard for this route: the shell's own `-both` controls.
     *
     * `/dashboard` is here because it publishes NOTHING into the top bar, so the two shell
     * controls are the whole right zone and the `-both` population is unambiguous. If a later
     * change stops rendering them, or rules this route `desktop`, this route's contribution
     * to the gate would otherwise become an empty loop reported as a pass.
     *
     * TWO, not three. The plan expected three — the hamburger, the notification bell and the
     * assistant launcher. The launcher does not mount in this environment and will not mount
     * in CI: it is gated on `activeModules.has('assistant')`, the `assistant` module requires
     * an active `anthropic` integration, and `bootstrapAnthropic` installs that only when
     * `ANTHROPIC_API_KEY` is in the environment, which `.env.test` does not set. So the
     * population is the hamburger and the bell. Asserted as a floor rather than as an
     * equality so that an environment which DOES have the key gets a third control gated
     * rather than a red run.
     */
    const bothAxes = census.candidates.filter((c) => c.floored.vertical && c.floored.horizontal);
    /**
     * VeloExpense: ONE, not two. VeloExpense's top bar has the hamburger and no bell yet —
     * `NotificationBell.tsx` is a placeholder that renders nothing until Wave 5 ports
     * ExpenseOS's (notifications are reached from the sidebar meanwhile). Raise this back to
     * 2 when the bell comes over, or the gate stops covering it.
     */
    const SHELL_BOTH_AXES = 1;
    expect(
      bothAxes.length,
      'the /dashboard gate went HOLLOW: it found fewer than 2 controls flooring both axes. ' +
        'This is not a broken page — it is the gate losing its subject. The shell renders a ' +
        'hamburger and a notification bell here, both `einc-tap-slop-both` at 32x32. If a ' +
        'later task ruled this route `desktop`, or moved the shell controls, this route stops ' +
        'testing anything and must be replaced rather than left green.',
    ).toBeGreaterThanOrEqual(SHELL_BOTH_AXES);

    // Each of them is square-ish and short, so both axes are genuinely bought by slop rather
    // than by the control's own size — which is what makes this route's population the
    // interesting one. Asserted about the MEASUREMENT, not about a size the spec knows.
    for (const c of bothAxes) {
      expect(
        c.reach.left + c.reach.right,
        `${describeCandidate(c)} floors the horizontal axis but buys none of it with slop. ` +
          'That is legitimate for a wide control (a `default` button is already past 44px), ' +
          'but on /dashboard the both-axes population is the 32px shell chrome and it should ' +
          'be reaching sideways.',
      ).toBeGreaterThan(0);
    }
  });

  for (const actor of ['employee', 'manager'] as const) {
    test(`/dashboard as ${actor}: the card list’s title link, floored by its own box`, async ({
      page,
    }) => {
      /**
       * ── THE SECOND `/dashboard` LANE, AND IT IS THE `/travel` LANE-B SHAPE, NOT THE ONE
       *    DIRECTLY ABOVE IT. READ THIS BEFORE EDITING. ─────────────────────────────────
       *
       * The lane above runs `/dashboard` through `runUniversalGates`. THIS ONE DELIBERATELY
       * DOES NOT, and the reason is the same one `/travel`'s card lane records at length:
       * `floored` is `pseudo !== null && num(after.minHeight) > 0`
       * (`e2e/support/tap-targets.ts:606-609`), so it tests ENROLMENT IN THE SLOP MECHANISM
       * and not "reaches 44px". A control floored by its own painted box carries no `::after`,
       * reports `floored.vertical === false`, and the floor lane inside `runUniversalGates`
       * SKIPS IT. Routing this subject through that gate gives one of two useless outcomes:
       * a red against a control that is already compliant, or a lane that silently measures
       * nothing. So the box is measured directly, here.
       *
       * ── WHAT THE SUBJECT IS, AND WHY IT IS A LINK RATHER THAN A BUTTON ────────────────
       *
       * `/travel`'s card list passes `onRowClick`, so `DataTableCards` renders the row's open
       * affordance as a `<button type="button" class="… min-h-11 …">`
       * (`DataTableCards.tsx:404-421`) and that button is the subject there.
       *
       * The three `/dashboard` cards pass NO `onRowClick` — each row's title cell renders the
       * card's own `<a>` at the record, which is what `e2e/dashboard.mobile.spec.ts` asserts
       * the hrefs of. That takes the other arm of the same `if`
       * (`DataTableCards.tsx:453-468`): the title SLOT becomes a `min-h-11` flex container
       * with `items-stretch` and the caller's anchor is its single child, so the anchor
       * inherits the 44px rather than sitting at its natural ~36px inside a padded parent.
       * The frame never names `a`; the geometry is what makes the anchor the tap target, and
       * the geometry is therefore what has to be measured. The subject is the LINK, and the
       * lane is named for it so nobody reconciles the two `/travel`-shaped lanes by making
       * this one look for a button.
       *
       * ── WHY THE SUBJECT IS BORROWED RATHER THAN SEEDED ───────────────────────────────
       *
       * Unlike `/travel`'s lane, which seeds a trip because that route renders empty states
       * for an actor with no trips, this one needs no fixture: `qa-activity.json` seeds seven
       * expense reports and all six travel requests to `qa.employee`, and routes six approval
       * tasks to `qa.manager`. The seeded rows are already there, this lane opens nothing and
       * writes nothing for either actor, and three phone projects can therefore run it at once
       * with no per-project isolation at all.
       *
       * ── BOTH ACTORS, AND THIS REVERSES THE PLAN'S ANSWER ON NEW INFORMATION ───────────
       *
       * The operator's Round-1 answer was "one tap-target lane, as `employee`". It is reversed
       * here deliberately rather than ignored: as a single `employee` lane this measured the
       * two "mine" cards' titles and NOTHING ELSE, because `selectDashboardCards` gates the
       * approvals card on `expense.report.approve` and that actor does not hold it. So
       * `ReportsToApproveCard`'s title anchor — the card this whole change exists for, and the
       * one clause 3 of the `ready` bar cites these lanes as evidence for — met the 44px floor
       * in no lane anywhere in the repo. It is the same blind-actor defect as the `/dashboard`
       * lane in `e2e/datatable-mobile.spec.ts`, and it is closed the same way.
       *
       * Being gated ON for a card is not the same as having rows in it, either: all three
       * cards short-circuit to `<SectionEmpty>` before they mount `<DataTable>` when
       * `rows.length === 0` (`MyExpenseReportsCard.tsx:279-285`), so a card with no rows
       * renders no card list and offers this lane no anchor. The coverage is a union:
       *
       *   employee — "My expense reports" and "My travel requests", both with rows. No
       *              approvals card at all.
       *   manager  — "Reports to approve", with rows. The two "mine" cards are gated on for
       *              this actor but it owns no report and no trip, so they render their empty
       *              copy and the approvals card is the only subject this actor offers.
       *
       * The approvals card's title link is therefore reachable ONLY as `manager`, and the
       * anti-vacuity floor below stays INSIDE the test rather than across the loop for exactly
       * that reason: an actor that rendered no card list has to go red on its own run rather
       * than be rescued by the other actor's subjects.
       */
      await signIn(page, actor);

      // VeloExpense: no locale segment in a path.
      const url = '/dashboard';
      const response = await page.goto(url, { waitUntil: 'domcontentloaded' });
      expect(response?.status(), `GET ${url} did not answer 200`).toBe(200);
      // The service worker's offline fallback also answers 200, and would otherwise be
      // censused as a route with two controls on it. Same guard as `runUniversalGates`.
      expect(
        await page.locator('[data-testid="offline-page"]').count(),
        `the service worker served the offline fallback in place of ${url}`,
      ).toBe(0);
      await assertCoarsePointer(page);
      // `/dashboard` is not ruled `desktop`, so the notice must be absent — asserted rather
      // than assumed, in both directions, exactly as the universal gate does it.
      await stepPastDesktopNotice(page, { expect: 'absent' });

      /**
       * Poll for the CARDS. `#main-content` paints immediately and each `SectionCard` paints
       * its skeleton before its tRPC response lands, so a census taken against the shell finds
       * the hamburger and the bell, measures them, and reports a route it never looked at.
       * `data-card-<id>` is minted per row by `DataTableCards`, so it is simultaneously proof
       * that the data arrived AND that the compact tree is what mounted.
       */
      const cards = page.locator('#main-content [id^="data-card-"]');
      await expect.poll(() => cards.count(), { timeout: 60_000 }).toBeGreaterThan(0);
      await page.addStyleTag({ content: '*{animation:none!important;transition:none!important}' });
      // Three tRPC lists land and the page lays out again when they do. A census taken
      // mid-flight pairs a rectangle from before the reflow with one from after.
      await page.waitForLoadState('networkidle');

      /**
       * PUT THE SUBJECT ON THE SCREEN BEFORE ANYTHING MEASURES IT. `mobile-390` IS WHY, AND
       * THIS IS NOT CEREMONY — DO NOT DELETE IT.
       *
       * `mobile-390` is `devices['iPhone 14']`, whose viewport is 390 × **664** — SHORTER than
       * `mobile-360`'s 800 and `mobile-412`'s 900, which is the one dimension nobody expects
       * the "narrowest" project to lose on. As `employee` the two "mine" cards sit below the
       * identity band, their first row's title anchor lands past 664px, `censusOf` drops every
       * candidate whose box is not wholly inside the viewport
       * (`e2e/support/tap-targets.ts:411-427`), and the lane had nothing left to measure: a
       * pre-flight run went red at `mobile-390` as `employee` with 10 anchors in the DOM and 0
       * censused, green at 360 and 412, green as `manager` at every width because the
       * approvals card sits higher up the page. The floor caught it, which is what the floor
       * is for; the fix is to give the lane its subject back, never to lower the number.
       *
       * ── SCROLLED ONLY WHEN IT HAS TO BE, SO THE OTHER WIDTHS MEASURE WHAT THEY ALWAYS DID
       *
       * The condition is "no title anchor is inside the viewport at all". Where the census
       * already had a subject — 360 and 412, and `manager` everywhere — that is false and
       * nothing moves, so those runs census exactly the population they censused before this
       * was added. An unconditional scroll would have silently changed the measured subject at
       * every width to buy a fix at one of them.
       *
       * The scroller is `main#main-content`, NOT the window: the shell is `h-dvh` and the
       * document does not scroll, so `window.scrollTo` moves nothing here. Same fact
       * `runUniversalGates`' `scrollToEnd` records at length, and `scrollTop` is set rather
       * than wheeled for the same reason — a wheel is asynchronous and momentum-scrolled, and
       * this has to be finished before the next statement reads geometry. The first anchor is
       * parked a quarter of the way down rather than flush with an edge, so it is inside the
       * viewport AND inside the clip chain the census intersects, not balanced on the boundary
       * of either.
       *
       * THE LANE STAYS WRITE-FREE. A scroll mutates nothing on the server, and all three cards
       * pass `disableInfiniteScroll`, so no sentinel asks for a next page on the way down. The
       * three phone projects can still run this concurrently, which is the property the "why
       * the subject is borrowed" paragraph above depends on.
       */
      const TITLE_SEL = '#main-content [data-dt-row-key] [data-dt-card-slot="title"] a';
      const parked = await page.evaluate((sel) => {
        const main = document.querySelector<HTMLElement>('#main-content');
        const anchors = Array.from(document.querySelectorAll<HTMLElement>(sel));
        /** The census's viewport half, applied to the subjects only. The census stays the
         *  authority on what is measurable; this decides only whether to scroll at all. */
        const onScreen = () =>
          anchors.filter((el) => {
            const r = el.getBoundingClientRect();
            return r.top >= 0 && r.bottom <= window.innerHeight;
          }).length;
        const [first] = anchors;
        const from = main?.scrollTop ?? 0;
        if (!main || !first || onScreen() > 0) {
          return { anchors: anchors.length, scrolled: false, from, to: from, onScreen: onScreen() };
        }
        main.scrollTop =
          from +
          (first.getBoundingClientRect().top - main.getBoundingClientRect().top) -
          main.clientHeight / 4;
        return {
          anchors: anchors.length,
          scrolled: true,
          from,
          to: main.scrollTop,
          onScreen: onScreen(),
        };
      }, TITLE_SEL);

      if (parked.scrolled) {
        // Prove it actually moved. Nothing in this lane scrolls before this point, so
        // `scrollTop` is 0 here and every anchor is BELOW the fold — the target is therefore
        // strictly greater, and a `to` that did not grow means the scroller refused. A
        // scroller that refused — because it is no longer this element, or because something
        // is holding it — would otherwise reach the floor below as a hollow lane blaming the
        // page for a subject that was never brought into view.
        expect(
          parked.to,
          `${MAIN} did not move on /dashboard as ${actor}: scrollTop is still ${parked.from} ` +
            `with ${parked.anchors} title anchors in the DOM and none of them inside the ` +
            'viewport. The shell scroller is not this element any more, or something is ' +
            'holding it — see this test’s scroll paragraph before touching the floor below.',
        ).toBeGreaterThan(parked.from);
        // One frame, so the scrolled layout is what `elementFromPoint` hit-tests against.
        // Same reason `runUniversalGates` awaits one after its own `scrollToEnd`.
        await page.evaluate(
          () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
        );
      }

      /**
       * The subjects, resolved from the DOM by STRUCTURE and then matched into the census by
       * NAME AND BOX — never selected by the property under test.
       *
       * `TapCandidate` carries no marker for "this anchor is in a card's title slot", so the
       * two have to be joined on something. The accessible name is computed here exactly as
       * `censusOf` computes it — `aria-label` else trimmed `textContent`, truncated to 40
       * characters (`e2e/support/tap-targets.ts:595`) — so half the join is on the census's own
       * key rather than on a second definition of it that could drift. The name ALONE is not
       * enough: it carries no scope, so any other anchor on the page whose computed name
       * happened to collide would be measured here as a card title. The structural scope is
       * therefore carried through the join as the element's own rectangle, which both sides
       * read with `getBoundingClientRect()` in viewport coordinates.
       *
       * The structural half is `[data-dt-row-key] [data-dt-card-slot="title"] a`: a card row,
       * its title slot, and the anchor inside it. Scoping through `data-dt-row-key` is what
       * keeps this off a title slot rendered anywhere but a card row, and the `a` is what
       * keeps it off `/travel`'s button arm if this file is ever pointed at that route.
       */
      const titles = await page.locator(TITLE_SEL).evaluateAll((els) =>
        els.map((el) => {
          const r = el.getBoundingClientRect();
          return {
            name: (el.getAttribute('aria-label') || (el.textContent || '').trim()).slice(0, 40),
            box: { l: r.left, r: r.right, t: r.top, b: r.bottom } as Rect,
          };
        }),
      );

      const census = await censusOf(page);
      logCensus(census, `the card list's title link, as ${actor}`, '/dashboard');

      /**
       * The same rectangle, to the pixel. Both sides are `getBoundingClientRect()` in viewport
       * coordinates, read after `networkidle` with animations off, and `censusOf` scrolls
       * nothing — so the only tolerance either read needs is sub-pixel rounding.
       */
      const sameBox = (a: Rect, b: Rect) =>
        Math.abs(a.l - b.l) <= 1 &&
        Math.abs(a.r - b.r) <= 1 &&
        Math.abs(a.t - b.t) <= 1 &&
        Math.abs(a.b - b.b) <= 1;

      const titleLinks = census.candidates.filter(
        (c) =>
          c.tag === 'a' &&
          !c.disabled &&
          titles.some((t) => t.name === c.name && sameBox(t.box, c.box)),
      );

      /**
       * THE ANTI-VACUITY FLOOR, and on this lane it is doing more work than usual.
       *
       * Every assertion below is a `for` over `titleLinks`. An empty list satisfies all of
       * them, and there are three separate ways to get an empty list that are NOT "the page
       * broke": the cards did not mount and the page rendered its table tree instead (in which
       * case the title slot exists but holds no anchor and nothing is measured); the rows all
       * landed below the fold and the census rejected them as off-viewport; or the actor lost
       * the card. All three would report green.
       *
       * THE SECOND OF THOSE IS NOT HYPOTHETICAL, AND THIS COMMENT USED TO GET IT WRONG. It
       * claimed the first card's rows "sit in the first viewport-full at every width in
       * `PHONE_PROJECTS`". They do not: at `mobile-390` (390 × 664) as `employee` they sit
       * below the fold, the census rejected all ten of them, and this floor is what turned
       * that into a red instead of a green lane measuring nothing. The scroll step above is
       * the repair — it gives the lane its subject back rather than lowering this number —
       * and the floor stays exactly where it is, because a scroll can fail too, and because
       * the other two ways of going hollow are untouched by it. If it fires again, read the
       * scroll telemetry in the message below before changing anything here.
       */
      expect(
        titleLinks.length,
        `the /dashboard card-title lane went HOLLOW as ${actor}: no enabled anchor inside a ` +
          `card title slot was censused (the DOM offered ${titles.length}). That is either the ` +
          'census rejecting them — check the off-viewport and not-hit-testable counts printed ' +
          'above — or the card tree not mounting at all, which is the `mobile` config no ' +
          'longer naming a `title` (`DataTable.tsx:159-160`) and would put the off-screen ' +
          'table back. The floor is per actor on purpose: which cards hold rows depends on ' +
          'the actor, and the other actor’s subjects may not rescue this run. See this test’s ' +
          'header, and point the lane at the new subject rather than deleting the guard. ' +
          `Scroll telemetry: ${parked.anchors} anchors in the DOM, ${MAIN} parked at ` +
          `${parked.to} (from ${parked.from}, ${parked.scrolled ? 'scrolled' : 'not scrolled'}), ` +
          `${parked.onScreen} of them inside the viewport afterwards.`,
      ).toBeGreaterThanOrEqual(1);

      for (const c of titleLinks) {
        /** THE BOX, AND NOT THE PSEUDO-ELEMENT. See this test's header before changing it to
         *  the enrolment shape most lanes in this file use. */
        expect(
          round(c.box.b - c.box.t),
          `${describeCandidate(c)} on /dashboard as ${actor} is ` +
            `${round(c.box.b - c.box.t)}px tall, under ` +
            `the ${HIT_FLOOR_PX}px floor. THIS CONTROL IS FLOORED BY ITS OWN BOX AND NOT BY ` +
            'SLOP — the no-`onRowClick` title slot is a `min-h-11` flex container with ' +
            '`items-stretch` and this anchor is its single child ' +
            '(apps/web/src/components/data-view/DataTable/DataTableCards.tsx:453-468) — so it ' +
            'has no `::after` and the floor lane in runUniversalGates cannot see it. The likely ' +
            'cause is that the slot went back to padding itself: a padded parent does not grow ' +
            'its child, which is the exact defect that arm was rewritten to fix. Do NOT reach ' +
            'for `einc-tap-slop`: slop paints nothing, so a 36px title would still LOOK 36px ' +
            'while claiming 44, and a hit region reaching past a card that sits in a stack of ' +
            'other cards is the R1 shape this file exists to refuse.',
        ).toBeGreaterThanOrEqual(HIT_FLOOR_PX);

        /**
         * And it buys that height with its box rather than with slop — asserted about the
         * MEASUREMENT and not against a class name.
         *
         * THIS IS THE DISGUISED-REGRESSION GUARD, and it is why the lane measures two things
         * rather than one. The failure it catches is not the first regression but the FIX that
         * usually follows it: the box shrinks, the assertion above goes red, and somebody
         * restores the floor by enrolling the control in `einc-tap-slop` instead of restoring
         * the box. Slop paints nothing. The title would still LOOK 36px, the hit region would
         * claim 44, and the extra 8px would land on the neighbouring card in the stack — a
         * repair that satisfies a hit-region test while making the page worse. A reach of 0 is
         * what says the 44px is real rather than declared.
         */
        expect(
          round(c.reach.up + c.reach.down),
          `${describeCandidate(c)} now reaches vertically beyond its own painted box. The card ` +
            "title is floored by the slot's `min-h-11` plus `items-stretch`, on purpose — " +
            'somebody added a slop class to a control that already met the floor, which buys ' +
            'nothing visible and puts a hit region over the neighbouring card in the stack.',
        ).toBeCloseTo(0, 1);
      }
    });
  }

  test('/admin/approval-workflows/[id]: the vertical repeat, with two pinned defects', async ({
    page,
  }) => {
    /**
     * ── WHY THIS ROUTE, AND WHY IT IS ALSO "THE SCHEMA-FORM ROUTE" ──────────────────────
     *
     * The plan names "`/admin/approval-workflows/[id]` and a schema-form route", which reads
     * as two. It is one, and deliberately so.
     *
     * `NodeConfigPanel.tsx` on this very route renders the design-system `<SchemaForm>`, so
     * the `templates.tsx` field templates ARE the schema-form surface here. The alternatives
     * were weighed and rejected: `/admin/roles` is the other route that mounts a SchemaForm on
     * load and T04 ruled it `desktop` (ADR-0005; the Page-readiness table in
     * `docs/design/pwa.md`), so at 360 and 390 it renders the notice and not the
     * form; `/admin/platform` mounts one but its schemas are scalar fields only, so
     * `ArrayFieldTemplate` never runs, and its censused population (two shell controls and one
     * `sm` button) adds no size class this file does not already cover on three other routes.
     * A fifth route for nothing is cost without coverage.
     *
     * THAT SENTENCE IS ABOUT `/admin/platform` AND `/admin/roles`, AND IT IS NOT WHY
     * `/profile` IS ABSENT. A fifth route WAS considered after this one and it would not have
     * been a fifth route for nothing: `/profile` mounts the product's only adjacent rename /
     * DESTRUCTIVE remove pair, which is a size class and an ADJACENCY nothing above covers. It
     * is absent because it cannot be measured yet, not because it was weighed and declined.
     * The guard that would measure it is at the foot of this file under BLOCKED, unwired, with
     * the reason. Read that before citing this paragraph as the file's position on /profile.
     *
     * WHAT IS NOT COVERED, STATED PLAINLY: `templates.tsx:320`'s `icon-xs` remove button — the
     * vertical-repeat risk frontend measured, which passes by 4px on a field height the
     * template does not control — DOES NOT RENDER ON LOAD ANYWHERE. It needs an array field
     * with items, which on this route means selecting a graph node first, and on the other
     * SchemaForm routes means opening a drawer. Driving a React Flow canvas to select a node
     * would put an interaction on the critical path of a geometry gate, which is the flake
     * this suite spends its `retries: 0` budget avoiding. So that population is measured by
     * `packages/design-system/tests/components/forms/schema-form/templates.test.tsx` and by
     * nothing here, and this file does not imply otherwise.
     *
     * What this route DID contribute is the vertical-repeat R1 risk in a worse form than the
     * one that was predicted: the node palette, whose 4px stack gutter is now fixed at the
     * container. See FIXED AT THE CONTAINER in the header — that shape is gone and must not be
     * pinned again.
     */
    const db = await testDb('tap-targets.mobile');
    // VeloExpense: SQL on the admin pool, in place of `db.approvalWorkflow.findUnique`; the key
    // is unique per tenant here, so the demo tenant is named.
    const workflow = (
      await db.query<{ id: string }>(
        `SELECT w.id FROM approval_workflow w JOIN organization o ON o.id = w.organization_id
          WHERE w.key = $1 AND o.slug = 'demo'`,
        [WORKFLOW_KEY],
      )
    ).rows[0];
    expect(
      workflow,
      `no ApprovalWorkflow with key "${WORKFLOW_KEY}" in the database this run is pointed at. ` +
        'The seed changed, or DATABASE_URL names a database that was never seeded — a MISSING ' +
        'DATABASE_URL is ruled out, `testDb` above fails with its own message for that.',
    ).toBeTruthy();
    if (!workflow) return;

    /**
     * PIN-1 — the top bar's page slot overflows across its left zone. See the header.
     *
     * Matched on the VICTIM'S ZONE rather than on either control's name, and both halves of
     * that are deliberate:
     *
     *   · Not the victim's name, because the overflow covers the whole left zone and steals
     *     from everything in it — the hamburger, the "Approval workflows" breadcrumb, and the
     *     rename pencil, measured. Pinning one name would leave the other two unpinned and
     *     make the gate red for a defect it has already recorded.
     *   · Not the thief's name, because which toolbar button lands on which victim depends on
     *     how far the overflow travelled: at 390 the hamburger is taken by `Settings`, at 360
     *     by `Simulate`. Pinning the thief would make the pin width-specific for no reason.
     *
     * What is pinned is therefore exactly the mechanism: a control in the header's `left`
     * zone loses its taps to a control the PAGE published into the header. `data-zone` and
     * `data-chrome` are the seams `TopBar.tsx` maintains for this. The moment the overflow is
     * fixed, no violation matches and the pin goes red.
     */
    const PIN_TOPBAR_OVERFLOW: PinnedDefect = {
      id: "PIN-1 the top bar's page slot overflows across its left zone (ADR-0002 residue at phone widths)",
      matches: (v) =>
        v.kind === 'stolen'
          ? // `probe.hitChrome`, NOT `thief.chrome`. The thief is usually not a candidate at
            // all: the overflowing toolbar is laid out at a negative left edge (-38 at 390,
            // -68 at 360), so the census rejects it as off-viewport while it goes on winning
            // every hit test in the left zone. Reading `data-chrome` off the hit element
            // directly is what lets the pin name the mechanism instead of a label.
            (v.victim.zone === 'left' && v.probe.hitChrome === 'page') ||
            // VeloExpense: the same overflow, seen from the other side. At 412 the overflowing
            // toolbar's own first button ("Settings") sits UNDER the shell's hamburger, so the
            // page control is the victim and the left zone the thief. One mechanism — the
            // page slot overflowing across the left zone — so one pin, widened by this clause.
            (v.victim.chrome === 'page' && v.probe.hitZone === 'left')
          : // The same overflow also shows up as a rectangle overlap between the toolbar's
            // buttons and the breadcrumb link they are sitting on top of.
            (v.slopper.chrome === 'page' && v.victim.zone === 'left') ||
            (v.victim.chrome === 'page' && v.slopper.zone === 'left'),
    };

    /**
     * PIN-3 — React Flow's own minimap sits on top of React Flow's own zoom controls.
     *
     * All nine interior points of `Zoom In`, `Fit View` and `Toggle Interactivity` (26x26,
     * unslopped, the `<Controls>` component) resolve to the `<MiniMap>`'s SVG. Both default to
     * the bottom-left corner of the canvas, and at 390px there is not room for both, so the
     * minimap — mounted later — covers all three. Every canvas control on this route is
     * unreachable on a phone.
     *
     * NOTHING TO DO WITH THE TAP SLOP. Neither component carries a slop class, both are
     * third-party chrome, and this would be true with the whole change reverted. It is pinned
     * rather than excluded on purpose: carving third-party UI out of the gate by vendor is
     * exactly the exemption that hollows a gate out, and "the user cannot zoom the canvas" is
     * a real finding whoever wrote the component.
     *
     * The thief is matched by its description rather than structurally, which is the one place
     * in this file that happens. It has to be: the minimap is an `<svg>`, so the census
     * excludes it (the box model does not describe SVG hit areas) and there is no candidate to
     * point at. "Mini Map" is React Flow's own `aria-label`, not one of our catalog strings, so
     * it does not move with a translation.
     */
    /** VeloExpense: React Flow's `<Controls>` buttons, by their own `aria-label`s. */
    const REACT_FLOW_CONTROLS = new Set(['Zoom In', 'Zoom Out', 'Fit View', 'Toggle Interactivity']);
    const PIN_REACTFLOW_MINIMAP: PinnedDefect = {
      id: "PIN-3 React Flow's minimap covers React Flow's zoom controls at phone widths",
      matches: (v) =>
        v.kind === 'stolen' &&
        ((v.probe.hit ?? '').includes('"Mini Map"') ||
          // VeloExpense: the same minimap, hit on one of its own shapes rather than on its
          // `<svg>` — at 360 the zoom buttons resolve to an unlabelled `rect` inside it, the
          // minimap's node drawing. Narrowed to React Flow's own control buttons as victims
          // and an SVG shape as the hit, so it cannot absorb anything else.
          (REACT_FLOW_CONTROLS.has(v.victim.name) && /^(rect|path|svg|g)\b/.test(v.probe.hit ?? ''))),
    };

    await runUniversalGates(
      page,
      {
        path: `/admin/approval-workflows/${workflow.id}`,
        why: 'the vertical-repeat R1 risk, and the schema-form surface',
        /**
         * P10 ruled `/admin/approval-workflows` `desktop`, and this dynamic child INHERITS
         * that ruling — there is no registry key of its own, and there must not be one
         * (`mobileReadiness.ts`, and the pin in `mobileReadiness.test.ts`). So the notice
         * renders here, and the gate steps past it rather than leaving.
         *
         * ─── THIS OPT-IN IS WHAT KEEPS TWO CHARACTERIZATION PINS ALIVE ─────────────────
         *
         * PIN-1 and PIN-3 below assert that two defects are STILL PRESENT. They are the
         * product's only phone-reachable witnesses for either one: PIN-1 needs a route that
         * publishes a labelled toolbar into the top bar's page slot, and PIN-3 needs a
         * React Flow canvas, and this is the only route that is both. Retiring this gate
         * when the route was ruled would have deleted the evidence at the moment nobody is
         * looking at the page any more — which is when geometry rots unnoticed.
         *
         * If either pin stops matching, that is a STOP and an escalation, not a matcher to
         * adjust: a pin going red means the defect it records was fixed somewhere else, and
         * the fix has to be found and written down before the pin is removed.
         */
        pastNotice: true,
      },
      [PIN_TOPBAR_OVERFLOW, PIN_REACTFLOW_MINIMAP],
    );
  });

  test('/expenses/approvals: the queue’s two sheet triggers, floored by their own height', async ({
    page,
  }) => {
    /**
     * The plain lane: `runUniversalGates` and one enrolment guard after it.
     *
     * ── WHY `manager` AND NOT THE STORED ADMIN ─────────────────────────────────────────
     *
     * `qa.admin`'s session is what every phone project carries, and `qa.admin` reaches this
     * route (`approvals/page.tsx` admits `approve || reimburse || readAll`) with an EMPTY
     * pending queue. An empty queue renders no cards, so the card tree's two sheet triggers
     * are the only page controls either way — but a route censused on its empty state is a
     * route whose population halves the day somebody seeds a task, and the census line would
     * not say which happened. `manager` holds the six seeded `EXPENSE_REPORT` tasks, so this
     * measures the queue a real approver arrives at. READ-ONLY: nothing here taps a card,
     * opens the drawer or decides anything, so no seeded task is consumed and the three
     * phone projects can run this file concurrently against the one `expenseos_e2e`.
     *
     * ── `pastNotice` IS OMITTED, AND THAT IS AN ASSERTION ──────────────────────────────
     *
     * `runUniversalGates` calls `stepPastDesktopNotice(… { expect: 'absent' })` for a route
     * that declares nothing, and that check fails in BOTH directions. A `limited` route
     * renders no notice, so the omission here is the free cross-check that the ruling took:
     * if a later task rules this route `desktop`, this lane goes red naming the notice rather
     * than quietly censusing it.
     */
    await signIn(page, 'manager');

    const census = await runUniversalGates(page, {
      path: '/expenses/approvals',
      why: "the card tree's filter and sort sheet triggers, which the floor lane cannot see",
    });

    /**
     * ── PROVE ENROLMENT BEFORE TRUSTING THE FLOOR ──────────────────────────────────────
     *
     * The two triggers in `#approvals-mobile-controls` are `Button size="lg"`, and the `lg`
     * row of the cva in `packages/design-system/src/components/ui/button.tsx` is
     * `'h-11 rounded-md px-8'` — 44px of PAINTED height and NO slop class. So there is no
     * `::after`, `floored.vertical` is false, and Gate 1 above walks straight past them.
     *
     * That is the correct design and the wrong thing to leave unsaid. A route whose only
     * page controls are skipped by the floor lane passes this file while the floor lane
     * measures nothing on it, which is the shape `pwa.md:624-625` records twice — 30px on
     * `/dashboard`, 38px on `/notifications`, both SKIPPED rather than failed. So the claim
     * is made here instead, against the control's own box, and the skip is asserted
     * positively so that closing it has to be deliberate.
     *
     * Found by accessible name and by PREFIX: both triggers relabel when they carry state
     * (`Filters · 2`, `Sort · Amount`, `table.mobile.filtersWithCount` / `sortWithField`),
     * and a lane pinned to the bare word would go hollow the moment a default sort lands.
     */
    const SHEETS = ['Filters', 'Sort'] as const;
    const sheets = census.candidates.filter(
      (c) => !c.disabled && SHEETS.some((s) => c.name === s || c.name.startsWith(`${s} ·`)),
    );
    expect(
      sheets.map(describeCandidate),
      'the /expenses/approvals sheet lane went HOLLOW: fewer than 2 of the card tree’s ' +
        '"Filters" / "Sort" triggers were censused. Below `md` these are the ONLY way to ' +
        'change the queue — the pill bar that switches it on a desktop is cloaked — so this ' +
        'is the page losing its phone controls, or `DataTableMobileConfig` coming off ' +
        "ExpenseApprovalsInbox.tsx, or the census rejecting them. Check the run's " +
        '[tap-targets] line for the off-viewport and clipped counts before changing this.',
    ).toHaveLength(2);

    for (const s of sheets) {
      /** The skip, asserted. See the block above — this is the `lg` tier's own height. */
      expect(
        s.floored.vertical,
        `${describeCandidate(s)} on /expenses/approvals now declares a VERTICAL floor. It ` +
          'did not: `size="lg"` is `h-11` with no `einc-tap-slop`, and this lane exists ' +
          'because that puts it outside Gate 1 entirely. If the `lg` cva row gained a slop ' +
          'class, that is a design-system change — move this subject into the floor lane and ' +
          'update the tap-target table in docs/design/pwa.md with it.',
      ).toBe(false);
      /** And with no `::after`, the hit region must be exactly the painted box. */
      expect(
        round(s.reach.up + s.reach.down + s.reach.left + s.reach.right),
        `${describeCandidate(s)} reaches beyond its own box on /expenses/approvals ` +
          `(${round(s.reach.up)}/${round(s.reach.down)}/${round(s.reach.left)}/` +
          `${round(s.reach.right)}px up/down/left/right) while declaring no floor at all. A ` +
          'hit region that is bigger than the control and bigger than anything it declares ' +
          'is the R1 shape this file hunts.',
      ).toBeCloseTo(0, 1);
      /** The floor itself, bought by the control rather than by the mechanism. */
      expect(
        round(s.box.b - s.box.t),
        `${describeCandidate(s)} on /expenses/approvals is ` +
          `${round(s.box.b - s.box.t)}px tall, under the ${HIT_FLOOR_PX}px floor, and it has ` +
          'no slop to make up the difference. These triggers are floored by their own ' +
          '`h-11`; either the `lg` cva row shrank, or FilterSheet.tsx / SortSheet.tsx stopped ' +
          'asking for `size="lg"`.',
      ).toBeGreaterThanOrEqual(HIT_FLOOR_PX);
    }
  });

  test('/expenses: three published controls at a coarse pointer, and one of them in this census', async ({
    page,
  }) => {
    /**
     * ── THE COUNT IS THREE, AND THE PLAN SAID TWO ──────────────────────────────────────
     *
     * The spec this lane was written from describes the `/expenses` top bar as TWO published
     * controls — "Upload receipt" and "New report" — and that is the FINE-pointer row. Every
     * project that collects this file sets `hasTouch: true`, `(pointer: coarse)` matches, and
     * `ReceiptFileInput` splits its picker in two: `useCoarsePointer()` puts a camera control
     * in the DOM AHEAD of the library one (`apps/web/src/components/attachments/
     * ReceiptFileInput.tsx`), and `ExpenseReportsList.tsx` swaps both to the icon-only
     * `UPLOAD_CHIP_ICON`. So the coarse row is "Take photo", "Choose file", "New report".
     *
     * ── AND ONLY THE THIRD OF THEM IS A TAP-TARGET CANDIDATE ───────────────────────────
     *
     * This is the whole reason the lane is shaped this way rather than as a plain entry.
     * Two independent mechanisms put the receipt pair outside `censusOf` — and neither of
     * them fails, because a control the census never holds cannot fail anything:
     *
     *   · THE CONTROL IS A `<label>`. `CANDIDATE_SELECTOR` in `e2e/support/tap-targets.ts`
     *     is real controls plus the ARIA roles that make a non-control into one. A bare
     *     `<label>` is neither: it carries no implicit role, so it matches no arm of that
     *     selector and `getByRole('button')` would not find it either.
     *   · THE INPUT IS `display: none`. `ReceiptFileInput` hides it with Tailwind `hidden`
     *     rather than `sr-only` — deliberately, and the primitive says so — so the one
     *     element in the pair that IS in `CANDIDATE_SELECTOR` (`input:not([type=hidden])`)
     *     is rejected by the `display === 'none'` filter and counted as `invisible`.
     *
     * Result: the trio contributes ONE candidate. Left alone, this route would report a
     * green tap-target run over a top bar whose two newest controls were never measured —
     * the exact "invisible to the gate rather than merely under it" failure `pwa.md:624-625`
     * records twice. So this lane asserts the absence, then measures the pair OUTSIDE the
     * census by its own mechanism, the way the `/delegations` lane above measures four
     * drawer fields the floor lane cannot see.
     *
     * `employee` rather than the stored admin: the seven seeded reports are theirs
     * (`qa-activity.json` → `expected.qaEmployee.reportCount: 7`), which is what makes the
     * card tree and the toolbar render against data rather than against an empty state.
     * READ-ONLY — nothing here opens a picker, uploads a file or creates a report.
     *
     * `pastNotice` OMITTED, as on `/expenses/approvals` above and for the same reason: a
     * `limited` route renders no notice, `stepPastDesktopNotice` checks both directions, and
     * the omission is the cross-check that the ruling took.
     */
    await signIn(page, 'employee');

    const census = await runUniversalGates(page, {
      path: '/expenses',
      why: "the top bar's coarse-pointer trio, of which the census can hold exactly one",
    });

    // ── HALF ONE: what the census DOES hold. ────────────────────────────────────────────

    /**
     * The published population, by structure and not by name: everything the PAGE put in the
     * top bar, as opposed to the shell's hamburger and bell (`data-chrome="shell"`).
     *
     * Asserted as a list of names rather than as a count, so a failure prints the population
     * it actually found. Both directions are findings. Fewer means `canCreate` went false or
     * the effect stopped publishing; MORE means either a fourth control landed here, or —
     * the interesting one — the receipt pair became censusable, at which point it belongs in
     * this half and the DOM probe below should be retired rather than left to double-report.
     */
    const published = census.candidates.filter((c) => !c.disabled && c.chrome === 'page');
    expect(
      published.map(describeCandidate),
      'the /expenses top-bar lane censused something other than exactly one enabled ' +
        'candidate under `[data-chrome="page"]`. ONE is correct and is the finding this lane ' +
        'exists for: the row publishes three controls at a coarse pointer and two of them ' +
        'are `<label>`s wrapping a `display:none` input, which `CANDIDATE_SELECTOR` cannot ' +
        'see. If this is now two or three, the receipt pair became censusable — move its ' +
        'floor assertions out of the DOM probe below and into the census half. If it is ' +
        'zero, `canCreate` went false for `employee` or the publishing effect in ' +
        'ExpenseReportsList.tsx stopped running.',
    ).toHaveLength(1);
    const [newReport] = published;
    if (!newReport) return;
    expect(
      newReport.name,
      'the one censused /expenses publisher is not "New report". That accessible name is ' +
        'load-bearing beyond this file — `e2e/expense-lifecycle.spec.ts` matches on it — so ' +
        'a rename here is a two-file change.',
    ).toBe('New report');

    /** Enrolment first, exactly as on `/delegations`: with no `::after` there is no floor
     *  claim to check, and Gate 1 above would have skipped it in silence. */
    expect(
      newReport.pseudo,
      `${describeCandidate(newReport)} has no ::after at all, so it declares NO floor and ` +
        'ships its painted box as its whole hit region. `Button size="sm"` is `h-9` plus ' +
        '`einc-tap-slop` in packages/design-system/src/components/ui/button.tsx; either that ' +
        'was dropped, or the rule left the `@media (pointer: coarse)` block in ' +
        "packages/design-system/src/globals.css. Nothing about the control's appearance " +
        'changes when this regresses.',
    ).not.toBeNull();
    expect(
      newReport.floored.vertical,
      `${describeCandidate(newReport)} carries a pseudo-element that floors no vertical axis. ` +
        '`min-height: 44px` is what enrols a control; an `::after` without it is decoration.',
    ).toBe(true);
    expect(
      round(newReport.hit.b - newReport.hit.t),
      `${describeCandidate(newReport)} reaches only ` +
        `${round(newReport.hit.b - newReport.hit.t)}px vertically, under the ${HIT_FLOOR_PX}px ` +
        'floor. The control is a 32px square below `lg` ' +
        "(`max-lg:h-8 max-lg:w-8 max-lg:px-0`) and the `sm` variant's `einc-tap-slop` is " +
        'what buys the rest.',
    ).toBeGreaterThanOrEqual(HIT_FLOOR_PX);

    /**
     * The HORIZONTAL axis: THE RECORDED SHORTFALL, ASSERTED POSITIVELY — the `/travel` and
     * `/delegations` shape, which this route now SHARES rather than contrasts with.
     *
     * IT USED TO CONTRAST, AND THE OLD COMMENT HERE PREDICTED ITS OWN REPLACEMENT. While the
     * control was a labelled `size="sm"` button, `einc-tap-slop` being vertical-only did not
     * matter across: the icon plus the label painted a box well past 44 wide, so the floor was
     * met by the control rather than by the mechanism, and the old assertion said
     * `box.r - box.l >= HIT_FLOOR_PX`. Its comment added that "an icon-only treatment below
     * `lg` (which is what `/delegations` did) reddens this instead of silently inheriting that
     * route's shortfall". **That treatment has now landed here** —
     * `apps/web/src/app/[locale]/(app)/expenses/ExpenseReportsList.tsx` reshapes the control to
     * `max-lg:h-8 max-lg:w-8 max-lg:px-0`, a 32px square below `lg` — so this lane was
     * rewritten in the SAME change rather than left knowingly red behind a gate that runs no
     * Playwright.
     *
     * 32 is not written down. What is asserted is the relation "the hit region is exactly the
     * painted box, and the painted box is under the floor", and it must redden in BOTH
     * directions:
     *
     *   · someone re-adds `einc-tap-slop-both` at the call site, growing the hit region past
     *     the box and into the `pointer-coarse:gap-3` seam a receipt chip's own 6px ring
     *     already reaches into — an R1 violation this census cannot report, because the chip
     *     is not a candidate (see HALF ONE above);
     *   · the container remedy legitimately lands and the control genuinely reaches the floor.
     *     That is a FIX, and this assertion is what makes closing it DELIBERATE: update it
     *     together with the `/delegations`, `/travel`, `/virtual-cards/requests`, `/budgets`
     *     and `/expenses` rows in docs/design/pwa.md, which all record 32 × 44 for the same
     *     mechanism.
     *
     * Do NOT relax this to `toBeGreaterThanOrEqual`. A one-sided floor would pass in both the
     * fixed state and the broken-overlap state, which is the whole failure mode.
     */
    expect(
      newReport.floored.horizontal,
      `${describeCandidate(newReport)} now floors the HORIZONTAL axis. The slop on this ` +
        'control is the `size="sm"` cva variant\'s vertical-only `einc-tap-slop`, and on this ' +
        'seam that is a ruling rather than an oversight: the control sits a ' +
        '`pointer-coarse:gap-3` away from a receipt chip whose own ring already reaches 6px, ' +
        "and it sits in the top bar's `right` zone, where the `/delegations` control's " +
        "horizontal reach overlapped `NotificationBell`'s across a 6px `gap-1.5` gutter and " +
        'lost it on DOM order. Someone re-added `einc-tap-slop-both` in ' +
        'apps/web/src/app/[locale]/(app)/expenses/ExpenseReportsList.tsx. The remedy is the ' +
        'CONTAINER — docs/design/pwa.md, the tap-target table, which records TWO of them for ' +
        'this control because it sits in two — not this call site.',
    ).toBe(false);
    expect(
      round(newReport.reach.left + newReport.reach.right),
      `${describeCandidate(newReport)} reaches sideways beyond its own box ` +
        `(${round(newReport.reach.left)}px left, ${round(newReport.reach.right)}px right). ` +
        '`einc-tap-slop` is vertical ONLY, and that is load-bearing here: this control sits ' +
        'a `pointer-coarse:gap-3` away from a receipt chip whose own ring already reaches ' +
        '6px, so horizontal reach here would put the two hit regions into the same strip — ' +
        'and the census cannot report that R1 violation, because the chip is not a candidate.',
    ).toBeCloseTo(0, 1);
    expect(
      round(newReport.hit.r - newReport.hit.l),
      `${describeCandidate(newReport)} is now ` +
        `${round(newReport.hit.r - newReport.hit.l)}px wide on the hit axis, at or past the ` +
        `${HIT_FLOOR_PX}px floor. Below \`lg\` this control is a 32px square ` +
        '(`max-lg:h-8 max-lg:w-8 max-lg:px-0`) and its horizontal shortfall is RECORDED in ' +
        "docs/design/pwa.md, not slopped over. If the top bar's right-zone gutter was widened " +
        'and this control legitimately reaches the floor on both axes now, that is a FIX and ' +
        'this assertion is what makes closing it deliberate: update it together with the ' +
        '`/delegations`, `/travel`, `/virtual-cards/requests`, `/budgets` and `/expenses` ' +
        'rows in docs/design/pwa.md, which all record 32 × 44.',
    ).toBeLessThan(HIT_FLOOR_PX);

    /**
     * The `DataTable` toolbar's two controls, which render below 768px on this route
     * (`ExpenseReportsList.tsx` mounts `DataTableToolbar` outside the `compact` branch).
     * One assertion each, because they are two different dispositions and the difference is
     * the point of this whole phase.
     */
    const byName = (name: string) => census.candidates.find((c) => !c.disabled && c.name === name);

    /** EXPORT — not a gap. `Button variant="ghost" size="sm"` carries `einc-tap-slop`. */
    const exportTrigger = byName('Export');
    expect(
      exportTrigger,
      'no enabled "Export" control was censused on /expenses. `TableExportMenu` renders it ' +
        "into `DataTableToolbar`'s `rightSlot` at every width, so this is the gate losing " +
        'its subject rather than a finding about the toolbar.',
    ).toBeDefined();
    /**
     * VeloExpense: A GAP HERE, ASSERTED POSITIVELY on the column chooser's doctrine below.
     *
     * VeloExpense's screens use lib-ui-kit's `Button`, not ExpenseOS's design-system one, and
     * the kit's `sm` is `h-7` with no `einc-tap-slop` (ExpenseOS: `einc-tap-slop h-9`). So
     * this trigger is ~28px tall at a coarse pointer, declares no floor, and Gate 1 skips it.
     * The fix belongs in the kit — ExpenseOS's slop classes on the kit Button's small sizes —
     * which is tracked on its own (it reaches every product that uses the kit). Until it
     * lands, both halves of the shortfall are pinned, so the lane goes red the day the kit
     * fixes it and the assertion has to be turned back into ExpenseOS's:
     * `floored.vertical === true` and the hit extent `>= HIT_FLOOR_PX`.
     */
    if (exportTrigger) {
      expect(
        exportTrigger.floored.vertical,
        `${describeCandidate(exportTrigger)} now declares a vertical floor. If the kit Button's ` +
          '`sm` gained `einc-tap-slop`, that is the FIX this pin was waiting for: restore ' +
          "ExpenseOS's two assertions here (floored, and at or past the floor).",
      ).toBe(false);
      expect(
        round(exportTrigger.hit.b - exportTrigger.hit.t),
        `${describeCandidate(exportTrigger)} now reaches the ${HIT_FLOOR_PX}px floor — see the ` +
          'note above; restore ExpenseOS\'s assertions.',
      ).toBeLessThan(HIT_FLOOR_PX);
    }

    /**
     * THE COLUMN CHOOSER — a gap, and the kind this phase is about.
     *
     * `TableSettingsButton`'s trigger is a bare `PopoverTrigger` with `h-10` and no slop
     * class at all (`packages/design-system/src/components/data-display/data-table/
     * TableSettingsButton.tsx`). It IS a `<button>`, so unlike the receipt pair it reaches
     * the census — and then declares no floor, so Gate 1 skips it and reports nothing. 40px,
     * four short of the floor, with every gate in this repo green about it.
     *
     * NOT FIXED HERE, and deliberately: the trigger is design-system-owned and shared by
     * every `DataTable` toolbar in the product, so slopping it is a change to all of them and
     * belongs to whoever owns that sweep. What this phase owes is that the skip stops being
     * invisible. So the shortfall is asserted POSITIVELY, on the `/delegations` doctrine:
     * "declares no floor" AND "is under the floor" are both pinned, and the only way to make
     * this lane green again is to fix the control and delete these two assertions together
     * with the row in docs/design/pwa.md. A one-sided `toBeGreaterThanOrEqual` here would
     * pass in the fixed state and in the broken state alike, which is the whole failure mode.
     */
    const settings = byName('Table settings');
    expect(
      settings,
      'no enabled "Table settings" control was censused on /expenses. `TableSettingsButton` ' +
        "renders into `DataTableToolbar`'s `rightSlot` at every width and its `aria-label` " +
        'is `table.settings.trigger`. If the label changed, point this lane at the new name ' +
        'rather than dropping the record — the shortfall below is still shipping.',
    ).toBeDefined();
    if (settings) {
      expect(
        settings.floored.vertical,
        `${describeCandidate(settings)} now declares a VERTICAL floor. That is a FIX, and ` +
          'this assertion is what makes closing it deliberate: the trigger shipped `h-10` ' +
          'with no slop class, which put it OUTSIDE Gate 1 rather than under it. Update this ' +
          'lane and the tap-target row in docs/design/pwa.md together.',
      ).toBe(false);
      expect(
        round(settings.hit.b - settings.hit.t),
        `${describeCandidate(settings)} now reaches ` +
          `${round(settings.hit.b - settings.hit.t)}px vertically, at or past the ` +
          `${HIT_FLOOR_PX}px floor. If the control was genuinely fixed, that is good news and ` +
          'this pinned shortfall has to be removed rather than left as a standing excuse for ' +
          'the next 40px trigger.',
      ).toBeLessThan(HIT_FLOOR_PX);
    }

    // ── HALF TWO: what the census does NOT hold, asserted rather than assumed. ──────────

    /**
     * The absence itself, first. Without this the rest of the half is a lane measuring
     * something nothing else claims to cover — and if the primitive ever grows a
     * `role="button"`, or swaps `hidden` for `sr-only`, the pair would quietly start being
     * gated in two places at once with no signal that the duplication happened.
     */
    const RECEIPT_NAMES = ['Take photo', 'Choose file', 'Upload receipt', 'Uploading…'];
    expect(
      census.candidates.filter((c) => RECEIPT_NAMES.includes(c.name)).map(describeCandidate),
      'a receipt control appeared in the /expenses census. It could not before: the control ' +
        'is a `<label>` (no implicit role, no arm of CANDIDATE_SELECTOR matches it) wrapping ' +
        'an `input.hidden` (rejected by the `display === "none"` filter). One of those two ' +
        'facts changed. That is an IMPROVEMENT — the floor lane can measure it now — but it ' +
        'makes the DOM probe below a second, weaker copy of the same claim. Retire the probe ' +
        'and let Gate 1 own these controls.',
    ).toEqual([]);

    /**
     * And now measure them anyway, by the mechanism they actually use.
     *
     * The arithmetic is `censusOf`'s, copied rather than shared because `censusOf` reaches
     * its subjects through a selector that will never match these: the `::after`'s containing
     * block is the label's PADDING box, so the borders come off before the used width and
     * height are centred on it. That is the line that produced the tabs' asymmetric split on
     * `/analytics`, and it is the line that matters here too — `UPLOAD_CHIP_ICON` carries
     * `border border-input`, so a ring is centred on a box 2px smaller than the one that is
     * painted. That is what put the ring at 42px when it was declared `-inset-1.5` (6px):
     * 30 + 6 + 6. It is now declared `-inset-[7px]`, for 30 + 7 + 7 = 44.
     */
    const PAGE_CHROME = '[data-chrome="page"]';
    const CAMERA = 'label:has(input[type="file"][capture="environment"])';
    const LIBRARY = 'label:has(input[type="file"]:not([capture]))';
    const pair = await page.evaluate(
      ([scopeSel, cameraSel, librarySel]) => {
        const scope = document.querySelector(scopeSel);
        const num = (v: string) => Number.parseFloat(v) || 0;
        const read = (sel: string) => {
          const el = scope?.querySelector(sel) ?? null;
          if (!el) return null;
          const r = el.getBoundingClientRect();
          const cs = getComputedStyle(el);
          const after = getComputedStyle(el, '::after');
          const ringed =
            after.content !== 'none' && after.content !== '' && after.content !== 'normal';
          const pl = r.left + num(cs.borderLeftWidth);
          const pr = r.right - num(cs.borderRightWidth);
          const pt = r.top + num(cs.borderTopWidth);
          const pb = r.bottom - num(cs.borderBottomWidth);
          const pw = num(after.width);
          const ph = num(after.height);
          const cx = (pl + pr) / 2;
          const cy = (pt + pb) / 2;
          const ring = ringed
            ? { l: cx - pw / 2, r: cx + pw / 2, t: cy - ph / 2, b: cy + ph / 2 }
            : null;
          return {
            name: (el.textContent || '').trim().slice(0, 40),
            ringed,
            box: { l: r.left, r: r.right, t: r.top, b: r.bottom },
            hit: ring
              ? {
                  l: Math.min(r.left, ring.l),
                  r: Math.max(r.right, ring.r),
                  t: Math.min(r.top, ring.t),
                  b: Math.max(r.bottom, ring.b),
                }
              : { l: r.left, r: r.right, t: r.top, b: r.bottom },
          };
        };
        return { camera: read(cameraSel), library: read(librarySel) };
      },
      [PAGE_CHROME, CAMERA, LIBRARY] as const,
    );

    /**
     * THREE, NOT TWO — asserted on the camera control's presence in the DOM, which is the
     * only place the split is observable. ADR-0003 puts it plainly: WHETHER the camera
     * control exists is JS (`useCoarsePointer()`), because `capture="environment"` is an
     * attribute and no media query can add one. At a fine pointer this element is ABSENT
     * rather than hidden, so finding it here is the proof that the phone projects' coarse
     * pointer reached the product and not just the stylesheet.
     */
    expect(
      pair.camera,
      'no camera control in the /expenses top bar at a coarse pointer. `assertCoarsePointer` ' +
        'already passed, so `(pointer: coarse)` matched — which means the JS half did not: ' +
        '`useCoarsePointer()` in apps/web/src/lib/useCoarsePointer.ts answered false, or ' +
        '`TopBarReceiptUpload` stopped passing `camera`. The row publishes THREE controls ' +
        'here and two publishers is the fine-pointer count.',
    ).not.toBeNull();
    expect(
      pair.library,
      'no file-picker control in the /expenses top bar. This one exists at every pointer, so ' +
        'its absence means `canCreate` went false or `ReceiptFileInput` stopped rendering.',
    ).not.toBeNull();
    if (!pair.camera || !pair.library) return;

    /** Printed on every run, pass or fail, for the same reason the census line is: these two
     *  controls are in no other gate's output, so a geometry that quietly changed would
     *  otherwise leave no trace at all. */
    for (const c of [pair.camera, pair.library]) {
      console.log(
        `[tap-targets] /expenses receipt control "${c.name}": painted ` +
          `${round(c.box.r - c.box.l)}x${round(c.box.b - c.box.t)}, hit region ` +
          `${round(c.hit.r - c.hit.l)}x${round(c.hit.b - c.hit.t)} (ring ` +
          `${c.ringed ? 'present' : 'ABSENT'})`,
      );
    }

    for (const c of [pair.camera, pair.library]) {
      /** Enrolment, for a mechanism that is not the slop class. `RECEIPT_HIT_SLOP` is a
       *  `pointer-coarse:after:-inset-[7px]` ring, so the pseudo-element is the whole of the
       *  claim and its absence is total: a 32px square with no ring is a 32px tap target. */
      expect(
        c.ringed,
        `the /expenses receipt control "${c.name}" has no ::after at all, so it ships its ` +
          'painted 32px square as its entire hit region. `RECEIPT_HIT_SLOP` in ' +
          'apps/web/src/components/attachments/ReceiptFileInput.tsx is what buys the rest, ' +
          'and `hitSlop` defaults to true precisely because this call site needs it. Nothing ' +
          "about the control's appearance changes when this regresses, and NO other gate in " +
          'this repo can see it — the label is not a tap-target candidate.',
      ).toBe(true);
      for (const [axis, extent] of [
        ['VERTICAL', c.hit.b - c.hit.t],
        ['HORIZONTAL', c.hit.r - c.hit.l],
      ] as const) {
        expect(
          round(extent),
          `the /expenses receipt control "${c.name}" reaches only ${round(extent)}px on the ` +
            `${axis} axis, under the ${HIT_FLOOR_PX}px floor. Its painted box is ` +
            `${round(c.box.r - c.box.l)}x${round(c.box.b - c.box.t)} and the ring is what ` +
            'buys the difference. TWO THINGS PRODUCE THIS READING AND THEY NEED DIFFERENT ' +
            'REMEDIES: (a) the ring was dropped or narrowed at the call site — put it back; ' +
            '(b) the ring is intact and the inset is once again too small for the border. ' +
            'An inset is measured against the PADDING box, so on the bordered ' +
            "`UPLOAD_CHIP_ICON` a 32px square's ring spans 30 + 2 × inset. That is why the " +
            'inset is `-inset-[7px]` and not `-inset-1.5`: 6px gave 42 and shipped under the ' +
            'floor, 7px gives exactly 44. Widen the inset at `RECEIPT_HIT_SLOP` rather than ' +
            'relaxing this assertion, and mind the pair gap — at 7px the two rings abut ' +
            'exactly, so a wider one would overlap.',
        ).toBeGreaterThanOrEqual(HIT_FLOOR_PX);
      }
    }

    /**
     * ── THE TWO CONDITIONS `ReceiptFileInput` WRITES DOWN AND CALLS UNOBSERVABLE ────────
     *
     * Its file comment states both and then says "Neither condition is observable to any
     * gate in this repo — jsdom cannot measure geometry and no test can see a stolen tap —
     * which is exactly why they are written down here." That was true while the only gate
     * that could see a stolen tap was R1, and R1 works off the census these controls are not
     * in. Measured directly, both conditions are ordinary arithmetic:
     *
     *   · the pair's two rings must not overlap each other, or "Choose file" — later in DOM
     *     order — silently wins taps aimed at "Take photo";
     *   · the pair must clear its NEIGHBOUR's hit region, which here is "New report".
     *
     * `ExpenseReportsList.tsx` buys both with `pointer-coarse:gap-3` on the row, and says so
     * at length. This is the assertion that makes the comment enforceable: at `gap-2` the two
     * 6px rings overlap by 4px and both of these go red. `EPS` is the file's own tolerance —
     * abutting exactly is the designed state and is not an overlap.
     */
    expect(
      round(pair.library.hit.l - pair.camera.hit.r),
      "the two /expenses receipt controls' hit regions OVERLAP by " +
        `${round(pair.camera.hit.r - pair.library.hit.l)}px. "${pair.library.name}" is later ` +
        'in DOM order, so it wins the shared strip and steals taps aimed at ' +
        `"${pair.camera.name}" — with nothing visible to explain why. The row needs ` +
        '`pointer-coarse:gap-3` (12px) so the two 6px rings abut rather than collide; it was ' +
        'widened from `gap-2` for exactly this, in the slot ExpenseReportsList.tsx publishes.',
    ).toBeGreaterThanOrEqual(-EPS);
    expect(
      round(newReport.hit.l - pair.library.hit.r),
      `"${pair.library.name}"'s hit region reaches into ` +
        `${describeCandidate(newReport)} by ${round(pair.library.hit.r - newReport.hit.l)}px. ` +
        'A slopped control needs at least its own ring of clearance from any neighbour, and ' +
        '"New report" is the neighbour `ReceiptFileInput`\'s file comment names. The remedy ' +
        "is the CONTAINER — the row's `pointer-coarse:gap-3` — and NOT a narrower ring, " +
        'which would drop the pair below the floor asserted above. Note that R1 above cannot ' +
        'report this: one of the two parties is not a census candidate.',
    ).toBeGreaterThanOrEqual(-EPS);
  });

  /**
   * ── `/expenses/[reportId]`: THE REAL-BOX POPULATION, AND THE AXIS TRAP ──────────────────
   *
   * The one route in this file whose 44px targets are bought with a BOX rather than with a
   * pseudo-element, which is why it needs a guard of its own and why that guard looks
   * different from the four above.
   *
   * THE GATE ABOVE SAYS NOTHING ABOUT THESE CONTROLS, and that is not a defect in it.
   * `TapCandidate.floored` is read off the `::after`'s own `min-width` / `min-height`
   * (`e2e/support/tap-targets.ts:606-609`), so a control with no `::after` is `{vertical:
   * false, horizontal: false}` and the universal floor lane skips it entirely. P06's
   * controls are exactly that population: UX grepped the whole route and found not one
   * `icon-sm`, `icon-xs` or `size="xs"` on it — they are hand-rolled `<button>`s and `<a>`s
   * carrying no variant and therefore NO HIT SLOP AT ALL, short on both axes rather than
   * only the horizontal one, and `.einc-tap-slop` never reaches them. Phase 5 sized them
   * with `pointer-coarse:min-h-11` / `pointer-coarse:min-w-11` instead. So the floor claim
   * for this route has to be made here or it is made nowhere.
   *
   * ── THE AXIS TRAP, WHICH IS THE THING MOST LIKELY TO BE "FIXED" WRONGLY ────────────────
   *
   * `runUniversalGates` asserts the 44px floor PER AXIS, and only on the axes the element
   * declares a floor for. That is correct under the ruling and it is not an oversight:
   * `icon-sm` ships 32x44 and `icon-xs` 24x44 BY RULING, so a control that is 24px wide and
   * 44px tall is a PASS. The tempting addition to a new block is
   * `expect(width).toBeGreaterThanOrEqual(44)` applied to everything in sight, and it would
   * redden a correct build on four routes that have nothing to do with this one.
   *
   * SO THERE IS NO TWO-DIMENSION ASSERTION BELOW. Each axis is asserted only where the
   * control itself declares that axis' floor — `min-h-11` gates the height, `min-w-11` gates
   * the width, independently — which is the same rule the universal gate applies, read off a
   * class list instead of off a pseudo-element because that is where this route wrote it.
   *
   * ── THE SESSION, AND WHY IT IS NOT THE PROJECTS' ───────────────────────────────────────
   *
   * Both phone projects run as the seeded admin. The subject here is a DRAFT report belonging
   * to `qa.employee`, and `editable` — which gates every control this block measures — is
   * `canEdit && (DRAFT || RETURNED)`. Adopting the owner's session makes the population
   * unambiguous rather than contingent on which permissions the admin role happens to carry
   * this week; a role change would otherwise hollow this block out silently.
   */
  test.describe('/expenses/[reportId]: the real-box population', () => {
    test.use({ storageState: stateFileFor(REPORT_OWNER) });

    test('the 44px boxes P06 sized by hand, per axis', async ({ page }) => {
      // VeloExpense: SQL on the admin pool, in place of `@expenseos/db`'s
      // `expenseReport.findFirst`; the title is this run's (`seedTapFixture`).
      const db = await testDb('tap-targets.mobile');
      const report = (
        await db.query<{ id: string; status: string }>(
          'SELECT id, status FROM expense_report WHERE title = $1',
          [draftTitle],
        )
      ).rows[0];
      expect(
        report,
        `no ExpenseReport titled "${REPORT_TITLE}" in the database this run is pointed at. ` +
          'It is seeded by `seedQaActivity()` from packages/db/prisma/seed-data/qa-activity.json ' +
          '— so either the seed changed its title, the QA activity fixture was not applied, or ' +
          'DATABASE_URL is not set in the TEST process (the runner needs it as well as the ' +
          'server). See the `env-cmd` wrapper in the e2e invocation.',
      ).toBeTruthy();
      if (!report) return;
      /**
       * DRAFT, asserted rather than assumed. Every control below is behind `editable`, and a
       * seed that moved this row to SUBMITTED would leave the block measuring a read-only
       * page and reporting a hollow population — a true failure with a misleading cause.
       */
      expect(
        report.status,
        `"${REPORT_TITLE}" is ${report.status}, not DRAFT. Every control this block measures ` +
          'is behind `editable`, which is `canEdit && (DRAFT || RETURNED)`, so the population ' +
          'below would be empty for a reason that has nothing to do with tap targets. Point ' +
          'this block at another editable seeded report rather than lowering the guard.',
      ).toBe('DRAFT');

      const census = await runUniversalGates(page, {
        path: `/expenses/${report.id}`,
        why: 'the hand-rolled controls P06 sized to a real 44px box, with no ::after anywhere',
        /**
         * ── THE DISCLOSURE, WHICH IS WHERE THIS LANE'S SUBJECT NOW LIVES ────────────────
         *
         * The operator round made the expenses pane a DISCLOSURE below `lg`, collapsed on
         * arrival: the list container takes a `hidden` class until the `Expenses · n` header
         * is tapped (`ExpenseReportWorkbench.tsx:969`, `:2614-2618`). The census only holds
         * what a finger can reach on the first screenful — a `display: none` subtree is
         * rejected as invisible before any geometry is read — so without this tap the lane
         * censuses a page whose only hand-sized control is behind a control, and reports the
         * HOLLOW message its own text warns about ("if the controls moved behind an
         * interaction, point this lane at a new subject").
         *
         * This is the `arrive` the field header calls DELIBERATELY RARE, and it is on the
         * right side of that line: ONE press on a control that is on screen from first
         * paint, whose effect is a local state flip with
         * an explicit wait for the region it names in `aria-controls` — not a sequence of
         * gestures, and not a round trip. What it reaches genuinely does not exist in any
         * state the route can be navigated to: `expensesListOpen` is component state with no
         * URL, no storage key and no server half.
         *
         * `openExpenseList` is shared with `expense-workbench.mobile.spec.ts` rather than
         * copied, so the two agree about what "open" means and about what acknowledges the
         * press. It is idempotent on `aria-expanded`, so it is also the honest thing to run
         * before a census: it never toggles a list that is already open.
         */
        arrive: openExpenseList,
      });

      /**
       * ── THE ANTI-HOLLOWING GUARD ──────────────────────────────────────────────────────
       *
       * The subject is found by the SIZE UTILITIES, which is the lesson `/users` paid for:
       * a subject identified by the property under test disappears exactly when that
       * property regresses, and what goes red is then the count with a message about the
       * wrong thing. These classes ARE the property under test, so there is no third
       * attribute to find them by — which is why the count and the measurement are split,
       * and why the count's message says "losing its subject", not "the floor regressed".
       *
       * `getByRole`-invisible controls cannot be in this census at all (the candidate must
       * lie inside the visual viewport and win a hit test), so this number is what a finger
       * can reach on the first screenful, not what the route renders.
       */
      const sized = census.candidates.filter(
        (c) =>
          !c.disabled && (c.classes.includes(COARSE_MIN_H) || c.classes.includes(COARSE_MIN_W)),
      );
      expect(
        sized.length,
        'the /expenses/[reportId] real-box lane went HOLLOW: no censused control carries ' +
          `\`${COARSE_MIN_H}\` or \`${COARSE_MIN_W}\`. This is the gate losing its subject ` +
          'rather than the floor regressing. The route sizes its hand-rolled controls with ' +
          'those utilities because none of them carries a Button variant and `.einc-tap-slop` ' +
          'therefore never reaches them (see ExpenseReportWorkbench.tsx:208-216 and ' +
          '_workbench/parts.tsx:514-526). CHECK THE DISCLOSURE FIRST: below `lg` the whole ' +
          'expense list is collapsed on arrival and the subject is inside it, so a lane that ' +
          'reports hollow here most likely means the `arrive` above stopped opening it — a ' +
          'renamed `workbench.expensesToggle`, a dropped `aria-controls`, or the pane header ' +
          'no longer rendering a button. Otherwise: the report stopped being editable, the ' +
          'route was ruled `desktop`, or the controls moved behind a FURTHER interaction — in ' +
          'which case point this lane at a new subject rather than deleting the guard.',
      ).toBeGreaterThanOrEqual(1);

      /**
       * ── THE WIDTH FLOOR ON THE FIRST SCREENFUL ──────────────────────────────────────────
       *
       * This used to be the block's only both-axes guard, and then it was not. Its subject was
       * "Add expense": a `size="sm"` (`h-9`, 36px) button whose label goes to
       * `pointer-coarse:sr-only`, leaving an 18px glyph in 12+18+12 = 42px of padding, 8px
       * short vertically and 2px short horizontally, so both minimums are load-bearing. The
       * P06 operator round cloaked it `hidden lg:contents` below `lg`, because what it creates
       * is an EMPTY expense and every field that would fill it in was cloaked on a phone too.
       * P18 brought those fields, the line block and the button back at every width, so
       * "Add expense" is a phone control again and its both-axes guard is restored, as CENSUS B
       * below. It is censused there rather than here because it sits in the Expenses card
       * header, and whether that header is inside the first screenful with the list open
       * depends on the width and on how tall the summary and the action bar render.
       *
       * WHAT THIS CENSUS HOLDS. With the disclosure open, the hand-sized control it can rely
       * on is the expense row's PAPERCLIP (`parts.tsx:514-526`), 44px wide by
       * `pointer-coarse:min-w-11` against an unsized 16px glyph, so the minimum is doing all
       * of the work. Its height is bought by `self-stretch` off the row and not by a class,
       * which is why it declares the horizontal floor only and why the per-axis loop below
       * correctly measures one axis on it. "Add expense" joins `sized` here too whenever it is
       * on this screenful, and the loop then measures both of its axes.
       *
       * The guard pins WHICH AXIS the on-screen population is expected to floor: a build that
       * dropped the paperclip's `min-w-11` and kept a height-only control would satisfy the
       * count above and fail here, which is the whole distinction the `/users` lesson in the
       * hollowness comment is about.
       *
       * The receipt sheet's "Close" (`parts.tsx:2049`) and its delete-receipt button
       * (`parts.tsx:2372`, a both-axes one) are real and are NOT being waived: they are inside
       * a `Drawer` that only exists once the paperclip has been pressed, which is a second
       * interaction on a second surface and past where this file lets a geometry gate go (see
       * the `arrive` note in the field header). Their floor is owed a lane of its own.
       */
      const widthFloored = sized.filter((c) => c.classes.includes(COARSE_MIN_W));
      expect(
        widthFloored.length,
        'no censused control on this route floors its WIDTH with a real box. The expense ' +
          "row's paperclip is the one that should — it is a 16px glyph whose 44px comes " +
          'entirely from `pointer-coarse:min-w-11`, so the minimum is the only thing between ' +
          'it and a 16px target. A zero here means the class came off that button, or the ' +
          'disclosure `arrive` above stopped opening the list, or the row affordance moved. ' +
          'The both-axes subject, "Add expense", is measured separately in census B below.',
      ).toBeGreaterThanOrEqual(1);

      /**
       * ── THE MEASUREMENT, PER AXIS, ON THE AXIS THE CONTROL DECLARES ───────────────────
       *
       * Read the file comment above before adding anything to this loop. There is no
       * `width >= 44` for a control that only declares a height, and adding one would fail a
       * correct build — `icon-sm` is 32x44 and `icon-xs` is 24x44 by ruling.
       *
       * The BOX is measured, not the hit rectangle, and that is the whole difference from the
       * universal lane: these controls have no `::after` to reach outside themselves, so
       * `box` and `hit` are the same rectangle and the 44px has to be in the box or it is
       * nowhere. If one of them ever grows a slop class, the universal gate above starts
       * measuring it too and the two agree.
       */
      const expectDeclaredBoxFloors = (candidates: readonly TapCandidate[]): void => {
        for (const c of candidates) {
          if (c.classes.includes(COARSE_MIN_H)) {
            const height = round(c.box.b - c.box.t);
            expect(
              height,
              `${describeCandidate(c)} on /expenses/[reportId] declares \`${COARSE_MIN_H}\` and ` +
                `renders ${height}px tall. The minimum is not resolving: either the rule left ` +
                'the `@media (pointer: coarse)` block, or a parent is constraining the control ' +
                'below its own minimum (a fixed-height `h-12` bar squeezing a 44px child is how ' +
                'this fails without any class changing).',
            ).toBeGreaterThanOrEqual(HIT_FLOOR_PX);
          }
          if (c.classes.includes(COARSE_MIN_W)) {
            const width = round(c.box.r - c.box.l);
            expect(
              width,
              `${describeCandidate(c)} on /expenses/[reportId] declares \`${COARSE_MIN_W}\` and ` +
                `renders ${width}px wide. Note this assertion is scoped to controls that declare ` +
                'the HORIZONTAL floor themselves — do not widen it to every candidate, because ' +
                '`icon-sm` ships 32x44 and `icon-xs` 24x44 by ruling and both are correct.',
            ).toBeGreaterThanOrEqual(HIT_FLOOR_PX);
          }
        }
      };
      expectDeclaredBoxFloors(sized);

      /**
       * ── CENSUSES B AND C: THE CONTROLS P18 BROUGHT BACK TO THE PHONE ───────────────────
       *
       * P18 un-cloaked "Add expense", the expense's own fields and the line block below `lg`,
       * and gave the hand-rolled ones a real 44px box at a coarse pointer, the same way P06
       * sized this route's other controls. None of them is on a screenful the census above can
       * be relied on to hold, so each is scrolled to and censused on its own, the two-census
       * shape the `/virtual-cards/transactions` attach lane already uses. Nothing is PRESSED:
       * "Add expense" would write a blank expense onto a shared seeded report, and "Add line"
       * would open a draft row.
       *
       * NO UNIVERSAL GATES ON THESE TWO, deliberately, and for that lane's reason: each is a
       * partial view of the page, scrolled to put one subject in it, so a population floor or
       * an R1 pass would be about whatever else the scroll happened to bring along. The guard
       * is the named subject, and the measurement is the per-axis box floor above, applied to
       * whatever the subject itself declares.
       *
       * THE SUBJECT IS FOUND BY NAME, NOT BY THE SIZE CLASS, wherever the name is unique: the
       * `/users` lesson again. The classes are then asserted separately, so a dropped class
       * reads as "the floor came off this control" and not as "the control is missing".
       */
      const settleFrame = () =>
        page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));

      /* ── CENSUS B: "Add expense", the both-axes subject, back on the phone. ───────────── */
      const addExpenseControl = page.getByRole('button', { name: ADD_EXPENSE, exact: true });
      await expect(
        addExpenseControl,
        `no "${ADD_EXPENSE}" control on /expenses/[reportId] at a phone width. P18 took its ` +
          '`hidden lg:contents` cloak off in ExpenseReportWorkbench.tsx, so it should be in the ' +
          'Expenses card header at every width on a draft. Either the cloak came back, or the ' +
          'report stopped being editable.',
      ).toBeVisible({ timeout: 30_000 });
      await addExpenseControl.scrollIntoViewIfNeeded();
      await settleFrame();
      const censusB = await censusOf(page);
      const plus = censusB.candidates.filter((c) => !c.disabled && c.name === ADD_EXPENSE);
      expect(
        plus.length,
        `the "${ADD_EXPENSE}" lane went HOLLOW: the locator above found the control visible ` +
          'and the census after scrolling to it holds no enabled candidate by that name. Check ' +
          'the off-viewport and clipped counts, or whether its label stopped being the text of ' +
          'its `pointer-coarse:sr-only` span. Point the lane at the new subject rather than ' +
          'deleting the guard.',
      ).toBeGreaterThanOrEqual(1);
      for (const c of plus) {
        expect(
          [c.classes.includes(COARSE_MIN_H), c.classes.includes(COARSE_MIN_W)],
          `${describeCandidate(c)} should declare both \`${COARSE_MIN_H}\` and ` +
            `\`${COARSE_MIN_W}\`. It is \`size="sm"\` (36px tall) with its label sr-only at a ` +
            'coarse pointer, so it is an 18px glyph in 42px of padding: BOTH minimums are ' +
            'load-bearing (ExpenseReportWorkbench.tsx, the "Add expense" call site).',
        ).toEqual([true, true]);
      }
      expectDeclaredBoxFloors(plus);

      /* ── CENSUS C: the line block — "Add line" and the saved line's delete. ───────────── */
      /**
       * "Add line" is parked at the vertical CENTRE of the viewport rather than merely brought
       * into view, so the saved line directly above it (the seeded report's one hotel line)
       * is on the same screenful, delete button included. `scrollIntoView` moves `main`, the
       * shell's scroller, and every scroller between.
       */
      const addLineControl = page.getByRole('button', { name: ADD_LINE, exact: true });
      await expect(
        addLineControl,
        `no "${ADD_LINE}" control in the expense editor at a phone width. P18 took the line ` +
          "block's `hidden lg:contents` cloak off in _workbench/parts.tsx, so it renders at " +
          'every width on a draft. Either the cloak came back, or the editor has no expense ' +
          'selected.',
      ).toBeVisible({ timeout: 30_000 });
      await addLineControl.evaluate((el) => el.scrollIntoView({ block: 'center' }));
      await settleFrame();
      const censusC = await censusOf(page);

      const addLine = censusC.candidates.filter((c) => !c.disabled && c.name === ADD_LINE);
      expect(
        addLine.length,
        `the "${ADD_LINE}" lane went HOLLOW: the control was scrolled to the centre of the ` +
          'viewport and the census holds no enabled candidate by that name. Check the ' +
          'off-viewport and clipped counts. Point the lane at the new subject rather than ' +
          'deleting the guard.',
      ).toBeGreaterThanOrEqual(1);
      for (const c of addLine) {
        expect(
          c.classes.includes(COARSE_MIN_H),
          `${describeCandidate(c)} should declare \`${COARSE_MIN_H}\`: it is a \`size="sm"\` ` +
            "36px button and a phone's primary action in the pane, so its 44px has to be a " +
            'real box (_workbench/parts.tsx, the "Add line" button).',
        ).toBe(true);
      }
      expectDeclaredBoxFloors(addLine);

      /**
       * The line's delete is found by its classes, which is the `sized` trade-off above made
       * on purpose: its name, "Delete", is shared with the EXPENSE's delete in the editor
       * header, which carries no floor at all, so a name filter cannot tell the two apart. A
       * zero here is therefore either the class coming off the line's delete, or the line row
       * not being on this screenful, and the message says both.
       */
      const lineDelete = censusC.candidates.filter(
        (c) =>
          !c.disabled &&
          c.name === LINE_DELETE &&
          c.classes.includes(COARSE_MIN_H) &&
          c.classes.includes(COARSE_MIN_W),
      );
      expect(
        lineDelete.length,
        `no "${LINE_DELETE}" control with both \`${COARSE_MIN_H}\` and \`${COARSE_MIN_W}\` ` +
          `next to "${ADD_LINE}". The saved line's delete is a 14px glyph in a \`h-10\` flex ` +
          'item, so both minimums are load-bearing (_workbench/parts.tsx, `LineItemRow`). ' +
          'Either a class came off it, or the seeded line is no longer directly above ' +
          `"${ADD_LINE}" (the report "${REPORT_TITLE}" should carry one hotel line).`,
      ).toBeGreaterThanOrEqual(1);
      expectDeclaredBoxFloors(lineDelete);
    });
  });
});
