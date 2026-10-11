import { describe, expect, it } from 'vitest';
import { hasPendingExtractionIn, receiptLockState, receiptState } from './parts';

/**
 * Expense reporting works with no Claude credential. Only the auto-fill stops.
 *
 * This is a product contract, not an accident of the current code, so it gets a test
 * rather than a comment. Losing the credential — never configured, integration
 * uninstalled, key expired — must cost the extraction and nothing else: the upload
 * succeeds, the file is stored and previewable, and the person types the figures in
 * over the top.
 *
 * The mechanism is the `error` on a PENDING row. `PENDING && !error` means "queued,
 * about to be overwritten by an extraction", which correctly locks the editor;
 * `PENDING && error` means "not coming", which must NOT. Those two states differ by one
 * field, which is exactly the kind of distinction that gets flattened by a later
 * refactor.
 */

/** The satellite as the worker leaves it with no API key. */
const NOT_CONFIGURED = {
  scanStatus: 'CLEAN',
  status: 'PENDING',
  error: 'extraction not configured',
} as never;

/** The same row while extraction is genuinely queued. */
const QUEUED = { scanStatus: 'CLEAN', status: 'PENDING', error: null } as never;

const expenseWith = (extraction: unknown) => ({ receipts: [{ extraction }] }) as never;

describe('extraction off: what still works', () => {
  it('reads as "Extraction off" rather than a failure', () => {
    // A distinct state from `extractFailed`: nothing went wrong, the feature is off.
    expect(receiptState(NOT_CONFIGURED)).toBe('notConfigured');
  });

  it('leaves the editor unlocked, so the figures can be typed in', () => {
    // The whole point. A locked editor here would make the expense unfillable, which is
    // the difference between "auto-fill is off" and "expense reporting is broken".
    expect(receiptLockState(expenseWith(NOT_CONFIGURED), false)).toEqual({
      editorLocked: false,
      viewerLocked: false,
    });
  });

  it('still shows the receipt, because the AV scan is what gates the preview', () => {
    // Extraction and safety are separate questions; a clean scan is enough to look at
    // the file.
    expect(receiptLockState(expenseWith(NOT_CONFIGURED), false).viewerLocked).toBe(false);
  });

  it('does not poll for an extraction that is not coming', () => {
    // Left in the pending set, the workbench would refetch forever on every report
    // holding a receipt uploaded while the key was missing.
    expect(hasPendingExtractionIn([expenseWith(NOT_CONFIGURED)])).toBe(false);
  });

  it('still locks the editor while extraction is genuinely queued', () => {
    // The other side of the same coin — the two states differ only by `error`, and
    // collapsing them would either break filling or let an extraction overwrite typing.
    expect(receiptLockState(expenseWith(QUEUED), false).editorLocked).toBe(true);
    expect(hasPendingExtractionIn([expenseWith(QUEUED)])).toBe(true);
  });

  it('locks everything while the file is still being uploaded or scanned', () => {
    // Unrelated to the credential: un-scanned bytes are not shown.
    expect(receiptLockState(expenseWith(NOT_CONFIGURED), true)).toEqual({
      editorLocked: true,
      viewerLocked: true,
    });
    const scanning = { scanStatus: 'SCANNING', status: 'PENDING', error: null } as never;
    expect(receiptLockState(expenseWith(scanning), false).viewerLocked).toBe(true);
  });
});

/**
 * The window between the two writes.
 *
 * A receipt row is written by the request; its extraction row is written by the worker.
 * In between there is no extraction at all — and `scanCleared` reads a missing row as
 * "not cleared" and shows "Scanning…", correctly, because un-scanned bytes must not be
 * rendered. But `hasPendingExtractionIn` read the same missing row as "nothing pending"
 * and switched polling OFF, so the pane sat on that placeholder until the reader reloaded
 * the page. The audit waited 56 seconds and gave up (GA readiness report F09).
 */
describe('a receipt whose pipeline has not reported yet', () => {
  const uploadedAgo = (ms: number) =>
    ({
      receipts: [{ extraction: null, uploadedAt: new Date(Date.now() - ms).toISOString() }],
    }) as never;

  it('keeps polling, so the pane clears without a reload', () => {
    expect(hasPendingExtractionIn([uploadedAgo(5_000)])).toBe(true);
  });

  it('stops polling once nothing is plausibly coming', () => {
    // Bounded on purpose: with extraction not configured at all, no row is ever written,
    // and an open-ended wait would be a 4-second heartbeat forever.
    expect(hasPendingExtractionIn([uploadedAgo(10 * 60 * 1000)])).toBe(false);
  });

  it('accepts a Date as well as the wire string', () => {
    expect(
      hasPendingExtractionIn([
        { receipts: [{ extraction: null, uploadedAt: new Date() }] } as never,
      ]),
    ).toBe(true);
  });

  it('does not poll on a receipt with no upload time at all', () => {
    // Rather than treating an unparseable date as "just uploaded" and polling forever.
    expect(hasPendingExtractionIn([{ receipts: [{ extraction: null }] } as never])).toBe(false);
  });

  it('leaves the editor unlocked either way', () => {
    // Waiting for the worker to report is not a reason to stop somebody typing.
    expect(receiptLockState(uploadedAgo(5_000), false)).toEqual({
      editorLocked: false,
      viewerLocked: false,
    });
  });
});

/**
 * A failed extraction still writes a row, and its confidence is 0 — so the expense header
 * badged the failure "AI: 0%", which reads as an extraction that ran and was certain of
 * nothing rather than one that produced nothing at all (GA readiness report F10).
 */
describe('a failed extraction is not a 0%-confident one', () => {
  const FAILED = { scanStatus: 'CLEAN', status: 'FAILED', confidence: 0 } as never;
  const EXTRACTED = { scanStatus: 'CLEAN', status: 'EXTRACTED', confidence: 0.88 } as never;

  it('is a distinct state from a successful extraction', () => {
    expect(receiptState(FAILED)).toBe('extractFailed');
    expect(receiptState(EXTRACTED)).toBe('extracted');
  });

  it('is the state the badge gates on', () => {
    // The header shows a percentage only where `receiptState` says `extracted`, which is
    // the single condition that separates "0% certain" from "did not run".
    expect(receiptState(FAILED)).not.toBe('extracted');
  });
});
