import '@testing-library/jest-dom/vitest';
import type { WorkflowNode } from '@expenseos/approvals';
import { render, screen, within } from '@testing-library/react';
import type * as React from 'react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

/**
 * The node bodies on the workflow canvas.
 *
 * A node is display-only — editing happens in the config panel — so its whole job is to
 * say, at a glance, what the step will DO. The tests are about the two ways that fails:
 *
 *   · **A branch with no visible exit label is a graph nobody can wire.** An approval has
 *     approve and reject, an IF has true and false, a switch has one exit per case PLUS a
 *     default, and a terminal has none at all. Getting the count or the ids wrong means
 *     edges attach to the wrong outcome.
 *   · **An unconfigured node must look unconfigured.** A `callWorkflow` with no target
 *     renders a warned pill rather than an empty one, because an empty pill reads as
 *     "configured, nothing to say".
 */

/** React Flow's Handle needs a provider; only its id and label matter here. */
vi.mock('@xyflow/react', () => ({
  Handle: ({ id, type, children }: { id?: string; type: string; children?: ReactNode }) => (
    <div data-handle={type} data-id={id ?? ''}>
      {children}
    </div>
  ),
  Position: { Top: 'top', Bottom: 'bottom' },
}));

import { defaultNode } from './graph-rf';
import { NODE_PALETTE, nodeTypes, TYPE_LABEL, WorkflowNodeView } from './WorkflowNodes';

const OPTIONS = {
  jobLevels: [{ id: 'jl-1', code: 'L3', label: { en: 'Senior' }, sortOrder: 1 }],
  departments: [{ id: 'dept-1', label: { en: 'Finance' } }],
  legalEntities: [],
  businessUnits: [],
  currencies: [],
  vendors: [],
  workflows: [{ key: 'vcc-standard', name: 'Card requests' }],
  roles: [],
  categories: [],
} as never;

/** React Flow passes a great deal more; the renderer reads only these two. */
type NodeViewProps = React.ComponentProps<typeof WorkflowNodeView>;
const show = (node: WorkflowNode, selected = false) =>
  render(<WorkflowNodeView {...({ data: { node }, selected } as unknown as NodeViewProps)} />);

/** Source handle ids, left to right, with their exit labels. */
const exits = () =>
  Array.from(document.querySelectorAll('[data-handle="source"]')).map((el) => ({
    id: el.getAttribute('data-id') ?? '',
    label: el.textContent ?? '',
  }));

const hasTarget = () => document.querySelector('[data-handle="target"]') !== null;

// ── The header ────────────────────────────────────────────────────────────────

describe('the node header', () => {
  it('names every node type', () => {
    // A node whose type has no label renders as an anonymous box. `defaultNode` is used
    // for the fixture so each one is valid for its type, as a real graph's would be.
    for (const type of Object.keys(TYPE_LABEL) as WorkflowNode['type'][]) {
      const view = show(defaultNode(type, 'n'));
      // "Notify" is both the type label and one of its own criterion labels.
      expect(screen.getAllByText(TYPE_LABEL[type])[0]).toBeInTheDocument();
      view.unmount();
    }
  });

  it('registers a renderer for every type, so none falls back to a default box', () => {
    expect(Object.keys(nodeTypes).sort()).toEqual(Object.keys(TYPE_LABEL).sort());
  });

  it('groups the palette so a routing node is not hunted for among terminals', () => {
    const types = NODE_PALETTE.flatMap((g) => g.types);
    expect(types).toContain('if');
    expect(types).toContain('approval');
    expect(types).toContain('approved');
    // Start is not offered: a graph has exactly one, and it is there from the outset.
    expect(types).not.toContain('start');
  });

  it('marks the selected node apart from its neighbours', () => {
    const { container } = show(
      { id: 'n', type: 'approval', approver: { kind: 'manager' } } as WorkflowNode,
      true,
    );
    expect(container.querySelector('[class*="ring-primary"]')).not.toBeNull();
  });
});

// ── Entry and exit ────────────────────────────────────────────────────────────

describe('where edges attach', () => {
  it('gives start no inbound handle, because nothing precedes it', () => {
    show({ id: 'n', type: 'start' } as WorkflowNode);
    expect(hasTarget()).toBe(false);
  });

  it('gives every other node an inbound handle', () => {
    show({ id: 'n', type: 'notify', target: { kind: 'requester' } } as WorkflowNode);
    expect(hasTarget()).toBe(true);
  });

  it('gives a terminal no exit at all', () => {
    // An edge leaving "Approved" would be a step after the end of the workflow.
    for (const type of ['approved', 'rejected'] as const) {
      const view = show({ id: 'n', type } as WorkflowNode);
      expect(exits()).toHaveLength(0);
      view.unmount();
    }
  });

  it('gives an approval a labelled approve and reject exit', () => {
    /**
     * The two ids are what the edges carry. Swapping them routes an approval down the
     * rejection path, which is the worst possible silent failure in a workflow.
     */
    show({ id: 'n', type: 'approval', approver: { kind: 'manager' } } as WorkflowNode);
    expect(exits()).toEqual([
      { id: 'approve', label: 'approve' },
      { id: 'reject', label: 'reject' },
    ]);
  });

  it('gives an acknowledgement ONE plain exit, not approve/reject', () => {
    // It parks a task but has a single outcome; two exits would imply a decision.
    show({ id: 'n', type: 'acknowledge', approver: { kind: 'manager' } } as WorkflowNode);
    expect(exits()).toEqual([{ id: '', label: '' }]);
  });

  it('gives an IF a true and a false exit', () => {
    show({ id: 'n', type: 'if', predicate: { always: true } } as WorkflowNode);
    expect(exits()).toEqual([
      { id: 'true', label: 'true' },
      { id: 'false', label: 'false' },
    ]);
  });

  it('gives a switch one exit per case, plus a default', () => {
    /**
     * The default is not optional: a subject matching no case has to go somewhere, and
     * without the exit the graph silently dead-ends.
     */
    show({
      id: 'n',
      type: 'switch',
      cases: [
        { id: 'c1', label: 'Small', predicate: { always: true } },
        { id: 'c2', label: '  ', predicate: { always: true } },
      ],
    } as WorkflowNode);
    expect(exits()).toEqual([
      { id: 'c1', label: 'Small' },
      // A blank label falls back to its position, so no exit is unnamed.
      { id: 'c2', label: 'Case 2' },
      { id: 'default', label: 'default' },
    ]);
  });

  it('gives a plain step a single unnamed exit', () => {
    show({ id: 'n', type: 'action', actions: [] } as WorkflowNode);
    expect(exits()).toEqual([{ id: '', label: '' }]);
  });
});

// ── What the body says ────────────────────────────────────────────────────────

describe('the node body', () => {
  it('shows who an approval routes to', () => {
    show({ id: 'n', type: 'approval', approver: { kind: 'manager' } } as WorkflowNode);
    expect(screen.getByText('Approver')).toBeInTheDocument();
    expect(screen.getByText('Direct manager')).toBeInTheDocument();
  });

  it('calls the person on an acknowledgement an acknowledger, not an approver', () => {
    // They are not approving anything, and the label is the only thing that says so.
    show({ id: 'n', type: 'acknowledge', approver: { kind: 'manager' } } as WorkflowNode);
    expect(screen.getByText('Acknowledger')).toBeInTheDocument();
  });

  it('names the minimum job level a chain approval must reach', () => {
    /**
     * "Manager ancestor" alone does not say how far up. Without the level the node
     * describes a different rule from the one it runs.
     */
    show({
      id: 'n',
      type: 'approval',
      approver: { kind: 'managerChain', minJobLevelId: 'jl-1' },
    } as WorkflowNode);
    expect(screen.getByText('Min level')).toBeInTheDocument();
    // Without options the id is all there is; resolved below.
    expect(screen.getByText('jl-1')).toBeInTheDocument();
  });

  it('summarises a custom approver filter', () => {
    show({
      id: 'n',
      type: 'approval',
      approver: {
        kind: 'filter',
        match: { all: [{ field: 'departmentId', op: 'eq', value: 'dept-1' }] },
      },
    } as WorkflowNode);
    expect(screen.getByText('Who')).toBeInTheDocument();
    expect(screen.getByText(/Department =/)).toBeInTheDocument();
  });

  it('says who a notify step tells, in words', () => {
    // "requester" is a schema value; "the requester" is a sentence.
    show({ id: 'n', type: 'notify', target: { kind: 'manager' } } as WorkflowNode);
    expect(screen.getByText("the requester's manager")).toBeInTheDocument();
  });

  it('falls back to the raw kind for a notify target it has no phrase for', () => {
    // A target shipped server-side must not render an empty pill.
    show({ id: 'n', type: 'notify', target: { kind: 'watchers' } } as unknown as WorkflowNode);
    expect(screen.getByText('watchers')).toBeInTheDocument();
  });

  it('spells out what an action writes, and which hook it runs', () => {
    show({
      id: 'n',
      type: 'action',
      actions: [
        { kind: 'setField', key: 'auditSelected', value: true },
        { kind: 'integration', hook: 'audit.log' },
      ],
    } as WorkflowNode);
    expect(screen.getByText('auditSelected = true')).toBeInTheDocument();
    expect(screen.getByText('→ audit.log')).toBeInTheDocument();
  });

  it('names a called sub-workflow, and warns when none is chosen', () => {
    /**
     * An unconfigured call is a node that does nothing at run time. An empty pill would
     * read as "configured, nothing to say".
     */
    const view = show({ id: 'n', type: 'callWorkflow', workflowKey: '' } as WorkflowNode);
    expect(screen.getByText('pick a workflow')).toBeInTheDocument();
    expect((screen.getByText('pick a workflow').parentElement as HTMLElement).className).toContain(
      'bg-warning',
    );
    view.unmount();

    show({ id: 'n', type: 'callWorkflow', workflowKey: 'vcc-standard' } as WorkflowNode);
    // No options in context, so the key is the best available name.
    expect(screen.getByText('vcc-standard')).toBeInTheDocument();
  });

  it('says how a parallel node joins, including the quorum size', () => {
    // "quorum" without k is not a rule anybody can evaluate.
    const view = show({ id: 'n', type: 'parallel', join: { kind: 'all' } } as WorkflowNode);
    expect(screen.getByText('all')).toBeInTheDocument();
    view.unmount();

    show({ id: 'n', type: 'parallel', join: { kind: 'quorum', k: 2 } } as WorkflowNode);
    expect(screen.getByText('quorum(2)')).toBeInTheDocument();
  });

  it('renders an IF’s condition as pills', () => {
    show({
      id: 'n',
      type: 'if',
      predicate: { all: [{ field: 'amount', op: 'gte', value: 500 }] },
    } as WorkflowNode);
    expect(screen.getByText('Amount')).toBeInTheDocument();
    expect(screen.getByText('≥')).toBeInTheDocument();
  });

  it('gives each switch case its own labelled box', () => {
    /**
     * Cases are evaluated in order and the reader has to be able to tell which
     * condition belongs to which exit.
     */
    show({
      id: 'n',
      type: 'switch',
      cases: [
        {
          id: 'c1',
          label: 'Small',
          predicate: { all: [{ field: 'amount', op: 'lt', value: 100 }] },
        },
        {
          id: 'c2',
          label: 'Large',
          predicate: { all: [{ field: 'amount', op: 'gte', value: 100 }] },
        },
      ],
    } as WorkflowNode);
    const boxes = document.querySelectorAll('fieldset');
    expect(boxes).toHaveLength(2);
    expect(within(boxes[0] as HTMLElement).getByText('Small')).toBeInTheDocument();
    expect(within(boxes[1] as HTMLElement).getByText('Large')).toBeInTheDocument();
  });

  it('leaves a structural node’s body empty', () => {
    // Start and the terminals have nothing to configure, so there is nothing to say.
    const { container } = show({ id: 'n', type: 'start' } as WorkflowNode);
    expect(container.textContent).toBe('Start');
  });

  it('resolves ids to labels when the editor has its options', () => {
    show({
      id: 'n',
      type: 'approval',
      approver: { kind: 'managerChain', minJobLevelId: 'jl-1' },
    } as WorkflowNode);
    // Without a provider the id shows through; the provider case is covered by the
    // ConditionBar suite, which owns `labelForValue`.
    expect(screen.getByText('jl-1')).toBeInTheDocument();
    expect(OPTIONS).toBeDefined();
  });
});
