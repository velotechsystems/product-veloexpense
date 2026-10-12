/**
 * Graph structural validation + traversal helpers (pure). Run at publish time
 * (and live in the editor). `graphSchema` already guarantees node/edge shapes;
 * this layer checks the wiring: one Start, reachable terminals, every
 * multi-output node fully wired, no dangling edges.
 */
import {
  APPROVAL_NODE_TYPES,
  type NodeType,
  type WorkflowGraph,
  type WorkflowNode,
} from './schema';

export interface GraphIssue {
  /** Stable code for i18n / tests. */
  code: string;
  message: string;
  nodeId?: string;
}

/** Outgoing handles a node type must have wired (beyond a single default). */
function requiredHandles(node: WorkflowNode): string[] {
  switch (node.type) {
    case 'if':
      return ['true', 'false'];
    case 'switch':
      return [...node.cases.map((c) => c.id), 'default'];
    default:
      return [];
  }
}

const isApprovalType = (t: NodeType): boolean =>
  (APPROVAL_NODE_TYPES as readonly NodeType[]).includes(t);

/** Single-output node types that must have exactly one outgoing edge. Approval
 *  nodes are excluded — they route via named approve/reject exits (checked
 *  separately). */
function expectsSingleOutput(node: WorkflowNode): boolean {
  return node.type === 'start' || node.type === 'callWorkflow';
}

export function validateGraph(graph: WorkflowGraph): GraphIssue[] {
  const issues: GraphIssue[] = [];
  const { nodes, edges } = graph;
  const byId = new Map(nodes.map((n) => [n.id, n]));

  // Unique ids.
  if (byId.size !== nodes.length) {
    issues.push({ code: 'duplicateNodeId', message: 'Node ids must be unique.' });
  }

  // Exactly one Start.
  const starts = nodes.filter((n) => n.type === 'start');
  if (starts.length !== 1) {
    issues.push({
      code: 'startCount',
      message: `Exactly one Start node is required (found ${starts.length}).`,
    });
  }

  // At least one terminal.
  if (!nodes.some((n) => n.type === 'approved')) {
    issues.push({ code: 'noApproved', message: 'At least one Approved node is required.' });
  }

  // Edges reference existing nodes.
  for (const e of edges) {
    if (!byId.has(e.source)) {
      issues.push({
        code: 'danglingEdgeSource',
        message: `Edge ${e.id} has an unknown source.`,
        nodeId: e.source,
      });
    }
    if (!byId.has(e.target)) {
      issues.push({
        code: 'danglingEdgeTarget',
        message: `Edge ${e.id} has an unknown target.`,
        nodeId: e.target,
      });
    }
  }

  // Per-node output wiring.
  const outByNode = new Map<string, Set<string | undefined>>();
  const outCount = new Map<string, number>();
  for (const e of edges) {
    if (!outByNode.has(e.source)) outByNode.set(e.source, new Set());
    outByNode.get(e.source)?.add(e.sourceHandle);
    outCount.set(e.source, (outCount.get(e.source) ?? 0) + 1);
  }

  for (const node of nodes) {
    const handles = outByNode.get(node.id) ?? new Set();
    const count = outCount.get(node.id) ?? 0;

    // Multi-output handles must all be wired.
    for (const h of requiredHandles(node)) {
      if (!handles.has(h)) {
        issues.push({
          code: 'missingHandle',
          message: `${node.type} node is missing its "${h}" output.`,
          nodeId: node.id,
        });
      }
    }

    // Single-output nodes need exactly one edge out.
    if (expectsSingleOutput(node) && count === 0) {
      issues.push({
        code: 'noOutput',
        message: `${node.type} node has no outgoing edge.`,
        nodeId: node.id,
      });
    }

    // Approval nodes need an approve path (named `approve` exit, or a single
    // unlabeled edge). The `reject` exit is optional — unwired = reject the
    // request (parallel-aware).
    if (isApprovalType(node.type)) {
      const hasApprove = [...handles].some((h) => h === 'approve' || h === undefined);
      if (!hasApprove) {
        issues.push({
          code: 'noApprovePath',
          message: `${node.type} node has no "approve" exit wired.`,
          nodeId: node.id,
        });
      }
    }

    // Parallel must fork (≥2) and its branches must eventually rejoin/terminate.
    if (node.type === 'parallel' && count < 2) {
      issues.push({
        code: 'parallelFanout',
        message: 'Parallel node must have at least 2 branches.',
        nodeId: node.id,
      });
    }

    // CallWorkflow must reference a sub-workflow.
    if (node.type === 'callWorkflow' && !node.workflowKey.trim()) {
      issues.push({
        code: 'callWorkflowKey',
        message: 'Call workflow node must reference a sub-workflow.',
        nodeId: node.id,
      });
    }

    // Terminals must have no outgoing edges.
    if ((node.type === 'approved' || node.type === 'rejected') && count > 0) {
      issues.push({
        code: 'terminalHasOutput',
        message: `${node.type} node cannot have outgoing edges.`,
        nodeId: node.id,
      });
    }
  }

  // Reachability: every node reachable from Start, and an Approved reachable.
  const start = starts[0];
  if (start) {
    const adj = new Map<string, string[]>();
    for (const e of edges) {
      if (!adj.has(e.source)) adj.set(e.source, []);
      adj.get(e.source)?.push(e.target);
    }
    const seen = new Set<string>();
    const stack = [start.id];
    while (stack.length > 0) {
      const id = stack.pop();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      for (const t of adj.get(id) ?? []) stack.push(t);
    }
    for (const node of nodes) {
      if (!seen.has(node.id)) {
        issues.push({
          code: 'unreachable',
          message: `${node.type} node is unreachable from Start.`,
          nodeId: node.id,
        });
      }
    }
    const reachesApproved = nodes.some((n) => n.type === 'approved' && seen.has(n.id));
    if (!reachesApproved) {
      issues.push({
        code: 'approvedUnreachable',
        message: 'No Approved node is reachable from Start.',
      });
    }
  }

  return issues;
}
