/**
 * Shared status constants for the Travel section. The request-status
 * value set and its badge-variant mapping are read by the requests list,
 * its filter pills, and (shortly) the dashboard's travel strip, so they
 * live here once rather than being copied per view.
 *
 * Same arrangement as `virtual-cards/_shared.ts`, for the same reason:
 * a variant map that exists twice is a screen that eventually disagrees
 * with itself about what colour an approved request is.
 *
 * Labels are NOT here — those are `travel.status.*` in the i18n catalogs.
 */

/** The `<Badge>` variants used by travel status mapping. */
type BadgeVariant = 'success' | 'warning' | 'destructive' | 'secondary';

/**
 * Every travel-request status, in lifecycle order — which is the order a
 * filter should offer them in.
 */
export const STATUSES = [
  'DRAFT',
  'SUBMITTED',
  'APPROVED',
  'REJECTED',
  'RETURNED',
  'CANCELLED',
] as const;

/** A travel request's status, as the list and its filters see it. */
export type TravelStatus = (typeof STATUSES)[number];

/**
 * Travel-request status → Badge variant.
 *
 * SUBMITTED and RETURNED are both amber because both are waiting on a
 * person — one on the approver, one on the requester. REJECTED is the
 * only red: CANCELLED is grey because the requester withdrew it, and
 * "somebody changed their mind" is not a failure.
 *
 * Keyed loosely (`string`) because the row's `status` arrives off the
 * wire; consumers fall back to `secondary` for anything unrecognised.
 */
export const STATUS_VARIANT: Record<string, BadgeVariant> = {
  DRAFT: 'secondary',
  SUBMITTED: 'warning',
  APPROVED: 'success',
  REJECTED: 'destructive',
  RETURNED: 'warning',
  CANCELLED: 'secondary',
};

/**
 * The trip's budget as it stands, in minor units.
 *
 * `approvedTotalMinor` is the snapshot an approver took; until somebody approves the
 * request it is NULL, and the figure is the sum of the budget lines. Showing a blank
 * until then would hide the number the decision is about.
 *
 * IT LIVES HERE FOR THE REASON THE VARIANT MAP DOES. Two screens now print this
 * figure — the requests list and the dashboard's travel card — and a money rule that
 * exists twice is two screens that eventually disagree about what a trip costs. That
 * is a worse failure than a wrong colour.
 *
 * Typed STRUCTURALLY rather than against `TravelRequestItem`, so a caller outside the
 * travel module can use it without importing anything from inside one. `superjson`
 * hands the client real `bigint`s, and `BigInt()` accepts a bigint unchanged, so a
 * string from a non-superjson caller works too.
 */
export function travelBudgetMinor(request: {
  approvedTotalMinor: bigint | string | null;
  budgetLines: readonly { amountMinor: bigint | string }[];
}): bigint {
  if (request.approvedTotalMinor != null) return BigInt(request.approvedTotalMinor);
  return request.budgetLines.reduce((sum, line) => sum + BigInt(line.amountMinor), 0n);
}
