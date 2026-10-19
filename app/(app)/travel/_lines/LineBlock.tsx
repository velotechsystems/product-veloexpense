'use client';

import { Badge, Button, Input } from '@expenseos/design-system';
// VeloExpense (w6-02): the vendored kit does not re-export `IconTrash`; it is Tabler's icon.
import { IconTrash } from '@tabler/icons-react';
import { useLocale, useTranslations } from 'next-intl';
import { useRef, useState } from 'react';
import { formatMinor, majorToMinor, minorToMajorInput, pickText } from '@/lib/format';
import { trpc } from '@/lib/trpc/client';
import { type AttendeeDraft, AttendeesBlock } from './AttendeesBlock';
import { BudgetLineNotes } from './BudgetLineRow';
import { EMPTY_DRAFT, strategyFor, type TravelLineDraft } from './lineKinds';
import { FlightPicker, StayPicker } from './OptionPicker';
import { lineSummary } from './summary';

/**
 * One budget line, as its own bordered block.
 *
 * Replaces a row in a hand-rolled `<table>`. The table could show a category, a basis
 * and an amount and nothing else, which was fine while every line was three of those and
 * became the constraint once a line could be a flight with a number and a cabin, or a
 * meal with people at it.
 *
 * The block shows three things a table could not:
 *
 *   · the fields its KIND actually has, chosen by the strategy registry;
 *   · where its number came from, as a badge — a policy ceiling and a market price are
 *     both "budget" and are not equally trustworthy, and an approver deciding on a
 *     total is entitled to know which they are reading;
 *   · an editable amount, which is the override. Typing one makes the line MANUAL and
 *     it stays that way: nothing re-prices, and going back to the derived figure means
 *     adding a fresh line and deleting this one.
 *
 * ## An override says why, and says so here
 *
 * The server refuses a typed figure that displaces a policy-derived one unless the line
 * carries a note (GA-6). The block mirrors that WHILE the figure is being typed: the amber
 * "overrides the policy amount of …" appears as soon as the box differs from the
 * derivation, the notes field turns required, and a blur that would send an unexplained
 * override is refused on the client — the typed figure stays in the box, the notes field
 * takes focus — rather than making a round trip to be told the same thing. Notes typed
 * afterwards go up WITH the amount, so the traveller never has to blur the amount twice.
 *
 * The derivation it compares against is the one the server recorded (`derivedAmountMinor`)
 * when the line has already been overridden once, and otherwise a live preview of what the
 * policy derives for this category on this trip — which, for a `PER_DIEM` line that has
 * never been touched, is the figure it carries.
 *
 * ## The shape
 *
 * The same shape an expense line item uses, because it is the same act:
 *
 *   row 1   the category, the amount, and the trash
 *   row 2   the traveller's own words
 *   then    whatever the KIND adds, with no rule between them — a separator would say
 *           the fare search is a different thing from the line, and it is the line.
 *
 * The amount sits in row 1 and CARRIES THE CURRENT FIGURE, editable in place. It used to
 * be a blank box at the bottom of the block, deliberately empty so that an accidental
 * no-op edit could not flip a derived line to MANUAL — a real hazard answered in the
 * wrong place. It is answered here by only writing when the value actually CHANGES: a
 * no-op edit is now a no-op, and the traveller can see the number they are editing.
 */

const BASIS_VARIANT: Record<string, 'success' | 'warning' | 'secondary'> = {
  QUOTE: 'success',
  POLICY_CAP: 'warning',
  PER_DIEM: 'secondary',
  MANUAL: 'secondary',
};

/**
 * The attendee editor's starting values, read out of the stored payload.
 *
 * Tolerant: a malformed payload seeds an empty editor rather than throwing. Strict on
 * write, forgiving on read — the same split the payload registry makes, and the reason a
 * drawer rendering fifty lines shows the forty-nine it understands.
 */
function attendeeSeed(payload: unknown): {
  attendees: AttendeeDraft[];
  occurrencesPerDay: number;
  days: number;
  ratePerPersonMinor: string | null;
} {
  const p = (payload ?? {}) as Record<string, unknown>;
  const raw = Array.isArray(p.attendees) ? (p.attendees as Record<string, unknown>[]) : [];
  return {
    attendees: raw.map((a) => ({
      name: typeof a.name === 'string' ? a.name : '',
      company: typeof a.company === 'string' ? a.company : '',
      isExternal: a.isExternal === true,
    })),
    occurrencesPerDay: typeof p.occurrencesPerDay === 'number' ? p.occurrencesPerDay : 1,
    days: typeof p.days === 'number' ? p.days : 1,
    // What somebody already typed over the allowance, when they did. The block prefers it
    // to the resolved rate — an override the query settling could undo is not an override.
    ratePerPersonMinor:
      typeof p.ratePerPersonMinor === 'string' ? (p.ratePerPersonMinor as string) : null,
  };
}

type Line = {
  id: string;
  kind: string;
  amountMinor: bigint | number | string;
  basis: string;
  confidence: string | null;
  notes: string | null;
  /** What the policy derived, when this figure replaced it. */
  derivedAmountMinor?: string | number | bigint | null;
  payload?: unknown;
  category: { id: string; label: unknown; icon: string | null; color?: string | null };
};

export function LineBlock({
  line,
  requestId,
  currency,
  tripType,
  departDate,
  returnDate,
  editable,
  pending,
  onUpdate,
  onRemove,
  onChanged,
  onError,
}: {
  line: Line;
  requestId: string;
  currency: { code: string; symbol: string };
  /** The trip's own shape and dates. A picker DEFAULTS from them and never overrides
   *  them: changing where or when somebody is flying is `update`'s job, and a search
   *  with its own route would price a journey the request does not describe. */
  tripType: string;
  departDate: string | Date;
  returnDate: string | Date | null;
  editable: boolean;
  pending?: boolean;
  onUpdate(input: {
    amountMinor?: bigint;
    payload?: Record<string, unknown> | null;
    notes?: string | null;
  }): void;
  onRemove(): void;
  /** A picker writes through its own mutation, so the drawer has to be told to refetch. */
  onChanged(): void;
  onError(e: { message: string }): void;
}) {
  const t = useTranslations('travel');
  const locale = useLocale();
  const strategy = strategyFor(line.kind);
  /**
   * The allowance this category resolves to on this trip, per person.
   *
   * Asked for only on the kind that multiplies by it, so a drawer of twenty lines does not
   * make twenty lookups nineteen of them ignore. It is what pre-fills the per-person box:
   * a traveller looking at a total is entitled to see the rate it was reached with.
   */
  const perDiem = trpc.travelRequests.perDiemRate.useQuery(
    { id: requestId, categoryId: line.category.id },
    { enabled: editable && strategy.attendees === true, staleTime: 5 * 60_000 },
  );
  /**
   * What the policy derives for this line NOW, for a derived line that has not been
   * overridden yet.
   *
   * Only asked when it is the one thing that can tell the traveller what they are about
   * to displace: a `PER_DIEM` line with no recorded override. A line that has already been
   * overridden carries the figure it replaced; a `MANUAL`, `QUOTE` or `POLICY_CAP` line has
   * no allowance to compare against.
   */
  const derivation = trpc.travelRequests.previewLine.useQuery(
    { requestId, categoryId: line.category.id },
    {
      enabled: editable && line.basis === 'PER_DIEM' && line.derivedAmountMinor == null,
      staleTime: 5 * 60_000,
    },
  );
  const [draft, setDraft] = useState<TravelLineDraft>(EMPTY_DRAFT);
  /**
   * The amount, in row 1, showing the figure the line CURRENTLY carries.
   *
   * It used to start blank — a box showing the stored value invites an accidental no-op
   * edit that flips a derived line to MANUAL. That hazard is real and is answered by
   * `commitAmount` below, which writes only when the value actually changed; a blank box
   * answered it by hiding the number the traveller was editing, which is why the amount
   * they could see was the OLD one and the one they typed had no formatting at all.
   *
   * Re-seeded whenever the stored figure moves under it — a fare picked in the search
   * modal writes through its own mutation, and the box has to show what landed.
   */
  // `amountMinor` crosses the wire as a string and arrives as a bigint from the cache;
  // one normalisation, so the comparisons below are between like things.
  const storedMinor = BigInt(line.amountMinor);
  const [amount, setAmount] = useState(() => minorToMajorInput(storedMinor, currency.code));
  const seededFrom = useRef(storedMinor);
  if (seededFrom.current !== storedMinor) {
    seededFrom.current = storedMinor;
    setAmount(minorToMajorInput(storedMinor, currency.code));
  }
  /**
   * The traveller's own words, PRE-FILLED with what is stored.
   *
   * Unlike the amount box below — which starts blank so an accidental no-op edit cannot
   * flip a derived line to MANUAL — this is the field's actual value being edited. There
   * is nothing derived to lose, and a rule may require it, so showing it empty when it is
   * not would read as "you still have to write this".
   */
  const [notes, setNotes] = useState(line.notes ?? '');

  const label = pickText(line.category.label, locale);
  const summary = lineSummary(line.kind, line.payload, {
    t: t as (key: string, values?: Record<string, string | number>) => string,
    money: (minor) => formatMinor(Number(minor), currency, locale),
  });
  const patch = (p: Partial<TravelLineDraft>) => setDraft((d) => ({ ...d, ...p }));

  /**
   * What the typed override WILL become, in the line's currency, as it is typed.
   *
   * The box is blank on purpose — a field pre-filled with the stored figure invites an
   * accidental no-op edit that flips a derived line to MANUAL — but blank plus a raw
   * `<input type="number">` means the only formatted money on the row is the OLD figure,
   * sitting in the header where it looks like the new one. "Can't see what you enter
   * until after" (UAT A14) is what that reads like: a traveller types 1450, sees 1450
   * and an unrelated $1,200.00, and has to commit an irreversible override to find out
   * what they entered.
   *
   * Parsed by the same `majorToMinor` the commit uses, so the preview and the saved
   * value cannot disagree — a preview computed a second way would be right until it
   * mattered. `null` when the box is empty or holds something unparseable, and the
   * preview simply is not drawn: guessing at half-typed input would flicker.
   */
  const previewMinor = (() => {
    const raw = amount.trim();
    if (!raw) return null;
    const minor = majorToMinor(raw, currency.code, locale);
    return minor != null && minor > 0n ? minor : null;
  })();

  /**
   * The figure the policy derived, when there is one to displace.
   *
   * Recorded on the line once an override has happened; previewed live for a derived line
   * that has not been touched; and, until that preview answers, the stored figure itself —
   * a `PER_DIEM` line IS its derivation until somebody types over it. Null on a line the
   * policy never priced, where a typed figure is a plain typed figure and no note is owed.
   */
  const derivedMinor: bigint | null =
    line.derivedAmountMinor != null
      ? BigInt(line.derivedAmountMinor)
      : derivation.data?.derivedAmountMinor != null
        ? BigInt(derivation.data.derivedAmountMinor)
        : line.basis === 'PER_DIEM'
          ? storedMinor
          : null;
  /**
   * An override typed but not yet committed. The SERVER's rule, mirrored exactly: any
   * client-sent amount on a line with a derivation displaces it — retyping the derived
   * figure onto an already-overridden line included — so "differs from what is stored"
   * is the test, not "differs from what was derived".
   */
  const pendingOverride =
    previewMinor != null && previewMinor !== storedMinor && derivedMinor != null;
  const notesRef = useRef<HTMLInputElement>(null);

  /**
   * Write only a real change.
   *
   * This is what makes it safe for the box to show the stored figure: tabbing through the
   * amount without touching it, or retyping the same number, is not an override — and an
   * override is permanent, so a no-op that flipped a derived line to MANUAL would cost a
   * traveller their allowance for nothing.
   */
  const commitAmount = () => {
    const minor = majorToMinor(amount.trim() || null, currency.code, locale);
    if (minor == null || minor <= 0n) {
      // Unparseable or cleared: put the stored figure back rather than leaving a box that
      // disagrees with the line it belongs to.
      setAmount(minorToMajorInput(storedMinor, currency.code));
      return;
    }
    if (minor === storedMinor) return;
    const notesText = notes.trim();
    /**
     * An override with nothing explaining it is refused HERE, not by the server.
     *
     * The server would refuse it too, with the same sentence — but as an error banner over
     * the drawer, after a round trip, with the box already reset. The typed figure stays
     * where it is, the notes field (already marked required, already saying why) takes
     * focus, and the amount goes up together with the note once it is written.
     */
    if (derivedMinor != null && !notesText) {
      notesRef.current?.focus();
      return;
    }
    onUpdate({
      amountMinor: minor,
      // Notes typed but not yet blurred ride along, so an override explained FIRST and
      // typed second is one write, and one the guard accepts.
      ...(notesText !== (line.notes ?? '') ? { notes: notesText || null } : {}),
    });
  };

  const commitDetail = () => {
    const next = notes.trim();
    /**
     * An override the amount box refused for want of a note is sent from here, with the
     * note. Otherwise the traveller would write the reason, see nothing happen, and have
     * to find their way back to the amount and blur it again.
     */
    if (pendingOverride && previewMinor != null && next) {
      onUpdate({ amountMinor: previewMinor, notes: next });
      return;
    }
    if (next === (line.notes ?? '')) return;
    // An empty string is SENT, not skipped: clearing a justification has to be
    // expressible, because a rule may be requiring one.
    onUpdate({ notes: next || null });
  };

  const commitPayload = () => {
    const payload = strategy.buildPayload?.(draft) ?? null;
    if (payload == null) return;
    onUpdate({ payload });
  };

  return (
    <div className="rounded-md border border-border bg-card p-3">
      {/*
       * The trash sits OUTSIDE the fields, not at the end of row 1.
       *
       * It used to be the row's third item, which stopped the amount ~48px short of the
       * notes box directly beneath it — a ragged edge down the side of every line. Out
       * here the category, the amount and the notes share one right edge, and the button
       * reads as belonging to the whole line, which is what it deletes.
       *
       * `PlannedLineDraft` and the create form's rows are the same shape, via
       * `BudgetLineRow`, so a draft row and the saved row that replaces it do not move
       * under the cursor.
       */}
      <div className="flex items-start gap-2">
        <div className="flex min-w-0 flex-1 flex-col">
          {/* Row 1 — the category takes two thirds, the amount one. The same shape an expense
          line item uses, because it is the same act. */}
          <div className="flex items-center gap-2">
            <div className="flex min-w-0 flex-[2] items-center gap-2">
              <span className="shrink-0 text-base leading-none">{line.category.icon ?? '🧭'}</span>
              <span className="min-w-0 truncate font-medium text-foreground text-sm">{label}</span>
              <Badge variant={BASIS_VARIANT[line.basis] ?? 'secondary'}>
                {t(`basis.${line.basis}` as 'basis.QUOTE')}
              </Badge>
              {line.confidence && line.confidence !== 'UNKNOWN' && (
                <span className="text-muted-foreground text-xs">
                  {t(`confidence.${line.confidence}` as 'confidence.TYPICAL')}
                </span>
              )}
            </div>
            <div className="min-w-0 flex-1">
              {editable ? (
                <Input
                  aria-label={t('line.override')}
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
              ) : (
                <span className="block text-right font-medium text-foreground text-sm tabular-nums">
                  {formatMinor(Number(line.amountMinor), currency, locale)}
                </span>
              )}
            </div>
          </div>
          {/*
           * What the typed figure WILL be, in the line's currency, as it is typed.
           *
           * `<input type="number">` formats nothing, so without this the only formatted money
           * on the row was the stored figure — "can't see what you enter until after" (UAT
           * A14). Parsed by the same `majorToMinor` the commit uses, so the preview and the
           * saved value cannot disagree.
           *
           * ALWAYS rendered, empty until there is something to show: `role="status"` is a
           * polite live region, and a live region has to exist before its content changes for
           * a screen reader to announce it.
           */}
          {editable && (
            <span
              role="status"
              aria-label={t('line.overridePreview')}
              className="mt-1 block text-right text-muted-foreground text-xs tabular-nums empty:hidden"
            >
              {previewMinor != null && previewMinor !== storedMinor
                ? formatMinor(Number(previewMinor), currency, locale)
                : ''}
            </span>
          )}

          {/**
           * How the figure was reached, composed from the PAYLOAD in the reader's locale.
           *
           * This used to render `line.detail` — a sentence the server had written in English.
           * That field is the traveller's now, so the explanation is derived from the facts
           * the payload carries, which also means an approver reading in FR-CA sees it in
           * FR-CA.
           */}
          {summary && <p className="mt-1 text-muted-foreground text-xs">{summary}</p>}

          {/*
           * What the figure REPLACED — or is about to replace — where the figure is.
           *
           * `basis` already flips the badge from "Per diem" to "Planned", which says the
           * amount was keyed rather than derived — but not that it displaced anything. A
           * policy-derived $400 raised to $450 read identically to a $450 typed into an
           * empty line, and an approver cannot ask about a difference they cannot see (GA
           * audit v2, GA-6/V2-06).
           *
           * In BOTH branches. It used to render only on a filed request, so the traveller
           * editing the line — the one person who could still change their mind — was the
           * one person never shown it. While a differing figure is being typed the sentence
           * is present-tense and live: the override has not happened yet, and this is the
           * moment to say what it will cost.
           */}
          {pendingOverride && derivedMinor != null ? (
            <p role="status" className="mt-2 text-amber-700 text-xs dark:text-amber-500">
              {t('line.overrides', { amount: formatMinor(Number(derivedMinor), currency, locale) })}
            </p>
          ) : (
            line.derivedAmountMinor != null && (
              <p className="mt-2 text-amber-700 text-xs dark:text-amber-500">
                {t('line.overrode', {
                  amount: formatMinor(Number(line.derivedAmountMinor), currency, locale),
                })}
              </p>
            )
          )}

          {/**
           * The traveller's own words, immediately under the category and the amount and
           * BEFORE the kind's own fields.
           *
           * Placed here deliberately: it is the one field every line has, and on a quoted
           * line it answers the question the flight picker below cannot — why this fare and
           * not the cheaper one on another carrier. A policy rule may require it, so it must
           * be the thing you see, not something below a collapsed picker.
           */}
          {editable ? (
            <div className="mt-2 flex flex-col gap-1">
              <span className="text-muted-foreground text-xs">{t('line.notes')}</span>
              {/* Required while an override is pending: the same field, announcing that
                  the figure above cannot be saved until it says why. */}
              <BudgetLineNotes
                ref={notesRef}
                value={notes}
                disabled={pending}
                required={pendingOverride}
                onChange={setNotes}
                onBlur={commitDetail}
              />
            </div>
          ) : (
            line.notes && <p className="mt-2 text-foreground text-sm">{line.notes}</p>
          )}

          {/* The kind's own fields follow with NO rule between them: a separator would say the
          fare search is a different thing from the line, and it is the line. */}
          {editable && (
            <div className="mt-3 flex flex-col gap-3">
              {/**
               * A provider-backed picker, rendered HERE rather than from the strategy —
               * it needs the request id, the line id and two mutations, which are this
               * row's concerns. The strategy's job was to say which one to open.
               */}
              {strategy.picker === 'FLIGHT' && (
                <FlightPicker
                  requestId={requestId}
                  lineId={line.id}
                  currency={currency}
                  tripType={tripType}
                  disabled={pending}
                  onChosen={onChanged}
                  onError={onError}
                />
              )}
              {strategy.picker === 'STAY' && (
                <StayPicker
                  requestId={requestId}
                  lineId={line.id}
                  currency={currency}
                  departDate={departDate}
                  returnDate={returnDate}
                  disabled={pending}
                  onChosen={onChanged}
                  onError={onError}
                />
              )}
              {strategy.attendees && (
                <AttendeesBlock
                  initial={attendeeSeed(line.payload)}
                  currencySymbol={currency.symbol}
                  perDiemRateMinor={perDiem.data?.ratePerPersonMinor ?? null}
                  disabled={pending}
                  onApply={(payload) => onUpdate({ payload })}
                />
              )}
              {strategy.Fields && (
                <div>
                  <strategy.Fields
                    draft={draft}
                    disabled={pending}
                    onChange={patch}
                    currencySymbol={currency.symbol}
                    labels={{
                      days: t('line.days'),
                      dailyCap: t('line.dailyCap'),
                      capHint: t('line.dailyCapHint'),
                      noLiveRate: t('line.noLiveRate'),
                    }}
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    className="mt-2"
                    disabled={pending}
                    onClick={commitPayload}
                  >
                    {t('line.recalculate')}
                  </Button>
                </div>
              )}

              {/* Said before it happens, not after. A traveller who does not know an override
              is permanent will type one to "check" and lose the allowance. */}
              <p className="text-muted-foreground text-xs">{t('line.overrideHint')}</p>
            </div>
          )}
        </div>
        {editable && (
          // `size="icon"`, not `size="sm"`, and it is the hit box that decides it.
          //
          // `sm` is `einc-tap-slop h-9 rounded-md px-3 text-xs` (`button.tsx:104`). The
          // slop it carries is VERTICAL ONLY, so an icon-only child in this size ships
          // 36px floored to 44px tall and `px-3` + a 16px glyph = 40px wide, with nothing
          // to widen it — 4px short on the un-slopped axis. `icon` is
          // `einc-tap-slop-both h-10 w-10` (`button.tsx:110`): 40x40 painted, floored to
          // 44 x 44. One prop, no new CSS.
          //
          // `-both` is safe HERE specifically. It reaches (44 - 40) / 2 = 2px per side
          // into the parent's `gap-2` 8px gutter (`:341`), and the only neighbour is the
          // line's content column — a text block, not a second slopped control. That is
          // the case `globals.css:152-157` warns about and this is not it; contrast
          // `DelegationsManager.tsx`, where two `-both` controls each reached 6px into a
          // 6px gutter and the later one won the strip.
          //
          // Visual delta: 36px tall becomes 40px. Same width, same `rounded-md` (it comes
          // from the cva base, `button.tsx:32`, not from the `sm` variant), same ghost
          // weight. `mt-0.5` still aligns the glyph with the first line of the label.
          <Button
            size="icon"
            variant="ghost"
            className="mt-0.5 shrink-0"
            aria-label={t('detail.plannedRemove', { category: label })}
            disabled={pending}
            onClick={onRemove}
          >
            <IconTrash className="h-4 w-4" />
          </Button>
        )}
      </div>
    </div>
  );
}
