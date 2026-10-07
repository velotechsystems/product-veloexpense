'use client';

import { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { cls } from '../data-table/helpers';

/**
 * macOS hides overlay scrollbars regardless of `::-webkit-scrollbar`
 * styling — System Settings → "Show scroll bars" wins. To guarantee
 * a visible scrollbar, we hide the native one and render our own
 * thumb overlay. The thumb is draggable; mouse wheel / trackpad
 * scroll on the content area still works natively.
 */
export function CustomScrollBox({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [metrics, setMetrics] = useState<{ ratio: number; top: number } | null>(null);
  const dragRef = useRef<{ startY: number; startScroll: number } | null>(null);

  const recompute = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ratio = el.clientHeight / el.scrollHeight;
    if (ratio >= 1) {
      setMetrics(null);
      return;
    }
    const top = (el.scrollTop / el.scrollHeight) * el.clientHeight;
    setMetrics({ ratio, top });
  }, []);

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

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      const drag = dragRef.current;
      const el = scrollRef.current;
      if (!drag || !el) return;
      const deltaY = e.clientY - drag.startY;
      const ratio = el.scrollHeight / el.clientHeight;
      el.scrollTop = drag.startScroll + deltaY * ratio;
    };
    const onMouseUp = () => {
      dragRef.current = null;
      document.body.style.userSelect = '';
    };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, []);

  const startDrag = (e: React.MouseEvent) => {
    const el = scrollRef.current;
    if (!el) return;
    dragRef.current = { startY: e.clientY, startScroll: el.scrollTop };
    document.body.style.userSelect = 'none';
    e.preventDefault();
  };

  const thumbHeight = metrics ? Math.max(24, metrics.ratio * 100) : 0;

  return (
    <div className={cls('relative', className)}>
      <div
        ref={scrollRef}
        onScroll={recompute}
        className="h-full overflow-y-scroll pr-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {children}
      </div>
      {metrics && (
        <div aria-hidden className="pointer-events-none absolute top-0 right-0.5 h-full w-1.5">
          {/* biome-ignore lint/a11y/noStaticElementInteractions: mouse-drag scrollbar thumb inside aria-hidden track; keyboard scrolling handled by the scroll container */}
          <div
            onMouseDown={startDrag}
            className="pointer-events-auto absolute right-0 w-1.5 cursor-pointer rounded-full bg-foreground/30 transition-colors hover:bg-foreground/50"
            style={{
              height: `${thumbHeight}%`,
              transform: `translateY(${metrics.top}px)`,
            }}
          />
        </div>
      )}
    </div>
  );
}
