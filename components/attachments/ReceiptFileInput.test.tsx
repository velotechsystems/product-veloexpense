import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetCoarsePointerStore } from '@/lib/useCoarsePointer';
import {
  RECEIPT_ACCEPT,
  RECEIPT_CAMERA_ACCEPT,
  RECEIPT_HIT_SLOP,
  ReceiptFileInput,
} from './ReceiptFileInput';

/**
 * The first test in this file is the one that matters most, and it is not about
 * the camera: it is that a FINE pointer renders exactly ONE `input[type=file]`,
 * with the camera control absent from the DOM rather than present-and-hidden.
 * Eight E2E call sites address file inputs by page-wide ordinal, seven of them
 * in specs unrelated to receipts, so emitting both controls and hiding one with
 * CSS breaks all eight at once with failures that read as product bugs.
 *
 * After that, the things a call site must be able to rely on and could not
 * verify for itself: `capture` on the camera control and nowhere else, an
 * image-only `accept` on it, no `multiple` on it, `disabled` reaching both, the
 * value reset that lets the same file be picked twice, the `hidden` technique
 * that the operator's resolution froze, and the hit-slop that gets a bespoke
 * `<label>` to 44px.
 */

/**
 * Answer `(pointer: coarse)` for the duration of one test.
 *
 * Two halves, and BOTH are load-bearing. `vi.stubGlobal` is the repo idiom for
 * this global (`packages/design-system/src/components/ui/resizable-panels.test.tsx:16`),
 * and `resetCoarsePointerStore()` is what makes a per-test stub visible at all:
 * the pointer store resolves `matchMedia` once per module instance, so without
 * the reset every test after the first would read the first test's answer.
 *
 * Neither cleans up on its own — `vitest.config.ts` sets neither `unstubGlobals`
 * nor `restoreMocks`, and `vi.restoreAllMocks()` does not undo a stubbed global —
 * hence the explicit `afterEach`. Without it a coarse `matchMedia` would leak
 * into whatever ran next in the same worker, and the whole suite is written
 * against the fine-pointer baseline that `tests/setup.ts` installs.
 *
 * Phase 4 lifts this pair into `apps/web/src/test-utils/pointer.ts` as
 * `stubPointer()` / `restorePointer()`, at which point this local copy goes.
 */
function stubPointer(kind: 'coarse' | 'fine') {
  const matches = kind === 'coarse';
  vi.stubGlobal(
    'matchMedia',
    vi.fn((media: string) => ({
      matches,
      media,
      addEventListener: () => {},
      removeEventListener: () => {},
    })),
  );
}

beforeEach(() => {
  resetCoarsePointerStore();
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetCoarsePointerStore();
});

/**
 * The coarse shape of sites 2 and 3: two labelled chips. The camera's name is
 * carried in an `sr-only` span here purely so that one helper serves both the
 * labelled and the icon-only sites — the accessible name comes from label
 * content either way, which is the point being pinned.
 */
function renderPair({
  multiple = true,
  disabled = false,
  hitSlop,
  ariaDisabled,
}: {
  multiple?: boolean;
  disabled?: boolean;
  hitSlop?: boolean;
  ariaDisabled?: boolean;
} = {}) {
  /**
   * Read the selection SYNCHRONOUSLY, inside the handler.
   *
   * Not fussiness: the value reset empties the very `FileList` the handler was
   * handed, because in a browser (and in jsdom —
   * `HTMLInputElement-impl.js` sets `this.files.length = 0`) that object is the
   * input's live list, not a snapshot of it. A caller that awaits before reading
   * it would see nothing, which is why `ExpenseReportsList` does
   * `Array.from(files)` as its first statement.
   */
  const picks: string[][] = [];
  const onFiles = vi.fn((files: FileList) => {
    picks.push([...files].map((f) => f.name));
  });
  const { container } = render(
    // gap-3, because two 6px hit-slops must abut and not overlap.
    <div className="flex items-center gap-3">
      <ReceiptFileInput
        className="rounded-md border border-input px-2.5 py-1.5"
        multiple={multiple}
        disabled={disabled}
        hitSlop={hitSlop}
        aria-disabled={ariaDisabled}
        onFiles={onFiles}
        camera={{
          className: 'rounded-md border border-input px-2.5 py-1.5',
          'aria-disabled': ariaDisabled,
          children: <span className="sr-only">Take photo</span>,
        }}
      >
        Choose file
      </ReceiptFileInput>
    </div>,
  );
  const inputs = [...container.querySelectorAll<HTMLInputElement>('input[type="file"]')];
  return { container, inputs, onFiles, picks };
}

const png = () => new File(['pixels'], 'receipt.png', { type: 'image/png' });
const pdf = () => new File(['%PDF'], 'invoice.pdf', { type: 'application/pdf' });

describe('<ReceiptFileInput> at a fine pointer', () => {
  it('renders exactly one input[type=file], with the camera control absent from the DOM', () => {
    stubPointer('fine');
    const { container, inputs } = renderPair();

    // THE non-negotiable. Not "one visible input" — one input, full stop.
    expect(inputs).toHaveLength(1);
    expect(container.querySelectorAll('label')).toHaveLength(1);

    // The camera control is not merely invisible: nothing of it is in the tree.
    expect(inputs[0]).not.toHaveAttribute('capture');
    expect(screen.queryByText('Take photo')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Take photo')).not.toBeInTheDocument();
  });

  it('renders the library control exactly as the call site asked, with the full accept list', () => {
    stubPointer('fine');
    const { inputs } = renderPair();

    expect(inputs[0]).toHaveAttribute('accept', RECEIPT_ACCEPT);
    expect(RECEIPT_ACCEPT).toContain('application/pdf');
    expect(inputs[0]).toHaveAttribute('multiple');
    expect(screen.getByLabelText('Choose file')).toBe(inputs[0]);
  });
});

describe('<ReceiptFileInput> at a coarse pointer', () => {
  it('renders two controls with the camera FIRST', () => {
    stubPointer('coarse');
    const { container, inputs } = renderPair();

    expect(inputs).toHaveLength(2);
    const labels = [...container.querySelectorAll('label')];
    expect(labels).toHaveLength(2);
    // A phone's first target is the one a phone user wants.
    expect(labels[0]).toHaveTextContent('Take photo');
    expect(labels[1]).toHaveTextContent('Choose file');
  });

  it('puts capture="environment" on the camera input and on nothing else', () => {
    stubPointer('coarse');
    const { inputs } = renderPair();

    expect(inputs[0]).toHaveAttribute('capture', 'environment');
    expect(inputs[1]).not.toHaveAttribute('capture');
  });

  it('gives the camera an image-only accept — application/pdf dropped', async () => {
    stubPointer('coarse');
    const { inputs, picks } = renderPair();

    expect(inputs[0]).toHaveAttribute('accept', RECEIPT_CAMERA_ACCEPT);
    expect(RECEIPT_CAMERA_ACCEPT).not.toContain('application/pdf');
    // A camera cannot produce a PDF, and an accept list naming a type the
    // capture device cannot produce is how iOS Safari ends up showing the share
    // sheet instead of opening the camera.
    await userEvent.upload(inputs[0], pdf());
    expect(picks).toEqual([]);

    // The library control still takes one, because a receipt often arrives as
    // an emailed invoice.
    await userEvent.upload(inputs[1], pdf());
    expect(picks).toEqual([['invoice.pdf']]);
  });

  it('never puts multiple on the camera input, whatever the prop says', () => {
    stubPointer('coarse');
    const { inputs } = renderPair({ multiple: true });

    // `capture` returns exactly one image per invocation on iOS Safari and
    // Android Chrome regardless of `multiple`, so the attribute would promise a
    // batch the camera cannot deliver — which is why the label is singular too.
    expect(inputs[0]).not.toHaveAttribute('multiple');
    expect(inputs[1]).toHaveAttribute('multiple');
  });

  it('follows multiple={false} on the library input, as the receipt drawer needs', () => {
    stubPointer('coarse');
    const { inputs } = renderPair({ multiple: false });

    expect(inputs[0]).not.toHaveAttribute('multiple');
    expect(inputs[1]).not.toHaveAttribute('multiple');
  });

  it('passes disabled to both inputs', () => {
    stubPointer('coarse');
    const { inputs } = renderPair({ disabled: true });

    expect(inputs[0]).toBeDisabled();
    expect(inputs[1]).toBeDisabled();
  });

  it('names each control from its own label content, with no aria-label anywhere', () => {
    stubPointer('coarse');
    const { container, inputs } = renderPair();

    expect(screen.getByLabelText('Take photo')).toBe(inputs[0]);
    expect(screen.getByLabelText('Choose file')).toBe(inputs[1]);
    // One name, one string, one translation — and voice control ("tap Take
    // photo") matches what is written. An aria-label on the <label> does
    // nothing, and on the input it would shadow the visible text.
    for (const el of container.querySelectorAll('*')) {
      expect(el).not.toHaveAttribute('aria-label');
    }
  });

  it('carries the 44px hit-slop on BOTH labels', () => {
    stubPointer('coarse');
    const { container } = renderPair();

    for (const label of container.querySelectorAll('label')) {
      expect(label.className).toContain(RECEIPT_HIT_SLOP);
      // Spelled out, so a reviewer can see the technique without resolving the
      // constant: hit-slop on a `relative` label, not a visual resize.
      expect(label.className).toContain('pointer-coarse:relative');
      // 7px, not 6: the `::after` insets from the PADDING box, so on a
      // 1px-bordered `size-8` chip the ring spans 30 + 7 + 7 = 44. `-inset-1.5`
      // spanned 42 and is what this assertion used to pin.
      expect(label.className).toContain('pointer-coarse:after:-inset-[7px]');
      // The call site's own treatment survives alongside it.
      expect(label.className).toContain('border-input');
    }
  });

  it('drops the slop from both labels when a site already reaches 44px by resize', () => {
    // A row with room to grow takes `pointer-coarse:min-h-11` and is genuinely
    // 44px. Slopping it on top would make a ~56px tap area poking outside a
    // visible chip, and would put the neighbour-clearance requirement on a site
    // that does not need it — both labelled sites sit beside a real button.
    stubPointer('coarse');
    const { container } = renderPair({ hitSlop: false });

    const labels = [...container.querySelectorAll('label')];
    expect(labels).toHaveLength(2);
    for (const label of labels) {
      expect(label.className).not.toContain('pointer-coarse:after');
      expect(label.className).not.toContain('pointer-coarse:relative');
      // Nothing else about the control changes.
      expect(label.className).toContain('border-input');
    }
  });
});

describe('<ReceiptFileInput> value reset', () => {
  it('clears the input after a selection so the same file can be picked twice', async () => {
    stubPointer('fine');
    const { inputs, picks } = renderPair();
    const input = inputs[0];
    if (!input) throw new Error('no input rendered');

    await userEvent.upload(input, png());
    expect(picks).toEqual([['receipt.png']]);
    expect(input.value).toBe('');

    // The second pick of the SAME file is the case the reset exists for: a user
    // retrying a failed upload, or re-photographing one receipt. Without the
    // reset the selection has not changed, so no event fires and nothing
    // happens — and this assertion is what catches that.
    await userEvent.upload(input, png());
    expect(picks).toEqual([['receipt.png'], ['receipt.png']]);
    expect(input.value).toBe('');
  });

  it('clears the camera input too', async () => {
    stubPointer('coarse');
    const { inputs, picks } = renderPair();
    const camera = inputs[0];
    if (!camera) throw new Error('no camera input rendered');

    await userEvent.upload(camera, png());
    await userEvent.upload(camera, png());
    expect(picks).toEqual([['receipt.png'], ['receipt.png']]);
    expect(camera.value).toBe('');
  });

  it('leaves the handler alone when a selection is cancelled', () => {
    stubPointer('fine');
    const { inputs, onFiles } = renderPair();
    const input = inputs[0];
    if (!input) throw new Error('no input rendered');

    // Dismissing the picker without choosing anything reaches React as a change
    // with an empty list. The reset still runs; the upload does not start.
    input.dispatchEvent(new Event('change', { bubbles: true }));
    expect(onFiles).not.toHaveBeenCalled();
    expect(input.value).toBe('');
  });
});

describe('<ReceiptFileInput> busy state', () => {
  it('marks each label unavailable only when its call site asks', () => {
    /**
     * The one label attribute a call site cannot reach through `className`, and
     * the reason it is a prop rather than derived from `disabled`: only a
     * coarse-pointer PAIR needs it. `disabled` on the inputs stops being
     * sufficient the moment there are two controls, because a person who taps
     * the OTHER one mid-upload gets silence — but at a fine pointer the lone
     * control's busy behaviour is `disabled` and nothing else, exactly as it
     * was before P04. Deriving this from `disabled` would change that for all
     * four sites, so the condition stays at the call site.
     */
    stubPointer('coarse');
    const { container } = renderPair({ disabled: true, ariaDisabled: true });

    const labels = [...container.querySelectorAll('label')];
    expect(labels).toHaveLength(2);
    for (const label of labels) expect(label).toHaveAttribute('aria-disabled', 'true');
  });

  it('puts no aria-disabled on either label by default', () => {
    stubPointer('coarse');
    const { container } = renderPair({ disabled: true });

    // A disabled INPUT is not an unavailable LABEL: the sites that keep their
    // pre-P04 busy behaviour must render exactly the markup they always did.
    for (const label of container.querySelectorAll('label')) {
      expect(label).not.toHaveAttribute('aria-disabled');
    }
  });
});

describe('<ReceiptFileInput> hiding technique', () => {
  it('keeps className="hidden" on the input and does not reach for sr-only', () => {
    // The operator's resolution, frozen deliberately: this component changes
    // the hiding technique for nobody. No `sr-only` on the input, no
    // focus-visible ring, no new desktop tab stop. The keyboard-reachability
    // that `hidden` costs is a pre-existing gap on its own ticket.
    stubPointer('coarse');
    const { inputs } = renderPair();

    for (const input of inputs) {
      expect(input).toHaveClass('hidden');
      expect(input).not.toHaveClass('sr-only');
    }
  });
});
