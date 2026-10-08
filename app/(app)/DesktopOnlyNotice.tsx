'use client';

import { Button, buttonVariants, cn } from '@expenseos/design-system';
import { IconDeviceDesktop } from '@tabler/icons-react';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import { Link, usePathname } from '@/i18n/navigation';
import { dispositionFor } from './mobileReadiness';

/**
 * The desktop-only notice — what a route ruled `desktop` in `mobileReadiness.ts` shows
 * below `lg` instead of its page.
 *
 * ─── THE MECHANISM IS CSS, AND THAT IS THE WHOLE DESIGN ──────────────────────────────────
 *
 * Both branches are ALWAYS RENDERED, and the viewport decides which one has a box:
 * `lg:hidden` on the notice, `hidden lg:contents` on the wrapper around the page. Nothing
 * here reads the viewport — no `matchMedia`, no resize listener, no `useIsCompact`.
 *
 * That matters for one specific reason, measured rather than assumed before any of this was
 * built (ADR-0005, "A `matchMedia` branch" under Alternatives considered): a `matchMedia`
 * branch cannot run until the client has hydrated, so the first paint
 * on a phone is the PAGE, replaced a moment later by the notice. The reader sees a flash of
 * the thing they were told they cannot use. CSS resolves before the first paint and needs
 * no JavaScript at all, which is also why the notice survives a `javaScriptEnabled: false`
 * context — see `e2e/desktop-notice.spec.ts`, which proves that in three layers.
 *
 * The premise the mechanism rests on was checked and is positive: one RSC flight payload
 * carries this layout's client references AND the leaf page's, and the initial HTML document
 * carries BOTH subtrees server-rendered. So `hidden` costs a server render that is thrown
 * away visually, and costs no extra round-trip.
 *
 * `contents`, NOT `block`. `main#main-content` is `flex flex-1 flex-col`, and its children
 * are the page's own flex items. A `block` wrapper would insert a box between them and
 * `main`, so every page's `flex-1`, `min-h-0` and `gap` would be resolving against the
 * wrapper instead of against `main` — a layout change on every desktop viewing of a
 * `desktop`-ruled route, shipped by a component whose entire job is to change nothing there.
 * `display: contents` generates no box at all, so the desktop layout is byte-identical.
 * `e2e/desktop-notice.spec.ts` measures that rather than asserting it.
 *
 * ─── WHAT THIS IS NOT ────────────────────────────────────────────────────────────────────
 *
 * NOT A DIALOG. No `role="dialog"`, no `aria-modal`, no focus trap, no Escape handler. It is
 * not a layer over the page — below `lg` the page is not in the layout, the accessibility
 * tree or the tab order, because `display: none` removes it from all three. Announcing a
 * modal over content that is not there tells a screen-reader user the opposite of the truth,
 * and a focus trap around the only thing on screen traps nothing.
 *
 * An `h2` rather than an `h1`, because `TopBar` already renders the route's `h1` and the
 * notice sits inside `main` beneath it. Two `h1`s on one document is the reflex mistake here.
 *
 * NOT A PERMISSION. `CLAUDE.md`: server is authoritative, UI gating is cosmetic. Ruling a
 * route `desktop` narrows nobody's access — RBAC and module gating are untouched, the route
 * still answers 200, and "Continue anyway" always works. There is no server check, no
 * middleware branch and no redirect anywhere in this feature, and none may be added.
 */

/**
 * `sessionStorage`, per matched PREFIX, and both halves are choices.
 *
 * SESSION rather than local: "I know, let me see it anyway" is a decision about right now,
 * on this device, in this sitting. Persisting it across weeks means a reader who tapped
 * through once in June never sees the notice again on the phone they bought in July, which
 * is not what they agreed to.
 *
 * PER MATCHED PREFIX rather than per full path, so continuing past `/admin/roles` also
 * covers `/admin/roles/anything`. The alternative — keying on the exact path — re-asks the
 * same question on every click inside one feature, which trains the reader to dismiss it
 * without reading it.
 */
const STORAGE_KEY = 'eos.desktopOk';

/**
 * Every read and write in `try`/`catch`, per the house pattern on `AppShell`'s
 * `eos.sidebarCollapsed`. Storage throws outright in Safari private browsing and under a
 * third-party-cookie block, and the correct behaviour when it does is that the notice still
 * renders and the choice simply does not outlive the page view — never that the route fails
 * to render. `DesktopOnlyNotice.test.tsx` pins the throwing case.
 */
function readAcknowledged(): readonly string[] {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    // Unavailable, or holding something that is not our array. Either way: no acknowledgements.
    return [];
  }
}

function writeAcknowledged(prefix: string): void {
  try {
    sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([...new Set([...readAcknowledged(), prefix])]),
    );
  } catch {
    /* storage unavailable — the choice lasts as long as this page view, which is enough */
  }
}

export function DesktopOnlyNotice({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const t = useTranslations('common.desktopOnly');
  const { disposition, prefix } = dispositionFor(pathname);

  /**
   * Starts `false` on both sides of hydration, and the stored value is applied on mount.
   *
   * The tempting shape is a `useState` initializer that reads storage — and it produces a
   * client render that disagrees with the server's, which React reports as a hydration
   * mismatch on the console. The mobile crawl fails any route that logs a console error, so
   * that shape would take `/admin/roles` red for a reason that looks nothing like its cause.
   * `AppShell` applies `eos.sidebarCollapsed` the same way and for the same reason.
   *
   * THE COST, RECORDED BECAUSE IT IS REAL: reloading a route you have already continued past
   * shows the notice for the frame between hydration and this effect. `useLayoutEffect` would
   * close that gap and cannot be used — React logs "useLayoutEffect does nothing on the
   * server" for a server-rendered client component, which is a console error, which is the
   * crawl failure above. One frame on a reload after an explicit opt-through is the cheaper
   * of the two.
   */
  const [acknowledged, setAcknowledged] = useState(false);
  /**
   * WHERE FOCUS GOES, AND WHY IT IS NOT THE WRAPPER — MEASURED, NOT ASSUMED.
   *
   * The obvious target is the content wrapper itself, and it does not work: an element with
   * `display: contents` generates no box, and Chromium 148 refuses to focus it even with
   * `tabIndex={-1}`. Probed directly during this build — `el.focus()` on a `display: contents`
   * div left `document.activeElement` as `<body>`, while the identical div at `display: block`
   * took focus. So "focus the content container" and "the wrapper is `contents`" are in direct
   * conflict, and `contents` is the half that cannot move: it is what keeps the desktop layout
   * byte-identical.
   *
   * The resolution is a one-pixel `sr-only` anchor as the wrapper's FIRST CHILD, rendered only
   * once the reader has continued. It is out of flow (`position: absolute`), so it is not a
   * flex item and changes no geometry; it has a box, so it can hold focus; and it is absent
   * entirely on every un-acknowledged render — which is every desktop render — so the
   * geometry claim is not merely unaffected, it is untouched.
   *
   * WHAT IT DOES NOT DO: announce anything. The anchor is empty, so a screen reader is placed
   * at the top of the page content and reads on from there, which is what the shell's own skip
   * link does. Saying "the page is showing now" out loud wants a live region and a catalog
   * key, and is a bigger change than this one.
   */
  const focusAnchorRef = useRef<HTMLDivElement>(null);
  /** Distinguishes "the reader just chose" from "the choice was restored from storage" —
   *  focus moves only on the first, because moving it on a page load is a hijack. */
  const justChose = useRef(false);

  useEffect(() => {
    setAcknowledged(prefix !== null && readAcknowledged().includes(prefix));
  }, [prefix]);

  useEffect(() => {
    if (!acknowledged || !justChose.current) return;
    justChose.current = false;
    // The notice the reader was reading has just been unmounted. Without this, focus falls
    // back to `<body>` and a keyboard or screen-reader user is returned to the top of the
    // document with no announcement of what changed.
    focusAnchorRef.current?.focus();
  }, [acknowledged]);

  /**
   * The early return, and why the wrapper does not exist on unruled routes.
   *
   * 51 of 52 routes are not ruled `desktop`, and they render EXACTLY what they rendered
   * before this component existed — same tree, same element count, no wrapper, nothing to
   * regress. A `display: contents` wrapper on every route would be harmless in principle and
   * is still not worth 51 routes' worth of "in principle".
   */
  if (disposition !== 'desktop') return <>{children}</>;

  const continueAnyway = () => {
    if (prefix !== null) writeAcknowledged(prefix);
    justChose.current = true;
    setAcknowledged(true);
  };

  return (
    <>
      {/*
       * UNMOUNTED once the reader continues, never merely hidden.
       *
       * The inherited contract from `docs/design/pwa.md` ruling 6, enforced by
       * `e2e/crawl-mobile.spec.ts`: exactly one VISIBLE `[data-testid="desktop-only-notice"]`,
       * and a notice that is present-but-hidden fails it. Keeping it mounted behind a class
       * would also leave its heading and its two controls in the accessibility tree and the
       * tab order above a page the reader has just asked to see.
       */}
      {!acknowledged && (
        <div
          data-testid="desktop-only-notice"
          className="flex flex-1 flex-col items-center justify-center gap-4 p-6 text-center lg:hidden"
        >
          <IconDeviceDesktop size={40} className="text-muted-foreground" aria-hidden />
          <div className="space-y-1">
            <h2 className="font-semibold text-foreground text-lg">{t('title')}</h2>
            <p className="max-w-md text-muted-foreground text-sm">{t('body')}</p>
          </div>
          <div className="flex flex-wrap items-center justify-center gap-2">
            {/*
             * "Continue anyway" is the PRIMARY action — first in reading order, carrying the
             * emphasis — because the reader asked for this route, usually by following a link
             * we sent them. The way through stays one obvious tap away, with no confirmation
             * and no friction. ADR-0005 D7 says so, and the reason is the dark-pattern check: an
             * escape hatch promoted over the requested destination is obstruction dressed as
             * helpfulness. The dashboard is offered plainly beside it as the alternative it
             * is — not buried, and not styled as a mistake.
             */}
            {/* VeloExpense kit: ExpenseOS's `sm` button is 36px tall; the kit's 36px size is
                `lg` (its `sm` is 28px), so both controls say `lg` to keep the phone target. */}
            <Button variant="default" size="lg" onClick={continueAnyway}>
              {t('continueAnyway')}
            </Button>
            {/* VeloExpense: the dashboard is the home page, `/`. */}
            <Link
              href="/"
              className={cn(buttonVariants({ variant: 'secondary', size: 'lg' }), 'no-underline')}
            >
              {t('goToDashboard')}
            </Link>
          </div>
        </div>
      )}
      <div
        data-testid="desktop-only-content"
        className={acknowledged ? 'contents' : 'hidden lg:contents'}
      >
        {acknowledged && (
          // See the note on `focusAnchorRef`. `-1`, so it holds focus programmatically and is
          // never a stop for anyone tabbing through the page.
          <div
            ref={focusAnchorRef}
            tabIndex={-1}
            data-testid="desktop-only-focus-anchor"
            className="sr-only"
          />
        )}
        {children}
      </div>
    </>
  );
}
