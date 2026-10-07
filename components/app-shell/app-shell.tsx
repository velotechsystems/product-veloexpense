/**
 * The signed-in frame — ExpenseOS's `AppShell` + `Sidebar`, ported onto the 2026
 * VeloTech kit.
 *
 * ── WHAT IS EXPENSEOS'S ─────────────────────────────────────────────────────
 *
 * The structure: a fixed-width sidebar (theirs is 240px; so is this), a header
 * with the product mark, labelled sections of icon + label rows filtered by what
 * the reader may open, a live count on Approvals, and the reader at the foot with
 * a way out. On a phone, the same sidebar off-canvas behind a Menu button.
 *
 * ── WHAT IS THE 2026 GUIDE'S ────────────────────────────────────────────────
 *
 * The look, which is VeloCRM's sidebar so the suite reads as one product family:
 * a white `--sidebar` panel with a 1px edge instead of E Inc.'s navy; the
 * `-nohalo` wordmark at a 16px cap height, centred, with the CSS halo behind it
 * and no rule under it; section labels in small caps; the active row as the
 * brand-50 tint (`--sidebar-accent`). Every colour is a kit token, so a tenant's
 * branding (`lib/branding/css.ts`) re-colours the shell without this file knowing.
 *
 * The organization's name and the reader's name and email are `translate="no"`:
 * they are tenant DATA, so a browser's translate prompt must leave them alone, and
 * the pseudo-locale crawl (e2e/pseudo-crawl.spec.ts) skips them for the same
 * reason — otherwise every screen's un-catalogued count rises by three.
 *
 * The wordmark is VeloExpense's, not the tenant's, even for a branded tenant: the
 * tenant's NAME sits under it. The tenant's logo is their tab icon and their
 * emails' header (VX4-3); swapping the product's mark in the shell is a decision
 * for the white-label work, not for a menu.
 */
import { LogOut } from 'lucide-react';
import { uiText } from '@/lib/i18n/catalog/ui';
import { visibleSections } from '@/lib/nav/sections';
import type { NavContext } from '@/lib/nav/context';
import { signOutAction } from '@/app/shell-actions';
import { NAV_ICONS } from './icons';
import { NavLink } from './nav-link';
import { ShellFrame } from './shell-frame';

const PRODUCT = 'VeloExpense';

/** viewBox is 1282 × 114 with a cap height of 100 units (the kit's `-nohalo` file). */
function Wordmark({ capHeight }: { capHeight: number }) {
  const height = Math.round(capHeight * 1.14);
  const width = Math.round(height * (1282 / 114));
  return (
    <span
      className="velo-halo inline-flex shrink-0"
      style={{ ['--halo-size' as string]: `${Math.round(capHeight * 8.74)}px` }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- a static SVG; next/image adds nothing */}
      <img className="ve-on-light" src="/brand/veloexpense-nohalo.svg" alt={PRODUCT} width={width} height={height} />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img className="ve-on-dark" src="/brand/veloexpense-nohalo-dark.svg" alt={PRODUCT} width={width} height={height} />
    </span>
  );
}

function Sidebar({ ctx, locale }: { ctx: NavContext; locale: string }) {
  const sections = visibleSections(ctx);
  return (
    <aside className="flex h-full w-full flex-col overflow-hidden border-r border-sidebar-border bg-sidebar text-sidebar-foreground">
      <div className="flex flex-col items-center gap-3 px-4 pt-7 pb-4">
        <Wordmark capHeight={16} />
        <p
          className="max-w-full truncate text-xs font-medium text-muted-foreground"
          data-testid="shell-org-name"
          translate="no"
        >
          {ctx.organizationName}
        </p>
      </div>

      <nav aria-label={uiText('nav.sidebar.label', locale)} className="flex-1 overflow-y-auto overscroll-contain px-3 py-2">
        {sections.map((section, n) => (
          <div className="mb-3 last:mb-0" key={section.label ?? `top-${n}`}>
            {section.label ? (
              <p className="mb-1 px-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                {uiText(section.label, locale)}
              </p>
            ) : null}
            <ul className="flex flex-col gap-0.5">
              {section.items.map((item) => {
                const Icon = NAV_ICONS[item.icon];
                const count = item.badge === 'pendingApprovals' ? ctx.pendingApprovals : 0;
                return (
                  <li key={item.href}>
                    <NavLink href={item.href} exact={item.exact === true}>
                      <Icon aria-hidden className="size-[18px] shrink-0" strokeWidth={1.75} />
                      <span className="flex-1 truncate">{uiText(item.label, locale)}</span>
                      {count > 0 ? (
                        <span
                          className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-primary px-1.5 text-[11px] font-bold text-primary-foreground"
                          data-testid="nav-badge"
                        >
                          {count > 99 ? '99+' : count}
                          <span className="sr-only"> {uiText('nav.sidebar.pending', locale)}</span>
                        </span>
                      ) : null}
                    </NavLink>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>

      <div className="flex items-center gap-3 border-t border-sidebar-border px-4 py-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-foreground" translate="no">
            {ctx.name}
          </p>
          <p className="truncate text-xs text-muted-foreground" translate="no">
            {ctx.email}
          </p>
        </div>
        <form action={signOutAction}>
          <button
            type="submit"
            title={uiText('nav.sidebar.sign.out', locale)}
            className="inline-flex size-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <LogOut aria-hidden className="size-[18px]" strokeWidth={1.75} />
            <span className="sr-only">{uiText('nav.sidebar.sign.out', locale)}</span>
          </button>
        </form>
      </div>
    </aside>
  );
}

export function AppShell({
  ctx,
  locale,
  children,
}: {
  ctx: NavContext;
  locale: string;
  children: React.ReactNode;
}) {
  return (
    <ShellFrame
      sidebar={<Sidebar ctx={ctx} locale={locale} />}
      brand={<Wordmark capHeight={14} />}
      menuLabel={uiText('nav.sidebar.menu', locale)}
      closeLabel={uiText('nav.sidebar.close', locale)}
    >
      {children}
    </ShellFrame>
  );
}
