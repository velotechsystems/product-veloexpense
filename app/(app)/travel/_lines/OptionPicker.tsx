'use client';

import {
  Badge,
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@expenseos/design-system';
import { routeFromLegs } from '@expenseos/travel-lines';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { formatMinor } from '@/lib/format';
import { trpc } from '@/lib/trpc/client';
import { ARROW } from './summary';

/**
 * The flight and lodging pickers.
 *
 * Rendered by the row rather than from a strategy, because both need the request id, the
 * line id and two mutations — the same reason `MileageFields` is rendered directly on the
 * expense side. The strategy's job is to say which one to open.
 *
 * ## Searching SPENDS
 *
 * Every press consumes a SerpApi credit from a paid plan, which shapes the whole
 * component: the search is a button, never an effect. Nothing here searches on mount, on
 * a date change, or on re-render, and the underlying procedures are mutations
 * specifically so react-query cannot refetch them on window focus.
 *
 * ## Picking does not send a price
 *
 * A chosen option is sent as a `candidateId` and nothing else. The server re-reads the amount
 * from its own cache, so what is rendered here is display-only — a tampered price in the DOM
 * changes nothing. That is why a search caches its results before anything can be picked, and
 * why the mutation's input has no amount field.
 *
 * ## Nothing found is FOUR different answers
 *
 * "No plan", "no airports for this place", "no flights on this route" and "the provider
 * failed" have three different owners between them, and an empty list tells none of them
 * apart. Each gets its own sentence, and the amount field underneath stays live
 * throughout — an unpriceable route still has to reach an approver.
 */

const CABINS = ['ECONOMY', 'PREMIUM_ECONOMY', 'BUSINESS', 'FIRST'] as const;
const STOPS = ['0', '1', '2'] as const;
/** VeloExpense (w6-02): "any number of stops" as a Select value — Radix refuses ''. */
const ANY_STOPS = 'any';

type Currency = { code: string; symbol: string };

/** A cached candidate as the search hands it back. `amountMinor` is for DISPLAY — the
 *  write re-reads it from the cache. */
type Candidate = {
  candidateId: string;
  amountMinor: bigint | number | string;
  option: Record<string, unknown>;
};

type SearchOutcome = {
  options: Candidate[];
  found: number;
  insight: { level: string | null } | null;
  reason: string;
  providerFailure?: string;
};

/** Why nothing came back, as a sentence rather than an empty list. */
function useReasonText() {
  const t = useTranslations('travel');
  return (out: SearchOutcome | null): string | null => {
    if (!out || out.reason === 'ok') return null;
    if (out.reason === 'provider-error' && out.providerFailure) {
      return t(`quote.provider-${out.providerFailure}` as 'quote.provider-error');
    }
    return t(`quote.${out.reason}` as 'quote.no-plan');
  };
}

function OptionRow({
  candidate,
  currency,
  primary,
  secondary,
  onPick,
  disabled,
}: {
  candidate: Candidate;
  currency: Currency;
  primary: string;
  secondary: string | null;
  onPick(): void;
  disabled?: boolean;
}) {
  const t = useTranslations('travel');
  const locale = useLocale();
  return (
    <li className="flex items-center justify-between gap-3 border-border border-b py-2 last:border-0">
      <div className="min-w-0">
        <div className="truncate text-foreground text-sm">{primary}</div>
        {secondary && <div className="truncate text-muted-foreground text-xs">{secondary}</div>}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <span className="text-foreground text-sm tabular-nums">
          {formatMinor(Number(candidate.amountMinor), currency, locale)}
        </span>
        <Button size="sm" variant="outline" disabled={disabled} onClick={onPick}>
          {t('picker.choose')}
        </Button>
      </div>
    </li>
  );
}

/**
 * The shared shell: the search CONTROLS stay on the budget line; the RESULTS open in a
 * modal.
 *
 * The list used to unfold underneath the controls, inside the line's own block, and it
 * pushed everything below it down the drawer — with a dozen fares on screen the line
 * stopped looking like a line. Worse, it competed for the same narrow column as the
 * fields: a fare row wants a route, an airline, a flight number and a price, and none of
 * those fit beside a category picker.
 *
 * A modal is also what the interaction actually is. Searching spends a credit and picking
 * rewrites the amount — that is a decision with a beginning and an end, not a panel that
 * sits open while somebody edits the rest of the trip.
 *
 * It opens on ANY outcome, including the four different ways of finding nothing, because
 * those are the search's answer too: pressing Search and having the page not visibly
 * change is indistinguishable from the button not working.
 */
function PickerShell({
  title,
  controls,
  onSearch,
  searching,
  outcome,
  onClose,
  children,
}: {
  title: string;
  controls: React.ReactNode;
  onSearch(): void;
  searching: boolean;
  outcome: SearchOutcome | null;
  onClose(): void;
  children: React.ReactNode;
}) {
  const t = useTranslations('travel');
  const reasonText = useReasonText();
  const reason = reasonText(outcome);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-end gap-3">
        {controls}
        <Button
          size="sm"
          variant="outline"
          className="mb-1"
          disabled={searching}
          onClick={onSearch}
        >
          {searching ? t('picker.searching') : t('picker.search')}
        </Button>
      </div>
      {/* Named before the press, because it is a purchase. */}
      <span className="text-muted-foreground text-xs">{t('picker.costHint')}</span>

      <Dialog open={outcome !== null} onOpenChange={(o) => !o && onClose()}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
          </DialogHeader>
          {reason && (
            <p
              role="status"
              className="rounded border border-warning/40 bg-warning/10 px-3 py-2 text-foreground text-sm"
            >
              {reason}
            </p>
          )}
          {outcome && outcome.options.length > 0 && (
            <>
              {/* A truncated list SAYS it was truncated. Presenting twelve of sixty as
                  everything on offer would be a silent cap. */}
              {outcome.found > outcome.options.length && (
                <p className="text-muted-foreground text-xs">
                  {t('picker.truncated', { shown: outcome.options.length, found: outcome.found })}
                </p>
              )}
              <ul className="max-h-[60vh] overflow-y-auto rounded border border-border px-3">
                {children}
              </ul>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function LabelledField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-muted-foreground text-xs">{label}</span>
      {children}
    </div>
  );
}

export function FlightPicker({
  requestId,
  lineId,
  currency,
  tripType,
  disabled,
  onChosen,
  onError,
}: {
  requestId: string;
  lineId: string;
  currency: Currency;
  /** The request's own trip shape, as the default. Changing where or when somebody is
   *  flying is `update`'s job — a search with its own route would price a journey the
   *  request does not describe. */
  tripType: string;
  disabled?: boolean;
  onChosen(): void;
  onError(e: { message: string }): void;
}) {
  const t = useTranslations('travel');
  const [cabin, setCabin] = useState<(typeof CABINS)[number]>('ECONOMY');
  const [maxStops, setMaxStops] = useState<string>('');
  const [deepSearch, setDeepSearch] = useState(false);
  const [outcome, setOutcome] = useState<SearchOutcome | null>(null);

  const search = trpc.travelRequests.searchFlightOptions.useMutation({
    onSuccess: (res) => setOutcome(res as unknown as SearchOutcome),
    onError,
  });
  const choose = trpc.travelRequests.chooseLineOption.useMutation({
    onSuccess: () => {
      // The list goes once a pick lands: leaving eleven rival fares beside the chosen
      // one invites a second press that silently replaces it.
      setOutcome(null);
      onChosen();
    },
    onError,
  });

  return (
    <PickerShell
      title={t('picker.flightResults')}
      searching={search.isPending || disabled === true}
      outcome={outcome}
      onClose={() => setOutcome(null)}
      onSearch={() =>
        search.mutate({
          id: requestId,
          tripType: (tripType === 'ONE_WAY' ? 'ONE_WAY' : 'ROUND_TRIP') as 'ONE_WAY',
          travelClass: cabin,
          maxStops: maxStops === '' ? null : Number(maxStops),
          deepSearch,
        })
      }
      controls={
        <>
          <LabelledField label={t('picker.cabin')}>
            <Select
              value={cabin}
              disabled={disabled}
              onValueChange={(v) => v && setCabin(v as typeof cabin)}
            >
              <SelectTrigger aria-label={t('picker.cabin')} className="w-44">
                {/* VeloExpense (w6-02): the kit's Radix <SelectValue> renders the chosen
                    item's own label. */}
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CABINS.map((c) => (
                  <SelectItem key={c} value={c}>
                    {t(`picker.cabins.${c}` as 'picker.cabins.ECONOMY')}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </LabelledField>
          <LabelledField label={t('picker.stops')}>
            <Select
              // VeloExpense (w6-02): Radix refuses an item whose value is '' (it means "no
              // value" there), so "any" travels as a sentinel and is '' again in state.
              value={maxStops === '' ? ANY_STOPS : maxStops}
              disabled={disabled}
              onValueChange={(v) => setMaxStops(!v || v === ANY_STOPS ? '' : v)}
            >
              <SelectTrigger aria-label={t('picker.stops')} className="w-40">
                {/* VeloExpense (w6-02): the kit's Radix <SelectValue> renders the chosen
                    item's own label. */}
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ANY_STOPS}>{t('picker.stopsAny')}</SelectItem>
                {STOPS.map((s) => (
                  <SelectItem key={s} value={s}>
                    {t(`picker.stopsMax.${s}` as 'picker.stopsMax.0')}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </LabelledField>
          {/* Opt-in, because it is slower AND dearer. Worth it when an estimate is
              about to be submitted, wasteful while somebody is still choosing dates. */}
          {/* biome-ignore lint/a11y/noLabelWithoutControl: Checkbox is the control (child) */}
          <label className="flex items-center gap-2 pb-1 text-muted-foreground text-xs">
            <Checkbox
              checked={deepSearch}
              disabled={disabled}
              onCheckedChange={(v) => setDeepSearch(v === true)}
            />
            {t('picker.deepSearch')}
          </label>
        </>
      }
    >
      {(outcome?.options ?? []).map((c) => {
        const legs = Array.isArray(c.option.legs)
          ? (c.option.legs as Record<string, unknown>[])
          : [];
        /**
         * The whole path. `first.from → last.to` rendered a return fare as `YYZ → YYZ` —
         * accurate, and useless to somebody choosing between fares, because the one thing
         * they need from the row is where it goes.
         */
        const route = routeFromLegs(legs).join(ARROW);
        const airlines = Array.isArray(c.option.airlines) ? (c.option.airlines as string[]) : [];
        const stops = typeof c.option.stops === 'number' ? c.option.stops : 0;
        return (
          <OptionRow
            key={c.candidateId}
            candidate={c}
            currency={currency}
            disabled={choose.isPending}
            primary={`${route || '—'} · ${
              stops === 0 ? t('picker.nonstop') : t('picker.stopCount', { count: stops })
            }`}
            secondary={
              [
                airlines.join(', ') || null,
                legs
                  .map((l) => l.flightNumber)
                  .filter(Boolean)
                  .join(' · ') || null,
              ]
                .filter(Boolean)
                .join(' · ') || null
            }
            onPick={() => choose.mutate({ id: requestId, lineId, candidateId: c.candidateId })}
          />
        );
      })}
    </PickerShell>
  );
}

export function StayPicker({
  requestId,
  lineId,
  currency,
  departDate,
  returnDate,
  disabled,
  onChosen,
  onError,
}: {
  requestId: string;
  lineId: string;
  currency: Currency;
  departDate: string | Date;
  returnDate: string | Date | null;
  disabled?: boolean;
  onChosen(): void;
  onError(e: { message: string }): void;
}) {
  const t = useTranslations('travel');
  /** Defaulted from the TRIP's dates, in UTC — a stay is the nights between departure
   *  and return, and rendering those in the reader's zone shifts them a day for anyone
   *  west of Greenwich. */
  const iso = (d: string | Date | null) => (d ? new Date(d).toISOString().slice(0, 10) : '');
  const [checkIn, setCheckIn] = useState(iso(departDate));
  const [checkOut, setCheckOut] = useState(iso(returnDate) || iso(departDate));
  const [applyCap, setApplyCap] = useState(false);
  const [outcome, setOutcome] = useState<SearchOutcome | null>(null);

  const search = trpc.travelRequests.searchStayOptions.useMutation({
    onSuccess: (res) => setOutcome(res as unknown as SearchOutcome),
    onError,
  });
  const choose = trpc.travelRequests.chooseLineOption.useMutation({
    onSuccess: () => {
      setOutcome(null);
      onChosen();
    },
    onError,
  });

  const dateInput = (value: string, onChange: (v: string) => void, label: string) => (
    <LabelledField label={label}>
      <input
        aria-label={label}
        type="date"
        className="rounded border border-border bg-background px-2 py-1 text-foreground text-sm"
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      />
    </LabelledField>
  );

  return (
    <PickerShell
      title={t('picker.stayResults')}
      searching={search.isPending || disabled === true}
      outcome={outcome}
      onClose={() => setOutcome(null)}
      onSearch={() =>
        search.mutate({ id: requestId, checkIn, checkOut, applyCap, vacationRentals: false })
      }
      controls={
        <>
          {dateInput(checkIn, setCheckIn, t('picker.checkIn'))}
          {dateInput(checkOut, setCheckOut, t('picker.checkOut'))}
          {/* Off by default. A cap is a WARNING threshold on a quoted stay, and using it
              as a hard filter can hide every hotel in an expensive city — which reads as
              "no results" rather than "everything here is over policy". */}
          {/* biome-ignore lint/a11y/noLabelWithoutControl: Checkbox is the control (child) */}
          <label className="flex items-center gap-2 pb-1 text-muted-foreground text-xs">
            <Checkbox
              checked={applyCap}
              disabled={disabled}
              onCheckedChange={(v) => setApplyCap(v === true)}
            />
            {t('picker.applyCap')}
          </label>
        </>
      }
    >
      {(outcome?.options ?? []).map((c) => {
        const stars = typeof c.option.starClass === 'number' ? c.option.starClass : null;
        const rating = typeof c.option.rating === 'number' ? c.option.rating : null;
        return (
          <OptionRow
            key={c.candidateId}
            candidate={c}
            currency={currency}
            disabled={choose.isPending}
            primary={String(c.option.name ?? t('picker.unnamedStay'))}
            secondary={
              [
                stars != null ? t('picker.stars', { count: stars }) : null,
                rating != null ? t('picker.rating', { rating }) : null,
              ]
                .filter(Boolean)
                .join(' · ') || null
            }
            onPick={() => choose.mutate({ id: requestId, lineId, candidateId: c.candidateId })}
          />
        );
      })}
    </PickerShell>
  );
}

/** Rendered beside a chosen option's price, when the provider had an opinion about it.
 *  A fare of $612 means something different when the typical range is $400–$500 than
 *  when it is $600–$900. */
export function ConfidenceBadge({ level }: { level: string | null }) {
  const t = useTranslations('travel');
  if (!level) return null;
  const variant = level === 'low' ? 'success' : level === 'high' ? 'warning' : 'secondary';
  return <Badge variant={variant}>{t(`picker.level.${level}` as 'picker.level.low')}</Badge>;
}
