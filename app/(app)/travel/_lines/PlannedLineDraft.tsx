'use client';

/**
 * A budget line that does not exist yet.
 *
 * The drawer used to add lines through a FORM STRIP pinned above the list — a labelled
 * category select, an amount, a notes box and an "Add to budget" button — which is a
 * different shape from the thing it produces and a different shape from how every other
 * repeating row in the product is added. Somebody filling in a trip met two layouts for
 * one idea.
 *
 * This is the same motion the expense workbench's "Add a line" uses: press the button, a
 * row appears, and it is already the shape of the row it will become —
 *
 *     row 1   category (two thirds) · amount (one third) · discard
 *     row 2   the traveller's own words
 *
 * ## Picking the category is the save
 *
 * There is no save button, for the reason the expense side records: a line's category
 * decides its KIND, and everything else about it is editable in place afterwards. So the
 * moment a category is chosen the line is created and this row is replaced by the real
 * one — with identical geometry, so nothing moves under the cursor. A blank amount is the
 * common case, and it is also how the derived figure gets POPULATED: the server prices the
 * line as it is created, and the block that replaces this row shows the allowance in its
 * amount box with the derivation captioned under it.
 *
 * Anything already typed rides along. Filling the amount first and the category second is
 * the natural order for somebody who knows what they are budgeting before they know which
 * bucket it goes in, and losing it would be a silent retype.
 *
 * ## …unless the pick would override a policy amount without a word
 *
 * The one case the save has to WAIT for. An amount typed before the category is picked,
 * with no note, is exactly the write the server refuses when the category turns out to
 * carry a per-diem — "Raising a policy-derived amount needs a reason" — and the row used
 * to learn that from the refusal. So the pick now asks `travelRequests.previewLine` what
 * the policy would derive, and:
 *
 *   · nothing derivable → the line is created, the amount a plain typed figure;
 *   · the typed figure IS the derivation → created with no amount, so it lands as
 *     `PER_DIEM` rather than as a typed copy of the allowance;
 *   · it differs → the row HOLDS, with the category shown as picked, the amber "overrides
 *     the policy amount of …" under the box, and the notes field marked required. Writing
 *     the note and leaving the field is what creates the line; so is clearing the amount.
 *
 * The server rule is unchanged behind this. The row is where the traveller meets it.
 *
 * The row survives a REFUSAL with its values intact. A draft that cleared itself on the
 * server's "no" would make the person retype an amount the server never objected to.
 */

import {
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@expenseos/design-system';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import { formatMinor, majorToMinor, pickText } from '@/lib/format';
import { trpc } from '@/lib/trpc/client';
import { BudgetLineNotes, BudgetLineRow } from './BudgetLineRow';

export interface PlannedLineDraftInput {
  categoryId: string;
  amountMinor?: bigint;
  notes: string | null;
}

export function PlannedLineDraft({
  categories,
  currency,
  requestId,
  pending,
  error,
  onCreate,
  onDiscard,
}: {
  categories: { id: string; label: unknown; icon: string | null }[];
  currency: { code: string; symbol: string };
  /** The saved request the line is being added to — what the preview prices against. */
  requestId: string;
  pending?: boolean;
  /** The server's own words about why the last attempt was refused. */
  error?: string | null;
  onCreate(input: PlannedLineDraftInput): void;
  onDiscard(): void;
}) {
  const t = useTranslations('travel');
  const locale = useLocale();
  const [amount, setAmount] = useState('');
  const [notes, setNotes] = useState('');
  /** Set only while a pick is HELD — see the header. Empty means "pick = save". */
  const [heldCategoryId, setHeldCategoryId] = useState('');

  const typedMinor = (() => {
    const minor = majorToMinor(amount.trim() || null, currency.code, locale);
    return minor != null && minor > 0n ? minor : null;
  })();

  const preview = trpc.travelRequests.previewLine.useQuery(
    { requestId, categoryId: heldCategoryId },
    { enabled: !!heldCategoryId, staleTime: 5 * 60_000 },
  );
  // An errored preview counts as answered with nothing: the row files the line and the
  // server, which enforces the rule regardless, has the last word.
  const settled = !!heldCategoryId && (preview.data !== undefined || preview.isError);
  const derivedMinor =
    settled && preview.data?.derivedAmountMinor != null
      ? BigInt(preview.data.derivedAmountMinor)
      : null;
  /** A held pick whose typed figure differs from what the policy derives. */
  const overridden = derivedMinor != null && typedMinor != null && typedMinor !== derivedMinor;

  const create = (categoryId: string, amountMinor: bigint | null) => {
    if (!categoryId) return;
    onCreate({
      categoryId,
      // Omitted when blank, so the SERVER derives it — the per-diem for the destination,
      // or a cap × the trip's days. Sending 0 would land as a MANUAL zero and suppress
      // the derivation entirely, which is the opposite of leaving the box empty.
      ...(amountMinor != null ? { amountMinor } : {}),
      notes: notes.trim() || null,
    });
  };

  /**
   * The pick. Saves at once unless it might be an unexplained override — the only case
   * that needs the preview's answer first — in which case the row holds until it has one.
   */
  const pick = (categoryId: string) => {
    if (!categoryId) return;
    if (typedMinor == null || notes.trim()) {
      setHeldCategoryId('');
      create(categoryId, typedMinor);
      return;
    }
    setHeldCategoryId(categoryId);
  };

  /**
   * The preview answered for a held pick. Decided ONCE per category — a refusal from the
   * server leaves the row standing with its values, and must not be retried on every
   * re-render; the traveller retries by picking again or editing what was refused.
   */
  const decidedFor = useRef('');
  // biome-ignore lint/correctness/useExhaustiveDependencies: `create` is a fresh closure per render; the answer is the dependency, and the decision is made once per category.
  useEffect(() => {
    if (!settled || decidedFor.current === heldCategoryId) return;
    decidedFor.current = heldCategoryId;
    // No allowance to displace: a typed figure is a plain typed figure, and the pick was
    // only ever waiting to find that out.
    if (derivedMinor == null) create(heldCategoryId, typedMinor);
    // The traveller typed the allowance itself. Filed as the derivation it is, not as a
    // typed copy of it that would then demand a note for changing nothing.
    else if (typedMinor === derivedMinor) create(heldCategoryId, null);
    // Otherwise held: the warning and the required note below are the affordance.
  }, [settled, heldCategoryId]);

  /** Leaving the notes field with a reason written is what files a held override. */
  const commitNotes = () => {
    if (heldCategoryId && overridden && notes.trim()) create(heldCategoryId, typedMinor);
  };

  /** Leaving the amount field: a held pick whose figure no longer overrides anything files
   *  itself — cleared, so the server derives, or retyped back to the allowance. */
  const commitAmount = () => {
    if (!heldCategoryId || !settled) return;
    if (typedMinor == null || typedMinor === derivedMinor) create(heldCategoryId, null);
  };

  const held = categories.find((c) => c.id === heldCategoryId);

  return (
    <div
      className={`rounded-md border border-dashed p-3 ${
        error ? 'border-destructive' : 'border-border'
      }`}
    >
      {/* The server's own sentence. It is already specific — "That travel category is not
          available." names the thing to fix — so rewording it here would only blur it. */}
      {error && (
        <p role="alert" className="mb-2 text-destructive text-xs">
          {error}
        </p>
      )}
      <BudgetLineRow
        removeLabel={t('detail.plannedDiscard')}
        removeDisabled={pending}
        onRemove={onDiscard}
        category={
          <Select value={heldCategoryId} onValueChange={(v) => v && pick(v)} disabled={pending}>
            <SelectTrigger aria-label={t('detail.plannedCategory')}>
              {/* A render child, not a bare `<SelectValue />`: base-ui shows the raw VALUE
                  when given none, and the value here is a UUID. A held pick shows its
                  category — the row is that line now, waiting on one word. */}
              {/* VeloExpense (w6-02): the kit's Radix <SelectValue> renders the held item's own
                  label (icon + name) and takes the empty state as a placeholder. */}
              <SelectValue placeholder={t('detail.plannedCategoryPlaceholder')} />
            </SelectTrigger>
            <SelectContent>
              {categories.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.icon ? `${c.icon} ` : ''}
                  {pickText(c.label, locale)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
        amount={
          <Input
            aria-label={t('detail.plannedAmount')}
            type="number"
            min="0"
            step="0.01"
            inputMode="decimal"
            prefix={currency.symbol}
            className="text-right"
            placeholder="0.00"
            value={amount}
            disabled={pending}
            onChange={(e) => setAmount(e.target.value)}
            onBlur={commitAmount}
          />
        }
        caption={
          overridden &&
          derivedMinor != null && (
            <p role="status" className="mt-1 text-amber-700 text-xs dark:text-amber-500">
              {t('line.overrides', {
                amount: formatMinor(Number(derivedMinor), currency, locale),
              })}
            </p>
          )
        }
        notes={
          <BudgetLineNotes
            value={notes}
            disabled={pending}
            required={overridden}
            onChange={setNotes}
            onBlur={commitNotes}
          />
        }
      />
      <p className="mt-1.5 text-muted-foreground text-xs">{t('detail.plannedAmountHint')}</p>
    </div>
  );
}
