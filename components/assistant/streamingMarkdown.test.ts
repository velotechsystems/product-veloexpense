import { describe, expect, it } from 'vitest';
import { completePartialMarkdown } from './streamingMarkdown';

/**
 * Closing markdown that is still arriving.
 *
 * The property that matters is not "the output is pretty" — it is that **every prefix of a
 * finished answer renders as the formatted version of that prefix**. Without it the answer
 * types out as raw source (`**Total` with the asterisks showing) and snaps into formatting
 * on the last token, which reads as the reply flickering.
 *
 * The opposite failure is the one to be careful about: inventing formatting the author
 * never wrote. A moment of literal asterisks is ugly; a finished answer that is wrong is a
 * bug. So the last group asserts that COMPLETE markdown is returned untouched, and it is
 * driven by streaming a real answer one character at a time.
 */

const complete = completePartialMarkdown;

describe('emphasis that has not closed yet', () => {
  it('closes an open bold run', () => {
    expect(complete('The total is **1,240')).toBe('The total is **1,240**');
  });

  it('closes an open italic run', () => {
    expect(complete('this is *pending')).toBe('this is *pending*');
  });

  it('closes an open strikethrough', () => {
    expect(complete('~~withdrawn')).toBe('~~withdrawn~~');
  });

  it('closes underscore bold', () => {
    expect(complete('__important')).toBe('__important__');
  });

  it('settles bold before italic, so one bold run is not read as two italics', () => {
    /** The ordering bug this guards: counting `*` first sees two unmatched asterisks in
     *  `**x`, appends one, and produces `**x*` — bold that never closes. */
    expect(complete('**bold')).toBe('**bold**');
  });

  it('leaves a closed bold run alone', () => {
    expect(complete('**done** and more')).toBe('**done** and more');
  });

  it('leaves a closed italic run alone', () => {
    expect(complete('*done* and more')).toBe('*done* and more');
  });

  it('closes the second run when the first is already closed', () => {
    expect(complete('**one** and **two')).toBe('**one** and **two**');
  });
});

describe('things that only look like emphasis', () => {
  it('leaves snake_case alone', () => {
    /** `expense_report_id` has three underscores and no emphasis in it. Closing one
     *  would italicise the rest of the answer as it streamed. */
    expect(complete('the column is expense_report_id')).toBe('the column is expense_report_id');
  });

  it('leaves a bullet list alone', () => {
    /** A list marker is a `*` at the start of a line and never emphasis. */
    const md = '* first\n* second\n* third';
    expect(complete(md)).toBe(md);
  });

  it('does not close an asterisk inside inline code', () => {
    expect(complete('use `a * b` to multiply')).toBe('use `a * b` to multiply');
  });

  it('does not close an underscore inside inline code', () => {
    expect(complete('the field `user_id` is required')).toBe('the field `user_id` is required');
  });
});

describe('code that has not closed yet', () => {
  it('closes an open inline span', () => {
    expect(complete('run `npm test')).toBe('run `npm test`');
  });

  it('closes an open fenced block', () => {
    expect(complete('```sql\nSELECT 1')).toBe('```sql\nSELECT 1\n```');
  });

  it('does not add a second newline when the text already ends in one', () => {
    expect(complete('```sql\nSELECT 1\n')).toBe('```sql\nSELECT 1\n```');
  });

  it('leaves a closed fence alone', () => {
    const md = '```sql\nSELECT 1\n```';
    expect(complete(md)).toBe(md);
  });

  it('closes a tilde fence with tildes', () => {
    expect(complete('~~~\nplain')).toBe('~~~\nplain\n~~~');
  });

  it('touches nothing else while a fence is open', () => {
    /** Inside a fence there is no markup, so a stray `**` in a code sample must not be
     *  closed — it is not emphasis, it is the code. */
    expect(complete('```js\nconst x = a ** b')).toBe('```js\nconst x = a ** b\n```');
  });
});

describe('links, which must never be shown half-built', () => {
  it('hides a destination that is still being typed', () => {
    /** Briefly showing a link to `/expenses/rep-` is worse than showing nothing for one
     *  frame: it is a link to nowhere, and it invites a click. */
    expect(complete('See [the report](/expenses/rep-')).toBe('See');
  });

  it('hides a label that is still being typed', () => {
    expect(complete('See [the rep')).toBe('See');
  });

  it('keeps a finished link', () => {
    const md = 'See [the report](/expenses/rep-1) for detail.';
    expect(complete(md)).toBe(md);
  });

  it('keeps a finished link at the very end', () => {
    const md = 'See [the report](/expenses/rep-1)';
    expect(complete(md)).toBe(md);
  });

  it('leaves bare brackets alone', () => {
    /** `[draft]` is literal text in markdown, and it is complete as it stands. */
    expect(complete('the status is [draft] today')).toBe('the status is [draft] today');
  });

  it('hides an image that is still being typed', () => {
    expect(complete('Here: ![receipt](https://')).toBe('Here:');
  });
});

describe('nothing to do', () => {
  it('returns an empty string unchanged', () => {
    expect(complete('')).toBe('');
  });

  it('returns plain prose unchanged', () => {
    expect(complete('You have three open reports.')).toBe('You have three open reports.');
  });

  it('returns an empty result when the only content was a dangling link', () => {
    expect(complete('[')).toBe('');
  });
});

describe('every prefix of a real answer renders', () => {
  /**
   * The actual contract, driven the way the panel drives it: one character at a time.
   *
   * Two properties per frame — the output is never shorter in CONTENT than the input
   * minus a dangling link, and the finished string is returned byte-identical. The second
   * is what stops this from quietly rewriting answers.
   */
  const ANSWER = [
    'You have **3 open reports**, totalling `$4,120`.',
    '',
    '* `rep-1` — *pending approval*',
    '* `rep-2` — submitted',
    '',
    'See [the list](/expenses) for detail.',
  ].join('\n');

  it('leaves the finished answer exactly as written', () => {
    expect(complete(ANSWER)).toBe(ANSWER);
  });

  it('never leaves an odd emphasis marker in any prefix', () => {
    for (let i = 1; i <= ANSWER.length; i += 1) {
      const out = complete(ANSWER.slice(0, i));
      const bare = out
        .replace(/```[\s\S]*?```/g, '')
        .replace(/`[^`\n]*`/g, '')
        .replace(/^[ \t]*\*[ \t]/gm, '  '); // list markers are not emphasis
      expect((bare.match(/\*\*/g) ?? []).length % 2, `at ${i}: ${JSON.stringify(out)}`).toBe(0);
    }
  });

  it('never leaves an unclosed backtick in any prefix', () => {
    for (let i = 1; i <= ANSWER.length; i += 1) {
      const out = complete(ANSWER.slice(0, i));
      expect((out.match(/`/g) ?? []).length % 2, `at ${i}: ${JSON.stringify(out)}`).toBe(0);
    }
  });

  it('never exposes a half-built link in any prefix', () => {
    for (let i = 1; i <= ANSWER.length; i += 1) {
      const out = complete(ANSWER.slice(0, i));
      // Either no `[` at all, or every `[` is part of a finished `[..](..)`.
      const stripped = out.replace(/!?\[[^\]]*\]\([^)]*\)/g, '');
      expect(stripped.includes('(/'), `at ${i}: ${JSON.stringify(out)}`).toBe(false);
    }
  });
});
