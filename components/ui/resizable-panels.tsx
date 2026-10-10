'use client';

import * as React from 'react';
// VeloExpense kit: the kit's `cn` (ExpenseOS imports its package's own).
import { cn } from '@/lib/utils';

/**
 * Horizontal resizable panel group with draggable gutters, per-panel minimum
 * widths, and one flexible panel that absorbs the remaining space. Dependency-
 * free (no react-resizable-panels). Below `breakpoint` the panels stack
 * vertically and the gutters disappear (mobile / narrow layouts).
 *
 * Sizes for the NON-flex panels are persisted to localStorage under
 * `storageKey`. SSR-safe: renders stacked on the server + first client paint,
 * then upgrades to the resizable row once the media query resolves — so there
 * is no hydration mismatch.
 *
 * Each child (in order) is one panel; `minWidths`, `panelKeys`, and (optional)
 * `defaultWidths` are index-aligned to the children. The optional `stackedOrder`
 * changes the order those panels are EMITTED in below the breakpoint, without
 * disturbing that index alignment or the resizable row above it.
 */
const GUTTER_PX = 8;

export interface ResizablePanelsProps {
  children: React.ReactNode;
  /** Min width (px) per panel, index-aligned to children. */
  minWidths: number[];
  /** Stable id per panel (for persistence), index-aligned to children. */
  panelKeys: string[];
  /** Index of the panel that flexes to fill remaining space. */
  flexIndex: number;
  /** Initial widths (px) for non-flex panels; falls back to the min. */
  defaultWidths?: (number | undefined)[];
  /** Initial widths as fractions of the container (e.g. [1/3, 1/3, 1/3] for
   *  equal thirds), index-aligned. When set and no saved sizes exist, each
   *  non-flex panel is sized to its fraction of the available width on mount, so
   *  the flex panel absorbs the remainder — giving true proportional columns
   *  that px defaults can't across screen sizes. */
  defaultFractions?: number[];
  /** localStorage key holding `{ [panelKey]: widthPx }`. */
  storageKey: string;
  /**
   * Render order for the STACKED layout ONLY, as child indices in the order they
   * should appear (`[2, 0, 1]` puts the third child first). Index-aligned to
   * `children` like every other array prop here, so each position keeps its own
   * `panelKeys[i]` / `minWidths[i]` / `defaultWidths[i]`: this moves a POSITION,
   * never a subtree. That is what makes a reorder safe — React's keyed
   * reconciliation MOVES the existing DOM node rather than unmounting and
   * remounting the panel's children, so a child that must mount exactly once
   * (and fire exactly one mutation) still does.
   *
   * Purely additive. Omit it — or pass one that is not a permutation of
   * `0..children.length - 1` — and the stacked order is the natural child order,
   * which is what it has always been. It is read ONLY below `breakpoint`; the
   * resizable row ignores it entirely, so persisted widths, gutters and drag
   * behaviour are untouched by it.
   */
  stackedOrder?: number[];
  /**
   * Give every panel in the STACKED column a full column's height and its own
   * scroller, and let the column scroll between them — instead of letting each
   * panel size to its content and squeeze its neighbours. Stacked layout only;
   * the resizable row never reads it.
   *
   * ── WHAT IT FIXES ──────────────────────────────────────────────────────────
   *
   * A panel that manages its own scrolling — `overflow-hidden` around an inner
   * `flex-1 overflow-y-auto`, which is what every workbench pane in this app is
   * — needs a DEFINITE height for that inner region to have anything to fill.
   * The wide branch below gives it one: its wrapper is a `grid`, so the panel
   * is stretched to the column's height. The stacked wrapper is a plain block
   * of auto height, so the panel is content-sized, `flex: 1 1 0%` on the inner
   * region resolves against an indefinite height, and the scroll region
   * collapses — the pane paints its header and chrome and cuts its body off.
   * Three of them in one column then also shrink against each other (a flex
   * item defaults to `flex-shrink: 1`, and `min-h-0` removes the content-based
   * minimum that would hold it), so what is on screen is neither the whole
   * panel nor a scrollable part of it.
   *
   * Opting in swaps that wrapper for `grid h-full min-h-0 shrink-0
   * overflow-y-auto` and lets the COLUMN scroll. Each part earns its place:
   *
   *   · `grid` stretches the panel to the wrapper, exactly as the wide branch
   *     does — this is what hands the panel the definite height its inner
   *     scroller needs.
   *   · `h-full` is that height: one column's worth, so a panel is a screenful
   *     rather than a third of one. It resolves against the column only when
   *     the column's own height is definite; where it is not, it computes to
   *     `auto` and the panels simply sit at their content height, which with
   *     `shrink-0` is still correct and still uncut.
   *   · `shrink-0` stops the panels squeezing each other — the squeeze IS the
   *     clipping.
   *   · `overflow-y-auto` on the wrapper catches whatever a panel that does not
   *     clip its own overflow spills past `h-full`, so the panel scrolls within
   *     itself rather than over its neighbour.
   *
   * The column then overflows honestly and scrolls from one panel to the next.
   *
   * ── WHY OPT-IN ─────────────────────────────────────────────────────────────
   *
   * Additive, exactly like `stackedOrder` above and for the same reason: a host
   * that passes nothing renders what it rendered before this prop existed, in
   * BOTH branches. A screenful per panel is a real change to how a stack reads
   * — a short panel stretches where it used to sit at content height — and this
   * component's other hosts stack at every width below their 80rem breakpoint,
   * which includes desktop windows, not just phones. So the hosts that have
   * been measured on a phone ask for it and nothing else moves.
   */
  stackedScroll?: boolean;
  /** Media query at/above which panels are resizable; below it they stack. */
  breakpoint?: string;
  /** Accessible label for each resize handle (localize at the call site). */
  separatorLabel?: string;
  className?: string;
}

/**
 * `order` as given when it is a genuine permutation of `0..count - 1`; the
 * natural order otherwise.
 *
 * The validation is not politeness. A malformed order would repeat or drop a
 * `panelKeys[i]`, and a DUPLICATE key is precisely the thing that would make
 * React tear a panel down and build it again — the one outcome `stackedOrder`
 * exists to avoid. So a bad order is refused rather than rendered, and the
 * caller gets the layout it had before the prop existed.
 */
function stackOrder(order: number[] | undefined, count: number): number[] {
  const natural = Array.from({ length: count }, (_, i) => i);
  if (!order || order.length !== count) return natural;
  const seen = new Set<number>();
  for (const i of order) {
    if (!Number.isInteger(i) || i < 0 || i >= count || seen.has(i)) return natural;
    seen.add(i);
  }
  return order;
}

export function ResizablePanels({
  children,
  minWidths,
  panelKeys,
  flexIndex,
  defaultWidths,
  defaultFractions,
  storageKey,
  stackedOrder,
  stackedScroll,
  breakpoint = '(min-width: 80rem)',
  separatorLabel = 'Resize panels',
  className,
}: ResizablePanelsProps) {
  const panels = React.Children.toArray(children);
  const containerRef = React.useRef<HTMLDivElement>(null);
  const [isWide, setIsWide] = React.useState(false);
  const [widths, setWidths] = React.useState<Record<string, number>>(() => {
    const init: Record<string, number> = {};
    panelKeys.forEach((key, i) => {
      init[key] = defaultWidths?.[i] ?? minWidths[i];
    });
    return init;
  });

  React.useEffect(() => {
    const mq = window.matchMedia(breakpoint);
    const sync = () => setIsWide(mq.matches);
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, [breakpoint]);

  React.useEffect(() => {
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (!raw) return;
      const saved = JSON.parse(raw) as Record<string, number>;
      setWidths((cur) => {
        const next = { ...cur };
        panelKeys.forEach((key, i) => {
          if (typeof saved[key] === 'number') next[key] = Math.max(minWidths[i], saved[key]);
        });
        return next;
      });
    } catch {
      // ignore malformed / unavailable storage
    }
  }, [storageKey, panelKeys, minWidths]);

  // Fractional init: once the container is measured (and only when the user has
  // no saved sizes), size each non-flex panel to its fraction of the available
  // width so the flex panel absorbs the rest — true proportional columns.
  const fractionInit = React.useRef(false);
  React.useEffect(() => {
    if (!isWide || fractionInit.current || !defaultFractions) return;
    try {
      if (window.localStorage.getItem(storageKey)) {
        fractionInit.current = true;
        return;
      }
    } catch {
      // storage unavailable — proceed with fractional sizing
    }
    const el = containerRef.current;
    if (!el) return;
    const avail = el.clientWidth - (panels.length - 1) * GUTTER_PX;
    if (avail <= 0) return;
    fractionInit.current = true;
    setWidths((cur) => {
      const next = { ...cur };
      panelKeys.forEach((key, i) => {
        const f = defaultFractions[i];
        if (i !== flexIndex && typeof f === 'number') {
          next[key] = Math.max(minWidths[i], Math.round(f * avail));
        }
      });
      return next;
    });
  }, [isWide, defaultFractions, storageKey, panels.length, panelKeys, minWidths, flexIndex]);

  const persist = React.useCallback(
    (next: Record<string, number>) => {
      try {
        window.localStorage.setItem(storageKey, JSON.stringify(next));
      } catch {
        // storage unavailable — sizes just won't persist
      }
    },
    [storageKey],
  );

  // Clamp a candidate width for the panel at `idx` so its own min holds AND the
  // flex panel keeps its minimum (given the other non-flex panels' widths).
  const clamp = React.useCallback(
    (idx: number, candidate: number, current: Record<string, number>) => {
      const container = containerRef.current?.clientWidth ?? 0;
      const gutters = (panels.length - 1) * GUTTER_PX;
      let otherNonFlex = 0;
      panelKeys.forEach((key, i) => {
        if (i !== flexIndex && i !== idx) otherNonFlex += current[key] ?? minWidths[i];
      });
      const max = container - gutters - otherNonFlex - minWidths[flexIndex];
      return Math.max(minWidths[idx], Math.min(candidate, Math.max(minWidths[idx], max)));
    },
    [panels.length, panelKeys, minWidths, flexIndex],
  );

  // The gutter after panel `i` drives the adjacent non-flex panel.
  const controlled = (i: number): { idx: number; sign: 1 | -1 } | null => {
    if (i !== flexIndex) return { idx: i, sign: 1 }; // drag right → widen panel i
    if (i + 1 < panels.length && i + 1 !== flexIndex) return { idx: i + 1, sign: -1 };
    return null;
  };

  const startDrag = (i: number, startX: number) => {
    const ctrl = controlled(i);
    if (!ctrl) return;
    const key = panelKeys[ctrl.idx];
    const startW = widths[key] ?? minWidths[ctrl.idx];
    const onMove = (e: PointerEvent) => {
      const delta = (e.clientX - startX) * ctrl.sign;
      setWidths((cur) => ({ ...cur, [key]: clamp(ctrl.idx, startW + delta, cur) }));
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      setWidths((cur) => {
        persist(cur);
        return cur;
      });
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  // Current / min / max width (px) of the panel the gutter after `i` controls —
  // exposed on the separator as aria-value* for assistive tech.
  const bounds = (i: number) => {
    const ctrl = controlled(i);
    if (!ctrl) return null;
    const idx = ctrl.idx;
    return {
      now: Math.round(widths[panelKeys[idx]] ?? minWidths[idx]),
      min: minWidths[idx],
      max: Math.round(clamp(idx, Number.MAX_SAFE_INTEGER, widths)),
    };
  };

  const nudge = (i: number, dir: -1 | 1) => {
    const ctrl = controlled(i);
    if (!ctrl) return;
    const key = panelKeys[ctrl.idx];
    setWidths((cur) => {
      const next = {
        ...cur,
        [key]: clamp(ctrl.idx, (cur[key] ?? minWidths[ctrl.idx]) + dir * 16 * ctrl.sign, cur),
      };
      persist(next);
      return next;
    });
  };

  // Keep the flex panel above its min as the container shrinks.
  React.useEffect(() => {
    const el = containerRef.current;
    if (!el || !isWide) return;
    const ro = new ResizeObserver(() => {
      setWidths((cur) => {
        const next = { ...cur };
        panelKeys.forEach((key, i) => {
          if (i !== flexIndex) next[key] = clamp(i, cur[key] ?? minWidths[i], cur);
        });
        return next;
      });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [isWide, panelKeys, minWidths, flexIndex, clamp]);

  if (!isWide) {
    // `panelKeys[i]` stays paired with `panels[i]`; only the SEQUENCE they are
    // emitted in changes. Never reorder `panelKeys` itself — that would repair
    // the visual order by mispairing every index-aligned prop.
    //
    // The wrapper is the ONLY thing `stackedScroll` changes, and the default
    // string is byte-for-byte the one this branch has always emitted — see the
    // prop for why an equal-share column is opt-in rather than the rule.
    const panelClass = stackedScroll ? 'grid h-full min-h-0 shrink-0 overflow-y-auto' : 'min-h-0';
    return (
      <div
        className={cn(
          'flex min-h-0 flex-1 flex-col gap-3',
          // The scroller for the stack itself. `overflow-x-*` from a host's
          // `className` is a different longhand and survives beside it.
          stackedScroll && 'overflow-y-auto',
          className,
        )}
      >
        {stackOrder(stackedOrder, panels.length).map((i) => (
          <div key={panelKeys[i]} className={panelClass}>
            {panels[i]}
          </div>
        ))}
      </div>
    );
  }

  return (
    <div ref={containerRef} className={cn('flex min-h-0 flex-1', className)}>
      {panels.map((child, i) => (
        <React.Fragment key={panelKeys[i]}>
          <div
            className="grid min-h-0 min-w-0"
            style={
              i === flexIndex
                ? { flex: '1 1 0%' }
                : { width: widths[panelKeys[i]], flex: '0 0 auto' }
            }
          >
            {child}
          </div>
          {i < panels.length - 1 && controlled(i) && (
            // biome-ignore lint/a11y/useSemanticElements: a separator is the correct ARIA role for a resize handle
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label={separatorLabel}
              aria-valuenow={bounds(i)?.now}
              aria-valuemin={bounds(i)?.min}
              aria-valuemax={bounds(i)?.max}
              tabIndex={0}
              onPointerDown={(e) => {
                e.preventDefault();
                startDrag(i, e.clientX);
              }}
              onKeyDown={(e) => {
                if (e.key === 'ArrowLeft') {
                  e.preventDefault();
                  nudge(i, -1);
                } else if (e.key === 'ArrowRight') {
                  e.preventDefault();
                  nudge(i, 1);
                }
              }}
              className="w-2 shrink-0 cursor-col-resize self-stretch rounded bg-transparent transition-colors hover:bg-border focus-visible:bg-ring focus-visible:outline-none"
            />
          )}
        </React.Fragment>
      ))}
    </div>
  );
}
ResizablePanels.displayName = 'ResizablePanels';
