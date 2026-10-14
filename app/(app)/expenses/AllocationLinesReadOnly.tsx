'use client';

import { splitExact } from '@expenseos/money';
import { useTranslations } from 'next-intl';
import { type CurrencyLike, formatMinor } from '@/lib/format';
import { localeLabel } from './_shared';

/**
 * One saved allocation row, as `AllocationLinesReadOnly` reads it — ONLY the fields it reads.
 *
 * Structural on purpose: both `expenses.report` (the workbench) and
 * `expenseApprovals.report` (the approver drawer) return a wider row, and each must be
 * assignable to this without a cast. A field added here is a field BOTH routes have to send.
 * Labels are `unknown` because they are Prisma `Json` (`{ en, fr-CA }`) and `localeLabel`
 * already accepts whatever shape arrives.
 */
export interface AllocationLineView {
  id: string;
  percentBp: number;
  /** Set by the server only when the NetSuite business unit is the line's business unit. */
  nsBusinessUnitLabel: string | null;
  businessUnit: { label: unknown } | null;
  department: { label: unknown } | null;
  class: { name: string } | null;
}

/** Amount with its currency code suffix, e.g. "$53.10 CAD" / "53,10 $ CAD".
 *  An inline copy of `_workbench/parts.tsx`'s private `money()`, so the rows read exactly
 *  as every other figure on the workbench pane does. */
function money(minor: number, currency: CurrencyLike, locale: string): string {
  return `${formatMinor(minor, currency, locale)} ${currency.code}`;
}

/**
 * The saved allocation as prose — one line per row: its share, what that share is in
 * money, and the dimensions it codes to.
 *
 * Shared by the expense workbench (`_workbench/parts.tsx`: alone on a submitted report, and
 * beside the editable row set as its below-`lg` face on a draft one) and the approver
 * drawer. One piece of markup serving several surfaces cannot drift between them.
 *
 * NO `<Field>`, NO `<input>`, NO `aria-label` — the same contract `ExpenseFieldsReadOnly`
 * and `TaxFiguresReadOnly` carry, and here it rules out `Percent` specifically: on a draft
 * report this renders at the same time as the `allocation.percent`-labelled input the
 * cloak merely hides, and Playwright's label engine has no visibility filter.
 *
 * The money column is derived, never stored: the expense's own total split by
 * `splitExact`, the same largest-remainder split the NetSuite poster allocates with, so
 * the rows always add up to the expense to the cent. Rounding each row on its own did
 * not: 0.05 split 50/50 read 0.03 + 0.03.
 *
 * VeloExpense: there is no NetSuite poster here, and the VeloLedger post does not split an
 * expense by its allocations; `splitExact` is still the split ExpenseOS posts with, and the
 * rows add up to the expense either way. `nsBusinessUnitLabel` and `class` are always null
 * (no NetSuite, no class), so a row names the admin business unit and the department.
 */
export function AllocationLinesReadOnly({
  allocations,
  amountMinor,
  currency,
  locale,
  className,
}: {
  allocations: readonly AllocationLineView[];
  /** The expense total in minor units, as the wire sends it (a bigint as a string). */
  amountMinor: string;
  currency: CurrencyLike;
  /** The READER's locale — it formats the money and picks the label translation. */
  locale: string;
  className?: string;
}) {
  const t = useTranslations('expenses');
  /**
   * An UNCODED expense says so, rather than rendering nothing.
   *
   * `return null` hid the whole block the moment a report stopped being editable — so
   * the approver, who is the last person able to catch it, could not see that BU /
   * department / class were blank. It reads as "no allocation section on this expense"
   * rather than "this expense is not coded", and blank coding is exactly what NetSuite
   * rejects downstream (GA readiness report F17, alongside F18 / F21 / F22). Below `lg`
   * on a draft it says the same thing to the submitter, who can still fix it.
   */
  if (allocations.length === 0) {
    return <p className={`text-sm text-warning ${className ?? ''}`}>{t('allocation.none')}</p>;
  }
  const shares = splitExact(
    BigInt(amountMinor),
    allocations.map((a) => BigInt(a.percentBp)),
  );
  return (
    <ul className={`flex flex-col gap-1 text-sm ${className ?? ''}`}>
      {allocations.map((a, i) => (
        /* `flex-wrap`: at 360 the dimension string is the long part, and it takes its own
           line under the two figures rather than squeezing them. */
        <li key={a.id} className="flex flex-wrap items-baseline gap-x-2">
          <span className="w-12 shrink-0 text-foreground tabular-nums">{a.percentBp / 100}%</span>
          <span className="shrink-0 text-foreground tabular-nums">
            {money(Number(shares[i]), currency, locale)}
          </span>
          <span className="min-w-0 text-muted-foreground text-xs">
            {[
              // The server names the NetSuite business unit when the switch makes it the
              // line's business unit (`nsBusinessUnitLabel`); otherwise the admin one, as ever.
              a.nsBusinessUnitLabel ??
                (a.businessUnit ? localeLabel(a.businessUnit.label, locale) : null),
              a.department ? localeLabel(a.department.label, locale) : null,
              a.class?.name ?? null,
            ]
              .filter(Boolean)
              .join(' · ') || '—'}
          </span>
        </li>
      ))}
    </ul>
  );
}
