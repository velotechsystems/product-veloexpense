/**
 * VeloExpense: the submit and recall ADAPTER (d23). Not in ExpenseOS.
 *
 * ExpenseOS's `expenses.submit` and `expenses.recall` drive its graph approval engine —
 * `startInstance`, the `approvalTask` / `approvalInstance` rows, `notifyReportSubmitted` /
 * `notifyReportRecalled`, `postApprovedReport`, `executeWorkflowEffects`. VeloExpense's
 * approvals run on its own engine until Wave 4 ports ExpenseOS's, so the ported procedures
 * keep ExpenseOS's checks and words and hand the TRANSITION to VeloExpense's
 * `lib/expenses/lifecycle.ts`, which does the same jobs on that engine in the procedure's own
 * transaction: it re-runs the policy pass under a lock, writes the status, opens (or
 * cancels) the approval run, notifies the approvers, recomputes the budgets and writes the
 * audit chain.
 *
 * The lifecycle speaks `DomainError`; a procedure speaks `TRPCError`. `toTrpcError` is the
 * one translation: the refusal's catalogued sentence (en-CA) becomes the message — what
 * ExpenseOS's procedures put there — and its code becomes the nearest tRPC code. An error
 * that is not ours is rethrown untouched, so `safeMessage` still launders it.
 */
import { TRPCError } from '@trpc/server';
import type { TenantDb } from '@/lib/db/prisma';
import { queryRunnerOf } from '@/lib/db/prisma-pg-bridge';
import { DomainError, encodeUserMessage } from '@/lib/errors/domain';
import { recallReport, submitReport, LifecycleError } from '@/lib/expenses/lifecycle';
import { renderUserMessage } from '@/lib/i18n/catalog/errors';
import { DEFAULT_LOCALE } from '@/lib/i18n/locales';

type TrpcCode = ConstructorParameters<typeof TRPCError>[0]['code'];

const LIFECYCLE_CODES: Record<LifecycleError['code'], TrpcCode> = {
  NOT_FOUND: 'NOT_FOUND',
  WRONG_STATUS: 'BAD_REQUEST',
  EMPTY_REPORT: 'PRECONDITION_FAILED',
  UNDATED: 'PRECONDITION_FAILED',
  UNCODED: 'PRECONDITION_FAILED',
  BLOCKED_BY_POLICY: 'PRECONDITION_FAILED',
  UNJUSTIFIED_WARNING: 'PRECONDITION_FAILED',
  FORBIDDEN: 'FORBIDDEN',
};

/** A lifecycle (or billing, or engine) refusal as the `TRPCError` a ported procedure throws. */
export function toTrpcError(err: unknown): unknown {
  if (!(err instanceof DomainError)) return err;
  const code: TrpcCode =
    err instanceof LifecycleError
      ? LIFECYCLE_CODES[err.code]
      : err.name === 'BillingLapsedError'
        ? 'FORBIDDEN'
        : 'PRECONDITION_FAILED';
  const message = err.userMessage
    ? renderUserMessage(encodeUserMessage(err.userMessage), DEFAULT_LOCALE)
    : err.message;
  return new TRPCError({ code, message, cause: err });
}

/** DRAFT | RETURNED → SUBMITTED, on VeloExpense's lifecycle. */
export async function submitThroughLifecycle(db: TenantDb, reportId: string, actorId: string) {
  try {
    return await submitReport(queryRunnerOf(db), reportId, actorId);
  } catch (err) {
    throw toTrpcError(err);
  }
}

/** SUBMITTED → DRAFT, on VeloExpense's lifecycle. */
export async function recallThroughLifecycle(db: TenantDb, reportId: string, actorId: string) {
  try {
    return await recallReport(queryRunnerOf(db), reportId, actorId);
  } catch (err) {
    throw toTrpcError(err);
  }
}
