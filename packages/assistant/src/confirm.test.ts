import type { ToolSpec } from '@expenseos/mcp-server';
import { TOOLS } from '@expenseos/mcp-server';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  confirmationEnvelope,
  hashToolInput,
  type PendingAction,
  rejectConfirmation,
  requiresConfirmation,
  stableStringify,
} from './confirm';

const NOW = new Date('2026-08-17T12:00:00Z');
const LATER = new Date('2026-08-17T12:05:00Z');

const mutateSpec: ToolSpec = {
  name: 'submit_expense_report',
  description: 'x'.repeat(90),
  input: z.object({ reportId: z.string().uuid() }),
  path: 'expenses.submit',
  kind: 'mutate',
  scope: 'expense_management.expense_report',
  access: 'write',
};

const pending = (over: Partial<PendingAction> = {}): PendingAction => ({
  userId: 'user-1',
  toolName: 'submit_expense_report',
  inputHash: hashToolInput('submit_expense_report', { reportId: 'r1' }),
  status: 'PENDING',
  expiresAt: LATER,
  ...over,
});

const attempt = (over: Record<string, unknown> = {}) => ({
  userId: 'user-1',
  toolName: 'submit_expense_report',
  input: { reportId: 'r1' },
  now: NOW,
  ...over,
});

describe('requiresConfirmation', () => {
  it('gates mutations and lets reads through', () => {
    expect(requiresConfirmation({ kind: 'mutate' })).toBe(true);
    expect(requiresConfirmation({ kind: 'read' })).toBe(false);
  });

  it('gates every mutating tool in the registry', () => {
    for (const tool of TOOLS) {
      expect(requiresConfirmation(tool), tool.name).toBe(tool.kind === 'mutate');
    }
  });
});

describe('stableStringify', () => {
  it('is independent of key insertion order', () => {
    // Two code paths building the same call must fingerprint identically, or a
    // legitimate confirmation is rejected for no reason a user could understand.
    expect(stableStringify({ a: 1, b: 2 })).toBe(stableStringify({ b: 2, a: 1 }));
  });

  it('sorts nested keys too', () => {
    expect(stableStringify({ o: { x: 1, y: 2 } })).toBe(stableStringify({ o: { y: 2, x: 1 } }));
  });

  it('preserves array order, where order is meaning', () => {
    expect(stableStringify([1, 2])).not.toBe(stableStringify([2, 1]));
  });

  it('ignores undefined members, which JSON drops anyway', () => {
    expect(stableStringify({ a: 1, b: undefined })).toBe(stableStringify({ a: 1 }));
  });
});

describe('hashToolInput', () => {
  it('separates the same input under different tools', () => {
    // `{id}` means something very different to "submit travel request" and "close card".
    expect(hashToolInput('submit_travel_request', { id: 'x' })).not.toBe(
      hashToolInput('set_virtual_card_status', { id: 'x' }),
    );
  });

  it('is stable across key order', () => {
    expect(hashToolInput('t', { a: 1, b: 2 })).toBe(hashToolInput('t', { b: 2, a: 1 }));
  });
});

describe('confirmationEnvelope', () => {
  it('returns a proposal rather than a result', () => {
    const env = confirmationEnvelope(
      mutateSpec,
      { reportId: 'r1' },
      { confirmationId: 'act-1', expiresAt: LATER },
    );
    expect(env.status).toBe('confirmation_required');
    expect(env.toolName).toBe('submit_expense_report');
    expect(env.input).toEqual({ reportId: 'r1' });
    expect(env.inputHash).toBe(hashToolInput('submit_expense_report', { reportId: 'r1' }));
  });
});

describe('rejectConfirmation', () => {
  it('allows a matching, pending, unexpired confirmation by the right user', () => {
    expect(rejectConfirmation(pending(), attempt())).toBeNull();
  });

  it('refuses a confirmation that was already spent', () => {
    // Single-use. Without this, one press approves a report twice.
    expect(rejectConfirmation(pending({ status: 'CONFIRMED' }), attempt())).toEqual({
      kind: 'not_pending',
      status: 'CONFIRMED',
    });
  });

  it('refuses an expired confirmation', () => {
    const expired = pending({ expiresAt: new Date('2026-08-17T11:59:00Z') });
    expect(rejectConfirmation(expired, attempt())).toMatchObject({ kind: 'expired' });
  });

  it('treats expiry as inclusive', () => {
    // A confirmation expiring exactly now is expired. Ties go to refusing.
    expect(rejectConfirmation(pending({ expiresAt: NOW }), attempt())).toMatchObject({
      kind: 'expired',
    });
  });

  it('refuses a confirmation pressed by somebody else', () => {
    // An id that leaked into another session must not execute there.
    expect(rejectConfirmation(pending(), attempt({ userId: 'user-2' }))).toEqual({
      kind: 'wrong_user',
    });
  });

  it('refuses when the input changed after the human saw it', () => {
    // The whole point of the gate: what was confirmed is what runs.
    expect(rejectConfirmation(pending(), attempt({ input: { reportId: 'r2' } }))).toEqual({
      kind: 'input_changed',
    });
  });

  it('refuses when the tool changed but the input did not', () => {
    // Same `{reportId}` shape, different action — a confirmation to submit must not be
    // spendable as a recall.
    expect(rejectConfirmation(pending(), attempt({ toolName: 'recall_expense_report' }))).toEqual({
      kind: 'input_changed',
    });
  });

  it('checks status before expiry', () => {
    // A spent confirmation that is also stale reports as spent — the more specific and
    // more alarming of the two.
    const both = pending({ status: 'CONFIRMED', expiresAt: new Date('2026-01-01T00:00:00Z') });
    expect(rejectConfirmation(both, attempt())).toMatchObject({ kind: 'not_pending' });
  });
});
