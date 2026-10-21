import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clientPoint,
  createLineDrag,
  type LatLng,
  type LineDragHost,
  LONG_PRESS_MS,
  pressKind,
} from './dragOnLine';

/**
 * The press-and-drag off the selected route (FR-4, TR-18, NFR-14), with a fake event
 * target and fake timers. What is pinned: nothing is dropped and nothing reaches the host
 * but the temporary marker while the pointer moves; one release is one `onDrop`; a mouse
 * press turns panning off at once and a click gives it back; on touch a 450 ms long-press
 * starts the drag while a swipe or a tap before it leaves the map to pan.
 */

/** The fake projection: one map degree per 100 viewport pixels. */
const toLatLng = (x: number, y: number): LatLng => ({ lat: y / 100, lng: x / 100 });

function setUp() {
  const target = new EventTarget();
  const host = {
    setPanning: vi.fn<(on: boolean) => void>(),
    toLatLng: vi.fn(toLatLng),
    ghost: { show: vi.fn(), move: vi.fn(), hide: vi.fn() },
    onStart: vi.fn(),
    onDrop: vi.fn<(at: LatLng) => void>(),
    onCancel: vi.fn(),
    target,
  } satisfies LineDragHost;
  const drag = createLineDrag(host);
  /** Dispatch a DOM-like event with the given fields on the gesture's target. */
  const fire = (type: string, fields: Record<string, unknown> = {}) => {
    const e = new Event(type, { cancelable: true });
    Object.assign(e, fields);
    target.dispatchEvent(e);
    return e;
  };
  const mouse = (x: number, y: number, extra: Record<string, unknown> = {}) => ({
    clientX: x,
    clientY: y,
    button: 0,
    pointerType: 'mouse',
    ...extra,
  });
  const finger = (x: number, y: number) => ({ touches: [{ clientX: x, clientY: y }] });
  return { host, drag, fire, mouse, finger };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('pressKind / clientPoint', () => {
  it.each([
    ['a primary mouse button', { button: 0, clientX: 1, clientY: 1 }, 'mouse'],
    ['a touch event', { touches: [] }, 'touch'],
    ['a touch pointer', { pointerType: 'touch', button: 0 }, 'touch'],
    ['a secondary button — starts nothing', { button: 2 }, null],
    ['nothing at all', null, null],
  ])('%s', (_, e, kind) => {
    expect(pressKind(e)).toBe(kind);
  });

  it('reads a touch from its first finger, or the one that lifted', () => {
    expect(clientPoint({ touches: [{ clientX: 3, clientY: 4 }] })).toEqual({ x: 3, y: 4 });
    expect(clientPoint({ touches: [], changedTouches: [{ clientX: 5, clientY: 6 }] })).toEqual({
      x: 5,
      y: 6,
    });
  });
});

describe('mouse', () => {
  it('a press turns panning off at once, so the press does not pan the map', () => {
    const { host, drag, mouse } = setUp();
    drag.press(mouse(100, 100), { lat: 1, lng: 1 });
    expect(host.setPanning).toHaveBeenCalledOnce();
    expect(host.setPanning).toHaveBeenCalledWith(false);
    expect(host.ghost.show).not.toHaveBeenCalled();
  });

  it('moving the pointer moves only the temporary marker — no drop, nothing else', () => {
    const { host, drag, fire, mouse } = setUp();
    drag.press(mouse(100, 100), { lat: 1, lng: 1 });
    for (let x = 110; x <= 300; x += 10) fire('pointermove', mouse(x, 120));

    expect(host.ghost.show).toHaveBeenCalledTimes(1);
    expect(host.ghost.move).toHaveBeenCalledTimes(19);
    expect(host.ghost.move).toHaveBeenLastCalledWith({ lat: 1.2, lng: 3 });
    expect(host.onStart).toHaveBeenCalledTimes(1);
    expect(host.onDrop).not.toHaveBeenCalled();
    expect(host.onCancel).not.toHaveBeenCalled();
  });

  it('one release is ONE drop, at the release, with the marker gone and panning back', () => {
    const { host, drag, fire, mouse } = setUp();
    drag.press(mouse(100, 100), { lat: 1, lng: 1 });
    fire('pointermove', mouse(200, 150));
    fire('pointerup', mouse(250, 150));
    // A second release (the compatibility mouseup, a touchend) changes nothing.
    fire('pointerup', mouse(260, 150));
    fire('touchend', { changedTouches: [{ clientX: 270, clientY: 150 }] });

    expect(host.onDrop).toHaveBeenCalledOnce();
    expect(host.onDrop).toHaveBeenCalledWith({ lat: 1.5, lng: 2.5 });
    expect(host.ghost.hide).toHaveBeenCalledTimes(1);
    expect(host.setPanning.mock.calls).toEqual([[false], [true]]);
  });

  it('a press released without moving is a click: no drag, no drop, panning back', () => {
    const { host, drag, fire, mouse } = setUp();
    drag.press(mouse(100, 100), { lat: 1, lng: 1 });
    fire('pointermove', mouse(102, 101)); // under the 4 px threshold
    fire('pointerup', mouse(102, 101));
    expect(host.ghost.show).not.toHaveBeenCalled();
    expect(host.onDrop).not.toHaveBeenCalled();
    expect(host.setPanning.mock.calls).toEqual([[false], [true]]);
  });

  it('Escape cancels a drag — and only the drag: it goes no further', () => {
    const { host, drag, fire, mouse } = setUp();
    drag.press(mouse(100, 100), { lat: 1, lng: 1 });
    fire('pointermove', mouse(200, 200));
    fire('keydown', { key: 'Escape' });
    fire('pointerup', mouse(200, 200));
    expect(host.onDrop).not.toHaveBeenCalled();
    expect(host.onCancel).toHaveBeenCalledTimes(1);
    expect(host.ghost.hide).toHaveBeenCalledTimes(1);
  });

  it('the Escape that cancels a drag does not reach the dialog around the map', () => {
    const host = {
      setPanning: vi.fn(),
      toLatLng,
      ghost: { show: vi.fn(), move: vi.fn(), hide: vi.fn() },
      onStart: vi.fn(),
      onDrop: vi.fn(),
      onCancel: vi.fn(),
    } satisfies LineDragHost;
    const drag = createLineDrag(host); // the document, as in the app
    const dialog = vi.fn();
    document.body.addEventListener('keydown', dialog);
    try {
      drag.press({ clientX: 0, clientY: 0, button: 0 }, { lat: 0, lng: 0 });
      document.dispatchEvent(Object.assign(new Event('pointermove'), { clientX: 50, clientY: 0 }));
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      expect(host.onCancel).toHaveBeenCalledTimes(1);
      expect(dialog).not.toHaveBeenCalled();
      // With no drag going, Escape is the dialog's again.
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      expect(dialog).toHaveBeenCalledTimes(1);
    } finally {
      document.body.removeEventListener('keydown', dialog);
    }
  });

  it('a secondary button starts nothing', () => {
    const { host, drag, fire, mouse } = setUp();
    drag.press(mouse(100, 100, { button: 2 }), { lat: 1, lng: 1 });
    fire('pointermove', mouse(200, 200));
    fire('pointerup', mouse(200, 200));
    expect(host.setPanning).not.toHaveBeenCalled();
    expect(host.onDrop).not.toHaveBeenCalled();
  });

  it('dispose mid-drag cancels it and stops listening', () => {
    const { host, drag, fire, mouse } = setUp();
    drag.press(mouse(100, 100), { lat: 1, lng: 1 });
    fire('pointermove', mouse(200, 200));
    drag.dispose();
    fire('pointerup', mouse(200, 200));
    expect(host.onCancel).toHaveBeenCalledTimes(1);
    expect(host.onDrop).not.toHaveBeenCalled();
    expect(host.setPanning).toHaveBeenLastCalledWith(true);
  });
});

describe('touch — a 450 ms long-press, and a swipe still pans', () => {
  it('nothing happens before 450 ms; at 450 ms panning goes off and the marker is up', () => {
    const { host, drag, finger } = setUp();
    drag.press(finger(100, 100), { lat: 1, lng: 1 });
    vi.advanceTimersByTime(LONG_PRESS_MS - 1);
    expect(host.setPanning).not.toHaveBeenCalled();
    expect(host.ghost.show).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(host.setPanning).toHaveBeenCalledOnce();
    expect(host.setPanning).toHaveBeenCalledWith(false);
    expect(host.ghost.show).toHaveBeenCalledOnce();
    expect(host.ghost.show).toHaveBeenCalledWith({ lat: 1, lng: 1 });
    expect(host.onStart).toHaveBeenCalledTimes(1);
  });

  it('a swipe before 450 ms is a pan: panning is never touched and nothing is dropped', () => {
    const { host, drag, fire, finger } = setUp();
    drag.press(finger(100, 100), { lat: 1, lng: 1 });
    vi.advanceTimersByTime(200);
    fire('touchmove', finger(100, 120)); // 20 px: over the 10 px slop
    vi.advanceTimersByTime(1000);
    fire('touchend', { changedTouches: [{ clientX: 100, clientY: 160 }] });

    expect(host.setPanning).not.toHaveBeenCalled();
    expect(host.ghost.show).not.toHaveBeenCalled();
    expect(host.onDrop).not.toHaveBeenCalled();
  });

  it('a small tremor under 10 px does not cancel the long-press', () => {
    const { host, drag, fire, finger } = setUp();
    drag.press(finger(100, 100), { lat: 1, lng: 1 });
    fire('touchmove', finger(104, 105));
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(host.ghost.show).toHaveBeenCalledTimes(1);
  });

  it('a tap before 450 ms drops nothing', () => {
    const { host, drag, fire, finger } = setUp();
    drag.press(finger(100, 100), { lat: 1, lng: 1 });
    vi.advanceTimersByTime(100);
    fire('touchend', { changedTouches: [{ clientX: 100, clientY: 100 }] });
    vi.advanceTimersByTime(1000);
    expect(host.ghost.show).not.toHaveBeenCalled();
    expect(host.onDrop).not.toHaveBeenCalled();
  });

  it('after the long-press the finger drags the marker, and lifting it is ONE drop', () => {
    const { host, drag, fire, finger } = setUp();
    drag.press(finger(100, 100), { lat: 1, lng: 1 });
    vi.advanceTimersByTime(LONG_PRESS_MS);
    const move = fire('touchmove', finger(300, 400));
    // Both the pointer and the touch stream report the same lift: one drop.
    fire('pointerup', { clientX: 300, clientY: 400, pointerType: 'touch' });
    fire('touchend', { changedTouches: [{ clientX: 300, clientY: 400 }] });

    expect(move.defaultPrevented).toBe(true); // the page does not scroll under the finger
    expect(host.onDrop).toHaveBeenCalledOnce();
    expect(host.onDrop).toHaveBeenCalledWith({ lat: 4, lng: 3 });
    expect(host.setPanning).toHaveBeenLastCalledWith(true);
  });

  it('a long-press released without moving drops the point where it was pressed', () => {
    const { host, drag, fire } = setUp();
    drag.press({ touches: [{ clientX: 100, clientY: 100 }] }, { lat: 1, lng: 1 });
    vi.advanceTimersByTime(LONG_PRESS_MS);
    fire('touchend', { touches: [], changedTouches: [] });
    expect(host.onDrop).toHaveBeenCalledOnce();
    expect(host.onDrop).toHaveBeenCalledWith({ lat: 1, lng: 1 });
  });

  it('ignores pointercancel (a browser scroll guess) but ends on touchcancel', () => {
    const { host, drag, fire, finger } = setUp();
    drag.press(finger(100, 100), { lat: 1, lng: 1 });
    vi.advanceTimersByTime(LONG_PRESS_MS);
    fire('pointercancel', { pointerType: 'touch' });
    fire('touchmove', finger(150, 150));
    expect(host.ghost.move).toHaveBeenCalledTimes(1);
    fire('touchcancel');
    expect(host.onCancel).toHaveBeenCalledTimes(1);
    expect(host.onDrop).not.toHaveBeenCalled();
  });
});
