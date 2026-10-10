import { describe, expect, it } from 'vitest';
import {
  localeLabel,
  nextSelectedExpenseId,
  SEVERITY_KEY,
  shouldPromptUpload,
  statusBadgeProps,
} from './_shared';

describe('localeLabel', () => {
  it('prefers the active locale, falling back to en then any value', () => {
    const label = { en: 'Software', 'fr-CA': 'Logiciel' };
    expect(localeLabel(label, 'fr-CA')).toBe('Logiciel');
    expect(localeLabel(label, 'en')).toBe('Software');
    expect(localeLabel(label, 'de')).toBe('Software'); // → en fallback
    expect(localeLabel({ 'fr-CA': 'Seul' }, 'en')).toBe('Seul'); // → first value
  });

  it('handles plain strings and non-label values', () => {
    expect(localeLabel('Meals', 'en')).toBe('Meals');
    expect(localeLabel(null, 'en')).toBe('');
    expect(localeLabel(42, 'en')).toBe('');
    expect(localeLabel(['a'], 'en')).toBe('');
  });
});

describe('statusBadgeProps', () => {
  /**
   * The status map used to be exported and its title-case value was rendered AS THE PILL
   * TEXT, so a fr-CA screen showed "Approved" and "Reimbursed" among French tiles while the
   * filter dropdown beside them said "Approuvé" (GA readiness report F43). Colour and text are
   * now separate channels: the map drives the colour, the catalog drives the words.
   */
  const t = (key: string) => `T:${key}`;

  it('maps every Prisma status to its colour key', () => {
    expect(statusBadgeProps('DRAFT', t).status).toBe('Draft');
    expect(statusBadgeProps('SUBMITTED', t).status).toBe('Submitted');
    expect(statusBadgeProps('APPROVED', t).status).toBe('Approved');
    expect(statusBadgeProps('REJECTED', t).status).toBe('Rejected');
    expect(statusBadgeProps('RETURNED', t).status).toBe('Returned');
    expect(statusBadgeProps('REIMBURSED', t).status).toBe('Reimbursed');
  });

  it('takes the pill TEXT from the catalog, never from the enum', () => {
    // The defect in one assertion: the label must not be the title-case English literal.
    expect(statusBadgeProps('APPROVED', t).label).toBe('T:status.approved');
    expect(statusBadgeProps('REIMBURSED', t).label).toBe('T:status.reimbursed');
  });

  it('uses the same keys the filter and the export already use', () => {
    // Not a parallel key set: the pill, the filter dropdown and the CSV must not be able to
    // say three different things about one report.
    for (const s of ['DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'RETURNED', 'REIMBURSED']) {
      expect(statusBadgeProps(s, t).label).toBe(`T:status.${s.toLowerCase()}`);
    }
  });

  it('falls back to a TRANSLATED label for a status the UI does not know', () => {
    /**
     * Derived from the mapped badge rather than the raw enum, so a status the server ships
     * before the UI knows it renders the fallback's translated label — not a MISSING_MESSAGE
     * on `status.something_new`.
     */
    expect(statusBadgeProps('SOMETHING_NEW', t)).toEqual({
      status: 'Draft',
      label: 'T:status.draft',
    });
    expect(statusBadgeProps('SOMETHING_NEW', t, 'Submitted').label).toBe('T:status.submitted');
  });
});

describe('SEVERITY_KEY', () => {
  it('maps policy severities to styling buckets', () => {
    expect(SEVERITY_KEY.BLOCK).toBe('error');
    expect(SEVERITY_KEY.WARNING).toBe('warning');
    expect(SEVERITY_KEY.INFO).toBe('info');
  });
});

describe('shouldPromptUpload', () => {
  it('prompts when the handoff link arrived and the report can still take files', () => {
    expect(shouldPromptUpload({ linkArrived: true, editable: true })).toBe(true);
  });

  it('stays silent on a report that cannot accept receipts', () => {
    // The upload control is not rendered when the report is not editable, so a banner telling
    // somebody to add receipts would read as broken rather than as "recall it first". This
    // happens when the report was submitted between the tool call and the click.
    expect(shouldPromptUpload({ linkArrived: true, editable: false })).toBe(false);
  });

  it('stays silent when nobody was sent here to upload', () => {
    expect(shouldPromptUpload({ linkArrived: false, editable: true })).toBe(false);
  });
});

describe('nextSelectedExpenseId', () => {
  const ids = ['e1', 'e2', 'e3'];

  it('keeps a selection the person made', () => {
    // The effect re-runs on every refetch; without this a poll yanks the selection.
    expect(nextSelectedExpenseId({ current: 'e3', expenseIds: ids, requested: 'e2' })).toBe('e3');
  });

  it('honours ?expense= on first load', () => {
    expect(nextSelectedExpenseId({ current: null, expenseIds: ids, requested: 'e2' })).toBe('e2');
  });

  it('falls back to the first expense with no deep link', () => {
    expect(nextSelectedExpenseId({ current: null, expenseIds: ids })).toBe('e1');
  });

  it('ignores a deep link naming an expense on another report', () => {
    // Stale or hand-edited: select the default rather than blanking the centre pane.
    expect(nextSelectedExpenseId({ current: null, expenseIds: ids, requested: 'nope' })).toBe('e1');
  });

  it('drops a selection that has been deleted', () => {
    expect(nextSelectedExpenseId({ current: 'gone', expenseIds: ids })).toBe('e1');
  });

  it('selects nothing on an empty report', () => {
    expect(nextSelectedExpenseId({ current: 'e1', expenseIds: [], requested: 'e2' })).toBeNull();
  });
});
