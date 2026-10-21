/**
 * Press on the selected route and drag a pass-through point off it (FR-4, TR-18).
 *
 * The gesture as one small state machine, with no map library and no Google type in it:
 * the map hands it a press (the Google polyline's `mousedown`, whose DOM event and
 * position it forwards) and a host that knows how to turn panning off, turn a viewport
 * point into a map position, and show the temporary marker. So every rule below is a
 * plain test with fake timers and a fake event target.
 *
 *   · **Mouse.** A press arms the drag and turns panning off at once, so the press does
 *     not pan the map. The drag starts after `MOUSE_SLOP_PX` of movement; a press released
 *     sooner was a click, and panning comes back.
 *   · **Touch.** A press starts a `LONG_PRESS_MS` timer and changes nothing else, so a
 *     plain swipe pans the map as always: moving more than `TOUCH_SLOP_PX` before the timer
 *     fires, or lifting the finger, abandons it. When it fires, panning goes off and the
 *     drag starts with the temporary marker under the finger. A long-press released
 *     without moving drops the point where it was pressed (the built-in fallback when a
 *     device will not let the finger move on).
 *   · **While dragging** nothing but the temporary marker moves: no state is set and
 *     nothing is sent. Moves are read from the document, not from Google, whose own
 *     `mousemove` is raised only while the pointer is over the line.
 *   · **The drop** hides the marker, gives panning back and calls `onDrop` exactly once,
 *     with the last position. Escape, a cancelled touch or `dispose` call `onCancel`
 *     instead, and nothing is dropped; an Escape that cancels a drag goes no further, so
 *     it does not also close the dialog around the map.
 *
 * A touch gesture ignores `pointercancel`: a browser that decides a moving finger is a
 * scroll cancels its pointer but keeps sending touch events, and `touchcancel` is what
 * says the touch really ended.
 */

export const LONG_PRESS_MS = 450;
/** A finger that moves this far before the long-press fires is panning, not pressing. */
export const TOUCH_SLOP_PX = 10;
/** A mouse that moves this far after the press is dragging, not clicking. */
export const MOUSE_SLOP_PX = 4;

export interface LatLng {
  lat: number;
  lng: number;
}

export interface LineDragHost {
  /** Map panning and zooming by gesture, on or off. */
  setPanning(on: boolean): void;
  /** A viewport point as a map position; null while the map cannot say. */
  toLatLng(clientX: number, clientY: number): LatLng | null;
  /** The temporary marker that follows the pointer. Drawn imperatively, never rendered. */
  ghost: { show(at: LatLng): void; move(at: LatLng): void; hide(): void };
  /** The drag has started: the marker is up. */
  onStart(): void;
  /** Released: the one call that may lead to a request. */
  onDrop(at: LatLng): void;
  /** A started drag ended without a drop. */
  onCancel(): void;
  /** Where the gesture's moves and release are read. The document, by default. */
  target?: EventTarget;
}

export interface LineDrag {
  /** A press on the line: its DOM event, and where on the map it landed when known. */
  press(domEvent: unknown, at: LatLng | null): void;
  /** Stop listening; a drag in progress is cancelled. */
  dispose(): void;
}

type Kind = 'mouse' | 'touch';
type Phase = 'idle' | 'armed' | 'holding' | 'dragging';

interface ClientPoint {
  x: number;
  y: number;
}

/** Touch or mouse, or null for a press that should start nothing (a secondary button). */
export function pressKind(e: unknown): Kind | null {
  if (!e || typeof e !== 'object') return null;
  if ('touches' in e) return 'touch';
  const pointer = (e as { pointerType?: unknown }).pointerType;
  if (pointer === 'touch') return 'touch';
  const button = (e as { button?: unknown }).button;
  if (typeof button === 'number' && button !== 0) return null;
  return 'mouse';
}

/** The viewport point of a mouse, pointer or touch event. */
export function clientPoint(e: unknown): ClientPoint | null {
  if (!e || typeof e !== 'object') return null;
  if ('touches' in e) {
    const t = e as { touches?: ArrayLike<Touchish>; changedTouches?: ArrayLike<Touchish> };
    const touch = t.touches?.[0] ?? t.changedTouches?.[0];
    return touch ? { x: touch.clientX, y: touch.clientY } : null;
  }
  const { clientX, clientY } = e as { clientX?: unknown; clientY?: unknown };
  return typeof clientX === 'number' && typeof clientY === 'number'
    ? { x: clientX, y: clientY }
    : null;
}

interface Touchish {
  clientX: number;
  clientY: number;
}

const MOVES = ['pointermove', 'touchmove'] as const;
const ENDS = ['pointerup', 'touchend'] as const;
const CANCELS = ['pointercancel', 'touchcancel'] as const;

export function createLineDrag(host: LineDragHost): LineDrag {
  const target = host.target ?? document;
  let phase: Phase = 'idle';
  let kind: Kind = 'mouse';
  let start: ClientPoint = { x: 0, y: 0 };
  let last: LatLng | null = null;
  let panningOff = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const positionOf = (e: unknown): LatLng | null => {
    const p = clientPoint(e);
    return p ? host.toLatLng(p.x, p.y) : null;
  };
  const moved = (e: unknown): number => {
    const p = clientPoint(e);
    return p ? Math.hypot(p.x - start.x, p.y - start.y) : 0;
  };

  const panning = (on: boolean) => {
    if (on === !panningOff) return;
    panningOff = !on;
    host.setPanning(on);
  };

  const beginDrag = (at: LatLng | null) => {
    if (at) last = at;
    if (!last) {
      // The map cannot place the point: there is nothing to drag.
      end();
      return;
    }
    phase = 'dragging';
    panning(false);
    host.ghost.show(last);
    host.onStart();
  };

  /** Back to idle: listeners off, timer off, marker hidden, panning back. */
  const end = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    for (const name of MOVES) target.removeEventListener(name, onMove);
    for (const name of ENDS) target.removeEventListener(name, onEnd);
    for (const name of CANCELS) target.removeEventListener(name, onCancelEvent);
    target.removeEventListener('keydown', onKey, true);
    if (phase === 'dragging') host.ghost.hide();
    phase = 'idle';
    panning(true);
  };

  function onMove(e: Event) {
    if (phase === 'holding') {
      if (moved(e) > TOUCH_SLOP_PX) end(); // a swipe: the map pans, as it always did
      return;
    }
    if (phase === 'armed') {
      if (moved(e) > MOUSE_SLOP_PX) beginDrag(positionOf(e));
      return;
    }
    if (phase !== 'dragging') return;
    // A finger dragging the marker must not scroll the page under it.
    if (e.type === 'touchmove' && e.cancelable) e.preventDefault();
    const at = positionOf(e);
    if (!at) return;
    last = at;
    host.ghost.move(at);
  }

  function onEnd(e: Event) {
    if (phase !== 'dragging') {
      // A click, or a tap before the long-press: nothing was started.
      end();
      return;
    }
    const at = positionOf(e) ?? last;
    end();
    if (at) host.onDrop(at);
  }

  function cancel() {
    const wasDragging = phase === 'dragging';
    end();
    if (wasDragging) host.onCancel();
  }

  function onCancelEvent(e: Event) {
    // See the file comment: a touch drag ends on `touchcancel`, not `pointercancel`.
    if (kind === 'touch' && e.type === 'pointercancel') return;
    cancel();
  }

  function onKey(e: Event) {
    if ((e as KeyboardEvent).key !== 'Escape') return;
    // Escape during a drag cancels the drag, and only that: the workspace stays open.
    if (phase === 'dragging') e.stopPropagation();
    cancel();
  }

  return {
    press(domEvent, at) {
      if (phase !== 'idle') return;
      const k = pressKind(domEvent);
      const p = clientPoint(domEvent);
      if (!k || !p) return;
      kind = k;
      start = p;
      last = at ?? host.toLatLng(p.x, p.y);
      for (const name of MOVES) target.addEventListener(name, onMove, { passive: false });
      for (const name of ENDS) target.addEventListener(name, onEnd);
      for (const name of CANCELS) target.addEventListener(name, onCancelEvent);
      // Capture, so a drag's Escape is read before the dialog's own Escape handler.
      target.addEventListener('keydown', onKey, true);
      if (kind === 'mouse') {
        phase = 'armed';
        panning(false);
        return;
      }
      phase = 'holding';
      timer = setTimeout(() => {
        timer = null;
        beginDrag(null);
      }, LONG_PRESS_MS);
    },
    dispose: cancel,
  };
}
