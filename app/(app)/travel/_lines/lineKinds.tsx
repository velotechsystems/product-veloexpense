'use client';

import type { TravelLineKindName } from '@expenseos/travel-lines';
import type { ComponentType } from 'react';

/**
 * Which fields a travel line's block offers, chosen by strategy rather than by an
 * `if (kind === 'CAR_RENTAL')`.
 *
 * The same shape as `expenses/_workbench/lineKinds.tsx`, and for the same reason. That
 * file records what the boolean branch cost on the expense side: `STANDARD_WITH_TIP`
 * existed as a kind, was written by extraction, and had no UI at all — so a tip lifted
 * off a receipt changed the taxable base where nobody could see or correct it.
 *
 * ## The UI does NOT decide the kind
 *
 * `TravelCategory.lineKind` does, and the server reads it off the category on every
 * write. A strategy only declares which FIELDS to offer for a kind the server has
 * already chosen — it cannot change what a line is, only what can be typed into it.
 *
 * That is a simpler contract than the expense side's, where the kind was derived from
 * two booleans and could disagree with the stored value. Here the risk is different and
 * `lineKinds.test.tsx` is aimed at it: a kind added to the enum with no strategy falls
 * back to `standard` SILENTLY, so a car-rental line would render a bare amount box and
 * never send the days or the cap it is priced from. The test asserts every kind in
 * `TRAVEL_LINE_KINDS` has one.
 *
 * ## What is not here yet
 *
 * AIRFARE, LODGING and DEPARTMENT_MEAL currently offer the amount field only. That is
 * not a placeholder: it is the documented fallback for an org with no provider
 * configured, where typing the fare is the only thing anybody can do. Their pickers and
 * the attendee editor arrive on top of this, and the amount stays underneath as the
 * override.
 */

/**
 * A block's local draft.
 *
 * Every value is a STRING until it is sent. Parsing per keystroke turns "12." into 12
 * and then fights the person trying to type "12.50" — the same reason the expense
 * editor's draft holds strings.
 */
export interface TravelLineDraft {
  amount: string;
  days: string;
  dailyCap: string;
  note: string;
}

export const EMPTY_DRAFT: TravelLineDraft = { amount: '', days: '', dailyCap: '', note: '' };

export interface TravelLineFieldsProps {
  draft: TravelLineDraft;
  disabled?: boolean;
  onChange(patch: Partial<TravelLineDraft>): void;
  currencySymbol: string;
  /** Localized, passed in so this module needs no i18n hook of its own — the same
   *  arrangement the expense registry uses. */
  labels: {
    days: string;
    dailyCap: string;
    capHint: string;
    noLiveRate: string;
  };
}

export interface TravelLineStrategy {
  kind: TravelLineKindName;
  /** Extra fields beside the amount. Omitted when the kind needs none. */
  Fields?: ComponentType<TravelLineFieldsProps>;
  /**
   * Draft fields to clear when a row leaves this strategy.
   *
   * Declared rather than hand-coded per branch: a typed amount is not a day count and a
   * daily cap is not a fare, so crossing between kinds has to invalidate both sides.
   * Getting it wrong leaves a stale figure the server will disagree with.
   */
  clearsOnExit: readonly (keyof TravelLineDraft)[];
  /**
   * The payload this block sends, or null when it has nothing kind-specific to send.
   *
   * A PROPOSAL. The server validates it against the category's kind and derives the
   * amount from it — the block never computes the figure it displays as authoritative.
   */
  buildPayload?(draft: TravelLineDraft): Record<string, unknown> | null;
  /**
   * A provider-backed picker this kind opens, rendered by the ROW rather than from here.
   *
   * The same split `MileageFields` makes on the expense side, and for the same reason:
   * a picker needs the request id, the line id and three mutations, which are the row's
   * concerns rather than a strategy's. The strategy exists to SELECT it and to declare
   * what switching away has to clear.
   */
  picker?: 'FLIGHT' | 'STAY';
  /**
   * Whether this kind captures attendees. Rendered by the row for the same reason a
   * picker is: the editor holds a draft list and needs the stored payload to seed it,
   * which is state a strategy has no business owning.
   */
  attendees?: boolean;
}

/**
 * Days × a daily cap: the shape a rental car and a ground leg share.
 *
 * Both are priced this way for the same reason — no provider on the travel integration
 * sells either, so a policy ceiling multiplied by the days of the trip is the only
 * honest figure available. The block says so rather than leaving a number that looks
 * like a market price.
 */
function CapTimesDaysFields({
  draft,
  disabled,
  onChange,
  currencySymbol,
  labels,
}: TravelLineFieldsProps) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-muted-foreground text-xs">
          {labels.days}
          <input
            aria-label={labels.days}
            type="number"
            min="0"
            step="1"
            inputMode="numeric"
            className="w-20 rounded border border-border bg-background px-2 py-1 text-foreground text-sm"
            value={draft.days}
            disabled={disabled}
            onChange={(e) => onChange({ days: e.target.value })}
          />
        </label>
        <label className="flex flex-col gap-1 text-muted-foreground text-xs" title={labels.capHint}>
          {labels.dailyCap}
          <span className="flex items-center gap-1">
            <span aria-hidden="true">{currencySymbol}</span>
            <input
              aria-label={labels.dailyCap}
              type="number"
              min="0"
              step="0.01"
              inputMode="decimal"
              className="w-24 rounded border border-border bg-background px-2 py-1 text-foreground text-sm"
              placeholder="0.00"
              value={draft.dailyCap}
              disabled={disabled}
              onChange={(e) => onChange({ dailyCap: e.target.value })}
            />
          </span>
        </label>
      </div>
      {/* Said plainly. An approver reading a figure is entitled to know nobody sold it
          at that price. */}
      <p className="text-muted-foreground text-xs">{labels.noLiveRate}</p>
    </div>
  );
}

/** Digits only, from a `<input type="number">` that hands back a string. Anything
 *  unparseable becomes 0 rather than NaN, which would reach the server as a payload the
 *  registry refuses. */
function intOf(v: string): number {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/** Major units → the digit string the payload registry takes. Empty when there is
 *  nothing to send, so an untouched field does not become "0". */
function minorStringOf(v: string): string | null {
  const trimmed = v.trim();
  if (!trimmed) return null;
  const n = Number.parseFloat(trimmed);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100).toString();
}

const capTimesDays = (kind: TravelLineKindName): TravelLineStrategy => ({
  kind,
  Fields: CapTimesDaysFields,
  clearsOnExit: ['days', 'dailyCap'],
  buildPayload: (draft) => {
    const dailyCapMinor = minorStringOf(draft.dailyCap);
    const days = intOf(draft.days);
    if (dailyCapMinor == null && days === 0) return null;
    return kind === 'CAR_RENTAL'
      ? { days, dailyCapMinor }
      : // GROUND takes a note where a car takes dates: nobody plans the calendar of
        // their airport taxis.
        { days, dailyCapMinor, note: draft.note.trim() || null };
  },
});

/**
 * The fallback: an amount and nothing else.
 *
 * Still what a kind with a picker falls back TO. An org with no provider configured gets
 * exactly this, and typing the fare is not a degraded mode — it is the only thing anybody
 * can do, so the amount field stays underneath the picker rather than being replaced by it.
 */
const amountOnly = (kind: TravelLineKindName): TravelLineStrategy => ({
  kind,
  clearsOnExit: [],
});

/** A kind priced from a provider search. The picker is rendered by the row; the amount
 *  field stays beneath it as the override and as the no-provider path. */
const provider = (kind: TravelLineKindName, picker: 'FLIGHT' | 'STAY'): TravelLineStrategy => ({
  kind,
  picker,
  clearsOnExit: [],
});

/**
 * Every kind, with the block it opens. Keyed rather than ordered, because a travel
 * line's kind is a single stored value — there is no first-match-wins question to
 * answer, which is the one way this differs from the expense registry.
 */
export const TRAVEL_LINE_STRATEGIES: Record<TravelLineKindName, TravelLineStrategy> = {
  STANDARD: amountOnly('STANDARD'),
  AIRFARE: provider('AIRFARE', 'FLIGHT'),
  LODGING: provider('LODGING', 'STAY'),
  DEPARTMENT_MEAL: { kind: 'DEPARTMENT_MEAL', attendees: true, clearsOnExit: [] },
  CAR_RENTAL: capTimesDays('CAR_RENTAL'),
  GROUND: capTimesDays('GROUND'),
};

/** The strategy for a kind. Never null for a kind the enum knows; an unrecognised one
 *  falls back to the amount box, which is the safe direction — a traveller can always
 *  type a figure. */
export function strategyFor(kind: string | null | undefined): TravelLineStrategy {
  return TRAVEL_LINE_STRATEGIES[kind as TravelLineKindName] ?? TRAVEL_LINE_STRATEGIES.STANDARD;
}

/**
 * Fields to clear when a row moves between two kinds.
 *
 * Empty when the strategy does not change, which is what keeps an edit within one kind
 * from wiping what has been typed. Both sides contribute: leaving a car must drop the
 * day count, and arriving at one must drop a typed amount that was priced some other way.
 */
export function fieldsToClear(
  from: string | null | undefined,
  to: string | null | undefined,
): readonly (keyof TravelLineDraft)[] {
  const before = strategyFor(from);
  const after = strategyFor(to);
  if (before.kind === after.kind) return [];
  return [...new Set([...before.clearsOnExit, ...after.clearsOnExit, 'amount' as const])];
}
