/**
 * VeloExpense: the submit and recall ADAPTER (d23), and since w2-02a the approver's
 * decide / return / reassign (d36). Not in ExpenseOS.
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
import {
  ApprovalEngineError,
  type ApprovalEngineErrorCode,
  decide as decideTask,
  type Decision,
  reassignTask,
} from '@/lib/approvals/engine';
import { DecisionForbiddenError } from '@/lib/approvals/eligibility';
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

/**
 * w2-02a: the approval engine's refusals, for the approver's procedures (decide, return,
 * reassign) — which, like submit and recall, hand their transition to VeloExpense's engine.
 */
const ENGINE_CODES: Record<ApprovalEngineErrorCode, TrpcCode> = {
  REPORT_NOT_FOUND: 'NOT_FOUND',
  TASK_NOT_FOUND: 'NOT_FOUND',
  WRONG_STATUS: 'BAD_REQUEST',
  RUN_ALREADY_OPEN: 'BAD_REQUEST',
  ALREADY_DECIDED: 'BAD_REQUEST',
  RUN_NOT_RUNNING: 'BAD_REQUEST',
  BAD_ASSIGNEE: 'BAD_REQUEST',
  RECEIPT_ACK_REQUIRED: 'PRECONDITION_FAILED',
  STEP_UNROUTABLE: 'PRECONDITION_FAILED',
  EXTERNAL_DECISION_UNSUPPORTED: 'PRECONDITION_FAILED',
};

/** A lifecycle (or billing, or engine) refusal as the `TRPCError` a ported procedure throws. */
export function toTrpcError(err: unknown): unknown {
  if (!(err instanceof DomainError)) return err;
  const code: TrpcCode =
    err instanceof LifecycleError
      ? LIFECYCLE_CODES[err.code]
      : err instanceof ApprovalEngineError
        ? ENGINE_CODES[err.code]
        : err instanceof DecisionForbiddenError
          ? // Not yours to decide is FORBIDDEN, as ExpenseOS's `resolveDecideAccess` answers;
            // a task that has gone is NOT_FOUND.
            err.code === 'TASK_NOT_FOUND'
            ? 'NOT_FOUND'
            : 'FORBIDDEN'
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

/**
 * w2-02a: one approver's decision on one task — APPROVED, REJECTED or RETURNED — on
 * VeloExpense's engine (d36). The engine re-checks eligibility, claims the task atomically,
 * advances or closes the run, moves the report, hands an approved report to the ledger,
 * recomputes the budgets, audits and notifies the submitter with the note.
 */
export async function decideThroughEngine(
  db: TenantDb,
  taskId: string,
  actorId: string,
  decision: Decision,
  input: { note?: string | null; receiptViewAcknowledged?: boolean },
  mayOverride: boolean,
) {
  try {
    return await decideTask(queryRunnerOf(db), taskId, actorId, decision, input, {
      isAdmin: mayOverride,
    });
  } catch (err) {
    throw toTrpcError(err);
  }
}

/** w2-02a: hand a pending task to somebody else, with the reason (d36, d37). */
export async function reassignThroughEngine(
  db: TenantDb,
  taskId: string,
  actorId: string,
  toUserId: string,
  note: string,
  mayOverride: boolean,
) {
  try {
    return await reassignTask(queryRunnerOf(db), taskId, actorId, toUserId, note, {
      isAdmin: mayOverride,
    });
  } catch (err) {
    throw toTrpcError(err);
  }
}
