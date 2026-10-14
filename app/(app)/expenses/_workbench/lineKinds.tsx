'use client';

import type { ExpenseLineKind } from '@expenseos/expense-lines';
import type { ComponentType } from 'react';

/**
 * Which extra fields a line-item row shows, chosen by strategy rather than by an
 * `if (isMileage)`.
 *
 * The row used to branch on one boolean, which had two costs. Adding a fourth kind meant
 * threading another flag through the same conditional; and the branch keyed on the
 * CATEGORY's `isMileage` while the database stores a `kind` on the LINE, so the two
 * concepts drifted apart in the reader's head. `STANDARD_WITH_TIP` is what that drift
 * cost: it has existed as a kind, been written by extraction, and had **no UI at all** —
 * no input, no display, not even a catalog key. A tip lifted off a receipt changed the
 * taxable base and the claimant could neither see nor correct it.
 *
 * ## The UI does NOT decide the kind
 *
 * `resolveLineKind` on the server does, and it needs data the UI does not own:
 *
 *   isMileage                      → MILEAGE
 *   !acceptsTip OR tip <= 0        → STANDARD
 *   otherwise                      → STANDARD_WITH_TIP
 *
 * So a tip-accepting category is only `STANDARD_WITH_TIP` once a tip is actually
 * entered — which means a strategy chosen from the category alone would disagree with the
 * stored kind on every zero-tip meal. A strategy therefore declares which FIELDS to
 * offer, and `kind` is what the server would store when those fields are filled. The
 * server stays authoritative.
 *
 * `lineKinds.test.tsx` asserts this table against `resolveLineKind`'s own rules, because
 * the failure mode of drift here is silent: the row offers a field the server will
 * discard, or hides one it expects.
 */

/** The category capabilities a strategy is allowed to look at. */
export interface CategoryCapabilities {
  isMileage?: boolean;
  acceptsTip?: boolean;
}

/** The row's local draft, as the strategies need to read and reset it. */
export interface LineDraft {
  amount: string;
  km: string;
  tip: string;
}

export interface LineFieldsProps {
  draft: LineDraft;
  disabled?: boolean;
  onTipChange(value: string): void;
  onTipCommit(): void;
  currencySymbol: string;
  /** Localized labels, passed in so this module needs no i18n hook of its own. */
  labels: { tip: string; tipHint: string };
}

export interface LineKindStrategy {
  /**
   * What the server would store for a line using these fields, once filled.
   *
   * For `STANDARD_WITH_TIP` that is conditional on a tip actually being entered — see the
   * module note. It is here to be asserted against the server, not to be written.
   */
  kind: ExpenseLineKind;
  /** Evaluated in order; the first match wins. */
  appliesTo(category: CategoryCapabilities | undefined): boolean;
  /** Extra fields under the amount. Omitted when the kind needs none. */
  Fields?: ComponentType<LineFieldsProps>;
  /**
   * Draft fields that must be cleared when the row leaves this strategy.
   *
   * Declared rather than hand-coded per branch: a typed amount is not a distance and a
   * measured route is not an amount, so crossing between them has to invalidate both
   * sides. Getting this wrong leaves a stale figure that the server disagrees with.
   */
  clearsOnExit: readonly (keyof LineDraft)[];
}

/** Distance-based. Its own component owns the route, unit toggle and live pricing. */
const mileage: LineKindStrategy = {
  kind: 'MILEAGE',
  appliesTo: (c) => c?.isMileage === true,
  // `MileageFields` is rendered directly by the row: it needs the report/expense ids and
  // the pricing query, which are the row's concerns rather than a strategy's. The
  // strategy exists to SELECT it and to declare what switching away has to clear.
  clearsOnExit: ['km'],
};

/**
 * A tip field, for categories that accept one.
 *
 * A voluntary tip is reimbursed but NOT taxed, so it leaves the taxable base — which is
 * exactly why it needs to be visible and correctable. A tip the extractor read wrongly
 * silently restates the tax on the line.
 */
function TipFields({
  draft,
  disabled,
  onTipChange,
  onTipCommit,
  currencySymbol,
  labels,
}: LineFieldsProps) {
  return (
    <label
      className="flex items-center gap-1.5 text-muted-foreground text-xs"
      title={labels.tipHint}
    >
      <span>{labels.tip}</span>
      <span>{currencySymbol}</span>
      <input
        aria-label={labels.tip}
        inputMode="decimal"
        className="w-full rounded border border-border bg-background px-2 py-1 text-foreground text-sm lg:w-20"
        placeholder="0.00"
        value={draft.tip}
        disabled={disabled}
        onChange={(e) => onTipChange(e.target.value)}
        onBlur={onTipCommit}
      />
    </label>
  );
}

const standardWithTip: LineKindStrategy = {
  kind: 'STANDARD_WITH_TIP',
  appliesTo: (c) => c?.acceptsTip === true,
  Fields: TipFields,
  // Leaving a tip-accepting category strips the tip: the server does the same, since a
  // tip on a category that does not accept one is how bad data gets in.
  clearsOnExit: ['tip'],
};

/** The fallback: amount + category, and nothing else. */
const standard: LineKindStrategy = {
  kind: 'STANDARD',
  appliesTo: () => true,
  clearsOnExit: [],
};

/**
 * Ordered, and the order is the rule. Mileage first because `isMileage` wins over
 * `acceptsTip` in `resolveLineKind`; `standard` last as the unconditional fallback.
 */
export const LINE_KIND_STRATEGIES: readonly LineKindStrategy[] = [
  mileage,
  standardWithTip,
  standard,
];

/** The strategy for a category. Never null — `standard` matches everything. */
export function strategyFor(category: CategoryCapabilities | undefined): LineKindStrategy {
  // biome-ignore lint/style/noNonNullAssertion: `standard` matches unconditionally.
  return LINE_KIND_STRATEGIES.find((s) => s.appliesTo(category))!;
}

/**
 * Fields to clear when moving between two categories.
 *
 * Empty when the strategy does not change, which is what keeps an edit within one kind
 * (picking a different meal category) from wiping the amount.
 */
export function fieldsToClear(
  from: CategoryCapabilities | undefined,
  to: CategoryCapabilities | undefined,
): readonly (keyof LineDraft)[] {
  const before = strategyFor(from);
  const after = strategyFor(to);
  if (before === after) return [];
  // Both sides: leaving mileage must drop the distance, and arriving at mileage must drop
  // the typed amount — neither is meaningful in the other kind.
  return [...new Set([...before.clearsOnExit, ...after.clearsOnExit, 'amount' as const])];
}
