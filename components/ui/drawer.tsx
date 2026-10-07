'use client';

import { Dialog as DialogPrimitive } from '@base-ui-components/react/dialog';
import { IconX } from '@tabler/icons-react';
import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * Drawer — edge-anchored slide-out variant of `Dialog`. Built on the
 * same Base UI `Dialog` primitive, so it inherits focus trap and ARIA
 * wiring for free. The positional CSS is the only thing that differs
 * from a modal: fixed to one edge, transform-slide animation driven by
 * `data-open` / `data-closed`.
 *
 * Two anchors, chosen with `<DrawerContent side>`:
 *   - `'right'` (the default) — full height, fixed width. Every drawer
 *     that existed before the mobile epic is this one, unchanged.
 *   - `'bottom'` — full width, height capped short of the viewport top.
 *     The phone shape: a sheet a thumb can reach the top of.
 *
 * Dismissal: by default a drawer closes ONLY via the built-in X button,
 * an explicit action (Save / Cancel / Close), or programmatically — a
 * stray click outside or an accidental Esc will NOT close it, so a
 * half-filled form is never lost by mistake. Pass `dismissible` to
 * restore click-away + Esc dismissal for read-only / disposable drawers.
 *
 * Note the two defaults pull opposite ways and that is deliberate: a
 * FORM drawer should be hard to lose, a bottom SHEET over a list should
 * not trap the reader — a sheet that survives a tap on the list behind
 * it reads as a stuck app. Sheets therefore pass `dismissible`; the
 * prop's default stays `false` because it is the form case that would
 * lose data if it were wrong.
 *
 * Usage:
 *   <Drawer open={open} onOpenChange={setOpen}>
 *     <DrawerContent>
 *       <DrawerHeader>
 *         <DrawerTitle>…</DrawerTitle>
 *       </DrawerHeader>
 *       <DrawerBody>…</DrawerBody>
 *       <DrawerFooter>…</DrawerFooter>
 *     </DrawerContent>
 *   </Drawer>
 */

type DrawerRootProps = React.ComponentPropsWithoutRef<typeof DialogPrimitive.Root>;
type DrawerOnOpenChange = NonNullable<DrawerRootProps['onOpenChange']>;

export interface DrawerProps extends DrawerRootProps {
  /**
   * Allow click-away and Esc to dismiss the drawer. Defaults to `false`:
   * the drawer closes only via the X, an explicit action, or
   * programmatically — guarding against accidental data loss. Set `true`
   * for read-only / disposable drawers where quick dismissal is nicer.
   */
  dismissible?: boolean;
}

/**
 * Wraps Base UI's `Dialog.Root` to make accidental dismissal opt-in.
 * Outside clicks are suppressed with `disablePointerDismissal`; Esc is
 * cancelled in `onOpenChange` (the only reason that still fires a close
 * we want to veto, since the X button reports `close-press`).
 */
export function Drawer({ dismissible = false, onOpenChange, ...props }: DrawerProps) {
  const handleOpenChange = React.useCallback<DrawerOnOpenChange>(
    (open, eventDetails) => {
      if (!dismissible && !open && eventDetails.reason === 'escape-key') {
        eventDetails.cancel();
        return;
      }
      onOpenChange?.(open, eventDetails);
    },
    [dismissible, onOpenChange],
  );

  return (
    <DialogPrimitive.Root
      {...props}
      onOpenChange={handleOpenChange}
      disablePointerDismissal={!dismissible}
    />
  );
}
Drawer.displayName = 'Drawer';

export const DrawerTrigger = DialogPrimitive.Trigger;
export const DrawerPortal = DialogPrimitive.Portal;
export const DrawerClose = DialogPrimitive.Close;

export const DrawerOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Backdrop>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Backdrop>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Backdrop
    ref={ref}
    className={cn(
      'fixed inset-0 z-50 bg-black/30 backdrop-blur-[1px]',
      'data-[closed]:animate-out data-[open]:animate-in',
      'data-[closed]:fade-out-0 data-[open]:fade-in-0',
      className,
    )}
    {...props}
  />
));
DrawerOverlay.displayName = 'DrawerOverlay';

/** Which edge the drawer is anchored to. */
export type DrawerSide = 'right' | 'bottom';

export interface DrawerContentProps
  extends React.ComponentPropsWithoutRef<typeof DialogPrimitive.Popup> {
  /**
   * Edge the panel slides in from. Defaults to `'right'` — every drawer
   * that existed before this prop is a right-side panel and none of them
   * had to change.
   *
   * `'bottom'` is the phone shape. It ignores `width` (a bottom sheet is
   * full-bleed; a width would leave it floating in a gutter) and ignores
   * `resizable` (the handle drags horizontally, which resizes nothing
   * here — and drag-to-resize is not a gesture a touch surface offers).
   */
  side?: DrawerSide;
  /**
   * Width of the drawer. A number is pixels; a string is any CSS length, so a drawer
   * that should take a share of the VIEWPORT can say `'50vw'`.
   *
   * The string form exists because the pixel default is an inline style, and an inline
   * style beats a class: a caller passing `className="w-full md:max-w-[50vw]"` got a
   * 480px drawer with a cap it never reached, which looks exactly like the class not
   * being applied. Pair a viewport width with `min-w-*` / `max-w-*` classes to keep it
   * usable at both ends.
   *
   * Defaults to 480. When `resizable` is set (and a `storageKey` is provided), this is
   * also the fallback the user sees the first time they open the drawer — resizing needs
   * a number to drag from, so a string width and `resizable` do not combine.
   */
  width?: number | string;
  /** Hide the built-in close button if you want a custom header. */
  hideCloseButton?: boolean;
  /** When set, render a drag handle on the left edge that lets the user
   *  resize the drawer. Width persists in localStorage under
   *  `expenseos.drawerWidth.<storageKey>` if `storageKey` is provided
   *  (recommended — otherwise the resize is in-memory only and resets
   *  on close). */
  resizable?: boolean;
  storageKey?: string;
  /** Lower / upper bound on resized width. Defaults to 360 / 1024. */
  minWidth?: number;
  maxWidth?: number;
}

/** Read the persisted width for `storageKey`, falling back to `fallback`. */
function readStoredWidth(storageKey: string | undefined, fallback: number): number {
  if (!storageKey || typeof window === 'undefined') return fallback;
  try {
    const raw = window.localStorage.getItem(`expenseos.drawerWidth.${storageKey}`);
    const n = raw ? Number.parseInt(raw, 10) : NaN;
    return Number.isFinite(n) && n > 0 ? n : fallback;
  } catch {
    return fallback;
  }
}

export const DrawerContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Popup>,
  DrawerContentProps
>(
  (
    {
      className,
      children,
      side = 'right',
      width = 480,
      hideCloseButton,
      resizable,
      storageKey,
      minWidth = 360,
      maxWidth = 1024,
      style,
      ...props
    },
    ref,
  ) => {
    // A bottom sheet is full-bleed and has no drag handle, so both of the
    // right-side sizing affordances are switched off here rather than at
    // every call site. See `side` on the props for why.
    const isBottom = side === 'bottom';
    const canResize = resizable && !isBottom;
    // Resize state is local — every Drawer instance keeps its own width
    // so two open drawers (rare but legal) don't fight over one ref.
    // We hydrate from localStorage lazily so SSR matches the default.
    // Resizing drags a pixel value; a viewport-relative width has none to start from, so
    // it falls back to the default rather than to `NaN`.
    const [currentWidth, setCurrentWidth] = React.useState<number>(
      typeof width === 'number' ? width : 480,
    );
    React.useEffect(() => {
      if (!canResize) return;
      setCurrentWidth(readStoredWidth(storageKey, typeof width === 'number' ? width : 480));
    }, [canResize, storageKey, width]);

    // Drag handle: capture pointer, then write width on every pointermove
    // until pointerup. `requestAnimationFrame` keeps the visual change
    // synced to the browser's paint and prevents jank under rapid moves.
    const dragStateRef = React.useRef<{
      startX: number;
      startWidth: number;
      rafId: number | null;
    } | null>(null);
    const onPointerDown = React.useCallback(
      (e: React.PointerEvent<HTMLButtonElement>) => {
        if (!canResize) return;
        e.preventDefault();
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        dragStateRef.current = {
          startX: e.clientX,
          startWidth: currentWidth,
          rafId: null,
        };
      },
      [canResize, currentWidth],
    );
    const onPointerMove = React.useCallback(
      (e: React.PointerEvent<HTMLButtonElement>) => {
        const ds = dragStateRef.current;
        if (!ds) return;
        // Dragging LEFT (clientX decreasing) increases the drawer
        // width because the drawer is right-aligned.
        const next = Math.min(
          maxWidth,
          Math.max(minWidth, ds.startWidth + (ds.startX - e.clientX)),
        );
        if (ds.rafId !== null) cancelAnimationFrame(ds.rafId);
        ds.rafId = requestAnimationFrame(() => setCurrentWidth(next));
      },
      [minWidth, maxWidth],
    );
    const onPointerUp = React.useCallback(
      (e: React.PointerEvent<HTMLButtonElement>) => {
        const ds = dragStateRef.current;
        if (!ds) return;
        if (ds.rafId !== null) cancelAnimationFrame(ds.rafId);
        dragStateRef.current = null;
        try {
          (e.target as HTMLElement).releasePointerCapture(e.pointerId);
        } catch {
          // releasing a capture we didn't hold is fine
        }
        if (storageKey && typeof window !== 'undefined') {
          try {
            window.localStorage.setItem(
              `expenseos.drawerWidth.${storageKey}`,
              String(currentWidth),
            );
          } catch {
            // localStorage may throw in private mode — width still
            // works for the rest of the session.
          }
        }
      },
      [storageKey, currentWidth],
    );

    return (
      <DrawerPortal>
        <DrawerOverlay />
        <DialogPrimitive.Popup
          ref={ref}
          // The inline width is the right-side panel's whole sizing story and
          // an inline style beats a class, so a bottom sheet must not receive
          // one at all — `w-full` below would lose to it.
          style={isBottom ? style : { width: canResize ? currentWidth : width, ...style }}
          className={cn(
            'z-50 flex flex-col',
            'border-border bg-card text-foreground shadow-2xl',
            'duration-200 data-[closed]:animate-out data-[open]:animate-in',
            isBottom
              ? [
                  'fixed inset-x-0 bottom-0 w-full rounded-t-2xl border-t',
                  /**
                   * Capped short of the viewport top, in `dvh` so the cap
                   * tracks the browser chrome collapsing on scroll rather than
                   * being measured against a `vh` the phone never actually
                   * shows. The 4rem gap keeps the list behind it visible —
                   * a sheet that reaches the top is a page, and the person
                   * loses the thing they are filtering.
                   *
                   * NOT verified against the iOS software keyboard. iOS does
                   * not resize the layout viewport when the keyboard opens —
                   * only `visualViewport` reflects it — so a text-filter input
                   * near the bottom of a full-height sheet can still end up
                   * under the keys. `DrawerBody` scrolls, and the browser
                   * scrolls a focused input into view, which covers the common
                   * case. The rest needs a real handset: phase 9.
                   */
                  'max-h-[calc(100dvh-4rem)]',
                  // Home-indicator clearance. Zero on every device without one.
                  'pb-[env(safe-area-inset-bottom)]',
                  'data-[closed]:slide-out-to-bottom data-[open]:slide-in-from-bottom',
                ]
              : [
                  'fixed top-0 right-0 h-full max-w-full border-l',
                  'data-[closed]:slide-out-to-right data-[open]:slide-in-from-right',
                ],
            className,
          )}
          {...props}
        >
          {canResize && (
            // 6-px wide ghost handle sitting just outside the left
            // border. `cursor-col-resize` + a faint hover tint mark
            // the affordance; the actual border stays visually clean.
            <button
              type="button"
              tabIndex={-1}
              aria-label="Resize drawer"
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
              className="absolute top-0 -left-1 z-10 h-full w-2 cursor-col-resize border-0 bg-transparent p-0 hover:bg-primary/20 active:bg-primary/30"
            />
          )}
          {children}
          {!hideCloseButton && (
            <DialogPrimitive.Close
              aria-label="Close"
              className="absolute top-3 right-3 rounded-sm p-1 text-muted-foreground opacity-70 transition-opacity hover:bg-muted hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring"
            >
              <IconX className="h-4 w-4" />
              <span className="sr-only">Close</span>
            </DialogPrimitive.Close>
          )}
        </DialogPrimitive.Popup>
      </DrawerPortal>
    );
  },
);
DrawerContent.displayName = 'DrawerContent';

export const DrawerHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      'flex shrink-0 items-start gap-3 border-border border-b px-5 py-4 pr-12',
      className,
    )}
    {...props}
  />
);
DrawerHeader.displayName = 'DrawerHeader';

export const DrawerBody = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('flex-1 overflow-y-auto px-5 py-4', className)} {...props} />
);
DrawerBody.displayName = 'DrawerBody';

export const DrawerFooter = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      'flex shrink-0 items-center justify-end gap-2 border-border border-t px-5 py-3',
      className,
    )}
    {...props}
  />
);
DrawerFooter.displayName = 'DrawerFooter';

export const DrawerTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn('font-semibold text-base leading-tight tracking-tight', className)}
    {...props}
  />
));
DrawerTitle.displayName = 'DrawerTitle';

export const DrawerDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn('text-muted-foreground text-sm', className)}
    {...props}
  />
));
DrawerDescription.displayName = 'DrawerDescription';
