/**
 * CallWorkflow expansion (pure). Sub-flows are implemented by *inlining*: at
 * instantiation each `callWorkflow` node is replaced by the called workflow's
 * graph, spliced in place. The result is one flat graph the interpreter runs
 * unchanged — no runtime child-instance machinery.
 *
 *   - the call node's incoming edges → the sub's Start successors,
 *   - the sub's Approved nodes → the call node's continuation (its single out),
 *   - the sub's Rejected nodes survive (reaching one fails the instance — the
 *     correct propagation),
 *   - node/edge ids are namespaced per call site so nesting stays unique.
 *
 * Cycle / depth protection: a call to a workflow already on the current path,
 * or beyond `maxDepth`, degrades to a transparent pass-through (the sub-flow is
 * skipped) rather than looping. Unknown/unpublished keys also pass through.
 */
import type { WorkflowEdge, WorkflowGraph, WorkflowNode } from './schema';

/** Drop a call node, wiring its predecessors straight to its single successor. */
function passthrough(g: WorkflowGraph, callId: string): WorkflowGraph {
  const succ = g.edges.find((e) => e.source === callId)?.target;
  const nodes = g.nodes.filter((n) => n.id !== callId);
  const edges: WorkflowEdge[] = [];
  for (const e of g.edges) {
    if (e.source === callId) continue;
    if (e.target === callId) {
      if (succ) edges.push({ ...e, target: succ });
      continue;
    }
    edges.push(e);
  }
  return { nodes, edges };
}

/** Splice an (already-expanded) sub-graph in place of a call node. */
function splice(g: WorkflowGraph, callId: string, sub: WorkflowGraph): WorkflowGraph {
  const p = (id: string) => `${callId}$${id}`;
  const subStart = sub.nodes.find((n) => n.type === 'start');
  const approvedIds = new Set(sub.nodes.filter((n) => n.type === 'approved').map((n) => n.id));
  const entryTargets = subStart
    ? sub.edges.filter((e) => e.source === subStart.id).map((e) => p(e.target))
    : [];
  const succ = g.edges.find((e) => e.source === callId)?.target;

  const nodes: WorkflowNode[] = [
    ...g.nodes.filter((n) => n.id !== callId),
    ...sub.nodes
      .filter((n) => n.type !== 'start' && n.type !== 'approved')
      .map((n) => ({ ...n, id: p(n.id) })),
  ];

  const edges: WorkflowEdge[] = [];
  // Parent edges, minus the call node's own in/out.
  for (const e of g.edges) {
    if (e.source === callId || e.target === callId) continue;
    edges.push(e);
  }
  // Predecessors of the call node → the sub's entry node(s).
  for (const e of g.edges) {
    if (e.target !== callId) continue;
    for (const et of entryTargets) {
      edges.push({
        id: `${e.id}~${et}`,
        source: e.source,
        sourceHandle: e.sourceHandle,
        target: et,
      });
    }
  }
  // Sub-graph internal edges (namespaced); edges into Approved → the parent
  // continuation; edges out of Start are already consumed above.
  for (const e of sub.edges) {
    if (subStart && e.source === subStart.id) continue;
    const target = approvedIds.has(e.target) ? succ : p(e.target);
    if (!target) continue;
    edges.push({ id: p(e.id), source: p(e.source), sourceHandle: e.sourceHandle, target });
  }
  return { nodes, edges };
}

export function inlineCallWorkflows(
  entry: WorkflowGraph,
  workflows: Map<string, WorkflowGraph>,
  maxDepth = 5,
): WorkflowGraph {
  function expand(graph: WorkflowGraph, path: string[], depth: number): WorkflowGraph {
    let g = graph;
    for (let guard = 0; guard < 1000; guard += 1) {
      const call = g.nodes.find((n) => n.type === 'callWorkflow');
      if (!call || call.type !== 'callWorkflow') break;
      const key = call.workflowKey;
      const sub = workflows.get(key);
      if (!sub || depth >= maxDepth || path.includes(key)) {
        g = passthrough(g, call.id);
        continue;
      }
      g = splice(g, call.id, expand(sub, [...path, key], depth + 1));
    }
    return g;
  }
  return expand(entry, [], 0);
}
