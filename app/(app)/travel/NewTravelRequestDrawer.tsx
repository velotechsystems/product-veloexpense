'use client';

/**
 * New travel request — the trip AND its planned budget, in one act.
 *
 * The traveller supplies a purpose, a destination, dates, and the items they intend to
 * spend on. Everything with a number on it is still the server's to compute: a row may
 * carry a typed amount, but a blank one is derived from the category, and the browser
 * never posts a total. The prototype in archive/ asked the form to post the budget itself,
 * which is how the approved amount became whatever the browser felt like sending.
 *
 * The budget used to be unreachable here: the form posted the trip alone, so composing a
 * request meant saving it, waiting for the drawer to reopen on the saved record, and only
 * then adding what it was for. Two screens and a round trip for one act.
 *
 * A right-hand DRAWER, not a centred dialog — the same surface the rest of the platform
 * creates and edits in, and specifically the same one `TravelRequestDrawer` beside this file
 * uses to show a request once it exists. A modal that interrupts the page to collect six fields
 * is a different interaction from the one every other record uses, for no reason a traveller
 * could name.
 */

import {
  Button,
  Checkbox,
  Drawer,
  DrawerBody,
  DrawerContent,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  Field as FormField,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
} from '@expenseos/design-system';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { trpc } from '@/lib/trpc/client';
import { CityPicker, type CityValue, EMPTY_CITY } from './CityPicker';
import {
  type DraftBudgetLine,
  DraftBudgetLines,
  type DraftTrip,
  draftLineAmount,
  draftLineNeedsNote,
} from './DraftBudgetLines';

const TRIP_TYPES = ['ROUND_TRIP', 'ONE_WAY'] as const;

/** A date input gives 'YYYY-MM-DD'; the API takes an ISO instant. Midnight UTC,
 *  because a trip is a range of calendar dates and the server budgets it in UTC —
 *  attaching the browser's offset here would shift a departure across midnight for
 *  anyone west of Greenwich. */
function toInstant(date: string): string | null {
  return date ? `${date}T00:00:00.000Z` : null;
}

export function NewTravelRequestDrawer({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const t = useTranslations('travel');
  const options = trpc.travelRequests.formOptions.useQuery();

  const [purpose, setPurpose] = useState('');
  const [notes, setNotes] = useState('');
  const [destination, setDestination] = useState<CityValue>(EMPTY_CITY);
  const [origin, setOrigin] = useState<CityValue>(EMPTY_CITY);
  const [tripType, setTripType] = useState<(typeof TRIP_TYPES)[number]>('ROUND_TRIP');
  const [departDate, setDepartDate] = useState('');
  const [returnDate, setReturnDate] = useState('');
  const [includeCar, setIncludeCar] = useState(false);
  const [currencyId, setCurrencyId] = useState<string>('');
  const [lines, setLines] = useState<DraftBudgetLine[]>([]);
  const [error, setError] = useState<string | null>(null);

  const categories = trpc.travelRequests.categories.useQuery();

  const currency = currencyId || options.data?.defaultCurrencyId || '';
  const create = trpc.travelRequests.create.useMutation({
    onSuccess: () => {
      onCreated();
      onClose();
    },
    onError: (e) => setError(e.message),
  });

  // Mirrored from the server's own check so the traveller is told before a round
  // trip goes anywhere. The server still enforces it — this is a courtesy, not the
  // rule.
  const dateProblem =
    tripType === 'ROUND_TRIP' && departDate && !returnDate
      ? t('errors.roundTripNeedsReturn')
      : returnDate && departDate && returnDate < departDate
        ? t('errors.returnBeforeDepart')
        : null;

  const currencyCode =
    (options.data?.currencies ?? []).find((c) => c.id === currency)?.code ?? 'CAD';
  const currencySymbol =
    (options.data?.currencies ?? []).find((c) => c.id === currency)?.symbol ?? '$';

  /**
   * A budget row counts only once it names a category.
   *
   * A blank row is somebody who pressed Add and has not chosen yet, not an item — posting
   * it would be refused by the server for a category that is not a uuid, which is a
   * confusing way to learn you left a row empty. Dropped silently on submit; the guard
   * below is what stops Submit while a row is half-written.
   */
  const budgetLines = lines.filter((l) => l.categoryId);
  const blankRow = lines.some((l) => !l.categoryId);
  /**
   * A row that overrides a policy-derived amount without saying why.
   *
   * The server refuses exactly this — "Raising a policy-derived amount needs a reason" —
   * and used to be the first place the traveller heard of it, as a banner over a drawer
   * that had let them press Create. The row says it now, and the button waits; the server
   * rule stands unchanged behind it.
   */
  const unexplainedOverride = budgetLines.some((l) => draftLineNeedsNote(l, currencyCode));

  const ready =
    purpose.trim().length >= 3 &&
    destination.label.trim() &&
    departDate &&
    currency &&
    !dateProblem &&
    !blankRow &&
    !unexplainedOverride;

  /**
   * The trip as the rows should price themselves against it — the same fields, in the
   * same shape, that `create` is about to send, so a figure previewed here is the figure
   * the save derives. `ready` withholds the preview while the dates are incoherent.
   */
  const trip: DraftTrip = {
    destinationCity: destination.city ?? (destination.label.trim() || null),
    departDate: toInstant(departDate),
    returnDate: tripType === 'ONE_WAY' ? null : toInstant(returnDate),
    currencyId: currency,
    ready: !!departDate && !dateProblem && (tripType === 'ONE_WAY' || !!returnDate),
  };

  return (
    <Drawer open onOpenChange={(o) => !o && onClose()}>
      {/*
        Half the viewport, and the same width as the request's own drawer — creating one
        and then viewing it must not resize the panel under the reader.

        `width` rather than a `max-w-*` class: the drawer sets its width as an INLINE
        style, and an inline style beats a class, so `className="w-full max-w-2xl"` was a
        480px panel with a cap it never reached. `max-w-full` keeps it on screen.

        Both min-widths below are load-bearing; neither is decoration. `min-width` is
        resolved after `width` and `max-width` (CSS 2.1 §10.4), so a min-width class is the
        only thing in this file that can beat that inline style:
          - below `md` (<768px), `min-w-full` overrides the 50vw inline width — without it
            a 360px phone lays out a 180px panel, half a screen of nothing;
          - from `md` up, `md:min-w-[42rem]` is the narrow-laptop floor. It is scoped at `md`
            and not `sm` because 42rem is 672px and a 640px `sm` viewport cannot hold it.
            Unscoped — as it was — min-width also beats `max-w-full`, so that floor forced a
            672px panel onto every phone: 312px painted off the LEFT of the screen at 360px.
      */}
      <DrawerContent width="50vw" className="min-w-full max-w-full md:min-w-[42rem]">
        <DrawerHeader>
          <DrawerTitle>{t('new')}</DrawerTitle>
        </DrawerHeader>

        <DrawerBody className="flex flex-col gap-3">
          {(error || dateProblem) && (
            <p className="rounded bg-destructive/10 px-3 py-2 text-destructive text-sm">
              {error ?? dateProblem}
            </p>
          )}

          <FormField label={t('form.purpose')}>
            <Textarea
              rows={2}
              value={purpose}
              placeholder={t('form.purposePlaceholder')}
              onChange={(e) => setPurpose(e.target.value)}
            />
          </FormField>

          <FormField label={t('form.destination')}>
            <CityPicker
              value={destination}
              onChange={setDestination}
              available={options.data?.placeLookup ?? false}
              placeholder={t('form.searchCity')}
            />
          </FormField>

          <FormField label={t('form.origin')}>
            <CityPicker
              value={origin}
              onChange={setOrigin}
              available={options.data?.placeLookup ?? false}
              placeholder={t('form.searchCity')}
            />
          </FormField>

          {/* One column below `sm`. Three 205px cells fit a 640px+ panel; at 360px they
              are 109px each, which is under the intrinsic width of a `date` input's own
              control and forces the row wider than the (now full-width) drawer. */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <FormField label={t('form.tripType')}>
              <Select value={tripType} onValueChange={(v) => setTripType(v as typeof tripType)}>
                <SelectTrigger>
                  {/**
                   * A render child, not a bare `<SelectValue />`.
                   *
                   * base-ui's Select.Value shows the raw VALUE when given no child, and the
                   * value here is the enum member — so the field read `ROUND_TRIP` where it
                   * should say "Round trip", in English and in French alike. Every other
                   * Select in the app already passes a function; these two did not.
                   */}
                  {/* VeloExpense (w6-02): the kit's Radix <SelectValue> renders the chosen
                      item's own label ("Round trip"), never the raw value. */}
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TRIP_TYPES.map((k) => (
                    <SelectItem key={k} value={k}>
                      {t(`tripType.${k}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
            <FormField label={t('form.departDate')}>
              <Input
                type="date"
                value={departDate}
                onChange={(e) => setDepartDate(e.target.value)}
              />
            </FormField>
            <FormField label={t('form.returnDate')}>
              <Input
                type="date"
                value={returnDate}
                min={departDate || undefined}
                disabled={tripType === 'ONE_WAY'}
                onChange={(e) => setReturnDate(e.target.value)}
              />
            </FormField>
          </div>

          <div className="grid grid-cols-1 items-end gap-3 sm:grid-cols-2">
            <FormField label={t('form.currency')}>
              <Select value={currency} onValueChange={(v) => setCurrencyId(v ?? '')}>
                <SelectTrigger>
                  {/**
                   * Same again, and worse here: the value is a UUID, so the field showed
                   * `01a038c5-66df-7164-a50e-47a5f3148699` where it should say "CAD ($)".
                   * Resolved against the loaded list, and empty until that arrives rather
                   * than briefly flashing the id.
                   */}
                  {/* VeloExpense (w6-02): the kit's Radix <SelectValue> renders the chosen
                      item's own label ("CAD ($)"); empty until the list arrives. */}
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(options.data?.currencies ?? []).map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.code} ({c.symbol})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
            {/* biome-ignore lint/a11y/noLabelWithoutControl: Checkbox is the control (child) */}
            <label className="flex items-center gap-2 pb-2 text-sm">
              <Checkbox checked={includeCar} onCheckedChange={(v) => setIncludeCar(v === true)} />
              {t('form.includeCar')}
            </label>
          </div>

          <FormField label={t('form.notes')}>
            <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </FormField>

          <section className="mt-2 border-border border-t pt-3">
            <h3 className="mb-2 font-medium text-foreground text-sm">{t('detail.budget')}</h3>
            <DraftBudgetLines
              lines={lines}
              onChange={setLines}
              categories={categories.data?.items ?? []}
              currencySymbol={currencySymbol}
              currencyCode={currencyCode}
              trip={trip}
              disabled={create.isPending}
            />
          </section>
        </DrawerBody>

        <DrawerFooter>
          <Button variant="ghost" onClick={onClose}>
            {t('form.cancel')}
          </Button>
          <Button
            disabled={!ready || create.isPending}
            onClick={() => {
              setError(null);
              create.mutate({
                purpose: purpose.trim(),
                notes: notes.trim() || null,
                destination: {
                  placeId: destination.placeId,
                  label: destination.label.trim(),
                  city: destination.city,
                  country: destination.country,
                },
                origin: {
                  placeId: origin.placeId,
                  label: origin.label.trim(),
                  city: origin.city,
                  country: origin.country,
                },
                tripType,
                // Non-null: `ready` requires it.
                departDate: toInstant(departDate) as string,
                returnDate: tripType === 'ONE_WAY' ? null : toInstant(returnDate),
                includeCar,
                currencyId: currency,
                /**
                 * Only the rows that name a category, and only an amount somebody actually
                 * TYPED. The populated figure is the server's own derivation shown early;
                 * left alone it is omitted, and the server derives it again on save — so
                 * the line lands as PER_DIEM, not as a typed copy of it. A figure typed
                 * over it goes as the override it is. A zero is never sent: it would land
                 * as a MANUAL zero and suppress the derivation.
                 */
                lines: budgetLines.map((l) => {
                  const { amountMinor } = draftLineAmount(l, currencyCode);
                  return {
                    categoryId: l.categoryId,
                    ...(amountMinor != null ? { amountMinor } : {}),
                    // The kind's own fields, when the kind has any that can be typed
                    // before the line exists — a meal's attendees, a car's or a taxi's
                    // days × daily cap. The server validates it against the CATEGORY's
                    // kind and prices from it, the same as it would on a saved request.
                    ...(l.payload ? { payload: l.payload } : {}),
                    notes: l.notes.trim() || null,
                  };
                }),
              });
            }}
          >
            {create.isPending ? t('form.saving') : t('form.submit')}
          </Button>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}
