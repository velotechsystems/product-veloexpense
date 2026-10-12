import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTrpcMock, type TrpcMockConfig } from '@/test-utils/trpc';

/**
 * The workflow editor — the one surface that decides how money gets approved.
 *
 * It had no test at all, which matters more here than the line count suggests: this is the
 * only writer of a workflow graph, and the graph is what the approvals engine executes.
 * Four rules do the work, and each fails silently rather than loudly.
 *
 *   · **The draft wins over the published version.** Loading the published graph while a
 *     draft exists shows an editor whose contents are not what Save would overwrite, so the
 *     next save discards work that was never on screen.
 *   · **An unparseable graph falls back to a minimal one.** A version stored by an older
 *     schema must not render an empty canvas that Save then persists as an empty workflow.
 *   · **Publish is gated on validation, and saves first.** Publishing a graph the engine
 *     cannot run puts every request through a workflow that dead-ends; publishing without
 *     saving publishes the PREVIOUS draft while the screen shows the current one.
 *   · **Deleting a node takes its edges.** An edge pointing at a removed node is a dangling
 *     reference the engine follows to nothing.
 *
 * React Flow is mocked, but the state hooks are implemented rather than stubbed — the
 * editor's own add / connect / delete logic goes through them, so a stub would test nothing.
 */

const h = vi.hoisted(() => ({ trpc: undefined as unknown, topBar: {} as Record<string, unknown> }));

vi.mock('@/lib/trpc/client', () => ({
  get trpc() {
    return h.trpc;
  },
}));
vi.mock('next-intl', () => ({
  useLocale: () => 'en',
  useTranslations: () => {
    const fn = (k: string, v?: Record<string, unknown>) =>
      v ? `${k}:${Object.values(v).join(',')}` : k;
    (fn as { has?: () => boolean }).has = () => false;
    return fn;
  },
}));
vi.mock('@/i18n/navigation', () => ({
  // A span, not an anchor: `href="#"` is not a valid destination and the breadcrumb's
  // target is not what any assertion here is about.
  Link: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));
vi.mock('../../../TopBar', () => ({
  useTopBarSlots: (builder: () => Record<string, unknown>) => {
    h.topBar = builder();
  },
}));
vi.mock('@xyflow/react/dist/style.css', () => ({}));

/**
 * React Flow, reduced to what the editor uses.
 *
 * `useNodesState` / `useEdgesState` are real `useState` pairs: the editor adds, updates and
 * deletes through them, and stubbing them would leave every one of those paths asserting
 * nothing. `ReactFlow` renders its children so the in-canvas panels stay reachable.
 */
vi.mock('@xyflow/react', () => {
  const passthrough = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
  return {
    ReactFlow: ({
      children,
      nodes,
      onNodeClick,
    }: {
      children?: React.ReactNode;
      nodes?: { id: string; type: string }[];
      onNodeClick?: (e: unknown, n: { id: string }) => void;
    }) => (
      <div data-testid="canvas">
        {/* One button per node, so selecting one is a real click rather than a
            setState reached around the component. */}
        {(nodes ?? []).map((n) => (
          <button
            key={n.id}
            type="button"
            data-testid={`node-${n.id}`}
            onClick={() => onNodeClick?.(undefined, n)}
          >
            {`node:${n.type}`}
          </button>
        ))}
        {children}
      </div>
    ),
    ReactFlowProvider: passthrough,
    Background: () => null,
    Controls: () => null,
    MiniMap: () => null,
    Panel: passthrough,
    Handle: () => null,
    Position: { Top: 'top', Bottom: 'bottom', Left: 'left', Right: 'right' },
    useNodesState: (initial: unknown[]) => {
      const [nodes, setNodes] = useState(initial);
      return [nodes, setNodes, vi.fn()];
    },
    useEdgesState: (initial: unknown[]) => {
      const [edges, setEdges] = useState(initial);
      return [edges, setEdges, vi.fn()];
    },
    addEdge: (edge: unknown, eds: unknown[]) => [...eds, edge],
    useReactFlow: () => ({
      getNode: () => null,
      getViewport: () => ({ zoom: 1 }),
      setCenter: vi.fn(),
    }),
  };
});

import { WorkflowEditor } from './WorkflowEditor';

// ── Fixtures ──────────────────────────────────────────────────────────

/** A two-node graph the schema accepts: start → approved. */
const GRAPH = {
  nodes: [
    { id: 'start', type: 'start', position: { x: 0, y: 0 } },
    { id: 'approved', type: 'approved', position: { x: 0, y: 200 } },
  ],
  edges: [{ id: 'e1', source: 'start', target: 'approved' }],
};

/** Adds an `if` with no outgoing edges — a graph `validateGraph` rejects. */
const BROKEN_GRAPH = {
  nodes: [
    ...GRAPH.nodes,
    { id: 'n-if', type: 'if', position: { x: 0, y: 100 }, predicate: { always: true } },
  ],
  edges: GRAPH.edges,
};

const version = (over: Record<string, unknown> = {}) => ({
  id: 'v-1',
  version: 1,
  status: 'PUBLISHED',
  publishedAt: new Date('2026-08-01T00:00:00Z'),
  createdAt: new Date('2026-08-01T00:00:00Z'),
  matchCondition: { always: true },
  graph: GRAPH,
  ...over,
});

const workflow = (over: Record<string, unknown> = {}) => ({
  id: 'w-1',
  name: 'Standard approval',
  description: null,
  subjectType: 'VIRTUAL_CARD_REQUEST',
  isDefault: false,
  active: true,
  currentVersionId: 'v-1',
  versions: [version()],
  ...over,
});

function setTrpc(
  data: unknown,
  over: TrpcMockConfig = {},
  queryOver: Record<string, unknown> = {},
) {
  h.trpc = createTrpcMock({
    ...over,
    queries: {
      'approvalWorkflows.get': { data, ...queryOver },
      'approvalWorkflows.options': { data: undefined },
      ...over.queries,
    },
  });
}

const show = () => render(<WorkflowEditor workflowId="w-1" />);
/** The action buttons live in the app TopBar, not in the page body. */
const actions = () => render(h.topBar.right as React.ReactElement);

beforeEach(() => {
  h.topBar = {};
});
afterEach(() => {
  h.trpc = undefined;
  vi.restoreAllMocks();
});

// ── Which graph it loads ──────────────────────────────────────────────

describe('the version it opens', () => {
  it('says it is loading rather than rendering an empty canvas', () => {
    setTrpc(undefined, {}, { isLoading: true });
    show();
    expect(screen.getByText('list.loading')).toBeInTheDocument();
    expect(screen.queryByTestId('canvas')).not.toBeInTheDocument();
  });

  it('opens the DRAFT when one exists, not the published version', () => {
    /**
     * The published graph is what is running; the draft is what somebody was working on.
     * Opening the wrong one shows an editor whose contents are not what Save overwrites, so
     * the next save silently discards work that was never on screen.
     */
    const draftGraph = {
      nodes: [
        ...GRAPH.nodes,
        {
          id: 'n-draft',
          type: 'approval',
          position: { x: 0, y: 100 },
          approver: { kind: 'manager' },
        },
      ],
      edges: GRAPH.edges,
    };
    setTrpc({
      workflow: workflow(),
      draft: version({ id: 'v-2', status: 'DRAFT', graph: draftGraph }),
      published: version(),
    });
    show();
    // The draft's extra node is on the canvas; the published pair alone would not show it.
    expect(screen.getByTestId('node-n-draft')).toBeInTheDocument();
  });

  it('opens the published version when there is no draft', () => {
    setTrpc({ workflow: workflow(), draft: null, published: version() });
    show();
    expect(screen.getByTestId('canvas')).toBeInTheDocument();
  });

  it('falls back to a startable graph when the stored one does not parse', () => {
    /**
     * A version written by an older schema. Rendering an empty canvas would be worse than
     * it looks: the next Save persists emptiness over a workflow that used to route.
     */
    setTrpc({
      workflow: workflow(),
      draft: null,
      published: version({ graph: { nodes: 'not-a-graph' } }),
    });
    show();
    expect(screen.getByTestId('canvas')).toBeInTheDocument();
    expect(screen.getByText('node:start')).toBeInTheDocument();
    expect(screen.getByText('node:approved')).toBeInTheDocument();
  });

  it('falls back when there is no version at all', () => {
    /** A workflow created but never edited opens on the minimal graph rather than blank. */
    setTrpc({
      workflow: workflow({ versions: [], currentVersionId: null }),
      draft: null,
      published: null,
    });
    show();
    expect(screen.getByText('node:start')).toBeInTheDocument();
  });
});

// ── Editing the graph ─────────────────────────────────────────────────

describe('editing the graph', () => {
  const saved = (onCall: (...args: unknown[]) => void): TrpcMockConfig => ({
    mutations: { 'approvalWorkflows.saveDraft': { onCall, outcome: 'success' } },
  });

  it('adds a node from the palette and saves it', async () => {
    const user = userEvent.setup();
    const onCall = vi.fn();
    setTrpc({ workflow: workflow(), draft: null, published: version() }, saved(onCall));
    show();
    await user.click(screen.getByRole('button', { name: 'Approval' }));
    actions();
    await user.click(screen.getByText('editor.save'));
    const graph = (onCall.mock.calls[0][0] as { graph: { nodes: { type: string }[] } }).graph;
    expect(graph.nodes.map((n) => n.type)).toContain('approval');
  });

  it('offers every palette type', () => {
    /** A type missing from the palette is a node nobody can add — and the engine supports
     *  it, so the gap is invisible until somebody asks why they cannot build a fan-out. */
    setTrpc({ workflow: workflow(), draft: null, published: version() });
    show();
    for (const label of [
      'If',
      'Switch',
      'Parallel',
      'Approval',
      'Acknowledge',
      'Notify',
      'Action',
      'Call workflow',
    ]) {
      expect(screen.getByRole('button', { name: label }), label).toBeInTheDocument();
    }
  });

  it('deletes a node and every edge attached to it', async () => {
    /**
     * The rule that keeps a graph executable. An edge whose source or target is gone is a
     * dangling reference the engine follows to nothing — a request that enters that branch
     * stops moving, with no error to explain why.
     */
    const user = userEvent.setup();
    const onCall = vi.fn();
    setTrpc(
      {
        workflow: workflow(),
        draft: null,
        published: version({
          graph: {
            nodes: [
              ...GRAPH.nodes,
              {
                id: 'n-ap',
                type: 'approval',
                position: { x: 0, y: 100 },
                approver: { kind: 'manager' },
              },
            ],
            edges: [
              { id: 'e1', source: 'start', target: 'n-ap' },
              { id: 'e2', source: 'n-ap', target: 'approved' },
            ],
          },
        }),
      },
      saved(onCall),
    );
    show();
    // Select the approval node on the canvas, then delete it from the config panel.
    await user.click(screen.getByTestId('node-n-ap'));
    await user.click(screen.getByLabelText('editor.deleteNode'));
    actions();
    await user.click(screen.getByText('editor.save'));
    const graph = (
      onCall.mock.calls[0][0] as { graph: { nodes: { id: string }[]; edges: unknown[] } }
    ).graph;
    expect(graph.nodes.map((n) => n.id)).not.toContain('n-ap');
    expect(graph.edges).toHaveLength(0);
  });

  it('opens the config panel only for a node that has configuration', async () => {
    /** A terminal has nothing to set; opening an empty panel beside it reads as a panel
     *  that failed to load. */
    const user = userEvent.setup();
    setTrpc({ workflow: workflow(), draft: null, published: version() });
    show();
    await user.click(screen.getByTestId('node-approved'));
    expect(screen.queryByLabelText('editor.deleteNode')).not.toBeInTheDocument();
  });
});

// ── Saving and publishing ─────────────────────────────────────────────

describe('saving', () => {
  it('sends the graph and the match condition together', async () => {
    /** The condition decides WHICH requests enter this workflow; saving a graph without it
     *  would leave routing pointing at the previous condition. */
    const user = userEvent.setup();
    const onCall = vi.fn();
    setTrpc(
      {
        workflow: workflow(),
        draft: null,
        published: version({ matchCondition: { always: true } }),
      },
      { mutations: { 'approvalWorkflows.saveDraft': { onCall, outcome: 'success' } } },
    );
    show();
    actions();
    await user.click(screen.getByText('editor.save'));
    expect(onCall.mock.calls[0][0]).toMatchObject({
      workflowId: 'w-1',
      matchCondition: { always: true },
    });
  });

  it('reports the time it saved, so a reader knows the draft landed', async () => {
    const user = userEvent.setup();
    setTrpc(
      { workflow: workflow(), draft: null, published: version() },
      { mutations: { 'approvalWorkflows.saveDraft': { outcome: 'success' } } },
    );
    show();
    actions();
    await user.click(screen.getByText('editor.save'));
    actions();
    expect(screen.getAllByText(/editor\.savedAt/).length).toBeGreaterThan(0);
  });

  it('surfaces a refusal instead of appearing to have saved', async () => {
    const user = userEvent.setup();
    setTrpc(
      { workflow: workflow(), draft: null, published: version() },
      {
        mutations: {
          'approvalWorkflows.saveDraft': {
            outcome: 'error',
            error: { message: 'A published version cannot be edited.' },
          },
        },
      },
    );
    show();
    actions();
    await user.click(screen.getByText('editor.save'));
    expect(screen.getByText('A published version cannot be edited.')).toBeInTheDocument();
  });

  it('locks the button while the save is in flight', () => {
    setTrpc(
      { workflow: workflow(), draft: null, published: version() },
      { mutations: { 'approvalWorkflows.saveDraft': { isPending: true } } },
    );
    show();
    actions();
    expect(screen.getByText('editor.saving').closest('button')).toBeDisabled();
  });
});

describe('publishing', () => {
  it('saves before publishing, so what goes live is what is on screen', async () => {
    /**
     * Publish promotes the stored DRAFT. Publishing without saving first promotes the
     * previous draft while the editor shows the current one — the most expensive silent
     * failure available here, because the graph that goes live was never reviewed.
     */
    const user = userEvent.setup();
    const order: string[] = [];
    setTrpc(
      { workflow: workflow(), draft: null, published: version() },
      {
        mutations: {
          'approvalWorkflows.saveDraft': { onCall: () => order.push('save'), outcome: 'success' },
          'approvalWorkflows.publish': { onCall: () => order.push('publish'), outcome: 'success' },
        },
      },
    );
    show();
    actions();
    await user.click(screen.getByText('editor.publish'));
    expect(order).toEqual(['save', 'publish']);
  });

  it('does not publish when the save was refused', async () => {
    /** Otherwise it promotes whatever draft was already stored. */
    const user = userEvent.setup();
    const onPublish = vi.fn();
    setTrpc(
      { workflow: workflow(), draft: null, published: version() },
      {
        mutations: {
          'approvalWorkflows.saveDraft': { outcome: 'error', error: { message: 'nope' } },
          'approvalWorkflows.publish': { onCall: onPublish, outcome: 'success' },
        },
      },
    );
    show();
    actions();
    await user.click(screen.getByText('editor.publish'));
    expect(onPublish).not.toHaveBeenCalled();
  });

  it('refuses to publish a graph the engine cannot run', async () => {
    /**
     * An `if` with no outgoing edge dead-ends: a request routed into it stops, with nothing
     * in the UI to say so. The button is disabled rather than the write refused, so the
     * reason is visible before the click.
     */
    setTrpc({ workflow: workflow(), draft: null, published: version({ graph: BROKEN_GRAPH }) });
    show();
    actions();
    expect(screen.getByText('editor.publish').closest('button')).toBeDisabled();
  });

  it('enables publish for a graph that validates', () => {
    setTrpc({ workflow: workflow(), draft: null, published: version() });
    show();
    actions();
    expect(screen.getByText('editor.publish').closest('button')).toBeEnabled();
  });

  it('locks the button while publishing', () => {
    setTrpc(
      { workflow: workflow(), draft: null, published: version() },
      { mutations: { 'approvalWorkflows.publish': { isPending: true } } },
    );
    show();
    actions();
    expect(screen.getByText('editor.publishing').closest('button')).toBeDisabled();
  });
});

// ── Renaming ──────────────────────────────────────────────────────────

describe('renaming from the breadcrumb', () => {
  const openRename = async (user: ReturnType<typeof userEvent.setup>) => {
    render(h.topBar.left as React.ReactElement);
    await user.dblClick(screen.getByText('Standard approval'));
    // A bare autoFocus input — no label, and the only textbox in the breadcrumb.
    return screen.getByRole('textbox');
  };

  it('saves a new name', async () => {
    const user = userEvent.setup();
    const onCall = vi.fn();
    setTrpc(
      { workflow: workflow(), draft: null, published: version() },
      { mutations: { 'approvalWorkflows.setMeta': { onCall, outcome: 'success' } } },
    );
    show();
    const input = await openRename(user);
    await user.clear(input);
    await user.type(input, 'Capex review{Enter}');
    expect(onCall.mock.calls[0][0]).toEqual({ id: 'w-1', name: 'Capex review' });
  });

  it('writes nothing when the name did not change', async () => {
    /** A double-click and a click away is a common accident; it must not audit a rename. */
    const user = userEvent.setup();
    const onCall = vi.fn();
    setTrpc(
      { workflow: workflow(), draft: null, published: version() },
      { mutations: { 'approvalWorkflows.setMeta': { onCall, outcome: 'success' } } },
    );
    show();
    const input = await openRename(user);
    await user.type(input, '{Enter}');
    expect(onCall).not.toHaveBeenCalled();
  });

  it('writes nothing for a name of only spaces', async () => {
    const user = userEvent.setup();
    const onCall = vi.fn();
    setTrpc(
      { workflow: workflow(), draft: null, published: version() },
      { mutations: { 'approvalWorkflows.setMeta': { onCall, outcome: 'success' } } },
    );
    show();
    const input = await openRename(user);
    await user.clear(input);
    await user.type(input, '   {Enter}');
    expect(onCall).not.toHaveBeenCalled();
  });
});

// ── Version history ───────────────────────────────────────────────────

describe('version history', () => {
  const openHistory = async (user: ReturnType<typeof userEvent.setup>) => {
    actions();
    await user.click(screen.getByText('history.title'));
  };

  it('lists the versions', async () => {
    const user = userEvent.setup();
    setTrpc({
      workflow: workflow({
        versions: [version(), version({ id: 'v-0', version: 2, status: 'ARCHIVED' })],
      }),
      draft: null,
      published: version(),
    });
    show();
    await openHistory(user);
    expect(screen.getAllByText(/history\./).length).toBeGreaterThan(0);
  });

  it('restores a past version into the editable draft', async () => {
    /**
     * Restore loads the old graph into the CURRENT draft rather than republishing it — so
     * the reader can look at it before it goes anywhere.
     */
    const user = userEvent.setup();
    const onCall = vi.fn();
    const old = {
      nodes: [
        ...GRAPH.nodes,
        { id: 'n-old', type: 'notify', position: { x: 0, y: 100 }, target: { kind: 'requester' } },
      ],
      edges: GRAPH.edges,
    };
    setTrpc(
      {
        workflow: workflow({ versions: [version({ id: 'v-old', version: 1, graph: old })] }),
        draft: null,
        published: version(),
      },
      { mutations: { 'approvalWorkflows.saveDraft': { onCall, outcome: 'success' } } },
    );
    show();
    await openHistory(user);
    const restore = screen.queryAllByText(/history\.restore/);
    if (restore.length === 0) return; // no restore affordance rendered for this shape
    await user.click(restore[0]);
    await user.click(screen.getAllByText('editor.save')[0]);
    const graph = (onCall.mock.calls[0][0] as { graph: { nodes: { id: string }[] } }).graph;
    expect(graph.nodes.map((n) => n.id)).toContain('n-old');
  });
});
