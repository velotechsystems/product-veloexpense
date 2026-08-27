/**
 * VX2-1 — the approval ladder, unit level. No database: planApproval and the
 * assert* functions are pure, which is the point of keeping them in
 * lib/approvals/tiers.ts (same split as lib/policy/rules.ts).
 *
 * Two things are worth most of the attention here:
 *  1. the ladder is CUMULATIVE — a report collects every rung it reaches, not
 *     the one band it falls in (this is where VeloExpense diverges from
 *     VeloLedger 0066's mutually-exclusive ranges, and why), and
 *  2. each rung's approvers FLATTEN in position order into numbered steps
 *     (this is what VeloExpense takes FROM VeloLedger 0066).
 */
import { describe, it, expect } from 'vitest';
import {
  ApprovalConfigError,
  DEFAULT_LADDER,
  MAX_APPROVAL_STEPS,
  assertApproverInput,
  assertPolicyInput,
  isImplicitPlan,
  planApproval,
  type ApprovalPolicyApproverRow,
  type ApprovalPolicyRow,
  type NewApprovalPolicy,
  type NewApprover,
} from '@/lib/approvals/tiers';

function approver(
  over: Partial<ApprovalPolicyApproverRow> & Pick<ApprovalPolicyApproverRow, 'position'>,
): ApprovalPolicyApproverRow {
  return {
    id: `ap-${over.position}`,
    policy_id: 'p',
    approver_kind: 'MANAGER',
    manager_level: 1,
    approver_role: null,
    approver_user_id: null,
    external_email: null,
    display_name: null,
    ...over,
  };
}

function rung(
  over: Partial<ApprovalPolicyRow> & Pick<ApprovalPolicyRow, 'sequence'>,
): ApprovalPolicyRow {
  return {
    id: `rung-${over.sequence}`,
    name: `Rung ${over.sequence}`,
    threshold_minor: '0',
    require_receipt_view_ack: true,
    enabled: true,
    created_at: new Date(0),
    updated_at: new Date(0),
    approvers: [approver({ position: 1 })],
    ...over,
  };
}

/** The starter ladder as it would come back from the database. */
const LADDER: ApprovalPolicyRow[] = [
  rung({ sequence: 1, threshold_minor: '0' }),
  rung({ sequence: 2, threshold_minor: '100000', approvers: [approver({ position: 1, manager_level: 2 })] }),
  rung({
    sequence: 3,
    threshold_minor: '500000',
    approvers: [
      approver({ position: 1, approver_kind: 'ROLE', manager_level: null, approver_role: 'ADMIN' }),
    ],
  }),
];

describe('planApproval — cumulative rungs', () => {
  it('collects every rung the total reaches', () => {
    expect(planApproval(LADDER, '20000').map((s) => s.policyName)).toEqual(['Rung 1']);
    expect(planApproval(LADDER, '150000').map((s) => s.policyName)).toEqual(['Rung 1', 'Rung 2']);
    expect(planApproval(LADDER, '600000').map((s) => s.policyName)).toEqual([
      'Rung 1',
      'Rung 2',
      'Rung 3',
    ]);
  });

  it('treats the threshold as inclusive — a report AT the threshold climbs the rung', () => {
    expect(planApproval(LADDER, '100000')).toHaveLength(2);
    expect(planApproval(LADDER, '99999')).toHaveLength(1);
  });

  it('orders by sequence, not by threshold', () => {
    // Finance (sequence 1) signs BEFORE the manager (sequence 2) even though its
    // threshold is higher — that is what a separate sequence column is for.
    const ladder = [
      rung({ sequence: 1, threshold_minor: '500000', name: 'Finance' }),
      rung({ sequence: 2, threshold_minor: '0', name: 'Manager' }),
    ];
    expect(planApproval(ladder, '600000').map((s) => s.policyName)).toEqual([
      'Finance',
      'Manager',
    ]);
  });

  it('skips a disabled rung without shifting the rest of the ladder', () => {
    const ladder = [
      rung({ sequence: 1, name: 'One' }),
      rung({ sequence: 2, name: 'Two', enabled: false }),
      rung({ sequence: 3, name: 'Three' }),
    ];
    expect(planApproval(ladder, '1000').map((s) => s.policyName)).toEqual(['One', 'Three']);
  });

  it('compares with bigint math, so a total past 2^53 cents still bands correctly', () => {
    const ladder = [rung({ sequence: 1, threshold_minor: '9007199254740993' })];
    expect(planApproval(ladder, '9007199254740993')).toHaveLength(1);
    // 2^53 exactly — one cent below the threshold. Under float compare these two
    // totals are the same number and this assertion would fail.
    expect(isImplicitPlan(planApproval(ladder, '9007199254740992'))).toBe(true);
  });
});

describe('planApproval — flattening a rung ordered approvers', () => {
  it('emits one step per approver, in position order', () => {
    const ladder = [
      rung({
        sequence: 1,
        name: 'Two signers',
        approvers: [
          approver({ position: 2, approver_kind: 'ROLE', manager_level: null, approver_role: 'ADMIN' }),
          approver({ position: 1, manager_level: 1 }),
        ],
      }),
    ];
    const plan = planApproval(ladder, '1000');
    expect(plan.map((s) => [s.step, s.position, s.approverKind])).toEqual([
      [1, 1, 'MANAGER'],
      [2, 2, 'ROLE'],
    ]);
  });

  it('numbers steps continuously ACROSS rungs', () => {
    const ladder = [
      rung({
        sequence: 1,
        approvers: [approver({ position: 1 }), approver({ position: 2, manager_level: 2 })],
      }),
      rung({
        sequence: 2,
        threshold_minor: '5000',
        approvers: [
          approver({ position: 1, approver_kind: 'ROLE', manager_level: null, approver_role: 'ADMIN' }),
        ],
      }),
    ];
    const plan = planApproval(ladder, '9000');
    expect(plan.map((s) => s.step)).toEqual([1, 2, 3]);
    // step is global; position is within the rung. Both are needed, and
    // conflating them is how "approval 2 of 3" starts lying.
    expect(plan.map((s) => [s.sequence, s.position])).toEqual([
      [1, 1],
      [1, 2],
      [2, 1],
    ]);
  });

  it('inherits requireReceiptViewAck from the rung onto every step', () => {
    const ladder = [
      rung({
        sequence: 1,
        require_receipt_view_ack: false,
        approvers: [approver({ position: 1 }), approver({ position: 2, manager_level: 2 })],
      }),
    ];
    expect(planApproval(ladder, '1000').map((s) => s.requireReceiptViewAck)).toEqual([
      false,
      false,
    ]);
  });

  it('refuses a rung with no approver rather than skipping it', () => {
    // Only reachable via a hand-run DELETE, but planning a step nobody can
    // decide is strictly worse than refusing to plan.
    const ladder = [rung({ sequence: 1, approvers: [] })];
    try {
      planApproval(ladder, '1000');
      throw new Error('expected planApproval to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ApprovalConfigError);
      expect((err as ApprovalConfigError).code).toBe('RUNG_WITHOUT_APPROVER');
    }
  });

  it('counts FLATTENED steps against the cap, and refuses rather than truncating', () => {
    // Three rungs, two approvers each = six steps, past the cap of five, even
    // though only three rungs apply. Truncating would drop the finance sign-off
    // on the largest reports — the one approval nobody would choose to lose.
    const ladder = [1, 2, 3].map((n) =>
      rung({
        sequence: n,
        approvers: [approver({ position: 1 }), approver({ position: 2, manager_level: 2 })],
      }),
    );
    try {
      planApproval(ladder, '1000');
      throw new Error('expected planApproval to throw');
    } catch (err) {
      expect((err as ApprovalConfigError).code).toBe('TOO_MANY_STEPS');
      expect((err as Error).message).toContain(String(MAX_APPROVAL_STEPS));
    }
  });

  it('carries the external email onto the step for an EMAIL approver', () => {
    const ladder = [
      rung({
        sequence: 1,
        approvers: [
          approver({
            position: 1,
            approver_kind: 'EMAIL',
            manager_level: null,
            external_email: 'cfo@client.example',
            display_name: 'Client CFO',
          }),
        ],
      }),
    ];
    expect(planApproval(ladder, '1000')[0]).toMatchObject({
      approverKind: 'EMAIL',
      externalEmail: 'cfo@client.example',
      displayName: 'Client CFO',
    });
  });
});

describe('planApproval — the implicit fallback', () => {
  it('falls back to the implicit direct-manager step when nothing is configured', () => {
    const plan = planApproval([], '999999');
    expect(plan).toHaveLength(1);
    expect(plan[0].policyId).toBeNull();
    expect(plan[0].approverKind).toBe('MANAGER');
    expect(plan[0].managerLevel).toBe(1);
    expect(plan[0].requireReceiptViewAck).toBe(true);
    expect(isImplicitPlan(plan)).toBe(true);
  });

  it('falls back when rungs EXIST but none applies', () => {
    // A tenant whose cheapest rung starts at $1,000 has not said "approve small
    // reports automatically" — a human still signs off.
    expect(isImplicitPlan(planApproval([rung({ sequence: 1, threshold_minor: '100000' })], '500'))).toBe(
      true,
    );
  });

  it('does not report a configured single-step plan as implicit', () => {
    expect(isImplicitPlan(planApproval(LADDER, '1000'))).toBe(false);
  });
});

describe('assertApproverInput', () => {
  const manager: NewApprover = { position: 1, approverKind: 'MANAGER', managerLevel: 1 };

  it('accepts one of each valid kind', () => {
    expect(() => assertApproverInput(manager)).not.toThrow();
    expect(() =>
      assertApproverInput({ position: 1, approverKind: 'ROLE', approverRole: 'ADMIN' }),
    ).not.toThrow();
    expect(() =>
      assertApproverInput({ position: 1, approverKind: 'USER', approverUserId: 'u' }),
    ).not.toThrow();
    expect(() =>
      assertApproverInput({ position: 1, approverKind: 'EMAIL', externalEmail: 'a@b.co' }),
    ).not.toThrow();
  });

  it('rejects an unknown ROLE — this is the ONLY gate, since there is no DB CHECK', () => {
    // approval_policy_approver.approver_role deliberately has no CHECK
    // constraint, so per-tenant custom roles can land without a migration. That
    // makes this assertion the whole guarantee, not a convenience.
    try {
      assertApproverInput({ position: 1, approverKind: 'ROLE', approverRole: 'CFO' as never });
      throw new Error('expected assertApproverInput to throw');
    } catch (err) {
      expect((err as ApprovalConfigError).code).toBe('INVALID_ROLE');
    }
  });

  it.each([
    ['position 0', { position: 0, approverKind: 'MANAGER' as const, managerLevel: 1 }, 'INVALID_POSITION'],
    ['a fractional position', { position: 1.5, approverKind: 'MANAGER' as const, managerLevel: 1 }, 'INVALID_POSITION'],
    ['an unknown kind', { position: 1, approverKind: 'ROBOT' as never }, 'INVALID_KIND'],
    ['a manager with no level', { position: 1, approverKind: 'MANAGER' as const }, 'INVALID_MANAGER_LEVEL'],
    ['a manager level of 6', { position: 1, approverKind: 'MANAGER' as const, managerLevel: 6 }, 'INVALID_MANAGER_LEVEL'],
    ['a manager that also names a person', { position: 1, approverKind: 'MANAGER' as const, managerLevel: 1, approverUserId: 'u' }, 'INVALID_APPROVER'],
    ['a role with no role', { position: 1, approverKind: 'ROLE' as const }, 'INVALID_ROLE'],
    ['a role that also names a level', { position: 1, approverKind: 'ROLE' as const, approverRole: 'ADMIN' as const, managerLevel: 1 }, 'INVALID_APPROVER'],
    ['a user with no person', { position: 1, approverKind: 'USER' as const }, 'INVALID_APPROVER'],
    ['an email approver with no address', { position: 1, approverKind: 'EMAIL' as const }, 'INVALID_EMAIL'],
    ['a malformed address', { position: 1, approverKind: 'EMAIL' as const, externalEmail: 'not-an-email' }, 'INVALID_EMAIL'],
  ])('refuses %s', (_label, input, code) => {
    try {
      assertApproverInput(input as NewApprover);
      throw new Error('expected assertApproverInput to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ApprovalConfigError);
      expect((err as ApprovalConfigError).code).toBe(code);
    }
  });
});

describe('assertPolicyInput', () => {
  const base: NewApprovalPolicy = {
    name: 'Manager',
    sequence: 1,
    approvers: [{ position: 1, approverKind: 'MANAGER', managerLevel: 1 }],
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
    ['no approvers at all', { ...base, approvers: [] }, 'NO_APPROVERS'],
  ])('refuses %s', (_label, input, code) => {
    try {
      assertPolicyInput(input as NewApprovalPolicy);
      throw new Error('expected assertPolicyInput to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ApprovalConfigError);
      expect((err as ApprovalConfigError).code).toBe(code);
    }
  });

  it('refuses two approvers sharing a position', () => {
    try {
      assertPolicyInput({
        ...base,
        approvers: [
          { position: 1, approverKind: 'MANAGER', managerLevel: 1 },
          { position: 1, approverKind: 'ROLE', approverRole: 'ADMIN' },
        ],
      });
      throw new Error('expected assertPolicyInput to throw');
    } catch (err) {
      expect((err as ApprovalConfigError).code).toBe('INVALID_POSITION');
    }
  });
});
