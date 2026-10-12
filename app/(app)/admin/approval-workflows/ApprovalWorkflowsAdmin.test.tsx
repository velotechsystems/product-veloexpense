import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTrpcMock, type TrpcMockConfig } from '@/test-utils/trpc';
import { ApprovalWorkflowsAdmin, statusKey } from './ApprovalWorkflowsAdmin';

const h = vi.hoisted(() => ({ trpc: undefined as unknown }));
vi.mock('@/lib/trpc/client', () => ({
  get trpc() {
    return h.trpc;
  },
}));
vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
}));
const push = vi.fn();
vi.mock('@/i18n/navigation', () => ({ useRouter: () => ({ push }) }));
vi.mock('../../TopBar', () => ({ setTopBarSlot: vi.fn() }));
vi.mock('@/components/admin/AdminLookupPage', () => ({
  slugify: (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
}));

import { setTopBarSlot } from '../../TopBar';

// ── statusKey (pure) ──────────────────────────────────────────────────
describe('statusKey', () => {
  it('is noVersion when there is no current version', () => {
    expect(statusKey({ currentVersionId: null, versions: [] } as never)).toBe('noVersion');
  });
  it('is published when a current version exists with no pending draft', () => {
    expect(
      statusKey({ currentVersionId: 'v1', versions: [{ status: 'PUBLISHED' }] } as never),
    ).toBe('published');
  });
  it('is draftPending when a current version coexists with a draft', () => {
    expect(
      statusKey({
        currentVersionId: 'v1',
        versions: [{ status: 'PUBLISHED' }, { status: 'DRAFT' }],
      } as never),
    ).toBe('draftPending');
  });
});

// ── Fixtures ──────────────────────────────────────────────────────────
function wf(over: Record<string, unknown> = {}) {
  return {
    id: 'w1',
    name: 'Standard approval',
    description: null,
    subjectType: 'VIRTUAL_CARD_REQUEST',
    isDefault: false,
    active: true,
    currentVersionId: 'v1',
    versions: [{ status: 'PUBLISHED' }],
    ...over,
  };
}

function setTrpc(config: TrpcMockConfig) {
  h.trpc = createTrpcMock(config);
}
function listConfig(items: unknown[], over: TrpcMockConfig = {}): TrpcMockConfig {
  return { queries: { 'approvalWorkflows.list': { data: { items } } }, ...over };
}

afterEach(() => {
  h.trpc = undefined;
  vi.restoreAllMocks();
  push.mockClear();
});
beforeEach(() => {
  vi.mocked(setTopBarSlot).mockClear();
});

describe('<ApprovalWorkflowsAdmin>', () => {
  it('renders workflows and mounts the New button for managers', () => {
    setTrpc(listConfig([wf()]));
    render(<ApprovalWorkflowsAdmin canManage />);
    expect(screen.getByText('Standard approval')).toBeInTheDocument();
    expect(setTopBarSlot).toHaveBeenCalledWith('right', expect.anything());
    expect(screen.getByLabelText('dragToReorder')).toBeInTheDocument();
  });

  it('hides the New button, drag handles and row actions for non-managers', () => {
    setTrpc(listConfig([wf()]));
    render(<ApprovalWorkflowsAdmin canManage={false} />);
    expect(setTopBarSlot).not.toHaveBeenCalledWith('right', expect.anything());
    expect(screen.queryByLabelText('dragToReorder')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('actions.menu')).not.toBeInTheDocument();
  });

  it('does not offer a drag handle for the pinned default workflow', () => {
    setTrpc(listConfig([wf({ id: 'a' }), wf({ id: 'd', isDefault: true, name: 'Default WF' })]));
    render(<ApprovalWorkflowsAdmin canManage />);
    // only the one non-default row is draggable
    expect(screen.getAllByLabelText('dragToReorder')).toHaveLength(1);
  });

  it('reorders non-default workflows and excludes defaults from the mutation', () => {
    const onCall = vi.fn();
    setTrpc(
      listConfig(
        [
          wf({ id: 'a', name: 'Alpha' }),
          wf({ id: 'b', name: 'Beta' }),
          wf({ id: 'd', isDefault: true }),
        ],
        {
          mutations: { 'approvalWorkflows.reorder': { onCall, outcome: 'success' } },
        },
      ),
    );
    const { container } = render(<ApprovalWorkflowsAdmin canManage />);
    fireEvent.dragStart(container.querySelector('#data-row-a') as HTMLElement);
    fireEvent.dragOver(container.querySelector('#data-row-b') as HTMLElement);
    fireEvent.dragEnd(container.querySelector('#data-row-a') as HTMLElement);
    expect(onCall).toHaveBeenCalledWith({ ids: ['b', 'a'] });
  });

  it('publishes a workflow with a pending draft after confirmation', async () => {
    const user = userEvent.setup();
    const onCall = vi.fn();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    setTrpc(
      listConfig([wf({ versions: [{ status: 'PUBLISHED' }, { status: 'DRAFT' }] })], {
        mutations: { 'approvalWorkflows.publish': { onCall, outcome: 'success' } },
      }),
    );
    render(<ApprovalWorkflowsAdmin canManage />);
    await user.click(screen.getByLabelText('actions.menu'));
    await user.click(await screen.findByText('actions.publish'));
    expect(onCall).toHaveBeenCalledWith({ workflowId: 'w1' });
  });

  it('toggles active state from the row menu', async () => {
    const user = userEvent.setup();
    const onCall = vi.fn();
    setTrpc(
      listConfig([wf({ active: true })], {
        mutations: { 'approvalWorkflows.setMeta': { onCall, outcome: 'success' } },
      }),
    );
    render(<ApprovalWorkflowsAdmin canManage />);
    await user.click(screen.getByLabelText('actions.menu'));
    await user.click(await screen.findByText('actions.deactivate'));
    expect(onCall).toHaveBeenCalledWith({ id: 'w1', active: false });
  });

  it('surfaces a mutation error in the banner', async () => {
    const user = userEvent.setup();
    setTrpc(
      listConfig([wf({ active: true })], {
        mutations: {
          'approvalWorkflows.setMeta': { outcome: 'error', error: { message: 'Boom' } },
        },
      }),
    );
    render(<ApprovalWorkflowsAdmin canManage />);
    await user.click(screen.getByLabelText('actions.menu'));
    await user.click(await screen.findByText('actions.deactivate'));
    expect(screen.getByText('Boom')).toBeInTheDocument();
  });

  it('renders empty and loading states', () => {
    setTrpc(listConfig([]));
    const { rerender } = render(<ApprovalWorkflowsAdmin canManage />);
    expect(screen.getByText('list.empty')).toBeInTheDocument();

    setTrpc({ queries: { 'approvalWorkflows.list': { isLoading: true } } });
    rerender(<ApprovalWorkflowsAdmin canManage />);
    expect(screen.queryByText('Standard approval')).not.toBeInTheDocument();
  });
});

// ── The two dialogs ───────────────────────────────────────────────────

/**
 * Neither dialog was reachable from a test, and between them they own every write this page
 * makes. Two rules carry the weight.
 *
 * **The key is derived from the name and never shown.** It is the workflow's stable
 * identifier — `callWorkflow` nodes reference it — so it has to satisfy the server's
 * `[a-z0-9-]{2,64}` before the button is offered. A name that slugifies to nothing (all
 * punctuation, or one character) must disable Create rather than produce a rejected write
 * whose error mentions a field the admin cannot see.
 *
 * **Editing meta is not editing the graph.** `setMeta` carries name, description and the
 * default flag; sending anything else here would let a rename touch routing.
 */

/** Render the node the page handed to the top bar — that is where New lives. */
function topBarNode() {
  const call = vi.mocked(setTopBarSlot).mock.calls.find((c) => c[0] === 'right');
  return call?.[1] as React.ReactNode;
}

describe('the create dialog', () => {
  const openCreate = async (user: ReturnType<typeof userEvent.setup>) => {
    render(topBarNode() as React.ReactElement);
    await user.click(screen.getByText('list.newWorkflow'));
  };

  it('derives the key from the name, so an admin never types one', async () => {
    const user = userEvent.setup();
    const onCall = vi.fn();
    setTrpc(
      listConfig([wf()], {
        mutations: { 'approvalWorkflows.create': { onCall, outcome: 'success' } },
      }),
    );
    render(<ApprovalWorkflowsAdmin canManage />);
    await openCreate(user);
    fireEvent.change(screen.getByLabelText(/create\.name/), {
      target: { value: 'Capital Expenditure  Review!' },
    });
    await user.click(screen.getByText('create.submit'));
    expect(onCall).toHaveBeenCalledWith({
      name: 'Capital Expenditure  Review!',
      key: 'capital-expenditure-review-',
      description: undefined,
      // VeloExpense: EXPENSE_REPORT, the only subject (ExpenseOS: VIRTUAL_CARD_REQUEST).
      subjectType: 'EXPENSE_REPORT',
      isDefault: false,
    });
  });

  it('refuses to submit until there is a name', async () => {
    const user = userEvent.setup();
    setTrpc(listConfig([wf()]));
    render(<ApprovalWorkflowsAdmin canManage />);
    await openCreate(user);
    expect(screen.getByText('create.submit').closest('button')).toBeDisabled();
  });

  it('refuses a name that slugifies to nothing usable', async () => {
    /**
     * The server requires two or more `[a-z0-9-]`. A name of punctuation, or of one
     * character, passes "is not empty" and fails the key rule — and the rejection would
     * name `key`, a field this form deliberately never shows.
     */
    const user = userEvent.setup();
    setTrpc(listConfig([wf()]));
    render(<ApprovalWorkflowsAdmin canManage />);
    await openCreate(user);
    for (const bad of ['!!!', 'A']) {
      fireEvent.change(screen.getByLabelText(/create\.name/), { target: { value: bad } });
      expect(screen.getByText('create.submit').closest('button'), bad).toBeDisabled();
    }
  });

  it('sends a description only when one was typed', async () => {
    /** An empty textarea is "no description", not the empty string — which would overwrite
     *  nothing with something and render as a blank line in the list. */
    const user = userEvent.setup();
    const onCall = vi.fn();
    setTrpc(
      listConfig([wf()], {
        mutations: { 'approvalWorkflows.create': { onCall, outcome: 'success' } },
      }),
    );
    render(<ApprovalWorkflowsAdmin canManage />);
    await openCreate(user);
    fireEvent.change(screen.getByLabelText(/create\.name/), { target: { value: 'Standard' } });
    fireEvent.change(screen.getByLabelText(/create\.description/), { target: { value: '  ' } });
    await user.click(screen.getByText('create.submit'));
    expect(onCall.mock.calls[0][0]).toMatchObject({ description: undefined });
  });

  it('carries the default flag', async () => {
    const user = userEvent.setup();
    const onCall = vi.fn();
    setTrpc(
      listConfig([wf()], {
        mutations: { 'approvalWorkflows.create': { onCall, outcome: 'success' } },
      }),
    );
    render(<ApprovalWorkflowsAdmin canManage />);
    await openCreate(user);
    fireEvent.change(screen.getByLabelText(/create\.name/), { target: { value: 'Standard' } });
    await user.click(screen.getByLabelText(/create\.isDefault/));
    await user.click(screen.getByText('create.submit'));
    expect(onCall.mock.calls[0][0]).toMatchObject({ isDefault: true });
  });

  it('reports a refusal in the dialog rather than closing over it', async () => {
    /** A duplicate key is the common one, and closing the dialog would lose what was typed. */
    const user = userEvent.setup();
    setTrpc(
      listConfig([wf()], {
        mutations: {
          'approvalWorkflows.create': {
            outcome: 'error',
            error: { message: 'A workflow with that key already exists.' },
          },
        },
      }),
    );
    render(<ApprovalWorkflowsAdmin canManage />);
    await openCreate(user);
    fireEvent.change(screen.getByLabelText(/create\.name/), { target: { value: 'Standard' } });
    await user.click(screen.getByText('create.submit'));
    expect(screen.getByText('A workflow with that key already exists.')).toBeInTheDocument();
    expect(screen.getByLabelText(/create\.name/)).toHaveValue('Standard');
  });

  it('locks the button while the write is in flight', async () => {
    const user = userEvent.setup();
    setTrpc(
      listConfig([wf()], {
        mutations: { 'approvalWorkflows.create': { isPending: true } },
      }),
    );
    render(<ApprovalWorkflowsAdmin canManage />);
    await openCreate(user);
    fireEvent.change(screen.getByLabelText(/create\.name/), { target: { value: 'Standard' } });
    expect(screen.getByText('create.submitting').closest('button')).toBeDisabled();
  });

  it('closes on cancel', async () => {
    const user = userEvent.setup();
    setTrpc(listConfig([wf()]));
    render(<ApprovalWorkflowsAdmin canManage />);
    await openCreate(user);
    await user.click(screen.getByText('create.cancel'));
    expect(screen.queryByText('create.title')).not.toBeInTheDocument();
  });
});

describe('the edit-meta dialog', () => {
  const openMeta = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(screen.getByLabelText('actions.menu'));
    await user.click(await screen.findByText('actions.editMeta'));
  };

  it('opens with the workflow’s current values', async () => {
    const user = userEvent.setup();
    setTrpc(listConfig([wf({ description: 'Two-tier', isDefault: true })]));
    render(<ApprovalWorkflowsAdmin canManage />);
    await openMeta(user);
    expect(screen.getByLabelText(/create\.name/)).toHaveValue('Standard approval');
    expect(screen.getByLabelText(/create\.description/)).toHaveValue('Two-tier');
    expect(screen.getByLabelText(/create\.isDefault/)).toBeChecked();
  });

  it('shows an absent description as empty, not as "null"', async () => {
    const user = userEvent.setup();
    setTrpc(listConfig([wf({ description: null })]));
    render(<ApprovalWorkflowsAdmin canManage />);
    await openMeta(user);
    expect(screen.getByLabelText(/create\.description/)).toHaveValue('');
  });

  it('saves the meta and nothing else', async () => {
    /** Renaming a workflow must not be able to touch its graph or its key — the key is
     *  referenced by `callWorkflow` nodes elsewhere. */
    const user = userEvent.setup();
    const onCall = vi.fn();
    setTrpc(
      listConfig([wf({ description: 'old' })], {
        mutations: { 'approvalWorkflows.setMeta': { onCall, outcome: 'success' } },
      }),
    );
    render(<ApprovalWorkflowsAdmin canManage />);
    await openMeta(user);
    fireEvent.change(screen.getByLabelText(/create\.name/), { target: { value: '  Renamed  ' } });
    await user.click(screen.getByText('meta.save'));
    expect(onCall).toHaveBeenCalledWith({
      id: 'w1',
      name: 'Renamed',
      description: 'old',
      isDefault: false,
    });
  });

  it('clears a description to null rather than to an empty string', async () => {
    /** Null is "no description"; '' would render as a blank line under the name. */
    const user = userEvent.setup();
    const onCall = vi.fn();
    setTrpc(
      listConfig([wf({ description: 'old' })], {
        mutations: { 'approvalWorkflows.setMeta': { onCall, outcome: 'success' } },
      }),
    );
    render(<ApprovalWorkflowsAdmin canManage />);
    await openMeta(user);
    fireEvent.change(screen.getByLabelText(/create\.description/), { target: { value: '   ' } });
    await user.click(screen.getByText('meta.save'));
    expect(onCall.mock.calls[0][0]).toMatchObject({ description: null });
  });

  it('reports a refusal in the dialog', async () => {
    const user = userEvent.setup();
    setTrpc(
      listConfig([wf()], {
        mutations: {
          'approvalWorkflows.setMeta': {
            outcome: 'error',
            error: { message: 'Only one workflow per subject can be the default.' },
          },
        },
      }),
    );
    render(<ApprovalWorkflowsAdmin canManage />);
    await openMeta(user);
    await user.click(screen.getByText('meta.save'));
    expect(
      screen.getByText('Only one workflow per subject can be the default.'),
    ).toBeInTheDocument();
  });

  it('locks the button while saving', async () => {
    const user = userEvent.setup();
    setTrpc(
      listConfig([wf()], { mutations: { 'approvalWorkflows.setMeta': { isPending: true } } }),
    );
    render(<ApprovalWorkflowsAdmin canManage />);
    await openMeta(user);
    expect(screen.getByText('meta.saving').closest('button')).toBeDisabled();
  });

  it('closes on cancel', async () => {
    const user = userEvent.setup();
    setTrpc(listConfig([wf()]));
    render(<ApprovalWorkflowsAdmin canManage />);
    await openMeta(user);
    await user.click(screen.getByText('create.cancel'));
    expect(screen.queryByText('meta.title')).not.toBeInTheDocument();
  });
});

/**
 * Every approval subject type has a label, in every locale.
 *
 * `t(`subject.${w.subjectType}`)` is interpolated, so `check-used-keys` cannot see it and
 * next-intl throws MISSING_MESSAGE at RENDER when one is absent — taking the whole admin
 * page down rather than showing a blank cell.
 *
 * It happened twice over. `VIRTUAL_CARD_LIMIT_INCREASE` shipped a seeded workflow with no
 * label, and `TRAVEL_REQUEST` did the same the moment a travel workflow was seeded. Both
 * only surfaced as `MISSING_MESSAGE` in a Playwright run's server log.
 *
 * Driven from the Prisma enum, so the next subject type cannot be added without a label.
 */
describe('every approval subject type is labelled', () => {
  const LOCALES = ['en', 'fr-CA'] as const;

  /** The enum as the schema defines it — the authority on what can reach the page.
   *  VeloExpense: `subject_type` is text under a CHECK (0058), so the authority is the
   *  CHECK — every value a row could carry, travel's reserved one included. */
  async function subjectTypes(): Promise<string[]> {
    const { readFileSync } = await import('node:fs');
    const sql = readFileSync(
      'prisma/migrations/0058_approval_workflow_engine/migration.sql',
      'utf8',
    );
    const block = /CONSTRAINT approval_workflow_subject_type\s+CHECK \(subject_type IN \(([^)]*)\)\)/.exec(sql);
    expect(block, 'approval_workflow_subject_type should exist in 0058').toBeTruthy();
    return (block?.[1] ?? '')
      .split(',')
      .map((v) => v.trim().replace(/^'|'$/g, ''))
      .filter((v) => /^[A-Z][A-Z0-9_]*$/.test(v));
  }

  for (const locale of LOCALES) {
    it(`${locale} labels all of them`, async () => {
      const { readFileSync } = await import('node:fs');
      const catalog = JSON.parse(
        readFileSync(`packages/i18n/src/catalogs/${locale}/workflows.json`, 'utf8'),
      ) as { subject: Record<string, string> };

      const types = await subjectTypes();
      expect(types.length).toBeGreaterThan(1);
      for (const type of types) {
        expect(catalog.subject[type], `${locale}: workflows.subject.${type}`).toBeTruthy();
      }
    });
  }
});
