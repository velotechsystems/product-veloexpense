import { describe, expect, it } from 'vitest';
import { approverNote } from './approverNote';

/** ExpenseOS 67db2e33 (#578): only a return or a rejection quotes the approver. */
describe('approverNote', () => {
  it('reads the note on a return and on a rejection, trimmed', () => {
    expect(approverNote({ type: 'RETURNED', payload: { note: '  Add the hotel folio. ' } })).toBe(
      'Add the hotel folio.',
    );
    expect(approverNote({ type: 'REJECTED', payload: { note: 'Personal expense.' } })).toBe(
      'Personal expense.',
    );
  });

  it('reads nothing from an empty or missing note', () => {
    expect(approverNote({ type: 'RETURNED', payload: { note: '' } })).toBeNull();
    expect(approverNote({ type: 'RETURNED', payload: { note: '   ' } })).toBeNull();
    expect(approverNote({ type: 'RETURNED', payload: {} })).toBeNull();
    expect(approverNote({ type: 'RETURNED', payload: null })).toBeNull();
    expect(approverNote({ type: 'REJECTED', payload: { note: 42 } })).toBeNull();
  });

  it('never quotes a `note` on any other event', () => {
    expect(approverNote({ type: 'APPROVED', payload: { note: 'Looks good' } })).toBeNull();
    expect(approverNote({ type: 'REASSIGNED', payload: { note: 'On leave' } })).toBeNull();
    expect(approverNote({ type: 'COMMENT', payload: { note: 'x' } })).toBeNull();
  });
});
