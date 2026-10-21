'use client';

/**
 * What a distance is worth, from `expenses.mileagePreview` — the workspace footer's price
 * (FR-5).
 *
 * Nothing here is typed, so there is no settle delay: the distance changes only when a
 * route is selected. The figure is asked for only with a category to price against and a
 * distance to price; a refusal ("No mileage rate in force for US on this date.") is the
 * same refusal the write would raise, said before it is attempted.
 */

import { trpc } from '@/lib/trpc/client';

export interface MileagePricing {
  expenseId: string;
  categoryId: string | null;
  /** Set on an existing line, so its own distance leaves the year-to-date basis. */
  lineItemId?: string;
}

export interface MileageQuote {
  /** The priced amount in minor units, or null while there is none. */
  amountMinor: string | null;
  /** True once the server has said this distance cannot be priced. */
  refused: boolean;
  /** The server's reason, when it gave one. */
  reason: string | null;
  /** Asked for, and not answered yet. */
  pending: boolean;
}

export function useMileageQuote(
  pricing: MileagePricing | undefined,
  distance: string | null,
  unit: 'KM' | 'MI',
): MileageQuote {
  const enabled = Boolean(pricing?.categoryId) && Boolean(distance);
  const preview = trpc.expenses.mileagePreview.useQuery(
    {
      expenseId: pricing?.expenseId ?? '',
      categoryId: pricing?.categoryId ?? '',
      mileageDistance: distance ?? '',
      mileageUnit: unit,
      lineItemId: pricing?.lineItemId,
    },
    { enabled, staleTime: 30_000 },
  );
  const data = enabled ? preview.data : undefined;
  return {
    amountMinor: data?.ok ? data.amountMinor : null,
    refused: data?.ok === false,
    reason: data?.ok === false ? (data.reason ?? null) : null,
    pending: enabled && data === undefined && !preview.isError,
  };
}
