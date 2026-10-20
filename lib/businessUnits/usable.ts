/**
 * f09 — the server refuses a deactivated business unit.
 *
 * Business units are never deleted; an administrator switches one off (`active = false`,
 * 0047) and the pickers stop offering it. Until now only the pickers did: a crafted form
 * post or API call could still put a deactivated unit on an expense report, a person, an
 * invitation or a budget.
 *
 * THE RULE, the one `assertAllocationDimensionsUsable` (server/routers/expenses.ts) already
 * applies to allocations:
 *   - no unit (null / absent)                     → fine;
 *   - the unit the record ALREADY carries         → fine, even if it has since been
 *     deactivated, so that editing anything else on a record coded before the
 *     deactivation still saves;
 *   - any other unit                              → it must exist in this tenant (RLS)
 *     and be active, or the write is refused with BUSINESS_UNIT_UNAVAILABLE.
 *
 * ExpenseOS has no such check on any of these paths (it relies on its pickers too).
 */
import type { QueryRunner } from '@/lib/db/client';
import { DomainError } from '@/lib/errors/domain';

export class BusinessUnitUnavailableError extends DomainError {
  readonly code = 'BUSINESS_UNIT_UNAVAILABLE' as const;
  constructor(businessUnitId: string) {
    super(`business unit ${businessUnitId} is missing or deactivated`, 'BUSINESS_UNIT_UNAVAILABLE');
    this.name = 'BusinessUnitUnavailableError';
  }
}

/** The decision alone, for callers that read the unit themselves (Prisma routers). */
export function businessUnitUsable(
  wanted: string | null | undefined,
  found: { active: boolean } | null,
  kept: string | null | undefined = null,
): boolean {
  if (!wanted) return true;
  if (kept && wanted === kept) return true;
  return found !== null && found.active;
}

/** Refuse `wanted` unless {@link businessUnitUsable}. Reads inside the caller's tenant. */
export async function assertBusinessUnitUsable(
  tx: QueryRunner,
  wanted: string | null | undefined,
  kept: string | null | undefined = null,
): Promise<void> {
  if (!wanted || (kept && wanted === kept)) return;
  const r = await tx.query('SELECT active FROM business_unit WHERE id = $1', [wanted]);
  const found = (r.rows[0] as { active: boolean } | undefined) ?? null;
  if (!businessUnitUsable(wanted, found, kept)) throw new BusinessUnitUnavailableError(wanted);
}
