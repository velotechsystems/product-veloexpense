import { COMPACT_QUERY } from '@expenseos/design-system';
import { vi } from 'vitest';
import { COARSE_POINTER_QUERY, resetCoarsePointerStore } from '@/lib/useCoarsePointer';
import { BELOW_LG_QUERY, resetIsBelowLgStore } from '@/lib/useIsBelowLg';

/**
 * Render a component test on a phone or on a desktop — the pointer, the
 * compact breakpoint and the `lg` breakpoint answered together and coherently.
 *
 * WHY THIS IS NOT TWO LINES IN EACH TEST FILE. Both halves of the pair are
 * things a caller gets wrong once and then debugs for an afternoon, and neither
 * of them is visible in the test that suffers from it:
 *
 *   · the stub has to be QUERY-KEYED. The obvious
 *     `vi.fn().mockReturnValue({ matches: true })` returns the same answer to
 *     every query, so it cannot express "coarse yes, fine no" — it says yes to
 *     `(pointer: fine)` too, and to `(prefers-reduced-motion: reduce)`, and to
 *     whatever a Base UI primitive mounted in the same tree happens to ask. A
 *     component test that stubbed it that way would be exercising a device that
 *     does not exist.
 *   · the stub does NOT clean itself up. `vitest.config.ts` sets neither
 *     `unstubGlobals` nor `restoreMocks`, and — the trap — `vi.restoreAllMocks()`
 *     does not undo a `vi.stubGlobal`. So a coarse stub set in one test stays
 *     coarse for every test after it in the same file, and for whatever file the
 *     worker picks up next. `parts.receiptPane.test.tsx` calls
 *     `vi.restoreAllMocks()` in its `beforeEach` and would have looked fully
 *     cleaned while leaking a phone-shaped `matchMedia` across the suite.
 *   · the stub has to be COHERENT ACROSS SEAMS, and this is the sharp one.
 *     This file used to answer the pointer question and nothing else, which
 *     meant `stubPointer('coarse')` answered FALSE to `COMPACT_QUERY`: a test
 *     that asked for a finger got one, on a desktop-width viewport. That is
 *     not a device, and a test written against it is asserting about hardware
 *     nobody ships. The seams are genuinely independent — `matchMedia` is
 *     asked three separate questions by three separate module stores — so
 *     stacking two stubs does not compose either: the second `vi.stubGlobal`
 *     replaces the first wholesale and takes its answer table with it. The fix
 *     is ONE table that answers all three questions at once, which is what
 *     `ANSWERS` below is.
 *
 * USAGE — the whole contract:
 *
 *   import { restorePointer, stubDevice } from '@/test-utils/pointer';
 *
 *   afterEach(restorePointer);
 *
 *   it('offers the camera on a phone', () => {
 *     stubDevice('phone');   // BEFORE the render that reads the device
 *     render(<Thing />);
 *   });
 *
 * `stubDevice` must be called before the first render of the test that needs
 * it, because each store resolves `matchMedia` once and then caches the answer.
 * `stubDevice` handles that for you — it resets BOTH stores itself, so the
 * ordering only has to hold against the RENDER, not against the reset.
 *
 * A test that says nothing about the device gets a DESKTOP one, which is what
 * every test in this suite was written against: jsdom ships no `matchMedia` at
 * all, `tests/setup.ts` installs one that answers `matches: false` to every
 * query, and `false` to all three questions is a mouse on a wide screen.
 *
 * `stubPointer` remains as a thin alias and is still correct to call — the same
 * table, reached through the older pointer-shaped name, with `'coarse'` meaning
 * `'phone'` and `'fine'` meaning `'desktop'`. It is kept so that the four files
 * consuming this seam did not have to move in the commit that widened it. New
 * tests should say `stubDevice`, because that name is what makes the compact
 * and `lg` answers visible at the call site rather than surprising.
 */

/**
 * The mouse half of the pair. Not read by anything in `src/` today —
 * `useCoarsePointer` asks only `(pointer: coarse)` and treats its negation as
 * fine — but a stub whose API says `'fine'` and then answers `false` to
 * `(pointer: fine)` is lying about the device, and the first caller to write
 * `matchMedia('(pointer: fine)')` would get a silent wrong answer rather than a
 * failure.
 */
const FINE_POINTER_QUERY = '(pointer: fine)';

export type PointerKind = 'coarse' | 'fine';

/** The device a test is running on. The primary vocabulary of this seam. */
export type DeviceKind = 'phone' | 'desktop';

/**
 * What each device answers, per query, and nothing else.
 *
 * COHERENCE IS THE CONTRACT. A phone is coarse AND compact AND below `lg`; a
 * desktop is none of the three. Those are not three independent switches a
 * caller may mix — there is no device that is coarse at 1280px, and this table
 * is what makes it impossible to ask for one. It is the reason the entry point
 * is named for a device rather than for a pointer.
 *
 * Deliberately an exhaustive table rather than a substring test, and
 * deliberately WITHOUT `(any-pointer: coarse)`. Answering `any-pointer` would
 * be physically correct — a phone's only pointer is coarse, so both queries are
 * true on it — and that is exactly the problem: `useCoarsePointer`'s file
 * comment rules `any-pointer` out because it matches a touch-screen laptop with
 * a mouse in hand, and if this table answered it, a regression that switched
 * the hook to `any-pointer` would keep every coarse test green. Leaving it out
 * of the table means such a switch fails loudly, here, at the seam. The same
 * reasoning is why the two width queries are named by their exported constants
 * rather than spelled as literals: a polarity flip in either constant moves
 * this table with it, so the flip shows up as failing tests rather than as a
 * stub that quietly agrees with the bug.
 *
 * Every query not named here answers `false`, which is precisely what
 * `tests/setup.ts` does — so installing this stub changes the answer to these
 * three questions and to nothing else.
 */
const ANSWERS: Record<DeviceKind, Readonly<Record<string, boolean>>> = {
  phone: {
    [COARSE_POINTER_QUERY]: true,
    [FINE_POINTER_QUERY]: false,
    [COMPACT_QUERY]: true,
    [BELOW_LG_QUERY]: true,
  },
  desktop: {
    [COARSE_POINTER_QUERY]: false,
    [FINE_POINTER_QUERY]: true,
    [COMPACT_QUERY]: false,
    [BELOW_LG_QUERY]: false,
  },
};

/** The older pointer-shaped vocabulary, mapped onto the device it meant. */
const DEVICE_FOR_POINTER: Record<PointerKind, DeviceKind> = {
  coarse: 'phone',
  fine: 'desktop',
};

/**
 * Which device the stub is currently answering as, and every `MediaQueryList`
 * it has handed out.
 *
 * Both exist so that `resizeDeviceTo` can change the answer AFTER the render —
 * see its own comment. A list is registered when `matchMedia` constructs it and
 * the whole registry is dropped by `stubDevice` and `restorePointer`, so it
 * never outlives the test that filled it.
 */
let currentDevice: DeviceKind = 'desktop';
const liveLists: { media: string; matches: boolean; handlers: Set<(e: unknown) => void> }[] = [];

/**
 * The same object shape `tests/setup.ts` hands out, not the three properties
 * `useCoarsePointer` happens to read.
 *
 * `stubPointer` replaces the global for the whole test, so every OTHER
 * component in the tree gets this object too — and the Base UI primitives this
 * app renders reach for the legacy `addListener`/`removeListener` pair as well
 * as the modern one. A minimal stub would turn "this test renders a phone" into
 * "this test throws inside a `<Select>`", with nothing in the failure pointing
 * back here.
 *
 * `matches` is a GETTER over the registry entry rather than a frozen boolean,
 * and the listener pairs actually record their handlers. Both are what let a
 * test change the viewport mid-render instead of only at mount: the stores this
 * seam feeds read `list.matches` again when their first subscriber attaches,
 * and they update from the `change` event after that. A frozen value and a
 * no-op `addEventListener` cannot express a window being dragged, which is the
 * only way to reach a class of bug that only exists ACROSS a breakpoint.
 */
function mediaQueryList(media: string, matches: boolean): MediaQueryList {
  const entry = { media, matches, handlers: new Set<(e: unknown) => void>() };
  liveLists.push(entry);
  return {
    get matches() {
      return entry.matches;
    },
    media,
    onchange: null,
    addListener: (fn: (e: unknown) => void) => entry.handlers.add(fn),
    removeListener: (fn: (e: unknown) => void) => entry.handlers.delete(fn),
    addEventListener: (_type: string, fn: (e: unknown) => void) => entry.handlers.add(fn),
    removeEventListener: (_type: string, fn: (e: unknown) => void) => entry.handlers.delete(fn),
    dispatchEvent: () => false,
  } as unknown as MediaQueryList;
}

/**
 * Run the rest of this test on a phone or on a desktop — pointer, compact
 * breakpoint and `lg` breakpoint answered together.
 *
 * THE PRIMARY ENTRY POINT. Pair it with `restorePointer()` in an `afterEach` —
 * see the leak described at the top of this file. Call it before the render
 * whose markup depends on the device.
 */
export function stubDevice(kind: DeviceKind): void {
  currentDevice = kind;
  liveLists.length = 0;
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => mediaQueryList(query, ANSWERS[currentDevice][query] ?? false)),
  );
  // After the stub, not before: this forgets any `MediaQueryList` either store
  // is still holding from an earlier test, so the next render resolves against
  // the stub installed one line up rather than against a cached answer. Both
  // stores, because a test that reset one would read a fresh answer to one
  // question and a stale answer to the other — the incoherence this seam
  // exists to prevent, reintroduced at the reset instead of at the table.
  resetCoarsePointerStore();
  resetIsBelowLgStore();
}

/**
 * The older, pointer-shaped name for the same thing: `'coarse'` is a phone and
 * `'fine'` is a desktop.
 *
 * A thin alias, kept so the four files already consuming this seam did not have
 * to move in the commit that widened it. It is not deprecated and not a lesser
 * path — it resolves to the same coherent table. Prefer `stubDevice` in new
 * tests, for the reason in the file header: `stubPointer('coarse')` reads as a
 * claim about a pointer, and it is now also a claim about a viewport width.
 */
export function stubPointer(kind: PointerKind): void {
  stubDevice(DEVICE_FOR_POINTER[kind]);
}

/**
 * Put `matchMedia` back and forget the device BOTH stores resolved.
 *
 * `afterEach(restorePointer)` in any file that calls `stubDevice` or
 * `stubPointer`, and it is not optional: `vi.restoreAllMocks()` does NOT undo a
 * stubbed global, so without this a single phone test leaves a phone-shaped
 * `matchMedia` behind for every test that runs after it in the same worker — a
 * cross-file failure that a path-filtered run cannot reproduce.
 *
 * Both stores, and the second one is the easier to forget. A missed
 * `resetIsBelowLgStore()` leaks a below-`lg` answer exactly the way a missed
 * `resetCoarsePointerStore()` leaks a coarse one, but with a worse signature:
 * the next file's tests would keep their fine pointer and their wide DataTable
 * while the workbench chrome silently moved to the body, and nothing in the
 * failure would point back here.
 *
 * It calls `vi.unstubAllGlobals()`, which is deliberately broader than
 * `matchMedia`: vitest offers no per-key unstub, and in both files this repairs
 * the other stubbed global is `fetch`, re-installed by their own `beforeEach`.
 * The consequence worth knowing is that this belongs in `afterEach` and nowhere
 * else — called mid-test it would take the test's `fetch` stub with it.
 */
export function restorePointer(): void {
  vi.unstubAllGlobals();
  currentDevice = 'desktop';
  liveLists.length = 0;
  resetCoarsePointerStore();
  resetIsBelowLgStore();
}

/**
 * Change the device UNDER a render that is already mounted — a window dragged
 * across 1024px, a tablet rotated.
 *
 * `stubDevice` answers a question asked at mount. This answers it again, on the
 * `MediaQueryList`s already handed out, by firing the `change` event the real
 * browser fires. That is the only way to reach a bug that lives ACROSS a
 * breakpoint rather than on one side of it, and there is a shipped example: the
 * receipt bottom sheet exists only below `lg`, so widening the window unmounted
 * it without its Close ever firing, and the flag it left behind suspended the
 * expense list's keyboard for the rest of the session. Nothing that renders one
 * width at a time can see that.
 *
 * WRAP THE CALL IN `act()`. It synchronously notifies React stores, so a bare
 * call updates state outside React's batch and the warning it prints does not
 * name this function.
 *
 * `stubDevice` first, always: this changes the answers, it does not install
 * them, and on an un-stubbed `matchMedia` there is nothing registered to change.
 */
export function resizeDeviceTo(kind: DeviceKind): void {
  currentDevice = kind;
  for (const entry of liveLists) {
    const next = ANSWERS[kind][entry.media] ?? false;
    if (next === entry.matches) continue;
    entry.matches = next;
    for (const handler of entry.handlers) handler({ matches: next, media: entry.media });
  }
}
