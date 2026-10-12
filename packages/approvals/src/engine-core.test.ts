import { describe, expect, it } from 'vitest';
import { advance, applyApproval, applyRejection, createInitialState } from './engine-core';
import type { SubjectFacts } from './predicate';
import type { JoinPolicy, WorkflowGraph, WorkflowNode } from './schema';

const EMPTY = new Set<string>();

/** A unified approval node (the engine core only cares that it's an `approval`
 *  type — approver resolution is the server layer's job). */
const appr = (id: string): WorkflowNode => ({
  id,
  type: 'approval',
  approver: { kind: 'manager' },
});

/** Drive a graph through a decision script (mirrors the server's apply loop). */
function drive(
  graph: WorkflowGraph,
  facts: SubjectFacts,
  decisions: { node: string; approve: boolean }[],
): string {
  let r = advance(graph, createInitialState(graph), facts, EMPTY);
  const open = new Set(r.createTasks);
  for (const d of decisions) {
    if (r.status !== 'RUNNING') break;
    open.delete(d.node);
    if (d.approve) {
      r = advance(graph, applyApproval(graph, r.state, d.node), facts, open);
    } else {
      const rej = applyRejection(graph, r.state, d.node);
      if (rej.status === 'REJECTED') return 'REJECTED';
      r = advance(graph, rej.state, facts, open);
    }
    for (const c of r.createTasks) open.add(c);
    for (const s of r.skipTasks) open.delete(s);
  }
  return r.status;
}

const seq = (): WorkflowGraph => ({
  nodes: [{ id: 's', type: 'start' }, appr('m'), { id: 'a', type: 'approved' }],
  edges: [
    { id: 'e1', source: 's', target: 'm' },
    { id: 'e2', source: 'm', target: 'a' },
  ],
});

/** parallel(join) over branch approval nodes converging at a tail approval → approved. */
const parallel = (join: JoinPolicy, branches: string[]): WorkflowGraph => ({
  nodes: [
    { id: 's', type: 'start' },
    { id: 'p', type: 'parallel', join },
    ...branches.map((b) => appr(b)),
    appr('tr'),
    { id: 'a', type: 'approved' },
  ],
  edges: [
    { id: 'es', source: 's', target: 'p' },
    ...branches.map((b, i) => ({ id: `pb${i}`, source: 'p', sourceHandle: `b${i}`, target: b })),
    ...branches.map((b, i) => ({ id: `bt${i}`, source: b, target: 'tr' })),
    { id: 'eta', source: 'tr', target: 'a' },
  ],
});

describe('engine-core', () => {
  it('sequential → APPROVED', () => {
    expect(drive(seq(), {}, [{ node: 'm', approve: true }])).toBe('APPROVED');
  });

  it('IF routes on amount', () => {
    const g: WorkflowGraph = {
      nodes: [
        { id: 's', type: 'start' },
        { id: 'gate', type: 'if', predicate: { field: 'amount', op: 'gte', value: 5000 } },
        appr('tr'),
        appr('m'),
        { id: 'a', type: 'approved' },
      ],
      edges: [
        { id: 'e1', source: 's', target: 'gate' },
        { id: 'e2', source: 'gate', sourceHandle: 'false', target: 'tr' },
        { id: 'e3', source: 'gate', sourceHandle: 'true', target: 'm' },
        { id: 'e4', source: 'm', target: 'a' },
        { id: 'e5', source: 'tr', target: 'a' },
      ],
    };
    expect(drive(g, { amount: 1000 }, [{ node: 'tr', approve: true }])).toBe('APPROVED');
    expect(drive(g, { amount: 9000 }, [{ node: 'm', approve: true }])).toBe('APPROVED');
  });

  it('parallel(all) needs every branch then the join', () => {
    const g = parallel({ kind: 'all' }, ['m', 'u']);
    expect(
      drive(g, {}, [
        { node: 'm', approve: true },
        { node: 'u', approve: true },
        { node: 'tr', approve: true },
      ]),
    ).toBe('APPROVED');
  });

  it('parallel(any) fires on the first approval, skipping siblings', () => {
    const g = parallel({ kind: 'any' }, ['m', 'u']);
    expect(
      drive(g, {}, [
        { node: 'm', approve: true },
        { node: 'tr', approve: true },
      ]),
    ).toBe('APPROVED');
  });

  it('parallel(quorum 2 of 3) fires at the second approval', () => {
    const g = parallel({ kind: 'quorum', k: 2 }, ['a1', 'a2', 'a3']);
    expect(
      drive(g, {}, [
        { node: 'a1', approve: true },
        { node: 'a2', approve: true },
        { node: 'tr', approve: true },
      ]),
    ).toBe('APPROVED');
  });

  it('parallel(all) fails when any branch rejects', () => {
    const g = parallel({ kind: 'all' }, ['m', 'u']);
    expect(drive(g, {}, [{ node: 'm', approve: false }])).toBe('REJECTED');
  });

  it('parallel(any) tolerates a branch reject, then approves via the other', () => {
    const g = parallel({ kind: 'any' }, ['m', 'u']);
    expect(
      drive(g, {}, [
        { node: 'm', approve: false },
        { node: 'u', approve: true },
        { node: 'tr', approve: true },
      ]),
    ).toBe('APPROVED');
  });

  it('approval node routes its approve exit (named handle)', () => {
    const g: WorkflowGraph = {
      nodes: [
        { id: 's', type: 'start' },
        appr('m'),
        { id: 'a', type: 'approved' },
        { id: 'r', type: 'rejected' },
      ],
      edges: [
        { id: 'e1', source: 's', target: 'm' },
        { id: 'e2', source: 'm', sourceHandle: 'approve', target: 'a' },
        { id: 'e3', source: 'm', sourceHandle: 'reject', target: 'r' },
      ],
    };
    expect(drive(g, {}, [{ node: 'm', approve: true }])).toBe('APPROVED');
    // Wired reject exit → routes to the rejected terminal (still REJECTED).
    expect(drive(g, {}, [{ node: 'm', approve: false }])).toBe('REJECTED');
  });

  it('reject exit can route to an escalation approver instead of failing', () => {
    const g: WorkflowGraph = {
      nodes: [{ id: 's', type: 'start' }, appr('m'), appr('esc'), { id: 'a', type: 'approved' }],
      edges: [
        { id: 'e1', source: 's', target: 'm' },
        { id: 'e2', source: 'm', sourceHandle: 'approve', target: 'a' },
        // Manager rejects → escalate rather than fail.
        { id: 'e3', source: 'm', sourceHandle: 'reject', target: 'esc' },
        { id: 'e4', source: 'esc', sourceHandle: 'approve', target: 'a' },
      ],
    };
    expect(
      drive(g, {}, [
        { node: 'm', approve: false },
        { node: 'esc', approve: true },
      ]),
    ).toBe('APPROVED');
  });

  it('fail-fast reject outside a parallel', () => {
    const g: WorkflowGraph = {
      nodes: [
        { id: 's', type: 'start' },
        { id: 'gate', type: 'if', predicate: { field: 'amount', op: 'gte', value: 1000000 } },
        { id: 'r', type: 'rejected' },
        { id: 'a', type: 'approved' },
      ],
      edges: [
        { id: 'e1', source: 's', target: 'gate' },
        { id: 'e2', source: 'gate', sourceHandle: 'true', target: 'r' },
        { id: 'e3', source: 'gate', sourceHandle: 'false', target: 'a' },
      ],
    };
    expect(advance(g, createInitialState(g), { amount: 2000000 }, EMPTY).status).toBe('REJECTED');
    expect(advance(g, createInitialState(g), { amount: 10 }, EMPTY).status).toBe('APPROVED');
  });
});

describe('pass-through side-effect nodes (notify / action)', () => {
  it('notify fires an effect and lets the token flow straight through', () => {
    const g: WorkflowGraph = {
      nodes: [
        { id: 's', type: 'start' },
        { id: 'n', type: 'notify', target: { kind: 'requester' } },
        { id: 'a', type: 'approved' },
      ],
      edges: [
        { id: 'e1', source: 's', target: 'n' },
        { id: 'e2', source: 'n', target: 'a' },
      ],
    };
    const r = advance(g, createInitialState(g), {}, EMPTY);
    expect(r.firedEffects).toEqual(['n']);
    expect(r.createTasks).toEqual([]);
    expect(r.status).toBe('APPROVED');
  });

  it('action fires an effect and passes through', () => {
    const g: WorkflowGraph = {
      nodes: [
        { id: 's', type: 'start' },
        { id: 'act', type: 'action', actions: [{ kind: 'integration', hook: 'test.hook' }] },
        { id: 'a', type: 'approved' },
      ],
      edges: [
        { id: 'e1', source: 's', target: 'act' },
        { id: 'e2', source: 'act', target: 'a' },
      ],
    };
    const r = advance(g, createInitialState(g), {}, EMPTY);
    expect(r.firedEffects).toEqual(['act']);
    expect(r.status).toBe('APPROVED');
  });

  it('an effect between an approval and the terminal fires only after the decision', () => {
    const g: WorkflowGraph = {
      nodes: [
        { id: 's', type: 'start' },
        appr('m'),
        { id: 'n', type: 'notify', target: { kind: 'manager' } },
        { id: 'a', type: 'approved' },
      ],
      edges: [
        { id: 'e1', source: 's', target: 'm' },
        { id: 'e2', source: 'm', target: 'n' },
        { id: 'e3', source: 'n', target: 'a' },
      ],
    };
    const first = advance(g, createInitialState(g), {}, EMPTY);
    expect(first.createTasks).toEqual(['m']);
    expect(first.firedEffects).toEqual([]); // notify not reached yet
    expect(first.status).toBe('RUNNING');
    const resumed = advance(g, applyApproval(g, first.state, 'm'), {}, new Set());
    expect(resumed.firedEffects).toEqual(['n']);
    expect(resumed.status).toBe('APPROVED');
  });
});

describe('acknowledge node', () => {
  const ackGraph: WorkflowGraph = {
    nodes: [
      { id: 's', type: 'start' },
      { id: 'k', type: 'acknowledge', approver: { kind: 'manager' } },
      { id: 'a', type: 'approved' },
    ],
    edges: [
      { id: 'e1', source: 's', target: 'k' },
      { id: 'e2', source: 'k', target: 'a' },
    ],
  };

  it('parks a task like an approval', () => {
    const r = advance(ackGraph, createInitialState(ackGraph), {}, EMPTY);
    expect(r.createTasks).toEqual(['k']);
    expect(r.status).toBe('RUNNING');
  });

  it('continues the flow when acknowledged (approve)', () => {
    const first = advance(ackGraph, createInitialState(ackGraph), {}, EMPTY);
    const resumed = advance(ackGraph, applyApproval(ackGraph, first.state, 'k'), {}, new Set());
    expect(resumed.status).toBe('APPROVED');
  });
});
