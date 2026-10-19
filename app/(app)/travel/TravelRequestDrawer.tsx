'use client';

/**
 * One travel request, opened.
 *
 * The budget table is the substance, and every line states its BASIS. A flight
 * priced from a live quote and a car priced from a policy ceiling are both "budget"
 * and are not equally trustworthy — an approver deciding on a total is entitled to
 * know which parts are market prices and which are maximums. A budget that hides its
 * own provenance is how a bad trip gets waved through on a plausible-looking number.
 *
 * Two things the budget is NOT allowed to do:
 *
 *   · **cover only what a provider can price.** Flights and stays are the two things
 *     SerpApi quotes; a trip also has a conference fee, a department dinner and — for
 *     want of any engine that sells them — a rental car. Those go in as PLANNED items
 *     against an expense category, so what an approver authorises is the trip rather
 *     than the priceable part of it.
 *   · **block the submission.** The budget used to gate `Submit for approval`
 *     outright, which turned "we could not price this destination" into "you may not
 *     ask". It is a warning now: the panel says what is missing and the press still
 *     works, because a traveller with an unpriceable destination still has to reach
 *     an approver.
 */

import {
  Button,
  Drawer,
  DrawerBody,
  DrawerContent,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  Field as FormField,
  IconPlus,
  Input,
  Textarea,
} from '@expenseos/design-system';
import type { inferRouterOutputs } from '@trpc/server';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { CommentThread } from '@/components/comments/CommentThread';
import { displayName, formatMinor, pickText } from '@/lib/format';
// VeloExpense (w6-02): the shared `currency` table has no symbol column, so the request
// carries its code and the symbol is the platform's (`Intl`, pure — safe in the browser).
import { currencySymbol } from '@/server/lib/currencySymbol';
import { trpc } from '@/lib/trpc/client';
import type { AppRouter } from '@/server/routers/_app';
import { LineBlock } from './_lines/LineBlock';
import { PlannedLineDraft } from './_lines/PlannedLineDraft';
import { ViolationList } from './_lines/ViolationList';

/** A local identity for an unsaved row. Not an index: discarding the first of three
 *  re-keys the two below it, React reuses the DOM nodes, and the caret jumps rows. */
function newDraftKey(): string {
  return `d-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

type Outputs = inferRouterOutputs<AppRouter>;
export type TravelRequestItem = Outputs['travelRequests']['listOwn']['items'][number];

// The basis badge and the per-line chrome moved to `_lines/LineBlock`.

/**
 * A workflow step's name, for a reader rather than for the engine.
 *
 * A task's `label` comes from its graph node, and the seeded graphs give their approval
 * nodes none — so the raw NODE TYPE arrived on screen and the Approvals section read
 * "approval  — · PENDING" (GA audit v2, V2-09). Worse in /fr-CA: neither token is in the
 * message catalogue, so the heading translated and these did not, and a translation
 * review passes while a French user still reads English (V2-23).
 *
 * The rule is "a bare node key is not a label", not "replace every label" — a workflow
 * author who typed "Manager approval" gets exactly that back. A key is recognised by
 * being one of the known node types; anything else is somebody's words and survives.
 */
const NODE_TYPES = new Set([
  'approval',
  'acknowledge',
  'action',
  'notify',
  'parallel',
  'switch',
  'callWorkflow',
]);

function stepLabel(label: string | null, t: (k: string) => string): string {
  // A task can carry no label at all, and the row then rendered an empty cell beside a
  // status — which reads as a missing step rather than an unnamed one.
  if (!label) return t('nodeLabel.step');
  return NODE_TYPES.has(label) ? t(`nodeLabel.${label}`) : label;
}

export function TravelRequestDrawer({
  request,
  taskId,
  onClose,
  onChanged,
}: {
  request: TravelRequestItem;
  /** Present when the viewer has a pending approval task on this request. */
  taskId?: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const t = useTranslations('travel');
  const locale = useLocale();
  const router = useRouter();
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  /**
   * Budget lines that do not exist yet — one per press of "Add a planned budget item".
   *
   * A list rather than a single flag, because somebody adding three items should not have
   * to wait for each to save before starting the next. Keyed by a local id: an index would
   * hand a discarded row's caret to the one below it.
   */
  const [drafts, setDrafts] = useState<string[]>([]);
  /** The server's refusal, per draft. Kept ON the row so it is beside the thing to fix. */
  const [draftErrors, setDraftErrors] = useState<Record<string, string>>({});
  // The trip-header edit form. Opened on demand rather than always-on: the header is
  // read far more often than it is changed, and six live inputs above the budget make
  // the thing an approver came to read harder to find.
  const [editingTrip, setEditingTrip] = useState(false);
  const [tripPurpose, setTripPurpose] = useState('');
  const [tripNotes, setTripNotes] = useState('');
  const [tripDepart, setTripDepart] = useState('');
  const [tripReturn, setTripReturn] = useState('');

  const timeline = trpc.travelRequests.timeline.useQuery({ id: request.id });
  // Only once there is something to compare against. Before approval the budget IS
  // the answer, and a variance panel of zeroes just takes up room.
  const variance = trpc.travelRequests.variance.useQuery(
    { id: request.id },
    { enabled: request.status === 'APPROVED' },
  );
  const fail = (e: { message: string }) => setError(e.message);
  const done = () => {
    setError(null);
    onChanged();
  };

  /**
   * There is no bulk "get live prices" any more.
   *
   * It searched flights and lodging and auto-took the CHEAPEST of each — which is the one
   * thing a picker exists to stop. Keeping both meant two ways to price a flight, and a
   * traveller who pressed both got two airfare lines. Each line's own picker replaced it.
   */
  const justify = trpc.travelRequests.justifyViolation.useMutation({
    onSuccess: done,
    onError: fail,
  });
  /**
   * Re-run the rules when the traveller changes the estimate, so a block appears (or
   * clears) as they work rather than only when they press Submit.
   *
   * Fire-and-forget on purpose. Its answer reaches the drawer through the request refetch
   * `done()` already triggers — the violations ride on `REQUEST_SELECT` — and a failure
   * here must not surface as an error over an edit that succeeded. Submit re-validates
   * server-side regardless, so nothing depends on this having run.
   */
  const revalidate = trpc.travelRequests.validate.useMutation({
    // A SECOND refetch, because the first one (from `done()`) raced this write and read
    // the old violation set. Two round-trips per edit is the honest cost of validating
    // out-of-band; the alternative is a drawer that shows yesterday's blockers.
    onSuccess: () => onChanged(),
  });
  /** An edit that can change the rules' answer: refresh, then re-run them. */
  const doneAndRevalidate = () => {
    done();
    revalidate.mutate({ id: request.id });
  };

  const addPlanned = trpc.travelRequests.addLine.useMutation({ onSuccess: doneAndRevalidate });

  const discardDraft = (key: string) => {
    setDrafts((d) => d.filter((k) => k !== key));
    setDraftErrors(({ [key]: _drop, ...rest }) => rest);
  };
  const removePlanned = trpc.travelRequests.removeLine.useMutation({
    onSuccess: doneAndRevalidate,
    onError: fail,
  });
  const updateLine = trpc.travelRequests.updateLine.useMutation({
    onSuccess: doneAndRevalidate,
    onError: fail,
  });
  const updateTrip = trpc.travelRequests.update.useMutation({
    onSuccess: () => {
      doneAndRevalidate();
      setEditingTrip(false);
    },
    onError: fail,
  });
  const submit = trpc.travelRequests.submit.useMutation({
    onSuccess: () => {
      done();
      onClose();
    },
    onError: fail,
  });
  const cancel = trpc.travelRequests.cancel.useMutation({
    onSuccess: () => {
      done();
      onClose();
    },
    onError: fail,
  });
  const buildReport = trpc.travelRequests.buildReport.useMutation({
    onSuccess: (res) => {
      done();
      // Straight into the report. Creating one and leaving the traveller on the
      // travel page is a step they then have to retrace.
      router.push(`/${locale}/expenses/${res.reportId}`);
    },
    onError: fail,
  });
  const decide = trpc.travelRequests.decide.useMutation({
    onSuccess: () => {
      done();
      onClose();
    },
    onError: fail,
  });

  const editable = request.status === 'DRAFT' || request.status === 'RETURNED';
  const total = request.budgetLines.reduce((a, l) => a + BigInt(l.amountMinor), 0n);

  const violations = request.policyViolations ?? [];
  const violationsByLine = new Map<string, typeof violations>();
  const requestWideViolations: typeof violations = [];
  for (const v of violations) {
    if (!v.travelLineId) {
      requestWideViolations.push(v);
      continue;
    }
    const held = violationsByLine.get(v.travelLineId);
    if (held) held.push(v);
    else violationsByLine.set(v.travelLineId, [v]);
  }
  /**
   * What stops a submit, computed the same way the server does.
   *
   * Advisory only — the gate lives in `travelRequests.submit` and re-runs the engine, so
   * a crafted call cannot get past it. This is here so the button can say WHY rather than
   * refusing after the click.
   */
  const blockingCount = violations.filter((v) => v.severity === 'BLOCK').length;
  const unjustifiedWarnings = violations.filter(
    (v) => v.severity === 'WARNING' && !v.resolvedAt,
  ).length;
  const policyBlocked = blockingCount > 0 || unjustifiedWarnings > 0;

  // Only asked for while the traveller can still act on the answer.
  const categories = trpc.travelRequests.categories.useQuery(undefined, {
    enabled: editable,
  });
  const carCategoryId = (categories.data?.items ?? []).find(
    (c) => c.code === categories.data?.carCode,
  )?.id;
  /**
   * A car was asked for and nothing has budgeted it.
   *
   * Nothing ever will, either: no provider on the travel integration quotes car hire,
   * so `includeCar` produces exactly no line on its own. Saying so beats a checkbox
   * that silently does nothing — which is what it was.
   */
  const carUnbudgeted =
    editable &&
    request.includeCar &&
    carCategoryId != null &&
    !request.budgetLines.some((l) => l.categoryId === carCategoryId);
  const unpriced = editable && request.budgetLines.length === 0;

  /**
   * A CATEGORY is all that is required. The amount is optional.
   *
   * It used to require both, which made the module's whole point unreachable: picking
   * "Meals" is supposed to derive the per-diem for the destination, and a form that
   * refused to submit without a typed figure meant every line arrived as `MANUAL` and no
   * allowance was ever applied from the UI. A typed amount is an override here, exactly as
   * it is on a line that already exists.
   */
  /** UTC, matching how the server reads a trip: a date rendered in the reader's zone
   *  shifts a day for anyone west of Greenwich, and an edit form pre-filled with the
   *  shifted value would SAVE the shift. */
  const isoDay = (d: string | Date | null) => (d ? new Date(d).toISOString().slice(0, 10) : '');

  const startEditTrip = () => {
    setError(null);
    setTripPurpose(request.purpose);
    setTripNotes(request.notes ?? '');
    setTripDepart(isoDay(request.departDate));
    setTripReturn(isoDay(request.returnDate));
    setEditingTrip(true);
  };

  const saveTrip = () => {
    setError(null);
    updateTrip.mutate({
      id: request.id,
      purpose: tripPurpose.trim(),
      notes: tripNotes.trim() || null,
      // Midnight UTC, because a trip is a range of calendar dates. Letting the browser
      // stamp its own offset makes the same trip a day shorter for half the company.
      departDate: `${tripDepart}T00:00:00.000Z`,
      returnDate: tripReturn ? `${tripReturn}T00:00:00.000Z` : null,
    });
  };

  const fmtDate = (d: string | Date | null) =>
    d ? new Date(d).toLocaleDateString(locale, { timeZone: 'UTC' }) : '—';

  return (
    <Drawer open onOpenChange={(o) => !o && onClose()}>
      {/*
        Half the viewport, matching the create drawer so one does not resize under the
        reader when the other closes. A block per line, each with its own fields, needs
        the room — this is not a three-column table any more.

        `width` rather than a `max-w-*` class alone: the drawer sets its width as an INLINE
        style, and an inline style beats a class — so this was a 480px panel with a 50vw cap
        it never reached, which looks exactly like the class not being applied.

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
          <DrawerTitle>
            {request.number} · {request.destinationLabel}
          </DrawerTitle>
        </DrawerHeader>

        <DrawerBody className="flex flex-col gap-5">
          {error && (
            <p className="rounded bg-destructive/10 px-3 py-2 text-destructive text-sm">{error}</p>
          )}

          <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
            <Row label={t('columns.traveller')} value={displayName(request.submitter)} />
            <Row label={t('columns.status')} value={t(`status.${request.status}`)} />
            <Row label={t('form.tripType')} value={t(`tripType.${request.tripType}`)} />
            <Row
              label={t('columns.dates')}
              value={`${fmtDate(request.departDate)} – ${fmtDate(request.returnDate)}`}
            />
            {request.originLabel && <Row label={t('form.origin')} value={request.originLabel} />}
            {request.approvedTotalMinor != null && (
              <Row
                label={t('detail.approvedTotal')}
                value={formatMinor(Number(request.approvedTotalMinor), request.currency, locale)}
              />
            )}
          </dl>

          {/**
           * Editing the trip itself.
           *
           * `travelRequests.update` has existed on the server since phase 3 and was wired
           * to NOTHING — a DRAFT request's purpose, dates and notes could not be changed
           * after creation, so a typo meant withdrawing and starting again. This is the
           * client half it was always missing.
           *
           * The destination and the currency stay out of it deliberately: both need the
           * place picker and both invalidate what every existing line was priced against,
           * which is a larger conversation than a text field.
           */}
          <section>
            <div className="mb-1 flex items-center justify-between">
              <h3 className="font-medium text-foreground text-sm">{t('detail.purpose')}</h3>
              {editable && !editingTrip && (
                <Button size="sm" variant="ghost" onClick={() => startEditTrip()}>
                  {t('header.edit')}
                </Button>
              )}
            </div>
            {editingTrip ? (
              <div className="flex flex-col gap-2">
                <FormField label={t('header.purpose')} htmlFor="trv-purpose">
                  <Textarea
                    id="trv-purpose"
                    rows={2}
                    value={tripPurpose}
                    onChange={(e) => setTripPurpose(e.target.value)}
                  />
                </FormField>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <FormField label={t('header.departDate')} htmlFor="trv-depart">
                    <Input
                      id="trv-depart"
                      type="date"
                      value={tripDepart}
                      onChange={(e) => setTripDepart(e.target.value)}
                    />
                  </FormField>
                  <FormField label={t('header.returnDate')} htmlFor="trv-return">
                    <Input
                      id="trv-return"
                      type="date"
                      value={tripReturn}
                      onChange={(e) => setTripReturn(e.target.value)}
                    />
                  </FormField>
                </div>
                <FormField label={t('header.notes')} htmlFor="trv-notes">
                  <Textarea
                    id="trv-notes"
                    rows={2}
                    value={tripNotes}
                    onChange={(e) => setTripNotes(e.target.value)}
                  />
                </FormField>
                {/* Said before the save, not discovered after it. */}
                <p className="text-muted-foreground text-xs">{t('header.editHint')}</p>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    disabled={updateTrip.isPending || tripPurpose.trim().length < 3}
                    onClick={saveTrip}
                  >
                    {t('header.save')}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setEditingTrip(false)}>
                    {t('header.cancel')}
                  </Button>
                </div>
              </div>
            ) : (
              <>
                <p className="whitespace-pre-wrap text-muted-foreground text-sm">
                  {request.purpose}
                </p>
                {request.notes && (
                  <p className="mt-1 whitespace-pre-wrap text-muted-foreground text-xs">
                    {request.notes}
                  </p>
                )}
              </>
            )}
          </section>

          <section>
            <div className="mb-2 flex items-center justify-between">
              <h3 className="font-medium text-foreground text-sm">{t('detail.budget')}</h3>
            </div>
            {/**
             * Advisory, not a refusal — `role="status"`, not `role="alert"`.
             *
             * Nothing here stops anything. The submit button below is live whether or
             * not these are showing, which is the whole change: the budget explains
             * what is missing instead of quietly disabling the only way forward.
             */}
            {unpriced && (
              <p
                role="status"
                className="mb-2 rounded border border-warning/40 bg-warning/10 px-3 py-2 text-foreground text-sm"
              >
                {t('detail.warnNoBudget')}
              </p>
            )}
            {policyBlocked && (
              <p
                // `role="alert"`, unlike the two advisory panels below — this one DOES
                // stop something, and the submit button is disabled while it shows.
                role="alert"
                className="mb-2 rounded border border-destructive/40 bg-destructive/10 px-3 py-2 text-foreground text-sm"
              >
                {blockingCount > 0
                  ? t('policy.blockedSummary', { count: blockingCount })
                  : t('policy.warnSummary', { count: unjustifiedWarnings })}
              </p>
            )}
            {carUnbudgeted && (
              <p
                role="status"
                className="mb-2 rounded border border-warning/40 bg-warning/10 px-3 py-2 text-foreground text-sm"
              >
                {t('detail.warnCarUnpriced')}
              </p>
            )}
            {requestWideViolations.length > 0 && (
              <div className="mb-2">
                <ViolationList
                  violations={requestWideViolations}
                  editable={editable}
                  pending={justify.isPending}
                  onJustify={(violationId, note) => {
                    setError(null);
                    justify.mutate({ violationId, note });
                  }}
                />
              </div>
            )}
            {/* "Nothing budgeted yet" is about the BUDGET, not about the screen — so it
                goes as soon as somebody starts a row, even before that row is saved. */}
            {request.budgetLines.length === 0 && drafts.length === 0 && (
              <p className="text-muted-foreground text-sm">{t('detail.noBudget')}</p>
            )}
            {request.budgetLines.length > 0 && (
              <>
                {/* A stack of blocks, not a table. A table could show a category, a
                    basis and an amount; a line can now be a flight with a number and a
                    cabin, or a meal with people at it, and three columns cannot hold
                    that. */}
                <div className="flex flex-col gap-2">
                  {request.budgetLines.map((line) => (
                    <div key={line.id} className="flex flex-col gap-1.5">
                      <LineBlock
                        line={line}
                        requestId={request.id}
                        currency={{ code: request.currency.code, symbol: currencySymbol(request.currency.code) }}
                        tripType={request.tripType}
                        departDate={request.departDate}
                        returnDate={request.returnDate}
                        editable={editable}
                        pending={updateLine.isPending || removePlanned.isPending}
                        onUpdate={(input) => {
                          setError(null);
                          updateLine.mutate({ id: request.id, lineId: line.id, ...input });
                        }}
                        onRemove={() => removePlanned.mutate({ id: request.id, lineId: line.id })}
                        onChanged={done}
                        onError={fail}
                      />
                      {/* Under its line, not in a panel of their own: a cabin block is a
                        fact about ONE flight, and a list at the bottom would make the
                        reader match sentences to lines by hand. */}
                      <ViolationList
                        violations={violationsByLine.get(line.id) ?? []}
                        editable={editable}
                        pending={justify.isPending}
                        onJustify={(violationId, note) => {
                          setError(null);
                          justify.mutate({ violationId, note });
                        }}
                      />
                    </div>
                  ))}
                </div>
              </>
            )}

            {/**
             * Adding a line, the way every other repeating row in the product is added:
             * one button, and the row it opens is already the shape of the row it will
             * become. It replaces a form strip — a labelled category select, an amount, a
             * notes box and an "Add to budget" button — pinned above the list, which was a
             * different layout for the same idea two inches from the thing it produced.
             *
             * BELOW the list, matching the expense workbench, so the row appears where the
             * press happened and the saved line lands in the same place. That is a reversal
             * of an earlier fix worth recording: the control sat above the stack because
             * the inline pickers grew as their queries settled and pushed it down mid-reach
             * — Playwright caught it as a click timing out on a button that would not hold
             * still. Those results moved into a modal, so the blocks above no longer grow
             * after mount and the reason has gone with them.
             */}
            {editable && (
              <div className="mt-2 flex flex-col gap-2">
                {drafts.map((key) => (
                  <PlannedLineDraft
                    key={key}
                    requestId={request.id}
                    categories={categories.data?.items ?? []}
                    currency={{ code: request.currency.code, symbol: currencySymbol(request.currency.code) }}
                    pending={addPlanned.isPending}
                    error={draftErrors[key] ?? null}
                    onDiscard={() => discardDraft(key)}
                    onCreate={(input) => {
                      setError(null);
                      setDraftErrors(({ [key]: _drop, ...rest }) => rest);
                      // The draft goes on SUCCESS only. A refusal keeps the row and its
                      // values, so the fix is one edit away rather than a retype.
                      addPlanned.mutate(
                        { id: request.id, ...input },
                        {
                          onSuccess: () => discardDraft(key),
                          onError: (err) =>
                            setDraftErrors((prev) => ({ ...prev, [key]: err.message })),
                        },
                      );
                    }}
                  />
                ))}
                <Button
                  size="sm"
                  variant="outline"
                  className="w-full"
                  onClick={() => setDrafts((d) => [...d, newDraftKey()])}
                >
                  <IconPlus size={12} className="mr-1" />
                  {t('detail.plannedAddItem')}
                </Button>
              </div>
            )}

            {request.budgetLines.length > 0 && (
              <div className="mt-3 flex items-baseline justify-between border-border border-t pt-2">
                <span className="font-medium text-foreground text-sm">{t('detail.total')}</span>
                <span className="font-medium text-foreground text-sm tabular-nums">
                  {formatMinor(Number(total), request.currency, locale)}
                </span>
              </div>
            )}
          </section>

          {variance.data && variance.data.rows.length > 0 && (
            <section>
              <h3 className="mb-2 font-medium text-foreground text-sm">{t('detail.variance')}</h3>
              {!variance.data.hasActuals ? (
                <p className="text-muted-foreground text-sm">{t('detail.varianceNone')}</p>
              ) : (
                // Four columns, three of them currency, and the widest cell is a
                // category label we do not control. `w-full` shrinks them to fit
                // until it cannot; past that the table pushes the whole drawer
                // sideways. The scroller keeps any overflow inside this section.
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-muted-foreground text-xs">
                        <th className="pb-1 text-left font-normal">{t('detail.budget')}</th>
                        <th className="pb-1 text-right font-normal">
                          {t('detail.varianceBudgeted')}
                        </th>
                        <th className="pb-1 text-right font-normal">
                          {t('detail.varianceActual')}
                        </th>
                        <th className="pb-1 text-right font-normal">{t('detail.varianceDelta')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {variance.data.rows.map((r) => (
                        <tr key={r.categoryId} className="border-border border-b last:border-0">
                          <td className="py-1.5 text-foreground">
                            {r.category?.icon ? `${r.category.icon} ` : ''}
                            {r.category ? pickText(r.category.label, locale) : r.categoryId}
                          </td>
                          <td className="py-1.5 text-right text-muted-foreground tabular-nums">
                            {formatMinor(Number(r.budgetedMinor), request.currency, locale)}
                          </td>
                          <td className="py-1.5 text-right text-foreground tabular-nums">
                            {formatMinor(Number(r.actualMinor), request.currency, locale)}
                          </td>
                          {/* An overrun is money nobody authorised, so it reads as a
                            problem; coming in under is not news. */}
                          <td
                            className={`py-1.5 text-right tabular-nums ${
                              BigInt(r.varianceMinor) > 0n
                                ? 'text-destructive'
                                : 'text-muted-foreground'
                            }`}
                          >
                            {formatMinor(Number(r.varianceMinor), request.currency, locale)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          )}

          <section>
            <h3 className="mb-2 font-medium text-foreground text-sm">{t('detail.timeline')}</h3>
            {(timeline.data?.tasks.length ?? 0) === 0 ? (
              <p className="text-muted-foreground text-sm">{t('detail.noTimeline')}</p>
            ) : (
              <ul className="flex flex-col gap-1.5 text-sm">
                {timeline.data?.tasks.map((task) => (
                  <li key={task.id} className="flex items-baseline justify-between gap-3">
                    <span className="text-foreground">{stepLabel(task.label, t)}</span>
                    <span className="text-muted-foreground text-xs">
                      {task.decidedBy ? displayName(task.decidedBy) : '—'} ·{' '}
                      {t(`taskStatus.${task.status}` as 'taskStatus.PENDING')}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/**
           * The discussion, after the approval timeline it usually refers to.
           *
           * Separate from that timeline on purpose: the section above answers "where is
           * this?" from the approval TASKS, while this one is the activity stream and the
           * conversation. Merging them would mean one list drawn from two sources with
           * different shapes.
           */}
          <section>
            <CommentThread subjectType="TRAVEL_REQUEST" subjectId={request.id} />
          </section>

          {taskId && (
            <Textarea
              rows={2}
              value={note}
              placeholder={t('detail.notePlaceholder')}
              aria-label={t('detail.note')}
              onChange={(e) => setNote(e.target.value)}
            />
          )}
        </DrawerBody>

        <DrawerFooter>
          <Button variant="ghost" onClick={onClose}>
            {t('detail.close')}
          </Button>
          {editable && (
            <>
              <Button
                variant="ghost"
                disabled={cancel.isPending}
                onClick={() => cancel.mutate({ id: request.id })}
              >
                {t('detail.withdraw')}
              </Button>
              {/**
               * Not gated on the budget any more.
               *
               * It used to read `disabled={… || request.budgetLines.length === 0}`, so a
               * destination with no per-diem rate and no quotable route produced a dead
               * button and no sentence explaining it — the traveller's only remaining
               * move was to invent a different destination. The panel above now says
               * what is missing, and the request still reaches an approver, who is the
               * person entitled to decide whether an unpriced trip is acceptable.
               */}
              <Button
                // Disabled ONLY for policy, and with a sentence above saying which
                // violations — unlike the budget gate this replaced, whose dead button
                // came with no explanation at all.
                disabled={submit.isPending || policyBlocked}
                onClick={() => submit.mutate({ id: request.id })}
              >
                {t('detail.submit')}
              </Button>
            </>
          )}
          {request.status === 'APPROVED' && (
            <Button
              disabled={buildReport.isPending}
              onClick={() => buildReport.mutate({ id: request.id })}
            >
              {t('detail.buildReport')}
            </Button>
          )}
          {taskId && (
            <>
              <Button
                variant="destructive"
                disabled={decide.isPending}
                onClick={() =>
                  decide.mutate({ taskId, approve: false, note: note.trim() || undefined })
                }
              >
                {t('detail.reject')}
              </Button>
              <Button
                disabled={decide.isPending}
                onClick={() =>
                  decide.mutate({ taskId, approve: true, note: note.trim() || undefined })
                }
              >
                {t('detail.approve')}
              </Button>
            </>
          )}
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="text-foreground">{value}</dd>
    </div>
  );
}
