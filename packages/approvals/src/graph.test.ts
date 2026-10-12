import { describe, expect, it } from 'vitest';
import { validateGraph } from './graph';
import type { WorkflowEdge, WorkflowGraph, WorkflowNode } from './schema';

/**
 * Structural validation of a workflow graph.
 *
 * This runs at publish time and is the last thing between an admin's drawing and a live
 * approval route. Every issue it fails to raise becomes a workflow that *starts* and then
 * behaves inexplicably: a request that parks on a node with no exit, a branch that can
 * never approve anything, an Approved node nothing can reach. None of those look like a
 * validation bug when they happen — they look like the engine losing requests.
 *
 * `graphSchema` already guarantees node and edge SHAPES, so nothing here re-tests that.
 * These are the wiring rules it cannot express.
 */

const pos = { x: 0, y: 0 };

const start = (id = 'n-start'): WorkflowNode => ({ id, position: pos, type: 'start' });
const approved = (id = 'n-ok'): WorkflowNode => ({ id, position: pos, type: 'approved' });
const rejected = (id = 'n-no'): WorkflowNode => ({ id, position: pos, type: 'rejected' });
const approval = (id = 'n-appr'): WorkflowNode => ({
  id,
  position: pos,
  type: 'approval',
  approver: { kind: 'manager' },
});
// Acknowledge carries `approver`, not `acknowledger` — its approver is resolved exactly
// like an Approval's; the difference is that it has a single outcome.
const acknowledge = (id = 'n-ack'): WorkflowNode => ({
  id,
  position: pos,
  type: 'acknowledge',
  approver: { kind: 'manager' },
});
const ifNode = (id = 'n-if'): WorkflowNode =>
  ({
    id,
    position: pos,
    type: 'if',
    predicate: { all: [] },
  }) as WorkflowNode;
const switchNode = (id = 'n-sw'): WorkflowNode =>
  ({
    id,
    position: pos,
    type: 'switch',
    cases: [{ id: 'c1', predicate: { all: [] } }],
  }) as WorkflowNode;
const parallel = (id = 'n-par'): WorkflowNode =>
  ({ id, position: pos, type: 'parallel', join: { kind: 'all' } }) as WorkflowNode;
const callWorkflow = (id: string, workflowKey: string): WorkflowNode =>
  ({ id, position: pos, type: 'callWorkflow', workflowKey }) as WorkflowNode;

let edgeSeq = 0;
const edge = (source: string, target: string, sourceHandle?: string): WorkflowEdge => ({
  id: `e${++edgeSeq}`,
  source,
  target,
  ...(sourceHandle ? { sourceHandle } : {}),
});

const graph = (nodes: WorkflowNode[], edges: WorkflowEdge[]): WorkflowGraph => ({ nodes, edges });
const codes = (g: WorkflowGraph) =>
  validateGraph(g)
    .map((i) => i.code)
    .sort();

/** The smallest publishable workflow: Start → Approval → Approved / Rejected. */
function minimalValid(): WorkflowGraph {
  return graph(
    [start(), approval(), approved(), rejected()],
    [
      edge('n-start', 'n-appr'),
      edge('n-appr', 'n-ok', 'approve'),
      edge('n-appr', 'n-no', 'reject'),
    ],
  );
}

describe('validateGraph — a valid graph', () => {
  it('accepts the minimal workflow with no issues', () => {
    // The baseline every other test perturbs. If this ever raises anything, the rest of
    // the file is asserting against noise.
    expect(validateGraph(minimalValid())).toEqual([]);
  });

  it('accepts an approval whose reject exit is unwired', () => {
    // Documented behaviour: an unwired reject exit MEANS reject the request. Requiring
    // it would force every workflow to draw an edge that changes nothing.
    const g = graph(
      [start(), approval(), approved()],
      [edge('n-start', 'n-appr'), edge('n-appr', 'n-ok', 'approve')],
    );
    expect(validateGraph(g)).toEqual([]);
  });

  it('accepts a single unlabelled edge out of an approval as its approve path', () => {
    const g = graph(
      [start(), approval(), approved()],
      [edge('n-start', 'n-appr'), edge('n-appr', 'n-ok')],
    );
    expect(codes(g)).toEqual([]);
  });
});

describe('validateGraph — entry and terminals', () => {
  it('requires exactly one Start', () => {
    const two = graph(
      [start('s1'), start('s2'), approval(), approved()],
      [edge('s1', 'n-appr'), edge('s2', 'n-appr'), edge('n-appr', 'n-ok', 'approve')],
    );
    expect(codes(two)).toContain('startCount');
  });

  it('reports a missing Start', () => {
    const none = graph([approval(), approved()], [edge('n-appr', 'n-ok', 'approve')]);
    const issues = validateGraph(none);
    expect(issues.map((i) => i.code)).toContain('startCount');
    // Reachability is skipped entirely without a Start — there is nowhere to walk from,
    // and reporting every node as unreachable would bury the real problem.
    expect(issues.map((i) => i.code)).not.toContain('unreachable');
  });

  it('requires at least one Approved node', () => {
    const g = graph(
      [start(), approval(), rejected()],
      [edge('n-start', 'n-appr'), edge('n-appr', 'n-no', 'approve')],
    );
    expect(codes(g)).toContain('noApproved');
  });

  it('rejects duplicate node ids', () => {
    // Two nodes sharing an id makes every edge ambiguous.
    const g = graph([start(), approved('dup'), approved('dup')], [edge('n-start', 'dup')]);
    expect(codes(g)).toContain('duplicateNodeId');
  });

  it('forbids an outgoing edge from a terminal', () => {
    const g = graph(
      [start(), approved(), rejected()],
      [edge('n-start', 'n-ok'), edge('n-ok', 'n-no')],
    );
    expect(codes(g)).toContain('terminalHasOutput');
  });
});

describe('validateGraph — dangling edges', () => {
  it('reports an edge whose source does not exist', () => {
    const g = minimalValid();
    g.edges.push(edge('ghost', 'n-ok'));
    const issues = validateGraph(g);
    expect(issues.map((i) => i.code)).toContain('danglingEdgeSource');
    expect(issues.find((i) => i.code === 'danglingEdgeSource')?.nodeId).toBe('ghost');
  });

  it('reports an edge whose target does not exist', () => {
    const g = minimalValid();
    g.edges.push(edge('n-appr', 'ghost'));
    expect(codes(g)).toContain('danglingEdgeTarget');
  });

  it('reports both ends when both are unknown', () => {
    const g = minimalValid();
    g.edges.push(edge('ghostA', 'ghostB'));
    const found = validateGraph(g).map((i) => i.code);
    expect(found).toContain('danglingEdgeSource');
    expect(found).toContain('danglingEdgeTarget');
  });
});

describe('validateGraph — output wiring', () => {
  it('requires an `if` node to wire BOTH branches', () => {
    // A half-wired condition is the worst kind: it works until the day the predicate
    // goes the other way, and then the request stops with no trace.
    const g = graph(
      [start(), ifNode(), approved()],
      [edge('n-start', 'n-if'), edge('n-if', 'n-ok', 'true')],
    );
    const issues = validateGraph(g);
    expect(issues.map((i) => i.code)).toContain('missingHandle');
    expect(issues.find((i) => i.code === 'missingHandle')?.message).toContain('false');
  });

  it('accepts a fully wired `if`', () => {
    const g = graph(
      [start(), ifNode(), approved(), rejected()],
      [edge('n-start', 'n-if'), edge('n-if', 'n-ok', 'true'), edge('n-if', 'n-no', 'false')],
    );
    expect(codes(g)).toEqual([]);
  });

  it('requires every switch case AND its default', () => {
    const g = graph(
      [start(), switchNode(), approved()],
      [edge('n-start', 'n-sw'), edge('n-sw', 'n-ok', 'c1')],
    );
    const missing = validateGraph(g).filter((i) => i.code === 'missingHandle');
    // Only `default` is unwired — the single case is.
    expect(missing).toHaveLength(1);
    expect(missing[0].message).toContain('default');
  });

  it('requires a Start to have an outgoing edge', () => {
    const g = graph([start(), approved()], []);
    expect(codes(g)).toContain('noOutput');
  });

  it('requires an approval to have an approve path', () => {
    // Only a reject exit: nothing can ever be approved through this node.
    const g = graph(
      [start(), approval(), approved(), rejected()],
      [edge('n-start', 'n-appr'), edge('n-appr', 'n-no', 'reject')],
    );
    expect(codes(g)).toContain('noApprovePath');
  });

  it('applies the approve-path rule to acknowledge nodes too', () => {
    // Acknowledge parks a task exactly like Approval, so the same wiring rule holds —
    // and a single outcome means its ONE exit is the one that matters.
    const g = graph(
      [start(), acknowledge(), approved(), rejected()],
      [edge('n-start', 'n-ack'), edge('n-ack', 'n-no', 'reject')],
    );
    expect(codes(g)).toContain('noApprovePath');
  });

  it('requires a parallel node to fork at least twice', () => {
    // A "parallel" with one branch is a straight line wearing a costume, and its join
    // policy would silently never be exercised.
    const g = graph(
      [start(), parallel(), approval(), approved()],
      [edge('n-start', 'n-par'), edge('n-par', 'n-appr'), edge('n-appr', 'n-ok', 'approve')],
    );
    expect(codes(g)).toContain('parallelFanout');
  });

  it('accepts a parallel node with two branches', () => {
    const g = graph(
      [start(), parallel(), approval('a1'), approval('a2'), approved()],
      [
        edge('n-start', 'n-par'),
        edge('n-par', 'a1'),
        edge('n-par', 'a2'),
        edge('a1', 'n-ok', 'approve'),
        edge('a2', 'n-ok', 'approve'),
      ],
    );
    expect(codes(g)).toEqual([]);
  });

  it('requires callWorkflow to name a sub-workflow', () => {
    // Whitespace counts as empty: a key of " " passes the schema's min(1) and resolves
    // to nothing at run time.
    const g = graph(
      [start(), callWorkflow('n-call', '  '), approved()],
      [edge('n-start', 'n-call'), edge('n-call', 'n-ok')],
    );
    expect(codes(g)).toContain('callWorkflowKey');
  });

  it('requires callWorkflow to have an outgoing edge', () => {
    const g = graph(
      [start(), callWorkflow('n-call', 'sub'), approved()],
      [edge('n-start', 'n-call')],
    );
    const found = codes(g);
    expect(found).toContain('noOutput');
    // …and the Approved node is then unreachable, which is the consequence worth seeing.
    expect(found).toContain('approvedUnreachable');
  });
});

describe('validateGraph — reachability', () => {
  it('reports a node no path from Start can reach', () => {
    const g = minimalValid();
    g.nodes.push(approval('orphan'));
    g.edges.push(edge('orphan', 'n-ok', 'approve'));
    const issues = validateGraph(g);
    const unreachable = issues.filter((i) => i.code === 'unreachable');
    expect(unreachable.map((i) => i.nodeId)).toEqual(['orphan']);
  });

  it('reports when no Approved node is reachable', () => {
    // The Approved node exists, so `noApproved` stays silent — but nothing routes to it,
    // which means no request can ever complete.
    const g = graph(
      [start(), approval(), approved(), rejected()],
      [edge('n-start', 'n-appr'), edge('n-appr', 'n-no', 'reject')],
    );
    const found = codes(g);
    expect(found).toContain('approvedUnreachable');
    expect(found).not.toContain('noApproved');
  });

  it('follows a chain of several hops', () => {
    const g = graph(
      [start(), approval('a1'), approval('a2'), approved()],
      [edge('n-start', 'a1'), edge('a1', 'a2', 'approve'), edge('a2', 'n-ok', 'approve')],
    );
    expect(codes(g)).toEqual([]);
  });

  it('terminates on a cycle instead of looping forever', () => {
    /**
     * A cycle is legal enough to draw, and the traversal has to survive it. Without the
     * `seen` guard this hangs the publish request rather than returning an issue —
     * failing to validate is recoverable, hanging is not.
     */
    const g = graph(
      [start(), approval('a1'), approval('a2'), approved()],
      [
        edge('n-start', 'a1'),
        edge('a1', 'a2', 'approve'),
        edge('a2', 'a1', 'approve'),
        edge('a1', 'n-ok', 'approve'),
      ],
    );
    expect(validateGraph(g)).toEqual([]);
  });

  it('reports every unreachable node, not just the first', () => {
    const g = minimalValid();
    g.nodes.push(approved('lost1'), approved('lost2'));
    const unreachable = validateGraph(g).filter((i) => i.code === 'unreachable');
    expect(unreachable.map((i) => i.nodeId).sort()).toEqual(['lost1', 'lost2']);
  });
});
