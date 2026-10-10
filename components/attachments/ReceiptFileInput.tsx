'use client';

/**
 * The receipt file input, shared by the four places a submitter attaches a
 * receipt: the reports-list top bar, the workbench handoff prompt, the expense
 * drawer header and the receipt drawer bar.
 *
 * It exists for the reason `AttachmentViewer.tsx` next door exists — to stop
 * four copies of the same input drifting. Four `accept` lists, four
 * `value = ''` resets and (from P04 onwards) four `capture="environment"`
 * attributes is four chances for one of them to be subtly different, and the
 * `accept` list in particular is the one that decides whether iOS Safari opens
 * the camera or the share sheet.
 *
 * WHAT IT OWNS, AND WHAT IT DELIBERATELY DOES NOT.
 *
 * It owns the `<input type="file">` itself: the two `accept` lists,
 * `capture`, `multiple`, `disabled`, the `hidden` technique, the value reset,
 * the touch hit-slop, and — the load-bearing one — whether the camera control
 * exists in the DOM at all.
 *
 * It owns none of the treatment. There is no `variant` prop and there must not
 * be one: at a fine pointer the four sites want a bordered chip, a primary fill,
 * another bordered chip and a 12px text link, two of which are page-local
 * workbench treatments,
 * and an enum encoding those four would become the thing every future call site
 * argues with. Each site passes its own `className` and its own label content —
 * icon plus text, or icon plus `<span className="sr-only">` where the control is
 * icon-only — which, since the operator's on-device review, is what a coarse
 * pointer gets at ALL FOUR sites. That is also where the accessible name comes
 * from, and it stays there: no `aria-label` anywhere. On a `<label>` element it
 * does nothing useful, and on the input it would silently shadow the visible
 * text every site still has at a fine pointer.
 *
 * Labels are RESOLVED STRINGS passed in as children, never catalog keys.
 * `packages/i18n/scripts/check-used-keys.mjs` resolves `t('literal')` calls per
 * `useTranslations('<ns>')` binding and is deliberately literal-only, so a
 * `labelKey` prop calling `t(labelKey)` in here would drop all four sites' keys
 * out of the CI coverage gate at `.github/workflows/ci.yml:105`.
 *
 * ATTRIBUTE → JS. SIZE → CSS. That rule is stated in full at the top of
 * `apps/web/src/lib/useCoarsePointer.ts` and this component is its first
 * consumer, so it is worth restating where the two halves land here:
 *
 *   · WHETHER the camera control exists is JS, through `useCoarsePointer()`.
 *     `capture="environment"` changes what the operating system's picker does
 *     and no media query can add or remove an attribute — and a camera control
 *     that is present-but-hidden is worse than useless, see below.
 *   · The 44px touch target is CSS, through `pointer-coarse:` on a control
 *     that is already in the DOM. It is cheaper, it needs no hydration, and on
 *     a phone's first paint — where the hook still answers `false` — the single
 *     library control is already 44px rather than growing a beat later. That
 *     last part is only true while each site's FINE-pointer treatment carries
 *     its own coarse sizing, and at sites 2, 3 and 4 that is all it is for:
 *     their icon-only pairs are chosen in JS and do not exist in that frame, so
 *     the labelled treatment underneath takes `pointer-coarse:min-h-11` to be
 *     44px while it is the only control on screen.
 *
 * THE ONE THING THAT CAN GO BADLY WRONG. At a fine pointer this renders
 * EXACTLY ONE `input[type=file]`, and the camera control is ABSENT from the
 * DOM rather than present-and-hidden. Nine E2E call sites address file inputs
 * by page-wide ordinal — eight `.last()` on a receipt entry point, seven of
 * those in specs that have nothing to do with receipts, plus one `.first()` on
 * the admin card-import route.
 *
 * Stated carefully, because the overstated version of this was in here and is
 * worth not repeating: the eight are all `.last()`, and since the camera
 * control is emitted BEFORE its picker they would survive a CSS-hidden control
 * — so "all eight break at once" was never the argument. The argument is that
 * DOM absence is a GLOBAL invariant: no page-wide ordinal anywhere can shift,
 * whatever ordinal a spec uses, instead of a per-call-site audit of which
 * ordinals happen to survive by accident of DOM order. See
 * `docs/adr/0003-coarse-pointer-affordances-are-js-gated-css-sized.md`. The
 * absence itself is pinned by the first test in `ReceiptFileInput.test.tsx`.
 *
 * THE HIT-SLOP HAS TWO CONDITIONS ATTACHED, AND IT IS OPTIONAL.
 * `RECEIPT_HIT_SLOP` declares a 7px inset, which on the one element that takes
 * it — a `size-8` square with a 1px border — spans 44px and reaches 6px past
 * what the control paints. Those two numbers are not the same number and the
 * inset is neither of them; the constant's own comment derives all three, and
 * anyone ringing a differently-built element has to redo that derivation. It is
 * how a bespoke `<label>` too small to tap reaches 44px without being visually
 * resized: an invisible, absolutely-positioned `::after` at `z-index: auto`
 * that extends OUTSIDE the control's painted bounds, so it silently wins any
 * tap landing in that 6px ring:
 *
 *   · **Two slops must not overlap each other.** A camera + library pair in a
 *     `gap-1.5` (6px) or `gap-2` (8px) wrapper collides, and the later sibling
 *     wins — so "Choose file" would steal taps aimed at "Take photo". The
 *     wrapper holding a pair needs **`gap-3` (12px)**, at which two 6px-reaching
 *     slops abut exactly. Read that as 2 × reach ≤ gap, not as a fixed 12: a
 *     ringed element with no border reaches 7px and would need 14.
 *   · **A slop must not overlap a NEIGHBOUR either** — the same bug with a
 *     different victim, and the more likely one, because every receipt control
 *     has a neighbour: the handoff prompt's ghost dismiss button, the drawer
 *     header's "Add expense" button, the reports list's "New report" button.
 *     Each needs **≥6px of clearance** from a slopped control, or it loses taps
 *     along its near edge with nothing visible to explain why.
 *
 * Neither condition is observable to any gate in this repo — jsdom cannot
 * measure geometry and no test can see a stolen tap — which is exactly why they
 * are written down here.
 *
 * Which is also why the slop is declinable. `hitSlop={false}` is for a control
 * that already reaches 44px by being genuinely that size (`min-h-11` on any row
 * with room for it, whether or not that row's height is fixed): a real 44px box
 * plus this ring is a ~56px tap area poking out of a visible chip, and it buys
 * nothing while putting the neighbour-clearance requirement on a site that did
 * not need it. The primitive
 * still owns the mechanism; the call site says whether its geometry needs it.
 */

import type { ReactNode } from 'react';
import { useCoarsePointer } from '@/lib/useCoarsePointer';

/**
 * What a submitter may attach from their file library. The same list all four
 * sites carried before this component existed, PDF included — a receipt often
 * arrives as an emailed invoice.
 */
export const RECEIPT_ACCEPT =
  'image/jpeg,image/png,image/webp,image/heic,image/heif,application/pdf';

/**
 * What the camera may produce: the image subset, `application/pdf` DROPPED.
 *
 * Not tidiness, and not something a gate in this repo can check. The reasoning
 * is that a camera cannot produce a PDF, so advertising one is incoherent, and
 * that an `accept` list naming a type the capture device cannot produce is the
 * known route to iOS Safari ignoring `capture` and showing the full share sheet
 * instead of opening the camera — which would defeat the whole feature on the
 * platform it was built for. That is an inference from a documented iOS quirk,
 * not a measurement: **on-device confirmation is still owed, and happens at the
 * operator's visual check against the staged branch.** The assertion below it
 * pins the list; nothing here pins iOS's behaviour, and it should not be read
 * as if it did.
 */
export const RECEIPT_CAMERA_ACCEPT = 'image/jpeg,image/png,image/webp,image/heic,image/heif';

/**
 * Hit-slop, not a visual resize — read both conditions in the file comment
 * above before putting one of these next to anything.
 *
 * WHY 7px AND NOT 6. The inset is NOT measured from what the control paints.
 * An absolutely-positioned `::after` resolves `inset` against the PADDING box
 * of its positioned ancestor (CSS 2.1 §10.1: the containing block of an
 * absolutely-positioned box is the nearest positioned ancestor's padding box),
 * and Tailwind's preflight puts every element on `box-sizing: border-box`
 * (`node_modules/tailwindcss/preflight.css:12`). So on the only site that takes
 * this slop — `UPLOAD_CHIP_ICON` in `ExpenseReportsList.tsx`, a `size-8` square
 * with `border border-input` — the 32px the eye sees is a 30px padding box once
 * the 1px border on each side comes off, and the ring spans
 *
 *     30 (padding box) + 7 + 7 = 44
 *
 * `-inset-1.5` (6px) shipped here first and spans 30 + 6 + 6 = **42**, two under
 * the floor, which is the arithmetic every comment in this file used to state.
 * The border is what the old reading dropped, so carry it in the next one:
 *
 *     ring span   = padding box + 2 × inset
 *                 = painted box − 2 × (border + padding) + 2 × inset
 *     outward reach past the painted edge = inset − border − padding
 *
 * At 7px on a 1px-bordered, unpadded chip the reach is **6px per side**, which
 * is the number both conditions in the file comment above are stated in. A
 * future ringed element with a THICKER border, or with padding, spans less than
 * 44 at this inset; one with NO border spans 46 and reaches 7px, which overflows
 * the 12px pair gap. Either way: redo the two lines above for the element you
 * are ringing rather than assuming 7px is a constant.
 *
 * `pointer-coarse:` because this is SIZE, and size is CSS. Tailwind 4.3 ships
 * the variant natively; this is the repo's first use of it. It is prepended to
 * the call site's own `className` for reading order only — that ordering
 * confers no precedence, because Tailwind resolves conflicts by stylesheet
 * order and not by position in the `class` attribute, and this file does not
 * run its classes through `cn()`/`tailwind-merge`. A call site that needs
 * different geometry declines the slop with `hitSlop={false}` rather than
 * trying to out-order it.
 */
export const RECEIPT_HIT_SLOP =
  "pointer-coarse:relative pointer-coarse:after:absolute pointer-coarse:after:-inset-[7px] pointer-coarse:after:content-['']";

/** One control's treatment: the call site's classes and the call site's label content. */
export interface ReceiptFileControl {
  /** Classes for the `<label>`. The whole visual treatment lives here. */
  className?: string;
  /**
   * Marks THIS control's `<label>` unavailable — the busy state, and the one
   * label attribute a call site cannot reach through `className`.
   *
   * It is here because `disabled` on the inputs stops being sufficient the
   * moment there are two controls: a person who taps the OTHER one mid-upload
   * gets silence with nothing to explain it, so the call site dims both labels
   * and takes their pointer events away. Those two are classes and belong at
   * the call site like every other class; this is the same statement to
   * assistive technology, and it has nowhere else to go.
   *
   * Per-control rather than a single top-level prop, and NOT derived from
   * `disabled`, on purpose. Only a coarse-pointer PAIR needs it: at a fine
   * pointer the lone control's busy behaviour is `disabled` on the input and
   * nothing else, exactly as it was before P04, and a primitive that mirrored
   * `disabled` onto the label here would change that for all four sites. So
   * the condition stays where the pointer and the busy flag are both already
   * known — the call site.
   */
  'aria-disabled'?: boolean;
  /**
   * The label's content, and therefore the control's accessible name. Resolved
   * strings, never catalog keys. Icon-only controls pass
   * `<Icon aria-hidden="true" />` plus `<span className="sr-only">{name}</span>`.
   */
  children: ReactNode;
}

export interface ReceiptFileInputProps extends ReceiptFileControl {
  /**
   * The camera control, rendered ONLY when the primary pointer is coarse, and
   * rendered BEFORE the library control so the phone's first target is the one
   * a phone user wants.
   *
   * Omit it and this renders exactly what the site rendered before P04. Pass it
   * and a fine pointer still renders exactly that — the camera control is not
   * hidden at a fine pointer, it is never created.
   */
  camera?: ReceiptFileControl;
  /**
   * Multi-file selection, on the library control only. The camera control never
   * gets it: `capture="environment"` returns exactly one image per invocation on
   * iOS Safari and on Android Chrome whatever `multiple` says, so carrying the
   * attribute there would promise a batch the camera cannot deliver — which is
   * also why the camera's label is singular at all four sites.
   */
  multiple?: boolean;
  /** Reaches BOTH inputs. The disabled *treatment* is the call site's, as with every other class. */
  disabled?: boolean;
  /**
   * Whether these controls reach 44px by hit-slop. Default `true`, and site 1
   * (the reports-list top bar) is the only one of the four call sites that
   * takes the default: its 32px squares live in a fixed `h-8` zone and align
   * against the shell's own 32px bell, so a real 44px box would overflow the
   * row AND stand visibly taller than the bell beside it. 30 (the 32px square's
   * padding box, once its 1px border comes off each side) + 7 + 7 = 44, with
   * nothing painted moved.
   *
   * Pass `false` where the control is ALREADY a real 44px box, which sites 2, 3
   * and 4 all do. All three give their icon-only pair `pointer-coarse:min-h-11
   * pointer-coarse:min-w-11 justify-center`: sites 2 and 3's rows are not
   * height-constrained at all, and site 4's receipt drawer bar IS a fixed height
   * and still has room — 44px fits inside 48 with 2px of clearance. (Sites 2 and
   * 3 also carry `pointer-coarse:px-3` on the labelled treatment a desktop gets,
   * which is what a phone paints for the frame before its pair exists.) Then the
   * tap area matches what is painted, and the neighbour-clearance condition in
   * the file comment above does not apply to those sites at all.
   *
   * So a fixed-height row is not on its own a reason to keep the ring: do the
   * arithmetic first. A label whose only laid-out child is an 18px icon paints
   * 18x18 — an `sr-only` span is absolutely positioned at 1px square and adds
   * nothing to a flex box — and this ring makes that 30x30, not 44. Reaching 44
   * from a painted 18 by ring alone needs a 13px reach per side, which then
   * needs a 26px gap inside the pair and eats into whatever sits beside it.
   *
   * It is a geometry switch and applies to both controls of a pair, which is
   * what "does this row have room to grow" is a property of. It is deliberately
   * not a treatment variant: every class stays at the call site.
   */
  hitSlop?: boolean;
  /**
   * Called with the selection, synchronously, while the input still holds it —
   * before the value reset below. Callers that need one file take `files[0]`;
   * callers that need the batch take the list. Deciding which is not this
   * component's business, so it hands over the `FileList` untouched.
   *
   * Read it synchronously or copy it (`Array.from(files)`) before awaiting: the
   * reset empties the very `FileList` object handed over here, because that
   * object is the input's live list rather than a snapshot of it.
   */
  onFiles: (files: FileList) => void;
}

function ReceiptControl({
  camera,
  className,
  'aria-disabled': ariaDisabled,
  children,
  multiple,
  disabled,
  hitSlop,
  onFiles,
}: ReceiptFileControl & {
  camera: boolean;
  multiple?: boolean;
  disabled?: boolean;
  hitSlop: boolean;
  onFiles: (files: FileList) => void;
}) {
  // `undefined` rather than `''` when there is nothing to say, so a control
  // with no treatment and no slop renders a bare `<label>` as it would today.
  const classes = [hitSlop ? RECEIPT_HIT_SLOP : null, className].filter(Boolean).join(' ');
  return (
    <label className={classes || undefined} aria-disabled={ariaDisabled}>
      {children}
      <input
        type="file"
        /**
         * `hidden`, not `sr-only`. The control a user sees and operates is the
         * `<label>`; the input is plumbing. This component changes the hiding
         * technique for nobody — all four sites already used `hidden` and the
         * keyboard-reachability that `hidden` costs is a pre-existing gap
         * tracked on its own ticket, not something to fix behind a refactor.
         */
        className="hidden"
        accept={camera ? RECEIPT_CAMERA_ACCEPT : RECEIPT_ACCEPT}
        capture={camera ? 'environment' : undefined}
        multiple={camera ? undefined : multiple}
        disabled={disabled}
        onChange={(e) => {
          const files = e.target.files;
          if (files?.length) onFiles(files);
          /**
           * Reset unconditionally, so the SAME file can be picked twice. Without
           * it the second pick is not a change and fires no event — which is
           * exactly what a user does after a failed upload, or after
           * photographing the same receipt again.
           */
          e.currentTarget.value = '';
        }}
      />
    </label>
  );
}

/**
 * A receipt file control — plus, on a coarse pointer only, a camera control
 * before it.
 *
 * Renders one or two `<label>`s and nothing around them: the wrapper, the gap
 * and every class belong to the call site. Read the file comment above for the
 * `gap-3` requirement that comes with the pair.
 */
export function ReceiptFileInput({
  camera,
  className,
  'aria-disabled': ariaDisabled,
  children,
  multiple,
  disabled,
  hitSlop = true,
  onFiles,
}: ReceiptFileInputProps) {
  const coarse = useCoarsePointer();
  return (
    <>
      {coarse && camera ? (
        <ReceiptControl
          camera
          className={camera.className}
          aria-disabled={camera['aria-disabled']}
          disabled={disabled}
          hitSlop={hitSlop}
          onFiles={onFiles}
          // No `multiple`, ever — see the prop's comment.
        >
          {camera.children}
        </ReceiptControl>
      ) : null}
      <ReceiptControl
        camera={false}
        className={className}
        aria-disabled={ariaDisabled}
        multiple={multiple}
        disabled={disabled}
        hitSlop={hitSlop}
        onFiles={onFiles}
      >
        {children}
      </ReceiptControl>
    </>
  );
}
