import type { WorkflowGraph, WorkflowNode } from '@expenseos/approvals';
import { describe, expect, it } from 'vitest';
import { defaultNode, fromReactFlow, type RFEdge, type RFNode, toReactFlow } from './graph-rf';

/**
 * The boundary between our persisted graph and React Flow's.
 *
 * Two properties matter and neither is visible on screen:
 *
 *   · **The round trip must not lose config.** React Flow owns position and nothing
 *     else; every node's typed config rides in `data.node` and has to come back out
 *     intact, or saving a graph after dragging one box silently resets the others.
 *   · **A fresh node must be VALID for its type.** The schema requires a predicate on
 *     an `if`, an approver on an `approval`, and so on — a node dropped without one
 *     fails validation on save, after the author has already laid the graph out.
 */

const graph = (over: Partial<WorkflowGraph> = {}): WorkflowGraph =>
  ({
    nodes: [
      { id: 'n1', type: 'start' },
      {
        id: 'n2',
        type: 'approval',
        approver: { kind: 'manager' },
        position: { x: 10, y: 20 },
      },
    ],
    edges: [{ id: 'e1', source: 'n1', target: 'n2' }],
    ...over,
  }) as WorkflowGraph;

describe('toReactFlow', () => {
  it('carries the whole typed node through, not just its type', () => {
    const { nodes } = toReactFlow(graph());
    expect(nodes[1].data.node).toMatchObject({ type: 'approval', approver: { kind: 'manager' } });
  });

  it('keeps a position that was already authored', () => {
    expect(toReactFlow(graph()).nodes[1].position).toEqual({ x: 10, y: 20 });
  });

  it('stacks unpositioned nodes so the vertical handles produce clean arrows', () => {
    /**
     * A graph authored by seed or by API has no positions. Dropping every node at the
     * origin would pile them into one unreadable square.
     */
    const { nodes } = toReactFlow(
      graph({
        nodes: [
          { id: 'a', type: 'start' },
          { id: 'b', type: 'approved' },
          { id: 'c', type: 'rejected' },
        ] as WorkflowNode[],
      }),
    );
    expect(nodes.map((n) => n.position)).toEqual([
      { x: 240, y: 40 },
      { x: 240, y: 150 },
      { x: 240, y: 260 },
    ]);
  });

  it('carries a branch handle so a switch case keeps the edge it labels', () => {
    // Without the handle every case edge leaves the same port and the branch is lost.
    const { edges } = toReactFlow(
      graph({ edges: [{ id: 'e1', source: 'n1', target: 'n2', sourceHandle: 'c1' }] }),
    );
    expect(edges[0]).toMatchObject({ source: 'n1', target: 'n2', sourceHandle: 'c1' });
  });

  it('survives an empty graph', () => {
    expect(toReactFlow({ nodes: [], edges: [] } as WorkflowGraph)).toEqual({
      nodes: [],
      edges: [],
    });
  });
});

describe('fromReactFlow', () => {
  it('returns every node with its config intact', () => {
    // Positions are the one thing the round trip ADDS: an unpositioned node comes back
    // with the layout the canvas gave it, which is the point of laying it out.
    const { nodes, edges } = toReactFlow(graph());
    const back = fromReactFlow(nodes, edges);
    expect(back.nodes).toEqual([
      { id: 'n1', type: 'start', position: { x: 240, y: 40 } },
      { id: 'n2', type: 'approval', approver: { kind: 'manager' }, position: { x: 10, y: 20 } },
    ]);
    expect(back.edges).toEqual([{ id: 'e1', source: 'n1', target: 'n2', sourceHandle: undefined }]);
  });

  it('rounds a dragged position, so a pixel of drift is not a diff', () => {
    /**
     * React Flow reports fractional positions while dragging. Persisting them makes
     * every open-and-close of the editor look like an edit.
     */
    const nodes: RFNode[] = [
      {
        id: 'n1',
        type: 'start',
        position: { x: 10.4, y: 20.6 },
        data: { node: { id: 'n1', type: 'start' } as WorkflowNode },
      },
    ];
    expect(fromReactFlow(nodes, []).nodes[0].position).toEqual({ x: 10, y: 21 });
  });

  it('takes the id from React Flow, not the stale copy inside the node', () => {
    // The canvas is the authority on identity once a node has been added there.
    const nodes: RFNode[] = [
      {
        id: 'renamed',
        type: 'start',
        position: { x: 0, y: 0 },
        data: { node: { id: 'old', type: 'start' } as WorkflowNode },
      },
    ];
    expect(fromReactFlow(nodes, []).nodes[0].id).toBe('renamed');
  });

  it('drops a null branch handle rather than persisting it', () => {
    // React Flow uses null for "the default port"; the schema wants it absent.
    const edges: RFEdge[] = [{ id: 'e1', source: 'a', target: 'b', sourceHandle: null }];
    expect(fromReactFlow([], edges).edges[0]).toEqual({ id: 'e1', source: 'a', target: 'b' });
  });
});

describe('defaultNode', () => {
  it('gives an if node a predicate it can be saved with', () => {
    expect(defaultNode('if', 'n1')).toEqual({
      id: 'n1',
      type: 'if',
      predicate: { field: 'amount', op: 'gte', value: 0 },
    });
  });

  it('gives a switch node one case, so it has a branch to attach an edge to', () => {
    const node = defaultNode('switch', 'n1') as { cases: { id: string }[] };
    expect(node.cases).toHaveLength(1);
    expect(node.cases[0].id).toBe('c1');
  });

  it('joins a parallel node on all branches by default', () => {
    // A quorum needs a number nobody has chosen yet; "all" is the safe reading.
    expect(defaultNode('parallel', 'n1')).toMatchObject({ join: { kind: 'all' } });
  });

  it('routes an approval and an acknowledgement to the direct manager', () => {
    expect(defaultNode('approval', 'n1')).toMatchObject({ approver: { kind: 'manager' } });
    expect(defaultNode('acknowledge', 'n1')).toMatchObject({ approver: { kind: 'manager' } });
  });

  it('notifies the requester by default', () => {
    // The one target that always exists, whatever the subject is.
    expect(defaultNode('notify', 'n1')).toMatchObject({ target: { kind: 'requester' } });
  });

  it('gives an action node a complete action, not an empty list', () => {
    expect(defaultNode('action', 'n1')).toMatchObject({
      actions: [{ kind: 'setField', key: 'auditSelected', value: true }],
    });
  });

  it('leaves a called workflow unset, because there is no safe default target', () => {
    expect(defaultNode('callWorkflow', 'n1')).toEqual({
      id: 'n1',
      type: 'callWorkflow',
      workflowKey: '',
    });
  });

  it('gives structural nodes nothing but their identity', () => {
    expect(defaultNode('start', 'n1')).toEqual({ id: 'n1', type: 'start' });
    expect(defaultNode('approved', 'n2')).toEqual({ id: 'n2', type: 'approved' });
    expect(defaultNode('rejected', 'n3')).toEqual({ id: 'n3', type: 'rejected' });
  });
});
