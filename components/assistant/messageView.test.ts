import { confirmationBlock, settleMarker } from '@expenseos/assistant';
import { describe, expect, it } from 'vitest';
import { isVisible, viewsOf } from './messageView';

const proposal = confirmationBlock({
  toolUseId: 'tu-1',
  toolName: 'submit_expense_report',
  toolInput: { reportId: 'r-1' },
  expiresAt: new Date('2026-08-19T12:15:00Z'),
});

describe('viewsOf', () => {
  it('shows the answer text', () => {
    expect(viewsOf([{ type: 'text', text: 'You have two open reports.' }])).toEqual([
      { kind: 'text', key: 't0', text: 'You have two open reports.' },
    ]);
  });

  it('never renders a tool result', () => {
    // Raw record data. Showing it would put fields on screen that the answer deliberately
    // summarised, and it reads as noise next to a written reply.
    expect(viewsOf([{ type: 'tool_result', tool_use_id: 't1', content: '{"total":100}' }])).toEqual(
      [],
    );
  });

  it('never renders thinking', () => {
    expect(viewsOf([{ type: 'thinking', thinking: 'let me check the jurisdiction' }])).toEqual([]);
  });

  it('drops anything it does not recognise rather than showing it raw', () => {
    // An allowlist, so a block type added to the API later cannot leak into the panel as
    // JSON somebody has to read.
    expect(viewsOf([{ type: 'something_new', payload: { a: 1 } }])).toEqual([]);
  });

  it('ignores empty text', () => {
    expect(viewsOf([{ type: 'text', text: '   ' }])).toEqual([]);
  });

  it('surfaces a proposal waiting on a press', () => {
    expect(viewsOf([proposal])).toEqual([
      {
        kind: 'proposal',
        key: 'p0',
        toolUseId: 'tu-1',
        toolName: 'submit_expense_report',
        status: 'confirmation_required',
        failed: false,
      },
    ]);
  });

  it('shows a declined proposal as declined', () => {
    const settled = settleMarker([proposal], 'tu-1', {
      status: 'declined',
      at: new Date('2026-08-19T12:05:00Z'),
    });
    expect(viewsOf(settled)[0]).toMatchObject({ status: 'declined', failed: false });
  });

  it('does not tick a confirmed proposal whose action was refused', () => {
    // The gate opened and the procedure still said no. A tick here would tell somebody an
    // action happened that did not.
    const settled = settleMarker([proposal], 'tu-1', {
      status: 'confirmed',
      result: 'FORBIDDEN: You cannot submit that report.',
      at: new Date('2026-08-19T12:05:00Z'),
    });
    expect(viewsOf(settled)[0]).toMatchObject({ status: 'confirmed', failed: true });
  });

  it('ticks a confirmed proposal that actually did something', () => {
    const settled = settleMarker([proposal], 'tu-1', {
      status: 'confirmed',
      result: { id: 'r-1', status: 'SUBMITTED' },
      at: new Date('2026-08-19T12:05:00Z'),
    });
    expect(viewsOf(settled)[0]).toMatchObject({ status: 'confirmed', failed: false });
  });
});

describe('isVisible', () => {
  it('hides a message that is only tool traffic', () => {
    // A turn that just ran a read produces a user-role message containing nothing but a
    // tool result. Rendering it would put an empty bubble in the thread.
    expect(isVisible([{ type: 'tool_result', tool_use_id: 't1', content: '{}' }])).toBe(false);
    expect(isVisible([{ type: 'text', text: 'hello' }])).toBe(true);
  });
});
