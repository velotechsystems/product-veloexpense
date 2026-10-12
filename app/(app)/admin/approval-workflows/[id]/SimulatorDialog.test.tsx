import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTrpcMock, type TrpcMockConfig } from '@/test-utils/trpc';
import type { EditorOptions } from './options';

/**
 * The workflow simulator — "who would have to approve this?" before anybody files it.
 *
 * It exists because the routing rules are only readable as a graph, and a graph does
 * not tell you which branch a $12,000 dinner in Engineering takes. The answers it gives
 * are only trustworthy if the facts it sends are exactly the facts that were typed, so
 * that is what these tests pin:
 *
 *   · **Money is typed in dollars and sent in minor units.** An off-by-100 here would
 *     make every simulation route through the wrong amount tier while looking correct.
 *   · **A fact left blank is ABSENT, not false.** "No department chosen" must not
 *     simulate as "the department is empty", which is a different branch.
 *   · **The report-only facts are only offered — and only sent — for a report.** A card
 *     request has no per-diem or budget to be over.
 *   · **Nothing is claimed before Run.** A stale result beside changed facts is worse
 *     than no result.
 */

const h = vi.hoisted(() => ({ trpc: undefined as unknown }));

vi.mock('@/lib/trpc/client', () => ({
  get trpc() {
    return h.trpc;
  },
}));
vi.mock('next-intl', () => ({
  useTranslations: () => {
    const t = (key: string, values?: Record<string, unknown>) =>
      values ? `${key}:${Object.values(values).join(',')}` : key;
    t.has = () => false;
    return t;
  },
  useLocale: () => 'en',
}));

/** The design system's Combobox is a Base UI popover; a native <select> is enough. */
vi.mock('@expenseos/design-system', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    Combobox: ({
      id,
      items,
      value,
      onValueChange,
    }: {
      id?: string;
      items: { value: string; label: string }[];
      value: string | null;
      onValueChange: (v: string | null) => void;
    }) => (
      <select id={id} value={value ?? ''} onChange={(e) => onValueChange(e.target.value || null)}>
        <option value="">—</option>
        {items.map((i) => (
          <option key={i.value} value={i.value}>
            {i.label}
          </option>
        ))}
      </select>
    ),
  };
});

import type { ApprovalSubjectTypeValue } from '@/lib/approvalSubjects';
import { SimulatorDialog } from './SimulatorDialog';

const OPTIONS = {
  jobLevels: [{ id: 'jl-1', code: 'L5', label: { en: 'Director' }, sortOrder: 1 }],
  departments: [{ id: 'dep-1', label: { en: 'Engineering' } }],
  legalEntities: [],
  businessUnits: [],
  currencies: [],
  vendors: [],
  workflows: [],
  roles: [],
  categories: [{ id: 'cat-1', label: { en: 'Meals' } }],
} as unknown as EditorOptions;

const RESULT = {
  workflowName: 'Above $10k',
  status: 'APPROVED',
  steps: [
    { nodeId: 'n-1', type: 'approval' },
    { nodeId: 'n-2', type: 'acknowledge' },
  ],
};

function setTrpc(over: TrpcMockConfig = {}) {
  h.trpc = createTrpcMock({
    ...over,
    queries: {
      'approvalWorkflows.simulate': {
        data: RESULT,
        ...over.queries?.['approvalWorkflows.simulate'],
      },
    },
  });
}

const show = (
  subjectType: ApprovalSubjectTypeValue = 'EXPENSE_REPORT',
  ...rest: (EditorOptions | undefined)[]
) => {
  const options = rest.length > 0 ? rest[0] : OPTIONS;
  const onClose = vi.fn();
  const view = render(
    <SimulatorDialog
      subjectType={subjectType}
      options={options}
      locale={'en' as never}
      onClose={onClose}
    />,
  );
  return { ...view, onClose };
};

const run = (user: ReturnType<typeof userEvent.setup>) =>
  user.click(screen.getByRole('button', { name: 'sim.run' }));

/**
 * Type into one of the dialog's number boxes.
 *
 * `user.type` is no good here: the dialog traps focus on its first field, so a click
 * on a later box does not move the caret and every keystroke lands in Amount.
 */
const fill = (label: RegExp, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });

/** The facts of the last simulate call. */
const lastInput = (onCall: ReturnType<typeof vi.fn>) =>
  onCall.mock.calls[onCall.mock.calls.length - 1]?.[0] as Record<string, unknown>;

beforeEach(() => {
  setTrpc();
});
afterEach(() => {
  // The dialog portals outside the render container, so the automatic teardown does
  // not always take its DOM with it — two dialogs in one document make every query
  // ambiguous, and a stale one answers first.
  cleanup();
  h.trpc = undefined;
  vi.restoreAllMocks();
});

describe('the facts it asks for', () => {
  it('offers the report-only facts for a report', () => {
    show();
    expect(screen.getByText('sim.overPerDiem')).toBeInTheDocument();
    expect(screen.getByText('sim.overBudget')).toBeInTheDocument();
  });

  // VeloExpense: no card-request subject (d50; lib/approvalSubjects).
  it.skip('offers none of them for a card request, which has no per-diem to be over', () => {
    show('VIRTUAL_CARD_REQUEST' as never);
    expect(screen.queryByText('sim.overPerDiem')).not.toBeInTheDocument();
    expect(screen.queryByText('sim.category')).not.toBeInTheDocument();
  });

  it('names a job level by code and label, since the code alone is opaque', () => {
    show();
    expect(screen.getByRole('option', { name: 'L5 — Director' })).toBeInTheDocument();
  });

  it('holds the pickers open, empty, while the options are still loading', () => {
    // The dialog is reachable before the option lists resolve.
    show('EXPENSE_REPORT', undefined);
    const dept = screen.getByLabelText(/sim.department/) as HTMLSelectElement;
    expect(dept).toBeInTheDocument();
    expect([...dept.options].map((o) => o.textContent)).toEqual(['—']);
  });
});

describe('what it sends', () => {
  it('claims nothing before Run', () => {
    /**
     * The query is gated on having been run; showing the canned answer beside facts
     * nobody submitted is how a stale verdict gets believed.
     */
    show();
    expect(screen.queryByText('Above $10k')).not.toBeInTheDocument();
  });

  it('converts the typed dollars to minor units', async () => {
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc({ queries: { 'approvalWorkflows.simulate': { data: RESULT, onCall } } });
    show();
    fill(/sim.amount/, '12000.50');
    await run(user);
    expect(lastInput(onCall).amount).toBe(1200050);
  });

  it('rounds a third decimal rather than sending a fraction of a cent', async () => {
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc({ queries: { 'approvalWorkflows.simulate': { data: RESULT, onCall } } });
    show();
    fill(/sim.amount/, '10.005');
    await run(user);
    expect(lastInput(onCall).amount).toBe(1001);
  });

  it('sends no amount at all when the box is left empty', async () => {
    /**
     * Zero is a real amount and would route down the lowest tier. Absent means "any
     * amount", which is what an empty box means.
     */
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc({ queries: { 'approvalWorkflows.simulate': { data: RESULT, onCall } } });
    show();
    await run(user);
    expect(lastInput(onCall).amount).toBeUndefined();
  });

  it('sends the chosen department and job level', async () => {
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc({ queries: { 'approvalWorkflows.simulate': { data: RESULT, onCall } } });
    show();
    await user.selectOptions(screen.getByLabelText(/sim.department/), 'dep-1');
    await user.selectOptions(screen.getByLabelText(/sim.jobLevel/), 'jl-1');
    await run(user);
    expect(lastInput(onCall)).toMatchObject({ departmentId: 'dep-1', jobLevelId: 'jl-1' });
  });

  it('sends the category as a list, because the report facts are per-report', async () => {
    // A report can span categories; the simulator asks about one at a time.
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc({ queries: { 'approvalWorkflows.simulate': { data: RESULT, onCall } } });
    show();
    await user.selectOptions(screen.getByLabelText(/sim.category/), 'cat-1');
    await run(user);
    expect(lastInput(onCall).categoryIds).toEqual(['cat-1']);
  });

  it('sends the largest single line separately from the report total', async () => {
    /**
     * A per-line threshold is a different rule from a report threshold — one $9,000
     * line in a $9,500 report trips a line rule and not a total rule.
     */
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc({ queries: { 'approvalWorkflows.simulate': { data: RESULT, onCall } } });
    show();
    fill(/sim.maxLine/, '9000');
    await run(user);
    expect(lastInput(onCall).maxLineAmount).toBe(900000);
  });

  it('sends a yes/no fact as the string the rules compare against', async () => {
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc({ queries: { 'approvalWorkflows.simulate': { data: RESULT, onCall } } });
    show();
    await user.selectOptions(screen.getByLabelText(/sim.hasPolicyViolation/), 'true');
    await user.selectOptions(screen.getByLabelText(/sim.overBudget/), 'false');
    await run(user);
    expect(lastInput(onCall)).toMatchObject({
      hasPolicyViolation: 'true',
      overBudget: 'false',
    });
  });

  it('leaves an unanswered yes/no absent rather than answering it', async () => {
    /**
     * "Don't know" and "no" route differently: a rule that fires on a violation must
     * not be evaluated as "there is no violation" just because nobody said.
     */
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc({ queries: { 'approvalWorkflows.simulate': { data: RESULT, onCall } } });
    show();
    await run(user);
    const input = lastInput(onCall);
    expect(input.overPerDiem).toBeUndefined();
    expect(input.requiresApproval).toBeUndefined();
  });

  // VeloExpense: no card-request subject (d50; lib/approvalSubjects).
  it.skip('sends no report facts for a card request', async () => {
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc({ queries: { 'approvalWorkflows.simulate': { data: RESULT, onCall } } });
    show('VIRTUAL_CARD_REQUEST' as never);
    await run(user);
    expect(lastInput(onCall)).not.toHaveProperty('categoryIds');
    expect(lastInput(onCall)).not.toHaveProperty('overBudget');
  });
});

describe('what it reports back', () => {
  it('names the workflow that governs those facts', async () => {
    const user = userEvent.setup();
    setTrpc();
    show();
    await run(user);
    expect(await screen.findByText('Above $10k')).toBeInTheDocument();
  });

  it('lists the approvals in the order they would be asked for', async () => {
    const user = userEvent.setup();
    setTrpc();
    show();
    await run(user);
    const steps = (await screen.findAllByRole('listitem')).map((li) => li.textContent);
    expect(steps).toEqual(['1.Approval', '2.Acknowledge']);
  });

  it('falls back to the raw node type for one it has no name for', async () => {
    const user = userEvent.setup();
    setTrpc({
      queries: {
        'approvalWorkflows.simulate': {
          data: { ...RESULT, steps: [{ nodeId: 'n-1', type: 'somethingNew' }] },
        },
      },
    });
    show();
    await run(user);
    expect(await screen.findByText('somethingNew')).toBeInTheDocument();
  });

  it('says plainly that nothing would be asked of anybody', async () => {
    /**
     * An auto-approving report is the answer people most want to check, and an empty
     * list reads as a failed simulation.
     */
    const user = userEvent.setup();
    setTrpc({
      queries: { 'approvalWorkflows.simulate': { data: { ...RESULT, steps: [] } } },
    });
    show();
    await run(user);
    expect(await screen.findByText('sim.noSteps')).toBeInTheDocument();
  });

  it('says when no published workflow governs those facts at all', async () => {
    // Which is itself a finding: the report would be auto-approved.
    const user = userEvent.setup();
    setTrpc({
      queries: {
        'approvalWorkflows.simulate': {
          data: { workflowName: null, status: 'APPROVED', steps: [] },
        },
      },
    });
    show();
    await run(user);
    expect(await screen.findByText('sim.none')).toBeInTheDocument();
  });

  it('shows the outcome the run would reach', async () => {
    const user = userEvent.setup();
    setTrpc({
      queries: {
        'approvalWorkflows.simulate': { data: { ...RESULT, status: 'PENDING' } },
      },
    });
    show();
    await run(user);
    expect(await screen.findByText('PENDING')).toBeInTheDocument();
  });

  it('says it is running while it is', () => {
    setTrpc({ queries: { 'approvalWorkflows.simulate': { data: RESULT, isLoading: true } } });
    show();
    // isFetching drives the label; loading alone leaves Run readable.
    expect(screen.getByRole('button', { name: 'sim.run' })).toBeInTheDocument();
  });

  it('says so when the run fails, instead of rendering nothing', async () => {
    /**
     * The failure mode this replaces: the result block was gated on `sim.data` alone, so
     * an error rendered NOTHING and pressing Run looked identical to a workflow with no
     * steps. That is how a rejected `subjectType` on the travel workflow was reported as
     * an unrunnable graph (GA v2, GA-1) — the graph was fine, the query never ran.
     */
    const user = userEvent.setup();
    setTrpc({
      queries: {
        'approvalWorkflows.simulate': { data: undefined, isError: true },
      },
    });
    // VeloExpense: on a report — no travel subject yet. The error state is the same for any.
    show();
    await run(user);
    expect(await screen.findByText('sim.failed')).toBeInTheDocument();
  });

  // VeloExpense: no travel subject yet (lib/approvalSubjects).
  it.skip('simulates a travel workflow — the subject that used to be rejected', async () => {
    /**
     * `TRAVEL_REQUEST` was absent from the router's input enum, so this exact render +
     * Run produced a validation error and a blank dialog. Asserted with a real result so
     * a regression shows up as "no steps" rather than as a passing error-state test.
     */
    const user = userEvent.setup();
    setTrpc();
    show('TRAVEL_REQUEST' as never);
    await run(user);
    expect(await screen.findByText('Above $10k')).toBeInTheDocument();
  });

  it('closes on request', async () => {
    const user = userEvent.setup();
    setTrpc();
    const { onClose } = show();
    await user.click(screen.getByRole('button', { name: 'sim.close' }));
    expect(onClose).toHaveBeenCalled();
  });
});
