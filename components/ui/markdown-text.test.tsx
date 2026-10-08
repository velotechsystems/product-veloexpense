import '@testing-library/jest-dom/vitest';
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MarkdownText } from './markdown-text';

/**
 * MarkdownText — the renderer every authored and model-generated string goes through.
 *
 * These exist because of a specific complaint: the assistant answered with a table of
 * virtual cards and it came out "barely readable". The markdown was never the problem.
 * `markdown-to-jsx` parses a GFM table correctly and always did — a real `<table>`, the
 * right number of `<th>` and `<td>`. What was missing was that no override named a single
 * table tag, so every cell rendered with an EMPTY class against the design system's CSS
 * reset: no borders, no padding, nothing separating one cell from the next.
 *
 * That is a failure mode worth a test of its own, because it cannot be seen from the
 * markdown side and it does not throw. The structure was right; only the presentation was
 * absent, and the symptom looked like the model formatting its answer badly.
 */

const TABLE = `| Card | Holder | Limit |
| --- | --- | --- |
| Ads | Ada Lovelace | $5,000 |
| Travel | Bo Chen | $2,500 |`;

describe('MarkdownText — tables', () => {
  it('parses a GFM table into real table structure', () => {
    // The half that was never broken, pinned so a renderer swap cannot quietly lose it.
    const { container } = render(<MarkdownText>{TABLE}</MarkdownText>);
    expect(container.querySelector('table')).toBeInTheDocument();
    expect(container.querySelectorAll('th')).toHaveLength(3);
    expect(container.querySelectorAll('td')).toHaveLength(6);
  });

  it('gives every cell real styling, not an empty class', () => {
    /**
     * The actual defect. Asserted on the cells rather than on a screenshot because the
     * only thing wrong was that these class strings were `""` — the structure around them
     * was already correct, which is why nothing failed.
     */
    const { container } = render(<MarkdownText>{TABLE}</MarkdownText>);
    const th = container.querySelector('th');
    const td = container.querySelector('td');
    expect(th?.className).toContain('px-2.5');
    expect(th?.className).toContain('font-medium');
    // A border is what separates rows; without one the table is a block of words.
    expect(td?.className).toContain('border-t');
    expect(td?.className).toContain('px-2.5');
    // Amounts and dates are what people put in these columns.
    expect(td?.className).toContain('tabular-nums');
  });

  it('lets a wide table scroll inside its own box instead of stretching the surface', () => {
    /**
     * The scroller has to be a WRAPPER around the table, not a class on it: a six-column
     * table in a 520px drawer otherwise pushes the whole panel sideways. Asserted as
     * "an ancestor of the table scrolls", which is the property that matters and does not
     * pin which element carries it.
     */
    const { container } = render(<MarkdownText>{TABLE}</MarkdownText>);
    const table = container.querySelector('table');
    expect(table).toBeInTheDocument();
    expect(table?.parentElement?.className).toContain('overflow-x-auto');
  });
});

describe('MarkdownText — code', () => {
  it('keeps the inline-code pill off a fenced block', () => {
    /**
     * `code` styles inline code as a padded, background-filled pill — right for inline,
     * and it applied just as happily to the `<code>` inside a `<pre>`, putting a pill
     * around every line of a code block. Neutralised on the `pre`, so the inline style
     * stays as it should be.
     */
    const { container } = render(<MarkdownText>{'```\nnpm run dev\n```'}</MarkdownText>);
    const pre = container.querySelector('pre');
    expect(pre).toBeInTheDocument();
    expect(pre?.className).toContain('[&>code]:bg-transparent');
    expect(pre?.className).toContain('overflow-x-auto');
  });

  it('still renders inline code as a pill', () => {
    const { container } = render(<MarkdownText>{'run `npm run dev` first'}</MarkdownText>);
    const code = container.querySelector('code');
    expect(code?.className).toContain('bg-muted');
  });
});
