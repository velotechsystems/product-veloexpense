'use client';

/**
 * ExpenseOS's `Tooltip` API — `<Tooltip content={…}>trigger</Tooltip>`, with `asChild` — on the
 * kit's Radix tooltip parts.
 *
 * VeloExpense: ExpenseOS's design system exports a single convenience component (Base UI
 * underneath); the kit exports shadcn's compound parts. Ported screens keep ExpenseOS's call
 * shape, so the difference is absorbed here, once, instead of in every screen. The classes are
 * ExpenseOS's own (popover surface, small text, 6px offset).
 */
import type * as React from 'react';
import { Tooltip as Root, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

export function Tooltip({
  children,
  content,
  className,
  asChild,
}: {
  children: React.ReactNode;
  content: React.ReactNode;
  className?: string;
  asChild?: boolean;
}) {
  return (
    <TooltipProvider delayDuration={0}>
      <Root>
        {asChild ? (
          <TooltipTrigger asChild>{children}</TooltipTrigger>
        ) : (
          <TooltipTrigger className="inline-flex items-center text-muted-foreground outline-none hover:text-foreground focus-visible:text-foreground">
            {children}
          </TooltipTrigger>
        )}
        <TooltipContent
          sideOffset={6}
          className={cn(
            'z-[70] max-w-xs rounded-md border border-border bg-popover px-2.5 py-1.5 text-popover-foreground text-xs leading-relaxed shadow-md',
            className,
          )}
        >
          {content}
        </TooltipContent>
      </Root>
    </TooltipProvider>
  );
}
