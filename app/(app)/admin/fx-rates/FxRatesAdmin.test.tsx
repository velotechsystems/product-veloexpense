import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTrpcMock, type TrpcMockConfig } from '@/test-utils/trpc';
import { FxRatesAdmin, RateHistoryDrawer } from './FxRatesAdmin';

/**
 * The page shows the current rate per pair; a pair's history is a drawer, not a
 * second tab over the same columns. What's worth pinning is that the tab is
 * gone, that a row opens its own pair's history, and that each entry states the
 * move from the one before it — the reason anyone opens this.
 */

const h = vi.hoisted(() => ({
  trpc: undefined as unknown,
  /** Whatever the page pushed into the app-shell top bar, so a test can click it. */
  slots: {} as Record<string, unknown>,
}));
vi.mock('@/lib/trpc/client', () => ({
  get trpc() {
    return h.trpc;
  },
}));
vi.mock('next-intl', () => ({
  useLocale: () => 'en',
  useTranslations: () => {
    const t = (key: string, values?: Record<string, unknown>) =>
      values ? `${key}:${Object.values(values).join(',')}` : key;
    // `useRefusalText` asks whether the catalog has a refusal's key before rendering it;
    // this catalog claims every key, so a refusal renders as its key + arguments.
    t.has = () => true;
    return t;
  },
}));
// Both specifiers, and each factory built inline — a `vi.mock` factory is hoisted above
// every top-level const, so it can close over the hoisted `h` but not over a local.
// VeloExpense: the shell lives at app/(app) (no [locale] segment).
vi.mock('@/app/(app)/TopBar', () => ({
  setTopBarSlot: (side: string, node: unknown) => {
    h.slots[side] = node;
  },
}));

const LATEST = [
  { base: 'USD', quote: 'CAD', rate: '1.3600', fetchedAt: '2026-07-20T00:00:00.000Z' },
  { base: 'EUR', quote: 'CAD', rate: '1.4700', fetchedAt: '2026-07-20T00:00:00.000Z' },
];

const HISTORY = [
  { base: 'USD', quote: 'CAD', rate: '1.3600', fetchedAt: '2026-07-20T00:00:00.000Z' },
  { base: 'USD', quote: 'CAD', rate: '1.3450', fetchedAt: '2026-06-20T00:00:00.000Z' },
  { base: 'USD', quote: 'CAD', rate: '1.3700', fetchedAt: '2026-05-20T00:00:00.000Z' },
];

function setTrpc(over: TrpcMockConfig = {}) {
  h.trpc = createTrpcMock({
    ...over,
    queries: {
      'policies.fxRate.latest': { data: LATEST },
      'policies.fxRate.history': { data: HISTORY },
      ...over.queries,
    },
  });
}

afterEach(() => {
  h.trpc = undefined;
  h.slots = {};
  vi.restoreAllMocks();
});

/**
 * Render the page, then mount whatever it put in the top bar — "Add rate" lives there.
 *
 * Two roots, deliberately: the button is a node the page handed to the app shell, and its
 * onClick closes over the page's state. Mounting it separately is what the shell does.
 */
function showWithTopBar(canManage = true) {
  render(<FxRatesAdmin canManage={canManage} />);
  const slot = h.slots.right as React.ReactNode;
  if (slot) render(slot);
}

describe('<FxRatesAdmin>', () => {
  it('shows the current rate per pair with no history tab to switch to', () => {
    setTrpc();
    render(<FxRatesAdmin canManage />);
    expect(screen.getByText('1.3600')).toBeInTheDocument();
    expect(screen.getByText('1.4700')).toBeInTheDocument();
    expect(screen.queryByText('viewHistory')).not.toBeInTheDocument();
    expect(screen.queryByText('viewLatest')).not.toBeInTheDocument();
  });

  it("opens the clicked pair's history in a drawer", async () => {
    const user = userEvent.setup();
    setTrpc();
    render(<FxRatesAdmin canManage />);
    await user.click(screen.getByText('USD'));
    // Title is interpolated with the pair that was clicked, not the other one.
    expect(await screen.findByText('historyTitle:USD,CAD')).toBeInTheDocument();
  });
});

describe('<RateHistoryDrawer>', () => {
  function renderDrawer() {
    setTrpc();
    return render(<RateHistoryDrawer pair={{ base: 'USD', quote: 'CAD' }} onClose={() => {}} />);
  }

  it('states the move from the previous entry, signed', () => {
    renderDrawer();
    // 1.3600 after 1.3450 is a rise; 1.3450 after 1.3700 is a fall.
    expect(screen.getByText('+0.0150')).toBeInTheDocument();
    expect(screen.getByText('-0.0250')).toBeInTheDocument();
  });

  it('leaves the oldest entry without a delta — there is nothing to compare it to', () => {
    renderDrawer();
    expect(screen.getAllByText(/^[+-]0\./)).toHaveLength(2);
  });

  it('marks the newest entry as the one in force', () => {
    renderDrawer();
    expect(screen.getByText('historyCurrent')).toBeInTheDocument();
  });

  it('says a pair has no earlier rates rather than showing an empty list', () => {
    h.trpc = createTrpcMock({ queries: { 'policies.fxRate.history': { data: [] } } });
    render(<RateHistoryDrawer pair={{ base: 'GBP', quote: 'CAD' }} onClose={() => {}} />);
    expect(screen.getByText('historyEmpty')).toBeInTheDocument();
  });
});

describe('<FxRatesAdmin> filtering', () => {
  it('matches the filter against either side of the pair', async () => {
    /**
     * "EUR" is a base on one row and never a quote; "CAD" is a quote on both. A filter
     * that only read `base` would find the first and miss the second — which reads as
     * missing data rather than as a half-implemented filter.
     */
    const user = userEvent.setup();
    setTrpc();
    render(<FxRatesAdmin canManage />);

    await user.click(screen.getByText(/(?:Add filter|filters\.addFilter)/));
    // The form opens on the first filterable column (base) with `contains`.
    await user.type(screen.getByPlaceholderText(/(?:Type a value…|filters\.typeAValue)/), 'CAD');
    await user.click(screen.getByRole('button', { name: /(?:^Add$|filters\.add$)/ }));

    // CAD is the QUOTE of both pairs and the base of neither.
    expect(screen.getByText('1.3600')).toBeInTheDocument();
    expect(screen.getByText('1.4700')).toBeInTheDocument();
  });

  it('drops the rows the filter does not match', async () => {
    const user = userEvent.setup();
    setTrpc();
    render(<FxRatesAdmin canManage />);
    await user.click(screen.getByText(/(?:Add filter|filters\.addFilter)/));
    await user.type(screen.getByPlaceholderText(/(?:Type a value…|filters\.typeAValue)/), 'EUR');
    await user.click(screen.getByRole('button', { name: /(?:^Add$|filters\.add$)/ }));
    expect(screen.getByText('1.4700')).toBeInTheDocument();
    expect(screen.queryByText('1.3600')).not.toBeInTheDocument();
  });

  it('says the list is empty rather than showing a bare table', () => {
    setTrpc({ queries: { 'policies.fxRate.latest': { data: [] } } });
    render(<FxRatesAdmin canManage />);
    expect(screen.getByText('emptyTitle')).toBeInTheDocument();
    expect(screen.getByText('emptyBody')).toBeInTheDocument();
  });
});

describe('<FxRatesAdmin> adding a rate', () => {
  it('offers no way to add for a reader who cannot manage rates', () => {
    /** Read is `config.policy.read`; adding is `config.fxRate.update`. Somebody with only
     *  the first must not be shown a control the server will refuse. */
    setTrpc();
    showWithTopBar(false);
    expect(screen.queryByText('add')).not.toBeInTheDocument();
  });

  it('refuses to save until both codes are three letters and the rate is numeric', async () => {
    /**
     * The pair is an ISO-4217 code on each side and the rate is a decimal. Posting "US"
     * or "1.3.6" fails server-side with a message about a schema, so the drawer holds the
     * line here where the fields are.
     */
    const user = userEvent.setup();
    const onCall = vi.fn();
    setTrpc({ mutations: { 'policies.fxRate.add': { onCall } } });
    showWithTopBar();
    await user.click(screen.getByText('add'));

    const save = screen.getByRole('button', { name: 'save' });
    expect(save).toBeDisabled();
    await user.type(screen.getByLabelText(/field\.base/), 'US');
    await user.type(screen.getByLabelText(/field\.quote/), 'CAD');
    await user.type(screen.getByLabelText(/field\.rate/), '1.36');
    // Two letters is not a currency.
    expect(save).toBeDisabled();
    await user.type(screen.getByLabelText(/field\.base/), 'D');
    expect(save).toBeEnabled();
    expect(onCall).not.toHaveBeenCalled();
  });

  it('upper-cases the codes as they are typed, and posts them trimmed', async () => {
    /** Nobody types "usd" meaning a different currency, and a lower-case code is a pair
     *  the append-only log would carry forever as its own row. */
    const user = userEvent.setup();
    const onCall = vi.fn();
    setTrpc({ mutations: { 'policies.fxRate.add': { onCall, outcome: 'success' } } });
    showWithTopBar();
    await user.click(screen.getByText('add'));
    await user.type(screen.getByLabelText(/field\.base/), 'usd');
    await user.type(screen.getByLabelText(/field\.quote/), 'cad');
    await user.type(screen.getByLabelText(/field\.rate/), '1.36');
    await user.click(screen.getByRole('button', { name: 'save' }));
    // Second argument is the per-call `{ onSuccess }` that closes the drawer.
    expect(onCall.mock.calls[0][0]).toEqual({ base: 'USD', quote: 'CAD', rate: '1.36' });
  });

  it('closes the drawer once the rate is in', async () => {
    // Left open, the same values invite a second click and the log gains a duplicate row.
    const user = userEvent.setup();
    setTrpc({ mutations: { 'policies.fxRate.add': { outcome: 'success' } } });
    showWithTopBar();
    await user.click(screen.getByText('add'));
    await user.type(screen.getByLabelText(/field\.base/), 'USD');
    await user.type(screen.getByLabelText(/field\.quote/), 'CAD');
    await user.type(screen.getByLabelText(/field\.rate/), '1.36');
    await user.click(screen.getByRole('button', { name: 'save' }));
    expect(screen.queryByText('addTitle')).not.toBeInTheDocument();
  });

  it("shows the server's refusal by the field, in the reader's language, and stays open", async () => {
    /**
     * `fxRate.add` refuses a zero and a `137` typed for `1.37` (#506). The drawer's own
     * check only knows "numeric", so the refusal arrives from the server — and it used to
     * arrive nowhere: no `onError`, the drawer sat there with the same values and nothing
     * to say. Now the sentence comes from the catalog key on the error, not from the
     * English message beside it, and the drawer stays open for the correction.
     */
    const user = userEvent.setup();
    setTrpc({
      mutations: {
        'policies.fxRate.add': {
          outcome: 'error',
          error: {
            message: 'Rate must be a positive number no greater than 1000000.',
            data: { refusal: { key: 'refusals.fx.rateOutOfBounds', params: { max: 1_000_000 } } },
          },
        },
      },
    });
    showWithTopBar();
    await user.click(screen.getByText('add'));
    await user.type(screen.getByLabelText(/field\.base/), 'USD');
    await user.type(screen.getByLabelText(/field\.quote/), 'CAD');
    await user.type(screen.getByLabelText(/field\.rate/), '0');
    await user.click(screen.getByRole('button', { name: 'save' }));

    expect(screen.getByRole('alert')).toHaveTextContent('refusals.fx.rateOutOfBounds:1000000');
    expect(screen.queryByText(/positive number no greater/)).not.toBeInTheDocument();
    expect(screen.getByText('addTitle')).toBeInTheDocument();
  });

  it('says it is saving, and will not take a second click', async () => {
    const user = userEvent.setup();
    setTrpc({ mutations: { 'policies.fxRate.add': { isPending: true } } });
    showWithTopBar();
    await user.click(screen.getByText('add'));
    await user.type(screen.getByLabelText(/field\.base/), 'USD');
    await user.type(screen.getByLabelText(/field\.quote/), 'CAD');
    await user.type(screen.getByLabelText(/field\.rate/), '1.36');
    expect(screen.getByRole('button', { name: 'saving' })).toBeDisabled();
  });
});

describe('<FxRatesAdmin> a rate the server refused', () => {
  /**
   * The server bounds a new rate against the pair's last row and refuses one that sits
   * too far from it (PRECONDITION_FAILED). What the drawer owes the person is the
   * refusal itself — it names both rates and the bound — and a way through it: a reason,
   * posted with the same values and an explicit flag, is how a wrong earlier row gets
   * corrected on the record instead of blocking its own fix.
   */
  const refusal = {
    message:
      'USD→CAD was last recorded at 1.36 on 2026-09-14. 2.00 is 47.1% away from that — ' +
      'more than the 25% a rate may move without a reason.',
    data: { code: 'PRECONDITION_FAILED' },
  };

  async function openAndFill(user: ReturnType<typeof userEvent.setup>, rate = '2.00') {
    showWithTopBar();
    await user.click(screen.getByText('add'));
    await user.type(screen.getByLabelText(/field\.base/), 'USD');
    await user.type(screen.getByLabelText(/field\.quote/), 'CAD');
    await user.type(screen.getByLabelText(/field\.rate/), rate);
  }

  it("shows the server's refusal verbatim and asks for a reason", async () => {
    const user = userEvent.setup();
    setTrpc({ mutations: { 'policies.fxRate.add': { error: refusal } } });
    await openAndFill(user);
    expect(screen.getByText(refusal.message)).toBeInTheDocument();
    expect(screen.getByText('deviationExplainer')).toBeInTheDocument();
    expect(screen.getByLabelText(/field\.reason/)).toBeInTheDocument();
    // The ordinary save is gone; what is offered is the override, and it is not yet armed.
    expect(screen.queryByRole('button', { name: 'save' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'confirmSave' })).toBeDisabled();
  });

  it('arms the override only once the reason is long enough to mean something', async () => {
    /** The server wants ten characters; the button says so before the round-trip. */
    const user = userEvent.setup();
    const onCall = vi.fn();
    setTrpc({ mutations: { 'policies.fxRate.add': { error: refusal, onCall } } });
    await openAndFill(user);
    const confirm = screen.getByRole('button', { name: 'confirmSave' });
    await user.type(screen.getByLabelText(/field\.reason/), 'inverted');
    expect(confirm).toBeDisabled();
    await user.type(screen.getByLabelText(/field\.reason/), ' quote fixed');
    expect(confirm).toBeEnabled();
    await user.click(confirm);
    // Same values, plus the explicit flag and the reason — never the flag alone.
    expect(onCall.mock.calls[0][0]).toEqual({
      base: 'USD',
      quote: 'CAD',
      rate: '2.00',
      confirmDeviation: true,
      reason: 'inverted quote fixed',
    });
  });

  it("says the deviation refusal in the reader's language, and still offers the override", async () => {
    /**
     * #510 gave this refusal its sentence; #513 gave it a catalog key. The drawer shows
     * the key's sentence — the English `message` is the log's and the fallback — while
     * the reason field and "Add anyway" stay exactly where the PRECONDITION_FAILED code
     * puts them. The two are independent: the code decides the affordance, the key
     * decides the words.
     */
    const user = userEvent.setup();
    setTrpc({
      mutations: {
        'policies.fxRate.add': {
          error: {
            ...refusal,
            data: {
              code: 'PRECONDITION_FAILED',
              refusal: {
                key: 'refusals.fx.rateFarFromPrior',
                params: {
                  base: 'USD',
                  quote: 'CAD',
                  prior: '1.36',
                  on: '2026-09-14',
                  rate: '2.00',
                  deviation: '47.1',
                  bound: 25,
                },
              },
            },
          },
        },
      },
    });
    await openAndFill(user);
    expect(screen.getByRole('alert')).toHaveTextContent(
      'refusals.fx.rateFarFromPrior:USD,CAD,1.36,2026-09-14,2.00,47.1,25',
    );
    expect(screen.queryByText(refusal.message)).not.toBeInTheDocument();
    // The correction path #510 built is untouched by the translation.
    expect(screen.getByLabelText(/field\.reason/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'confirmSave' })).toBeInTheDocument();
  });

  it('offers no override for a failure that is not the deviation bound', async () => {
    /** A permission error names nothing a reason could fix; showing the reason field
     *  there would invite people to type one and be refused again. */
    const user = userEvent.setup();
    const forbidden = {
      message: 'You do not have permission to do that.',
      data: { code: 'FORBIDDEN' },
    };
    setTrpc({ mutations: { 'policies.fxRate.add': { error: forbidden } } });
    await openAndFill(user, '1.37');
    expect(screen.getByText('You do not have permission to do that.')).toBeInTheDocument();
    expect(screen.queryByLabelText(/field\.reason/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'save' })).toBeInTheDocument();
  });

  it('drops the refusal as soon as the pair or rate is changed', async () => {
    /** The refusal was of THAT rate against THAT pair. Left standing while the person
     *  retypes, it would offer the override for a rate the server never refused. */
    const user = userEvent.setup();
    const onReset = vi.fn();
    setTrpc({ mutations: { 'policies.fxRate.add': { error: refusal, onReset } } });
    await openAndFill(user);
    onReset.mockClear();
    await user.type(screen.getByLabelText(/field\.rate/), '1');
    expect(onReset).toHaveBeenCalled();
    // Typing the reason itself is not a change of what was refused.
    onReset.mockClear();
    await user.type(screen.getByLabelText(/field\.reason/), 'x');
    expect(onReset).not.toHaveBeenCalled();
  });

  it('clears the failure when the drawer is closed', async () => {
    // Reopened for a different pair, a stale refusal must not greet the person.
    const user = userEvent.setup();
    const onReset = vi.fn();
    setTrpc({ mutations: { 'policies.fxRate.add': { error: refusal, onReset } } });
    showWithTopBar();
    await user.click(screen.getByText('add'));
    await user.click(screen.getByRole('button', { name: 'cancel' }));
    expect(onReset).toHaveBeenCalled();
    expect(screen.queryByText('addTitle')).not.toBeInTheDocument();
  });
});

describe('<RateHistoryDrawer> unchanged rates', () => {
  it('shows no delta for a rate that did not move', () => {
    /** "+0.0000" reads as a change that rounded away; nothing at all reads as no change,
     *  which is what it is. */
    h.trpc = createTrpcMock({
      queries: {
        'policies.fxRate.history': {
          data: [
            { base: 'USD', quote: 'CAD', rate: '1.3600', fetchedAt: '2026-07-20T00:00:00.000Z' },
            { base: 'USD', quote: 'CAD', rate: '1.3600', fetchedAt: '2026-06-20T00:00:00.000Z' },
          ],
        },
      },
    });
    render(<RateHistoryDrawer pair={{ base: 'USD', quote: 'CAD' }} onClose={() => {}} />);
    expect(screen.queryByText(/^[+-]?0\.0000$/)).not.toBeInTheDocument();
  });
});
