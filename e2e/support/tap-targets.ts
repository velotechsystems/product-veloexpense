import { expect, type Page, type TestInfo } from '@playwright/test';

/**
 * The interactive-candidate census, and the hit-region geometry derived from it.
 *
 * Consumed by `e2e/tap-targets.mobile.spec.ts` (the coarse-pointer gates) and
 * `e2e/tap-targets-desktop.spec.ts` (the fine-pointer inverse). One module rather than a
 * sibling pair, deliberately: the enumeration, the geometry and the failure-message
 * formatting are one measurement, and splitting them would put the two halves of a single
 * number in different files. `e2e/support/safe-area.ts` sets the same precedent — the CDP
 * mechanism, the fixture constants and the project guard live together there because they
 * are one concern.
 *
 * ─── THE ONE HARDCODED NUMBER, AND WHY IT IS THE ONLY ONE ────────────────────────────────
 *
 * `HIT_FLOOR_PX = 44`. Everything else — every control's size, every per-side slop, every
 * hit rectangle — is MEASURED off the page. That asymmetry is the whole design. A spec that
 * carried a size→slop table ("`icon-sm` is 32px and slops 6px a side") would assert the
 * table against itself: change the `h-8` and the table changes with it, green throughout.
 * Reading the slop off the pseudo-element and comparing it to an EXTERNAL 44 is what makes
 * the gate say something. 44px is WCAG 2.2 SC 2.5.5 and the Apple HIG minimum; it comes
 * from outside this repo, which is the point.
 *
 * `EPS = 0.5` is the second and last constant. It exists because the designed geometry
 * includes exact TANGENCY — a 6px slop meeting a 6px gutter — and a closed-interval overlap
 * test calls tangency a violation. See `EPS` below.
 *
 * ─── HOW THE HIT RECTANGLE IS DERIVED ────────────────────────────────────────────────────
 *
 * The slop is an absolutely positioned `::after` that overflows its control (the rule is in
 * `packages/design-system/src/globals.css`, inside `@media (pointer: coarse)`). It is not a
 * node, so it has no `getBoundingClientRect`. It is reconstructed from two measurements:
 *
 *   1. Its USED SIZE, read as `height` / `width` off `getComputedStyle(el, '::after')`.
 *      Chrome resolves both to used values for a rendered pseudo-element, so a `height:100%;
 *      min-height:44px` on a 32px control reads back `44px` — verified, not assumed.
 *   2. Its POSITION, which is not read at all. It is derived: the pseudo is CENTRED ON THE
 *      ELEMENT'S PADDING BOX.
 *
 * Point 2 is the load-bearing one, and it is one rule with no branches. For the vertical-only
 * variant the CSS says `left: 0; width: 100%`, which spans the padding box exactly — that is
 * "centred on the padding box" with zero overhang. For `-both` it says `left: 50%;
 * min-width: 44px; transform: translate(-50%,-50%)`, which is the same statement with a
 * floor. Vertically both say `top: 50%; translateY(-50%)`. So one construction covers both
 * classes, and the test never asks which class an element carries in order to place its
 * rectangle.
 *
 * THE OFFSET PROPERTIES ARE NEVER READ, and `globals.css` says why at the rule itself:
 * `getComputedStyle` reports `top` / `bottom` / `left` / `right` as resolved used values
 * whether or not they were specified, so on a 32px control `top` reads `16px` — the
 * percentage BEFORE the transform that does the actual centring — and `bottom` reads
 * `-28px` despite being `auto`. Reconstructing a rectangle from those four numbers gets the
 * wrong answer in a way that looks arithmetically fine.
 *
 * ─── WHY THE PADDING BOX AND NOT THE BORDER BOX — THE ASYMMETRY THAT BREAKS NAIVE CODE ───
 *
 * An absolutely positioned child resolves percentage sizes and offsets against its
 * containing block, which for a `position: relative` originating element is that element's
 * PADDING BOX — borders excluded. On a control with no border, or with a symmetric one, the
 * padding box is concentric with the border box and the slop comes out even on both sides.
 * On a control with a ONE-SIDED border it does not.
 *
 * The live case is the design-system `Tabs` button, which carries `border-b-2`. Its padding
 * box sits 2px high inside its border box, so the centred pseudo-element inherits that
 * offset and the overhang splits UNEVENLY — measured 4px above and 2px below on a 38px tab.
 * Computing a per-side slop as `(44 - rendered) / 2` gets 3/3 and is wrong on both sides.
 *
 * So each side is derived independently, as the distance from the control's own border-box
 * edge to the corresponding edge of the union rectangle. No division by two appears anywhere
 * in this file.
 *
 * ─── WHAT A CANDIDATE IS, AND THE TWO FILTERS THAT ARE NOT OBVIOUS ───────────────────────
 *
 * `CANDIDATE_SELECTOR` is the interactive surface: real controls plus the ARIA roles that
 * make a `div` into one. Two filters beyond the obvious display/visibility/size ones:
 *
 *   · IN-VIEWPORT ONLY. A candidate's border box must lie entirely inside the visual
 *     viewport. Hit-testing cannot reach anything else — `elementFromPoint` is viewport
 *     coordinates and returns `null` outside it — so an off-screen control cannot be probed
 *     and must not be silently scored as passing. The count of what this excluded is
 *     returned in the census so a route that scrolled its own controls out of reach reads as
 *     a smaller population rather than as a green run.
 *
 *   · HIT-TESTABLE ONLY, decided by `elementsFromPoint` STACK MEMBERSHIP rather than by a
 *     bounding box. This one was paid for. `AppShell`'s skip link is Tailwind `sr-only`
 *     (`clip-path: inset(50%)`) but also carries `px-3 py-2`, and the padding wins the
 *     cascade — so it reports a 24x16 bounding box at (-1,-1) that overlaps the hamburger's
 *     hit region by 17x7 on EVERY route. It is not a real collision: `clip-path` removes it
 *     from hit-testing entirely, and no probe anywhere in its own box ever resolves to it.
 *     A bounding-box census reports that phantom as an R1 violation forever.
 *
 *     `elementsFromPoint` returns the whole stack at a point, not just the top of it, which
 *     is exactly the discriminator needed here: an element that is merely COVERED by another
 *     still appears in the stack below it (and being covered is the violation we are hunting,
 *     so it must stay in the census), while an element removed from hit-testing does not
 *     appear at all. Clipped-away, `pointer-events: none`, and genuinely-occluded are three
 *     different states and this separates the first two from the third.
 *
 * ─── COMPOSED CONTROLS ───────────────────────────────────────────────────────────────────
 *
 * A control fully CONTAINED inside another control's box is a composed widget, not a theft —
 * the date picker's trigger button sits inside its input's box on `/analytics` and on
 * `/admin/platform`, and tapping it is the correct outcome. Containment is the
 * discriminator, and it is structural rather than a guess about intent: slop reaches a few
 * pixels OUTSIDE a neighbour's box by construction and can never be contained in it. Every
 * exemption taken is counted and returned, so the census says how often it fired.
 */

/**
 * WCAG 2.2 SC 2.5.5 / Apple HIG. The only hardcoded number in the geometry, and external to
 * this repo on purpose — see the header.
 */
export const HIT_FLOOR_PX = 44;

/**
 * The open-interior tolerance, in CSS pixels.
 *
 * Overlap is evaluated on the OPEN interior: two rectangles that share an edge do not
 * overlap. That is not a rounding allowance, it is the designed geometry. The shell's
 * notification bell reaches 6px sideways across the top bar's 6px `gap-1.5` gutter, so its
 * hit region meets its neighbour's EXACTLY — measured at a 0px gap. A closed-interval test
 * reports that designed tangency as a violation on every route that publishes a top-bar
 * control, and the fix a reader would reach for (widen the gutter) is the wrong one.
 *
 * 0.5px rather than 0 because the layout is sub-pixel: control widths on these routes are
 * things like 132.296875px, and a tangency computed from two of those lands near zero rather
 * than on it.
 *
 * The tangency is ALSO asserted positively, in the mobile spec, so that this tolerance
 * cannot quietly absorb a gutter that narrowed. Tolerating tangency and requiring it are
 * different claims and both are made.
 */
export const EPS = 0.5;

/** How far outside an unslopped edge the negative probe samples. */
const NEGATIVE_PROBE_PX = 2;

/**
 * The interactive surface.
 *
 * Real controls plus the ARIA roles that make a non-control into one. `[tabindex]` last and
 * `-1` excluded: a programmatic focus target is not a tap target.
 */
const CANDIDATE_SELECTOR = [
  'button',
  'a[href]',
  'input:not([type="hidden"])',
  'select',
  'textarea',
  'summary',
  '[role="button"]',
  '[role="tab"]',
  '[role="link"]',
  '[role="checkbox"]',
  '[role="switch"]',
  '[role="radio"]',
  '[role="menuitem"]',
  '[role="menuitemcheckbox"]',
  '[role="menuitemradio"]',
  '[role="option"]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/**
 * ARIA roles that make an element a CONTAINER, never a tap target.
 *
 * `[tabindex]` in the selector above is what makes this necessary. It is there to catch
 * hand-rolled controls that are focusable without being a `<button>`, and it also sweeps in
 * every focusable WRAPPER — React Flow gives each graph node on
 * `/admin/approval-workflows/[id]` a focusable `div[role="group"]` around the node's own
 * controls. Probing a container's interior finds its children, correctly, and reports every
 * one of them as a stolen tap. A group is not something a finger aims at; the things inside
 * it are, and they are censused on their own.
 */
const CONTAINER_ROLES = new Set([
  'group',
  'presentation',
  'none',
  'application',
  'document',
  'region',
  'list',
  'listitem',
  'row',
  'rowgroup',
  'grid',
  'table',
  'toolbar',
  'tablist',
  'menu',
  'menubar',
  'tabpanel',
  'dialog',
  'figure',
  'article',
  'form',
  'search',
  'navigation',
]);

/** A rectangle in viewport CSS pixels. `t`/`b` grow downward. */
export interface Rect {
  l: number;
  r: number;
  t: number;
  b: number;
}

/** One probe of `document.elementFromPoint`. */
export interface Probe {
  x: number;
  y: number;
  /** `null` when the point fell outside the viewport, or on nothing. */
  hit: string | null;
  /** Index of the CANDIDATE that was hit, when the hit element is one or is inside one.
   *  `null` for a hit on non-interactive chrome. Lets a violation name its thief
   *  structurally rather than by parsing a description. */
  hitIndex: number | null;
  /** The hit element's top-bar `data-chrome` / `data-zone`, read straight off the DOM rather
   *  than via the census. A thief is often NOT a candidate — the workflow editor's overflowing
   *  toolbar is laid out at a negative left edge, so it is off-viewport and uncensused while
   *  still winning every hit test in the left zone. Without these, a pin about that mechanism
   *  would have nothing to match on but a label. */
  hitChrome: string | null;
  hitZone: string | null;
  /** The hit element is the candidate itself or one of its descendants. */
  isSelf: boolean;
  /** The hit element's box is fully inside the candidate's box — a composed sub-control. */
  isContained: boolean;
}

export interface TapCandidate {
  /** Stable within one census, for naming a partner in a failure message. */
  index: number;
  tag: string;
  role: string | null;
  /** Accessible name, best-effort: `aria-label`, else trimmed text. */
  name: string;
  /**
   * The measured descriptor used wherever this suite says "size class". The cva size name
   * (`sm`, `icon-xs`, …) is not in the DOM — only the utilities it expands to are — so this
   * is the slop class plus the measured border box, which is what a reader needs to find the
   * control anyway.
   */
  sizeLabel: string;
  /** `both` / `vertical` / `none`, read off the class list for reporting only. Nothing in
   *  the geometry branches on it — see the header. */
  slopClass: 'both' | 'vertical' | 'none';
  /** The element's class tokens. Used ONLY by the per-class floor guards, to find a control
   *  by the size utility that the slop is wired to (`h-7` for `Button size="xs"`) rather than
   *  by the slop class itself — a subject identified by its slop class disappears the moment
   *  the slop class is dropped, which is precisely the regression the guard exists to catch. */
  classes: string[];
  /** `disabled` or `aria-disabled="true"`. An obstruction, but never a victim. */
  disabled: boolean;
  /** The control's own visible box. */
  box: Rect;
  /** The reconstructed `::after` rectangle, or `null` where there is no pseudo-element. */
  pseudo: Rect | null;
  /** `box` ∪ `pseudo`. What a finger can reach. */
  hit: Rect;
  /** Per-side reach of `hit` beyond `box`. Derived independently per side. */
  reach: { up: number; down: number; left: number; right: number };
  /** Which axes the pseudo-element FLOORS, read from its own `min-width` / `min-height`
   *  rather than from the class name — `min-height: 44px` means the vertical axis is
   *  floored. `default`-size buttons floor the horizontal axis too, and satisfy it with
   *  their own width rather than with slop; that is a pass, not an exemption. */
  floored: { vertical: boolean; horizontal: boolean };
  /** The top bar's `data-zone` this control sits in, or `null` outside the header. `TopBar.tsx`
   *  maintains those attributes as a testability seam rather than as decoration, and this is
   *  the seam being used. */
  zone: string | null;
  /** The top bar's `data-chrome` — `page` for whatever a route published into a slot, `shell`
   *  for the shell's own controls. `null` outside the header. */
  chrome: string | null;
  /** The nine strictly-interior points, and what each resolved to. */
  interiorProbes: Probe[];
  /** Points `NEGATIVE_PROBE_PX` outside each side whose measured reach is <= EPS. */
  negativeProbes: { side: 'up' | 'down' | 'left' | 'right'; probes: Probe[] }[];
}

export interface TapCensus {
  /** `matchMedia('(pointer: coarse)')`, read in the page. The took-effect guard. */
  coarse: boolean;
  fine: boolean;
  viewport: { width: number; height: number };
  candidates: TapCandidate[];
  /** Why elements were dropped, so a shrunken population is legible rather than silent. */
  rejected: {
    invisible: number;
    zeroSize: number;
    offViewport: number;
    /** Partly outside a scrolling/clipping ancestor, so partly not hit-testable. */
    clipped: number;
    notHitTestable: number;
  };
}

/**
 * The whole measurement, in one `page.evaluate`.
 *
 * One pass rather than a locator-per-control loop, for two reasons. Every number in a census
 * has to come from ONE layout state — a census assembled across round trips can pair a
 * rectangle measured before a font swapped with one measured after, and report an overlap
 * that never existed. And the nine-point probe is `document.elementFromPoint`, which has no
 * Playwright equivalent that returns what was hit rather than acting on it.
 */
function collectCensus(args: {
  selector: string;
  eps: number;
  negativePx: number;
  containerRoles: string[];
}): TapCensus {
  const { selector, eps, negativePx } = args;
  const containerRoles = new Set(args.containerRoles);
  const num = (s: string): number => {
    const n = Number.parseFloat(s);
    return Number.isNaN(n) ? 0 : n;
  };
  const describe = (el: Element | null): string | null => {
    if (!el) return null;
    const role = el.getAttribute('role');
    const label = el.getAttribute('aria-label') || (el.textContent || '').trim();
    return `${el.tagName.toLowerCase()}${role ? `[${role}]` : ''}"${label.slice(0, 40)}"`;
  };

  /**
   * Next's DEV OVERLAY is not part of the product, and it is on top of it.
   *
   * `next dev` mounts a `<nextjs-portal>` custom element carrying the build-activity
   * indicator and the error overlay. It is `position: fixed`, it wins hit-testing wherever it
   * sits, and it does not exist in a production build — so a probe that resolves to it is an
   * artifact of the harness, not a fact about the app. Left alone it reports the bottom-left
   * corner of every route as a stolen tap, and it would do so on a developer's machine and
   * not in CI, which is the worst possible shape for a gate.
   *
   * Resolution therefore looks THROUGH it: `elementsFromPoint` gives the whole stack and the
   * first entry that is not inside the overlay is what a user would actually hit. This cannot
   * mask a product regression — nothing in `apps/web` renders a `nextjs-*` element.
   */
  const isDevOverlay = (n: Element | null): boolean => {
    for (let p: Element | null = n; p; p = p.parentElement) {
      if (p.tagName.toLowerCase().startsWith('nextjs-')) return true;
    }
    return false;
  };
  const topAt = (x: number, y: number): Element | null =>
    document.elementsFromPoint(x, y).find((n) => !isDevOverlay(n)) ?? null;

  const rejected = { invisible: 0, zeroSize: 0, offViewport: 0, clipped: 0, notHitTestable: 0 };
  const kept: { el: Element; box: Rect; pseudo: Rect | null }[] = [];

  for (const el of Array.from(document.querySelectorAll(selector))) {
    /**
     * SVG content is out of scope, and not as a convenience.
     *
     * Every measurement in this file is CSS box model — border box, padding box, an
     * `::after` sized against a containing block. None of it describes SVG, whose hit area
     * follows its own geometry: a React Flow edge on `/admin/approval-workflows/[id]` is a
     * `<g tabindex="0">` reporting a 1.72x25.5 bounding box while its stroke is hit-testable
     * several pixels either side of it. Measured against its box it looks like a control with
     * mysterious horizontal slop, which is a false reading of a true fact. The tap-slop
     * classes are never applied to SVG, so nothing this file gates is being skipped.
     */
    if (el.namespaceURI === 'http://www.w3.org/2000/svg') {
      rejected.invisible += 1;
      continue;
    }
    // An ARIA container is not a tap target. See CONTAINER_ROLES.
    const declaredRole = el.getAttribute('role');
    if (declaredRole && containerRoles.has(declaredRole)) {
      rejected.invisible += 1;
      continue;
    }
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') {
      rejected.invisible += 1;
      continue;
    }
    // `pointer-events: none` is deliberately NOT filtered here. The stack test below drops
    // it anyway — such an element never appears in `elementsFromPoint` — and letting it fall
    // out there rather than here is what makes the disabled asymmetry correct rather than
    // stipulated. A `<Button disabled>` carries `disabled:pointer-events-none`, so taps pass
    // THROUGH it: it is not an obstruction, and the census says so by not holding it. An
    // `aria-disabled` control keeps its pointer events, stays in the census, and is therefore
    // an obstruction — while still being exempt as a victim, which the gate applies
    // separately. "Obstructions but not victims" is two different facts and they come from
    // two different places.
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) {
      rejected.zeroSize += 1;
      continue;
    }
    /**
     * Entirely REACHABLE: inside the visual viewport, and not cut off by any scrolling or
     * clipping ancestor.
     *
     * The viewport half is obvious — `elementFromPoint` takes viewport coordinates and
     * returns `null` outside them. The clipping half is not, and it was found by a false
     * positive: the row-actions button at the bottom of the employee table on `/users` sits
     * partly below its scroll container's edge, so the lower third of its box is not painted
     * and not hit-testable, and probing there resolves to the scroller. Reported as a stolen
     * tap it is nonsense — nothing stole anything, the control is simply half scrolled away —
     * and worse, it is TIMING-DEPENDENT, because which row lands on the boundary depends on
     * how much data arrived.
     *
     * So the clip chain is walked and intersected, starting from the viewport, and a
     * candidate whose box is not wholly inside the result is dropped and counted. Anything
     * partly out of reach is not measured rather than measured wrongly.
     */
    let clip: Rect = { l: 0, t: 0, r: window.innerWidth, b: window.innerHeight };
    for (let anc = el.parentElement; anc; anc = anc.parentElement) {
      const acs = getComputedStyle(anc);
      if (acs.overflowX === 'visible' && acs.overflowY === 'visible') continue;
      const ar = anc.getBoundingClientRect();
      clip = {
        l: Math.max(clip.l, ar.left),
        t: Math.max(clip.t, ar.top),
        r: Math.min(clip.r, ar.right),
        b: Math.min(clip.b, ar.bottom),
      };
    }
    const insideViewport =
      r.left >= -eps &&
      r.top >= -eps &&
      r.right <= window.innerWidth + eps &&
      r.bottom <= window.innerHeight + eps;
    const insideClip =
      r.left >= clip.l - eps &&
      r.top >= clip.t - eps &&
      r.right <= clip.r + eps &&
      r.bottom <= clip.b + eps;
    if (!insideViewport) {
      rejected.offViewport += 1;
      continue;
    }
    if (!insideClip) {
      rejected.clipped += 1;
      continue;
    }
    // Hit-testable at all? Stack membership, not the top of the stack — an occluded control
    // is still a candidate (and its occlusion is the thing we are hunting), a clipped-away
    // one is not a control at all. See the header's skip-link note.
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const stack = document.elementsFromPoint(cx, cy);
    if (!stack.some((n) => n === el || el.contains(n))) {
      rejected.notHitTestable += 1;
      continue;
    }

    const box: Rect = { l: r.left, r: r.right, t: r.top, b: r.bottom };
    const after = getComputedStyle(el, '::after');
    let pseudo: Rect | null = null;
    if (after.content !== 'none' && after.content !== '' && after.content !== 'normal') {
      // The padding box: the pseudo-element's containing block, borders excluded. This is
      // the line that produces the tabs' asymmetric split.
      const pl = r.left + num(cs.borderLeftWidth);
      const pr = r.right - num(cs.borderRightWidth);
      const pt = r.top + num(cs.borderTopWidth);
      const pb = r.bottom - num(cs.borderBottomWidth);
      const pw = num(after.width);
      const ph = num(after.height);
      const ccx = (pl + pr) / 2;
      const ccy = (pt + pb) / 2;
      pseudo = { l: ccx - pw / 2, r: ccx + pw / 2, t: ccy - ph / 2, b: ccy + ph / 2 };
    }
    kept.push({ el, box, pseudo });
  }

  const candidates: TapCandidate[] = kept.map(({ el, box, pseudo }, index) => {
    const after = getComputedStyle(el, '::after');
    const hit: Rect = pseudo
      ? {
          l: Math.min(box.l, pseudo.l),
          r: Math.max(box.r, pseudo.r),
          t: Math.min(box.t, pseudo.t),
          b: Math.max(box.b, pseudo.b),
        }
      : { ...box };
    const reach = {
      up: box.t - hit.t,
      down: hit.b - box.b,
      left: box.l - hit.l,
      right: hit.r - box.r,
    };

    const probeAt = (x: number, y: number): Probe => {
      if (x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) {
        return {
          x,
          y,
          hit: null,
          hitIndex: null,
          hitChrome: null,
          hitZone: null,
          isSelf: false,
          isContained: false,
        };
      }
      // `topAt`, not `elementFromPoint`: Next's dev overlay is not part of the product and
      // must not be reported as having stolen anything. See `isDevOverlay`.
      const h = topAt(x, y);
      if (!h) {
        return {
          x,
          y,
          hit: null,
          hitIndex: null,
          hitChrome: null,
          hitZone: null,
          isSelf: false,
          isContained: false,
        };
      }
      const hr = h.getBoundingClientRect();
      // Which candidate did we land on, if any? Resolved against the kept list so a
      // violation can name its thief structurally instead of by string-matching a label.
      const hitIndex = kept.findIndex((k) => k.el === h || k.el.contains(h));
      return {
        x,
        y,
        hit: describe(h),
        hitIndex: hitIndex === -1 ? null : hitIndex,
        hitChrome: h.closest('[data-chrome]')?.getAttribute('data-chrome') ?? null,
        hitZone: h.closest('[data-zone]')?.getAttribute('data-zone') ?? null,
        isSelf: h === el || el.contains(h),
        // Fully inside the candidate's own box => a composed sub-control, not a theft.
        isContained:
          hr.left >= box.l - eps &&
          hr.right <= box.r + eps &&
          hr.top >= box.t - eps &&
          hr.bottom <= box.b + eps,
      };
    };

    const interiorProbes: Probe[] = [];
    for (const fx of [0.15, 0.5, 0.85]) {
      for (const fy of [0.15, 0.5, 0.85]) {
        interiorProbes.push(probeAt(box.l + (box.r - box.l) * fx, box.t + (box.b - box.t) * fy));
      }
    }

    /**
     * The negative probe, on the sides that measured no reach.
     *
     * SCOPED TO CONTROLS THAT HAVE A PSEUDO-ELEMENT, deliberately: the
     * claim is "this control slops the axis it is supposed to and NOT the other one", and a
     * control with no slop at all has no such claim to make. Running it on everything is not
     * merely wasteful, it is wrong — it asserts a general "no element's hit area exceeds its
     * bounding box" that plenty of correct DOM does not satisfy, starting with any element
     * whose visible box is smaller than its pointer target for reasons of its own.
     *
     * A side is "unslopped" by MEASUREMENT — its reach is nil — rather than by class name, so
     * the probe and the thing it is checking cannot disagree about which sides they mean.
     */
    const negativeProbes: TapCandidate['negativeProbes'] = [];
    const along = pseudo ? [0.25, 0.5, 0.75] : [];
    if (reach.up <= eps) {
      negativeProbes.push({
        side: 'up',
        probes: along.map((f) => probeAt(box.l + (box.r - box.l) * f, box.t - negativePx)),
      });
    }
    if (reach.down <= eps) {
      negativeProbes.push({
        side: 'down',
        probes: along.map((f) => probeAt(box.l + (box.r - box.l) * f, box.b + negativePx)),
      });
    }
    if (reach.left <= eps) {
      negativeProbes.push({
        side: 'left',
        probes: along.map((f) => probeAt(box.l - negativePx, box.t + (box.b - box.t) * f)),
      });
    }
    if (reach.right <= eps) {
      negativeProbes.push({
        side: 'right',
        probes: along.map((f) => probeAt(box.r + negativePx, box.t + (box.b - box.t) * f)),
      });
    }

    const slopClass: TapCandidate['slopClass'] = el.classList.contains('einc-tap-slop-both')
      ? 'both'
      : el.classList.contains('einc-tap-slop')
        ? 'vertical'
        : 'none';
    const round = (n: number) => Math.round(n * 100) / 100;

    return {
      index,
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute('role'),
      name: (el.getAttribute('aria-label') || (el.textContent || '').trim()).slice(0, 40),
      sizeLabel: `${slopClass === 'none' ? 'unslopped' : `einc-tap-slop${slopClass === 'both' ? '-both' : ''}`} ${round(box.r - box.l)}x${round(box.b - box.t)}`,
      slopClass,
      classes: Array.from(el.classList),
      disabled:
        (el as HTMLButtonElement).disabled === true || el.getAttribute('aria-disabled') === 'true',
      box,
      pseudo,
      hit,
      reach,
      // Read off the pseudo-element's own floor declarations, not off the class name.
      floored: {
        vertical: pseudo !== null && num(after.minHeight) > 0,
        horizontal: pseudo !== null && num(after.minWidth) > 0,
      },
      zone: el.closest('[data-zone]')?.getAttribute('data-zone') ?? null,
      chrome: el.closest('[data-chrome]')?.getAttribute('data-chrome') ?? null,
      interiorProbes,
      negativeProbes,
    };
  });

  return {
    coarse: window.matchMedia('(pointer: coarse)').matches,
    fine: window.matchMedia('(pointer: fine)').matches,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    candidates,
    rejected,
  };
}

/**
 * Take one census of the page as it currently stands.
 *
 * `collectCensus` is passed to `page.evaluate` by reference and stringified into the page,
 * which is why it closes over NOTHING from module scope and takes its three constants as an
 * argument. A helper hoisted out of it later would be silently `undefined` in the browser.
 */
export async function censusOf(page: Page): Promise<TapCensus> {
  return page.evaluate(collectCensus, {
    selector: CANDIDATE_SELECTOR,
    eps: EPS,
    negativePx: NEGATIVE_PROBE_PX,
    containerRoles: [...CONTAINER_ROLES],
  });
}

/**
 * The took-effect guard, and the first thing every coarse-pointer test does.
 *
 * It is a real guard rather than a formality, and the reason is written down in
 * `e2e/desktop-notice.spec.ts` too: Chromium's CDP `Emulation.setEmulatedMedia` SILENTLY
 * IGNORES a `pointer` feature in this build (148.0.7778.96). Measured here, on the harness,
 * before any product code existed to confound it — THIS DOC COMMENT IS THE RECORD OF THAT
 * MEASUREMENT and the two specs that rely on it point back here. Asked to emulate
 * `pointer: coarse` it reports `content: 'none'` on the pseudo-element
 * under BOTH values — which, for a spec that gates on the slop existing, reads as a pass.
 *
 * So the emulation is not requested over CDP at all. It comes from the Playwright context
 * option `hasTouch`, which `mobile-360` and `mobile-390` set and `chromium` does not, and
 * this function asserts `matchMedia` in the page to prove it landed. Guard red means the
 * projects moved, not that the app broke.
 */
export async function assertCoarsePointer(page: Page, census?: TapCensus): Promise<void> {
  const coarse = census
    ? census.coarse
    : await page.evaluate(() => matchMedia('(pointer: coarse)').matches);
  expect(
    coarse,
    'the page does not report a COARSE primary pointer, so every slop assertion below would ' +
      'be measuring a fine-pointer build where the `::after` does not exist at all — and ' +
      'would pass vacuously. This is the emulation, not the app: the phone projects set ' +
      '`hasTouch: true` in playwright.config.ts, and CDP Emulation.setEmulatedMedia is ' +
      'deliberately NOT used here because it silently ignores a `pointer` feature in this ' +
      'Chromium (148.0.7778.96, measured).',
  ).toBe(true);
}

/** The inverse guard, for the desktop spec. */
export async function assertFinePointer(page: Page, census?: TapCensus): Promise<void> {
  const coarse = census
    ? census.coarse
    : await page.evaluate(() => matchMedia('(pointer: coarse)').matches);
  expect(
    coarse,
    'the `chromium` project reports a COARSE primary pointer. It must not — the whole claim ' +
      'of this spec is that the slop does not exist under a mouse, and a coarse reading here ' +
      'means the project picked up `hasTouch` from somewhere and the spec is asserting the ' +
      'wrong half of the media query.',
  ).toBe(false);
}

/** One line naming a control precisely enough to find it. */
export function describeCandidate(c: TapCandidate): string {
  const r = (n: number) => Math.round(n * 100) / 100;
  return (
    `${c.tag}${c.role ? `[role=${c.role}]` : ''} "${c.name}" (${c.sizeLabel}` +
    `${c.disabled ? ', disabled' : ''}) at ${r(c.box.l)},${r(c.box.t)}`
  );
}

/** The remedy every R1 message ends with. R3 is the arbitrated rule it names. */
export const R3_REMEDY =
  'REMEDY (R3): where two hit regions would overlap, the fix is at the CONTAINER — give the ' +
  'row or stack that holds these two controls enough gutter that their 44px regions clear ' +
  'each other, or make one of them a size whose target is met by its own box. Do NOT widen ' +
  'the shell-zone gutter, and do NOT drop the slop class: the class is the accessibility ' +
  'floor and the gutter is load-bearing layout. Neither is the fix.';

/** Overlap of two rectangles on the OPEN interior. `null` when they do not overlap. */
export function openOverlap(a: Rect, b: Rect, eps = EPS): { x: number; y: number } | null {
  const x = Math.min(a.r, b.r) - Math.max(a.l, b.l);
  const y = Math.min(a.b, b.b) - Math.max(a.t, b.t);
  return x > eps && y > eps ? { x, y } : null;
}

/** `a` fully encloses `b`. Composed controls, which are exempt — see the header. */
export function encloses(a: Rect, b: Rect, eps = EPS): boolean {
  return b.l >= a.l - eps && b.r <= a.r + eps && b.t >= a.t - eps && b.b <= a.b + eps;
}

/**
 * Fail in ~0ms rather than after a navigation, and name the project.
 *
 * Mirrors `assertPhoneProject` in `e2e/support/safe-area.ts`. Not imported from there: that
 * one exists to guard the CDP inset override, and folding a second meaning into it would make
 * one red run mean two unrelated things.
 */
export function assertProject(testInfo: TestInfo, allowed: readonly string[]): void {
  expect(
    allowed.includes(testInfo.project.name),
    `this spec measures a ${allowed.join(' / ')} viewport and was collected by ` +
      `"${testInfo.project.name}". That is a playwright.config.ts spec-list problem, not a ` +
      'product problem — see the spec-list note above the config.',
  ).toBe(true);
}
