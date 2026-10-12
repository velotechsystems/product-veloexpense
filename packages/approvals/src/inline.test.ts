import { describe, expect, it } from 'vitest';
import { advance, applyApproval, createInitialState } from './engine-core';
import { inlineCallWorkflows } from './inline';
import { graphSchema, type WorkflowGraph } from './schema';

const parent: WorkflowGraph = {
  nodes: [
    { id: 's', type: 'start' },
    { id: 'call', type: 'callWorkflow', workflowKey: 'sub' },
    {
      id: 'tr',
      type: 'approval',
      approver: {
        kind: 'filter',
        match: { field: 'departmentId', op: 'eq', value: '00000000-0000-0000-0000-000000000000' },
      },
    },
    { id: 'a', type: 'approved' },
  ],
  edges: [
    { id: 'e1', source: 's', target: 'call' },
    { id: 'e2', source: 'call', target: 'tr' },
    { id: 'e3', source: 'tr', target: 'a' },
  ],
};

const sub: WorkflowGraph = {
  nodes: [
    { id: 's', type: 'start' },
    { id: 'm', type: 'approval', approver: { kind: 'manager' } },
    { id: 'a', type: 'approved' },
  ],
  edges: [
    { id: 'e1', source: 's', target: 'm' },
    { id: 'e2', source: 'm', target: 'a' },
  ],
};

describe('inlineCallWorkflows', () => {
  it('splices the sub-flow between predecessor and continuation', () => {
    const flat = inlineCallWorkflows(parent, new Map([['sub', sub]]));
    // No callWorkflow nodes remain; result validates.
    expect(flat.nodes.some((n) => n.type === 'callWorkflow')).toBe(false);
    expect(graphSchema.safeParse(flat).success).toBe(true);
    // Manager (from sub) then Treasury (parent continuation) → approved.
    let r = advance(flat, createInitialState(flat), {}, new Set());
    expect(r.createTasks.length).toBe(1); // the sub's manager step
    const mgr = r.createTasks[0];
    r = advance(flat, applyApproval(flat, r.state, mgr), {}, new Set());
    expect(r.createTasks.length).toBe(1); // Treasury
    const tr = r.createTasks[0];
    r = advance(flat, applyApproval(flat, r.state, tr), {}, new Set());
    expect(r.status).toBe('APPROVED');
  });

  it('passes through an unknown workflow key', () => {
    const flat = inlineCallWorkflows(parent, new Map());
    expect(flat.nodes.some((n) => n.type === 'callWorkflow')).toBe(false);
    // start → tr → approved (sub skipped).
    let r = advance(flat, createInitialState(flat), {}, new Set());
    const tr = r.createTasks[0];
    r = advance(flat, applyApproval(flat, r.state, tr), {}, new Set());
    expect(r.status).toBe('APPROVED');
  });

  it('breaks a self-referential cycle via the depth/path guard', () => {
    const selfCall: WorkflowGraph = {
      nodes: [
        { id: 's', type: 'start' },
        { id: 'c', type: 'callWorkflow', workflowKey: 'loop' },
        { id: 'a', type: 'approved' },
      ],
      edges: [
        { id: 'e1', source: 's', target: 'c' },
        { id: 'e2', source: 'c', target: 'a' },
      ],
    };
    const flat = inlineCallWorkflows(selfCall, new Map([['loop', selfCall]]));
    expect(flat.nodes.some((n) => n.type === 'callWorkflow')).toBe(false);
    expect(advance(flat, createInitialState(flat), {}, new Set()).status).toBe('APPROVED');
  });
});
