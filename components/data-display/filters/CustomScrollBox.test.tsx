import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CustomScrollBox } from './CustomScrollBox';

/**
 * The facet list's hand-painted scrollbar.
 *
 * It exists because macOS hides overlay scrollbars whatever CSS says — System
 * Settings wins — so a long facet list gave no hint that it scrolled. The thumb is
 * therefore drawn here, and the two things worth pinning are that it appears ONLY
 * when there is overflow (an always-on bar in a short list is visual noise on every
 * filter rail) and that dragging it moves the content by the content:viewport ratio
 * rather than one-to-one.
 *
 * jsdom reports 0 for layout, so each test installs the metrics `recompute` reads.
 */

function setMetrics(
  el: HTMLElement,
  m: { scrollHeight?: number; clientHeight?: number; scrollTop?: number },
) {
  for (const [key, value] of Object.entries(m)) {
    Object.defineProperty(el, key, { value, configurable: true, writable: true });
  }
}

function setup(children: React.ReactNode = <div style={{ height: 1000 }}>rows</div>) {
  const { container } = render(<CustomScrollBox>{children}</CustomScrollBox>);
  const scroller = container.querySelector('.overflow-y-scroll') as HTMLElement;
  return { container, scroller };
}

const thumb = (container: HTMLElement) =>
  container.querySelector('[aria-hidden]')?.firstElementChild as HTMLElement | undefined;

describe('when the content fits', () => {
  it('paints no thumb', () => {
    const { container, scroller } = setup();
    setMetrics(scroller, { scrollHeight: 200, clientHeight: 200 });
    fireEvent.scroll(scroller);
    expect(thumb(container)).toBeUndefined();
  });

  it('paints no thumb when the content is shorter than the box', () => {
    const { container, scroller } = setup();
    setMetrics(scroller, { scrollHeight: 100, clientHeight: 200 });
    fireEvent.scroll(scroller);
    expect(thumb(container)).toBeUndefined();
  });
});

describe('when the content overflows', () => {
  it('paints a thumb', () => {
    const { container, scroller } = setup();
    setMetrics(scroller, { scrollHeight: 1000, clientHeight: 200 });
    fireEvent.scroll(scroller);
    expect(thumb(container)).toBeDefined();
  });

  it('sizes the thumb as a percentage of the visible fraction', () => {
    // 400 of 1000 visible → 40%.
    const { container, scroller } = setup();
    setMetrics(scroller, { scrollHeight: 1000, clientHeight: 400 });
    fireEvent.scroll(scroller);
    expect(thumb(container)?.style.height).toBe('40%');
  });

  it('floors the thumb at a grabbable size', () => {
    /**
     * The floor is `Math.max(24, ratio * 100)` and the unit is PERCENT, not pixels —
     * so it clamps at 24% of the track and bites for any list more than ~4× its own
     * height. Reading the 24 as pixels (as the sibling Scroll2D's floor genuinely is)
     * is the easy misreading, and it makes the thumb look wrong on long facet lists
     * rather than throwing.
     */
    const { container, scroller } = setup();
    setMetrics(scroller, { scrollHeight: 100_000, clientHeight: 200 });
    fireEvent.scroll(scroller);
    expect(thumb(container)?.style.height).toBe('24%');
  });

  it('applies the floor to anything under a quarter of the track', () => {
    const { container, scroller } = setup();
    setMetrics(scroller, { scrollHeight: 1000, clientHeight: 200 });
    fireEvent.scroll(scroller);
    expect(thumb(container)?.style.height).toBe('24%');
  });

  it('positions the thumb from the scroll offset', () => {
    const { container, scroller } = setup();
    setMetrics(scroller, { scrollHeight: 1000, clientHeight: 200, scrollTop: 500 });
    fireEvent.scroll(scroller);
    expect(thumb(container)?.style.transform).toBe('translateY(100px)');
  });

  it('starts the thumb at the top', () => {
    const { container, scroller } = setup();
    setMetrics(scroller, { scrollHeight: 1000, clientHeight: 200, scrollTop: 0 });
    fireEvent.scroll(scroller);
    expect(thumb(container)?.style.transform).toBe('translateY(0px)');
  });

  it('drops the thumb again when the content shrinks to fit', () => {
    // The facet list re-renders as filters narrow it; a stale thumb would linger.
    const { container, scroller } = setup();
    setMetrics(scroller, { scrollHeight: 1000, clientHeight: 200 });
    fireEvent.scroll(scroller);
    expect(thumb(container)).toBeDefined();
    setMetrics(scroller, { scrollHeight: 150, clientHeight: 200 });
    fireEvent.scroll(scroller);
    expect(thumb(container)).toBeUndefined();
  });
});

describe('dragging', () => {
  it('scrolls by the content:viewport ratio', () => {
    // 1000/200 = 5 px of content per px of drag.
    const { container, scroller } = setup();
    setMetrics(scroller, { scrollHeight: 1000, clientHeight: 200, scrollTop: 0 });
    fireEvent.scroll(scroller);
    fireEvent.mouseDown(thumb(container) as HTMLElement, { clientY: 0 });
    fireEvent.mouseMove(window, { clientY: 10 });
    expect(scroller.scrollTop).toBe(50);
    fireEvent.mouseUp(window);
  });

  it('drags upward from a scrolled position', () => {
    const { container, scroller } = setup();
    setMetrics(scroller, { scrollHeight: 1000, clientHeight: 200, scrollTop: 500 });
    fireEvent.scroll(scroller);
    fireEvent.mouseDown(thumb(container) as HTMLElement, { clientY: 100 });
    fireEvent.mouseMove(window, { clientY: 80 });
    expect(scroller.scrollTop).toBe(400);
    fireEvent.mouseUp(window);
  });

  it('suppresses text selection while dragging and restores it after', () => {
    // Otherwise dragging the thumb selects the facet labels behind it.
    const { container, scroller } = setup();
    setMetrics(scroller, { scrollHeight: 1000, clientHeight: 200 });
    fireEvent.scroll(scroller);
    fireEvent.mouseDown(thumb(container) as HTMLElement, { clientY: 0 });
    expect(document.body.style.userSelect).toBe('none');
    fireEvent.mouseUp(window);
    expect(document.body.style.userSelect).toBe('');
  });

  it('stops once the button is released', () => {
    const { container, scroller } = setup();
    setMetrics(scroller, { scrollHeight: 1000, clientHeight: 200, scrollTop: 0 });
    fireEvent.scroll(scroller);
    fireEvent.mouseDown(thumb(container) as HTMLElement, { clientY: 0 });
    fireEvent.mouseMove(window, { clientY: 10 });
    const after = scroller.scrollTop;
    fireEvent.mouseUp(window);
    fireEvent.mouseMove(window, { clientY: 200 });
    expect(scroller.scrollTop).toBe(after);
  });

  it('ignores a mousemove with no drag in progress', () => {
    const { scroller } = setup();
    setMetrics(scroller, { scrollHeight: 1000, clientHeight: 200, scrollTop: 0 });
    fireEvent.scroll(scroller);
    fireEvent.mouseMove(window, { clientY: 200 });
    expect(scroller.scrollTop).toBe(0);
  });
});

describe('composition', () => {
  it('renders its children in the scrolling element', () => {
    const { scroller } = setup(<div data-testid="rows">facets</div>);
    expect(scroller.querySelector('[data-testid="rows"]')).toBeInTheDocument();
  });

  it('hides the native scrollbar it replaces', () => {
    const { scroller } = setup();
    expect(scroller.className).toContain('[scrollbar-width:none]');
  });
});
