/**
 * VX2-4a — the approver token codec. Pure, no database.
 *
 * This is the whole reason the codec is not inside the `'use server'` actions
 * file: the encoding is the contract between the admin page and the rows it
 * writes, and if it drifts, a tenant's ladder quietly starts routing to the
 * wrong people. Cheap to pin, expensive to debug from a stored row.
 */
import { describe, it, expect } from 'vitest';
import {
  approverChoices,
  decodeApproverList,
  decodeApproverToken,
  encodeApproverToken,
  ApproverTokenError,
} from '@/lib/approvals/approver-token';
import { MAX_MANAGER_LEVEL, type ApprovalPolicyApproverRow } from '@/lib/approvals/tiers';

/** A stored row, with only the fields the codec reads set. */
const row = (over: Partial<ApprovalPolicyApproverRow>): ApprovalPolicyApproverRow =>
  ({
    id: 'a1',
    policy_id: 'p1',
    position: 1,
    approver_kind: 'MANAGER',
    manager_level: 1,
    approver_role: null,
    approver_user_id: null,
    external_email: null,
    display_name: null,
    ...over,
  }) as ApprovalPolicyApproverRow;

describe('encode → decode round-trips', () => {
  it('carries a reporting-line level through unchanged', () => {
    for (let level = 1; level <= MAX_MANAGER_LEVEL; level += 1) {
      const token = encodeApproverToken(row({ approver_kind: 'MANAGER', manager_level: level }));
      expect(token).toBe(`MANAGER:${level}`);
      expect(decodeApproverToken(token, 1)).toEqual({
        position: 1,
        approverKind: 'MANAGER',
        managerLevel: level,
      });
    }
  });

  it('carries a role through unchanged', () => {
    const token = encodeApproverToken(
      row({ approver_kind: 'ROLE', manager_level: null, approver_role: 'ADMIN' }),
    );
    expect(token).toBe('ROLE:ADMIN');
    expect(decodeApproverToken(token, 2)).toEqual({
      position: 2,
      approverKind: 'ROLE',
      approverRole: 'ADMIN',
    });
  });

  it('carries a person through unchanged, uuid and all', () => {
    const id = '00000000-0000-4000-8000-00000000000a';
    const token = encodeApproverToken(
      row({ approver_kind: 'USER', manager_level: null, approver_user_id: id }),
    );
    expect(token).toBe(`USER:${id}`);
    expect(decodeApproverToken(token, 1)).toEqual({
      position: 1,
      approverKind: 'USER',
      approverUserId: id,
    });
  });

  it('encodes an EMAIL approver as blank — it is stored but never offered', () => {
    // The resolver refuses to route onto an external approver until VX2-8, so
    // offering one here would let an admin save a ladder that breaks every
    // submit in the tenant. Blank means the page renders it read-only.
    expect(
      encodeApproverToken(
        row({ approver_kind: 'EMAIL', manager_level: null, external_email: 'ext@vendor.test' }),
      ),
    ).toBe('');
  });

  it('encodes a half-written stored row as blank rather than a broken token', () => {
    // Should be impossible — approval_policy_approver_complete forbids it — but
    // if one ever exists, blank is the safe render. `ROLE:` would decode into an
    // exception on the next save of an unrelated rung.
    expect(encodeApproverToken(row({ approver_kind: 'ROLE', manager_level: null }))).toBe('');
    expect(encodeApproverToken(row({ approver_kind: 'USER', manager_level: null }))).toBe('');
  });
});

describe('decode refuses what the schema would refuse', () => {
  it('rejects an out-of-range reporting-line level', () => {
    expect(() => decodeApproverToken('MANAGER:0', 1)).toThrow(ApproverTokenError);
    expect(() => decodeApproverToken(`MANAGER:${MAX_MANAGER_LEVEL + 1}`, 1)).toThrow(
      /reporting-line level/,
    );
    expect(() => decodeApproverToken('MANAGER:two', 1)).toThrow(ApproverTokenError);
  });

  it('rejects a role outside the vocabulary', () => {
    expect(() => decodeApproverToken('ROLE:WIZARD', 1)).toThrow(/unrecognised role/);
  });

  it('rejects "a specific person" with no person', () => {
    // The exact half-configured state ExpenseOS needed a zod schema to catch —
    // their editor wrote { kind: 'user', userId: '' } the moment somebody chose
    // the option and before they said who (GAP-AUDIT AP-11).
    expect(() => decodeApproverToken('USER:', 1)).toThrow(/pick a person/);
  });

  it('rejects a malformed or unknown token', () => {
    expect(() => decodeApproverToken('MANAGER', 1)).toThrow(ApproverTokenError);
    expect(() => decodeApproverToken(':1', 1)).toThrow(ApproverTokenError);
    expect(() => decodeApproverToken('EMAIL:ext@vendor.test', 1)).toThrow(/unrecognised approver/);
    expect(() => decodeApproverToken('', 1)).toThrow(ApproverTokenError);
  });
});

describe('decoding a whole rung', () => {
  it('numbers positions by the order shown, and drops the blank rows', () => {
    // "One empty select at the end" is the add-another affordance, and setting a
    // select back to none is how an approver is removed — both depend on this.
    expect(decodeApproverList(['MANAGER:1', '', 'ROLE:ADMIN', '  '])).toEqual([
      { position: 1, approverKind: 'MANAGER', managerLevel: 1 },
      { position: 2, approverKind: 'ROLE', approverRole: 'ADMIN' },
    ]);
  });

  it('refuses a rung with nothing chosen', () => {
    expect(() => decodeApproverList(['', ''])).toThrow(/at least one approver/);
    expect(() => decodeApproverList([])).toThrow(/at least one approver/);
  });
});

describe('the choices offered', () => {
  it('offers every reporting-line level, every role, and each person', () => {
    const choices = approverChoices([
      { id: 'u1', email: 'a@x.test', display_name: 'Ada' },
      { id: 'u2', email: 'b@x.test', display_name: null },
    ]);
    expect(choices.filter((c) => c.group === 'Reporting line')).toHaveLength(MAX_MANAGER_LEVEL);
    expect(choices.filter((c) => c.group === 'A specific person').map((c) => c.label)).toEqual([
      'Ada',
      // Falls back to the email when there is no display name, so an option is
      // never a blank line an admin has to guess at.
      'b@x.test',
    ]);
    expect(choices.some((c) => c.value === 'ROLE:ADMIN')).toBe(true);
  });

  it('offers NO external-approver option', () => {
    const choices = approverChoices([]);
    expect(choices.some((c) => c.value.startsWith('EMAIL'))).toBe(false);
  });

  it('offers only values its own decoder accepts', () => {
    // The property that matters: the page cannot present a choice that the save
    // path rejects. Without this, adding a kind to the vocabulary and forgetting
    // the decoder produces a select that errors on submit.
    for (const c of approverChoices([{ id: 'u1', email: 'a@x.test', display_name: 'Ada' }])) {
      expect(() => decodeApproverToken(c.value, 1)).not.toThrow();
    }
  });
});
