import { IconTrendingDown, IconTrendingUp } from '@tabler/icons-react';
// VeloExpense kit: the kit's paths for ExpenseOS's relative ones; the Badge's `success` and
// `destructive` tones and the Card are the kit's own, which take the same props.
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import type { StatCardProps, StatCardVariant } from './StatCard.types';

/**
 * Variant → Tailwind text color class for the value.
 * Maps to the shadcn semantic tokens defined in globals.css.
 */
const variantValueClass: Record<StatCardVariant, string> = {
  default: 'text-foreground',
  primary: 'text-primary',
  success: 'text-success',
  warning: 'text-warning',
  danger: 'text-destructive',
};

/**
 * StatCard — KPI tile with optional trend.
 *
 * Composes shadcn `Card` + `Badge` with a label, large value, optional
 * secondary value, optional trend indicator, and optional top-right icon.
 * Interactive when `onClick` is supplied (cursor + hover shadow).
 *
 * ## The value size below `lg`
 *
 * The value is `text-3xl` (30px) from `lg` up and `text-xl` (20px) below it.
 * That split is an operator ruling, quoted here so a later reader does not
 * re-litigate it from taste: "the mobile value size is `text-xl` (20px). At the
 * `StatCard` primitive, `max-lg:` scoped, with `font-bold` retained."
 *
 * **20px is a floor, not a starting point.** If a value does not fit its card on
 * a phone, the remedy is a fresh operator call — widen the tile's content box the
 * way `PeriodAnalysis`' grid was widened, or accept a bounded clip — and never a
 * quiet drop to `text-lg` here.
 *
 * It is scoped `max-lg:` and additive deliberately: there is no `valueSize` prop
 * and no `className` passthrough. `@expenseos/design-system` is `private: true`
 * and consumed from source, so no external contract breaks and no escape hatch is
 * owed until a consumer actually asks for one. ADR-0008's Alternatives already
 * refused the prop.
 *
 * `text-3xl` staying on this element is what keeps every existing consumer
 * (`/expenses`, `/analytics`, `/admin/audit-trail`, `/admin/control-evaluation`,
 * `/admin/fraud-detection`, `/netsuite/people`) pixel-identical on a desktop.
 * `tailwind-merge` keeps both because a bare size and a `max-lg:` size are
 * different keys — verified against this repo's own `cn`, not assumed.
 *
 * ## `max-lg:whitespace-nowrap` + `max-lg:min-w-0` move the failure, they do not bound it
 *
 * `/expenses`' `openBalance` is, on two independent estimates, at or just past
 * its content box at 20px — roughly 134px of `CAD 99,999.99` against roughly
 * 124px of card. The design review's minority position was not absorbed: "the
 * bounded `openBalance` string is, on two independent estimates, at or past its
 * unchanged 124–126px content box at `text-xl`." Frontend concurred: "Plainly:
 * I don't think this comfortably fits."
 *
 * These two classes do not make it fit, AND THEY DO NOT CONTAIN THE OVERFLOW
 * EITHER. All they change is WHICH BOX spills:
 *
 *   · `max-lg:whitespace-nowrap` holds the value on one line, so an over-wide
 *     value runs off sideways instead of wrapping to a second line.
 *   · `max-lg:min-w-0` clears the card's automatic minimum size. Every consumer
 *     lays these out with Tailwind's `grid-cols-N`, which is
 *     `repeat(N, minmax(0, 1fr))` — read off `node_modules/tailwindcss/dist/lib.js`,
 *     not assumed — so the TRACK is already floored at 0 and never grows. What
 *     grows without `min-w-0` is the grid ITEM: `min-width: auto` floors the card
 *     at its own min-content width, so the card's border box, background and
 *     border paint wider than its track and over its neighbour. With `min-w-0`
 *     the card sits in its track and the TEXT is what leaves it.
 *
 * So the pair converts "the card's border box spills" into "the text spills out
 * of the card". It does not bound the spill: `Card` sets no `overflow`
 * (`../ui/card.tsx:8-11`), so the value still paints outside the card's border
 * box and still counts toward `main.scrollWidth` — which is the exact reading
 * `e2e/analytics.mobile.spec.ts` takes of this route family. `overflow-hidden`
 * on `Card` is what would actually bound it; that is filed separately, because
 * it would change every card in the product at every width.
 *
 * All three are `max-lg:`-scoped for the same reason `text-3xl` stays bare: the
 * operator's constraint is "all of these changes are for mobile only", said twice.
 * Unprefixed they reach all six consumers at every width — `tabular-nums` in
 * particular changes numeral advance widths, which is a visible desktop change to
 * routes this ticket never asked about.
 *
 * Unresolved at the time of writing: whether trading a wrap for a clip is the
 * failure `/expenses` wants — both are forbidden by the acceptance criteria, so
 * either way it is an operator call.
 */
export function StatCard({
  label,
  value,
  secondaryValue,
  icon: Icon,
  trend,
  variant = 'default',
  onClick,
  loading = false,
}: StatCardProps) {
  if (loading) {
    return (
      <Card className="p-4">
        <div className="flex flex-col gap-2">
          <div className="h-4 w-3/5 animate-pulse rounded bg-muted" />
          {/*
            Paired to the value's line-height so the skeleton does not resize the
            card on load: `text-3xl` is 36px = `h-9`, `text-xl` is 28px = `h-7`.
            Both read off tailwindcss/theme.css (`--text-xl--line-height:
            calc(1.75 / 1.25)` → 1.75rem, `--spacing: 0.25rem` → h-7 = 1.75rem).
          */}
          <div className="h-9 w-4/5 animate-pulse rounded bg-muted max-lg:h-7" />
        </div>
      </Card>
    );
  }

  return (
    <Card
      onClick={onClick}
      // `max-lg:min-w-0`: a grid child defaults to `min-width: auto`, which floors
      // the card at its own min-content width and lets an unbreakable value paint
      // the card's border box wider than its track. `max-lg:` because desktop is
      // ruled unchanged — see the note above for what this does and does not buy.
      className={cn(
        'relative p-4 max-lg:min-w-0',
        onClick && 'cursor-pointer transition-shadow hover:shadow-md',
      )}
    >
      <div className="flex flex-col gap-1">
        <div className="font-medium text-muted-foreground text-sm">{label}</div>

        <div
          className={cn(
            'font-bold text-3xl max-lg:whitespace-nowrap max-lg:text-xl max-lg:tabular-nums',
            variantValueClass[variant],
          )}
        >
          {typeof value === 'number' ? value.toLocaleString() : value}
        </div>

        {secondaryValue && (
          <div className="mt-1 text-muted-foreground text-sm">{secondaryValue}</div>
        )}

        {trend && (
          <div className="mt-2">
            <Badge variant={trend.direction === 'up' ? 'success' : 'destructive'}>
              <span className="inline-flex items-center gap-1">
                {trend.direction === 'up' ? (
                  <IconTrendingUp size={14} />
                ) : (
                  <IconTrendingDown size={14} />
                )}
                <span className="text-xs">{trend.value}</span>
              </span>
            </Badge>
          </div>
        )}

        {Icon && (
          <div className="absolute top-4 right-4 text-muted-foreground/50">
            <Icon size={24} />
          </div>
        )}
      </div>
    </Card>
  );
}
