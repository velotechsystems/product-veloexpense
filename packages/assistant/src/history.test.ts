import { describe, expect, it } from 'vitest';
import { hasLiveProposal, toApiMessages } from './history';
import { confirmationBlock, readMarker, type StoredMessage, settleMarker } from './pending';

const T0 = new Date('2026-08-18T12:00:00Z');
const row = (id: string, role: string, content: unknown): StoredMessage => ({
  id,
  role,
  content,
  createdAt: T0,
});
const text = (t: string) => ({ type: 'text', text: t });
const toolUse = (id: string) => ({ type: 'tool_use', id, name: 'get_expense_report', input: {} });
const toolResult = (id: string) => ({ type: 'tool_result', tool_use_id: id, content: '{}' });

describe('toApiMessages', () => {
  it('merges consecutive same-role rows instead of dropping either', () => {
    // A turn that stopped on tool results, then the person typed again: two user rows in a
    // row, which the API rejects. Merging keeps both; anything else changes what the model
    // is told happened.
    const messages = toApiMessages([
      row('a', 'assistant', [toolUse('t1')]),
      row('b', 'user', [toolResult('t1')]),
      row('c', 'user', [text('actually, never mind')]),
    ]);
    expect(messages.map((m) => m.role)).toEqual(['assistant', 'user']);
    expect(messages[1].content).toHaveLength(2);
  });

  it('answers a tool call that never got a result', () => {
    // A request that died between two writes. If the model saw nothing it could not tell
    // "this never ran" from "this ran and I forgot" — and the second reading produces a
    // confident claim that a report was submitted.
    const messages = toApiMessages([row('a', 'assistant', [toolUse('t1')])]);
    expect(messages).toHaveLength(2);
    expect(messages[1].role).toBe('user');
    const marker = readMarker((messages[1].content as unknown[])[0]);
    expect(marker).toMatchObject({ status: 'declined' });
    expect(marker?.result).toMatch(/did not complete/i);
  });

  it('fills only the calls that are missing an answer', () => {
    const messages = toApiMessages([
      row('a', 'assistant', [toolUse('t1'), toolUse('t2')]),
      row('b', 'user', [toolResult('t1')]),
    ]);
    const content = messages[1].content as unknown[];
    expect(content).toHaveLength(2);
    expect(content.filter((b) => readMarker(b))).toHaveLength(1);
  });

  it('leaves a complete transcript alone', () => {
    const stored = [
      row('a', 'user', [text('list my reports')]),
      row('b', 'assistant', [toolUse('t1')]),
      row('c', 'user', [toolResult('t1')]),
      row('d', 'assistant', [text('You have two.')]),
    ];
    expect(toApiMessages(stored)).toHaveLength(4);
  });

  it('drops rows with no content rather than sending an empty message', () => {
    const messages = toApiMessages([
      row('a', 'user', []),
      row('b', 'user', [text('hello')]),
      row('c', 'assistant', null),
    ]);
    expect(messages).toEqual([{ role: 'user', content: [text('hello')] }]);
  });

  it('ignores rows whose role is neither user nor assistant', () => {
    const messages = toApiMessages([
      row('a', 'system', [text('nope')]),
      row('b', 'user', [text('hi')]),
    ]);
    expect(messages).toHaveLength(1);
  });
});

describe('hasLiveProposal', () => {
  const proposal = confirmationBlock({
    toolUseId: 't1',
    toolName: 'submit_expense_report',
    toolInput: { reportId: 'r-1' },
    expiresAt: new Date(T0.getTime() + 60_000),
  });

  it('is true while a proposal is waiting on a press', () => {
    expect(
      hasLiveProposal([row('a', 'assistant', [toolUse('t1')]), row('b', 'user', [proposal])]),
    ).toBe(true);
  });

  it('is false once it is settled', () => {
    const settled = settleMarker([proposal], 't1', { status: 'confirmed', at: T0 });
    expect(hasLiveProposal([row('b', 'user', settled)])).toBe(false);
  });

  it('is false in a conversation that proposed nothing', () => {
    expect(hasLiveProposal([row('a', 'assistant', [text('Here are your reports.')])])).toBe(false);
  });
});
