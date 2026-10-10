import '@testing-library/jest-dom/vitest';
import { COMPACT_QUERY } from '@expenseos/design-system';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { restorePointer, stubPointer } from '@/test-utils/pointer';
import { createTrpcMock, type TrpcMockConfig } from '@/test-utils/trpc';
import { ExpenseReportsList, NewReportDialog } from './ExpenseReportsList';

/**
 * VeloExpense: ExpenseOS's `ExpenseReportsList.test.tsx` (w2-05). The cases are ExpenseOS's,
 * with two VeloExpense adaptations, each marked: the receipt upload asks for no extraction
 * until Wave 3 (`startExtraction` is not ported), and the "New report" control's slop class
 * is set on the control rather than coming from the kit Button (f07).
 */

const h = vi.hoisted(() => ({
  trpc: undefined as unknown,
  push: vi.fn(),
  params: {} as Record<string, string>,
  /** What the export menu handed to the browser. */
  downloads: [] as Array<{ filename: string; csv: string }>,
}));

// The export menu's real builder runs; only the browser hand-off is intercepted.
vi.mock('@/lib/exportCsv', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  downloadCsv: (filename: string, csv: string) => {
    h.downloads.push({ filename, csv });
  },
}));
vi.mock('@/lib/trpc/client', () => ({
  get trpc() {
    return h.trpc;
  },
}));
vi.mock('next-intl', () => ({
  useTranslations: () => (key: string, vals?: Record<string, unknown>) =>
    vals && 'count' in vals ? `${key}:${vals.count}` : key,
  useLocale: () => 'en',
}));
vi.mock('next/navigation', () => ({
  useSearchParams: () => ({ get: (k: string) => h.params[k] ?? null }),
}));
// The list navigates through the LOCALE-AWARE router, so the mock has to stand
// where the component imports it from; mocking `next/navigation` alone would
// leave the real next-intl factory running headless in jsdom.
vi.mock('@/i18n/navigation', () => ({
  useRouter: () => ({ push: h.push }),
}));
vi.mock('../TopBar', () => ({ setTopBarSlot: vi.fn() }));

import { setTopBarSlot } from '../TopBar';

function reportRow(over: Record<string, unknown> = {}) {
  return {
    id: 'rep1',
    number: 'EXP-000128',
    title: 'Trip to SF',
    purpose: null,
    businessUnit: 'Sales',
    status: 'DRAFT',
    totalMinor: '64200',
    currency: { code: 'USD', symbol: '$' },
    /** The reader's own currency, and this report's total converted into it. A USD report
     *  read by a CAD reader is the case the currency column exists for. */
    homeCurrency: 'CAD',
    homeTotalMinor: '89100',
    expenseCount: 3,
    submitterId: 'u1',
    currencyId: 'c1',
    approvalInstanceId: null,
    pendingWith: null,
    submittedAt: null,
    approvedAt: null,
    createdAt: '2026-06-09T18:20:00.000Z',
    updatedAt: '2026-06-12T15:04:00.000Z',
    ...over,
  };
}

function setTrpc(config: TrpcMockConfig) {
  h.trpc = createTrpcMock(config);
}

function renderList(over: Partial<Parameters<typeof ExpenseReportsList>[0]> = {}) {
  return render(
    <ExpenseReportsList canCreate={over.canCreate ?? true} canDelete={over.canDelete ?? true} />,
  );
}

beforeEach(() => {
  vi.mocked(setTopBarSlot).mockClear();
  h.push.mockClear();
  h.params = {};
});
afterEach(() => {
  h.trpc = undefined;
  h.downloads = [];
  /**
   * Standing here BEFORE any test in this file stubs a pointer, deliberately.
   *
   * `vi.stubGlobal` is not cleaned up by anything vitest is configured to do here —
   * `vitest.config.ts` sets neither `unstubGlobals` nor `restoreMocks`, and
   * `vi.restoreAllMocks()` does not undo a stubbed global. So the first coarse test
   * written in this file would otherwise leave a phone-shaped `matchMedia` behind for
   * every test after it AND for whatever file the worker ran next — a cross-file failure
   * that a path-filtered run cannot reproduce, which is the one class of bug worth
   * pre-empting rather than debugging. Having the cleanup already here means that test
   * cannot be written wrong.
   *
   * It also closes an existing leak on the way past: this file stubs `fetch` in eight
   * tests and nothing ever put it back.
   */
  restorePointer();
});

describe('<ExpenseReportsList>', () => {
  it('sums the open balance in ONE currency', () => {
    /**
     * The defect this replaces: `openBalance` summed `totalMinor` raw across every
     * submitted and approved report and printed a generic `$` in front of the result — so
     * a USD report and a CAD one were added together as though a cent were a cent, and the
     * glyph they share meant nothing on screen disclosed it (GA readiness report F54).
     *
     * 891.00 + 500.00 = 1,391.00 CAD. The raw sum it used to print would have been
     * 642.00 + 500.00 = 1,142.00 — a number in no currency at all.
     */
    setTrpc({
      queries: {
        'expenses.list': {
          data: [
            reportRow({ status: 'SUBMITTED' }), // USD 642.00 → CAD 891.00
            reportRow({
              id: 'rep2',
              status: 'APPROVED',
              currency: { code: 'CAD', symbol: '$' },
              totalMinor: '50000',
              homeTotalMinor: '50000',
            }),
            // A draft is not an open balance, and must not be counted.
            reportRow({ id: 'rep3', status: 'DRAFT', homeTotalMinor: '999999' }),
          ],
        },
      },
    });
    renderList();
    expect(screen.getByText('CAD 1,391.00')).toBeInTheDocument();
    expect(screen.queryByText('CAD 1,142.00')).not.toBeInTheDocument();
  });

  it('leaves a report it cannot value out of the balance, and says so', () => {
    /**
     * The rule the report rollup already follows, applied to the list: an amount with no
     * rate to the reader's currency is EXCLUDED rather than folded in at the wrong scale —
     * and the exclusion is stated, because an understated balance nobody is told about is
     * worse than a smaller one they are.
     */
    setTrpc({
      queries: {
        'expenses.list': {
          data: [
            reportRow({ status: 'SUBMITTED' }), // CAD 891.00
            reportRow({ id: 'rep2', status: 'SUBMITTED', homeTotalMinor: null }),
          ],
        },
      },
    });
    renderList();
    expect(screen.getByText('CAD 891.00')).toBeInTheDocument();
    // The stub renders `key:count`, so this asserts the notice is shown for exactly one
    // excluded report — the message itself is the catalog's job, and both locales carry it.
    expect(screen.getByText('stats.openExcluded:1')).toBeInTheDocument();
  });

  it('renders a row per report with title, number, count and total', () => {
    setTrpc({
      queries: {
        'expenses.list': {
          data: [
            reportRow(),
            reportRow({
              id: 'rep2',
              number: 'EXP-000131',
              title: 'Montréal',
              totalMinor: '9200',
              homeTotalMinor: '12766',
              expenseCount: 7,
            }),
          ],
        },
      },
    });
    renderList();
    expect(screen.getByText('Trip to SF')).toBeInTheDocument();
    expect(screen.getByText('EXP-000128')).toBeInTheDocument();
    expect(screen.getByText('Montréal')).toBeInTheDocument();
    /**
     * The ISO code, not the glyph. These two assertions used to read `$642.00` and
     * `$92.00` — which is precisely the defect: CAD and USD both render `$`, so a USD
     * report and a CAD one printed identically and the reader could not tell which was
     * which (GA readiness report F54).
     */
    expect(screen.getByText('USD 642.00')).toBeInTheDocument();
    expect(screen.getByText('USD 92.00')).toBeInTheDocument();
    // …and a foreign report also states what it is worth in the reader's own currency.
    expect(screen.getByText('≈ CAD 891.00')).toBeInTheDocument();
    expect(screen.getByText('≈ CAD 127.66')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument(); // rep1 expense count
    expect(screen.getByText('7')).toBeInTheDocument(); // rep2 expense count
  });

  it('navigates to the report workbench on row click', () => {
    setTrpc({ queries: { 'expenses.list': { data: [reportRow()] } } });
    renderList();
    fireEvent.click(screen.getByText('Trip to SF'));
    expect(h.push).toHaveBeenCalledWith('/expenses/rep1');
  });

  it('shows the empty state when there are no reports', () => {
    setTrpc({ queries: { 'expenses.list': { data: [] } } });
    renderList();
    expect(screen.getByText('list.emptyTitle')).toBeInTheDocument();
    expect(screen.queryByText('Trip to SF')).not.toBeInTheDocument();
  });

  // The top-bar right slot carries "Upload receipt" + "New report", both gated
  // on `canCreate`. Grab the node passed to the slot and render it in isolation
  // to check which actions it contains.
  function lastRightSlot(): React.ReactElement {
    const call = vi
      .mocked(setTopBarSlot)
      .mock.calls.filter((c) => c[0] === 'right' && c[1] != null)
      .at(-1);
    if (!call) throw new Error('no non-null right-slot call');
    return call[1] as React.ReactElement;
  }

  it('offers Upload receipt + New report when canCreate, neither otherwise', () => {
    setTrpc({ queries: { 'expenses.list': { data: [] } } });
    const list1 = renderList({ canCreate: true });
    const withCreate = lastRightSlot();
    list1.unmount();
    const slot1 = render(withCreate);
    expect(screen.getByText('list.uploadReceipt')).toBeInTheDocument();
    expect(screen.getByText('list.newReport')).toBeInTheDocument();
    slot1.unmount();

    vi.mocked(setTopBarSlot).mockClear();
    setTrpc({ queries: { 'expenses.list': { data: [] } } });
    const list2 = renderList({ canCreate: false });
    const noCreate = lastRightSlot();
    list2.unmount();
    render(noCreate);
    // Both actions create/write, so neither shows without canCreate.
    expect(screen.queryByText('list.uploadReceipt')).not.toBeInTheDocument();
    expect(screen.queryByText('list.newReport')).not.toBeInTheDocument();
  });
});

describe('<NewReportDialog>', () => {
  it('creates a report with the entered title + chosen currency', () => {
    const onCreated = vi.fn();
    const calls: unknown[] = [];
    h.trpc = createTrpcMock({
      queries: {
        'expenses.currencies': {
          data: [{ id: 'c1', code: 'CAD', symbol: '$', label: { en: 'Canadian Dollar' } }],
        },
      },
      mutations: {
        'expenses.create': {
          onCall: (a) => calls.push(a),
          outcome: 'success',
          data: { id: 'new1' },
        },
      },
    });
    render(<NewReportDialog onClose={vi.fn()} onCreated={onCreated} />);

    expect(screen.getByText('createDialog.title')).toBeInTheDocument();
    const createBtn = screen.getByRole('button', { name: 'createDialog.create' });
    expect(createBtn).toBeDisabled(); // title is empty

    fireEvent.change(screen.getByPlaceholderText('createDialog.reportTitlePlaceholder'), {
      target: { value: 'Trip to SF' },
    });
    expect(createBtn).toBeEnabled();
    fireEvent.click(createBtn);

    // Currency defaults to CAD; the title is passed through trimmed.
    expect(calls).toEqual([{ title: 'Trip to SF', currency: 'CAD' }]);
    expect(onCreated).toHaveBeenCalledWith('new1');
  });

  /**
   * A refusal the person can SEE.
   *
   * `expenses.create` caps the title at `z.string().max(200)`. The dialog set no limit,
   * showed no counter, and registered no `onError` — so a longer title round-tripped to a
   * 400 and the dialog just sat there: button still live, field still full, nothing said,
   * nothing created. Observed on dev with a 260-character title. The only feedback was in
   * the network tab.
   *
   * Two tests, because there are two failures and only one of them is about length. The
   * length is preventable client-side; a server refusal for ANY other reason still has to
   * reach the screen rather than the console.
   */
  const currencyStub = {
    'expenses.currencies': {
      data: [{ id: 'c1', code: 'CAD', symbol: '$', label: { en: 'Canadian Dollar' } }],
    },
  };

  it('refuses a title over the server’s limit, and says so, without calling create', () => {
    const calls: unknown[] = [];
    h.trpc = createTrpcMock({
      queries: currencyStub,
      mutations: { 'expenses.create': { onCall: (a) => calls.push(a), outcome: 'success' } },
    });
    render(<NewReportDialog onClose={vi.fn()} onCreated={vi.fn()} />);

    fireEvent.change(screen.getByPlaceholderText('createDialog.reportTitlePlaceholder'), {
      target: { value: 'Q'.repeat(201) },
    });

    expect(screen.getByText(/createDialog\.titleTooLong/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'createDialog.create' })).toBeDisabled();
    // The point of blocking here: nothing is sent, so there is no 400 to explain.
    fireEvent.click(screen.getByRole('button', { name: 'createDialog.create' }));
    expect(calls).toEqual([]);
  });

  it('shows the server’s refusal instead of swallowing it', () => {
    h.trpc = createTrpcMock({
      queries: currencyStub,
      mutations: {
        'expenses.create': { outcome: 'error', error: { message: 'BAD_REQUEST' } },
      },
    });
    render(<NewReportDialog onClose={vi.fn()} onCreated={vi.fn()} />);

    fireEvent.change(screen.getByPlaceholderText('createDialog.reportTitlePlaceholder'), {
      target: { value: 'Trip to SF' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'createDialog.create' }));

    expect(screen.getByText(/createDialog\.createFailed/)).toBeInTheDocument();
  });

  it('names the approver holding a submitted report', () => {
    // "Submitted" alone doesn't say whether it's moving or stuck — the UAT
    // question was literally "who is my approval sitting with?".
    setTrpc({
      queries: {
        'expenses.list': {
          data: [
            reportRow({
              status: 'SUBMITTED',
              approvalInstanceId: 'inst1',
              pendingWith: { firstName: 'John', lastName: 'Rim', email: 'john.rim@e.inc' },
            }),
          ],
        },
      },
    });
    renderList();
    expect(screen.getByText('list.awaitingName')).toBeInTheDocument();
  });

  it('says nothing extra when the report is not out for approval', () => {
    setTrpc({ queries: { 'expenses.list': { data: [reportRow({ status: 'DRAFT' })] } } });
    renderList();
    expect(screen.queryByText('list.awaitingName')).not.toBeInTheDocument();
  });
});

// ── Receipt-first entry ───────────────────────────────────────────────

/**
 * Dropping receipts in and getting a report back.
 *
 * One upload batch becomes one report holding one expense per file, each with its receipt
 * filed. Three rules, and each of them is the difference between losing somebody's receipts
 * and not:
 *
 *   · **A single failed upload does not abandon the rest.** The report exists either way,
 *     and an expense whose upload failed is visible and re-uploadable in the workbench —
 *     so stopping the loop would strand the files that would have succeeded.
 *   · **Extraction is requested ONCE for the whole batch.** Above a threshold that routes
 *     through the cheaper Batch API, so per-file calls are the expensive shape.
 *   · **A partial failure is reported.** Silently landing four of five receipts is the
 *     worst outcome available: the report looks complete and one expense has no receipt.
 */

/**
 * A FileList, which `fetch`-based upload code indexes and iterates. Each file is one byte
 * unless `sizes` gives its length.
 */
function fileList(names: string[], sizes: number[] = []): FileList {
  const files = names.map(
    (n, i) => new File([new Uint8Array(sizes[i] ?? 1)], n, { type: 'application/pdf' }),
  );
  return {
    // Spread first: an array spreads its indices AND its `length`, so declaring length
    // afterwards is what keeps it from being overwritten by the spread.
    ...files,
    length: files.length,
    item: (i: number) => files[i] ?? null,
    [Symbol.iterator]: function* () {
      yield* files;
    },
  } as unknown as FileList;
}

/**
 * EVERY hidden file input the top-bar slot is currently publishing, in DOM order.
 *
 * Plural, and that is the point. The singular version of this helper returned
 * `container.querySelector('input[type="file"]')` — the FIRST input — which is a correct
 * reading of today's markup and a silently wrong one from the coarse-pointer control
 * pair onward: a camera control renders BEFORE the library control, so `querySelector`
 * would quietly have started answering with the camera input at every call site below,
 * without one test turning red. Selecting the whole set and then naming the input you
 * mean is what makes that a choice rather than an accident.
 *
 * Re-read on every call rather than cached: the slot is republished from an effect, so
 * "the input" is only ever the LATEST published slot's input. That is load-bearing for
 * the disabled-while-busy test below.
 */
function uploadInputs(): HTMLInputElement[] {
  return [...uploadRow().querySelectorAll<HTMLInputElement>('input[type="file"]')];
}

/**
 * The slot's own wrapper element, rendered fresh — the ROW the upload control(s) and
 * "New report" sit in.
 *
 * Extracted from `uploadInputs` rather than added beside it so both read the same
 * render: the coarse-pointer tests below have to assert on the `<label>`s and on the
 * row's own gap, and a second helper that re-rendered the slot independently would be
 * asserting about a different copy of it.
 *
 * The freshness matters as much as it does for the inputs. The pointer is read INSIDE
 * the published element rather than in the effect that publishes it, so re-rendering
 * the captured element is what exercises the coarse branch at all — and re-reading the
 * latest published element is what makes the busy assertions below see the republished
 * slot rather than the one from before the upload started.
 */
function uploadRow(): HTMLElement {
  const slot = vi
    .mocked(setTopBarSlot)
    .mock.calls.filter((c) => c[0] === 'right')
    .at(-1)?.[1];
  const { container } = render(slot as React.ReactElement);
  return container.firstElementChild as HTMLElement;
}

/**
 * The library control's input — the one WITHOUT `capture`. It is the control that takes
 * a batch, so it is the one every upload test below drives.
 *
 * Keyed on the ATTRIBUTE rather than on ordinal position or on label text, which is what
 * lets this file be repaired now, while there is exactly one input and `capture` appears
 * nowhere in the app: today it finds the only input there is, and on the day a second one
 * appears it still finds the right one. `capture="environment"` is also the only
 * honest discriminator available — it is the attribute that makes a control a camera, and
 * unlike a class or a label it cannot be true of both.
 */
function libraryInput(): HTMLInputElement {
  return uploadInputs().find((i) => !i.hasAttribute('capture')) as HTMLInputElement;
}

/**
 * The camera control's input — the one carrying `capture`, or `undefined` when there is
 * none.
 *
 * `undefined` is the ANSWER at a fine pointer, not a failure to find it, and asserting
 * that it is undefined is how a test pins the rule this whole feature turns on: at a fine
 * pointer the camera control is absent from the DOM rather than present-and-hidden.
 * Present-and-hidden would break eight E2E call sites that address file inputs by
 * page-wide ordinal.
 */
function cameraInput(): HTMLInputElement | undefined {
  return uploadInputs().find((i) => i.hasAttribute('capture'));
}

interface UploadStubs {
  onStart?: (...a: unknown[]) => void;
  onUploadUrl?: (...a: unknown[]) => void;
  onReceiptCreate?: (...a: unknown[]) => void;
  onStartExtraction?: (...a: unknown[]) => void;
  expenseIds?: string[];
  startOutcome?: 'success' | 'error';
  putOk?: boolean | boolean[];
}

function uploadTrpc(s: UploadStubs = {}) {
  let created = 0;
  setTrpc({
    queries: { 'expenses.list': { data: [] } },
    mutations: {
      'expenses.startFromReceipts': {
        onCall: s.onStart,
        outcome: s.startOutcome ?? 'success',
        error: { message: 'no home currency' },
        data: { reportId: 'rep-new', expenseIds: s.expenseIds ?? ['e1', 'e2'] },
      },
      'expenses.receiptUploadUrl': {
        onCall: s.onUploadUrl,
        outcome: 'success',
        data: { url: 'https://s3/put', headers: {}, key: 'k' },
      },
      'expenses.receiptCreate': {
        onCall: (...a: unknown[]) => {
          created += 1;
          s.onReceiptCreate?.(...a);
        },
        outcome: 'success',
        get data() {
          return { id: `r${created}` };
        },
      },
      'expenses.startExtraction': { onCall: s.onStartExtraction, outcome: 'success', data: {} },
    },
  });
}

describe('uploading receipts', () => {
  const okFetch = (ok: boolean | boolean[]) => {
    let i = 0;
    return vi.fn(async () => {
      const value = Array.isArray(ok) ? (ok[i++] ?? true) : ok;
      return { ok: value, status: value ? 200 : 503 } as Response;
    });
  };

  it('creates one report for the batch, one upload per file, one extraction call', async () => {
    const onStart = vi.fn();
    const onUploadUrl = vi.fn();
    const onStartExtraction = vi.fn();
    vi.stubGlobal('fetch', okFetch(true));
    uploadTrpc({ onStart, onUploadUrl, onStartExtraction });
    renderList();
    const input = libraryInput();
    fireEvent.change(input, { target: { files: fileList(['a.pdf', 'b.pdf']) } });
    // VeloExpense: waits for the landing rather than for `startExtraction`, which is not
    // called until extraction is ported (Wave 3).
    await vi.waitFor(() => expect(h.push).toHaveBeenCalledWith('/expenses/rep-new'));
    // One report, sized to the batch, with a localized placeholder title.
    expect(onStart.mock.calls[0][0]).toMatchObject({ count: 2, title: 'list.untitledReport' });
    // One presign per file, each against its OWN expense.
    expect(onUploadUrl).toHaveBeenCalledTimes(2);
    expect(onUploadUrl.mock.calls.map((c) => (c[0] as { expenseId: string }).expenseId)).toEqual([
      'e1',
      'e2',
    ]);
    // VeloExpense: no extraction is requested until Wave 3 (ExpenseOS: once, for both
    // receipts together).
    expect(onStartExtraction).not.toHaveBeenCalled();
  });

  it("declares each file's own byte length, the size of the body it PUTs", async () => {
    /** Each link is bound to the declared size, so it must be the size of the body PUT —
     *  read off the PUT itself, so a future client-side transform is caught here. */
    const onUploadUrl = vi.fn();
    const put = okFetch(true);
    vi.stubGlobal('fetch', put);
    uploadTrpc({ onUploadUrl });
    renderList();
    fireEvent.change(libraryInput(), {
      target: { files: fileList(['a.pdf', 'b.pdf'], [1234, 88]) },
    });
    await vi.waitFor(() => expect(put).toHaveBeenCalledTimes(2));
    const putSizes = put.mock.calls.map(
      (c) => ((c as unknown[])[1] as RequestInit & { body: File }).body.size,
    );
    expect(putSizes).toEqual([1234, 88]);
    expect(onUploadUrl.mock.calls.map((c) => (c[0] as { sizeBytes: number }).sizeBytes)).toEqual(
      putSizes,
    );
  });

  it('defers extraction per receipt so the batch can go at once', async () => {
    /** The per-receipt call would extract one at a time, missing the Batch API threshold
     *  the whole fan-out design depends on. */
    const onReceiptCreate = vi.fn();
    vi.stubGlobal('fetch', okFetch(true));
    uploadTrpc({ onReceiptCreate });
    renderList();
    fireEvent.change(libraryInput(), { target: { files: fileList(['a.pdf']) } });
    await vi.waitFor(() => expect(onReceiptCreate).toHaveBeenCalled());
    expect(onReceiptCreate.mock.calls[0][0]).toMatchObject({ deferExtraction: true });
  });

  it('lands on the new report’s workbench', async () => {
    vi.stubGlobal('fetch', okFetch(true));
    uploadTrpc();
    renderList();
    fireEvent.change(libraryInput(), { target: { files: fileList(['a.pdf']) } });
    await vi.waitFor(() => expect(h.push).toHaveBeenCalledWith('/expenses/rep-new'));
  });

  it('keeps going when one file’s upload fails, and says how many', async () => {
    /**
     * The rule that matters most here. Stopping would strand the files that would have
     * succeeded, and the report already exists — so the recoverable state is "four of five
     * landed, and you were told", not "the batch failed".
     */
    const onStartExtraction = vi.fn();
    const onReceiptCreate = vi.fn();
    vi.stubGlobal('fetch', okFetch([false, true]));
    uploadTrpc({ onStartExtraction, onReceiptCreate });
    renderList();
    fireEvent.change(libraryInput(), { target: { files: fileList(['bad.pdf', 'good.pdf']) } });
    expect(await screen.findByText('list.uploadPartial')).toBeInTheDocument();
    // The survivor was still filed. VeloExpense: filed rather than queued for extraction,
    // which is not called until Wave 3 (ExpenseOS asserts `receiptIds: ['r1']` on it).
    expect(onReceiptCreate).toHaveBeenCalledTimes(1);
    expect(onReceiptCreate.mock.calls[0][0]).toMatchObject({ filename: 'good.pdf' });
    expect(onStartExtraction).not.toHaveBeenCalled();
  });

  it('asks for no extraction when every upload failed', async () => {
    /** An empty receiptIds would be a call the server rejects for nothing. */
    const onStartExtraction = vi.fn();
    vi.stubGlobal('fetch', okFetch(false));
    uploadTrpc({ onStartExtraction });
    renderList();
    fireEvent.change(libraryInput(), { target: { files: fileList(['a.pdf']) } });
    await vi.waitFor(() => expect(screen.getByText('list.uploadPartial')).toBeInTheDocument());
    expect(onStartExtraction).not.toHaveBeenCalled();
  });

  it('stops when the server returned fewer expenses than files', async () => {
    /**
     * Defensive, and the alternative is worse than stopping: presigning against
     * `undefined` uploads a file to a URL for no expense, so the receipt exists in the
     * bucket attached to nothing.
     */
    const onUploadUrl = vi.fn();
    vi.stubGlobal('fetch', okFetch(true));
    uploadTrpc({ onUploadUrl, expenseIds: ['e1'] });
    renderList();
    fireEvent.change(libraryInput(), { target: { files: fileList(['a.pdf', 'b.pdf']) } });
    await vi.waitFor(() => expect(h.push).toHaveBeenCalled());
    expect(onUploadUrl).toHaveBeenCalledTimes(1);
  });

  it('reports a failure to create the report at all, and re-enables the control', async () => {
    /**
     * Without re-enabling, one failure disables uploading for the rest of the session.
     *
     * The generic notice rather than the thrown message is the correct branch HERE: the
     * harness rejects with a plain object, and the component only trusts a real `Error`'s
     * message. That guard is what stops a non-Error rejection rendering as "[object
     * Object]" where a person expects a sentence.
     */
    vi.stubGlobal('fetch', okFetch(true));
    uploadTrpc({ startOutcome: 'error' });
    renderList();
    fireEvent.change(libraryInput(), { target: { files: fileList(['a.pdf']) } });
    expect(await screen.findByText('list.uploadFailed')).toBeInTheDocument();
    expect(h.push).not.toHaveBeenCalled();
    /**
     * Waited for, not asserted the moment the notice appears.
     *
     * The notice renders in the page body; the file input lives in the TOP BAR, published
     * through `setTopBarSlot` from an effect keyed on `uploadBusy`. So clearing the busy
     * flag re-renders the page first and re-publishes the slot one effect cycle later —
     * there is a real render in between where the failure is on screen and the control is
     * still disabled.
     *
     * Asserting immediately happened to win that race on a fast machine and lost it in
     * CI, where it read as "the control is never re-enabled" for a control that always
     * was. The claim worth pinning is that it ENDS UP enabled.
     *
     * Over EVERY input, not the first one, and this is the most dangerous of the six
     * selectors this phase repaired. `disabled` reaches both controls of a
     * coarse-pointer pair from one prop, so a bug that re-enabled one and left the other
     * stuck would be invisible to an assertion about `[0]`: the test would report "the
     * control is re-enabled" while the camera control stayed disabled for the rest of the
     * session. That is a silent narrowing rather than a failure, which is exactly why it
     * had to be fixed before there were two controls rather than after.
     *
     * The length guard is not decoration either. `for (… of [])` passes vacuously, so
     * without it the assertion would also go green for a slot that published NO control
     * at all — turning the claim from "it ends up enabled" into "nothing is disabled
     * because nothing is there", which is the same silent narrowing wearing a different
     * hat.
     */
    await vi.waitFor(() => {
      const inputs = uploadInputs();
      expect(inputs).not.toHaveLength(0);
      for (const input of inputs) expect(input).not.toBeDisabled();
    });
  });

  it('shows a real Error’s own message', async () => {
    /** A tRPC client error IS an Error, so the server's sentence is what a person sees. */
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network unreachable');
      }),
    );
    uploadTrpc();
    renderList();
    fireEvent.change(libraryInput(), { target: { files: fileList(['a.pdf']) } });
    // Every file failed on the transport, so the partial notice is what surfaces.
    expect(await screen.findByText('list.uploadPartial')).toBeInTheDocument();
  });

  it('offers no upload control to somebody who may not create', () => {
    setTrpc({ queries: { 'expenses.list': { data: [] } } });
    renderList({ canCreate: false });
    /**
     * NONE of them, counted — not "the first one is missing". `canCreate` is the server's
     * answer about permission, and a coarse-pointer camera control that escaped the same
     * gate would be a real permission hole that a null-check on one input could not see.
     */
    expect(uploadInputs()).toHaveLength(0);
  });

  it('renders exactly ONE file input at a fine pointer, and no camera control', async () => {
    /**
     * The invariant the whole feature turns on, pinned at this entry point: on a desktop
     * the camera control does not exist in the DOM, rather than existing and being
     * hidden.
     *
     * It is not a style preference. Eight E2E call sites across the suite address file
     * inputs by page-wide ordinal and seven of them are in specs with nothing to do with
     * receipts, so a second input emitted here and hidden with CSS breaks all eight at
     * once — with failures that read as product bugs in unrelated features. A fine
     * pointer is the default in this suite (jsdom has no `matchMedia`; `tests/setup.ts`
     * answers `matches: false` to every query), so this test is asserting the desktop
     * case without having to stub anything.
     */
    setTrpc({ queries: { 'expenses.list': { data: [] } } });
    renderList();
    await vi.waitFor(() => expect(uploadInputs()).toHaveLength(1));
    expect(cameraInput()).toBeUndefined();
  });
});

// ── The camera control, at the top bar's entry point ──────────────────

/**
 * On a coarse pointer the reports list's "Upload receipt" chip becomes an
 * ICON-ONLY PAIR: a "Take photo" control carrying `capture="environment"`, then
 * the picker it has always had, relabelled "Choose file".
 * `capture="environment"` forces the camera and removes the library choice,
 * which is why a phone needs a second control rather than a second attribute on
 * the one it already had.
 *
 * Site 1 of P04's four, and the only one that reaches the screen through
 * `setTopBarSlot` — so the thing most worth knowing when reading these tests is
 * WHERE THE POINTER IS READ. It is read inside the published element, never in
 * the effect that publishes it. That is what lets `uploadRow()` pull the last
 * element handed to the mock, render it under a stubbed pointer, and see the
 * coarse branch; had the effect branched on the pointer instead, the boolean
 * would have been frozen at publish time and every test below would only ever
 * have seen a desktop.
 *
 * Icon-only is arithmetic rather than taste at this site. The top bar's right
 * zone is already documented as overflowing at 1024px in FR-CA, and two
 * labelled chips would widen it further; two 32px squares plus `gap-3` is ~76px
 * against today's ~133px, so this pair leaves the row narrower than it found it.
 */
describe('the receipt controls on a phone', () => {
  const filesIn = (row: HTMLElement) => [
    ...row.querySelectorAll<HTMLInputElement>('input[type="file"]'),
  ];
  const labelsIn = (row: HTMLElement) => [...row.querySelectorAll('label')];

  /**
   * Pick a receipt and leave the upload running, so the busy state stays on
   * screen to be asserted.
   *
   * The PUT to the presigned URL is parked forever rather than resolved: the
   * point is the window in which both controls have to go quiet, and on the
   * success path this page never clears `uploadBusy` — it navigates instead. So
   * a parked `fetch` is the only way to hold that window open. `fetch` is
   * dropped again by this file's `afterEach(restorePointer)`.
   */
  function parkedTrpc() {
    const onUploadUrl = vi.fn();
    uploadTrpc({ onUploadUrl });
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>(() => {})),
    );
    // Armed before `renderList`, because the list reads the harness on its
    // first render — not something `startUpload` can do on its way past.
    return onUploadUrl;
  }

  async function startUpload(input: HTMLInputElement, onUploadUrl: () => void) {
    fireEvent.change(input, { target: { files: fileList(['receipt.png']) } });
    // Parked at the PUT, which is well past `setUploadBusy(true)`.
    await vi.waitFor(() => expect(onUploadUrl).toHaveBeenCalled());
  }

  it('keeps the desktop chip exactly as it was, wording and treatment', () => {
    /**
     * The count claim — one input, camera absent from the DOM — is pinned by
     * 'renders exactly ONE file input at a fine pointer' above. This is the
     * other half of the same promise: the icon-only treatment and the
     * two-sources wording must not leak onto a desktop, where there is one
     * control and no choice of source to describe.
     */
    stubPointer('fine');
    setTrpc({ queries: { 'expenses.list': { data: [] } } });
    renderList();

    const row = uploadRow();
    const labels = labelsIn(row);
    expect(labels).toHaveLength(1);
    expect(labels[0]).toHaveTextContent('list.uploadReceipt');
    // A lone control is not a choice between sources, so "Choose file" would be
    // answering a question nobody asked.
    expect(within(row).queryByText('capture.chooseFile')).not.toBeInTheDocument();
    expect(within(row).queryByText('capture.takePhoto')).not.toBeInTheDocument();
    // The labelled chip, not the 32px square.
    expect(labels[0].className).toContain('font-medium');
    expect(labels[0].className).toContain('px-2.5');
    expect(labels[0].className).not.toContain('size-8');
  });

  it('adds a camera control before the picker on a phone, and relabels the pair', () => {
    stubPointer('coarse');
    setTrpc({ queries: { 'expenses.list': { data: [] } } });
    renderList();

    const row = uploadRow();
    const inputs = filesIn(row);
    expect(inputs).toHaveLength(2);
    // Camera first: a phone's first target is the one a phone user wants.
    expect(inputs[0]).toHaveAttribute('capture', 'environment');
    expect(inputs[1]).not.toHaveAttribute('capture');

    const labels = labelsIn(row);
    expect(labels[0]).toHaveTextContent('capture.takePhoto');
    // Two SOURCES, not one source and one outcome — the iOS/Android convention,
    // and the only wording that makes the camera control's missing library
    // choice legible.
    expect(labels[1]).toHaveTextContent('capture.chooseFile');
    expect(within(row).queryByText('list.uploadReceipt')).not.toBeInTheDocument();
    // And the row's other control is untouched by any of it.
    expect(within(row).getByText('list.newReport')).toBeInTheDocument();
  });

  it('keeps multi-file on the picker and never puts it on the camera', () => {
    /**
     * This site is the batch one: one upload becomes one report holding one
     * expense per file, so losing `multiple` here would quietly turn the
     * receipt-first entry point into a one-at-a-time one. The camera must not
     * have it — `capture` returns exactly one image per invocation on iOS
     * Safari and on Android Chrome whatever `multiple` says, so the attribute
     * would promise a batch the camera cannot deliver.
     */
    stubPointer('coarse');
    setTrpc({ queries: { 'expenses.list': { data: [] } } });
    renderList();

    const [camera, picker] = filesIn(uploadRow());
    expect(camera).not.toHaveAttribute('multiple');
    expect(picker).toHaveAttribute('multiple');
  });

  it('names both icon-only controls through sr-only text and no aria-label', () => {
    stubPointer('coarse');
    setTrpc({ queries: { 'expenses.list': { data: [] } } });
    renderList();

    const row = uploadRow();
    for (const label of labelsIn(row)) {
      // One string, one translation, and voice control ("tap Take photo")
      // matches what a sighted user is told the icon means.
      expect(label.querySelectorAll('span.sr-only')).toHaveLength(1);
      /**
       * NOT `aria-label`, on either node. On a `<label>` element it does
       * nothing useful, and on the input it would shadow the visible text at
       * the sites that still have visible text.
       */
      expect(label).not.toHaveAttribute('aria-label');
      expect(label.querySelector('input')).not.toHaveAttribute('aria-label');
      // The icon is decoration once a name exists; announcing both would read
      // the control out twice.
      expect(label.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    }
  });

  it('reaches 44px by hit-slop, so the painted boxes stay 32px', () => {
    stubPointer('coarse');
    setTrpc({ queries: { 'expenses.list': { data: [] } } });
    renderList();

    const row = uploadRow();
    /**
     * Each ring reaches 6px past what its chip paints — a 7px inset against the
     * padding box, less this chip's 1px border. Two of those collide at this
     * row's 8px gap and the later sibling wins, so "Choose file" would silently
     * steal taps aimed at "Take photo". 12px is where the two rings abut
     * exactly, and it is also what gives "New report" next door the >=6px of
     * clearance past the ring that `ReceiptFileInput`'s file comment asks for.
     */
    expect(row.className).toContain('pointer-coarse:gap-3');
    for (const label of labelsIn(row)) {
      // 32px painted, 44px tappable. The zone is a fixed `h-8` aligned against
      // the shell's 32px bell, so a real 44px box would overflow the header's
      // padding and sit visibly taller than the bell — which is why this site
      // takes the invisible ring and sites 2 and 3 take a real resize.
      expect(label.className).toContain('size-8');
      // 30 (padding box) + 7 + 7 = 44. Pinned as a literal beside `size-8`
      // because the two only add up together: the inset is measured from the
      // padding box, so this chip's 1px border is part of the arithmetic.
      expect(label.className).toContain('pointer-coarse:after:-inset-[7px]');
      expect(label.className).not.toContain('pointer-coarse:min-h-11');
      // The width arithmetic that makes this pair narrower than the chip it
      // replaces is only true of a square that cannot be compressed, and the
      // zone's page box is its designated `min-w-0` yielder.
      expect(label.className).toContain('shrink-0');
    }
  });

  it('files a receipt taken with the camera', async () => {
    stubPointer('coarse');
    const onStart = vi.fn();
    const onUploadUrl = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200 }) as Response),
    );
    uploadTrpc({ onStart, onUploadUrl });
    renderList();

    const camera = cameraInput() as HTMLInputElement;
    fireEvent.change(camera, { target: { files: fileList(['photo.jpg']) } });

    // The camera control is wired to the same batch handler as the picker: one
    // report, sized to what arrived, then one presign against its own expense.
    await vi.waitFor(() => expect(onUploadUrl).toHaveBeenCalled());
    expect(onStart.mock.calls[0][0]).toMatchObject({ count: 1, title: 'list.untitledReport' });
    expect(onUploadUrl.mock.calls[0][0]).toMatchObject({ expenseId: 'e1', filename: 'photo.jpg' });
  });

  it('quiets both controls while an upload runs on a phone', async () => {
    stubPointer('coarse');
    const onUploadUrl = parkedTrpc();
    renderList();
    await startUpload(libraryInput(), onUploadUrl);

    /**
     * `disabled` on the inputs is not enough once there are two controls: a
     * person who taps the one they did NOT start the upload with gets silence
     * and nothing to explain it. So both labels go quiet, and say so — reusing
     * the drawer's existing "Uploading…" rather than translating the same word
     * again.
     *
     * Waited for rather than asserted straight away, for the reason the
     * re-enable test above sets out at length: the control lives in the top bar
     * and is republished from an effect keyed on `uploadBusy`, so there is a
     * real render between the flag flipping and the slot carrying it.
     */
    await vi.waitFor(() => {
      const row = uploadRow();
      const labels = labelsIn(row);
      expect(labels).toHaveLength(2);
      for (const label of labels) {
        expect(label).toHaveTextContent('drawer.uploading');
        expect(label).toHaveAttribute('aria-disabled', 'true');
        // What actually swallows the tap, and what explains it. No spinner:
        // this codebase has no `animate-spin` and no reduced-motion handling
        // anywhere, so motion here would open an obligation P04 is not paying.
        expect(label.className).toContain('pointer-events-none');
        expect(label.className).toContain('opacity-50');
      }
      for (const input of filesIn(row)) expect(input).toBeDisabled();
      expect(within(row).queryByText('capture.takePhoto')).not.toBeInTheDocument();
      expect(within(row).queryByText('capture.chooseFile')).not.toBeInTheDocument();
    });
  });

  it('leaves the desktop busy state precisely as it was', async () => {
    stubPointer('fine');
    const onUploadUrl = parkedTrpc();
    renderList();
    const before = labelsIn(uploadRow())[0].className;
    await startUpload(libraryInput(), onUploadUrl);

    /**
     * Today's behaviour and not one thing more: the input goes disabled, and
     * the label keeps its wording and its classes. The relabel and the dimming
     * exist to answer "why did nothing happen when I tapped the other one", and
     * on a desktop there is no other one.
     */
    await vi.waitFor(() => {
      const row = uploadRow();
      const label = labelsIn(row)[0];
      expect(filesIn(row)[0]).toBeDisabled();
      expect(label).toHaveTextContent('list.uploadReceipt');
      expect(label).not.toHaveAttribute('aria-disabled');
      expect(label.className).toBe(before);
      expect(within(row).queryByText('drawer.uploading')).not.toBeInTheDocument();
    });
  });

  it('offers no camera control to somebody who may not create', () => {
    /**
     * The coarse-pointer half of the `canCreate` gate above, and it is worth
     * its own test rather than being assumed from the desktop one: the camera
     * control is a second element behind the same condition, and one that
     * escaped the gate would be a real permission hole on precisely the devices
     * least able to report it.
     */
    stubPointer('coarse');
    setTrpc({ queries: { 'expenses.list': { data: [] } } });
    renderList({ canCreate: false });
    expect(uploadInputs()).toHaveLength(0);
  });
});

// ── Deep link ─────────────────────────────────────────────────────────

describe('the notification deep link', () => {
  it('opens the report named in the query string', () => {
    /** A notification links here rather than straight to the workbench so the list is the
     *  single entry point; the redirect is what makes that invisible. */
    h.params = { report: 'rep-42' };
    setTrpc({ queries: { 'expenses.list': { data: [] } } });
    renderList();
    expect(h.push).toHaveBeenCalledWith('/expenses/rep-42');
  });

  it('does not redirect when there is no link', () => {
    setTrpc({ queries: { 'expenses.list': { data: [] } } });
    renderList();
    expect(h.push).not.toHaveBeenCalled();
  });

  it('follows one click once, however often the list re-renders', () => {
    /**
     * The effect runs on every render while the param is in the address bar. Without the
     * seen-guard, coming BACK to the list would immediately bounce the reader out of it
     * again — a page they cannot stay on.
     */
    h.params = { report: 'rep-42', n: '1' };
    setTrpc({ queries: { 'expenses.list': { data: [] } } });
    const { rerender } = render(<ExpenseReportsList canCreate canDelete />);
    rerender(<ExpenseReportsList canCreate canDelete />);
    rerender(<ExpenseReportsList canCreate canDelete />);
    expect(h.push).toHaveBeenCalledTimes(1);
  });
});

// ── Deleting, and narrowing the list ──────────────────────────────────

describe('deleting a report', () => {
  /**
   * The previous version of this bailed out — `if (!menu) return` — on a selector that
   * never matched, so it passed without pressing anything. The menu is a `RowActionsMenu`
   * labelled by `actions.menu`, not the column menu.
   */
  const rowMenu = async (user: ReturnType<typeof userEvent.setup>, title: string) => {
    const row = screen.getByText(title).closest('tr') as HTMLElement;
    await user.click(within(row).getByRole('button', { name: 'actions.menu' }));
  };

  it('deletes the row whose menu was opened', async () => {
    const user = userEvent.setup();
    const onCall = vi.fn();
    setTrpc({
      queries: {
        'expenses.list': { data: [reportRow(), reportRow({ id: 'rep2', title: 'Montréal' })] },
      },
      mutations: { 'expenses.deleteReport': { onCall, outcome: 'success' } },
    });
    renderList();
    await rowMenu(user, 'Montréal');
    await user.click(await screen.findByText('actions.delete'));
    expect(onCall).toHaveBeenCalledWith({ reportId: 'rep2' });
  });

  it('offers no delete on a report that has already been submitted', async () => {
    /**
     * Deleting a submitted report would take work out from under whoever is holding the
     * approval, and leave their task pointing at nothing. The server refuses it; the menu
     * does not offer it.
     */
    const user = userEvent.setup();
    setTrpc({ queries: { 'expenses.list': { data: [reportRow({ status: 'SUBMITTED' })] } } });
    renderList();
    await rowMenu(user, 'Trip to SF');
    expect(await screen.findByText('actions.view')).toBeInTheDocument();
    expect(screen.queryByText('actions.delete')).not.toBeInTheDocument();
  });

  it('offers no delete to somebody who may not delete', async () => {
    const user = userEvent.setup();
    setTrpc({ queries: { 'expenses.list': { data: [reportRow()] } } });
    renderList({ canDelete: false });
    await rowMenu(user, 'Trip to SF');
    expect(await screen.findByText('actions.view')).toBeInTheDocument();
    expect(screen.queryByText('actions.delete')).not.toBeInTheDocument();
  });

  it('opens the report from the same menu', async () => {
    const user = userEvent.setup();
    setTrpc({ queries: { 'expenses.list': { data: [reportRow()] } } });
    renderList();
    await rowMenu(user, 'Trip to SF');
    await user.click(await screen.findByText('actions.view'));
    expect(h.push).toHaveBeenCalledWith('/expenses/rep1');
  });
});

describe('narrowing the list', () => {
  /**
   * The previous version of this asserted that both rows were on screen and never
   * applied a filter — it would have passed against a page with no filtering at all.
   * Both clauses are hand-written here, and `report` matches the NUMBER as well as the
   * title because people quote the number out of an email.
   */
  const rows = [
    reportRow({ id: 'a', number: 'EXP-1', title: 'Trip to SF', status: 'DRAFT' }),
    reportRow({ id: 'b', number: 'EXP-2', title: 'Client dinner', status: 'SUBMITTED' }),
  ];

  const titles = () => ['Trip to SF', 'Client dinner'].filter((t) => screen.queryByText(t));

  const addPill = async (
    user: ReturnType<typeof userEvent.setup>,
    field: string,
    op: string,
    value: string,
    kind: 'text' | 'enum' = 'text',
  ) => {
    await user.click(screen.getByRole('button', { name: /(?:Add filter|filters\.addFilter)/ }));
    await user.selectOptions(await screen.findByLabelText(/(?:^Field$|filters\.field)/), field);
    await user.selectOptions(screen.getByLabelText(/(?:^Operator$|filters\.operator)/), op);
    const control = screen.getByLabelText(/(?:^Value$|filters\.value$)/);
    if (kind === 'enum') await user.selectOptions(control, value);
    else await user.type(control, value);
    await user.click(screen.getByRole('button', { name: /(?:^Add$|filters\.add$)/ }));
  };

  it('narrows to one status', async () => {
    const user = userEvent.setup();
    setTrpc({ queries: { 'expenses.list': { data: rows } } });
    renderList();
    await addPill(user, 'status', 'equals', 'SUBMITTED', 'enum');
    expect(titles()).toEqual(['Client dinner']);
  });

  it('matches a report by its title', async () => {
    const user = userEvent.setup();
    setTrpc({ queries: { 'expenses.list': { data: rows } } });
    renderList();
    await addPill(user, 'report', 'contains', 'dinner');
    expect(titles()).toEqual(['Client dinner']);
  });

  it('matches a report by its number as well as its title', async () => {
    /** People quote the number from an email; searching only titles would find nothing. */
    const user = userEvent.setup();
    setTrpc({ queries: { 'expenses.list': { data: rows } } });
    renderList();
    await addPill(user, 'report', 'contains', 'exp-2');
    expect(titles()).toEqual(['Client dinner']);
  });

  it('applies both clauses rather than letting the last one win', async () => {
    const user = userEvent.setup();
    setTrpc({ queries: { 'expenses.list': { data: rows } } });
    renderList();
    await addPill(user, 'status', 'equals', 'DRAFT', 'enum');
    await addPill(user, 'report', 'contains', 'trip');
    expect(titles()).toEqual(['Trip to SF']);
  });
});

describe('exporting the list', () => {
  /**
   * A reader exports this to answer "where are my claims" somewhere other than here — a
   * status update, a month-end chase. So the columns carry the words the screen carries,
   * and the status column carries the extra fact the badge cannot: WHO is holding a
   * submitted report. "Submitted" alone does not say whether it is moving or stuck.
   */
  const exportCsv = async (user: ReturnType<typeof userEvent.setup>) => {
    // The export and settings triggers share the bare key under this file's
    // namespace-less `t`; export is first in the toolbar's slot.
    await user.click(screen.getAllByRole('button', { name: 'trigger' })[0]);
    await user.click(await screen.findByText('CSV'));
    return h.downloads.at(-1)?.csv ?? '';
  };

  it('names the report by its title and its number together', async () => {
    const user = userEvent.setup();
    setTrpc({ queries: { 'expenses.list': { data: [reportRow()] } } });
    renderList();
    expect(await exportCsv(user)).toContain('Trip to SF (EXP-000128)');
  });

  it('says who is holding a submitted report, not just that it is submitted', async () => {
    const user = userEvent.setup();
    setTrpc({
      queries: {
        'expenses.list': {
          data: [
            reportRow({
              status: 'SUBMITTED',
              pendingWith: { firstName: 'John', lastName: 'Rim', email: 'john.rim@e.inc' },
            }),
          ],
        },
      },
    });
    renderList();
    expect(await exportCsv(user)).toContain('list.awaitingName');
  });

  it('falls back to the plain status for a report nobody is holding', async () => {
    const user = userEvent.setup();
    setTrpc({ queries: { 'expenses.list': { data: [reportRow({ status: 'DRAFT' })] } } });
    renderList();
    const csv = await exportCsv(user);
    expect(csv).toContain('status.draft');
    expect(csv).not.toContain('list.awaitingName');
  });

  it('carries the count and the total with its currency', async () => {
    const user = userEvent.setup();
    setTrpc({ queries: { 'expenses.list': { data: [reportRow()] } } });
    renderList();
    const csv = await exportCsv(user);
    expect(csv).toContain('642.00');
    expect(csv).toMatch(/(^|,)3(,|$)/m);
  });

  it('exports what the filter left, not every report', async () => {
    const user = userEvent.setup();
    setTrpc({
      queries: {
        'expenses.list': {
          data: [reportRow(), reportRow({ id: 'b', number: 'EXP-2', title: 'Client dinner' })],
        },
      },
    });
    renderList();
    await user.click(screen.getByRole('button', { name: /(?:Add filter|filters\.addFilter)/ }));
    await user.selectOptions(await screen.findByLabelText(/(?:^Field$|filters\.field)/), 'report');
    await user.selectOptions(screen.getByLabelText(/(?:^Operator$|filters\.operator)/), 'contains');
    await user.type(screen.getByLabelText(/(?:^Value$|filters\.value$)/), 'dinner');
    await user.click(screen.getByRole('button', { name: /(?:^Add$|filters\.add$)/ }));
    const csv = await exportCsv(user);
    expect(csv).toContain('Client dinner');
    expect(csv).not.toContain('Trip to SF');
  });
});

describe('starting a report from the list', () => {
  /**
   * The New-report button lives in the app's TOP BAR, which this page pushes a node into
   * — so the button and the dialog are rendered by two different roots. They still share
   * the list's state: pressing the button calls `setCreating` on the mounted list, and
   * the dialog appears there. That is exactly the wiring worth pinning, because it is
   * the one thing a slot-based control can quietly lose.
   */
  const rightSlot = (): React.ReactElement => {
    const call = vi
      .mocked(setTopBarSlot)
      .mock.calls.filter((c) => c[0] === 'right' && c[1] != null)
      .at(-1);
    if (!call) throw new Error('no non-null right-slot call');
    return call[1] as React.ReactElement;
  };

  const pressNewReport = async (user: ReturnType<typeof userEvent.setup>) => {
    render(rightSlot());
    await user.click(screen.getByText('list.newReport'));
  };

  it('opens the dialog, then lands on what it created', async () => {
    const user = userEvent.setup();
    h.trpc = createTrpcMock({
      queries: {
        'expenses.list': { data: [] },
        'expenses.currencies': {
          data: [{ id: 'c1', code: 'CAD', symbol: '$', label: { en: 'Canadian Dollar' } }],
        },
      },
      mutations: { 'expenses.create': { outcome: 'success', data: { id: 'new1' } } },
    });
    renderList();
    await pressNewReport(user);
    await user.type(
      await screen.findByPlaceholderText('createDialog.reportTitlePlaceholder'),
      'Trip to SF',
    );
    await user.click(screen.getByRole('button', { name: 'createDialog.create' }));
    expect(h.push).toHaveBeenCalledWith('/expenses/new1');
  });

  it('closes without creating anything on cancel', async () => {
    const user = userEvent.setup();
    const onCall = vi.fn();
    h.trpc = createTrpcMock({
      queries: { 'expenses.list': { data: [] }, 'expenses.currencies': { data: [] } },
      mutations: { 'expenses.create': { onCall, outcome: 'success', data: { id: 'x' } } },
    });
    renderList();
    await pressNewReport(user);
    await screen.findByText('createDialog.title');
    await user.click(screen.getByRole('button', { name: 'addLine.cancel' }));
    expect(screen.queryByText('createDialog.title')).not.toBeInTheDocument();
    expect(onCall).not.toHaveBeenCalled();
  });

  it('opens with an empty currency list rather than refusing to open', async () => {
    /** The currency list is its own query. A dialog that will not render until it lands
     *  is a New-report button that does nothing for the first second of every visit. */
    const user = userEvent.setup();
    h.trpc = createTrpcMock({
      queries: {
        'expenses.list': { data: [] },
        'expenses.currencies': { isLoading: true, data: undefined },
      },
      mutations: { 'expenses.create': { outcome: 'success', data: { id: 'x' } } },
    });
    renderList();
    await pressNewReport(user);
    expect(await screen.findByText('createDialog.title')).toBeInTheDocument();
  });

  it('will not create a report titled only spaces', async () => {
    const user = userEvent.setup();
    h.trpc = createTrpcMock({
      queries: {
        'expenses.currencies': {
          data: [{ id: 'c1', code: 'CAD', symbol: '$', label: { en: 'Canadian Dollar' } }],
        },
      },
      mutations: { 'expenses.create': { outcome: 'success', data: { id: 'x' } } },
    });
    render(<NewReportDialog onClose={vi.fn()} onCreated={vi.fn()} />);
    await user.type(screen.getByPlaceholderText('createDialog.reportTitlePlaceholder'), '   ');
    expect(screen.getByRole('button', { name: 'createDialog.create' })).toBeDisabled();
  });
});

/**
 * /expenses below `md` — the one worked example of the opt-in card API.
 *
 * Done-when 1 names this page at 390px and cannot be verified without it.
 * The browser half (real geometry at 360 and 390) lives in
 * `e2e/datatable-mobile.spec.ts`; what is pinned HERE is the wiring a
 * screenshot cannot see: which columns a card borrows, that the kebab moved
 * rather than multiplied, and that every string on the compact chrome came
 * out of the catalog.
 *
 * That last one is the F43 guard and it is the reason this block exists at
 * all. `<FilterSheet>` and `<SortSheet>` default every label to English
 * INSIDE the design system, as literals. `check-used-keys` cannot see a
 * literal — there is no key for it to look for — so a page that mounted
 * either sheet without its bag would ship "Filters" and "Sort" to a French
 * reader and no gate in the repo would say a word. It is exactly how the
 * filter-pill chrome shipped in English. Under this file's next-intl mock a
 * catalog key renders as the key itself, so the two are trivially
 * distinguishable: `mobile.filtersTrigger` means the bag arrived, `Filters`
 * means the DS default did.
 */
describe('<ExpenseReportsList> on a phone', () => {
  /** Answer `matchMedia` as a phone. Only `COMPACT_QUERY` flips, so no
   *  unrelated probe inside the design system is accidentally answered. */
  function stubCompact(compact: boolean) {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query === COMPACT_QUERY ? compact : false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }));
  }

  function renderCompact(over: Partial<Parameters<typeof ExpenseReportsList>[0]> = {}) {
    stubCompact(true);
    setTrpc({
      queries: {
        'expenses.list': {
          data: [
            reportRow(),
            reportRow({
              id: 'rep2',
              number: 'EXP-000129',
              title: 'Client dinner',
              status: 'SUBMITTED',
            }),
          ],
        },
      },
    });
    return renderList(over);
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders cards, not a table', () => {
    renderCompact();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });

  it('borrows exactly the configured columns — title, badge, and two fields', () => {
    renderCompact();
    const card = screen.getByRole('listitem', { name: /Trip to SF/ });
    expect(card).toHaveTextContent('Trip to SF'); // title: report
    expect(card).toHaveTextContent('EXP-000128');
    expect(card).toHaveTextContent('status.draft'); // badge: status
    expect(card).toHaveTextContent('columns.total'); // field: total
    expect(card).toHaveTextContent('USD 642.00');
    expect(card).toHaveTextContent('columns.updated'); // field: updated
    /**
     * The line COUNT is deliberately not on the card. `mobile.fields` is
     * `['total', 'updated']` and the intersection with column visibility is a
     * pure read — nothing on the card path writes `visibleColumns`,
     * `columnWidths` or `density` back, so a phone cannot rewrite the desktop
     * layout of a saved view.
     */
    expect(card).not.toHaveTextContent('columns.expenses');
  });

  it('offers no per-card checkbox — selection is P05/P07’s, with its bulk bar', () => {
    // `mobile.selectable` is a SECOND opt-in on top of the table's
    // `selectable`, and this page sets neither. Ticking rows that no
    // 360px-wide action bar can act on is worse than not ticking them.
    renderCompact();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });

  it('MOVES the row kebab out of the title cell instead of drawing a second one', async () => {
    /**
     * On the desktop the kebab lives inside the `report` cell, at the right
     * edge of the identity column. A card draws that same cell as its TITLE,
     * so leaving the menu in it would put a 24px trigger inside the card's
     * accessible name, beside the card's own 44px one — two menus offering
     * the same two items, one of them too small to hit.
     *
     * `ctx.compact` is how the cell knows. The table's aria-label
     * (`actions.menu`) must be absent and the card's (`rowActions`) present.
     */
    const user = userEvent.setup();
    renderCompact();
    expect(screen.queryByRole('button', { name: 'actions.menu' })).not.toBeInTheDocument();
    const kebabs = screen.getAllByRole('button', { name: 'rowActions' });
    expect(kebabs).toHaveLength(2);
    // 44×44 on the BUTTON, not a div drawn around a 24px one.
    expect(kebabs[0]).toHaveClass('h-11', 'w-11');

    // Same actions, same conditions: the draft offers delete, and the
    // submitted report does not.
    await user.click(kebabs[0] as HTMLElement);
    expect(await screen.findByText('actions.view')).toBeInTheDocument();
    expect(screen.getByText('actions.delete')).toBeInTheDocument();
  });

  it('withholds delete on the card exactly where it withholds it in the table', async () => {
    const user = userEvent.setup();
    renderCompact({ canDelete: false });
    await user.click(screen.getAllByRole('button', { name: 'rowActions' })[0] as HTMLElement);
    expect(await screen.findByText('actions.view')).toBeInTheDocument();
    expect(screen.queryByText('actions.delete')).not.toBeInTheDocument();
  });

  it('puts sort and filter within reach, at 44px, in place of the pill bar', () => {
    // Done-when 2. Cards have no column headers, so the two affordances the
    // table hangs off a `<th>` have nowhere to live; these are where they go.
    renderCompact();
    const filters = screen.getByRole('button', { name: 'mobile.filtersTrigger' });
    const sort = screen.getByRole('button', { name: 'mobile.sortTrigger' });
    expect(filters).toHaveClass('h-11');
    expect(sort).toHaveClass('h-11');
  });

  it('labels both sheets from the catalog, never from the design system’s English', () => {
    // THE F43 GUARD. See the note above this describe block.
    renderCompact();
    expect(screen.getByRole('button', { name: 'mobile.filtersTrigger' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'mobile.sortTrigger' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Filters' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sort' })).not.toBeInTheDocument();
  });

  it('labels the sheet CONTENTS from the catalog too, not just the triggers', async () => {
    // A trigger can be right while everything behind it is English — the
    // sheet takes two separate bags (`labels` for the pill chrome it shares
    // with the bar, `sheetLabels` for the frame that only exists below `md`)
    // and forgetting either is silent.
    const user = userEvent.setup();
    renderCompact();
    await user.click(screen.getByRole('button', { name: 'mobile.filtersTrigger' }));
    const sheet = await screen.findByRole('dialog');
    expect(within(sheet).getByText('mobile.filtersEmpty')).toBeInTheDocument();
    expect(within(sheet).getByText('filters.addFilter')).toBeInTheDocument();
    expect(within(sheet).getByRole('button', { name: 'mobile.done' })).toBeInTheDocument();
    expect(within(sheet).queryByText('No filters yet.')).not.toBeInTheDocument();
    expect(within(sheet).queryByText('Add filter')).not.toBeInTheDocument();
  });

  it('offers the sort sheet exactly the fields the column header would offer', async () => {
    /**
     * Built from `sortSheetOptions`, which is `resolveSortField` mapped over
     * the visible columns — the SAME resolver the header calls. A sheet built
     * from `sortable: true` alone would offer a field the header withholds,
     * which is F04 again by another route: an indicator that moves and rows
     * that do not.
     *
     * On this page `report` and `status` declare `sortable`; `expenses`,
     * `total` and `updated` do not, so the sheet must not list them.
     */
    const user = userEvent.setup();
    renderCompact();
    await user.click(screen.getByRole('button', { name: 'mobile.sortTrigger' }));
    const sheet = await screen.findByRole('dialog');
    const fields = within(sheet)
      .getAllByRole('radio')
      .map((r) => r.textContent);
    expect(fields).toContain('columns.report');
    expect(fields).toContain('columns.status');
    expect(fields).not.toContain('columns.total');
    expect(fields).not.toContain('columns.updated');
  });

  it('counts filter GROUPS on the trigger, not clauses', async () => {
    /**
     * "Status is Draft or Submitted" is ONE filter to whoever set it, and a
     * trigger reading `Filters · 2` would describe a screen they cannot see
     * behind the sheet. The design system pins the mapping from clauses to
     * groups (`groupClauses`, and `FilterSheet.test.tsx`); what this pins is
     * the half only the page can get wrong — that the array the sheet counts
     * is `pillBar.filters`, the same one the bar and `filteredRows` read, and
     * not a copy of its own.
     */
    const user = userEvent.setup();
    renderCompact();

    /**
     * Open, add one `status equals <value>` clause, close.
     *
     * The close is not tidiness: an open Drawer marks the rest of the page
     * inert, so the trigger this test is about is out of the accessibility
     * tree until the sheet is dismissed — which is exactly what a reader
     * sees, and the only state in which the count is worth reading.
     */
    async function addStatus(value: string, triggerName: string) {
      await user.click(screen.getByRole('button', { name: triggerName }));
      const sheet = await screen.findByRole('dialog');
      await user.click(within(sheet).getByText('filters.addFilter'));
      // The popover is portaled, so it is addressed from the document.
      await user.selectOptions(await screen.findByLabelText('filters.field'), 'status');
      await user.selectOptions(screen.getByLabelText('filters.value'), value);
      await user.click(screen.getByRole('button', { name: 'filters.add' }));
      await user.click(
        within(screen.getByRole('dialog')).getByRole('button', { name: 'mobile.done' }),
      );
    }

    await addStatus('DRAFT', 'mobile.filtersTrigger');
    expect(
      await screen.findByRole('button', { name: 'mobile.filtersWithCount:1' }),
    ).toBeInTheDocument();
    // One DRAFT row in the fixture, and one clause: the list agrees with the
    // trigger here.
    expect(screen.getAllByRole('listitem')).toHaveLength(1);

    // A second value on the SAME field and operator joins the first block
    // with `or`. Two clauses, still one filter.
    await addStatus('SUBMITTED', 'mobile.filtersWithCount:1');
    expect(
      await screen.findByRole('button', { name: 'mobile.filtersWithCount:1' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'mobile.filtersWithCount:2' }),
    ).not.toBeInTheDocument();

    /**
     * ZERO rows, and that is a PRE-EXISTING BUG being pinned, not the
     * behaviour anyone wants.
     *
     * The sheet drew "Draft or Submitted" and the trigger counted it as one
     * filter, both correctly. The matcher then disagrees:
     * `ExpenseReportsList.tsx:384-398` walks `tableState.filters` and
     * narrows successively, so two `status equals` clauses AND together and
     * intersect to nothing. `AllExpensesList.tsx:488-505` already carries
     * the fix — it buckets clauses by field and ORs the `equals` set within
     * a bucket — and this page has not had it yet.
     *
     * The count below is therefore what the page DOES, not what it should
     * do. It is asserted so the empty list fails loudly instead of passing
     * silently: whoever ports the group-by-field OR-equals matcher over here
     * gets told by this test that the number changed (it should become 2)
     * rather than finding the suite quietly green either way.
     */
    expect(screen.queryAllByRole('listitem')).toHaveLength(0);
  });

  it('keeps the pill bar as the ONLY filter frame at desktop width', () => {
    // One frame at a time. The bar is a horizontal strip with no room below
    // `md`; the sheet is that strip stacked. Both at once would be two filter
    // editors on one screen writing to one clause array.
    stubCompact(false);
    setTrpc({ queries: { 'expenses.list': { data: [reportRow()] } } });
    renderList();
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'mobile.filtersTrigger' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'mobile.sortTrigger' })).not.toBeInTheDocument();
    expect(screen.getByText('filters.addFilter')).toBeInTheDocument();
  });
});

// ── The "New report" control, icon-only below `lg` ────────────────────

/**
 * The third control in the top bar's coarse-pointer row — "Take photo",
 * "Choose file", "New report" — and the only one this change touches.
 *
 * WHAT IS NOT HERE, DELIBERATELY. Nothing below asserts anything about the
 * row's `pointer-coarse:gap-3`, and the assertion that does
 * (`reaches 44px by hit-slop, so the painted boxes stay 32px`, above) is
 * unchanged. CSS flex `gap` is a fixed distance between adjacent items' box
 * edges and is independent of either item's own width, so narrowing this
 * control moves its LEFT edge right and leaves the 12px seam — and the
 * 12 − 6 = 6px of clearance past the receipt chip's ring that
 * `ReceiptFileInput`'s file comment asks for — exactly where it was. The row
 * gets narrower overall; the seam does not. A second, weaker assertion about
 * the same class here would read as this change having an opinion on it.
 *
 * `uploadRow()` is the file's existing extractor and no new one was written:
 * it pulls the last element handed to `setTopBarSlot('right', …)` and renders
 * it on its own, which is what these assertions need. `stubPointer('coarse')`
 * is for HONESTY about the subject rather than for the assertions — the claim
 * is about a phone, and a phone is the width at which three controls share this
 * row. jsdom applies no stylesheet, so every `max-lg:` assertion below would
 * read identically on a stubbed desktop; that is a limit of this level, not a
 * reason to pick the wrong device.
 *
 * The translation mock renders catalog KEYS, not values, so the accessible name
 * queried for is `list.newReport`.
 */
describe('the "New report" control the top bar publishes', () => {
  const published = () => {
    stubPointer('coarse');
    setTrpc({ queries: { 'expenses.list': { data: [] } } });
    renderList();
    return within(uploadRow()).getAllByRole('button', { name: /list\.newReport/ });
  };

  it('publishes exactly one button, not a labelled one and an icon one', () => {
    /**
     * Stated as a count so the REASON is legible rather than inferred from a
     * query that happens to be singular. A labelled `max-lg:hidden` button
     * beside an icon `lg:hidden` one is the plausible wrong answer and the
     * shape most responsive top-bar controls take.
     *
     * Honest about its own novelty, the way `/budgets` was. This is NOT the
     * only detector on this route: `offers Upload receipt + New report when
     * canCreate, neither otherwise` and `adds a camera control before the
     * picker on a phone` both call `getByText('list.newReport')`, which throws
     * "found multiple elements" on a two-branch pair. What this case adds is
     * the reason, written down where it applies, so that a later edit to those
     * tests cannot quietly take the detector with it.
     */
    expect(
      published(),
      'the top bar accepts ONE control below `lg`. A `max-lg:hidden` / `lg:hidden` pair ' +
        'would put BOTH in the accessibility tree here, because jsdom applies no ' +
        'stylesheet, and a screen-reader user would meet the control twice — in a row that ' +
        'already publishes three controls at a coarse pointer.',
    ).toHaveLength(1);
  });

  it('hides the label below lg without taking it out of the accessible name', () => {
    /**
     * `max-lg:sr-only` rather than `sr-only lg:not-sr-only`, and rather than
     * `max-lg:hidden` — this is the assertion that pins the difference:
     *
     *   · `hidden` would remove the label from the accessibility tree too, and
     *     the control would become an unlabelled icon in both EN and FR-CA;
     *   · `not-sr-only` sets `white-space: normal`, which overrides the Button
     *     base's `whitespace-nowrap` and would let the DESKTOP label wrap where
     *     today it cannot.
     *
     * The name is asserted first and the mechanism second: `published()` already
     * found this button BY that name, which is the accessible name surviving at
     * every width. That name is load-bearing beyond this file —
     * `e2e/expense-lifecycle.spec.ts` and `e2e/tap-targets.mobile.spec.ts` both
     * match on "New report" — so a rename is a multi-file change.
     *
     * NEITHER `aria-label` NOR `title` EXISTS, and both are ASSERTED rather than
     * left to the comment. A second name competing with the label element is how
     * this control would come to read differently to a screen reader than it does
     * to a sighted desktop user; and a `title` would be that same second name plus
     * a tooltip no touch device can summon.
     */
    const [button] = published();
    const label = screen.getByText('list.newReport');
    expect(label).toHaveClass('max-lg:sr-only');
    expect(label.tagName, 'the label is its own element, so only IT is hidden').toBe('SPAN');
    expect(button).toContainElement(label);
    expect(
      button,
      'an aria-label would override the sr-only label as the accessible name',
    ).not.toHaveAttribute('aria-label');
    expect(
      button,
      'a title would compete with the sr-only label and tooltip on no touch device',
    ).not.toHaveAttribute('title');
  });

  it('becomes a square control carrying exactly one, vertical-only, slop class below lg', () => {
    /**
     * The cva `size="sm"` variant is `einc-tap-slop h-9 rounded-md px-3 text-xs`,
     * so below `lg` the unprefixed `h-9` is overridden, a matching width is
     * added and the horizontal padding comes off — a 32x32 box instead of a
     * 36px-tall labelled pill.
     *
     * THE `max-lg:` PREFIXES ARE PART OF THE CLAIM, not formatting. `Button`
     * forwards `className` into `cn`/`twMerge`, so an unprefixed `h-8 w-8 px-0`
     * would merge against the cva's `h-9 px-3` at every width and shrink the
     * control on DESKTOP too — with this suite green, because jsdom applies no
     * stylesheet and cannot tell a breakpoint-scoped class from a bare one.
     *
     * THE CLASS IS ON THE `Button` AND NEVER ON A WRAPPER. Hoisting it onto the
     * row's `<div>` would take the sizing outside both `canCreate` conditionals
     * and change what a reader without `canCreate` gets — today an absent
     * control, then an empty box the row still lays out and gaps. This class
     * assertion is the only thing in this suite that fails on that hoist: the
     * permission test above queries by TEXT, and the text is still absent.
     *
     * THE SLOP CLASS COMES FROM THE CVA AND NOTHING ADDS A SECOND ONE, which is
     * what the negative assertion is for. `cn`/`twMerge` has no conflict map for
     * these two — they are hand-written CSS in `globals.css`, not Tailwind
     * utilities — so an `einc-tap-slop-both` in `className` does not REPLACE the
     * cva's `einc-tap-slop`; both land and `-both` wins purely on stylesheet
     * source order. Vertical-only is also right on the merits here for a reason
     * this row owns: 6px of horizontal reach would land in the
     * `pointer-coarse:gap-3` seam the receipt chip's own 7px ring already
     * reaches 6px into, and `e2e/tap-targets.mobile.spec.ts` cannot report that
     * collision because the chip is not a census candidate.
     *
     * jsdom loads no stylesheet, so every assertion here is a CLASS-LIST claim
     * and not a geometry one. Unlike `/virtual-cards/requests` and `/budgets`,
     * this control IS measured: `e2e/tap-targets.mobile.spec.ts`'s `/expenses`
     * two-halves lane asserts it two-sided, and that lane was rewritten in the
     * same change. It is compiled by `npm run typecheck:e2e` and NOT run — this
     * machine has no Playwright browsers and `ci.yml` runs none — so 32 x 44 is
     * the geometry this code asks for, recorded in `docs/design/pwa.md` and not
     * yet confirmed by a render.
     */
    const [button] = published();
    expect(button).toHaveClass('max-lg:h-8', 'max-lg:w-8', 'max-lg:px-0');
    expect(button).toHaveClass('einc-tap-slop');
    expect(
      Array.from((button as HTMLElement).classList).filter((c) => c.startsWith('einc-tap-slop')),
      'the published control must carry exactly one slop class, and it must be the ' +
        'vertical-only `einc-tap-slop` from the `size="sm"` cva variant. Two of them on one ' +
        'element is not a merge — twMerge does not know they conflict — it is a hit region ' +
        'decided by the order the rules happen to appear in globals.css.',
    ).toEqual(['einc-tap-slop']);
    /**
     * The base's `gap-2` has nothing to space once the label is out of flow —
     * an `sr-only` label is `position: absolute` and so not a flex item — and
     * the 6px `mr-1.5` would push the glyph off-centre in a 32px box. Read off
     * the class LIST rather than through a CSS selector: a class containing a
     * colon needs escaping in a selector, and getting that wrong reads as the
     * class being absent.
     */
    const glyph = (button as HTMLElement).querySelector('svg');
    expect(glyph, 'the button lost its icon').not.toBeNull();
    expect(Array.from((glyph as SVGElement).classList)).toContain('max-lg:mr-0');
  });
});
