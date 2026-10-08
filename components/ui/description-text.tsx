'use client';

import type * as React from 'react';
import { cn } from '@/lib/utils';
import { MarkdownText } from './markdown-text';

/**
 * DescriptionText — the canonical muted helper-text typography used
 * across forms (Field's description, Fieldset's description, RJSF's
 * DescriptionFieldTemplate, per-option radio descriptions, etc.).
 *
 * Composes `MarkdownText` for string children so descriptions can use
 * markdown (links, emphasis, inline code, short lists). Non-string
 * children pass through as-is so callers can hand in pre-rendered JSX
 * (RJSF's DescriptionFieldTemplate already wraps in a <p>, and we
 * don't want <p>-in-<p> nesting).
 *
 * Named "Description" (not "Help") because "Help" is reserved for the
 * `?` tooltip — they're different anatomy slots.
 */
export interface DescriptionTextProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, 'children'> {
  children?: React.ReactNode;
}

export function DescriptionText({ className, children, ...props }: DescriptionTextProps) {
  if (children == null || children === '') return null;
  if (typeof children === 'string') {
    return (
      <MarkdownText className={cn(DescriptionText.STYLE, className)} {...props}>
        {children}
      </MarkdownText>
    );
  }
  // Non-string content (typically RJSF's already-rendered <p>) is
  // returned as-is to avoid double-wrapping. Callers passing raw JSX
  // are responsible for matching the description typography manually
  // via the exported `STYLE` class if needed.
  return <>{children}</>;
}
DescriptionText.STYLE = 'text-muted-foreground text-xs leading-relaxed';
