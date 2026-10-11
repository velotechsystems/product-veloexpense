import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { restorePointer, stubDevice, stubPointer } from '@/test-utils/pointer';

/**
 * The workbench's receipt pane: the viewer, the document list, and the two destructive
 * paths through it.
 *
 * It is the only place in the product that renders a file somebody uploaded, so most of
 * the tests are about NOT rendering one:
 *
 *   · **Nothing is previewed until the AV scan is CLEAN.** A missing extraction row
 *     means the scan has not run, which is treated as not-cleared rather than as "fine"
 *     — otherwise un-scanned bytes reach an iframe.
 *   · **An infected file says so, in the tone that means it.** "Scanning" forever and
 *     "infected" look the same to somebody waiting.
 *
 * The other half is that an expense takes SEVERAL documents. A second upload ADDS one;
 * it used to replace, which is why a restaurant bill and its cardholder copy could never
 * both be attached and the tip on the copy was therefore invisible. Deleting the LAST
 * document offers to clear the itemisation with it; deleting one of several does not,
 * because the server re-determines the expense from what remains.
 */

const h = vi.hoisted(() => ({
  calls: {} as Record<string, unknown[]>,
  asyncResults: {} as Record<string, unknown>,
  asyncErrors: {} as Record<string, string>,
  pending: {} as Record<string, boolean>,
}));

/** One stable `t`, so memo/effect deps do not churn. */
const t = (key: string, values?: Record<string, unknown>) =>
  values ? `${key}:${Object.values(values).join(',')}` : key;
t.has = () => false;

vi.mock('next-intl', () => ({ useTranslations: () => t, useLocale: () => 'en' }));

vi.mock('@/lib/trpc/client', () => {
  const procedure = (name: string) => ({
    useQuery: () => ({ data: undefined, isLoading: false, isFetching: false, error: null }),
    useMutation: (opts?: { onSuccess?: () => void; onError?: (e: Error) => void }) => ({
      isPending: h.pending[name] ?? false,
      mutate: (vars: unknown) => {
        h.calls[name] ??= [];
        h.calls[name].push(vars);
        const msg = h.asyncErrors[name];
        if (msg) opts?.onError?.(new Error(msg));
        else opts?.onSuccess?.();
      },
      mutateAsync: async (vars: unknown) => {
        h.calls[name] ??= [];
        h.calls[name].push(vars);
        const msg = h.asyncErrors[name];
        if (msg) throw new Error(msg);
        return h.asyncResults[name];
      },
    }),
  });
  const router = new Proxy({} as Record<string, unknown>, {
    get: (_t, key: string) => procedure(key),
  });
  return { trpc: { expenses: router } };
});

/** The viewer itself is the attachment component's job, and has its own suite. */
vi.mock('@/components/attachments/AttachmentViewer', () => ({
  AttachmentDocument: ({ file }: { file: { url: string; mimeType: string } }) => (
    <div data-testid="viewer" data-url={file.url} data-mime={file.mimeType} />
  ),
  useViewerZoom: () => [1, vi.fn()],
  ZoomControls: () => <div data-testid="zoom" />,
}));
vi.mock('./StatementApplyDialog', () => ({
  StatementApplyDialog: ({ receiptId }: { receiptId: string }) => (
    <div data-testid="statement-dialog" data-receipt={receiptId} />
  ),
}));

import { ReceiptPane } from './parts';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const extraction = (over: Record<string, unknown> = {}) => ({
  scanStatus: 'CLEAN',
  status: 'EXTRACTED',
  confidence: 0.95,
  data: {},
  error: null,
  reviewedAt: null,
  ...over,
});

const receipt = (over: Record<string, unknown> = {}) => ({
  id: 'rec-1',
  filename: 'canoe.jpg',
  url: 'https://files/canoe.jpg?sig=1',
  contentType: 'image/jpeg',
  sizeBytes: 1024,
  kind: 'OTHER',
  uploadedAt: '2026-07-28T12:00:00.000Z',
  extraction: extraction(),
  ...over,
});

const expense = (over: Record<string, unknown> = {}) =>
  ({
    id: 'exp-1',
    merchant: 'Canoe',
    date: '2026-07-28T12:00:00.000Z',
    amountMinor: 12500,
    currency: { id: 'cur-cad', code: 'CAD', symbol: '$', exponent: 2 },
    lineItems: [],
    attendees: [],
    receipts: [receipt()],
    ...over,
  }) as never;

const onChange = vi.fn();
const onMoveReceipt = vi.fn();

const show = (props: Record<string, unknown> = {}) =>
  render(
    <ReceiptPane
      expense={expense()}
      editable
      reviewThreshold={0.8}
      onChange={onChange}
      {...props}
    />,
  );

const called = (name: string) => (h.calls[name] ?? []) as Record<string, unknown>[];

/**
 * The confirmation's own button. "actions.delete" also labels the row's trash icon, and
 * the two are only distinguishable by which one is a <button> with that TEXT.
 */
const confirmButton = () =>
  screen
    .getAllByRole('button', { name: 'actions.delete' })
    .find((b) => b.textContent === 'actions.delete') as HTMLElement;

/**
 * EVERY file input the pane is currently rendering, in DOM order.
 *
 * The three helpers here replace five copies of
 * `screen.getByText('drawer.attachAnother').querySelector('input')`, which reached the
 * input through its LABEL TEXT — and that is the wrong handle for two independent
 * reasons, both of which bite from the coarse-pointer control pair onward:
 *
 *   · the text itself moves. At a coarse pointer the pair reads as two SOURCES
 *     ("Take photo" / "Choose file", `capture.takePhoto` / `capture.chooseFile`), so
 *     `drawer.attachAnother` is not on screen at all and `getByText` throws "unable to
 *     find an element" — five tests failing for a reason that has nothing to do with
 *     what any of them is asserting;
 *   · and `getByText` is a SINGULAR query, so it throws the moment two nodes match.
 *     Not returns null — throws. `queryByText` is `makeSingleQuery(queryAllBy, …)` in
 *     `@testing-library/dom` and is exactly as brittle to duplication as `getByText`,
 *     which is worth knowing before reaching for it as the safe alternative.
 *
 * `input[type="file"]` plus the `capture` attribute is stable against both. It is the
 * markup's own distinction rather than a copy decision, it holds today with one input
 * and no `capture` anywhere in the app, and it will hold unchanged on the day a second
 * appears.
 *
 * Scoped to `document.body` rather than to `show()`'s container because exactly one
 * `ReceiptPane` is mounted per test and RTL cleans up between them — the same scope
 * `screen` itself uses.
 */
const attachInputs = () => [
  ...document.body.querySelectorAll<HTMLInputElement>('input[type="file"]'),
];

/**
 * The library control's input — the one WITHOUT `capture`. Present at every pointer,
 * and the control all five upload tests below drive.
 */
const libraryInput = () =>
  attachInputs().find((i) => !i.hasAttribute('capture')) as HTMLInputElement;

/**
 * The camera control's input — the one WITH `capture`. Exists on a coarse pointer only,
 * so this returns `undefined` on a desktop rather than throwing, which is what the
 * non-negotiable below asserts about.
 */
const cameraInput = () =>
  attachInputs().find((i) => i.hasAttribute('capture')) as HTMLInputElement | undefined;

/** Each attach control's `<label>` — the control a person actually operates. */
const attachLabels = () => attachInputs().map((i) => i.closest('label') as HTMLElement);

beforeEach(() => {
  h.calls = {};
  h.asyncResults = {
    receiptUploadUrl: { url: 'https://s3/put', headers: {}, key: 'k/1' },
    receiptCreate: { id: 'rec-new' },
  };
  h.asyncErrors = {};
  h.pending = {};
  onChange.mockReset();
  onMoveReceipt.mockReset();
  vi.restoreAllMocks();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true }) as Response),
  );
});

/**
 * The cleanup `vi.restoreAllMocks()` above looks like it already does, and does not.
 *
 * `vi.restoreAllMocks()` does NOT undo a `vi.stubGlobal`, and `vitest.config.ts` sets
 * neither `unstubGlobals` nor `restoreMocks` — so this file's `beforeEach` reads as
 * fully hygienic while leaving every stubbed global in place. Today that means a `fetch`
 * stub outliving the file; from the first `stubPointer('coarse')` written here it would
 * mean a phone-shaped `matchMedia` leaking into whatever the worker ran next, which a
 * path-filtered run cannot reproduce. `restorePointer()` calls `vi.unstubAllGlobals()`
 * and closes both.
 *
 * It goes in `afterEach` and nowhere else: called mid-test it would take the test's own
 * `fetch` stub with it.
 */
afterEach(restorePointer);

// ── Nothing selected ──────────────────────────────────────────────────────────

describe('with no expense selected', () => {
  it('prompts for one instead of showing an empty viewer', () => {
    show({ expense: null });
    expect(screen.getByText('workbench.selectPrompt')).toBeInTheDocument();
  });

  it('offers no attach affordance, because there is nothing to attach to', () => {
    show({ expense: null });
    expect(screen.queryByText('drawer.attach')).not.toBeInTheDocument();
  });
});

// ── The viewer gate ───────────────────────────────────────────────────────────

describe('what may be previewed', () => {
  it('renders a clean image', () => {
    show();
    expect(screen.getByTestId('viewer')).toHaveAttribute('data-mime', 'image/*');
  });

  it('renders a clean PDF as a PDF', () => {
    // The viewer needs the real type or it renders a broken image.
    show({ expense: expense({ receipts: [receipt({ contentType: 'application/pdf' })] }) });
    expect(screen.getByTestId('viewer')).toHaveAttribute('data-mime', 'application/pdf');
  });

  it('refuses to preview a file whose scan has not finished', () => {
    show({
      expense: expense({
        receipts: [receipt({ extraction: extraction({ scanStatus: 'SCANNING' }) })],
      }),
    });
    expect(screen.queryByTestId('viewer')).not.toBeInTheDocument();
    // The same string labels the row's chip, so count rather than expecting one.
    expect(screen.getAllByText('extraction.scanning').length).toBeGreaterThan(0);
  });

  it('treats a MISSING scan row as not cleared, not as fine', () => {
    /**
     * No extraction row means the scan has not run at all. Rendering the bytes anyway
     * would put an un-scanned upload straight into the pane — so the preview stays blocked
     * whatever the pane ends up SAYING, which is the part that must not regress.
     */
    show({
      expense: expense({
        receipts: [receipt({ extraction: null, uploadedAt: new Date().toISOString() })],
      }),
    });
    expect(screen.queryByTestId('viewer')).not.toBeInTheDocument();
    // Just uploaded: the worker has not reported yet, and the view is still polling.
    expect(screen.getByText('extraction.scanning')).toBeInTheDocument();
  });

  it('stops saying "Scanning" once nothing is coming', () => {
    /**
     * A receipt uploaded long ago with no extraction row at all is not being scanned.
     * "Scanning…" there is a placeholder that never resolves — the audit sat on it for 56
     * seconds and reloaded the page (GA readiness report F09). The preview stays blocked
     * either way; only the sentence changes.
     */
    show({
      expense: expense({
        receipts: [receipt({ extraction: null, uploadedAt: '2026-07-28T12:00:00.000Z' })],
      }),
    });
    expect(screen.queryByTestId('viewer')).not.toBeInTheDocument();
    expect(screen.getByText('extraction.notReported')).toBeInTheDocument();
    expect(screen.queryByText('extraction.scanning')).not.toBeInTheDocument();
  });

  it('says an infected file is infected, in a tone that means it', () => {
    // "Scanning" forever and "infected" look identical to somebody waiting.
    show({
      expense: expense({
        receipts: [receipt({ extraction: extraction({ scanStatus: 'INFECTED' }) })],
      }),
    });
    const msg = screen
      .getAllByText('extraction.infected')
      .find((el) => el.className.includes('text-destructive')) as HTMLElement;
    expect(msg).toBeDefined();
  });

  it('says so when the scan itself failed', () => {
    show({
      expense: expense({
        receipts: [receipt({ extraction: extraction({ scanStatus: 'FAILED' }) })],
      }),
    });
    expect(screen.getAllByText('extraction.failed').length).toBeGreaterThan(0);
  });

  it('does not try to preview a file it cannot render', () => {
    // A .docx receipt is legitimate; an <img> pointed at it is not.
    show({
      expense: expense({
        receipts: [receipt({ contentType: 'application/vnd.openxmlformats' })],
      }),
    });
    expect(screen.queryByTestId('viewer')).not.toBeInTheDocument();
    expect(screen.getByText('extraction.ready')).toBeInTheDocument();
  });

  it('offers zoom only for something that can be zoomed', () => {
    const view = show();
    expect(screen.getByTestId('zoom')).toBeInTheDocument();
    view.unmount();
    show({ expense: expense({ receipts: [] }) });
    expect(screen.queryByTestId('zoom')).not.toBeInTheDocument();
  });

  it('says there is nothing attached yet', () => {
    show({ expense: expense({ receipts: [] }) });
    expect(screen.getByText('drawer.noReceipts')).toBeInTheDocument();
  });

  it('freezes the presigned URL, so a poll does not reload the preview', () => {
    /**
     * The report query re-presigns every receipt on each 4-second poll. Following the
     * new signature would reload the image — a visible flicker every four seconds
     * while a scan is running.
     */
    const view = show();
    expect(screen.getByTestId('viewer')).toHaveAttribute(
      'data-url',
      'https://files/canoe.jpg?sig=1',
    );
    view.rerender(
      <ReceiptPane
        expense={expense({ receipts: [receipt({ url: 'https://files/canoe.jpg?sig=2' })] })}
        editable
        reviewThreshold={0.8}
        onChange={onChange}
      />,
    );
    expect(screen.getByTestId('viewer')).toHaveAttribute(
      'data-url',
      'https://files/canoe.jpg?sig=1',
    );
  });

  it('covers the pane while the receipt is still processing', () => {
    show({ locked: true });
    expect(screen.getByText('workbench.processingReceipt')).toBeInTheDocument();
  });
});

// ── The document list ─────────────────────────────────────────────────────────

describe('the document list', () => {
  it('lists every attached document with its state', () => {
    show({
      expense: expense({
        receipts: [receipt(), receipt({ id: 'rec-2', filename: 'card-copy.pdf' })],
      }),
    });
    expect(screen.getByText('canoe.jpg')).toBeInTheDocument();
    expect(screen.getByText('card-copy.pdf')).toBeInTheDocument();
    expect(screen.getAllByText('extraction.done')).toHaveLength(2);
  });

  it('switches the viewer to the document that was clicked', async () => {
    const user = userEvent.setup();
    show({
      expense: expense({
        receipts: [
          receipt(),
          receipt({ id: 'rec-2', filename: 'card-copy.pdf', url: 'https://files/copy.pdf' }),
        ],
      }),
    });
    await user.click(screen.getByText('card-copy.pdf'));
    expect(screen.getByTestId('viewer')).toHaveAttribute('data-url', 'https://files/copy.pdf');
  });

  it('names what a document turned out to be, but not the default', () => {
    /**
     * OTHER is the kind a row is created with, so saying it costs space and tells the
     * reader nothing.
     */
    show({
      expense: expense({
        receipts: [receipt(), receipt({ id: 'rec-2', kind: 'BANK_STATEMENT' })],
      }),
    });
    expect(screen.getByText('documentKind.BANK_STATEMENT')).toBeInTheDocument();
    expect(screen.queryByText('documentKind.OTHER')).not.toBeInTheDocument();
  });

  it('offers the spread-across-expenses action on a statement only', () => {
    /**
     * A statement evidences several charges; a restaurant bill evidences one. Offering
     * the action on the bill invites attaching one meal's receipt to five expenses.
     */
    show({
      expense: expense({
        receipts: [receipt(), receipt({ id: 'rec-2', kind: 'BANK_STATEMENT' })],
      }),
    });
    expect(screen.getAllByText('openAction')).toHaveLength(1);
  });

  it('opens the statement dialog on the statement that was chosen', async () => {
    const user = userEvent.setup();
    show({
      expense: expense({ receipts: [receipt({ id: 'rec-9', kind: 'BANK_STATEMENT' })] }),
    });
    await user.click(screen.getByText('openAction'));
    expect(screen.getByTestId('statement-dialog')).toHaveAttribute('data-receipt', 'rec-9');
  });

  it('offers no statement action on a read-only report', () => {
    show({
      editable: false,
      expense: expense({ receipts: [receipt({ kind: 'BANK_STATEMENT' })] }),
    });
    expect(screen.queryByText('openAction')).not.toBeInTheDocument();
  });

  it('shows every extraction state as its own chip', () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ status: 'EXTRACTING' }, 'extraction.extracting'],
      [{ status: 'FAILED' }, 'extraction.extractFailed'],
      [{ status: 'PENDING', error: 'no api key' }, 'extraction.notConfigured'],
      [{ status: 'PENDING', error: null }, 'extraction.ready'],
    ];
    for (const [over, label] of cases) {
      const view = render(
        <ReceiptPane
          expense={expense({ receipts: [receipt({ extraction: extraction(over) })] })}
          editable
          reviewThreshold={0.8}
          onChange={onChange}
        />,
      );
      expect(screen.getAllByText(label).length).toBeGreaterThan(0);
      view.unmount();
    }
  });
});

// ── Moving a document ─────────────────────────────────────────────────────────

describe('moving a document to another expense', () => {
  const targets = [{ id: 'exp-2', label: 'Air Canada' }];

  it('offers the move as a select, reachable by keyboard and by thumb', () => {
    /**
     * Drag is the gesture people reach for, but no keyboard has a drag and a touch
     * device has no dragover. The select is the same operation, not a lesser fallback.
     */
    show({ moveTargets: targets, onMoveReceipt });
    expect(screen.getByLabelText('workbench.moveReceiptTo')).toBeInTheDocument();
  });

  it('moves the document to the chosen expense', async () => {
    const user = userEvent.setup();
    show({ moveTargets: targets, onMoveReceipt });
    await user.selectOptions(screen.getByLabelText('workbench.moveReceiptTo'), 'exp-2');
    expect(onMoveReceipt).toHaveBeenCalledWith('rec-1', 'exp-2');
  });

  it('resets, so the same target can be chosen twice in a row', async () => {
    // Two documents moved to the same expense is an ordinary thing to want.
    const user = userEvent.setup();
    show({ moveTargets: targets, onMoveReceipt });
    const select = screen.getByLabelText('workbench.moveReceiptTo') as HTMLSelectElement;
    await user.selectOptions(select, 'exp-2');
    expect(select.value).toBe('');
  });

  it('offers no move when there is nowhere to move it to', () => {
    // A drag that can never land is a worse affordance than no drag at all.
    show({ moveTargets: [], onMoveReceipt });
    expect(screen.queryByLabelText('workbench.moveReceiptTo')).not.toBeInTheDocument();
  });

  it('offers no move on a read-only report, or with no handler', () => {
    const view = show({ editable: false, moveTargets: targets, onMoveReceipt });
    expect(screen.queryByLabelText('workbench.moveReceiptTo')).not.toBeInTheDocument();
    view.unmount();
    show({ moveTargets: targets });
    expect(screen.queryByLabelText('workbench.moveReceiptTo')).not.toBeInTheDocument();
  });

  it('makes the row draggable only when a move is possible', () => {
    const view = show({ moveTargets: targets, onMoveReceipt });
    expect(screen.getByText('canoe.jpg').closest('button')).toHaveAttribute('draggable', 'true');
    view.unmount();
    show();
    expect(screen.getByText('canoe.jpg').closest('button')).toHaveAttribute('draggable', 'false');
  });

  it('cloaks the picker below `lg`, and keeps the delete control at both widths', () => {
    /**
     * The operator's second request. Moving a document to another expense is editing,
     * and of a kind that is hard to read and easy to fire by accident: an unlabelled
     * 7rem picker between the document's name and a trash can, whose options are other
     * expenses, and whose effect is invisible from this pane — the document leaves, the
     * selection follows it, and if it was the last document here the expense is deleted
     * server-side. Below `lg` it opened as a platform picker beside the receipt the
     * reader had just tapped to LOOK at.
     *
     * The mechanism is CSS and jsdom applies no CSS, so this asserts the DOM and the
     * class on it, as `parts.limitedRegions.test.tsx` documents. `hidden lg:contents`
     * and never `lg:block`: the row is a flex container, so a `block` wrapper would
     * become its flex item and take the select's own `shrink-0` and `max-w` out of the
     * row's arithmetic — hidden, it is not a flex item at all, which is the absent case.
     *
     * DELETE IS NOT CLOAKED, and that is the other half of the request: it stays
     * operable at every width, in its own real 44px box rather than in hit-slop.
     */
    show({ moveTargets: targets, onMoveReceipt });

    const picker = screen.getByLabelText('workbench.moveReceiptTo');
    const cloak = picker.closest('[class*="lg:contents"]') as HTMLElement | null;
    expect(cloak).not.toBeNull();
    expect((cloak as HTMLElement).className).toContain('hidden lg:contents');
    expect((cloak as HTMLElement).className).not.toContain('lg:block');

    const row = picker.closest('li') as HTMLElement;
    const remove = within(row).getByRole('button', { name: 'actions.delete' });
    expect(remove.closest('[class*="lg:hidden"]')).toBeNull();
    expect(remove.closest('[class*="lg:contents"]')).toBeNull();
    // The real box, not `.einc-tap-slop-both`: an invisible `::after` beside a
    // destructive control is how a mis-tap deletes a financial document.
    expect(remove.className).toContain('pointer-coarse:min-h-11');
    expect(remove.className).toContain('pointer-coarse:min-w-11');
  });

  it('leaves the row layout intact with the picker cloaked', () => {
    /**
     * At 360 the row is the document's name and the delete control, and the name button
     * keeps the `flex-1` that makes the delete control sit at the end of it. Nothing in
     * the row's own class list is conditional on the picker, which is what makes the
     * cloaked case and the "nowhere to move it to" case identical.
     */
    const view = show({ moveTargets: targets, onMoveReceipt });
    const withPicker = (screen.getByText('canoe.jpg').closest('li') as HTMLElement).className;
    const nameWithPicker = (screen.getByText('canoe.jpg').closest('button') as HTMLElement)
      .className;
    view.unmount();

    show({ moveTargets: [], onMoveReceipt });
    expect((screen.getByText('canoe.jpg').closest('li') as HTMLElement).className).toBe(withPicker);
    expect((screen.getByText('canoe.jpg').closest('button') as HTMLElement).className).toContain(
      'flex-1',
    );
    expect(nameWithPicker).toContain('flex-1');
  });

  it('carries the receipt and its source expense on the drag', () => {
    // The drop target needs both: moving within the same expense is a no-op.
    show({ moveTargets: targets, onMoveReceipt });
    const setData = vi.fn();
    fireEvent.dragStart(screen.getByText('canoe.jpg').closest('button') as HTMLElement, {
      dataTransfer: { setData, effectAllowed: '' },
    });
    expect(setData).toHaveBeenCalled();
    expect(JSON.stringify(setData.mock.calls)).toContain('rec-1');
    expect(JSON.stringify(setData.mock.calls)).toContain('exp-1');
  });
});

// ── Attaching ─────────────────────────────────────────────────────────────────

describe('attaching a document', () => {
  const file = () => new File(['x'], 'bill.jpg', { type: 'image/jpeg' });

  it('invites the first attachment, then invites ANOTHER', () => {
    /**
     * An expense takes as many documents as it takes to prove the claim. The label is
     * the only thing that says a second one adds rather than replaces.
     */
    const view = show({ expense: expense({ receipts: [] }) });
    expect(screen.getByText('drawer.attach')).toBeInTheDocument();
    view.unmount();
    show();
    expect(screen.getByText('drawer.attachAnother')).toBeInTheDocument();
  });

  it('offers no attach on a read-only report', () => {
    show({ editable: false });
    expect(screen.queryByText(/drawer\.attach/)).not.toBeInTheDocument();
    /**
     * The same claim made about the CONTROL rather than about the copy, and the reason
     * both lines are here.
     *
     * The regex above is safe as written — `editable: false` renders no attach
     * affordance at all, so there is never a second node for a singular query to trip
     * over — but it is safe for a reason that has nothing to do with what it is
     * checking. It matches on `drawer.attach*`, and a coarse-pointer control pair reads
     * as `capture.takePhoto` / `capture.chooseFile`: a camera control that escaped the
     * `editable` gate would carry neither string and this assertion would stay green
     * while the read-only report offered a camera. Counting the inputs cannot miss that.
     */
    expect(attachInputs()).toHaveLength(0);
  });

  it('uploads to the presigned URL and then extracts', async () => {
    const user = userEvent.setup();
    show();
    await user.upload(libraryInput(), file());
    await waitFor(() => expect(called('startExtraction').length).toBe(1));
    // The link is bound to the declared size, so it must be the size of the body PUT —
    // read off the PUT itself, so a future client-side transform is caught here.
    const init = vi.mocked(fetch).mock.calls[0]?.[1] as RequestInit | undefined;
    const body = init?.body as File;
    expect(body.size).toBeGreaterThan(0);
    expect(called('receiptUploadUrl')[0]).toMatchObject({
      expenseId: 'exp-1',
      filename: 'bill.jpg',
      contentType: 'image/jpeg',
      sizeBytes: body.size,
    });
    expect(called('receiptCreate')[0]).toMatchObject({ key: 'k/1', deferExtraction: true });
    expect(called('startExtraction')[0]).toEqual({ receiptIds: ['rec-new'] });
  });

  it('defers extraction until the row exists, then starts it explicitly', async () => {
    /**
     * The order matters: extracting during create would race the row, and the server
     * re-reads the WHOLE document set on extraction so the answer accounts for every
     * file rather than the newest.
     */
    const user = userEvent.setup();
    show();
    await user.upload(libraryInput(), file());
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(called('receiptCreate')[0]?.deferExtraction).toBe(true);
  });

  it('falls back to a generic content type when the browser gives none', async () => {
    // A .heic from some browsers arrives with an empty type; S3 needs something.
    show();
    // fireEvent, not user.upload: userEvent honours the input's `accept` list and a
    // type-less file matches nothing in it, so the change never fires.
    fireEvent.change(libraryInput(), {
      target: { files: [new File(['x'], 'photo.heic', { type: '' })] },
    });
    await waitFor(() => expect(called('receiptUploadUrl').length).toBe(1));
    expect(called('receiptUploadUrl')[0]?.contentType).toBe('application/octet-stream');
  });

  it('reports a failed PUT rather than pretending the file is attached', async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false }) as Response),
    );
    show();
    await user.upload(libraryInput(), file());
    expect(await screen.findByText('drawer.uploadFailed')).toBeInTheDocument();
    expect(called('receiptCreate')).toHaveLength(0);
  });

  it('reports the server’s own refusal', async () => {
    const user = userEvent.setup();
    h.asyncErrors.receiptUploadUrl = 'That file type is not allowed';
    show();
    await user.upload(libraryInput(), file());
    expect(await screen.findByText('That file type is not allowed')).toBeInTheDocument();
  });
});

// ── Attaching, on a phone ─────────────────────────────────────────────────────

/**
 * On a coarse pointer the pane's one attach link becomes a PAIR: "Take photo" beside
 * "Choose file". `capture="environment"` forces the camera and removes the library
 * choice, which is why a phone needs a second control rather than a second attribute on
 * the one it already had.
 *
 * This site is the odd one of P04's four, in three ways worth stating because each has
 * its own test below:
 *
 *   · it is SINGLE-FILE. No `multiple` before and none after — `pickUpload` takes one
 *     file and the pane's whole upload path is written around that;
 *   · it is ICON-ONLY on coarse. This bar is `h-12` and already carries a heading, the
 *     zoom controls, "Full screen" and a download button, so two more text links would
 *     not fit at a phone's width. The words move into an `sr-only` span, which is where
 *     each control's accessible name comes from — not `aria-label`;
 *   · and its 44px tap area is a REAL sized box with `ReceiptFileInput`'s hit-slop
 *     declined, like sites 2 and 3 but reached differently: those rows are not
 *     height-constrained, while this one is `h-12` — which still leaves room, since a
 *     44px control fits inside 48px. The ring is the wrong tool here because the only
 *     laid-out child is an 18px icon, and 18 + 6 + 6 is 30, not 44.
 *
 * The first test is the one that matters most, and it is not about the camera: at a fine
 * pointer this renders EXACTLY ONE `input[type=file]`, camera absent from the DOM rather
 * than hidden. Eight E2E call sites address file inputs by page-wide ordinal, seven of
 * them in specs with nothing to do with receipts, so emitting both and hiding one breaks
 * all eight at once with failures that read as product bugs.
 */
describe('attaching a document on a phone', () => {
  const file = () => new File(['x'], 'bill.jpg', { type: 'image/jpeg' });

  /**
   * Render the pane WHERE A PHONE ACTUALLY HAS IT — inside the open receipt sheet.
   *
   * `stubPointer('coarse')` is `stubDevice('phone')`, which answers the `lg` query as
   * well as the pointer one, and below `lg` this pane is not the third stacked pane: it
   * is a `DrawerContent side="bottom"` opened from the paperclip on the expense row. So
   * a phone-stubbed render with the sheet shut has no pane in it at all, and the four
   * assertions below would have been asserting about an empty document.
   *
   * The claim each of these tests makes is unchanged and is now stated where it is
   * true: on a phone, IN THE SHEET, the attach pair is icon-only, sized to a real 44px
   * box, single-file from either source, and goes quiet together while an upload runs.
   * The host owns `sheetOpen` because the trigger is a pane away; here it is simply
   * held open.
   */
  const showInSheet = (props: Record<string, unknown> = {}) =>
    show({ sheetOpen: true, onSheetOpenChange: vi.fn(), ...props });

  /**
   * Pick a receipt and leave the upload running, so the busy state stays on screen to be
   * asserted.
   *
   * The PUT to the presigned URL is parked forever rather than resolved: the point is the
   * window in which both controls have to go quiet. This replaces the `fetch` stub this
   * file's `beforeEach` installs, and `afterEach(restorePointer)` drops it again.
   */
  async function startUpload(input: HTMLInputElement) {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>(() => {})),
    );
    await userEvent.upload(input, file());
    // Parked at the PUT, which is past `setUploading(true)`.
    await waitFor(() => expect(called('receiptUploadUrl')).toHaveLength(1));
  }

  it('renders one control on a desktop, with no capture and no batch', () => {
    stubPointer('fine');
    show();

    // THE non-negotiable. Not "one visible input" — one input, full stop.
    expect(attachInputs()).toHaveLength(1);
    expect(attachLabels()).toHaveLength(1);
    expect(cameraInput()).toBeUndefined();
    expect(libraryInput()).not.toHaveAttribute('capture');
    // Single-file, this site's distinguishing trait, unchanged in both directions.
    expect(libraryInput()).not.toHaveAttribute('multiple');
    /**
     * Two class-list facts about this one label, neither of which changes what a desktop
     * renders: `pointer-coarse:` is inert at a fine pointer.
     *
     * The min-height is there for the frame a PHONE renders before hydration —
     * `useCoarsePointer()` answers `false` then, so this text link is the only control
     * on screen and CSS is what makes it a 44px target without waiting for JS. The
     * absent ring is site 4 declining `hitSlop`: its controls are sized instead.
     */
    expect(attachLabels()[0].className).toContain('pointer-coarse:min-h-11');
    expect(attachLabels()[0].className).not.toContain('pointer-coarse:after');
    // And today's wording: a lone control is not a choice between sources, so
    // "Choose file" would be answering a question nobody asked.
    expect(screen.getByText('drawer.attachAnother')).toBeInTheDocument();
    expect(screen.queryByText('capture.takePhoto')).not.toBeInTheDocument();
    expect(screen.queryByText('capture.chooseFile')).not.toBeInTheDocument();
  });

  it('adds a camera control before the picker on a phone, and names both by source', () => {
    stubPointer('coarse');
    showInSheet();

    const inputs = attachInputs();
    expect(inputs).toHaveLength(2);
    // Camera first: a phone's first target is the one a phone user wants.
    expect(inputs[0]).toHaveAttribute('capture', 'environment');
    expect(inputs[1]).not.toHaveAttribute('capture');
    // A camera cannot produce a PDF, and an `accept` list naming a type the capture
    // device cannot produce is the known route to iOS Safari ignoring `capture`.
    expect(cameraInput()?.accept).not.toContain('pdf');
    expect(libraryInput().accept).toContain('application/pdf');

    /**
     * The accessible names, and the coverage Phase 4 handed to this phase: the
     * fine-pointer sibling above asserts `drawer.attachAnother` by text, so without this
     * the coarse copy would go unchecked entirely.
     *
     * Two SOURCES, not one source and one outcome — the iOS/Android convention, and the
     * only wording that makes the camera control's missing library choice legible. Each
     * name lives in an `sr-only` span inside the label, so it is one string, one
     * translation, and voice control ("tap Take photo") matches it.
     */
    const [camera, picker] = attachLabels();
    expect(camera).toHaveTextContent('capture.takePhoto');
    expect(picker).toHaveTextContent('capture.chooseFile');
    expect(camera).not.toHaveAttribute('aria-label');
    expect(picker).not.toHaveAttribute('aria-label');

    /**
     * "Attach another" is GONE on a phone, and the signal it carried is not lost: the
     * receipt list renders directly beneath this same bar whenever `receipts.length > 0`
     * — `show()`'s fixture has one — so "something is already attached" is carried by the
     * visible filename rather than only by the verb.
     */
    expect(screen.queryByText('drawer.attachAnother')).not.toBeInTheDocument();
    expect(screen.getByText('canoe.jpg')).toBeInTheDocument();
  });

  it('never offers a batch, from either source', () => {
    stubPointer('coarse');
    showInSheet();

    // `capture` returns exactly one image per invocation on iOS Safari and on Android
    // Chrome whatever `multiple` says. This site never wanted a batch in any case:
    // `pickUpload` takes one file.
    // Counted before the loop: a render that produced no controls would otherwise
    // satisfy "none of them offers a batch" without offering anything at all, and
    // since the pane moved into a sheet an empty document is a reachable state.
    expect(attachInputs()).toHaveLength(2);
    for (const input of attachInputs()) expect(input).not.toHaveAttribute('multiple');
  });

  it('sizes both controls to a real 44px box rather than ringing an 18px icon', () => {
    stubPointer('coarse');
    showInSheet();

    const labels = attachLabels();
    // Before the loop, so a rendering that produced no labels could not pass this
    // vacuously — the pair is the thing being sized.
    expect(labels).toHaveLength(2);
    for (const label of labels) {
      /**
       * A REAL BOX, and the primitive's ring declined. The only laid-out child is an
       * 18px icon — the `sr-only` span is absolutely positioned at 1px square and
       * contributes nothing to the flex box — so an unsized label paints 18x18 and the
       * 6px ring would reach 30x30, which is 14px short of 44. This bar is `flex h-12`,
       * so a 44px control fits inside 48 with 2px of clearance, and the ring comes off
       * as it does at sites 2 and 3.
       *
       * jsdom performs no layout and every `getBoundingClientRect()` is zero, so this
       * is a class-list pin and NOT a measurement of the tap target.
       */
      expect(label.className).toContain('pointer-coarse:min-h-11');
      expect(label.className).toContain('pointer-coarse:min-w-11');
      expect(label.className).toContain('justify-center');
      expect(label.className).not.toContain('pointer-coarse:after');
      expect(label.className).not.toContain('pointer-coarse:relative');
    }
    /**
     * The row's coarse gap, which is now spacing rather than a collision fix: with the
     * ring declined there are no 6px rings to overlap each other or the download button,
     * and 12px stays because two 44px targets 8px apart in a 48px bar are easy to
     * mis-tap.
     */
    expect((labels[0].parentElement as HTMLElement).className).toContain('pointer-coarse:gap-3');
  });

  it('files a receipt taken with the camera, one photo at a time', async () => {
    stubPointer('coarse');
    const user = userEvent.setup();
    showInSheet();

    await user.upload(cameraInput() as HTMLInputElement, file());
    await waitFor(() => expect(called('startExtraction').length).toBe(1));

    // The same single-file path the link has always taken — `files[0]`, one presign, one
    // row — reached from the camera instead of the library.
    expect(called('receiptUploadUrl')).toHaveLength(1);
    const init = vi.mocked(fetch).mock.calls[0]?.[1] as RequestInit | undefined;
    const body = init?.body as File;
    expect(body.size).toBeGreaterThan(0);
    expect(called('receiptUploadUrl')[0]).toMatchObject({
      expenseId: 'exp-1',
      filename: 'bill.jpg',
      contentType: 'image/jpeg',
      sizeBytes: body.size,
    });
    expect(called('receiptCreate')[0]).toMatchObject({ key: 'k/1', deferExtraction: true });
  });

  it('quiets both controls while an upload runs on a phone', async () => {
    stubPointer('coarse');
    showInSheet();

    await startUpload(libraryInput());

    /**
     * `disabled` on the inputs stops being enough once there are two controls: a person
     * who taps the one they did NOT start the upload with gets silence and nothing to
     * explain it. So both labels go quiet and say so — reusing the drawer's existing
     * "Uploading…" rather than translating the same word a third time.
     */
    await waitFor(() => expect(attachLabels()[0]).toHaveAttribute('aria-disabled', 'true'));
    for (const label of attachLabels()) {
      expect(label).toHaveTextContent('drawer.uploading');
      expect(label).toHaveAttribute('aria-disabled', 'true');
      // What actually swallows the tap, and what explains it. No spinner: this codebase
      // has no `animate-spin` and no reduced-motion handling anywhere.
      expect(label.className).toContain('pointer-events-none');
      expect(label.className).toContain('opacity-50');
    }
    for (const input of attachInputs()) expect(input).toBeDisabled();
    expect(screen.queryByText('capture.takePhoto')).not.toBeInTheDocument();
    expect(screen.queryByText('capture.chooseFile')).not.toBeInTheDocument();
  });

  it('leaves the desktop busy state precisely as it was', async () => {
    stubPointer('fine');
    show();

    const before = attachLabels()[0].className;
    await startUpload(libraryInput());

    // Today's behaviour and not one thing more: the input goes disabled and the link
    // relabels to "Uploading…", with no dimming and no `aria-disabled`. The extra
    // signals exist to answer "why did nothing happen when I tapped the other one",
    // and on a desktop there is no other one.
    await waitFor(() => expect(screen.getByText('drawer.uploading')).toBeInTheDocument());
    const label = attachLabels()[0];
    expect(attachInputs()).toHaveLength(1);
    expect(libraryInput()).toBeDisabled();
    expect(label).not.toHaveAttribute('aria-disabled');
    expect(label.className).toBe(before);
  });

  it('offers no camera on a read-only report', () => {
    /**
     * The `editable` gate, made about the CONTROL rather than about the copy. The
     * read-only test above matches on `drawer.attach*`, and a coarse pair carries neither
     * of those strings — so a camera that escaped the gate would leave that assertion
     * green while a read-only report offered a camera. Counting inputs cannot miss it.
     */
    stubPointer('coarse');
    show({ editable: false });
    expect(attachInputs()).toHaveLength(0);
    expect(screen.queryByText('capture.takePhoto')).not.toBeInTheDocument();
  });
});

// ── Deleting ──────────────────────────────────────────────────────────────────

describe('deleting a document', () => {
  it('asks first, naming the file', async () => {
    const user = userEvent.setup();
    show();
    await user.click(screen.getByLabelText('actions.delete'));
    expect(screen.getByText('drawer.removeReceiptConfirm:canoe.jpg')).toBeInTheDocument();
  });

  it('offers to clear the itemisation when this is the LAST document', async () => {
    /**
     * With nothing left to re-read from, lines extracted from the deleted file would
     * otherwise stay on the expense with no evidence behind them.
     */
    const user = userEvent.setup();
    show({ expense: expense({ lineItems: [{ id: 'li-1' }, { id: 'li-2' }] }) });
    await user.click(screen.getByLabelText('actions.delete'));
    expect(screen.getByRole('checkbox')).toBeChecked();
    expect(screen.getByText('drawer.removeRecordsAlso:2')).toBeInTheDocument();
  });

  it('does NOT offer it while other documents remain', async () => {
    /**
     * The server re-determines the expense from what is left, so clearing the lines by
     * hand would discard work it is about to redo correctly.
     */
    const user = userEvent.setup();
    show({
      expense: expense({
        lineItems: [{ id: 'li-1' }],
        receipts: [receipt(), receipt({ id: 'rec-2', filename: 'copy.pdf' })],
      }),
    });
    await user.click(screen.getAllByLabelText('actions.delete')[0]);
    expect(screen.getByRole('checkbox')).not.toBeChecked();
  });

  it('deletes the receipt and the lines when both were asked for', async () => {
    const user = userEvent.setup();
    show({ expense: expense({ lineItems: [{ id: 'li-1' }] }) });
    await user.click(screen.getByLabelText('actions.delete'));
    await user.click(confirmButton());
    await waitFor(() => expect(called('receiptRemove').length).toBe(1));
    expect(called('lineItemRemove')[0]).toEqual({ id: 'li-1' });
    expect(called('receiptRemove')[0]).toEqual({ id: 'rec-1' });
  });

  it('keeps the lines when the box is cleared', async () => {
    const user = userEvent.setup();
    show({ expense: expense({ lineItems: [{ id: 'li-1' }] }) });
    await user.click(screen.getByLabelText('actions.delete'));
    await user.click(screen.getByRole('checkbox'));
    await user.click(confirmButton());
    await waitFor(() => expect(called('receiptRemove').length).toBe(1));
    expect(called('lineItemRemove')).toHaveLength(0);
  });

  it('abandons the delete on cancel', async () => {
    const user = userEvent.setup();
    show();
    await user.click(screen.getByLabelText('actions.delete'));
    await user.click(screen.getByRole('button', { name: 'addLine.cancel' }));
    expect(screen.queryByText(/removeReceiptConfirm/)).not.toBeInTheDocument();
    expect(called('receiptRemove')).toHaveLength(0);
  });

  it('reports a failed delete', async () => {
    const user = userEvent.setup();
    h.asyncErrors.receiptRemove = 'The report is locked';
    show();
    await user.click(screen.getByLabelText('actions.delete'));
    await user.click(confirmButton());
    expect(await screen.findByText('The report is locked')).toBeInTheDocument();
  });

  it('offers no delete on a read-only report', () => {
    show({ editable: false });
    expect(screen.queryByLabelText('actions.delete')).not.toBeInTheDocument();
  });
});

// ── The low-confidence review prompt ──────────────────────────────────────────

describe('the review prompt', () => {
  const unsure = () =>
    expense({
      receipts: [receipt({ extraction: extraction({ confidence: 0.4 }) })],
    });

  it('asks for a look when a scan came back unsure', () => {
    show({ expense: unsure() });
    expect(screen.getByText('extraction.reviewPrompt')).toBeInTheDocument();
  });

  it('stays quiet once somebody has looked', () => {
    show({
      expense: expense({
        receipts: [
          receipt({ extraction: extraction({ confidence: 0.4, reviewedAt: '2026-07-29' }) }),
        ],
      }),
    });
    expect(screen.queryByText('extraction.reviewPrompt')).not.toBeInTheDocument();
  });

  it('stays quiet about a confident scan', () => {
    show();
    expect(screen.queryByText('extraction.reviewPrompt')).not.toBeInTheDocument();
  });

  it('stays quiet on a read-only report, where nothing can be done about it', () => {
    show({ editable: false, expense: unsure() });
    expect(screen.queryByText('extraction.reviewPrompt')).not.toBeInTheDocument();
  });

  it('marks every unsure document reviewed, not just the visible one', async () => {
    /**
     * The prompt is one banner for the whole expense; clearing it has to clear
     * everything it was speaking for, or it comes straight back.
     */
    const user = userEvent.setup();
    show({
      expense: expense({
        receipts: [
          receipt({ extraction: extraction({ confidence: 0.4 }) }),
          receipt({ id: 'rec-2', extraction: extraction({ confidence: 0.3 }) }),
          receipt({ id: 'rec-3', extraction: extraction({ confidence: 0.99 }) }),
        ],
      }),
    });
    await user.click(screen.getByRole('button', { name: 'extraction.markReviewed' }));
    expect(called('markExtractionReviewed')).toEqual([
      { receiptId: 'rec-1' },
      { receiptId: 'rec-2' },
    ]);
  });

  it('holds the button while the acknowledgement is in flight', () => {
    h.pending.markExtractionReviewed = true;
    show({ expense: unsure() });
    expect(screen.getByRole('button', { name: 'extraction.markReviewed' })).toBeDisabled();
  });
});

// ── The title bar ─────────────────────────────────────────────────────────────

describe('the title bar', () => {
  it('links the file full-screen and offers a download', () => {
    show();
    const bar = screen.getByText('drawer.receipt').parentElement as HTMLElement;
    expect(within(bar).getByRole('link', { name: /workbench\.fullScreen/ })).toHaveAttribute(
      'href',
      'https://files/canoe.jpg?sig=1',
    );
    expect(within(bar).getByLabelText('workbench.download')).toHaveAttribute(
      'download',
      'canoe.jpg',
    );
  });

  it('offers neither when nothing is attached', () => {
    show({ expense: expense({ receipts: [] }) });
    expect(screen.queryByRole('link', { name: /workbench\.fullScreen/ })).not.toBeInTheDocument();
  });
});

// ── The receipt sheet, below `lg` ─────────────────────────────────────────────

/**
 * Below `lg` this pane is a `DrawerContent side="bottom"` — the shipped component, the
 * same one `FilterSheet` and `SortSheet` use — opened from the paperclip on the expense
 * row. Three of the plan's five security requirements land here, and each has a test
 * that fails if the requirement is quietly undone.
 */
describe('the receipt sheet', () => {
  const inSheet = (props: Record<string, unknown> = {}) =>
    show({ sheetOpen: true, onSheetOpenChange: vi.fn(), ...props });

  /**
   * Every URL this tree hands to a link or a download, which is what SEC-3 is about.
   *
   * The VIEWER's own url is excluded on purpose and is not a hole: the `<img src>` it
   * becomes is how the receipt is rendered at all, it is not navigable, not copyable as
   * text, and not something the share sheet is offered. What SEC-3 forbids is the URL
   * reaching a control that hands it somewhere — which is exactly the `[href]` /
   * `[download]` set below.
   */
  const exposedUrls = () =>
    [...document.body.querySelectorAll<HTMLElement>('[href], [download]')].map(
      (el) => el.getAttribute('href') ?? '',
    );

  it('mounts nothing until the sheet is opened', () => {
    // The pane RELOCATES below `lg`; it is not duplicated. A closed sheet is no pane,
    // which is why the phone-stubbed tests above hold it open.
    stubDevice('phone');
    show();
    expect(screen.queryByText('drawer.receipt')).not.toBeInTheDocument();
  });

  it('opens as a bottom sheet with one heading, not two', () => {
    stubDevice('phone');
    inSheet();
    // The `DrawerTitle` carries the name; the pane's own <h3> stands down, so "Receipt"
    // reaches the accessibility tree once.
    expect(screen.getAllByText('drawer.receipt')).toHaveLength(1);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    // A real 44px way out. The primitive's built-in X is a 24px target and is declined.
    expect(screen.getByRole('button', { name: 'drawer.close' })).toBeInTheDocument();
  });

  it('SEC-2/SEC-3: the presigned URL is absent from the document, not merely hidden', () => {
    /**
     * A presigned receipt URL is a bearer credential to a financial document, valid for
     * an hour, with no second factor. On iOS a `target="_blank"` out of a standalone PWA
     * window hands it to Safari — its history, its tab list, and whatever the share
     * sheet can reach — where it stays live for the rest of that hour. So "Full screen"
     * is the sheet itself (SEC-2), and the download link goes with it.
     *
     * ABSENT rather than `max-lg:hidden`, which is SEC-3: a CSS-hidden anchor still
     * holds a real presigned URL in the DOM, and SEC-3 admits no string the user can
     * copy. The assertion is therefore about the URL, not about the two controls — a
     * future control that reintroduced the string under a different name would fail it.
     */
    stubDevice('phone');
    inSheet();

    expect(screen.queryByRole('link', { name: /workbench\.fullScreen/ })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('workbench.download')).not.toBeInTheDocument();
    expect(exposedUrls().filter((u) => u.includes('sig=1'))).toEqual([]);
  });

  it('SEC-2/SEC-3: and the desktop pane keeps both, unchanged', () => {
    stubDevice('desktop');
    show();
    expect(screen.getByRole('link', { name: /workbench\.fullScreen/ })).toHaveAttribute(
      'href',
      'https://files/canoe.jpg?sig=1',
    );
    expect(screen.getByLabelText('workbench.download')).toHaveAttribute('download', 'canoe.jpg');
  });

  it('SEC-4: asks for a fresh signature when the sheet opens', () => {
    /**
     * `refetchOnWindowFocus: false` and `staleTime: 30_000` were calibrated for a
     * desktop tab. A phone backgrounds an installed app, and a sheet reopened against a
     * URL that expired in a pocket renders S3's error body inside the viewer — which
     * reads as the receipt having been lost.
     *
     * It refetches. It does not re-issue anything: nothing here mutates.
     */
    const onRefetchReport = vi.fn();
    stubDevice('phone');
    inSheet({ onRefetchReport });
    expect(onRefetchReport).toHaveBeenCalledTimes(1);
  });

  it('SEC-4: and again whenever the app comes back to the foreground', () => {
    // `visibilitychange`, not `focus` alone — `focus` misses the standalone-window case
    // on iOS, which is the only case this exists for.
    const onRefetchReport = vi.fn();
    stubDevice('phone');
    inSheet({ onRefetchReport });
    onRefetchReport.mockClear();

    document.dispatchEvent(new Event('visibilitychange'));
    expect(onRefetchReport).toHaveBeenCalledTimes(1);
  });

  it('SEC-4: does not refetch for the desktop pane, which never goes stale unseen', () => {
    const onRefetchReport = vi.fn();
    stubDevice('desktop');
    show({ onRefetchReport });
    expect(onRefetchReport).not.toHaveBeenCalled();
  });

  it('SEC-4: the viewer reads the current URL in the sheet, and the frozen one outside it', () => {
    /**
     * The freeze exists for a four-second problem — the extraction poll re-signs every
     * receipt and an unfrozen `src` would reload the preview each time. That trade is
     * right in a pane that is on screen continuously and dies with its tab, and wrong in
     * a sheet that can sit in memory past the URL's one-hour life.
     */
    stubDevice('phone');
    const { rerender } = inSheet();
    const src = () => screen.getByTestId('viewer').getAttribute('data-url');
    expect(src()).toContain('sig=1');

    rerender(
      <ReceiptPane
        expense={expense({ receipts: [receipt({ url: 'https://files/canoe.jpg?sig=2' })] })}
        editable
        reviewThreshold={0.8}
        onChange={onChange}
        sheetOpen
        onSheetOpenChange={vi.fn()}
      />,
    );
    expect(src()).toContain('sig=2');
  });

  it('SEC-3: nothing in this tree shares or copies anything', () => {
    /**
     * A standing guard rather than a behaviour: SEC-3 names `navigator.share` and
     * `navigator.clipboard.writeText` specifically, and neither is reachable from this
     * component today. The test is what makes adding one a red build rather than a
     * review catch.
     */
    const share = vi.fn();
    const writeText = vi.fn();
    vi.stubGlobal('navigator', {
      ...navigator,
      share,
      clipboard: { writeText },
    });
    stubDevice('phone');
    inSheet();
    expect(share).not.toHaveBeenCalled();
    expect(writeText).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
