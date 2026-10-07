import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Scroll2D } from './Scroll2D';

/**
 * The custom scrollbar thumbs.
 *
 * This component exists because macOS hides native overlay scrollbars however you
 * style them, so the thumbs are painted by hand — which means their size and position
 * are arithmetic this file owns, and arithmetic is what a test can hold.
 *
 * The rule that is easy to lose and hard to notice is the **suppression floor**. A
 * browser can disagree with itself about `scrollWidth` vs `clientWidth` by a pixel or
 * two under `table-layout: fixed`, and a naive proportional thumb then paints at
 * ~99% of the track: a bar that looks static, cannot visibly move, and reads as
 * chrome rather than as a scroll affordance. So a thumb within 8px of its track
 * suppresses the bar entirely. Removing that check does not break a test that only
 * asserts "a thumb appears" — it just puts a fake scrollbar on every table.
 *
 * jsdom reports 0 for every layout metric, so each test defines the four it needs on
 * the scroll element and fires a scroll to trigger the recompute.
 */

/** jsdom has no layout; install the metrics `recompute` reads. */
function setMetrics(
  el: HTMLElement,
  m: {
    scrollHeight?: number;
    clientHeight?: number;
    scrollWidth?: number;
    clientWidth?: number;
    scrollTop?: number;
    scrollLeft?: number;
  },
) {
  for (const [key, value] of Object.entries(m)) {
    Object.defineProperty(el, key, { value, configurable: true, writable: true });
  }
}

interface Rendered {
  container: HTMLElement;
  scroller: HTMLElement;
}

function setup(props: Record<string, unknown> = {}, body?: React.ReactNode): Rendered {
  const { container } = render(
    <Scroll2D {...props}>{body ?? <div style={{ height: 2000, width: 2000 }} />}</Scroll2D>,
  );
  return { container, scroller: container.querySelector('.overflow-auto') as HTMLElement };
}

/** The painted thumbs, if any. Tracks are aria-hidden; the thumb is the inner div. */
const thumbs = (container: HTMLElement) => {
  const tracks = [...container.querySelectorAll('[aria-hidden]')] as HTMLElement[];
  return {
    vertical: tracks.find((t) => t.className.includes('w-1.5'))?.firstElementChild as
      | HTMLElement
      | undefined,
    horizontal: tracks.find((t) => t.className.includes('h-1.5'))?.firstElementChild as
      | HTMLElement
      | undefined,
  };
};

const recompute = (scroller: HTMLElement) => fireEvent.scroll(scroller);

describe('when there is nothing to scroll', () => {
  it('paints no thumbs', () => {
    const { container, scroller } = setup();
    setMetrics(scroller, {
      scrollHeight: 300,
      clientHeight: 300,
      scrollWidth: 300,
      clientWidth: 300,
    });
    recompute(scroller);
    expect(thumbs(container).vertical).toBeUndefined();
    expect(thumbs(container).horizontal).toBeUndefined();
  });

  it('ignores a sub-pixel overflow of one pixel', () => {
    // Browsers disagree by ~1px under `table-layout: fixed`; that is not scroll room.
    const { container, scroller } = setup();
    setMetrics(scroller, {
      scrollHeight: 301,
      clientHeight: 300,
      scrollWidth: 301,
      clientWidth: 300,
    });
    recompute(scroller);
    expect(thumbs(container).vertical).toBeUndefined();
    expect(thumbs(container).horizontal).toBeUndefined();
  });

  it('suppresses a thumb that would fill almost the whole track', () => {
    /**
     * The suppression floor. 300px viewport in 310px of content leaves a thumb of
     * ~290px in a 300px track — 10px of travel, but the proportional thumb lands
     * within 8px of the track once rounding is applied, so the bar is suppressed
     * rather than painted as a static-looking full-width bar.
     */
    const { container, scroller } = setup();
    setMetrics(scroller, {
      scrollHeight: 305,
      clientHeight: 300,
      scrollWidth: 305,
      clientWidth: 300,
    });
    recompute(scroller);
    expect(thumbs(container).vertical).toBeUndefined();
    expect(thumbs(container).horizontal).toBeUndefined();
  });
});

describe('the vertical thumb', () => {
  it('appears once there is real scroll room', () => {
    const { container, scroller } = setup();
    setMetrics(scroller, {
      scrollHeight: 1000,
      clientHeight: 200,
      scrollWidth: 200,
      clientWidth: 200,
    });
    recompute(scroller);
    expect(thumbs(container).vertical).toBeDefined();
  });

  it('is sized in proportion to the content', () => {
    // 200 of 1000 visible → one fifth of a 200px track.
    const { container, scroller } = setup();
    setMetrics(scroller, {
      scrollHeight: 1000,
      clientHeight: 200,
      scrollWidth: 200,
      clientWidth: 200,
    });
    recompute(scroller);
    expect(thumbs(container).vertical?.style.height).toBe('40px');
  });

  it('never shrinks below a grabbable minimum', () => {
    // 200 of 100_000 visible would be a 0.4px thumb — unusable, so it floors at 24px.
    const { container, scroller } = setup();
    setMetrics(scroller, {
      scrollHeight: 100_000,
      clientHeight: 200,
      scrollWidth: 200,
      clientWidth: 200,
    });
    recompute(scroller);
    expect(thumbs(container).vertical?.style.height).toBe('24px');
  });

  it('sits at the top when unscrolled', () => {
    const { container, scroller } = setup();
    setMetrics(scroller, {
      scrollHeight: 1000,
      clientHeight: 200,
      scrollWidth: 200,
      clientWidth: 200,
      scrollTop: 0,
    });
    recompute(scroller);
    expect(thumbs(container).vertical?.style.transform).toBe('translateY(0px)');
  });

  it('reaches the end of its travel when scrolled to the bottom', () => {
    // scrollTop 800 of 800 → the full (track 200 − thumb 40) = 160px of travel.
    const { container, scroller } = setup();
    setMetrics(scroller, {
      scrollHeight: 1000,
      clientHeight: 200,
      scrollWidth: 200,
      clientWidth: 200,
      scrollTop: 800,
    });
    recompute(scroller);
    expect(thumbs(container).vertical?.style.transform).toBe('translateY(160px)');
  });

  it('sits halfway at half scroll', () => {
    const { container, scroller } = setup();
    setMetrics(scroller, {
      scrollHeight: 1000,
      clientHeight: 200,
      scrollWidth: 200,
      clientWidth: 200,
      scrollTop: 400,
    });
    recompute(scroller);
    expect(thumbs(container).vertical?.style.transform).toBe('translateY(80px)');
  });
});

describe('insetTop reserves room for a sticky header', () => {
  it('shrinks the track rather than the content', () => {
    /**
     * The track starts BELOW the header, so the thumb is proportional to the shrunk
     * track: a 40px inset leaves 160px of track, and one fifth of that is 32px.
     * Getting this wrong puts the thumb behind the sticky header at scroll position 0.
     */
    const { container, scroller } = setup({ insetTop: 40 });
    setMetrics(scroller, {
      scrollHeight: 1000,
      clientHeight: 200,
      scrollWidth: 200,
      clientWidth: 200,
    });
    recompute(scroller);
    expect(thumbs(container).vertical?.style.height).toBe('32px');
  });

  it('offsets the track by the inset', () => {
    const { container, scroller } = setup({ insetTop: 40 });
    setMetrics(scroller, {
      scrollHeight: 1000,
      clientHeight: 200,
      scrollWidth: 200,
      clientWidth: 200,
    });
    recompute(scroller);
    const track = thumbs(container).vertical?.parentElement as HTMLElement;
    expect(track.style.top).toBe('40px');
  });

  it('suppresses the bar when the inset consumes the whole track', () => {
    const { container, scroller } = setup({ insetTop: 200 });
    setMetrics(scroller, {
      scrollHeight: 1000,
      clientHeight: 200,
      scrollWidth: 200,
      clientWidth: 200,
    });
    recompute(scroller);
    expect(thumbs(container).vertical).toBeUndefined();
  });

  it('auto-measures a tagged header when no inset is given', () => {
    // The consumer tags a child rather than threading pixel measurements through.
    const { container, scroller } = setup(
      {},
      <>
        <div data-scroll2d-header>header</div>
        <div style={{ height: 2000 }} />
      </>,
    );
    expect(container.querySelector('[data-scroll2d-header]')).toBeInTheDocument();
    setMetrics(scroller, {
      scrollHeight: 1000,
      clientHeight: 200,
      scrollWidth: 200,
      clientWidth: 200,
    });
    recompute(scroller);
    // jsdom measures the header at 0 height, so the effective inset is 0 and the
    // thumb matches the un-inset case — what is pinned here is that the auto-measure
    // path runs without throwing and does not override a real prop (next test).
    expect(thumbs(container).vertical?.style.height).toBe('40px');
  });

  it('lets an explicit inset win over the auto-measure', () => {
    const { container, scroller } = setup(
      { insetTop: 40 },
      <>
        <div data-scroll2d-header>header</div>
        <div style={{ height: 2000 }} />
      </>,
    );
    setMetrics(scroller, {
      scrollHeight: 1000,
      clientHeight: 200,
      scrollWidth: 200,
      clientWidth: 200,
    });
    recompute(scroller);
    expect(thumbs(container).vertical?.style.height).toBe('32px');
  });
});

describe('the horizontal thumb', () => {
  it('appears and is sized against the horizontal track', () => {
    const { container, scroller } = setup();
    setMetrics(scroller, {
      scrollHeight: 200,
      clientHeight: 200,
      scrollWidth: 1000,
      clientWidth: 200,
    });
    recompute(scroller);
    expect(thumbs(container).horizontal?.style.height).toBeFalsy();
    expect(thumbs(container).horizontal?.style.width).toBe('40px');
  });

  it('shrinks its track by the pinned-column insets on both sides', () => {
    // insetLeft + insetRight reserve the pinned bands: 200 − 20 − 20 = 160 of track.
    const { container, scroller } = setup({ insetLeft: 20, insetRight: 20 });
    setMetrics(scroller, {
      scrollHeight: 200,
      clientHeight: 200,
      scrollWidth: 1000,
      clientWidth: 200,
    });
    recompute(scroller);
    expect(thumbs(container).horizontal?.style.width).toBe('32px');
  });

  it('positions the thumb from scrollLeft', () => {
    const { container, scroller } = setup();
    setMetrics(scroller, {
      scrollHeight: 200,
      clientHeight: 200,
      scrollWidth: 1000,
      clientWidth: 200,
      scrollLeft: 800,
    });
    recompute(scroller);
    expect(thumbs(container).horizontal?.style.transform).toBe('translateX(160px)');
  });

  it('sits at the bottom edge by default', () => {
    const { container, scroller } = setup();
    setMetrics(scroller, {
      scrollHeight: 200,
      clientHeight: 200,
      scrollWidth: 1000,
      clientWidth: 200,
    });
    recompute(scroller);
    const track = thumbs(container).horizontal?.parentElement as HTMLElement;
    expect(track.className).toContain('bottom-0.5');
    expect(track.style.top).toBe('');
  });

  it('can sit below the sticky header instead', () => {
    /**
     * `top` mode exists so a tall table does not make somebody scroll to the bottom
     * to discover it scrolls sideways. The bar then hangs off `insetTop`.
     */
    const { container, scroller } = setup({ horizontalScrollbarPosition: 'top', insetTop: 40 });
    setMetrics(scroller, {
      scrollHeight: 200,
      clientHeight: 200,
      scrollWidth: 1000,
      clientWidth: 200,
    });
    recompute(scroller);
    const track = thumbs(container).horizontal?.parentElement as HTMLElement;
    expect(track.style.top).toBe('40px');
    expect(track.className).not.toContain('bottom-0.5');
    expect(thumbs(container).horizontal?.className).toContain('top-0');
  });

  it('suppresses the bar when the insets consume the track', () => {
    const { container, scroller } = setup({ insetLeft: 100, insetRight: 100 });
    setMetrics(scroller, {
      scrollHeight: 200,
      clientHeight: 200,
      scrollWidth: 1000,
      clientWidth: 200,
    });
    recompute(scroller);
    expect(thumbs(container).horizontal).toBeUndefined();
  });
});

describe('dragging a thumb', () => {
  it('scrolls the container by the content:track ratio, not one-to-one', () => {
    /**
     * The scale factor is the whole point: a 200px track standing in for 1000px of
     * content means one pixel of thumb travel is five pixels of scroll. Dragging
     * one-to-one would make a long table feel broken near the end.
     */
    const { container, scroller } = setup();
    setMetrics(scroller, {
      scrollHeight: 1000,
      clientHeight: 200,
      scrollWidth: 200,
      clientWidth: 200,
      scrollTop: 0,
    });
    recompute(scroller);
    const thumb = thumbs(container).vertical as HTMLElement;
    fireEvent.mouseDown(thumb, { clientY: 0 });
    fireEvent.mouseMove(window, { clientY: 16 });
    // (1000 − 200) / (200 − 40) = 5 px of scroll per px of drag.
    expect(scroller.scrollTop).toBe(80);
    fireEvent.mouseUp(window);
  });

  it('scrolls horizontally the same way', () => {
    const { container, scroller } = setup();
    setMetrics(scroller, {
      scrollHeight: 200,
      clientHeight: 200,
      scrollWidth: 1000,
      clientWidth: 200,
      scrollLeft: 0,
    });
    recompute(scroller);
    const thumb = thumbs(container).horizontal as HTMLElement;
    fireEvent.mouseDown(thumb, { clientX: 0 });
    fireEvent.mouseMove(window, { clientX: 10 });
    expect(scroller.scrollLeft).toBe(50);
    fireEvent.mouseUp(window);
  });

  it('suppresses text selection while dragging and restores it after', () => {
    // Without this, dragging the thumb selects the table's text behind it.
    const { container, scroller } = setup();
    setMetrics(scroller, {
      scrollHeight: 1000,
      clientHeight: 200,
      scrollWidth: 200,
      clientWidth: 200,
    });
    recompute(scroller);
    fireEvent.mouseDown(thumbs(container).vertical as HTMLElement, { clientY: 0 });
    expect(document.body.style.userSelect).toBe('none');
    fireEvent.mouseUp(window);
    expect(document.body.style.userSelect).toBe('');
  });

  it('stops moving the container once the button is released', () => {
    const { container, scroller } = setup();
    setMetrics(scroller, {
      scrollHeight: 1000,
      clientHeight: 200,
      scrollWidth: 200,
      clientWidth: 200,
      scrollTop: 0,
    });
    recompute(scroller);
    fireEvent.mouseDown(thumbs(container).vertical as HTMLElement, { clientY: 0 });
    fireEvent.mouseMove(window, { clientY: 10 });
    const after = scroller.scrollTop;
    fireEvent.mouseUp(window);
    fireEvent.mouseMove(window, { clientY: 400 });
    expect(scroller.scrollTop).toBe(after);
  });

  it('ignores a stray mousemove with no drag in progress', () => {
    const { scroller } = setup();
    setMetrics(scroller, {
      scrollHeight: 1000,
      clientHeight: 200,
      scrollWidth: 200,
      clientWidth: 200,
      scrollTop: 0,
    });
    recompute(scroller);
    fireEvent.mouseMove(window, { clientY: 400 });
    expect(scroller.scrollTop).toBe(0);
  });
});

describe('composition', () => {
  it('renders its children inside the scrolling element', () => {
    const { scroller } = setup({}, <div data-testid="body">rows</div>);
    expect(scroller.querySelector('[data-testid="body"]')).toBeInTheDocument();
  });

  it('hides the native scrollbars it is replacing', () => {
    const { scroller } = setup();
    expect(scroller.className).toContain('[scrollbar-width:none]');
  });

  it('forwards a ref to the scrolling element, not the wrapper', () => {
    // Consumers use it as an IntersectionObserver root, which only works on the
    // element that actually scrolls.
    let captured: HTMLDivElement | null = null;
    const { container } = render(
      <Scroll2D
        ref={(el) => {
          captured = el;
        }}
      >
        <div />
      </Scroll2D>,
    );
    expect(captured).toBe(container.querySelector('.overflow-auto'));
  });

  it('applies both class-name slots to their own elements', () => {
    const { container, scroller } = setup({ className: 'outer-x', innerClassName: 'inner-y' });
    expect(container.firstElementChild?.className).toContain('outer-x');
    expect(scroller.className).toContain('inner-y');
  });

  it('paints both thumbs when the content overflows in both directions', () => {
    const { container, scroller } = setup();
    setMetrics(scroller, {
      scrollHeight: 1000,
      clientHeight: 200,
      scrollWidth: 1000,
      clientWidth: 200,
    });
    recompute(scroller);
    expect(thumbs(container).vertical).toBeDefined();
    expect(thumbs(container).horizontal).toBeDefined();
  });
});
