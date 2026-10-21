'use client';

/**
 * Whether an element is on screen, from an `IntersectionObserver` (FR-3, FR-6).
 *
 * Two answers:
 *
 *   · `onScreen` — in the viewport right now.
 *   · `seen` — has been on screen at least once since mount, and stays true. The small map
 *     mounts on first sight and is then left mounted: unmounting it on scroll and mounting
 *     it again would ask for its path and load Google's map a second time for the same
 *     line, so thirty lines scrolled past cost nothing until seen, and nothing more after.
 *
 * With no `IntersectionObserver` at all (an old browser) the element counts as on screen,
 * so the line still works; it only loses the saving. Nothing here reads layout itself.
 */

import { type RefCallback, useCallback, useEffect, useState } from 'react';

export interface OnScreen<T extends Element> {
  /** Put on the element to watch. */
  ref: RefCallback<T>;
  onScreen: boolean;
  seen: boolean;
}

export function useOnScreen<T extends Element = HTMLElement>(): OnScreen<T> {
  const [node, setNode] = useState<T | null>(null);
  const supported = typeof IntersectionObserver !== 'undefined';
  const [onScreen, setOnScreen] = useState(!supported);
  const [seen, setSeen] = useState(!supported);
  const ref = useCallback<RefCallback<T>>((el) => setNode(el), []);

  useEffect(() => {
    if (!node || !supported) return;
    const observer = new IntersectionObserver((entries) => {
      const visible = entries.some((e) => e.isIntersecting);
      setOnScreen(visible);
      if (visible) setSeen(true);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [node, supported]);

  return { ref, onScreen, seen };
}
