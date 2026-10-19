'use client';

import { Button, Checkbox, Input } from '@expenseos/design-system';
// VeloExpense (w6-02): the vendored kit does not re-export `IconTrash`; it is Tabler's icon,
// imported from Tabler as the expense screens do.
import { IconPlus, IconTrash } from '@tabler/icons-react';
import { useTranslations } from 'next-intl';
import { useRef, useState } from 'react';

/**
 * A meal with people at it, priced per head.
 *
 * The field that makes this a KIND rather than a typed amount is `occurrencesPerDay`: a
 * team eating together twice a day for four days is sixteen covers at the allowance, and
 * nobody should be doing that multiplication in their head into a single box. The block
 * captures the four facts and the server does the arithmetic — one implementation of it,
 * in `@expenseos/travel-lines`, so two callers cannot disagree.
 *
 * Attendees are a flat snapshot: a name, an optional company, and whether they are
 * outside the org. No FK to `User`, exactly as `ExpenseAttendee` has always worked —
 * a client guest is not a user and never will be.
 *
 * ## The rate is SHOWN, not guessed at
 *
 * The per-person box used to be blank, meaning "use whatever the server resolves". A
 * traveller looking at a total had three of the four numbers that made it and no way to
 * check the fourth — and no way to tell an allowance they should question from one they
 * should not. It is pre-filled with the allowance the server resolved for this category
 * on this trip, and typing over it is the override.
 *
 * ## When it writes
 *
 * On BLUR, not on Apply and not per keystroke. Adding a person and tabbing away re-prices
 * the line, which is what "as you add, the amount changes" has to mean — while a write per
 * letter would post a partly-typed attendee list on every keystroke, and each write
 * re-prices.
 */

export interface AttendeeDraft {
  name: string;
  company: string;
  isExternal: boolean;
}

/**
 * A row with a stable local key.
 *
 * Not an index. Removing the first of three re-keys the two below it, React reuses the
 * DOM nodes, and whatever was focused jumps to a different person's name — which is the
 * concrete bug `noArrayIndexKey` exists to catch, not a lint formality. The id is
 * client-only and never sent.
 */
type Row = AttendeeDraft & { key: number };

export function AttendeesBlock({
  initial,
  currencySymbol,
  perDiemRateMinor,
  disabled,
  onApply,
}: {
  initial: {
    attendees: AttendeeDraft[];
    occurrencesPerDay: number;
    days: number;
    /** What this line already stores, when somebody has typed one. */
    ratePerPersonMinor?: string | null;
  };
  currencySymbol: string;
  /** The allowance the server resolved for this category on this trip, per person per
   *  occurrence. Null when no rate covers the destination and the traveller's tier. */
  perDiemRateMinor?: string | null;
  disabled?: boolean;
  onApply(payload: Record<string, unknown>): void;
}) {
  const t = useTranslations('travel');
  const nextKey = useRef(0);
  const [attendees, setAttendees] = useState<Row[]>(() =>
    initial.attendees.map((a) => ({ ...a, key: nextKey.current++ })),
  );
  const [occurrences, setOccurrences] = useState(String(initial.occurrencesPerDay || 1));
  const [days, setDays] = useState(String(initial.days || 1));
  /**
   * The per-person allowance, in major units.
   *
   * Seeded from what the line already stores, and failing that from the per-diem rate the
   * server resolved — the point of showing it is that the multiplication on screen is
   * checkable. Blank only when there is no rate at all, which still means "let the server
   * resolve it".
   */
  const majorOf = (minor: string | null | undefined) => {
    if (!minor) return '';
    const n = Number(minor);
    return Number.isFinite(n) ? (n / 100).toFixed(2) : '';
  };
  const [rate, setRate] = useState(() =>
    majorOf(initial.ratePerPersonMinor ?? perDiemRateMinor ?? null),
  );
  /**
   * Fill the box once the resolved rate ARRIVES, if nobody has typed anything.
   *
   * It is fetched, so the first render of a fresh line has no rate to show. Seeding only
   * in `useState` would leave that line permanently blank; overwriting a typed value would
   * throw away an override the moment the query settled.
   */
  const seededRate = useRef(perDiemRateMinor ?? null);
  if (seededRate.current !== (perDiemRateMinor ?? null)) {
    seededRate.current = perDiemRateMinor ?? null;
    if (!rate.trim() && !initial.ratePerPersonMinor) setRate(majorOf(perDiemRateMinor));
  }

  const setAt = (key: number, patch: Partial<AttendeeDraft>) =>
    setAttendees((a) => a.map((x) => (x.key === key ? { ...x, ...patch } : x)));

  const named = attendees.filter((a) => a.name.trim().length > 0);
  const covers =
    named.length * (Number.parseInt(occurrences, 10) || 0) * (Number.parseInt(days, 10) || 0);

  /** Written on blur, so adding a person and tabbing away re-prices the line. */
  const apply = () => applyWith(attendees);

  const applyWith = (rows: Row[]) => {
    const namedRows = rows.filter((a) => a.name.trim().length > 0);
    const rateMinor = (() => {
      const trimmed = rate.trim();
      if (!trimmed) return null;
      const n = Number.parseFloat(trimmed);
      return Number.isFinite(n) && n >= 0 ? Math.round(n * 100).toString() : null;
    })();
    onApply({
      // Only the NAMED ones. A half-typed row would otherwise count as a head and
      // inflate the estimate by one person's allowance.
      attendees: namedRows.map((a) => ({
        name: a.name.trim(),
        company: a.company.trim() || null,
        isExternal: a.isExternal,
      })),
      occurrencesPerDay: Number.parseInt(occurrences, 10) || 0,
      days: Number.parseInt(days, 10) || 0,
      ratePerPersonMinor: rateMinor,
    });
  };

  const numberField = (
    label: string,
    value: string,
    onChange: (v: string) => void,
    max: string,
  ) => (
    <div className="flex flex-col gap-1">
      <span className="text-muted-foreground text-xs">{label}</span>
      <input
        aria-label={label}
        type="number"
        min="0"
        max={max}
        step="1"
        inputMode="numeric"
        className="w-20 rounded border border-border bg-background px-2 py-1 text-foreground text-sm"
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        onBlur={apply}
      />
    </div>
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2">
        <span className="text-muted-foreground text-xs">{t('attendees.heading')}</span>
        {attendees.length === 0 && (
          <p className="text-muted-foreground text-xs">{t('attendees.none')}</p>
        )}
        {attendees.map((a) => (
          <div key={a.key} className="flex flex-wrap items-center gap-2">
            <Input
              aria-label={t('attendees.name')}
              className="w-40"
              placeholder={t('attendees.name')}
              value={a.name}
              disabled={disabled}
              onChange={(e) => setAt(a.key, { name: e.target.value })}
              onBlur={apply}
            />
            <Input
              aria-label={t('attendees.company')}
              className="w-40"
              placeholder={t('attendees.company')}
              value={a.company}
              disabled={disabled}
              onChange={(e) => setAt(a.key, { company: e.target.value })}
              onBlur={apply}
            />
            {/* biome-ignore lint/a11y/noLabelWithoutControl: Checkbox is the control (child) */}
            <label className="flex items-center gap-1.5 text-muted-foreground text-xs">
              <Checkbox
                checked={a.isExternal}
                disabled={disabled}
                onCheckedChange={(v) => setAt(a.key, { isExternal: v === true })}
              />
              {t('attendees.external')}
            </label>
            <Button
              size="sm"
              variant="ghost"
              aria-label={t('attendees.remove')}
              disabled={disabled}
              onClick={() => {
                const next = attendees.filter((x) => x.key !== a.key);
                setAttendees(next);
                // Re-priced immediately: a head that left the meal changes the total, and
                // there is no field to blur out of.
                applyWith(next);
              }}
            >
              <IconTrash className="h-4 w-4" />
            </Button>
          </div>
        ))}
        <Button
          size="sm"
          variant="outline"
          className="self-start"
          disabled={disabled}
          onClick={() =>
            setAttendees((list) => [
              ...list,
              { name: '', company: '', isExternal: false, key: nextKey.current++ },
            ])
          }
        >
          <IconPlus size={12} className="mr-1" />
          {t('attendees.add')}
        </Button>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        {numberField(t('attendees.occurrencesPerDay'), occurrences, setOccurrences, '24')}
        {numberField(t('attendees.days'), days, setDays, '366')}
        {/* The head count, DERIVED and read-only: it is the named attendees above, and a
            second place to type it would let the two disagree about who is going. */}
        <div className="flex flex-col gap-1">
          <span className="text-muted-foreground text-xs">{t('attendees.people')}</span>
          <output className="w-16 rounded border border-border bg-muted/40 px-2 py-1 text-foreground text-sm tabular-nums">
            {named.length}
          </output>
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-muted-foreground text-xs">{t('attendees.ratePerPerson')}</span>
          <Input
            aria-label={t('attendees.ratePerPerson')}
            type="number"
            min="0"
            step="0.01"
            inputMode="decimal"
            prefix={currencySymbol}
            className="w-28"
            placeholder={t('attendees.ratePlaceholder')}
            value={rate}
            disabled={disabled}
            onChange={(e) => setRate(e.target.value)}
            onBlur={apply}
          />
        </div>
      </div>

      {/* The multiplication, spelled out. This is the whole reason the kind exists —
          a traveller can see that three people twice a day for four days is 24 covers
          rather than having to trust a total. */}
      <p className="text-muted-foreground text-xs">
        {t('attendees.covers', { heads: named.length, covers })}
      </p>
    </div>
  );
}
