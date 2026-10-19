import { describe, expect, it } from 'vitest';
import { collectGuidance } from './guidance';

/**
 * Recovering what the model was actually shown.
 *
 * The grounding check is only fair if it judges the answer against the guidance the turn
 * received. These tests pin the two ways that could go wrong: crediting guidance that was never
 * returned, and mistaking somebody's record data for authored guidance.
 */

const call = (id: string, name: string) => ({ type: 'tool_use', id, name, input: {} });
const result = (id: string, content: unknown) => ({
  type: 'tool_result',
  tool_use_id: id,
  content,
});

describe('collectGuidance', () => {
  it('returns the result of a help search', () => {
    const guidance = collectGuidance([
      { content: [call('t1', 'search_help_articles')] },
      { content: [result('t1', 'Only the submitter can recall a report.')] },
    ]);
    expect(guidance).toBe('Only the submitter can recall a report.');
  });

  it('ignores the results of every other tool', () => {
    // An answer grounded in somebody's actual expense data is not making an unsupported claim
    // about the product, so a report read must not count as guidance — nor be judged as if the
    // guidance had failed to mention it.
    const guidance = collectGuidance([
      { content: [call('t1', 'get_expense_report')] },
      { content: [result('t1', '{"totalMinor":123456}')] },
    ]);
    expect(guidance).toBe('');
  });

  it('correlates by tool_use id, not by position', () => {
    // Tool calls run in parallel and results come back in one message in any order. Pairing by
    // position would credit the search with a card list.
    const guidance = collectGuidance([
      { content: [call('t1', 'list_virtual_cards'), call('t2', 'search_help_articles')] },
      { content: [result('t2', 'Authored guidance.'), result('t1', 'card rows')] },
    ]);
    expect(guidance).toBe('Authored guidance.');
  });

  it('joins several searches in the order they happened', () => {
    const guidance = collectGuidance([
      { content: [call('t1', 'search_help_articles')] },
      { content: [result('t1', 'First.')] },
      { content: [call('t2', 'search_help_articles')] },
      { content: [result('t2', 'Second.')] },
    ]);
    expect(guidance).toBe('First.\n\nSecond.');
  });

  it('reads a result delivered as content blocks', () => {
    const guidance = collectGuidance([
      { content: [call('t1', 'search_help_articles')] },
      { content: [result('t1', [{ type: 'text', text: 'Block form.' }])] },
    ]);
    expect(guidance).toBe('Block form.');
  });

  it('is empty when the turn never searched', () => {
    // The caller must read this as "nothing to be grounded in", not as a failure: plenty of
    // legitimate answers come from the capability catalog or a tool instead.
    expect(collectGuidance([{ content: [{ type: 'text', text: 'An answer.' }] }])).toBe('');
    expect(collectGuidance([])).toBe('');
  });

  it('ignores a result with no matching call', () => {
    // A repaired transcript can carry an orphaned result; crediting it would attribute guidance
    // to a search that never ran.
    expect(collectGuidance([{ content: [result('gone', 'orphan')] }])).toBe('');
  });

  it('survives content that is not a block array', () => {
    expect(collectGuidance([{ content: 'plain string' }, { content: null }])).toBe('');
  });
});

describe('reading a tool result whatever shape it arrived in', () => {
  /**
   * The SDK delivers a tool result's content as a bare string or as an array of blocks,
   * and a caller can construct either. Guidance that silently read as empty would make an
   * answer look ungrounded to the review pass — flagged for a human, when the search had
   * in fact returned an article.
   */
  const turn = (content: unknown) => [
    { content: [{ type: 'tool_use', id: 'c1', name: 'search_help_articles' }] },
    { content: [{ type: 'tool_result', tool_use_id: 'c1', content }] },
  ];

  it('reads plain string parts out of a block array', () => {
    expect(collectGuidance(turn(['first', 'second']))).toBe('first\nsecond');
  });

  it('reads the text field of a text block', () => {
    expect(collectGuidance(turn([{ type: 'text', text: 'from a block' }]))).toBe('from a block');
  });

  it('skips a block with no text rather than writing "undefined"', () => {
    /** An image block, or a shape nobody anticipated. It contributes nothing, and it must
     *  not contribute the string "undefined" to the grounding the judge reads. */
    const out = collectGuidance(turn([{ type: 'image' }, { type: 'text', text: 'kept' }]));
    expect(out).not.toContain('undefined');
    expect(out).toContain('kept');
  });

  it('treats a null part as no text', () => {
    expect(collectGuidance(turn([null, { type: 'text', text: 'kept' }]))).toContain('kept');
  });

  it('drops a result that is only whitespace', () => {
    /** An empty search result is "nothing to be grounded in", which is a different claim
     *  from "grounded in a blank string" — the latter reads as guidance that said nothing. */
    expect(collectGuidance(turn(['   ', '']))).toBe('');
  });

  it('reads a result whose content is neither a string nor an array as empty', () => {
    expect(collectGuidance(turn({ unexpected: true }))).toBe('');
  });
});
