'use client';

import Markdown from 'markdown-to-jsx';
import type * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * MarkdownText — the canonical markdown renderer for ExpenseOS.
 *
 * Accepts a markdown string and renders it with a hardened, design-system
 * style set: links open in a new tab, inline code gets a subtle background
 * pill, lists/blockquotes/headings inherit the surrounding text size and
 * pick up consistent rhythm.
 *
 * Used by `DescriptionText` for muted helper text, and anywhere else we
 * need to render lightly-formatted authored copy (changelog notes, schema
 * descriptions, etc.).
 *
 * Pass `inline` to opt into a single-line / inline render that suppresses
 * block elements — appropriate for short descriptions / labels.
 *
 * Custom element styling can be extended per-call via the `overrides`
 * prop (merged onto the defaults). Useful when a particular surface
 * needs a different link color or a non-default heading scale.
 */
export interface MarkdownTextProps extends React.HTMLAttributes<HTMLDivElement> {
  /** The markdown source. Empty / nullish renders nothing. */
  children?: string | null;
  /** Inline-only render: paragraphs / lists / headings are flattened to spans. */
  inline?: boolean;
  /** Extra component overrides merged on top of the defaults. */
  overrides?: Record<string, unknown>;
}

const BLOCK_OVERRIDES = {
  a: {
    props: {
      className: 'underline underline-offset-2 hover:text-foreground',
      target: '_blank',
      rel: 'noreferrer',
    },
  },
  code: {
    props: {
      className: 'rounded bg-muted px-1 py-0.5 font-mono text-[0.95em]',
    },
  },
  strong: { props: { className: 'font-medium text-foreground' } },
  em: { props: { className: 'italic' } },
  // Lists inherit the parent text color/size; tight vertical rhythm
  // matches the rest of the description anatomy.
  ul: { props: { className: 'list-disc space-y-0.5 pl-5' } },
  ol: { props: { className: 'list-decimal space-y-0.5 pl-5' } },
  li: { props: { className: 'leading-relaxed' } },
  // Paragraphs render as flow content — markdown that contains multiple
  // paragraphs gets vertical spacing between them. The `:not(:last-child)`
  // selector keeps the final paragraph flush with the surrounding container.
  p: { props: { className: 'leading-relaxed [&:not(:last-child)]:mb-2' } },
  // Headings stay small — markdown inside a description shouldn't grow
  // visual weight on its own; sizing is governed by the wrapping
  // typography component (e.g. DescriptionText).
  h1: { props: { className: 'font-semibold text-foreground text-base' } },
  h2: { props: { className: 'font-semibold text-foreground text-sm' } },
  h3: { props: { className: 'font-semibold text-foreground text-sm' } },
  h4: { props: { className: 'font-medium text-foreground text-sm' } },
  blockquote: {
    props: { className: 'border-border border-l-2 pl-3 text-muted-foreground italic' },
  },
  hr: { props: { className: 'my-3 border-border' } },
  /**
   * Tables — the elements `markdown-to-jsx` has always produced and nothing ever styled.
   *
   * The parser handles GFM tables correctly: a three-column table arrives as a real
   * `<table>` with three `<th>` and its `<td>`s in place. But no override named any of
   * those tags, so every cell rendered with an empty class against the design system's
   * CSS reset — no borders, no padding, no cell separation. A table of cards and limits
   * came out as a wall of run-together words, which reads as the model formatting its
   * answer badly when the markdown it emitted was perfectly good.
   *
   * `table` is a component rather than props because the scroller has to be a WRAPPER: a
   * table wider than its container (six columns in a 520px drawer) otherwise pushes the
   * whole surface sideways. Overflow belongs on an element the table can overflow, not on
   * the table itself.
   */
  table: {
    component: ({ children, ...rest }: { children?: React.ReactNode }) => (
      <div className="my-2 max-w-full overflow-x-auto">
        <table className="w-full border-collapse text-sm" {...rest}>
          {children}
        </table>
      </div>
    ),
  },
  thead: { props: { className: 'border-border border-b' } },
  th: {
    props: {
      className: 'whitespace-nowrap px-2.5 py-1.5 text-left font-medium text-foreground',
    },
  },
  // `tabular-nums` because the columns people put in these are amounts and dates, and
  // proportional digits make a column of figures impossible to compare down.
  td: {
    props: { className: 'border-border/60 border-t px-2.5 py-1.5 align-top tabular-nums' },
  },
  /**
   * Fenced code blocks. `code` above styles INLINE code as a pill, and that override
   * applies just as happily to the `<code>` inside a `<pre>` — which put a padded,
   * background-filled pill around every line of a code block. Neutralised here rather
   * than by weakening the inline style, which is right where it is.
   */
  pre: {
    props: {
      className:
        'my-2 max-w-full overflow-x-auto rounded-md bg-muted p-2.5 text-[0.95em] [&>code]:bg-transparent [&>code]:p-0',
    },
  },
} as const;

export function MarkdownText({
  className,
  children,
  inline,
  overrides,
  ...props
}: MarkdownTextProps) {
  if (children == null || children === '') return null;
  const mergedOverrides = overrides
    ? { ...BLOCK_OVERRIDES, ...(overrides as Record<string, never>) }
    : BLOCK_OVERRIDES;
  return (
    <div className={cn('space-y-2', className)} {...props}>
      <Markdown options={{ overrides: mergedOverrides, forceInline: inline }}>{children}</Markdown>
    </div>
  );
}
