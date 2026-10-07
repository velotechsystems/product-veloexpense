/**
 * Ported from ExpenseOS `tests/setup.ts` (550b2945): the polyfills its component tests run
 * with under jsdom, including jest-axe's `toHaveNoViolations` (typed in types/jest-axe.d.ts).
 *
 * Root Vitest setup — runs before every test file.
 *
 *   - jest-dom matchers (`toBeInTheDocument`, `toHaveClass`, …)
 *   - axe-core via jest-axe (we re-export `toHaveNoViolations`)
 *
 * Per-file setup goes in the test itself, not here.
 */
import '@testing-library/jest-dom/vitest';
import { toHaveNoViolations } from 'jest-axe';
import { expect } from 'vitest';

expect.extend(toHaveNoViolations);


// Polyfill `ResizeObserver` (used by Base UI / cmdk in jsdom).
class ResizeObserverPolyfill {
  observe() {}
  unobserve() {}
  disconnect() {}
}
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = ResizeObserverPolyfill as unknown as typeof ResizeObserver;
}

// jsdom doesn't implement matchMedia. Some Base UI primitives query it on mount.
if (typeof window !== 'undefined' && !window.matchMedia) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

// jsdom doesn't implement Element.scrollIntoView. cmdk calls it when items
// become active during keyboard navigation. No-op is sufficient for tests.
if (typeof Element !== 'undefined' && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = function scrollIntoViewPolyfill() {};
}

// jsdom lacks the Pointer Capture API and PointerEvent. Base UI popovers
// (Select, Menu, Popover) call these on open/close; shimming them lets those
// components be exercised with `userEvent` in component tests.
if (typeof Element !== 'undefined') {
  Element.prototype.hasPointerCapture ||= () => false;
  Element.prototype.setPointerCapture ||= () => {};
  Element.prototype.releasePointerCapture ||= () => {};
}
if (typeof window !== 'undefined' && typeof window.PointerEvent === 'undefined') {
  window.PointerEvent = window.MouseEvent as unknown as typeof PointerEvent;
}
