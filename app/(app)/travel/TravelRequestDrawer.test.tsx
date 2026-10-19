import { DEFAULT_LOCALE } from '@/lib/i18n/locales';
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTrpcMock, type TrpcMockConfig } from '@/test-utils/trpc';

/**
 * One travel request, opened.
 *
 * The budget table is the substance, and the point of it is that **every line states its
 * BASIS**. A flight priced from a live quote and a car priced from a policy ceiling are
 * both "budget" and are not equally trustworthy — an approver deciding on a total is
 * entitled to know which parts are market prices and which are maximums. A budget that
 * hides its own provenance is how a bad trip gets waved through on a plausible number.
 *
 * The rest is about who may do what, and when:
 *
 *   · **Only a DRAFT or RETURNED request is editable**, so repricing and submitting are
 *     absent on anything that has left the traveller's hands.
 *   · **Submitting no longer needs a budget.** It used to: the button was disabled until
 *     the request had lines, which turned "we cannot price this destination" into "you
 *     may not ask". The panel warns instead, and the press still works — an approver is
 *     the person entitled to decide whether an unpriced trip is acceptable.
 *   · **Anything a provider cannot price goes in as a PLANNED item** against an expense
 *     category — a conference fee, a department dinner, a rental car (nothing on the
 *     market quotes those). Removal is offered on those lines and on no others.
 *   · **Variance appears only once there is something to compare against**; before
 *     approval the budget IS the answer and a panel of zeroes just takes up room.
 *   · **Deciding needs a task.** Without one the approve and reject buttons would be
 *     offered on somebody else's request.
 */

const h = vi.hoisted(() => ({ trpc: undefined as unknown, pushed: [] as string[] }));

vi.mock('next-intl', () => ({
  // VeloExpense (w6-02): the registry's default (en-CA), not a literal (check:i18n).
  useLocale: () => DEFAULT_LOCALE,
  useTranslations: (ns?: string) => {
    const t = (k: string, v?: Record<string, unknown>) => {
      const full = ns ? `${ns}.${k}` : k;
      return v ? `${full}:${Object.values(v).join(',')}` : full;
    };
    t.has = () => false;
    return t;
  },
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: (p: string) => h.pushed.push(p) }),
}));
vi.mock('@/lib/trpc/client', () => ({
  get trpc() {
    return h.trpc;
  },
}));
vi.mock('@/components/comments/CommentThread', () => ({
  CommentThread: ({ subjectId }: { subjectId: string }) => (
    <div data-testid="comments" data-subject={subjectId} />
  ),
}));
/** Select becomes plain buttons; Base UI's popup has its own suite. Same mock the
 *  new-request drawer's tests use, for the same reason. */
vi.mock('@expenseos/design-system', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@expenseos/design-system')>();
  const React = await import('react');
  const Ctx = React.createContext<{ value: string; onValueChange: (v: string) => void }>({
    value: '',
    onValueChange: () => undefined,
  });
  return {
    ...actual,
    Select: ({
      value,
      onValueChange,
      children,
    }: {
      value: string;
      onValueChange: (v: string) => void;
      children: ReactNode;
    }) => (
      <Ctx.Provider value={{ value, onValueChange }}>
        <div data-testid="select" data-value={value}>
          {children}
        </div>
      </Ctx.Provider>
    ),
    SelectTrigger: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    /**
     * A RENDER CHILD is the shape the app actually uses.
     *
     * base-ui's `Select.Value` shows the raw value when given no child, and every value
     * in this drawer is a UUID — so each Select passes `{() => label}`. The mock has to
     * honour that or the field renders nothing and a test about picking a category is
     * really a test about the mock. `ReactNode` alone does not admit a function, hence
     * the union.
     */
    SelectValue: ({ children }: { children?: ReactNode | (() => ReactNode) }) => {
      const { value } = React.useContext(Ctx);
      return <span>{typeof children === 'function' ? children() : (children ?? value)}</span>;
    },
    SelectContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    SelectItem: ({ value, children }: { value: string; children: ReactNode }) => {
      const { onValueChange } = React.useContext(Ctx);
      return (
        <button type="button" data-option={value} onClick={() => onValueChange(value)}>
          {children}
        </button>
      );
    },
  };
});

import { TravelRequestDrawer } from './TravelRequestDrawer';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const line = (over: Record<string, unknown> = {}) => ({
  id: 'bl-1',
  categoryId: 'c-air',
  category: { id: 'c-air', label: { en: 'Airfare' }, icon: '✈️' },
  kind: 'AIRFARE',
  basis: 'QUOTE',
  confidence: 'HIGH',
  /**
   * The route and the flight number, as DATA.
   *
   * The line used to carry `notes: 'YYZ → SFO, 1 stop'` — a sentence the server had
   * composed. `detail` is the traveller's own words now, so what a reader is shown about
   * the figure comes from here and is composed in their locale at render.
   */
  payload: {
    fromLabel: 'YYZ',
    toLabel: 'SFO',
    travelClass: 'ECONOMY',
    legs: [{ from: 'YYZ', to: 'SFO', flightNumber: 'AC 795' }],
  },
  /** What the traveller wrote. Null unless a case is about it. */
  notes: null,
  amountMinor: '85000',
  ...over,
});

const request = (over: Record<string, unknown> = {}) =>
  ({
    id: 'tr-1',
    number: 'TRV-000042',
    status: 'DRAFT',
    purpose: 'Client kickoff',
    tripType: 'ROUND_TRIP',
    destinationLabel: 'San Francisco, CA, USA',
    originLabel: 'Toronto, ON, Canada',
    departDate: '2026-09-01T00:00:00.000Z',
    returnDate: '2026-09-05T00:00:00.000Z',
    currency: { code: 'CAD', symbol: '$' },
    includeCar: false,
    approvedTotalMinor: null,
    submitter: { firstName: 'Dana', lastName: 'Patel', email: 'dana@e.inc' },
    budgetLines: [line()],
    policyViolations: [],
    ...over,
  }) as never;

/** A policy violation on the airfare line above. */
const violation = (over: Record<string, unknown> = {}) => ({
  id: 'v-1',
  travelLineId: 'bl-1',
  ruleCode: 'rule-cabin',
  severity: 'BLOCK',
  message: 'travelCabinClass',
  data: { cabin: 'BUSINESS' },
  resolveNote: null,
  resolvedAt: null,
  ...over,
});

/**
 * Two seeded buckets, one of which is the rental car.
 *
 * `carCode` comes from the SERVER rather than being spelled again here, because the
 * drawer has to recognise that bucket to say a car nobody can quote still has to be
 * planned by hand — and two copies of the string drift apart on a seed rename.
 */
const PLANNED_CATEGORIES = {
  items: [
    { id: 'c-meals', code: 'travelMeals', label: { en: 'Meals' }, icon: null },
    { id: 'c-car', code: 'travelCarRental', label: { en: 'Rental car' }, icon: null },
  ],
  carCode: 'travelCarRental',
};

/** What `previewLine` answers when the policy has nothing to say about a line. */
const NO_DERIVATION = {
  derivedAmountMinor: null,
  basis: null,
  days: 0,
  dailyRateMinor: null,
  edgeDaysHalved: false,
  city: null,
};
/** A 4-day per-diem at $80.00 a day for the meals category. */
const MEALS_DERIVATION = {
  derivedAmountMinor: '32000',
  basis: 'PER_DIEM',
  days: 4,
  dailyRateMinor: '8000',
  edgeDaysHalved: false,
  city: 'San Francisco',
};

function setTrpc(over: TrpcMockConfig = {}) {
  h.trpc = createTrpcMock({
    ...over,
    queries: {
      'travelRequests.timeline': {
        data: { tasks: [] },
        ...over.queries?.['travelRequests.timeline'],
      },
      // Nothing derivable by default, so a typed figure on a draft row files at once —
      // which is what every case not ABOUT the override needs.
      'travelRequests.previewLine': { data: NO_DERIVATION },
      'travelRequests.variance': { data: undefined, ...over.queries?.['travelRequests.variance'] },
      'travelRequests.categories': {
        data: PLANNED_CATEGORIES,
        ...over.queries?.['travelRequests.categories'],
      },
      ...over.queries,
    },
  });
}

const onClose = vi.fn();
const onChanged = vi.fn();

const show = (props: Record<string, unknown> = {}) =>
  render(
    <TravelRequestDrawer request={request()} onClose={onClose} onChanged={onChanged} {...props} />,
  );

const btn = (key: string) => screen.getByRole('button', { name: `travel.detail.${key}` });
const noBtn = (key: string) =>
  expect(screen.queryByRole('button', { name: `travel.detail.${key}` })).not.toBeInTheDocument();

beforeEach(() => {
  h.pushed = [];
  onClose.mockReset();
  onChanged.mockReset();
});
afterEach(() => {
  h.trpc = undefined;
  vi.restoreAllMocks();
});

// ── What it shows ─────────────────────────────────────────────────────────────

describe('the request', () => {
  it('heads with the number and where the trip goes', () => {
    setTrpc();
    show();
    expect(screen.getByText('TRV-000042 · San Francisco, CA, USA')).toBeInTheDocument();
  });

  it('reads out the traveller, the status, the trip type and the dates', () => {
    setTrpc();
    show();
    expect(screen.getByText('Dana Patel')).toBeInTheDocument();
    expect(screen.getByText('travel.status.DRAFT')).toBeInTheDocument();
    expect(screen.getByText('travel.tripType.ROUND_TRIP')).toBeInTheDocument();
    expect(screen.getByText(/2026-09-01 – 2026-09-05/)).toBeInTheDocument();
  });

  it('formats the dates in UTC, because a trip is a range of calendar dates', () => {
    // Locally, a midnight-UTC departure reads as the previous day west of Greenwich.
    setTrpc();
    show();
    expect(screen.queryByText(/2026-08-31/)).not.toBeInTheDocument();
  });

  it('dashes a one-way trip’s missing return', () => {
    setTrpc();
    show({ request: request({ tripType: 'ONE_WAY', returnDate: null }) });
    expect(screen.getByText(/2026-09-01 – —/)).toBeInTheDocument();
  });

  it('names the origin only when there is one', () => {
    setTrpc();
    const view = show({ request: request({ originLabel: null }) });
    expect(screen.queryByText('travel.form.origin')).not.toBeInTheDocument();
    view.unmount();

    show();
    expect(screen.getByText('travel.form.origin')).toBeInTheDocument();
  });

  it('shows the approved total only once there is one', () => {
    /**
     * Before a decision the budget is the only figure; showing an "approved total" of
     * nothing would imply a decision that has not happened.
     */
    setTrpc();
    const view = show();
    expect(screen.queryByText('travel.detail.approvedTotal')).not.toBeInTheDocument();
    view.unmount();

    show({ request: request({ status: 'APPROVED', approvedTotalMinor: '90000' }) });
    expect(screen.getByText('travel.detail.approvedTotal')).toBeInTheDocument();
    expect(screen.getByText('$900.00')).toBeInTheDocument();
  });

  it('carries the discussion, addressed to this request', () => {
    setTrpc();
    show();
    expect(screen.getByTestId('comments')).toHaveAttribute('data-subject', 'tr-1');
  });
});

// ── The budget ────────────────────────────────────────────────────────────────

describe('the budget table', () => {
  it('states the BASIS of every line', () => {
    /**
     * A quoted flight and a policy-capped car are both "budget" and are not equally
     * trustworthy. This is the whole reason the table exists rather than a total.
     */
    setTrpc();
    show({
      request: request({
        budgetLines: [
          line(),
          line({
            id: 'bl-2',
            basis: 'POLICY_CAP',
            category: { id: 'c-car', label: { en: 'Car' }, icon: null },
          }),
          line({
            id: 'bl-3',
            basis: 'PER_DIEM',
            category: { id: 'c-meals', label: { en: 'Meals' }, icon: null },
          }),
        ],
      }),
    });
    expect(screen.getByText('travel.basis.QUOTE')).toBeInTheDocument();
    expect(screen.getByText('travel.basis.POLICY_CAP')).toBeInTheDocument();
    expect(screen.getByText('travel.basis.PER_DIEM')).toBeInTheDocument();
  });

  it('tones a quote apart from a ceiling', () => {
    // Same shape, different trust — the colour is what says so at a glance.
    setTrpc();
    show({
      request: request({
        budgetLines: [line(), line({ id: 'bl-2', basis: 'POLICY_CAP' })],
      }),
    });
    expect(screen.getByText('travel.basis.QUOTE').className).not.toEqual(
      screen.getByText('travel.basis.POLICY_CAP').className,
    );
  });

  it('says how confident a priced line is, but not when it does not know', () => {
    setTrpc();
    show({
      request: request({
        budgetLines: [line(), line({ id: 'bl-2', confidence: 'UNKNOWN' })],
      }),
    });
    expect(screen.getByText('travel.confidence.HIGH')).toBeInTheDocument();
    expect(screen.queryByText('travel.confidence.UNKNOWN')).not.toBeInTheDocument();
  });

  it('shows what a line was priced from, composed from the payload', () => {
    /**
     * "Airfare $850" is a number; "YYZ→SFO · AC 795" is a number somebody can check
     * against a boarding pass.
     *
     * Composed here rather than read out of a stored string: `detail` is the traveller's
     * field now, so the route and the flight number are rendered from the payload — which
     * also means an approver reading in FR-CA gets it in FR-CA.
     */
    setTrpc();
    show();
    expect(screen.getByText(/YYZ → SFO/)).toBeInTheDocument();
    expect(screen.getByText(/AC 795/)).toBeInTheDocument();
  });

  it('shows the traveller’s own words in an editable field, not as a caption', () => {
    setTrpc();
    show({ request: request({ budgetLines: [line({ notes: 'Only nonstop that morning' })] }) });
    // Two fields carry this label — the add form's and the line's — so the LINE's is the
    // one holding a value; the add form's starts empty.
    const fields = screen.getAllByLabelText('travel.line.notes') as HTMLInputElement[];
    expect(fields.map((f) => f.value)).toContain('Only nonstop that morning');
  });

  it('shows the detail as read-only text once the request is no longer editable', () => {
    setTrpc();
    show({
      request: request({
        status: 'SUBMITTED',
        budgetLines: [line({ notes: 'Only nonstop that morning' })],
      }),
    });
    expect(screen.getByText('Only nonstop that morning')).toBeInTheDocument();
    // No editable field anywhere: the add form is gone with the rest of the editing UI.
    expect(screen.queryAllByLabelText('travel.line.notes')).toHaveLength(0);
  });

  it('totals the lines in BigInt, so a long trip does not lose precision', () => {
    setTrpc();
    show({
      request: request({
        budgetLines: [line({ amountMinor: '85000' }), line({ id: 'bl-2', amountMinor: '42550' })],
      }),
    });
    expect(screen.getByText('$1,275.50')).toBeInTheDocument();
  });

  it('says there is no budget yet', () => {
    setTrpc();
    show({ request: request({ budgetLines: [] }) });
    expect(screen.getByText('travel.detail.noBudget')).toBeInTheDocument();
  });
});

// ── Pricing ───────────────────────────────────────────────────────────────────

/**
 * The bulk "Get live prices" button is GONE, and this block went with it.
 *
 * It searched flights and lodging and auto-took the CHEAPEST of each — the one thing a
 * per-line picker exists to stop — and a traveller who pressed both it and a picker got two
 * airfare lines. Everything it was tested for now lives in the pickers and is asserted
 * there: that a search is a button and never an effect, that it names the cost before the
 * press, and that "nothing found" is four different sentences rather than an empty list
 * (see "the flight picker" below and `_lines/OptionPicker.tsx`).
 */

// ── Submitting and withdrawing ────────────────────────────────────────────────

describe('submitting', () => {
  it('submits a trip nothing could price, and WARNS rather than refusing', async () => {
    /**
     * Deliberately inverted. This used to assert the button was DISABLED with no budget
     * lines, which is the rule this change removes.
     *
     * The old gate had a good intention and the wrong remedy. An empty budget is worth
     * saying something about — the approver would be shown a total of zero — but the
     * cause is usually a destination no per-diem rate matches and no route can be quoted
     * for, which is nothing the traveller can fix. Disabling their only way forward left
     * them with no move except to invent a different destination, and no sentence
     * explaining why.
     *
     * So: the warning appears, AND the press lands.
     */
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc({ mutations: { 'travelRequests.submit': { onCall, outcome: 'success' } } });
    show({ request: request({ budgetLines: [] }) });

    expect(screen.getByText('travel.detail.warnNoBudget')).toBeInTheDocument();
    expect(btn('submit')).toBeEnabled();
    await user.click(btn('submit'));
    expect(onCall).toHaveBeenCalledWith({ id: 'tr-1' });
  });

  it('says nothing about the budget once the trip has been priced', () => {
    // A warning that is always on is a warning nobody reads.
    setTrpc();
    show();
    expect(screen.queryByText('travel.detail.warnNoBudget')).not.toBeInTheDocument();
  });

  it('submits, then closes', async () => {
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc({ mutations: { 'travelRequests.submit': { onCall, outcome: 'success' } } });
    show();
    await user.click(btn('submit'));
    expect(onCall).toHaveBeenCalledWith({ id: 'tr-1' });
    expect(onClose).toHaveBeenCalled();
  });

  it('withdraws a request the traveller no longer wants', async () => {
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc({ mutations: { 'travelRequests.cancel': { onCall, outcome: 'success' } } });
    show();
    await user.click(btn('withdraw'));
    expect(onCall).toHaveBeenCalledWith({ id: 'tr-1' });
    expect(onClose).toHaveBeenCalled();
  });

  it('offers neither on a request that has left the traveller’s hands', () => {
    setTrpc();
    show({ request: request({ status: 'APPROVED' }) });
    noBtn('submit');
    noBtn('withdraw');
  });
});

// ── After approval ────────────────────────────────────────────────────────────

describe('once approved', () => {
  it('offers to turn the trip into an expense report', () => {
    setTrpc();
    show({ request: request({ status: 'APPROVED' }) });
    expect(btn('buildReport')).toBeInTheDocument();
  });

  it('takes the traveller straight into the report it created', async () => {
    /**
     * Creating one and leaving them on the travel page is a step they then have to
     * retrace.
     */
    const user = userEvent.setup();
    setTrpc({
      mutations: {
        'travelRequests.buildReport': { outcome: 'success', data: { reportId: 'rep-9' } },
      },
    });
    show({ request: request({ status: 'APPROVED' }) });
    await user.click(btn('buildReport'));
    expect(h.pushed).toEqual(['/en-CA/expenses/rep-9']);
  });

  it('offers no report builder before approval', () => {
    setTrpc();
    show();
    noBtn('buildReport');
  });

  it('asks for the variance only once there is something to compare against', () => {
    /**
     * Before approval the budget IS the answer, and a variance panel of zeroes just
     * takes up room.
     */
    const onCall = vi.fn();
    setTrpc({ queries: { 'travelRequests.variance': { data: undefined, onCall } } });
    show();
    expect(onCall.mock.calls[0]?.[1]).toMatchObject({ enabled: false });
  });

  it('compares budget with actuals, marking an overrun', () => {
    /**
     * An overrun is money nobody authorised, so it reads as a problem; coming in under
     * is not news.
     */
    setTrpc({
      queries: {
        'travelRequests.variance': {
          data: {
            hasActuals: true,
            rows: [
              {
                categoryId: 'c-air',
                category: { label: { en: 'Airfare' }, icon: '✈️' },
                budgetedMinor: '85000',
                actualMinor: '92000',
                varianceMinor: '7000',
              },
              {
                categoryId: 'c-meals',
                category: null,
                budgetedMinor: '20000',
                actualMinor: '15000',
                varianceMinor: '-5000',
              },
            ],
          },
        },
      },
    });
    show({ request: request({ status: 'APPROVED' }) });
    // The variance is the LAST cell of each row; $150 also appears as an actual.
    const rows = screen.getAllByRole('row').filter((r) => r.querySelectorAll('td').length === 4);
    const varianceOf = (i: number) => rows[i].querySelectorAll('td')[3] as HTMLElement;
    expect(varianceOf(0).textContent).toContain('70.00');
    expect(varianceOf(0).className).toContain('text-destructive');
    expect(varianceOf(1).className).not.toContain('text-destructive');
  });

  it('names a category that no longer resolves by its id, rather than blank', () => {
    setTrpc({
      queries: {
        'travelRequests.variance': {
          data: {
            hasActuals: true,
            rows: [
              {
                categoryId: 'c-gone',
                category: null,
                budgetedMinor: '1000',
                actualMinor: '1000',
                varianceMinor: '0',
              },
            ],
          },
        },
      },
    });
    show({ request: request({ status: 'APPROVED' }) });
    expect(screen.getByText('c-gone')).toBeInTheDocument();
  });

  it('says the trip has no actuals yet', () => {
    setTrpc({
      queries: {
        'travelRequests.variance': {
          data: {
            hasActuals: false,
            rows: [
              {
                categoryId: 'c-air',
                category: null,
                budgetedMinor: '1',
                actualMinor: '0',
                varianceMinor: '-1',
              },
            ],
          },
        },
      },
    });
    show({ request: request({ status: 'APPROVED' }) });
    expect(screen.getByText('travel.detail.varianceNone')).toBeInTheDocument();
  });
});

// ── The approval timeline and deciding ────────────────────────────────────────

describe('deciding', () => {
  it('shows where the request is, and who has had it', () => {
    setTrpc({
      queries: {
        'travelRequests.timeline': {
          data: {
            tasks: [
              {
                id: 'task-1',
                label: 'Manager approval',
                status: 'APPROVED',
                decidedBy: { firstName: 'Sam', lastName: 'Ito', email: 's@e.inc' },
              },
              { id: 'task-2', label: 'Finance', status: 'PENDING', decidedBy: null },
            ],
          },
        },
      },
    });
    show();
    expect(screen.getByText('Manager approval')).toBeInTheDocument();
    // Statuses now come from the catalogue. This test asserted the raw enums —
    // `Sam Ito · APPROVED` — which is the defect V2-09/V2-23 reported, so it is
    // inverted rather than deleted: the record of what changed lives here.
    expect(screen.getByText(/Sam Ito · travel\.taskStatus\.APPROVED/)).toBeInTheDocument();
    expect(screen.getByText(/— · travel\.taskStatus\.PENDING/)).toBeInTheDocument();
  });

  it('never shows a raw workflow node key or status enum', () => {
    /**
     * GA audit v2, V2-09 and V2-23. The Approvals section of a submitted request read, in
     * full:
     *
     *     approval                              — · PENDING
     *
     * Two server tokens and nothing else. `approval` is the workflow NODE KEY — the
     * seeded graphs give their approval nodes no label, so the raw type reached the
     * screen. `PENDING` is the `ApprovalTaskStatus` enum.
     *
     * Neither is in the message catalogue, which is the part that makes this more than
     * untidy: in /fr-CA the section heading translates to "Approbations" and these two
     * stay in English, so a translation review passes while a French user still reads
     * server vocabulary.
     */
    setTrpc({
      queries: {
        'travelRequests.timeline': {
          data: {
            tasks: [{ id: 'task-1', label: 'approval', status: 'PENDING', decidedBy: null }],
          },
        },
      },
    });
    show();
    // The mocked translator returns the KEY, so a translated string is proof it went
    // through the catalogue — and the raw tokens must be gone.
    // Exact text, not a regex: the catalogue KEY contains the enum name, so
    // /PENDING/ would match `travel.taskStatus.PENDING` and prove nothing.
    expect(screen.queryByText('approval')).not.toBeInTheDocument();
    expect(screen.queryByText('PENDING')).not.toBeInTheDocument();
    expect(screen.getByText('travel.nodeLabel.approval')).toBeInTheDocument();
    expect(screen.getByText(/travel\.taskStatus\.PENDING/)).toBeInTheDocument();
  });

  it('keeps a label somebody actually wrote', () => {
    // The rule is "a bare node key is not a label", not "replace every label".
    setTrpc({
      queries: {
        'travelRequests.timeline': {
          data: {
            tasks: [
              { id: 'task-1', label: 'Manager approval', status: 'APPROVED', decidedBy: null },
            ],
          },
        },
      },
    });
    show();
    expect(screen.getByText('Manager approval')).toBeInTheDocument();
  });

  it('says so when nothing has been routed yet', () => {
    setTrpc();
    show();
    expect(screen.getByText('travel.detail.noTimeline')).toBeInTheDocument();
  });

  it('offers no decision without a task on the request', () => {
    /**
     * The drawer is shared: an approver reading somebody else's request must not be
     * offered a decision the server would refuse.
     */
    setTrpc();
    show();
    noBtn('approve');
    noBtn('reject');
    expect(screen.queryByLabelText('travel.detail.note')).not.toBeInTheDocument();
  });

  it('approves with an optional note', async () => {
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc({ mutations: { 'travelRequests.decide': { onCall, outcome: 'success' } } });
    show({ taskId: 'task-1', request: request({ status: 'SUBMITTED' }) });
    await user.click(btn('approve'));
    expect(onCall).toHaveBeenCalledWith({ taskId: 'task-1', approve: true, note: undefined });
    expect(onClose).toHaveBeenCalled();
  });

  it('rejects with a trimmed note', async () => {
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc({ mutations: { 'travelRequests.decide': { onCall, outcome: 'success' } } });
    show({ taskId: 'task-1', request: request({ status: 'SUBMITTED' }) });
    await user.type(screen.getByLabelText('travel.detail.note'), '  Too expensive  ');
    await user.click(btn('reject'));
    expect(onCall).toHaveBeenCalledWith({
      taskId: 'task-1',
      approve: false,
      note: 'Too expensive',
    });
  });

  it('holds both decisions while one is in flight', () => {
    setTrpc({ mutations: { 'travelRequests.decide': { isPending: true } } });
    show({ taskId: 'task-1', request: request({ status: 'SUBMITTED' }) });
    expect(btn('approve')).toBeDisabled();
    expect(btn('reject')).toBeDisabled();
  });

  it('reports a refused decision', async () => {
    const user = userEvent.setup();
    setTrpc({
      mutations: {
        'travelRequests.decide': {
          outcome: 'error',
          error: { message: 'That task was already decided' },
        },
      },
    });
    show({ taskId: 'task-1', request: request({ status: 'SUBMITTED' }) });
    await user.click(btn('approve'));
    expect(await screen.findByText('That task was already decided')).toBeInTheDocument();
  });

  it('closes on the footer without deciding', async () => {
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc({ mutations: { 'travelRequests.decide': { onCall } } });
    show({ taskId: 'task-1' });
    await user.click(btn('close'));
    expect(onClose).toHaveBeenCalled();
    expect(onCall).not.toHaveBeenCalled();
  });
});

// ── Planned items ─────────────────────────────────────────────────────────────

describe('planning what nobody can price', () => {
  const catOption = (id: string) => document.querySelector(`[data-option="${id}"]`) as HTMLElement;
  const amount = () => screen.getByLabelText('travel.detail.plannedAmount');
  /**
   * The LAST notes box on screen.
   *
   * The draft row and every line block share the `line.notes` label — deliberately,
   * because it is the same field for the same purpose — and drafts render after the saved
   * lines, so the last one is the row being added.
   */
  const detailField = () =>
    screen.getAllByLabelText('travel.line.notes').at(-1) as HTMLInputElement;
  /** Open a row. There is no save button: picking the category is the save. */
  const openDraft = (user: ReturnType<typeof userEvent.setup>) =>
    user.click(screen.getByRole('button', { name: 'travel.detail.plannedAddItem' }));

  /**
   * One change event per field, rather than `user.type`.
   *
   * These are CONTROLLED inputs, and `user.type` sends a keystroke at a time. React 19
   * flushes those on its own schedule, so under load a second keystroke can arrive
   * against a DOM value React has already reset from state that had not landed yet —
   * "40" ends up as "0", and the test then reports "the add button is dead" about a form
   * that works. Measured: it failed about one run in three with a second suite running
   * beside it, and passed every time in isolation, which is the worst shape a failure
   * can have.
   *
   * A single change event is what a paste is, and it is exactly what the component's
   * `onChange` handles. Nothing here is testing keystroke handling.
   */
  const fill = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } });

  it('opens no row until it is asked to', async () => {
    /**
     * The form strip this replaced was always there: a labelled category select, an
     * amount, a notes box and an "Add to budget" button, pinned above the list whether or
     * not anybody was adding anything. One button now, and the row is the row.
     */
    setTrpc();
    show();
    expect(screen.queryByLabelText('travel.detail.plannedAmount')).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'travel.detail.plannedAddItem' }),
    ).toBeInTheDocument();
  });

  it('opens a row already shaped like the line it will become', async () => {
    // Category and amount on the first line, the traveller's own words on the second —
    // the same geometry `LineBlock` renders, so nothing moves when it is saved.
    const user = userEvent.setup();
    setTrpc();
    show();
    await openDraft(user);
    expect(screen.getByLabelText('travel.detail.plannedAmount')).toBeInTheDocument();
    expect(detailField()).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'travel.detail.plannedDiscard' }),
    ).toBeInTheDocument();
  });

  it('sends the category, the detail, and the amount in MINOR units', async () => {
    /**
     * Minor units is the assertion that matters. The field takes what a person types —
     * "125.50" — and the server takes BigInt minor units; sending 125 or 125.5 would
     * under-budget the line by two orders of magnitude and still look plausible in the
     * table, because the table formats whatever it is given.
     *
     * The amount and the notes are filled BEFORE the category on purpose: picking the
     * category is the save, and knowing what you are budgeting before you know which
     * bucket it goes in is the natural order. Anything already typed has to ride along.
     */
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc({ mutations: { 'travelRequests.addLine': { onCall, outcome: 'success' } } });
    show();

    await openDraft(user);
    fill(amount(), '125.50');
    fill(detailField(), 'Team dinner with the client');
    await user.click(catOption('c-meals'));

    // The first ARGUMENT: the row passes per-call `onSuccess`/`onError` as the second, so
    // it can drop itself only when the write lands.
    expect(onCall.mock.calls[0][0]).toEqual({
      id: 'tr-1',
      categoryId: 'c-meals',
      amountMinor: 12550n,
      notes: 'Team dinner with the client',
    });
  });

  it('writes nothing while the category is unpicked', async () => {
    // An amount with no category is not a plan, and there is no button to press by
    // mistake — the row simply has not been finished.
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc({ mutations: { 'travelRequests.addLine': { onCall, outcome: 'success' } } });
    show();
    await openDraft(user);
    fill(amount(), '40');
    fill(detailField(), 'Dinner');
    expect(onCall).not.toHaveBeenCalled();
  });

  it('discards a row without writing anything', async () => {
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc({ mutations: { 'travelRequests.addLine': { onCall, outcome: 'success' } } });
    show();
    await openDraft(user);
    fill(amount(), '40');
    await user.click(screen.getByRole('button', { name: 'travel.detail.plannedDiscard' }));
    expect(screen.queryByLabelText('travel.detail.plannedAmount')).not.toBeInTheDocument();
    expect(onCall).not.toHaveBeenCalled();
  });

  it('opens a second row without waiting for the first', async () => {
    // Somebody adding three items should not have to save each before starting the next.
    const user = userEvent.setup();
    setTrpc();
    show();
    await openDraft(user);
    await openDraft(user);
    expect(screen.getAllByLabelText('travel.detail.plannedAmount')).toHaveLength(2);
  });

  it('offers removal on EVERY line, quoted ones included', () => {
    /**
     * Deliberately inverted. Removal used to be offered on a MANUAL line only, matching
     * a server that refused anything else — because a re-price was the only way a quoted
     * or per-diem line could change, so deleting one left a hole nothing would refill.
     *
     * Nothing re-prices now. The total is the sum of what is there, and deleting a line
     * is how a traveller corrects a mistake: add a fresh one, drop the old one.
     */
    setTrpc();
    show({
      request: request({
        budgetLines: [
          line(),
          line({
            id: 'bl-2',
            basis: 'MANUAL',
            categoryId: 'c-meals',
            category: { id: 'c-meals', label: { en: 'Meals' }, icon: null },
          }),
        ],
      }),
    });
    expect(
      screen.getByRole('button', { name: 'travel.detail.plannedRemove:Meals' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'travel.detail.plannedRemove:Airfare' }),
    ).toBeInTheDocument();
  });

  it('reports a refused removal without swallowing the reason', async () => {
    // Replaces the old "reports a failed reprice". The server's message is the useful
    // half of a refusal, and a generic failure tells the traveller nothing to act on.
    const user = userEvent.setup();
    setTrpc({
      mutations: {
        'travelRequests.removeLine': {
          outcome: 'error',
          error: { message: 'A submitted request can no longer be edited.' },
        },
      },
    });
    show({
      request: request({
        budgetLines: [
          line({
            id: 'bl-2',
            basis: 'MANUAL',
            categoryId: 'c-meals',
            category: { id: 'c-meals', label: { en: 'Meals' }, icon: null },
          }),
        ],
      }),
    });
    await user.click(screen.getByRole('button', { name: 'travel.detail.plannedRemove:Meals' }));
    expect(
      await screen.findByText('A submitted request can no longer be edited.'),
    ).toBeInTheDocument();
  });

  it('removes the line it was asked about', async () => {
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc({ mutations: { 'travelRequests.removeLine': { onCall, outcome: 'success' } } });
    show({
      request: request({
        budgetLines: [
          line({
            id: 'bl-7',
            basis: 'MANUAL',
            categoryId: 'c-meals',
            category: { id: 'c-meals', label: { en: 'Meals' }, icon: null },
          }),
        ],
      }),
    });
    await user.click(screen.getByRole('button', { name: 'travel.detail.plannedRemove:Meals' }));
    expect(onCall).toHaveBeenCalledWith({ id: 'tr-1', lineId: 'bl-7' });
  });

  it('offers neither the form nor removal once the request has been submitted', () => {
    // The budget an approver is reading is not the traveller's to edit any more.
    setTrpc();
    show({
      request: request({
        status: 'SUBMITTED',
        budgetLines: [
          line({
            id: 'bl-7',
            basis: 'MANUAL',
            categoryId: 'c-meals',
            category: { id: 'c-meals', label: { en: 'Meals' }, icon: null },
          }),
        ],
      }),
    });
    expect(
      screen.queryByRole('button', { name: 'travel.detail.plannedSave' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'travel.detail.plannedRemove:Meals' }),
    ).not.toBeInTheDocument();
  });

  /**
   * A typed figure that would override the allowance, with no note.
   *
   * The one pick that cannot be the save. It is exactly the write the server refuses —
   * "Raising a policy-derived amount needs a reason" — and the row used to learn that from
   * the refusal, after a round trip. So the pick asks `previewLine` first, and holds the
   * row, warning and all, until the note is written or the figure stops overriding.
   */
  describe('a typed figure that would override the allowance', () => {
    const withDerivation = (onCall: (...args: unknown[]) => void) =>
      setTrpc({
        queries: { 'travelRequests.previewLine': { data: MEALS_DERIVATION } },
        mutations: { 'travelRequests.addLine': { onCall, outcome: 'success' } },
      });

    it('holds the pick, warns, and requires a note rather than filing it', async () => {
      const onCall = vi.fn();
      const user = userEvent.setup();
      withDerivation(onCall);
      show();
      await openDraft(user);
      fill(amount(), '400');
      await user.click(catOption('c-meals'));

      expect(onCall).not.toHaveBeenCalled();
      // The row is still a draft — with the category shown as picked, so it reads as the
      // line it is about to become, waiting on one word.
      expect(amount()).toHaveValue(400);
      expect(screen.getByText(/travel\.line\.overrides:.*320/)).toBeInTheDocument();
      expect(detailField()).toHaveAttribute('aria-required', 'true');
      expect(detailField()).toHaveAttribute('aria-invalid', 'true');

      fill(detailField(), 'Client dinner ran over the allowance');
      fireEvent.blur(detailField());
      expect(onCall.mock.calls[0][0]).toEqual({
        id: 'tr-1',
        categoryId: 'c-meals',
        amountMinor: 40000n,
        notes: 'Client dinner ran over the allowance',
      });
    });

    it('files the allowance itself as a derivation, not as a typed copy of it', async () => {
      // $320 typed against a $320 allowance displaces nothing. Sent as an amount it would
      // land MANUAL and demand a note for changing nothing; omitted, the server derives.
      const onCall = vi.fn();
      const user = userEvent.setup();
      withDerivation(onCall);
      show();
      await openDraft(user);
      fill(amount(), '320');
      await user.click(catOption('c-meals'));
      expect(onCall.mock.calls[0][0]).toEqual({ id: 'tr-1', categoryId: 'c-meals', notes: null });
    });

    it('files at once when a note is already written', async () => {
      const onCall = vi.fn();
      const user = userEvent.setup();
      withDerivation(onCall);
      show();
      await openDraft(user);
      fill(amount(), '400');
      fill(detailField(), 'Client dinner');
      await user.click(catOption('c-meals'));
      expect(onCall.mock.calls[0][0]).toEqual({
        id: 'tr-1',
        categoryId: 'c-meals',
        amountMinor: 40000n,
        notes: 'Client dinner',
      });
    });

    it('files at once when the figure displaces nothing', async () => {
      // The default preview: no allowance for the category. A typed figure is a typed
      // figure, and the pick is the save it always was.
      const onCall = vi.fn();
      const user = userEvent.setup();
      setTrpc({ mutations: { 'travelRequests.addLine': { onCall, outcome: 'success' } } });
      show();
      await openDraft(user);
      fill(amount(), '40');
      await user.click(catOption('c-meals'));
      expect(onCall.mock.calls[0][0]).toEqual({
        id: 'tr-1',
        categoryId: 'c-meals',
        amountMinor: 4000n,
        notes: null,
      });
    });

    it('shows the held category in the picker, so the row reads as the line it will be', async () => {
      const user = userEvent.setup();
      withDerivation(vi.fn());
      show();
      await openDraft(user);
      fill(amount(), '400');
      await user.click(catOption('c-meals'));
      const select = Array.from(document.querySelectorAll('[data-testid="select"]')).at(-1);
      expect(select).toHaveAttribute('data-value', 'c-meals');
      expect(select).toHaveTextContent('Meals');
    });

    it('retyping the allowance itself files the line as a derivation', async () => {
      const onCall = vi.fn();
      const user = userEvent.setup();
      withDerivation(onCall);
      show();
      await openDraft(user);
      fill(amount(), '400');
      await user.click(catOption('c-meals'));
      fill(amount(), '320');
      fireEvent.blur(amount());
      expect(onCall.mock.calls[0][0]).toEqual({ id: 'tr-1', categoryId: 'c-meals', notes: null });
    });

    it('does nothing on a notes blur while the figure still overrides and says nothing', async () => {
      const onCall = vi.fn();
      const user = userEvent.setup();
      withDerivation(onCall);
      show();
      await openDraft(user);
      fill(amount(), '400');
      await user.click(catOption('c-meals'));
      fireEvent.blur(detailField());
      fireEvent.blur(amount());
      expect(onCall).not.toHaveBeenCalled();
      // And nothing at all before a category is picked, whatever is blurred.
      await openDraft(user);
      fireEvent.blur(screen.getAllByLabelText('travel.detail.plannedAmount').at(-1) as HTMLElement);
      expect(onCall).not.toHaveBeenCalled();
    });

    it('files at once when the preview fails — the server has the last word anyway', async () => {
      const onCall = vi.fn();
      const user = userEvent.setup();
      setTrpc({
        queries: {
          'travelRequests.previewLine': {
            data: undefined,
            isError: true,
            error: { message: 'boom' },
          },
        },
        mutations: { 'travelRequests.addLine': { onCall, outcome: 'success' } },
      });
      show();
      await openDraft(user);
      fill(amount(), '400');
      await user.click(catOption('c-meals'));
      expect(onCall.mock.calls[0][0]).toEqual({
        id: 'tr-1',
        categoryId: 'c-meals',
        amountMinor: 40000n,
        notes: null,
      });
    });

    it('clearing the held figure files the line for the server to derive', async () => {
      const onCall = vi.fn();
      const user = userEvent.setup();
      withDerivation(onCall);
      show();
      await openDraft(user);
      fill(amount(), '400');
      await user.click(catOption('c-meals'));
      expect(onCall).not.toHaveBeenCalled();
      fill(amount(), '');
      fireEvent.blur(amount());
      expect(onCall.mock.calls[0][0]).toEqual({ id: 'tr-1', categoryId: 'c-meals', notes: null });
    });
  });

  it('reports a refused add without clearing what was typed', async () => {
    /**
     * Wiping the form on failure makes the person retype an amount the server never
     * objected to — and the refusal here is usually about the CATEGORY.
     */
    const user = userEvent.setup();
    setTrpc({
      mutations: {
        'travelRequests.addLine': {
          outcome: 'error',
          error: { message: 'That expense category is not available.' },
        },
      },
    });
    show();
    await openDraft(user);
    fill(amount(), '40');
    await user.click(catOption('c-meals'));
    expect(await screen.findByText('That expense category is not available.')).toBeInTheDocument();
    // The row is still there, still holding what was typed.
    expect(amount()).toHaveValue(40);
  });
});

// ── The rental car nothing can quote ──────────────────────────────────────────

describe('the rental car', () => {
  /**
   * There is no car engine. SerpApi's travel surface is Google Flights, Google Hotels,
   * Google Travel Explore, TripAdvisor and OpenTable — none of them sells car hire, and
   * there is no Google car-rental results page for one to scrape either. So `includeCar`
   * produces exactly no budget line on its own, and used to do so silently: a checkbox
   * that appeared to add a car to the trip and did nothing at all.
   */
  const carTrip = (over: Record<string, unknown> = {}) => request({ includeCar: true, ...over });

  it('says a requested car will not be budgeted unless it is planned', () => {
    setTrpc();
    show({ request: carTrip() });
    expect(screen.getByText('travel.detail.warnCarUnpriced')).toBeInTheDocument();
  });

  it('stops saying it once the car HAS been planned', () => {
    setTrpc();
    show({
      request: carTrip({
        budgetLines: [
          line(),
          line({
            id: 'bl-3',
            basis: 'MANUAL',
            categoryId: 'c-car',
            category: { id: 'c-car', label: { en: 'Rental car' }, icon: null },
          }),
        ],
      }),
    });
    expect(screen.queryByText('travel.detail.warnCarUnpriced')).not.toBeInTheDocument();
  });

  it('says nothing about a car on a trip that never asked for one', () => {
    setTrpc();
    show();
    expect(screen.queryByText('travel.detail.warnCarUnpriced')).not.toBeInTheDocument();
  });

  it('says nothing to an approver, who cannot act on it', () => {
    // The remedy is "add a planned item", and that is not offered on a submitted
    // request — a warning whose fix is unreachable is noise.
    setTrpc();
    show({ request: carTrip({ status: 'SUBMITTED' }) });
    expect(screen.queryByText('travel.detail.warnCarUnpriced')).not.toBeInTheDocument();
  });
});

// ── The per-line blocks ───────────────────────────────────────────────────────

/**
 * Each line is its own bordered block now, and the two things the old table could not
 * do are what these cover: overriding the amount, and offering the fields a KIND has.
 */
describe('the line blocks', () => {
  const overrideField = () => screen.getByLabelText('travel.line.override');

  it('carries the figure the line has, in row 1', async () => {
    /**
     * The amount used to be a blank box at the bottom of the block, so the only formatted
     * money on the row was the OLD figure in the header. It is in row 1 beside the
     * category now, showing what the line currently is — the same shape an expense line
     * item uses.
     */
    setTrpc();
    show();
    expect(overrideField()).toHaveValue(850);
  });

  it('sends a typed amount in MINOR units, on blur', async () => {
    const onCall = vi.fn();
    setTrpc({ mutations: { 'travelRequests.updateLine': { onCall, outcome: 'success' } } });
    show();
    // `change` rather than clear-then-type: the box now holds the stored figure, and
    // typing after a clear that did not take appends to it.
    fireEvent.change(overrideField(), { target: { value: '1234.50' } });
    fireEvent.blur(overrideField());
    expect(onCall).toHaveBeenCalledWith({
      id: 'tr-1',
      lineId: 'bl-1',
      amountMinor: 123_450n,
    });
  });

  it('writes nothing when the figure did not move', async () => {
    /**
     * What makes it safe for the box to show the stored value. An override is permanent —
     * nothing re-prices it back — so a no-op edit that flipped a derived line to MANUAL
     * would cost a traveller their allowance for nothing.
     */
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc({ mutations: { 'travelRequests.updateLine': { onCall, outcome: 'success' } } });
    show();
    await user.click(overrideField());
    await user.tab();
    expect(onCall).not.toHaveBeenCalled();
  });

  /**
   * "Manual budget amount not visible while entering — can't see what you enter until
   * after" (UAT A14).
   *
   * The box is blank on purpose, and it is a raw `<input type="number">`, so the only
   * formatted money on the row was the OLD figure in the header — sitting where it looks
   * like the new one. A traveller typed 1450, saw `1450` and an unrelated `$1,200.00`,
   * and had to commit an IRREVERSIBLE override to find out what they had entered.
   */
  describe('seeing the override before committing it', () => {
    it('shows the typed amount as money, in the line currency', async () => {
      setTrpc();
      show();
      fireEvent.change(overrideField(), { target: { value: '1234.5' } });
      expect(screen.getByLabelText('travel.line.overridePreview')).toHaveTextContent('1,234.50');
    });

    it('shows nothing while the box still holds the stored figure', async () => {
      // A preview repeating the number beside it is noise, and guessing at a half-typed
      // value is how a preview starts flickering.
      setTrpc();
      show();
      // The live region exists (it has to, to be announced when it fills) but says nothing.
      expect(screen.getByLabelText('travel.line.overridePreview')).toBeEmptyDOMElement();
    });

    it('shows nothing for a half-typed value it cannot parse', async () => {
      setTrpc();
      show();
      fireEvent.change(overrideField(), { target: { value: '-' } });
      expect(screen.getByLabelText('travel.line.overridePreview')).toBeEmptyDOMElement();
    });

    it('writes nothing until the field is left', async () => {
      /**
       * Until then the line still IS the old amount, and this override is permanent once
       * made. A write per keystroke would commit `1`, then `12`, then `123`.
       */
      const onCall = vi.fn();
      setTrpc({ mutations: { 'travelRequests.updateLine': { onCall, outcome: 'success' } } });
      show();
      fireEvent.change(overrideField(), { target: { value: '1234.5' } });
      expect(onCall).not.toHaveBeenCalled();
    });

    it('previews with the SAME parser the commit uses', async () => {
      /**
       * A preview computed a second way is right until it matters. Typing a value and
       * applying it must send exactly what was shown.
       */
      const onCall = vi.fn();
      setTrpc({ mutations: { 'travelRequests.updateLine': { onCall, outcome: 'success' } } });
      show();
      fireEvent.change(overrideField(), { target: { value: '1234.5' } });
      expect(screen.getByLabelText('travel.line.overridePreview')).toHaveTextContent('1,234.50');
      fireEvent.blur(overrideField());
      expect(onCall).toHaveBeenCalledWith({ id: 'tr-1', lineId: 'bl-1', amountMinor: 123_450n });
    });
  });

  it('offers days and a daily cap on a car line, and says nobody quoted it', async () => {
    /**
     * No provider on the travel integration sells car hire, so the figure is a policy
     * ceiling × the days. An approver reading it is entitled to know that rather than
     * assuming somebody sold the price.
     */
    setTrpc();
    show({
      request: request({
        budgetLines: [line({ kind: 'CAR_RENTAL', basis: 'POLICY_CAP' })],
      }),
    });
    expect(screen.getByLabelText('travel.line.days')).toBeInTheDocument();
    expect(screen.getByLabelText('travel.line.dailyCap')).toBeInTheDocument();
    expect(screen.getByText('travel.line.noLiveRate')).toBeInTheDocument();
  });

  it('sends the cap and the days as a payload for the server to price', async () => {
    // The block proposes; the server derives the amount and decides the basis.
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc({ mutations: { 'travelRequests.updateLine': { onCall, outcome: 'success' } } });
    show({
      request: request({ budgetLines: [line({ kind: 'CAR_RENTAL', basis: 'POLICY_CAP' })] }),
    });
    await user.type(screen.getByLabelText('travel.line.days'), '3');
    await user.type(screen.getByLabelText('travel.line.dailyCap'), '75');
    await user.click(screen.getByRole('button', { name: 'travel.line.recalculate' }));
    expect(onCall).toHaveBeenCalledWith({
      id: 'tr-1',
      lineId: 'bl-1',
      payload: { days: 3, dailyCapMinor: '7500' },
    });
  });

  it('offers no cap fields on a kind that is not priced from one', async () => {
    // An airfare line is amount-only until its picker lands — which is also the path
    // for an org with no provider configured.
    setTrpc();
    show({ request: request({ budgetLines: [line({ kind: 'AIRFARE' })] }) });
    expect(screen.queryByLabelText('travel.line.days')).not.toBeInTheDocument();
    expect(overrideField()).toBeInTheDocument();
  });

  it('offers nothing editable once the request is submitted', async () => {
    // The blocks are what an approver is reading. Editing them under one would change
    // the thing being decided.
    setTrpc();
    show({ request: request({ status: 'SUBMITTED' }) });
    expect(screen.queryByLabelText('travel.line.override')).not.toBeInTheDocument();
  });
});

// ── The provider-backed pickers ───────────────────────────────────────────────

/**
 * Searching SPENDS a paid credit, which shapes every assertion here: the search is a
 * button and never an effect. And picking sends a `quoteId` and nothing else — the
 * server re-reads the amount from the stored candidate, so a price rendered in the DOM
 * is display-only.
 */
describe('the flight picker', () => {
  const flightLine = () =>
    request({ budgetLines: [line({ kind: 'AIRFARE', basis: 'MANUAL', notes: null })] });

  it('does not search until somebody presses the button', async () => {
    // Every call is a purchase. A search on mount would spend a credit for opening a
    // drawer, and a search on re-render would spend several.
    const onCall = vi.fn();
    setTrpc({ mutations: { 'travelRequests.searchFlightOptions': { onCall } } });
    show({ request: flightLine() });
    expect(onCall).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'travel.picker.search' })).toBeInTheDocument();
    // And says so before the press.
    expect(screen.getByText('travel.picker.costHint')).toBeInTheDocument();
  });

  it('sends the cabin and the stop limit the traveller chose', async () => {
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc({
      mutations: { 'travelRequests.searchFlightOptions': { onCall, outcome: 'success' } },
    });
    show({ request: flightLine() });
    await user.click(screen.getByRole('button', { name: 'travel.picker.search' }));
    expect(onCall).toHaveBeenCalledWith({
      id: 'tr-1',
      // From the REQUEST, not the picker: changing where somebody flies is `update`'s job.
      tripType: 'ROUND_TRIP',
      travelClass: 'ECONOMY',
      maxStops: null,
      deepSearch: false,
    });
  });

  it('keeps the amount override live beside the picker', async () => {
    /**
     * The no-provider path. An org with no SerpApi plan can still type the fare, and
     * that is not a degraded mode — it is the only thing anybody can do, so the field
     * sits underneath the picker rather than being replaced by it.
     */
    setTrpc();
    show({ request: flightLine() });
    expect(screen.getByLabelText('travel.line.override')).toBeInTheDocument();
  });

  it('offers no picker at all once the request is submitted', async () => {
    setTrpc();
    show({ request: request({ status: 'SUBMITTED', budgetLines: [line({ kind: 'AIRFARE' })] }) });
    expect(screen.queryByRole('button', { name: 'travel.picker.search' })).not.toBeInTheDocument();
  });
});

describe('the attendee editor', () => {
  const mealLine = () =>
    request({ budgetLines: [line({ kind: 'DEPARTMENT_MEAL', basis: 'PER_DIEM', notes: null })] });

  it('spells out the multiplication rather than only showing a total', async () => {
    /**
     * The whole reason DEPARTMENT_MEAL is a kind. Three people twice a day for four days
     * is 24 covers, and nobody should be doing that in their head into a single box.
     */
    setTrpc();
    show({ request: mealLine() });
    expect(screen.getByText(/travel\.attendees\.covers/)).toBeInTheDocument();
  });

  it('sends only the NAMED attendees', async () => {
    // A half-typed row would otherwise count as a head and inflate the estimate by one
    // person's allowance.
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc({ mutations: { 'travelRequests.updateLine': { onCall, outcome: 'success' } } });
    show({ request: mealLine() });
    await user.click(screen.getByRole('button', { name: 'travel.attendees.add' }));
    await user.click(screen.getByRole('button', { name: 'travel.attendees.add' }));
    const names = screen.getAllByLabelText('travel.attendees.name');
    await user.type(names[0], 'Ada');
    // names[1] deliberately left blank.
    await user.tab();
    const payload = onCall.mock.calls.at(-1)?.[0]?.payload as { attendees: unknown[] };
    expect(payload.attendees).toEqual([{ name: 'Ada', company: null, isExternal: false }]);
  });

  it('sends no rate when the allowance could not be resolved', async () => {
    /**
     * The box is pre-filled with the rate the server resolved, and an empty one means it
     * resolved none — no rate covering the destination and the traveller's tier. Sending
     * null is how the server is told to work it out (or not) rather than being handed a
     * figure the client invented.
     */
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc({ mutations: { 'travelRequests.updateLine': { onCall, outcome: 'success' } } });
    show({ request: mealLine() });
    await user.click(screen.getByLabelText('travel.attendees.ratePerPerson'));
    await user.tab();
    expect(onCall.mock.calls.at(-1)?.[0]?.payload).toMatchObject({ ratePerPersonMinor: null });
  });
});

// ── Editing the trip itself ──────────────────────────────────────────────────

describe('the trip header', () => {
  it('offers an edit affordance that the module has never had', async () => {
    /**
     * `travelRequests.update` shipped in phase 3 wired to NOTHING: a DRAFT request's
     * purpose and dates could not be changed after creation, so a typo meant withdrawing
     * and starting over.
     */
    setTrpc();
    show();
    expect(screen.getByRole('button', { name: 'travel.header.edit' })).toBeInTheDocument();
  });

  it('sends the dates at midnight UTC', async () => {
    /**
     * A trip is a range of calendar dates. Letting the browser stamp its own offset makes
     * the same trip a day shorter for half the company, and a form pre-filled with a
     * shifted value would SAVE the shift.
     */
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc({ mutations: { 'travelRequests.update': { onCall, outcome: 'success' } } });
    show();
    await user.click(screen.getByRole('button', { name: 'travel.header.edit' }));
    await user.click(screen.getByRole('button', { name: 'travel.header.save' }));
    const sent = onCall.mock.calls[0]?.[0] as { departDate: string };
    expect(sent.departDate).toMatch(/T00:00:00\.000Z$/);
  });

  it('warns that editing does not re-price what is already there', async () => {
    // Said before the save rather than discovered after it.
    const user = userEvent.setup();
    setTrpc();
    show();
    await user.click(screen.getByRole('button', { name: 'travel.header.edit' }));
    expect(screen.getByText('travel.header.editHint')).toBeInTheDocument();
  });

  it('offers no edit affordance once submitted', async () => {
    setTrpc();
    show({ request: request({ status: 'SUBMITTED' }) });
    expect(screen.queryByRole('button', { name: 'travel.header.edit' })).not.toBeInTheDocument();
  });
});

describe('adding a line', () => {
  /** The same selectors the planned-item block uses: the Select trigger is not
   *  label-associated, so the option is reached by its `data-option` attribute, and the
   *  controlled inputs take one change event rather than a keystroke stream. */
  const catOption = (id: string) => document.querySelector(`[data-option="${id}"]`) as HTMLElement;
  const amount = () => screen.getByLabelText('travel.detail.plannedAmount');
  const openDraft = (user: ReturnType<typeof userEvent.setup>) =>
    user.click(screen.getByRole('button', { name: 'travel.detail.plannedAddItem' }));
  const fill = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } });

  it('needs a CATEGORY only — the amount is optional', async () => {
    /**
     * The regression this pins. The form required both, which made the module's whole
     * point unreachable: picking "Meals" is supposed to derive the per-diem for the
     * destination, and a form that would not submit without a typed figure meant every
     * line arrived as MANUAL and no allowance was ever applied from the UI.
     */
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc({ mutations: { 'travelRequests.addLine': { onCall, outcome: 'success' } } });
    show();
    await openDraft(user);
    await user.click(catOption('c-meals'));
    expect(onCall).toHaveBeenCalled();
  });

  it('omits the amount entirely when blank, so the server derives it', async () => {
    // Sending 0 would land as a MANUAL zero and suppress the derivation — the opposite
    // of what leaving the field empty means.
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc({ mutations: { 'travelRequests.addLine': { onCall, outcome: 'success' } } });
    show();
    await openDraft(user);
    await user.click(catOption('c-meals'));
    expect(onCall.mock.calls[0]?.[0]?.amountMinor).toBeUndefined();
  });

  it('omits a zero rather than budgeting nothing', async () => {
    /**
     * Zero is not an estimate. With the old form it disabled the Add button; there is no
     * button to disable now, and refusing the category pick would be a dead control with
     * nothing to explain it — so it is treated as an amount nobody typed and the line is
     * created with the derived figure instead. The strict refusal still exists where it
     * can say why: the amount box on the created row puts the stored figure back.
     */
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc({ mutations: { 'travelRequests.addLine': { onCall, outcome: 'success' } } });
    show();
    await openDraft(user);
    fill(amount(), '0');
    await user.click(catOption('c-meals'));
    expect(onCall.mock.calls[0][0]).toEqual({ id: 'tr-1', categoryId: 'c-meals', notes: null });
  });
});

// ── Policy violations ─────────────────────────────────────────────────────────

describe('policy violations', () => {
  it('shows a blocking violation and refuses the submit', async () => {
    /**
     * The one place the estimate stops being advisory. Everything else on this screen is
     * a `role="status"` panel beside a live button; this one disables it — and says why,
     * unlike the budget gate it replaced, whose dead button came with no sentence at all.
     */
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc({ mutations: { 'travelRequests.submit': { onCall, outcome: 'success' } } });
    show({ request: request({ policyViolations: [violation()] }) });

    // `t.has` is hard-false in this file's next-intl mock, so the label falls back to the
    // raw message key — the fallback path itself, which `ViolationList.test.tsx` covers
    // against a catalog that does have the key.
    expect(screen.getByText('travel.policy.blockedSummary:1')).toBeInTheDocument();
    expect(screen.getByText('travelCabinClass')).toBeInTheDocument();
    expect(btn('submit')).toBeDisabled();
    await user.click(btn('submit'));
    expect(onCall).not.toHaveBeenCalled();
  });

  it('offers no justification box for a BLOCK', () => {
    // A blocking violation must be fixed, not justified. The server refuses it too; the
    // absent box is what stops somebody wasting a paragraph on it.
    setTrpc();
    show({ request: request({ policyViolations: [violation()] }) });
    expect(screen.queryByText('travel.policy.justify')).not.toBeInTheDocument();
    expect(screen.getByText('travel.policy.blockHint')).toBeInTheDocument();
  });

  it('blocks the submit on an UNJUSTIFIED warning, and releases it once explained', () => {
    const warn = violation({ severity: 'WARNING' });
    setTrpc();
    const { unmount } = show({ request: request({ policyViolations: [warn] }) });
    expect(btn('submit')).toBeDisabled();
    expect(screen.getByText('travel.policy.warnSummary:1')).toBeInTheDocument();
    unmount();

    setTrpc();
    show({
      request: request({
        policyViolations: [
          { ...warn, resolveNote: 'Only flight that lands in time', resolvedAt: '2026-08-20' },
        ],
      }),
    });
    expect(btn('submit')).toBeEnabled();
  });

  it('sends a warning’s justification, and sends null for a blank one', async () => {
    /**
     * Blank CLEARS rather than cancels. An explanation the traveller no longer stands
     * behind should stop unblocking their submit, so the empty box has to reach the
     * server rather than being read as "never mind".
     */
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc({
      mutations: { 'travelRequests.justifyViolation': { onCall, outcome: 'success' } },
    });
    show({ request: request({ policyViolations: [violation({ severity: 'WARNING' })] }) });

    await user.click(screen.getByText('travel.policy.justify'));
    await user.type(screen.getByLabelText('travel.policy.justify'), '  ');
    await user.click(screen.getByText('travel.policy.saveJustification'));
    expect(onCall).toHaveBeenCalledWith({ violationId: 'v-1', note: null });
  });

  it('puts a line-anchored violation under its own line', () => {
    // A cabin block is a fact about ONE flight. A list at the bottom would make the
    // reader match sentences to lines by hand.
    setTrpc();
    show({
      request: request({
        budgetLines: [
          line(),
          line({
            id: 'bl-2',
            payload: {
              fromLabel: 'YYZ',
              toLabel: 'LHR',
              travelClass: 'ECONOMY',
              legs: [{ from: 'YYZ', to: 'LHR', flightNumber: 'AC 848' }],
            },
          }),
        ],
        policyViolations: [violation({ travelLineId: 'bl-2' })],
      }),
    });
    /**
     * Walk up to the wrapper that pairs a line with its own violations, and check that
     * the flight it sits beside is the second one. Asserting only that the sentence is
     * SOMEWHERE on screen would pass with it rendered under the wrong flight, which is
     * the exact mistake this arrangement exists to prevent.
     */
    const sentence = screen.getByText('travelCabinClass');
    const pair = sentence.closest('li')?.closest('div.flex.flex-col.gap-1\\.5');
    expect(pair?.textContent).toContain('AC 848');
    expect(pair?.textContent).not.toContain('AC 795');
  });

  it('shows a request-wide violation once, not per line', () => {
    setTrpc();
    show({
      request: request({
        budgetLines: [line(), line({ id: 'bl-2' })],
        policyViolations: [violation({ travelLineId: null })],
      }),
    });
    expect(screen.getAllByText('travelCabinClass')).toHaveLength(1);
  });

  it('says nothing at all when the estimate is clean', () => {
    setTrpc();
    show();
    expect(screen.queryByText(/travel\.policy\.blockedSummary/)).not.toBeInTheDocument();
    expect(screen.queryByText(/travel\.policy\.warnSummary/)).not.toBeInTheDocument();
    expect(btn('submit')).toBeEnabled();
  });
});
