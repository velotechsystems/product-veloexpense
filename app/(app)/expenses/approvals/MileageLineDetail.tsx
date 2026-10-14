'use client';

/**
 * MileageLineDetail — what a `MILEAGE` line on the approver's expense card claims:
 * the distance, the route, and the rate it was priced at (or the per-band split
 * when the trip crossed a rate boundary).
 *
 * Display only. Everything here is the snapshot `expenseApprovals.report` sends,
 * taken when the line was priced; nothing is recomputed in the browser. In
 * particular the claimed-vs-route pair is decided on the server
 * (`deriveRouteView`): `routeDistance` is non-null only when the filed route's own
 * distance differs from the claim by more than the threshold, so the browser never
 * needs the legs, and never needs to decide what counts as a difference.
 *
 * Two labelling rules come from the security review and are not style:
 *   · the route figure is "as filed" — the submitter controls the stored legs, so
 *     it is never presented as verified or computed;
 *   · a hidden pair says nothing about agreement. With `routeDistance` null the
 *     line shows the distance alone, never "matches the route".
 */

import { useTranslations } from 'next-intl';
import { type CurrencyLike, formatMinor } from '@/lib/format';
import { RouteSummary } from '../_workbench/RouteEditor';

/** The mileage fields of one `expenseApprovals.report` line. Structural, so the
 *  inferred tRPC line type satisfies it without a cast. */
export interface MileageLineFields {
  /** Decimal string in `mileageUnit` ("120.00"). */
  mileageDistance: string | null;
  mileageUnit: 'KM' | 'MI' | null;
  /** The pricing engine's segments, as stored (JSON). Read through `mileageTiers`. */
  mileageBreakdown: unknown;
  mileageRoute: { stops: { description: string }[] } | null;
  /** The filed route's distance in `mileageUnit`, only when it differs from the claim. */
  routeDistance: string | null;
  /** A route was stored but the server could not read it. */
  mileageRouteUnavailable: boolean;
}

/** One rate band the trip was billed in. Bounds are in the rule's unit, on the
 *  traveller's year-to-date distance. */
export interface MileageTier {
  /** The band's lower bound ("0.00", "5000.00"). */
  from: string;
  /** The next billed band's lower bound, or null for the last band (open-ended:
   *  its top lives on the rate rule, which the snapshot does not carry). */
  to: string | null;
  /** Distance billed in this band. */
  distance: string;
  rateMinor: bigint;
  amountMinor: bigint;
}

const DECIMAL = /^\d+(\.\d+)?$/;
const INTEGER = /^-?\d+$/;

/** A stored field as a string, when it is a string or a finite number. */
function asText(v: unknown): string | null {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
}

/**
 * The bands a mileage line was billed in, read from its stored breakdown
 * (`MileageSegment[]` in `server/lib/mileage.ts`: `fromDistance`, `rateMinor`,
 * `distance`, `amountMinor`, one entry per band the trip touched, ascending).
 *
 * Each band's top is the next entry's `fromDistance`; the last entry is open.
 * All-or-nothing: a breakdown that is not an array of well-formed entries yields
 * `[]`, and the card shows no rate rather than a partial split that would not sum
 * to the line amount.
 */
export function mileageTiers(breakdown: unknown): MileageTier[] {
  if (!Array.isArray(breakdown)) return [];
  const parsed: Omit<MileageTier, 'to'>[] = [];
  for (const entry of breakdown) {
    if (entry === null || typeof entry !== 'object') return [];
    const e = entry as Record<string, unknown>;
    const from = asText(e.fromDistance);
    const distance = asText(e.distance);
    const rate = asText(e.rateMinor);
    const amount = asText(e.amountMinor);
    if (from == null || distance == null || rate == null || amount == null) return [];
    if (!DECIMAL.test(from) || !DECIMAL.test(distance)) return [];
    if (!INTEGER.test(rate) || !INTEGER.test(amount)) return [];
    parsed.push({ from, distance, rateMinor: BigInt(rate), amountMinor: BigInt(amount) });
  }
  return parsed.map((p, i) => ({ ...p, to: parsed[i + 1]?.from ?? null }));
}

export function MileageLineDetail({
  line,
  currency,
  locale,
}: {
  line: MileageLineFields;
  /** The expense's own currency — the one its line amounts and rates are in. */
  currency: CurrencyLike;
  locale: string;
}) {
  const t = useTranslations('expenses');
  // Distances with two decimals, as the editor stores them; band bounds without
  // trailing zeros ("5,000", not "5,000.00").
  const twoDp = new Intl.NumberFormat(locale, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const bound = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 });
  const distance = (v: string) => twoDp.format(Number(v));
  const money = (minor: bigint) => formatMinor(minor, currency, locale);

  const unit = line.mileageUnit === 'MI' ? t('line.mi') : line.mileageUnit ? t('line.km') : null;
  const tiers = unit ? mileageTiers(line.mileageBreakdown) : [];

  return (
    <div className="mt-0.5 flex min-w-0 flex-col gap-0.5 break-words text-muted-foreground text-xs">
      {unit &&
        line.mileageDistance != null &&
        (line.routeDistance != null ? (
          <p>
            {t('line.mileageClaimed', {
              claimed: distance(line.mileageDistance),
              unit,
              route: distance(line.routeDistance),
            })}
          </p>
        ) : (
          <p>{t('line.distanceValue', { distance: distance(line.mileageDistance), unit })}</p>
        ))}

      {line.mileageRouteUnavailable ? (
        <p>{t('line.routeUnavailable')}</p>
      ) : line.mileageRoute ? (
        <RouteSummary value={line.mileageRoute} />
      ) : null}

      {unit && tiers.length === 1 && (
        <p>{t('line.mileageRate', { rate: money(tiers[0].rateMinor), unit })}</p>
      )}
      {unit && tiers.length > 1 && (
        <ul className="flex flex-col gap-0.5">
          {tiers.map((tier) => {
            const values = {
              from: bound.format(Number(tier.from)),
              unit,
              distance: distance(tier.distance),
              rate: money(tier.rateMinor),
              amount: money(tier.amountMinor),
            };
            return (
              <li key={tier.from}>
                {tier.to == null
                  ? t('line.mileageTierOpen', values)
                  : t('line.mileageTier', { ...values, to: bound.format(Number(tier.to)) })}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
