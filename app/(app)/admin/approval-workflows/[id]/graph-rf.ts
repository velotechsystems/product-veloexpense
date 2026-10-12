/**
 * Conversion between our persisted WorkflowGraph and React Flow's node/edge
 * shapes. React Flow owns layout (position) + interaction; our schema owns
 * type + config. `data.node` carries the full typed node so config panels edit
 * it in place; position is synced back on export.
 */

import type { WorkflowEdge, WorkflowGraph, WorkflowNode } from '@expenseos/approvals';
import type { Edge, Node } from '@xyflow/react';

export type RFNodeData = { node: WorkflowNode };
export type RFNode = Node<RFNodeData>;
export type RFEdge = Edge;

/** Deterministic fallback layout for nodes authored without positions —
 *  stacked top-to-bottom so the (Top target / Bottom source) handles produce
 *  clean vertical arrows. */
function fallbackPosition(index: number): { x: number; y: number } {
  return { x: 240, y: 40 + index * 110 };
}

export function toReactFlow(graph: WorkflowGraph): { nodes: RFNode[]; edges: RFEdge[] } {
  return {
    nodes: graph.nodes.map((n, i) => ({
      id: n.id,
      type: n.type,
      position: n.position ?? fallbackPosition(i),
      data: { node: n },
    })),
    edges: graph.edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      sourceHandle: e.sourceHandle,
    })),
  };
}

export function fromReactFlow(nodes: RFNode[], edges: RFEdge[]): WorkflowGraph {
  return {
    nodes: nodes.map((n) => ({
      ...n.data.node,
      id: n.id,
      position: { x: Math.round(n.position.x), y: Math.round(n.position.y) },
    })) as WorkflowNode[],
    edges: edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      sourceHandle: e.sourceHandle ?? undefined,
    })) as WorkflowEdge[],
  };
}

/** Default config for a freshly-dropped node of the given type. */
export function defaultNode(type: WorkflowNode['type'], id: string): WorkflowNode {
  switch (type) {
    case 'if':
      return { id, type, predicate: { field: 'amount', op: 'gte', value: 0 } };
    case 'switch':
      return {
        id,
        type,
        cases: [{ id: 'c1', predicate: { field: 'amount', op: 'gte', value: 0 } }],
      };
    case 'parallel':
      return { id, type, join: { kind: 'all' } };
    case 'approval':
      return { id, type, approver: { kind: 'manager' } };
    case 'acknowledge':
      return { id, type, approver: { kind: 'manager' } };
    case 'notify':
      return { id, type, target: { kind: 'requester' } };
    case 'action':
      return { id, type, actions: [{ kind: 'setField', key: 'auditSelected', value: true }] };
    case 'callWorkflow':
      return { id, type, workflowKey: '' };
    default:
      return { id, type } as WorkflowNode;
  }
}
