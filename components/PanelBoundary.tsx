'use client';

import { Button } from '@expenseos/design-system';
import { IconAlertTriangle } from '@tabler/icons-react';
import { useTranslations } from 'next-intl';
import { Component, type ReactNode } from 'react';

/**
 * A containment boundary around ONE panel.
 *
 * WHY THIS EXISTS AND `dashboard/error.tsx` DOES NOT. A route-level `error.tsx` catches
 * the same errors at the same granularity as the `(app)` boundary already does: the whole
 * page. It buys route-specific copy and a route-scoped `reset()`. It buys zero
 * containment — one panel throwing still takes out every other panel on the screen. On the
 * post-login landing page that is the difference between "one card is missing" and "the
 * product appears to be down", so the boundary has to sit *inside* the page, around each
 * panel, which is a thing only a component can do. `(app)/error.tsx` stays the app's one
 * route boundary and is untouched.
 *
 * The fallback is deliberately quiet: a small inline notice sized like the panel it
 * replaces, not a full-bleed error screen. It states that this one section is missing and
 * offers the single action that usually works. It does NOT show `error.message` — an error
 * that reaches here has not been sanitized the way a tRPC error has and may carry anything
 * the throw site put in it. The digest-and-server-log route is `(app)/error.tsx`'s job;
 * here the console line is the handle.
 *
 * A server component may be passed as `children`: React resolves the element on the server
 * and a throw during that render surfaces to the nearest boundary, which is this one. That
 * is a backstop, not a plan — a panel that has a sensible degraded rendering should catch
 * its own failure and render it (see `IdentityChips`), because a real panel beats a
 * placeholder every time.
 *
 * IT IS NOT DASHBOARD-ONLY, WHICH IS WHY THE LOG PREFIX IS `[panel]`. It was `[dashboard]`
 * when the dashboard was the only caller. The prefix names the mechanism, not the first
 * page to reach for it, so a boundary firing on some other route does not report itself as
 * a dashboard failure.
 */
export function PanelBoundary({
  children,
  fallback,
}: {
  children: ReactNode;
  /**
   * What to draw instead of the panel. Omitted → `PanelFallback`, which is what every
   * caller but one wants and what every caller had before this prop existed.
   *
   * `undefined` AND NOT NULLISH IS THE TEST BELOW, DELIBERATELY. `fallback ?? <PanelFallback />`
   * would read `fallback={null}` as "not supplied" and paint the default — which is the
   * exact call the dashboard's identity band makes, so the one caller this prop exists for
   * would be the one caller it silently ignored. Omission and `null` are different
   * requests: "give me the standard face" and "draw nothing at all".
   *
   * THE ONE CALLER PASSING `null`, and why the error-face rule is waived there.
   * `ux-ui-designer`, who wrote that rule: "`PanelFallback` is a bordered muted box with a
   * Retry button that reloads the page. Dropping that into a navy band is wrong visually,
   * and worse than wrong semantically — it offers a full page reload to recover a
   * DEPARTMENT LABEL. Affordances like that teach readers to ignore error affordances that
   * matter." The chips sit beside a name that renders from the session and cannot fail, so
   * their absence costs the reader two words they did not come to the page for.
   */
  fallback?: ReactNode;
}) {
  return (
    <PanelBoundaryInner fallback={fallback === undefined ? <PanelFallback /> : fallback}>
      {children}
    </PanelBoundaryInner>
  );
}

/**
 * The catch itself. A class, because `getDerivedStateFromError` / `componentDidCatch` have
 * no hook equivalent — React still has no function-component error boundary. The copy is
 * pulled out into `PanelFallback` so this class needs no hooks of its own.
 */
class PanelBoundaryInner extends Component<
  { children: ReactNode; fallback: ReactNode },
  { failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override componentDidCatch(error: unknown) {
    console.error('[panel] render error', error);
  }

  override render() {
    if (this.state.failed) return this.props.fallback;
    return this.props.children;
  }
}

function PanelFallback() {
  const t = useTranslations('common');
  return (
    <div
      // `role="status"` and not `role="alert"`: a missing panel is not an emergency, and an
      // assertive live region on a landing page interrupts whatever the reader is already
      // being told. Polite is the honest urgency here.
      role="status"
      className="flex items-center gap-3 rounded-lg border border-border bg-muted/30 px-4 py-3"
    >
      <IconAlertTriangle size={18} className="shrink-0 text-warning" aria-hidden />
      <span className="flex-1 text-muted-foreground text-sm">{t('panelUnavailable')}</span>
      <Button
        size="sm"
        variant="secondary"
        // A full reload rather than a boundary-local reset. The panels this wraps are
        // server-rendered or server-data-backed; clearing `failed` re-renders the element
        // React already resolved, which fails identically. Reloading is the action that
        // can actually change the answer.
        onClick={() => window.location.reload()}
      >
        {t('retry')}
      </Button>
    </div>
  );
}
