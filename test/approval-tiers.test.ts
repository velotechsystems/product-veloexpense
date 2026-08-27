/**
 * VX2-1 — the approval ladder, unit level. No database: planApproval and
 * assertPolicyInput are pure, which is the point of keeping them in
 * lib/approvals/tiers.ts (same split as lib/policy/rules.ts).
 *
 * The interesting cases are all about the ladder being CUMULATIVE: a report
 * collects every rung it reaches, not the one band it falls in.
 */
import { describe, it, expect } from 'vitest';
import {
  ApprovalConfigError,
  DEFAULT_LADDER,
  MAX_APPROVAL_STEPS,
  assertPolicyInput,
  isImplicitPlan,
  planApproval,
  type ApprovalPolicyRow,
  type NewApprovalPolicy,
} from '@/lib/approvals/tiers';

/** A stored rung, with only the fields planApproval reads spelled out. */
function rung(over: Partial<ApprovalPolicyRow> & Pick<ApprovalPolicyRow, 'sequence'>): ApprovalPolicyRow {
  return {
    id: `rung-${over.sequence}`,
    name: `Rung ${over.sequence}`,
    threshold_minor: '0',
    approver_kind: 'MANAGER',
    manager_level: 1,
    approver_role: null,
    approver_user_id: null,
    require_receipt_view_ack: true,
    enabled: true,
    created_at: new Date(0),
    updated_at: new Date(0),
    ...over,
  };
}

/** The starter ladder as it would come back from the database. */
const LADDER: ApprovalPolicyRow[] = [
  rung({ sequence: 1, threshold_minor: '0' }),
  rung({ sequence: 2, threshold_minor: '100000', manager_level: 2 }),
  rung({
    sequence: 3,
    threshold_minor: '500000',
    approver_kind: 'ROLE',
    manager_level: null,
    approver_role: 'ADMIN',
  }),
];

describe('planApproval', () => {
  it('is cumulative: a report collects every rung it reaches', () => {
    expect(planApproval(LADDER, '20000').map((s) => s.name)).toEqual(['Rung 1']);
    expect(planApproval(LADDER, '150000').map((s) => s.name)).toEqual(['Rung 1', 'Rung 2']);
    expect(planApproval(LADDER, '600000').map((s) => s.name)).toEqual([
      'Rung 1',
      'Rung 2',
      'Rung 3',
    ]);
  });

  it('numbers the steps 1..n for THIS report, not by the rung sequence', () => {
    // Rungs 2 and 3 apply; their steps are 1 and 2, because step is a position
    // in this report's ladder and the UI counts "approval 1 of 2".
    const ladder = [
      rung({ sequence: 1, threshold_minor: '0', enabled: false }),
      rung({ sequence: 2, threshold_minor: '100000' }),
      rung({ sequence: 3, threshold_minor: '200000' }),
    ];
    expect(planApproval(ladder, '300000').map((s) => s.step)).toEqual([1, 2]);
  });

  it('treats the threshold as inclusive — a report AT the threshold climbs the rung', () => {
    expect(planApproval(LADDER, '100000')).toHaveLength(2);
    expect(planApproval(LADDER, '99999')).toHaveLength(1);
  });

  it('orders by sequence, not by threshold', () => {
    // Finance (sequence 1) signs off BEFORE the manager (sequence 2), even
    // though its threshold is higher — that is what sequence is for.
    const ladder = [
      rung({ sequence: 1, threshold_minor: '500000', name: 'Finance' }),
      rung({ sequence: 2, threshold_minor: '0', name: 'Manager' }),
    ];
    expect(planApproval(ladder, '600000').map((s) => s.name)).toEqual(['Finance', 'Manager']);
  });

  it('skips a disabled rung without shifting the rest of the ladder', () => {
    const ladder = [
      rung({ sequence: 1, threshold_minor: '0', name: 'One' }),
      rung({ sequence: 2, threshold_minor: '0', name: 'Two', enabled: false }),
      rung({ sequence: 3, threshold_minor: '0', name: 'Three' }),
    ];
    expect(planApproval(ladder, '1000').map((s) => s.name)).toEqual(['One', 'Three']);
  });

  it('falls back to the implicit direct-manager rung when nothing is configured', () => {
    const plan = planApproval([], '999999');
    expect(plan).toHaveLength(1);
    expect(plan[0].policyId).toBeNull();
    expect(plan[0].approverKind).toBe('MANAGER');
    expect(plan[0].managerLevel).toBe(1);
    expect(isImplicitPlan(plan)).toBe(true);
  });

  it('falls back when rungs EXIST but none applies', () => {
    // A tenant whose cheapest rung starts at $1,000 has not said "approve
    // small reports automatically" — a human still signs off.
    const ladder = [rung({ sequence: 1, threshold_minor: '100000' })];
    const plan = planApproval(ladder, '500');
    expect(isImplicitPlan(plan)).toBe(true);
  });

  it('does not report a configured single-rung plan as implicit', () => {
    expect(isImplicitPlan(planApproval(LADDER, '1000'))).toBe(false);
  });

  it('refuses rather than truncates when more rungs apply than a report may require', () => {
    const ladder = Array.from({ length: MAX_APPROVAL_STEPS + 1 }, (_, i) =>
      rung({ sequence: i + 1, threshold_minor: '0' }),
    );
    // Truncating would silently drop the TOP rungs, i.e. the finance sign-off on
    // the largest reports — the one approval nobody would choose to lose.
    expect(() => planApproval(ladder, '1000')).toThrowError(ApprovalConfigError);
    try {
      planApproval(ladder, '1000');
    } catch (err) {
      expect((err as ApprovalConfigError).code).toBe('TOO_MANY_STEPS');
    }
  });

  it('compares with bigint math, so a total past 2^53 cents still bands correctly', () => {
    const ladder = [rung({ sequence: 1, threshold_minor: '9007199254740993' })];
    // 2^53 + 1 exactly: equal, so the rung applies. Under float compare this
    // is indistinguishable from 2^53 and the assertion below would pass by luck,
    // so the second case is the one that matters.
    expect(planApproval(ladder, '9007199254740993')).toHaveLength(1);
    expect(isImplicitPlan(planApproval(ladder, '9007199254740992'))).toBe(true);
  });

  it('snapshots the rung, not a pointer to it', () => {
    const [step] = planApproval(LADDER, '600000').slice(2);
    expect(step).toMatchObject({
      policyId: 'rung-3',
      approverKind: 'ROLE',
      approverRole: 'ADMIN',
      requireReceiptViewAck: true,
      thresholdMinor: '500000',
    });
  });
});

describe('assertPolicyInput', () => {
  const base: NewApprovalPolicy = {
    name: 'Manager',
    sequence: 1,
    approverKind: 'MANAGER',
    managerLevel: 1,
  };

  it('accepts the shipped starter ladder', () => {
    for (const rungInput of DEFAULT_LADDER) {
      expect(() => assertPolicyInput(rungInput)).not.toThrow();
    }
  });

  it.each([
    ['a blank name', { ...base, name: '   ' }, 'INVALID_NAME'],
    ['sequence 0', { ...base, sequence: 0 }, 'INVALID_SEQUENCE'],
    ['sequence 11', { ...base, sequence: 11 }, 'INVALID_SEQUENCE'],
    ['a fractional sequence', { ...base, sequence: 1.5 }, 'INVALID_SEQUENCE'],
    ['a negative threshold', { ...base, thresholdMinor: '-1' }, 'INVALID_THRESHOLD'],
    ['an unknown kind', { ...base, approverKind: 'ROBOT' as never }, 'INVALID_KIND'],
    ['a manager rung with no level', { ...base, managerLevel: null }, 'INVALID_MANAGER_LEVEL'],
    ['a manager level of 6', { ...base, managerLevel: 6 }, 'INVALID_MANAGER_LEVEL'],
    [
      'a manager rung that also names a person',
      { ...base, approverUserId: 'someone' },
      'INVALID_APPROVER',
    ],
    [
      'a role rung with no role',
      { name: 'Finance', sequence: 2, approverKind: 'ROLE' as const },
      'INVALID_ROLE',
    ],
    [
      'a user rung with no person',
      { name: 'Named', sequence: 2, approverKind: 'USER' as const },
      'INVALID_APPROVER',
    ],
    [
      'a role rung that also names a manager level',
      { name: 'Finance', sequence: 2, approverKind: 'ROLE' as const, approverRole: 'ADMIN' as const, managerLevel: 1 },
      'INVALID_APPROVER',
    ],
  ])('refuses %s', (_label, input, code) => {
    try {
      assertPolicyInput(input as NewApprovalPolicy);
      throw new Error('expected assertPolicyInput to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ApprovalConfigError);
      expect((err as ApprovalConfigError).code).toBe(code);
    }
  });
});
