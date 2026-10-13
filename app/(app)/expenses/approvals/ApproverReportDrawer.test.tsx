import '@testing-library/jest-dom/vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTrpcMock, type TrpcMockConfig } from '@/test-utils/trpc';

/**
 * ApproverReportDrawer — where a report is actually decided.
 *
 * It is the read-only counterpart to the submitter's workbench, and the tests are about
 * what an approver is allowed to do rather than what they can see:
 *
 *   · **A decision needs a TASK, not just a status.** A deep link can open a report the
 *     viewer has no pending task on (already decided, or expired); the decide actions
 *     must not appear, because the server would refuse them and the button would be a
 *     lie.
 *   · **An acknowledgement is not a decision.** It has one outcome, so no reject and no
 *     return are offered — either would be an authority the node does not carry.
 *   · **A rejection must say why.** Confirm stays disabled without a note, because
 *     "rejected" with no reason sends the submitter back to a report with nothing to
 *     fix. A RETURN may go without one: the note is the useful part, not the gate.
 *   · **Chase before deciding.** Approving a report whose receipts are missing is the
 *     thing this button exists to prevent, so it only appears when something is
 *     actually missing.
 */

const h = vi.hoisted(() => ({ trpc: undefined as unknown }));

const translators = new Map<string, (k: string, v?: Record<string, unknown>) => string>();

vi.mock('next-intl', () => ({
  useLocale: () => 'en',
  useTranslations: (ns?: string) => {
    const key = ns ?? '';
    let t = translators.get(key);
    if (!t) {
      const fn = (k: string, values?: Record<string, unknown>) => {
        const full = ns ? `${ns}.${k}` : k;
        return values ? `${full}:${Object.values(values).join(',')}` : full;
      };
      (fn as { has?: () => boolean }).has = () => false;
      t = fn;
      translators.set(key, t);
    }
    return t;
  },
}));
vi.mock('@/lib/trpc/client', () => ({
  get trpc() {
    return h.trpc;
  },
}));

import { ApproverReportDrawer } from './ApproverReportDrawer';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const receipt = (over: Record<string, unknown> = {}) => ({
  id: 'rec-1',
  filename: 'canoe.pdf',
  url: 'https://files/canoe.pdf',
  extraction: null,
  ...over,
});

const expense = (over: Record<string, unknown> = {}) => ({
  id: 'exp-1',
  merchant: 'Canoe',
  date: '2026-07-28T12:00:00.000Z',
  placeText: 'Toronto',
  amountMinor: '12500',
  explanation: 'Dinner with the Acme team',
  attendees: [{ id: 'a-1', name: 'Jo Chan', company: 'Acme', isExternal: true }],
  lineItems: [
    { id: 'li-1', amountMinor: '12500', category: { id: 'c-1', label: { en: 'Meals' } } },
  ],
  receipts: [receipt()],
  ...over,
});

const report = (over: Record<string, unknown> = {}) => ({
  id: 'rep-1',
  number: 'EXP-1042',
  title: 'Toronto client visit',
  status: 'SUBMITTED',
  purpose: 'Quarterly review',
  totalMinor: '125000',
  currency: { code: 'CAD', symbol: '$' },
  submitter: { id: 'u-1', firstName: 'Dana', lastName: 'Patel', email: 'dana@e.inc' },
  violations: [],
  expenses: [expense()],
  extractionReviewThreshold: 0.8,
  ...over,
});

function setTrpc(data: unknown = report(), over: TrpcMockConfig = {}) {
  h.trpc = createTrpcMock({
    ...over,
    queries: {
      'expenseApprovals.report': { data, ...over.queries?.['expenseApprovals.report'] },
      ...over.queries,
    },
  });
}

const onClose = vi.fn();
const onDecided = vi.fn();

const show = (props: Record<string, unknown> = {}) =>
  render(
    <ApproverReportDrawer
      reportId="rep-1"
      taskId="task-1"
      canReimburse={false}
      onClose={onClose}
      onDecided={onDecided}
      {...props}
    />,
  );

const btn = (name: string) => screen.getByRole('button', { name });
const noBtn = (name: string) =>
  expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();

afterEach(() => {
  h.trpc = undefined;
  onClose.mockReset();
  onDecided.mockReset();
  vi.restoreAllMocks();
});

// ── What it shows ─────────────────────────────────────────────────────────────

describe('the report', () => {
  it('heads with the report, its status, total and submitter', () => {
    setTrpc();
    show();
    expect(screen.getByText('Toronto client visit')).toBeInTheDocument();
    expect(screen.getByText('EXP-1042')).toBeInTheDocument();
    // The TRANSLATED label. It used to assert the English status literal, which is the
    // defect: the pill rendered its status key (GA readiness report F43).
    expect(screen.getByText('expenses.status.submitted')).toBeInTheDocument();
    expect(screen.getByText('$1,250.00 CAD')).toBeInTheDocument();
    expect(screen.getByText('· Dana Patel')).toBeInTheDocument();
  });

  it('says it is loading rather than showing an empty report', () => {
    setTrpc(undefined, {
      queries: { 'expenseApprovals.report': { isLoading: true, data: undefined } },
    });
    show();
    expect(screen.getByText('expenses.list.loading')).toBeInTheDocument();
    expect(screen.getByText('expenses.drawer.fallback')).toBeInTheDocument();
  });

  it('surfaces the policy warnings the approver is deciding against', () => {
    /**
     * The whole reason to look at this screen rather than approve from the list.
     */
    setTrpc(
      report({
        violations: [
          { id: 'v1', severity: 'BLOCK', message: 'Over the per-diem cap' },
          { id: 'v2', severity: 'INFO', message: 'No receipt on one line' },
        ],
      }),
    );
    show();
    expect(screen.getByText('expenses.policy.error: Over the per-diem cap')).toBeInTheDocument();
    expect(screen.getByText('expenses.policy.info: No receipt on one line')).toBeInTheDocument();
  });

  it('says explicitly that there are no warnings', () => {
    // An empty section reads as a section that failed to load.
    setTrpc();
    show();
    expect(screen.getByText('expenses.drawer.noWarnings')).toBeInTheDocument();
  });

  it('reads an expense out with its lines, attendees and receipt', () => {
    setTrpc();
    show();
    expect(screen.getByText('Canoe')).toBeInTheDocument();
    // The place rides with the date, under the merchant.
    expect(screen.getByText(/7\/28\/2026 · Toronto/)).toBeInTheDocument();
    expect(screen.getByText('Dinner with the Acme team')).toBeInTheDocument();
    expect(screen.getByText(/Jo Chan · Acme · expenses\.attendee\.external/)).toBeInTheDocument();
    expect(screen.getByText('Meals')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'canoe.pdf' })).toHaveAttribute(
      'href',
      'https://files/canoe.pdf',
    );
  });

  it('names an expense with no merchant rather than leaving it blank', () => {
    setTrpc(report({ expenses: [expense({ merchant: null, placeText: null })] }));
    show();
    expect(screen.getByText('expenses.line.noMerchant')).toBeInTheDocument();
  });

  it('says when an expense has no lines, and when a report has none', () => {
    setTrpc(report({ expenses: [expense({ lineItems: [] })] }));
    show();
    expect(screen.getByText('expenses.drawer.noLines')).toBeInTheDocument();

    setTrpc(report({ expenses: [] }));
    show();
    expect(screen.getByText('expenses.drawer.noExpenses')).toBeInTheDocument();
  });

  it('warns when a low-confidence scan has not been verified', () => {
    /**
     * The coded figures came from an extraction nobody checked. The approver is about
     * to decide on them, so the caution belongs here as well as on the workbench.
     */
    setTrpc(
      report({
        expenses: [
          expense({
            receipts: [
              receipt({ extraction: { status: 'EXTRACTED', confidence: 0.4, reviewedAt: null } }),
            ],
          }),
        ],
      }),
    );
    show();
    expect(screen.getByText('expenses.extraction.reviewPromptApprover')).toBeInTheDocument();
  });

  it('stops warning once the submitter has verified the scan', () => {
    setTrpc(
      report({
        expenses: [
          expense({
            receipts: [
              receipt({
                extraction: {
                  status: 'EXTRACTED',
                  confidence: 0.4,
                  reviewedAt: '2026-07-29T12:00:00.000Z',
                },
              }),
            ],
          }),
        ],
      }),
    );
    show();
    expect(screen.queryByText('expenses.extraction.reviewPromptApprover')).not.toBeInTheDocument();
  });

  it('does not warn about a confident scan', () => {
    setTrpc(
      report({
        expenses: [
          expense({
            receipts: [
              receipt({ extraction: { status: 'EXTRACTED', confidence: 0.95, reviewedAt: null } }),
            ],
          }),
        ],
      }),
    );
    show();
    expect(screen.queryByText('expenses.extraction.reviewPromptApprover')).not.toBeInTheDocument();
    expect(screen.getByText('expenses.extraction.done')).toBeInTheDocument();
  });
});

// ── Who may decide ────────────────────────────────────────────────────────────

describe('what the approver may do', () => {
  it('offers approve, reject and return on a submitted report they hold a task on', () => {
    setTrpc();
    show();
    expect(btn('expenses.approvals.approve')).toBeInTheDocument();
    expect(btn('expenses.approvals.reject')).toBeInTheDocument();
    expect(btn('expenses.approvals.return')).toBeInTheDocument();
  });

  it('offers nothing to decide without a task on the report', () => {
    /**
     * A deep link can open a report whose task was already decided or has expired. The
     * server would refuse the decision, so offering the button is a lie.
     */
    setTrpc();
    show({ taskId: undefined });
    noBtn('expenses.approvals.approve');
    noBtn('expenses.approvals.reject');
    noBtn('expenses.approvals.return');
  });

  it('offers nothing to decide on a report that is no longer submitted', () => {
    setTrpc(report({ status: 'APPROVED' }));
    show();
    noBtn('expenses.approvals.approve');
  });

  it('offers only an acknowledgement when the task is one', () => {
    // An acknowledge node has a single outcome; reject or return would be an
    // authority it does not carry.
    setTrpc();
    show({ isAcknowledge: true });
    expect(btn('expenses.approvals.acknowledge')).toBeInTheDocument();
    noBtn('expenses.approvals.approve');
    noBtn('expenses.approvals.reject');
    noBtn('expenses.approvals.return');
  });

  it('offers no reimbursement, even to AP on an approved report (VeloExpense, d71)', () => {
    // VeloExpense: ExpenseOS offers AP "mark reimbursed" here once a report is approved.
    // VeloExpense's reimbursement screen stays the one place AP pays (d71).
    setTrpc(report({ status: 'APPROVED' }));
    show({ canReimburse: false });
    noBtn('expenses.approvals.markReimbursed');

    setTrpc(report({ status: 'APPROVED' }));
    show({ canReimburse: true });
    noBtn('expenses.approvals.markReimbursed');
  });

  it('does not offer reimbursement on a report still awaiting a decision', () => {
    setTrpc();
    show({ canReimburse: true });
    noBtn('expenses.approvals.markReimbursed');
  });
});

// ── Deciding ──────────────────────────────────────────────────────────────────

describe('deciding', () => {
  it('approves against the task, not the report', async () => {
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc(report(), { mutations: { 'expenseApprovals.decide': { onCall } } });
    show();
    await user.click(btn('expenses.approvals.approve'));
    expect(onCall).toHaveBeenCalledWith({ taskId: 'task-1', approve: true });
  });

  it('acknowledges as an approval of the acknowledge task', async () => {
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc(report(), { mutations: { 'expenseApprovals.decide': { onCall } } });
    show({ isAcknowledge: true });
    await user.click(btn('expenses.approvals.acknowledge'));
    expect(onCall).toHaveBeenCalledWith({ taskId: 'task-1', approve: true });
  });

  it('will not reject without a reason', async () => {
    /**
     * "Rejected" with no note sends the submitter back to a report with nothing to
     * fix, and the only place to say what was wrong is this box.
     */
    const user = userEvent.setup();
    setTrpc();
    show();
    await user.click(btn('expenses.approvals.reject'));
    const confirm = btn('expenses.approvals.confirmReject');
    expect(confirm).toBeDisabled();
    await user.type(screen.getByRole('textbox'), '   ');
    expect(confirm).toBeDisabled();
  });

  it('rejects with a trimmed note', async () => {
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc(report(), { mutations: { 'expenseApprovals.decide': { onCall } } });
    show();
    await user.click(btn('expenses.approvals.reject'));
    await user.type(screen.getByRole('textbox'), '  Missing the hotel folio  ');
    await user.click(btn('expenses.approvals.confirmReject'));
    expect(onCall).toHaveBeenCalledWith({
      taskId: 'task-1',
      approve: false,
      note: 'Missing the hotel folio',
    });
  });

  it('returns for edit without demanding a note', async () => {
    // A return is a nudge, not a verdict — the note is useful, not required.
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc(report(), { mutations: { 'expenseApprovals.returnForEdit': { onCall } } });
    show();
    await user.click(btn('expenses.approvals.return'));
    expect(btn('expenses.approvals.confirmReturn')).toBeEnabled();
    await user.click(btn('expenses.approvals.confirmReturn'));
    expect(onCall).toHaveBeenCalledWith({ reportId: 'rep-1', note: undefined });
  });

  it('returns against the REPORT, not the task', async () => {
    /**
     * A return unwinds the whole instance rather than deciding one step, so it is
     * addressed to the report — sending a taskId would return only that step.
     */
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc(report(), { mutations: { 'expenseApprovals.returnForEdit': { onCall } } });
    show();
    await user.click(btn('expenses.approvals.return'));
    await user.type(screen.getByRole('textbox'), 'Please split the meals');
    await user.click(btn('expenses.approvals.confirmReturn'));
    expect(onCall).toHaveBeenCalledWith({ reportId: 'rep-1', note: 'Please split the meals' });
  });

  it('abandons a note without deciding', async () => {
    const decideCall = vi.fn();
    const user = userEvent.setup();
    setTrpc(report(), { mutations: { 'expenseApprovals.decide': { onCall: decideCall } } });
    show();
    await user.click(btn('expenses.approvals.reject'));
    await user.type(screen.getByRole('textbox'), 'never mind');
    await user.click(btn('expenses.addLine.cancel'));
    expect(btn('expenses.approvals.approve')).toBeInTheDocument();
    expect(decideCall).not.toHaveBeenCalled();
  });

  it('starts the second note empty, not with the first one’s text', async () => {
    // Carrying a rejection reason into a return note attributes it to the wrong action.
    const user = userEvent.setup();
    setTrpc();
    show();
    await user.click(btn('expenses.approvals.reject'));
    await user.type(screen.getByRole('textbox'), 'Wrong currency');
    await user.click(btn('expenses.addLine.cancel'));
    await user.click(btn('expenses.approvals.return'));
    expect(screen.getByRole('textbox')).toHaveValue('');
  });

  // VeloExpense: ExpenseOS's 'marks a report reimbursed' is not carried — the drawer has no
  // reimburse action here (d71).

  it('tells the inbox to refresh once a decision lands', async () => {
    const user = userEvent.setup();
    setTrpc(report(), { mutations: { 'expenseApprovals.decide': { outcome: 'success' } } });
    show();
    await user.click(btn('expenses.approvals.approve'));
    expect(onDecided).toHaveBeenCalled();
  });

  it('reports a refused decision instead of closing as if it worked', async () => {
    const user = userEvent.setup();
    setTrpc(report(), {
      mutations: {
        'expenseApprovals.decide': {
          outcome: 'error',
          error: { message: 'Task already decided.' },
        },
      },
    });
    show();
    await user.click(btn('expenses.approvals.approve'));
    expect(await screen.findByText('Task already decided.')).toBeInTheDocument();
    expect(onDecided).not.toHaveBeenCalled();
  });

  it('holds every action while one is in flight', () => {
    setTrpc(report(), { mutations: { 'expenseApprovals.decide': { isPending: true } } });
    show();
    expect(btn('expenses.approvals.approve')).toBeDisabled();
    expect(btn('expenses.approvals.reject')).toBeDisabled();
    expect(btn('expenses.approvals.return')).toBeDisabled();
  });

  it('closes on the footer, without deciding', async () => {
    const user = userEvent.setup();
    setTrpc();
    show();
    await user.click(btn('expenses.drawer.close'));
    expect(onClose).toHaveBeenCalled();
    expect(onDecided).not.toHaveBeenCalled();
  });
});

// ── Chasing receipts before deciding ──────────────────────────────────────────

describe('asking for the missing receipts', () => {
  it('offers the ask only when something is actually missing', () => {
    setTrpc();
    show();
    noBtn('expenses.drawer.requestReceipts:1');

    setTrpc(report({ expenses: [expense({ receipts: [] })] }));
    show();
    expect(btn('expenses.drawer.requestReceipts:1')).toBeInTheDocument();
  });

  it('asks for every receiptless expense on the report at once', async () => {
    /**
     * The drawer lists expenses as cards with no selection, and "all of them" is the
     * only sensible ask when you are about to decide the report. Per-expense precision
     * lives on the AP cross-report table.
     */
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc(
      report({
        expenses: [
          expense({ receipts: [] }),
          expense({ id: 'exp-2', receipts: [receipt({ id: 'rec-2' })] }),
          expense({ id: 'exp-3', receipts: [] }),
        ],
      }),
      { mutations: { 'expenseApprovals.chaseReceipts': { onCall } } },
    );
    show();
    await user.click(btn('expenses.drawer.requestReceipts:2'));
    expect(onCall).toHaveBeenCalledWith({ expenseIds: ['exp-1', 'exp-3'] });
  });

  it('says how many were chased', async () => {
    const user = userEvent.setup();
    setTrpc(report({ expenses: [expense({ receipts: [] })] }), {
      mutations: {
        'expenseApprovals.chaseReceipts': {
          outcome: 'success',
          data: { reports: 1, expenses: 1, skipped: 0 },
        },
      },
    });
    show();
    await user.click(btn('expenses.drawer.requestReceipts:1'));
    expect(await screen.findByText('expenses.drawer.chaseSent:1')).toBeInTheDocument();
  });

  it('says nothing was sent when the server chased nobody', async () => {
    const user = userEvent.setup();
    setTrpc(report({ expenses: [expense({ receipts: [] })] }), {
      mutations: {
        'expenseApprovals.chaseReceipts': {
          outcome: 'success',
          data: { reports: 0, expenses: 0, skipped: 1 },
        },
      },
    });
    show();
    await user.click(btn('expenses.drawer.requestReceipts:1'));
    expect(await screen.findByText('expenses.drawer.chaseNone')).toBeInTheDocument();
  });

  it('reports a refused chase', async () => {
    const user = userEvent.setup();
    setTrpc(report({ expenses: [expense({ receipts: [] })] }), {
      mutations: {
        'expenseApprovals.chaseReceipts': {
          outcome: 'error',
          error: { message: 'Nothing to chase' },
        },
      },
    });
    show();
    await user.click(btn('expenses.drawer.requestReceipts:1'));
    expect(await screen.findByText('Nothing to chase')).toBeInTheDocument();
  });

  it('holds the ask while it is in flight', () => {
    setTrpc(report({ expenses: [expense({ receipts: [] })] }), {
      mutations: { 'expenseApprovals.chaseReceipts': { isPending: true } },
    });
    show();
    expect(btn('expenses.drawer.requestReceipts:1')).toBeDisabled();
  });

  it('keeps the decide actions reachable while the ask is on screen', () => {
    // Chasing is advice, not a gate — an approver may still decide.
    setTrpc(report({ expenses: [expense({ receipts: [] })] }));
    show();
    const footer = btn('expenses.drawer.requestReceipts:1').parentElement as HTMLElement;
    expect(
      within(footer).getByRole('button', { name: 'expenses.approvals.approve' }),
    ).toBeEnabled();
  });
});

// ── Fitting a phone ───────────────────────────────────────────────────────────

/**
 * jsdom does not lay out, so none of this can measure an overflow — it pins the three
 * classes that prevent one, each against a node the test first proves it has found.
 * The measurements live in the Playwright suite, which has a real viewport and can
 * force real insets over CDP (`e2e/support/safe-area.ts`); asserting a computed
 * `--safe-area-bottom` here would be green on every machine and say nothing.
 *
 * What is actually at stake: the footer row is `justify-end`, so the control an
 * unwrapped overflow pushes out of reach is the right-most one — Approve.
 */
describe('fitting a narrow panel', () => {
  it('wraps the action row instead of pushing Approve past the edge', () => {
    setTrpc();
    show();
    const row = btn('expenses.approvals.approve').parentElement as HTMLElement;
    // The row really is the one carrying the whole idle-mode action set.
    expect(within(row).getByRole('button', { name: 'expenses.drawer.close' })).toBeInTheDocument();
    expect(row).toHaveClass('flex-wrap');
  });

  it('wraps the report identity line instead of overflowing it', () => {
    setTrpc();
    show();
    const meta = screen.getByText('EXP-1042').parentElement as HTMLElement;
    // Four items on one line, the last of which is an unbounded person's name.
    expect(within(meta).getByText('· Dana Patel')).toBeInTheDocument();
    expect(meta).toHaveClass('flex-wrap');
  });

  it('lifts the footer clear of the home indicator', () => {
    /**
     * `DrawerContent` pads for the inset only on its `side='bottom'` variant, and this
     * is the right-side one — so the drawer pays for its own clearance locally, rather
     * than changing a primitive every other drawer in the product shares.
     */
    setTrpc();
    show();
    const footer = btn('expenses.approvals.approve').parentElement?.parentElement as HTMLElement;
    expect(footer).toHaveClass('border-t'); // it is the DrawerFooter, not the row
    expect(footer).toHaveClass('pb-[calc(12px_+_var(--safe-area-bottom))]');
  });
});
