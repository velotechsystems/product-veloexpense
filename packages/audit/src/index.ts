/**
 * @expenseos/audit — ExpenseOS's audit primitive, for ported routers.
 *
 * VeloExpense: the API is ExpenseOS's (`withAudit`, `writeAudit`, `auditDiff`,
 * `auditActions`); the rows are VeloExpense's per-tenant `audit_entry` chain, which
 * `lib/audit/verify.ts` verifies. See `writer.ts` and `actions.ts` for the two places
 * the port differs. Not ported (yet): the chain verifier and helpers ExpenseOS exports
 * for its own `Audit` table — VeloExpense's live in lib/audit.
 */
export { auditActions } from './actions';
// VeloExpense (w6-03): ExpenseOS's delegation marker, for the assistant's confirmed actions.
export {
  currentDelegation,
  type DelegationContext,
  runWithDelegation,
  withDelegation,
} from './delegation';
export { type AuditDiff, auditDiff } from './diff';
export type { AuditActor, AuditInput, ResolvedActor } from './types';
export { withAudit, writeAudit } from './writer';
