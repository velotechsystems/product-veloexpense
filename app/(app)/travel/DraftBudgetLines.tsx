'use client';

/**
 * The planned budget, while the request is still a draft in the browser.
 *
 * A traveller used to have to save the trip, wait for the drawer to reopen on the saved
 * record, and only then start adding what they intended to spend — two screens and a round
 * trip for one act. These rows are held locally and posted WITH the request.
 *
 * ── The kind's own fields are HERE too ───────────────────────────────────────
 *
 * They used not to be, and the omission read as a missing feature rather than as the
 * boundary it is. It is worth separating the two cases, because they are not the same:
 *
 *   - A meal's attendees, and a car's or a taxi's days × daily cap, are PAYLOAD. They are
 *     typed, not fetched, and `travelRequests.create` has always accepted a payload per
 *     line — so there was never a reason to make somebody save the trip first. They render
 *     here, and the server prices from them on create exactly as it would after.
 *
 *   - A fare search and a hotel search are not payload. Cabin, stops and check-in dates are
 *     the ARGUMENTS to a provider search that writes its result through a mutation keyed on
 *     a line that exists, and there is no line until this form is submitted. Those rows say
 *     so in a sentence rather than showing a Search button that cannot search.
 *
 * ── The amount is POPULATED, and typing over it is the override ──────────────
 *
 * It used to be blank on every row, with a hint saying blank meant "let the policy price
 * it". True, and useless to somebody deciding whether the trip is affordable: the figure
 * the policy would produce was invisible until the request had been saved. So a row whose
 * category carries a per-diem now asks `travelRequests.previewLine` — the destination, the
 * dates and the currency it already has, priced by the same ladder the save will run — and
 * shows the answer IN the amount box, with the derivation captioned under it.
 *
 * What goes on the wire has not changed, and that is the part that matters:
 *
 *   · the populated figure, untouched, sends NO amount — the server derives, and the line
 *     lands as `PER_DIEM`, exactly as a blank box always did;
 *   · a figure the traveller typed over it sends the amount, lands as `MANUAL`, and the
 *     server records what it replaced and refuses it without a note. That rule is mirrored
 *     here — the amber warning, the notes field turning required, and Create held until
 *     it is written — so the traveller meets it on the row and not as a banner after the
 *     fact. The server is still the enforcement; this is the courtesy.
 *
 * The browser still never posts a total it worked out itself. The figure in the box came
 * from the server, and sending it back would only relabel a derivation as a typed one.
 */

import {
  Button,
  IconPlus,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@expenseos/design-system';
import { useLocale, useTranslations } from 'next-intl';
import { type Dispatch, type SetStateAction, useEffect } from 'react';
import { formatMinor, majorToMinor, minorToMajorInput, pickText } from '@/lib/format';
import { trpc } from '@/lib/trpc/client';
import { AttendeesBlock } from './_lines/AttendeesBlock';
import { BudgetLineNotes, BudgetLineRow } from './_lines/BudgetLineRow';
import { EMPTY_DRAFT, strategyFor, type TravelLineDraft } from './_lines/lineKinds';
import { derivationSummary } from './_lines/summary';

export interface DraftBudgetLine {
  /** Local identity for React. A row has no server id until the request is filed, and
   *  keying on the index would hand a removed row's caret to the one below it. */
  rowId: string;
  categoryId: string;
  /** Major units, as populated or as typed. Parsed once, on submit. */
  amount: string;
  notes: string;
  /** The kind's own draft, for the kinds priced from a cap × days. Strings until sent,
   *  for the reason `TravelLineDraft` records. */
  kindDraft: TravelLineDraft;
  /** What goes on the wire as this line's payload — built from `kindDraft` for a car or a
   *  ground leg, handed over whole by the attendee editor for a meal. Null when the kind
   *  has nothing of its own to send. */
  payload: Record<string, unknown> | null;
  /**
   * What the policy derived for this row the last time the preview answered, in minor
   * units as a string. Null when nothing was derived — or nothing asked yet.
   *
   * Kept ON the row rather than in the row component, because two decisions outside it
   * depend on it: whether the amount goes on the wire at all, and whether Create may be
   * pressed without a note. Both are made by the drawer, from the rows.
   */
  derivedAmountMinor: string | null;
}

/** The trip as typed so far — what a preview prices a row against. */
export interface DraftTrip {
  destinationCity: string | null;
  /** ISO instants, midnight UTC, the same shape `create` sends. Null until typed. */
  departDate: string | null;
  returnDate: string | null;
  currencyId: string;
  /** False while the dates are incoherent — a round trip with no return, a return before
   *  the departure. A preview against half a trip would show a one-day figure that then
   *  jumps, which reads as the number being unreliable. */
  ready: boolean;
}

export function newDraftLine(): DraftBudgetLine {
  return {
    rowId: `d-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    categoryId: '',
    amount: '',
    notes: '',
    kindDraft: { ...EMPTY_DRAFT },
    payload: null,
    derivedAmountMinor: null,
  };
}

/**
 * Parsed with `'en'` whatever the reader's locale: the box is `<input type="number">`,
 * whose value is always dot-decimal regardless of what the person typed or saw.
 */
const PARSE_LOCALE = 'en';

/**
 * What a row's amount means on the wire.
 *
 *   · nothing typed, or the populated figure left as it was  → no amount; the server derives
 *   · a figure with no derivation behind it                  → the amount, a plain typed figure
 *   · a figure that differs from the derivation              → the amount, and it is an OVERRIDE
 *
 * The middle case is not an override — there was nothing to replace — and the server agrees:
 * it records `derivedAmountMinor` and demands a note only when a derivation was displaced.
 * The three cases are decided here, once, so the send and the gate cannot disagree.
 */
export function draftLineAmount(
  line: Pick<DraftBudgetLine, 'amount' | 'derivedAmountMinor'>,
  currencyCode: string,
): { amountMinor: bigint | null; overridden: boolean } {
  const minor = majorToMinor(line.amount.trim() || null, currencyCode, PARSE_LOCALE);
  if (minor == null || minor <= 0n) return { amountMinor: null, overridden: false };
  const derived = line.derivedAmountMinor != null ? BigInt(line.derivedAmountMinor) : null;
  if (derived != null && minor === derived) return { amountMinor: null, overridden: false };
  return { amountMinor: minor, overridden: derived != null };
}

/** True while a row overrides its derivation and nothing says why. What holds Create. */
export function draftLineNeedsNote(line: DraftBudgetLine, currencyCode: string): boolean {
  return draftLineAmount(line, currencyCode).overridden && !line.notes.trim();
}

type Category = { id: string; label: unknown; icon: string | null; lineKind?: string | null };

export function DraftBudgetLines({
  lines,
  onChange,
  categories,
  currencySymbol,
  currencyCode,
  trip,
  disabled,
}: {
  lines: DraftBudgetLine[];
  /**
   * A state setter, not a plain callback. Rows patch themselves from an EFFECT when their
   * preview settles, and two previews settle in the same batch response — so two patches
   * land in one commit, and a patch computed from a closed-over `lines` would drop the
   * other row's. The updater form is what makes concurrent patches compose.
   */
  onChange: Dispatch<SetStateAction<DraftBudgetLine[]>>;
  categories: Category[];
  currencySymbol: string;
  currencyCode: string;
  trip: DraftTrip;
  disabled?: boolean;
}) {
  const t = useTranslations('travel');

  const patch = (rowId: string, next: Partial<DraftBudgetLine>) =>
    onChange((prev) => prev.map((l) => (l.rowId === rowId ? { ...l, ...next } : l)));
  const remove = (rowId: string) => onChange((prev) => prev.filter((l) => l.rowId !== rowId));

  /**
   * A preview settled for a row. Two things can follow, and the difference is whether the
   * traveller has touched the amount:
   *
   *   · untouched — blank, or still exactly the figure the LAST preview populated — takes
   *     the new figure, so a changed destination or date moves the amount with it;
   *   · typed over — keeps what they typed. The new derivation is recorded underneath, so
   *     the warning compares against the right number, and nothing they wrote is lost.
   *
   * The seed-only-when-empty rule the attendee editor uses, extended by one clause because
   * this box, unlike that one, is re-priced as the trip above it changes.
   */
  const applyDerived = (rowId: string, derived: string | null) =>
    onChange((prev) =>
      prev.map((l) => {
        if (l.rowId !== rowId || l.derivedAmountMinor === derived) return l;
        const typed = majorToMinor(l.amount.trim() || null, currencyCode, PARSE_LOCALE);
        const untouched =
          typed == null || (l.derivedAmountMinor != null && typed === BigInt(l.derivedAmountMinor));
        return {
          ...l,
          derivedAmountMinor: derived,
          ...(untouched
            ? { amount: derived ? minorToMajorInput(BigInt(derived), currencyCode) : '' }
            : {}),
        };
      }),
    );

  return (
    <div className="flex flex-col gap-2">
      {lines.map((line) => (
        <DraftLineRow
          key={line.rowId}
          line={line}
          categories={categories}
          currencySymbol={currencySymbol}
          currencyCode={currencyCode}
          trip={trip}
          disabled={disabled}
          onPatch={(next) => patch(line.rowId, next)}
          onDerived={(derived) => applyDerived(line.rowId, derived)}
          onRemove={() => remove(line.rowId)}
        />
      ))}

      <Button
        size="sm"
        variant="outline"
        className="w-full"
        disabled={disabled}
        onClick={() => onChange((prev) => [...prev, newDraftLine()])}
      >
        <IconPlus className="mr-1 h-3.5 w-3.5" />
        {t('detail.plannedAddItem')}
      </Button>
      {/* Said where the amount is typed, because leaving it alone is the RIGHT answer for
          most categories and reads like an unfinished row otherwise. Only once there is a
          row to say it about. */}
      {lines.length > 0 && (
        <p className="text-muted-foreground text-xs">{t('detail.plannedAmountHint')}</p>
      )}
    </div>
  );
}

/**
 * One row. Its own component because the preview is a hook, and a hook per row cannot live
 * inside a `.map` in the parent.
 */
function DraftLineRow({
  line,
  categories,
  currencySymbol,
  currencyCode,
  trip,
  disabled,
  onPatch,
  onDerived,
  onRemove,
}: {
  line: DraftBudgetLine;
  categories: Category[];
  currencySymbol: string;
  currencyCode: string;
  trip: DraftTrip;
  disabled?: boolean;
  onPatch(next: Partial<DraftBudgetLine>): void;
  onDerived(derived: string | null): void;
  onRemove(): void;
}) {
  const t = useTranslations('travel');
  const locale = useLocale();
  const picked = categories.find((c) => c.id === line.categoryId);
  const label = picked ? pickText(picked.label, locale) : '';
  const strategy = strategyFor(picked?.lineKind);

  /**
   * Asked only for the kinds that use the answer — a STANDARD line takes the trip total
   * as its amount, a meal takes the DAILY rate as its per-person figure — and only once the
   * trip above is coherent enough to price. Twenty rows of airfare would otherwise make
   * twenty lookups none of them read.
   */
  const wantsPreview = !!picked && (strategy.kind === 'STANDARD' || strategy.attendees === true);
  const previewEnabled = wantsPreview && trip.ready && !!trip.departDate && !!trip.currencyId;
  const preview = trpc.travelRequests.previewLine.useQuery(
    {
      categoryId: line.categoryId,
      destinationCity: trip.destinationCity,
      departDate: trip.departDate,
      returnDate: trip.returnDate,
      currencyId: trip.currencyId,
    },
    { enabled: previewEnabled, staleTime: 60_000 },
  );
  // Only a STANDARD line's amount IS the allowance. A meal's total is heads × occurrences ×
  // days × the rate, which the server derives from the attendee payload, so its box is
  // left alone and only the rate is handed down.
  const populates = previewEnabled && strategy.kind === 'STANDARD';
  const derived = populates && preview.data ? preview.data.derivedAmountMinor : null;
  const settled = populates && preview.data !== undefined;

  /**
   * Hand the row what was derived, once the query has an answer.
   *
   * An EFFECT rather than the render-time seed the attendee editor uses, because the state
   * being seeded belongs to the parent — React forbids setting another component's state
   * mid-render. Keyed on the derived STRING so a re-render with the same answer is a no-op.
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: `onDerived` is a fresh closure per render; the answer it delivers is the dependency.
  useEffect(() => {
    if (settled) onDerived(derived);
  }, [settled, derived]);

  const { overridden } = draftLineAmount(line, currencyCode);
  const derivedMinor = line.derivedAmountMinor != null ? BigInt(line.derivedAmountMinor) : null;
  const money = (minor: bigint) => formatMinor(Number(minor), { code: currencyCode }, locale);
  const caption = derivationSummary(populates ? preview.data : null, {
    t: t as (key: string, values?: Record<string, string | number>) => string,
    money,
  });

  /** A category change takes the kind with it, so whatever was typed for the old kind has
   *  to go: a day count is not a head count, and leaving one behind would post a payload
   *  the server validates against a kind that no longer applies. The derivation goes too —
   *  it was the OLD category's. */
  const pickCategory = (categoryId: string) => {
    const kindChanged =
      strategyFor(categories.find((c) => c.id === categoryId)?.lineKind).kind !== strategy.kind;
    onPatch({
      categoryId,
      ...(kindChanged
        ? { kindDraft: { ...EMPTY_DRAFT }, payload: null, amount: '', derivedAmountMinor: null }
        : {}),
    });
  };

  /** Only reached from a strategy that renders `Fields`, and every such strategy builds
   *  its own payload — so the payload is rebuilt from the whole draft on every keystroke
   *  rather than patched field by field. */
  const patchKind = (next: Partial<TravelLineDraft>) => {
    const kindDraft = { ...line.kindDraft, ...next };
    onPatch({ kindDraft, payload: strategy.buildPayload?.(kindDraft) ?? null });
  };

  return (
    <div className="rounded-md border border-border bg-card p-3">
      <BudgetLineRow
        showLabels
        removeLabel={t('detail.plannedRemove', { category: label || '' })}
        removeDisabled={disabled}
        onRemove={onRemove}
        category={
          <Select
            value={line.categoryId}
            onValueChange={(v) => pickCategory(v ?? '')}
            disabled={disabled}
          >
            <SelectTrigger aria-label={t('detail.plannedCategory')}>
              {/* A render child, not a bare `<SelectValue />`: base-ui shows the raw
                  VALUE when given none, and the value here is a UUID.
                  VeloExpense (w6-02): the kit's Radix <SelectValue> renders the chosen item's
                  own label (icon + name, the same text) and takes the empty state as a
                  placeholder, so ExpenseOS's Base UI render-fn is not needed. */}
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
            prefix={currencySymbol}
            className="text-right"
            placeholder="0.00"
            value={line.amount}
            disabled={disabled}
            onChange={(e) => onPatch({ amount: e.target.value })}
          />
        }
        caption={
          (caption || overridden) && (
            <div className="mt-1 flex flex-col gap-0.5">
              {/* Where the populated figure came from, in the sentence the saved line will
                  carry. Blank until the preview answers; a caption guessed at first would
                  flicker. */}
              {caption && <p className="text-muted-foreground text-xs">{caption}</p>}
              {/* Said WHILE it differs, before anything is sent. `role="status"` so a screen
                  reader hears the warning appear as the figure changes. */}
              {overridden && derivedMinor != null && (
                <p role="status" className="text-amber-700 text-xs dark:text-amber-500">
                  {t('line.overrides', { amount: money(derivedMinor) })}
                </p>
              )}
            </div>
          )
        }
        notes={
          <BudgetLineNotes
            value={line.notes}
            disabled={disabled}
            required={overridden}
            onChange={(v) => onPatch({ notes: v })}
          />
        }
      >
        {/* Attendees. The editor is already a local draft that hands its payload up — it
            never owned a mutation — so it works here unchanged. The per-person box is
            pre-filled with the DAILY rate the preview resolved for this trip, the same
            number the saved block shows; blank still means "let the server resolve it". */}
        {strategy.attendees && (
          <div className="mt-3">
            <AttendeesBlock
              key={line.categoryId}
              initial={{ attendees: [], occurrencesPerDay: 1, days: 1 }}
              currencySymbol={currencySymbol}
              perDiemRateMinor={previewEnabled ? (preview.data?.dailyRateMinor ?? null) : null}
              disabled={disabled}
              onApply={(payload) => onPatch({ payload })}
            />
          </div>
        )}

        {strategy.Fields && (
          <div className="mt-3">
            <strategy.Fields
              draft={line.kindDraft}
              disabled={disabled}
              onChange={patchKind}
              currencySymbol={currencySymbol}
              labels={{
                days: t('line.days'),
                dailyCap: t('line.dailyCap'),
                capHint: t('line.dailyCapHint'),
                noLiveRate: t('line.noLiveRate'),
              }}
            />
          </div>
        )}

        {/* The one thing that genuinely cannot happen yet, said plainly. A Search button
            here would have nothing to search against — the provider call writes its quote
            onto a line, and the line arrives with the request. */}
        {strategy.picker && (
          <p className="mt-2 text-muted-foreground text-xs">
            {t(
              strategy.picker === 'FLIGHT'
                ? 'detail.plannedSearchAfterCreateFlight'
                : 'detail.plannedSearchAfterCreateStay',
            )}
          </p>
        )}
      </BudgetLineRow>
    </div>
  );
}
