'use client';

import {
  forwardRef,
  type ReactNode,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { cls } from './data-table/helpers';

/**
 * 2D scroll container with custom-rendered vertical AND horizontal
 * thumbs. macOS hides native overlay scrollbars regardless of
 * `::-webkit-scrollbar` styling — this component sidesteps that by
 * suppressing the native bars and painting our own thumbs on top.
 *
 * `insetTop`, `insetLeft`, `insetRight` shrink the scrollbar track
 * regions (NOT the scrolling content) — useful for reserving space
 * for sticky elements:
 *
 *   - `insetTop`   = sticky column-header height → vertical track
 *                     starts BELOW the header.
 *   - `insetLeft`  = left-pinned columns' total width → horizontal
 *                     track starts where the pinned-left band ends.
 *   - `insetRight` = right-pinned columns' total width → horizontal
 *                     track ends where the pinned-right band begins.
 *
 * The thumb size + position math accounts for the inset so the
 * thumb stays correctly proportional within the shrunk track.
 *
 * Forwards a ref to the inner scrolling element so external logic
 * (e.g. an IntersectionObserver) can use it as a `root`.
 *
 * `horizontalScrollbarPosition`:
 *   - `'bottom'` (default) — H bar sits at the bottom edge of the
 *     scroll container. Standard "scroll to the bottom to see it"
 *     pattern.
 *   - `'top'` — H bar sits immediately BELOW the sticky header
 *     (uses `insetTop`). Useful for tall data tables where the
 *     user shouldn't have to scroll vertically to find horizontal
 *     scroll affordance.
 *
 * `insetTop` can be auto-measured from a tagged descendant: if any
 * child carries `data-scroll2d-header`, its rendered height is used
 * as `insetTop`. The explicit `insetTop` prop wins when set; the
 * auto-measure fills it in when the prop is left undefined. Use this
 * with `horizontalScrollbarPosition="top"` so the H bar lands flush
 * with the body's top edge without the consumer having to thread
 * pixel measurements through.
 */
export const Scroll2D = forwardRef<
  HTMLDivElement,
  {
    children: ReactNode;
    className?: string;
    innerClassName?: string;
    insetTop?: number;
    insetLeft?: number;
    insetRight?: number;
    /** Where to render the horizontal scrollbar. Defaults to 'bottom'. */
    horizontalScrollbarPosition?: 'top' | 'bottom';
  }
>(function Scroll2D(
  {
    children,
    className,
    innerClassName,
    insetTop,
    insetLeft = 0,
    insetRight = 0,
    horizontalScrollbarPosition = 'bottom',
  },
  externalRef,
) {
  const scrollRef = useRef<HTMLDivElement>(null);
  useImperativeHandle(externalRef, () => scrollRef.current as HTMLDivElement, []);

  const [v, setV] = useState<{ thumb: number; pos: number } | null>(null);
  const [h, setH] = useState<{ thumb: number; pos: number } | null>(null);

  // Auto-measured header height. When the consumer tags a child with
  // `data-scroll2d-header`, we observe its size and feed it back in
  // as the effective `insetTop`. The explicit `insetTop` prop (when
  // set) wins.
  const [measuredTop, setMeasuredTop] = useState(0);
  const effectiveInsetTop = insetTop ?? measuredTop;

  // Drag state is in a ref so pointermove doesn't trigger re-render.
  // `scale` is the content:track ratio captured at drag start, so
  // dragging the thumb 1px moves content `scale` px.
  const drag = useRef<
    | { axis: 'v'; start: number; startScroll: number; scale: number }
    | { axis: 'h'; start: number; startScroll: number; scale: number }
    | null
  >(null);

  const recompute = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;

    // Overflow is the difference between content and viewport. We
    // ONLY render a scrollbar when there's meaningful scroll room —
    // i.e. the thumb would be visibly smaller than the track. A
    // 1-3px diff from sub-pixel rendering (browsers can disagree on
    // `scrollWidth` vs `clientWidth` by ~1px under
    // `table-layout: fixed`) would otherwise paint a thumb at
    // near-full-track-width, which reads as a static bar instead of
    // a scroll affordance. The 8px floor on the difference between
    // thumb size and track size catches that case AND honors the
    // `Math.max(24, …)` lower bound on the thumb size.
    const overflowY = el.scrollHeight - el.clientHeight;
    const overflowX = el.scrollWidth - el.clientWidth;

    const trackH = Math.max(0, el.clientHeight - effectiveInsetTop);
    if (overflowY <= 1 || trackH <= 0) {
      setV(null);
    } else {
      const ratio = el.clientHeight / el.scrollHeight;
      const thumb = Math.max(24, ratio * trackH);
      // If the thumb is so close to the track size that it can't
      // visibly move, suppress the bar — there's no scroll room
      // worth indicating.
      if (trackH - thumb < 8) {
        setV(null);
      } else {
        const pos = (el.scrollTop / overflowY) * (trackH - thumb);
        setV({ thumb, pos });
      }
    }

    const trackW = Math.max(0, el.clientWidth - insetLeft - insetRight);
    if (overflowX <= 1 || trackW <= 0) {
      setH(null);
    } else {
      const ratio = el.clientWidth / el.scrollWidth;
      const thumb = Math.max(24, ratio * trackW);
      if (trackW - thumb < 8) {
        setH(null);
      } else {
        const pos = (el.scrollLeft / overflowX) * (trackW - thumb);
        setH({ thumb, pos });
      }
    }
  }, [effectiveInsetTop, insetLeft, insetRight]);

  useLayoutEffect(() => {
    recompute();
  }, [recompute]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(recompute);
    ro.observe(el);
    const mo = new MutationObserver(recompute);
    mo.observe(el, { childList: true, subtree: true, characterData: true });
    return () => {
      ro.disconnect();
      mo.disconnect();
    };
  }, [recompute]);

  // Auto-measure the tagged header (`data-scroll2d-header`) if the
  // consumer uses the magic attribute. No-op when the explicit
  // `insetTop` prop is set — the prop wins.
  useEffect(() => {
    if (insetTop !== undefined) return;
    const root = scrollRef.current;
    if (!root) return;
    const header = root.querySelector<HTMLElement>('[data-scroll2d-header]');
    if (!header) return;
    const ro = new ResizeObserver(() => {
      setMeasuredTop(header.getBoundingClientRect().height);
    });
    ro.observe(header);
    setMeasuredTop(header.getBoundingClientRect().height);
    return () => ro.disconnect();
  }, [insetTop]);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const d = drag.current;
      const el = scrollRef.current;
      if (!d || !el) return;
      if (d.axis === 'v') {
        el.scrollTop = d.startScroll + (e.clientY - d.start) * d.scale;
      } else {
        el.scrollLeft = d.startScroll + (e.clientX - d.start) * d.scale;
      }
    };
    const onUp = () => {
      drag.current = null;
      document.body.style.userSelect = '';
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);

  const startVDrag = (e: React.MouseEvent) => {
    const el = scrollRef.current;
    if (!el || !v) return;
    const trackH = el.clientHeight - effectiveInsetTop;
    const maxScroll = el.scrollHeight - el.clientHeight;
    drag.current = {
      axis: 'v',
      start: e.clientY,
      startScroll: el.scrollTop,
      // pxOfContent / pxOfThumbMovement → drag 1 px → scroll `scale` px.
      scale: maxScroll / (trackH - v.thumb),
    };
    document.body.style.userSelect = 'none';
    e.preventDefault();
  };
  const startHDrag = (e: React.MouseEvent) => {
    const el = scrollRef.current;
    if (!el || !h) return;
    const trackW = el.clientWidth - insetLeft - insetRight;
    const maxScroll = el.scrollWidth - el.clientWidth;
    drag.current = {
      axis: 'h',
      start: e.clientX,
      startScroll: el.scrollLeft,
      scale: maxScroll / (trackW - h.thumb),
    };
    document.body.style.userSelect = 'none';
    e.preventDefault();
  };

  // Horizontal scrollbar wrapper geometry. `top` mode sits the bar
  // immediately below the sticky header (= effectiveInsetTop from
  // the scroll container's top). Sticky-positioned via `top: …` so it
  // stays visible no matter how far the body has been scrolled down.
  const hWrapperStyle: React.CSSProperties =
    horizontalScrollbarPosition === 'top'
      ? { top: effectiveInsetTop, left: insetLeft, right: insetRight }
      : { left: insetLeft, right: insetRight };

  return (
    <div className={cls('relative', className)}>
      <div
        ref={scrollRef}
        onScroll={recompute}
        className={cls(
          'h-full w-full overflow-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
          innerClassName,
        )}
      >
        {children}
      </div>
      {/* Scrollbar wrappers carry an explicit high z-index so they
          paint ABOVE any sticky cell (pinned columns, sticky header)
          inside the scroll container. Without this, sticky <td>
          elements with their own stacking context can render above
          the absolute-positioned scrollbar in some browsers, hiding
          the thumb behind the column's opaque background. */}
      {v && (
        <div
          aria-hidden
          className="pointer-events-none absolute right-0.5 z-50 w-1.5"
          style={{ top: effectiveInsetTop, bottom: 0 }}
        >
          {/* biome-ignore lint/a11y/noStaticElementInteractions: mouse-drag scrollbar thumb inside aria-hidden track; keyboard scrolling handled by the scroll container */}
          <div
            onMouseDown={startVDrag}
            className="pointer-events-auto absolute right-0 w-1.5 cursor-pointer rounded-full bg-foreground/40 transition-colors hover:bg-foreground/60"
            style={{
              height: v.thumb,
              transform: `translateY(${v.pos}px)`,
            }}
          />
        </div>
      )}
      {h && (
        <div
          aria-hidden
          className={cls(
            'pointer-events-none absolute z-50 h-1.5',
            horizontalScrollbarPosition === 'bottom' && 'bottom-0.5',
          )}
          style={hWrapperStyle}
        >
          {/* biome-ignore lint/a11y/noStaticElementInteractions: mouse-drag scrollbar thumb inside aria-hidden track; keyboard scrolling handled by the scroll container */}
          <div
            onMouseDown={startHDrag}
            className={cls(
              'pointer-events-auto absolute h-1.5 cursor-pointer rounded-full bg-foreground/40 transition-colors hover:bg-foreground/60',
              horizontalScrollbarPosition === 'top' ? 'top-0' : 'bottom-0',
            )}
            style={{
              width: h.thumb,
              transform: `translateX(${h.pos}px)`,
            }}
          />
        </div>
      )}
    </div>
  );
});
