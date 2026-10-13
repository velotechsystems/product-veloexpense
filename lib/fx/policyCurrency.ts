/**
 * The organization's policy currency (`organization.policy_currency_code`, 0015): the
 * currency every policy threshold and per-category limit is stated in, and the base
 * VeloExpense's analytics report in.
 *
 * Moved from VeloExpense's v1 policy service (lib/policy/service.ts) at the cutover
 * (w4-02d), with its rule: it REFUSES rather than assuming CAD (PE-8). The column is
 * NOT NULL DEFAULT 'CAD', so a missing row means no tenant context — a scheduled job, say —
 * and answering CAD there would evaluate against a currency nobody chose.
 *
 * Its writer is `policies.expensePolicy.setCurrency` (d68).
 */
import type { QueryRunner } from '@/lib/db/client';
import { DomainError } from '@/lib/errors/domain';
import { ORG } from '@/lib/tenant/sql';

export class NoTenantCurrencyError extends DomainError {
  constructor() {
    super('no tenant context, so there is no policy currency to read', null);
    this.name = 'NoTenantCurrencyError';
  }
}

export async function policyCurrencyCode(tx: QueryRunner): Promise<string> {
  const org = await tx.query(`SELECT policy_currency_code FROM organization WHERE id = ${ORG}`);
  if (org.rows.length === 0) throw new NoTenantCurrencyError();
  return org.rows[0].policy_currency_code as string;
}
