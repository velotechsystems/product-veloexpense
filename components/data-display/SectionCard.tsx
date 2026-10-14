import type * as React from 'react';
import { cn } from '@/lib/utils';
// Kit: the kit's own Card, as for StatCard — ExpenseOS's Card carries no `gap-6`, so the shell
// sets `gap-0` below to keep ExpenseOS's look (header straight onto the body).
import { Card, CardContent } from '@/components/ui/card';

/**
 * `SectionCard` — the card shell every summary card on `/dashboard` is drawn in: a
 * bordered card, a header (title, optional description, optional caller-computed
 * right-hand nodes), a body, and an optional footer.
 *
 * IT WAS EXTRACTED, NOT DESIGNED. The header and the empty state below are `my-info`'s
 * `SectionHeader` and `EmptyState` moved here verbatim — same elements, same classes,
 * same order — and `my-info` was rewired to them in the same change. Both were already
 * plain sync function components with no hooks, no next-intl and no `Link`, which is the
 * only reason the move was cheap: nothing had to be rewritten to become dual-callable.
 *
 * THE SECOND CALLER IS GONE, AND THE EXTRACTION ARGUMENT IS WEAKER FOR IT. This shell was
 * lifted out so that two surfaces could not draw different chrome for one idea. `/my-info`
 * was that second surface; it has been deleted, its record moved to `/profile`, and its
 * activity sections were retired rather than rebuilt. **`/dashboard` is now the only
 * consumer of this component.** That is a real cost, stated rather than papered over: a
 * change to a shell with one caller is a cross-package change buying no de-duplication,
 * and it sits one indirection further from the page it draws.
 *
 * It stays here anyway, and moving it back into `apps/web` was considered and rejected as
 * churn — the move would touch every call site and this package's barrel to buy nothing
 * today, and the two rules below (no `count` prop; the shell owns loading and error) are
 * worth keeping wherever the file lives. `ADR-0002` § Consequences records the same
 * reasoning and says explicitly that if no second consumer has appeared by the time
 * somebody next opens this file, relocating it is a reasonable call. What was NOT
 * acceptable was leaving this docstring asserting a caller that no longer exists.
 * Contrast `identity-banner.tsx`, which genuinely does have two callers
 * (`/dashboard` and `/profile`) and is therefore not in question.
 *
 * WHY THE DESIGN SYSTEM AND NOT `apps/web`. This package has no `next` dependency at all —
 * not a dep, not a peer — so a footer that navigates genuinely cannot live here. That is
 * why `footer` is a `ReactNode` and not an `href`: with that one inversion the shell has
 * no framework surface left, and the design system is a defensible home for it.
 *
 * NO `count` / `rows.length` PROP, EVER. Badges and totals are computed by the caller and
 * arrive as nodes in `headerRight`. The rule was written against a real defect: `/my-info`
 * derived its counts from a capped page of rows, under-reporting for anybody with more
 * reports than the cap, while the dashboard derived its from an aggregate query. That page
 * is gone, and the rule outlives it — the next surface to reuse this shell will have its
 * own row cap, and counting inside the shell is how that cap gets hidden there too.
 * Keeping the arithmetic outside is what prevents it by construction. (On the dashboard
 * today only ONE card prints a header figure at all; `ADR-0002` D5 and D8 say which and
 * why.)
 *
 * WHICH FACES THE SHELL OWNS. Loading and error, both of them — because the list renderer
 * these cards wrap does not own them adequately:
 *
 *   - LOADING. `DataTable`'s `loading` prop is a one-line "Loading…" in a single table
 *     cell, with no `aria-busy` and no live region. The shell renders a row skeleton
 *     INSTEAD of `children` while `loading` is true. Callers must NOT also pass `loading`
 *     to `DataTable`: two competing loading treatments is worse than one. And a skeleton,
 *     never a zero. The rule was best stated on the page this shell came from, and it is
 *     quoted here because that page is deleted and this is now where it lives: "A panel
 *     that states a number is making a claim; hardcoding that claim to zero is worse than
 *     omitting the panel." (`profile/EmploymentFields.tsx` carries the same rule in its
 *     own voice for the field grid.)
 *
 *   - ERROR. `DataTable` has no error prop at all. The shell replaces `children` entirely
 *     with a sentence and whatever recovery action the caller passes. Do NOT fake this
 *     through `renderEmpty`: an error rendered as an empty state tells the reader "you
 *     have nothing", which is a lie.
 *
 * Error wins over loading: a failure the reader has to know about outranks progress.
 */
export interface SectionCardError {
  /** One sentence, already translated, saying this section could not be loaded. */
  message: string;
  /** The recovery affordance — typically a "Try again" button. A node rather than a
   *  handler for the same reason `footer` is a node: no framework surface in here. */
  action?: React.ReactNode;
}

export interface SectionCardProps {
  /** Section heading, already translated. */
  title: string;
  /** Optional sub-line under the heading. */
  description?: string;
  /**
   * The right-hand end of the header — badges, counts, money. NODES the caller built.
   * See the header note: this shell never counts anything itself.
   */
  headerRight?: React.ReactNode;
  /**
   * Rendered below the body. OPTIONAL, and the caller is responsible for omitting it when
   * the section has nothing in it.
   *
   * THIS IS THE TRAP THE PROP EXISTS TO AVOID. On `/my-info` the "view all" link lived
   * inside the row list, so it rendered only when there were rows. Hoisting such a link into
   * this footer unconditionally puts "View all" underneath "You have no reports" — a link
   * to a listing the reader was just told is empty. Pass it from the non-empty branch only.
   */
  footer?: React.ReactNode;
  /** Heading level for `title`. `3` (the `/my-info` sections' level) by default; the
   *  dashboard cards are top-level sections of their page and pass `2`. The `3` default is
   *  vestigial now that the level-3 caller is gone; it is kept so a future sub-section
   *  caller needs no change here, and because changing a default is a silent break. */
  headingLevel?: 2 | 3;
  /** While true, the shell draws its own skeleton instead of `children`. */
  loading?: boolean;
  /** Announced by the skeleton's live region. Required in practice whenever `loading`
   *  is used — this package cannot translate anything itself. */
  loadingLabel?: string;
  /** How many skeleton rows to draw. Three by default: enough to read as a list. */
  skeletonRows?: number;
  /** Set (non-null) → the shell replaces `children` with the error face. */
  error?: SectionCardError | null;
  children?: React.ReactNode;
  className?: string;
}

export function SectionCard({
  title,
  description,
  headerRight,
  footer,
  headingLevel = 3,
  loading = false,
  loadingLabel,
  skeletonRows = 3,
  error,
  children,
  className,
}: SectionCardProps) {
  const Heading = headingLevel === 2 ? 'h2' : 'h3';
  return (
    <Card className={cn('gap-0 overflow-hidden p-0', className)}>
      <div className="flex items-start justify-between gap-4 border-border border-b px-5 py-4">
        <div>
          <Heading className="m-0 font-semibold text-base text-foreground">{title}</Heading>
          {description && <p className="m-0 mt-1 text-muted-foreground text-xs">{description}</p>}
        </div>
        {headerRight}
      </div>
      {error ? (
        <SectionError {...error} />
      ) : loading ? (
        <SectionSkeleton rows={skeletonRows} label={loadingLabel} />
      ) : (
        children
      )}
      {!error && !loading && footer}
    </Card>
  );
}

/**
 * The centred "there is nothing here" face — `my-info`'s `EmptyState`, moved (and now
 * outliving that page).
 *
 * It states a fact about the data. It is NOT the place to report a failure to load: see
 * the error note on `SectionCard`.
 */
export interface SectionEmptyProps {
  icon?: React.ReactNode;
  /** The fact, already translated. */
  message: string;
  /** An optional second line — what to do about it, or why it is empty. */
  hint?: string;
}

export function SectionEmpty({ icon, message, hint }: SectionEmptyProps) {
  return (
    <CardContent className="flex flex-col items-center gap-2 py-10 text-center">
      {icon}
      <div className="font-medium text-muted-foreground text-sm">{message}</div>
      {hint && <div className="text-muted-foreground/70 text-xs">{hint}</div>}
    </CardContent>
  );
}

/** Stable keys for the placeholder bars, so the list needs no array index as a key.
 *  Six is the ceiling on `skeletonRows`; no summary card previews more than five. */
const SKELETON_KEYS = ['a', 'b', 'c', 'd', 'e', 'f'];

/**
 * The pending face. Bars the shape of rows, not a spinner and emphatically not a zero.
 *
 * `role="status"` + `aria-busy` because the visual treatment carries the whole message and
 * a screen reader gets nothing from grey rectangles. Polite, not assertive: a section that
 * has not arrived yet is not an emergency.
 */
function SectionSkeleton({ rows, label }: { rows: number; label?: string }) {
  return (
    <div role="status" aria-busy="true" className="flex flex-col gap-3 px-5 py-4">
      {label && <span className="sr-only">{label}</span>}
      {SKELETON_KEYS.slice(0, Math.min(Math.max(1, rows), SKELETON_KEYS.length)).map((key) => (
        <div key={key} className="h-8 animate-pulse rounded bg-muted" aria-hidden />
      ))}
    </div>
  );
}

/**
 * The failure face. One sentence and the caller's recovery action — never `error.message`
 * from the throw site, which has not been sanitized and may carry anything.
 */
function SectionError({ message, action }: SectionCardError) {
  return (
    <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
      <div role="status" className="font-medium text-muted-foreground text-sm">
        {message}
      </div>
      {action}
    </CardContent>
  );
}
