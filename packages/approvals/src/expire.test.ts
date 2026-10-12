import { describe, expect, it } from 'vitest';
import { defaultOnExpire } from './engine';
import type { WorkflowNode } from './schema';

const pos = { x: 0, y: 0 };
const node = (over: Partial<WorkflowNode>): WorkflowNode =>
  ({
    id: 'n',
    type: 'approval',
    approver: { kind: 'manager' },
    position: pos,
    ...over,
  }) as WorkflowNode;

describe('defaultOnExpire', () => {
  it('escalates manager / managerChain approvals by default', () => {
    expect(defaultOnExpire(node({ approver: { kind: 'manager' } }))).toBe('ESCALATE');
    expect(defaultOnExpire(node({ approver: { kind: 'managerChain' } }))).toBe('ESCALATE');
  });

  it('rejects filter-pool approvals by default (no single chain to climb)', () => {
    expect(defaultOnExpire(node({ approver: { kind: 'filter', match: { always: true } } }))).toBe(
      'REJECT',
    );
  });

  it('honors an explicit onExpire over the default', () => {
    expect(defaultOnExpire(node({ approver: { kind: 'manager' }, onExpire: 'REJECT' }))).toBe(
      'REJECT',
    );
    expect(
      defaultOnExpire(
        node({ approver: { kind: 'filter', match: { always: true } }, onExpire: 'APPROVE' }),
      ),
    ).toBe('APPROVE');
  });

  it('rejects for a missing or non-approval node (never auto-approves)', () => {
    expect(defaultOnExpire(undefined)).toBe('REJECT');
    expect(defaultOnExpire(node({ type: 'start' }))).toBe('REJECT');
  });
});
