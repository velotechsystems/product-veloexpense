import { describe, expect, it } from 'vitest';
import {
  confirmationBlock,
  pendingConfirmation,
  readMarker,
  rejectPress,
  type StoredMessage,
  settleMarker,
} from './pending';

const T0 = new Date('2026-08-18T12:00:00Z');
const later = (ms: number) => new Date(T0.getTime() + ms);

const toolUse = (id: string, name: string, input: unknown) => ({
  type: 'tool_use',
  id,
  name,
  input,
});

const proposal = (id: string, name: string, input: unknown, expiresAt = later(60_000)) =>
  confirmationBlock({ toolUseId: id, toolName: name, toolInput: input, expiresAt });

const transcript = (...pairs: { assistant: unknown[]; user?: unknown[] }[]): StoredMessage[] => {
  const rows: StoredMessage[] = [];
  pairs.forEach((pair, i) => {
    rows.push({ id: `a${i}`, role: 'assistant', content: pair.assistant, createdAt: T0 });
    if (pair.user) rows.push({ id: `u${i}`, role: 'user', content: pair.user, createdAt: T0 });
  });
  return rows;
};

describe('confirmationBlock', () => {
  it('is not an error', () => {
    // Needing a press is the gate working. Marking it as an error teaches the model to
    // apologise for it.
    const block = proposal('t1', 'submit_expense_report', { reportId: 'r-1' });
    expect((block as unknown as Record<string, unknown>).is_error).toBeUndefined();
    expect(readMarker(block)?.status).toBe('confirmation_required');
  });

  it('fingerprints the proposed input', () => {
    const a = readMarker(proposal('t1', 'submit_expense_report', { reportId: 'r-1' }))?.inputHash;
    const b = readMarker(proposal('t2', 'submit_expense_report', { reportId: 'r-2' }))?.inputHash;
    expect(a).not.toBe(b);
  });
});

describe('readMarker', () => {
  it('returns null for blocks that are not ours', () => {
    expect(readMarker({ type: 'text', text: 'hello' })).toBeNull();
    expect(
      readMarker({ type: 'tool_result', tool_use_id: 't1', content: 'plain result' }),
    ).toBeNull();
    expect(readMarker(null)).toBeNull();
  });

  it('treats unparseable content as not a proposal', () => {
    // Asymmetric consequences: refusing to confirm something unreadable costs a click,
    // while treating it as pressable lands a press on a proposal nobody can see.
    expect(readMarker({ type: 'tool_result', tool_use_id: 't1', content: '{oops' })).toBeNull();
  });
});

describe('pendingConfirmation', () => {
  it('finds the proposal a person could still press', () => {
    const rows = transcript({
      assistant: [toolUse('t1', 'submit_expense_report', { reportId: 'r-1' })],
      user: [proposal('t1', 'submit_expense_report', { reportId: 'r-1' })],
    });
    const pending = pendingConfirmation(rows, T0);
    expect(pending).toMatchObject({ toolUseId: 't1', toolName: 'submit_expense_report' });
    expect(pending?.input).toEqual({ reportId: 'r-1' });
    expect(pending?.messageId).toBe('u0');
  });

  it('reads the input from the tool call, not from the marker', () => {
    // The property that makes a side table unnecessary: rewriting the marker cannot change
    // what would execute.
    const tampered = {
      type: 'tool_result',
      tool_use_id: 't1',
      content: JSON.stringify({
        ...readMarker(proposal('t1', 'submit_expense_report', { reportId: 'r-1' })),
        input: { reportId: 'r-999' },
      }),
    };
    const rows = transcript({
      assistant: [toolUse('t1', 'submit_expense_report', { reportId: 'r-1' })],
      user: [tampered],
    });
    expect(pendingConfirmation(rows, T0)?.input).toEqual({ reportId: 'r-1' });
  });

  it('finds nothing once the proposal is settled', () => {
    const rows = transcript({
      assistant: [toolUse('t1', 'submit_expense_report', { reportId: 'r-1' })],
      user: [proposal('t1', 'submit_expense_report', { reportId: 'r-1' })],
    });
    const settled = settleMarker(rows[1].content, 't1', { status: 'confirmed', at: T0 });
    expect(pendingConfirmation([rows[0], { ...rows[1], content: settled }], T0)).toBeNull();
  });

  it('finds nothing once the proposal has expired', () => {
    const rows = transcript({
      assistant: [toolUse('t1', 'submit_expense_report', { reportId: 'r-1' })],
      user: [proposal('t1', 'submit_expense_report', { reportId: 'r-1' }, later(1000))],
    });
    expect(pendingConfirmation(rows, later(2000))).toBeNull();
  });

  it('does not resurrect an older proposal the conversation moved past', () => {
    // Someone who ignored a proposal and carried on has walked away from that decision.
    const rows = transcript(
      {
        assistant: [toolUse('t1', 'submit_expense_report', { reportId: 'r-1' })],
        user: [proposal('t1', 'submit_expense_report', { reportId: 'r-1' })],
      },
      {
        assistant: [toolUse('t2', 'recall_expense_report', { reportId: 'r-2' })],
        user: [proposal('t2', 'recall_expense_report', { reportId: 'r-2' })],
      },
    );
    const settled = settleMarker(rows[3].content, 't2', { status: 'declined', at: T0 });
    const moved = [...rows.slice(0, 3), { ...rows[3], content: settled }];
    expect(pendingConfirmation(moved, T0)).toBeNull();
  });

  it('refuses a proposal whose tool call is missing', () => {
    // A marker with no call behind it has no verifiable input, so there is nothing safe to
    // execute.
    const rows: StoredMessage[] = [
      {
        id: 'u0',
        role: 'user',
        content: [proposal('t1', 'submit_expense_report', {})],
        createdAt: T0,
      },
    ];
    expect(pendingConfirmation(rows, T0)).toBeNull();
  });

  it('finds nothing in a conversation that never proposed anything', () => {
    const rows = transcript({ assistant: [{ type: 'text', text: 'Here are your reports.' }] });
    expect(pendingConfirmation(rows, T0)).toBeNull();
  });
});

describe('rejectPress', () => {
  const rows = transcript({
    assistant: [toolUse('t1', 'submit_expense_report', { reportId: 'r-1' })],
    user: [proposal('t1', 'submit_expense_report', { reportId: 'r-1' })],
  });
  const pending = pendingConfirmation(rows, T0);
  if (!pending) throw new Error('fixture should propose something');

  it('honours a press on the proposal that was shown', () => {
    expect(rejectPress(pending, { toolUseId: 't1', now: T0 })).toBeNull();
  });

  it('refuses a press naming a different call', () => {
    expect(rejectPress(pending, { toolUseId: 't2', now: T0 })).toEqual({ kind: 'input_changed' });
  });

  it('refuses a press that arrives after the proposal expired', () => {
    expect(rejectPress(pending, { toolUseId: 't1', now: later(60_001) })).toMatchObject({
      kind: 'expired',
    });
  });
});

describe('settleMarker', () => {
  it('rewrites only the marker it names', () => {
    const content = [
      proposal('t1', 'submit_expense_report', { reportId: 'r-1' }),
      proposal('t2', 'recall_expense_report', { reportId: 'r-2' }),
      { type: 'text', text: 'unrelated' },
    ];
    const settled = settleMarker(content, 't1', {
      status: 'confirmed',
      result: { ok: true },
      at: T0,
    });
    expect(readMarker(settled[0])).toMatchObject({ status: 'confirmed', result: { ok: true } });
    expect(readMarker(settled[1])?.status).toBe('confirmation_required');
    expect(settled[2]).toEqual({ type: 'text', text: 'unrelated' });
  });

  it('keeps the proposed input when settling', () => {
    // The transcript has to stay true about what was agreed to, not just that something was.
    const content = [proposal('t1', 'submit_expense_report', { reportId: 'r-1' })];
    const settled = settleMarker(content, 't1', { status: 'confirmed', at: T0 });
    expect(readMarker(settled[0])?.input).toEqual({ reportId: 'r-1' });
  });

  it('serialises a BigInt in the tool result instead of throwing', () => {
    /**
     * Tool results carry money in minor units as `BigInt` — `requestedLimitMinor`,
     * `spendLimitMinor` — and `JSON.stringify` refuses a BigInt outright. `settleMarker` runs
     * AFTER the tool has executed, which made a throw here the worst place for one: the card
     * request existed, the request 500'd, and the marker stayed `confirmation_required` — a
     * live Confirm button on an action that had already happened, and a second press ran it
     * again. Serialised as a decimal string, the same way `runTurn` already answers reads.
     */
    const rows = transcript({
      assistant: [toolUse('t1', 'request_virtual_card', { requestedLimit: '500.00' })],
      user: [proposal('t1', 'request_virtual_card', { requestedLimit: '500.00' })],
    });
    const settled = settleMarker(rows[1].content, 't1', {
      status: 'confirmed',
      result: { id: 'vcr-1', requestedLimitMinor: 50000n, lines: [{ amountMinor: 1n }] },
      at: T0,
    });
    const marker = readMarker(settled[0]);
    expect(marker?.status).toBe('confirmed');
    expect(marker?.result).toEqual({
      id: 'vcr-1',
      requestedLimitMinor: '50000',
      lines: [{ amountMinor: '1' }],
    });
    // Settled means no longer pressable — the single-use property has to survive the fix.
    expect(pendingConfirmation([rows[0], { ...rows[1], content: settled }], T0)).toBeNull();
  });
});
