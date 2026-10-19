/**
 * A line's one-line summary, composed from its payload at render time.
 *
 * This replaces a string the SERVER used to compose and store in `detail`
 * ("Per diem · 3 days · Toronto · first/last day halved", "YUL→LHR · AC 412"). Two
 * things were wrong with that:
 *
 *   · it occupied `detail`, which is the TRAVELLER's field — the place they say why this
 *     line, and on a quoted line why THIS fare rather than the cheaper one on another
 *     carrier. A policy rule can require that field, and it cannot require a field the
 *     server fills in by itself;
 *   · it was English, whoever was reading. The old code excused this as a "snapshot read
 *     back years later", which was never true of an estimate a traveller and an approver
 *     in two languages both look at.
 *
 * So the payload carries the FACTS and this composes the sentence. Pure, and taking `t`
 * and a money formatter rather than calling hooks, so it can be tested without a render.
 */

import { flightNumbersOf, flightRouteOf, readTravelLinePayload } from '@expenseos/travel-lines';

export interface SummaryDeps {
  /** Scoped to the `travel` catalog. Values are interpolated by next-intl. */
  t: (key: string, values?: Record<string, string | number>) => string;
  /** Minor units in the request's currency → a display string. */
  money: (minor: bigint) => string;
}

const DOT = ' · ';
/** One separator for every route rendered anywhere, so the picker and the line agree. */
export const ARROW = ' → ';

/**
 * What `travelRequests.previewLine` says about a line that does not exist yet.
 *
 * The same four facts the server writes into a STANDARD payload when it derives an
 * allowance, so the caption under a POPULATED amount reads exactly like the caption under
 * the saved line it becomes.
 */
export interface DerivationPreview {
  derivedAmountMinor: string | null;
  days: number;
  dailyRateMinor: string | null;
  edgeDaysHalved: boolean;
  city: string | null;
}

/**
 * The caption for a derived figure the traveller has not saved yet — "Per diem · 3 days ·
 * Toronto · $75.00/day" — or null when nothing was derived.
 *
 * Composed by the SAME function as a saved line's summary, from the preview restated as
 * the payload the server would have written. A second sentence-builder for the same facts
 * would drift from the first, and the point of showing the caption before the save is
 * that it is the sentence the traveller will see after it.
 */
export function derivationSummary(
  preview: DerivationPreview | null | undefined,
  deps: SummaryDeps,
): string | null {
  if (!preview?.derivedAmountMinor) return null;
  return lineSummary(
    'STANDARD',
    {
      perDiemDays: preview.days,
      perDiemCity: preview.city,
      perDiemDailyMinor: preview.dailyRateMinor,
      perDiemEdgeHalved: preview.edgeDaysHalved,
    },
    deps,
  );
}

/** A summary for the line, or null when its payload says nothing worth a sentence. */
export function lineSummary(kind: string, payload: unknown, deps: SummaryDeps): string | null {
  const parts = fragments(kind, payload, deps).filter((p): p is string => !!p);
  return parts.length > 0 ? parts.join(DOT) : null;
}

function fragments(kind: string, payload: unknown, { t, money }: SummaryDeps): (string | null)[] {
  switch (kind) {
    case 'STANDARD': {
      const p = readTravelLinePayload('STANDARD', payload);
      // Absent, not zero. A STANDARD line with no allowance applied has nothing to say
      // here — its amount is somebody's typed figure, and the override hint says so.
      if (!p?.perDiemDays) return [];
      return [
        t('line.summary.perDiem', { days: p.perDiemDays, city: p.perDiemCity ?? '' }),
        p.perDiemDailyMinor
          ? t('line.summary.dailyRate', { rate: money(BigInt(p.perDiemDailyMinor)) })
          : null,
        // Said explicitly, because a traveller checking rate × days finds the figure
        // short by a day and reports a bug.
        p.perDiemEdgeHalved ? t('line.summary.edgeHalved') : null,
      ];
    }
    case 'AIRFARE': {
      const p = readTravelLinePayload('AIRFARE', payload);
      if (!p) return [];
      /**
       * The whole path, not the endpoints.
       *
       * `fromLabel → toLabel` rendered a return trip as `YYZ → YYZ`, which is accurate and
       * tells the reader nothing about where they went. `routeFromLegs` walks the legs, so
       * a return Calgary–Orlando reads `YYC → MCO → YYC` and a connection shows up too.
       */
      const path = flightRouteOf(payload);
      const route = path.length > 0 ? path.join(ARROW) : null;
      const numbers = flightNumbersOf(payload);
      return [
        route,
        numbers.length > 0 ? numbers.join(DOT) : null,
        // Only when it is not the ordinary cabin. A label reading "economy" on every
        // flight is a label nobody reads, and the point of showing it is the exception.
        p.travelClass && p.travelClass !== 'ECONOMY' ? t(`policy.cabin.${p.travelClass}`) : null,
      ];
    }
    case 'LODGING': {
      const p = readTravelLinePayload('LODGING', payload);
      if (!p) return [];
      return [
        p.propertyName || null,
        p.nights > 0 ? t('line.summary.nights', { nights: p.nights }) : null,
        p.nightlyMinor ? t('line.summary.nightly', { rate: money(BigInt(p.nightlyMinor)) }) : null,
      ];
    }
    case 'DEPARTMENT_MEAL': {
      const p = readTravelLinePayload('DEPARTMENT_MEAL', payload);
      if (!p || p.attendees.length === 0) return [];
      return [
        t('line.summary.attendees', { count: p.attendees.length }),
        p.occurrencesPerDay > 1 ? t('line.summary.perDay', { count: p.occurrencesPerDay }) : null,
        p.days > 0 ? t('line.summary.days', { days: p.days }) : null,
      ];
    }
    case 'CAR_RENTAL':
    case 'GROUND': {
      const p = readTravelLinePayload(kind, payload);
      if (!p) return [];
      const days = p.days ?? 0;
      return [
        days > 0 ? t('line.summary.days', { days }) : null,
        p.dailyCapMinor
          ? t('line.summary.dailyCap', { cap: money(BigInt(p.dailyCapMinor)) })
          : null,
      ];
    }
    default:
      return [];
  }
}
