/**
 * The few layout pieces every VeloExpense screen repeats, on the 2026 kit.
 * Server-safe. The kit supplies the parts (`PageHeader`, `Card`, `Table`,
 * `Badge`); this file only fixes how VeloExpense arranges them, so forty
 * screens stop restating the same class strings and drifting apart.
 *
 * 2026 guide, "Shape and space": cards and table frames are flat, 1px border,
 * radius-lg (8px), separated by background steps rather than shadows. Headings:
 * the page title is heading-1 (`PageHeader`); a section or card title is
 * heading-3 (18/28, 600) — heading-2's 24px competes with the page title on a
 * working screen; a short section LABEL is the guide's eyebrow (`velo-eyebrow`).
 */
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { cn } from '@/lib/utils';

export { PageHeader } from '@/components/page-header';

const WIDTH = {
  /** A single form or a short settings page. */
  narrow: 'max-w-3xl',
  /** A page of cards or a modest table. */
  default: 'max-w-5xl',
  /** A wide table: lists, queues, reports. */
  wide: 'max-w-6xl',
} as const;

/** The page body inside the app shell's `<main>`. Not a landmark itself. */
export function Screen({
  width = 'default',
  className,
  ...props
}: React.ComponentProps<'div'> & { width?: keyof typeof WIDTH }) {
  return (
    <div
      data-slot="screen"
      className={cn('mx-auto flex w-full flex-col gap-6 p-6 lg:p-8', WIDTH[width], className)}
      {...props}
    />
  );
}

/** A titled block on a screen: an 18px title, an optional line under it, actions on the right. */
export function Section({
  title,
  description,
  actions,
  className,
  children,
  ...props
}: Omit<React.ComponentProps<'section'>, 'title'> & {
  title?: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <section className={cn('flex flex-col gap-4', className)} {...props}>
      {title || description || actions ? (
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-1">
            {title ? <h2 className="text-lg leading-7 font-semibold">{title}</h2> : null}
            {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
          </div>
          {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
        </div>
      ) : null}
      {children}
    </section>
  );
}

/** The guide's flat surface: 1px border, radius-lg, `--card`. For a block that is not a kit `Card`. */
export const SURFACE = 'rounded-lg border border-border bg-card text-card-foreground';

/**
 * The frame around a kit `Table`: the flat surface, roomier first/last columns
 * and rows than the kit's compact default, and cells that wrap (the kit's cells
 * are `nowrap`, which is right for a dense grid and wrong for a description or
 * a reason column).
 */
export function TableCard({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="table-card" className={cn(SURFACE, 'overflow-hidden', ROOMY_CELLS, className)} {...props} />;
}

/** `TableCard`'s cell rules alone, for a table that sits inside a surface of its own. */
export const ROOMY_CELLS =
  '[&_td]:py-3 [&_td]:whitespace-normal [&_td:first-child]:pl-4 [&_td:last-child]:pr-4 [&_th:first-child]:pl-4 [&_th:last-child]:pr-4';

/** "← Somewhere": the way back up from a detail or form screen, above its header. */
export function BackLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="inline-flex w-fit items-center gap-1.5 text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
    >
      <ArrowLeft aria-hidden className="size-4" strokeWidth={1.75} />
      {children}
    </Link>
  );
}
