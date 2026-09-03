/**
 * VX2-8 — deciding from an emailed link.
 *
 * The LOGIC lives here rather than in `app/approve/actions.ts`, which keeps only
 * the form wrapper. Two reasons, and the second is the load-bearing one: it is the
 * house pattern (every domain rule in this codebase is in `lib/<domain>` with a
 * thin server action over it), and a `'use server'` module importing
 * `next/navigation` is awkward to exercise from a vitest suite — so the rules that
 * matter most in this ticket would have been the hardest ones to test.
 *
 * ── The three properties this file exists to hold ───────────────────────────
 *
 * 1. THE TOKEN AUTHENTICATES; IT DOES NOT AUTHORIZE. ExpenseOS's own header says
 *    it and it is the reason the feature is safe: "The token only authenticates
 *    the actor and binds one action to one task; the caller still re-runs
 *    canDecide + the atomic claim, so it never bypasses authorization." So this
 *    goes through `engine.decide`, which opens with `assertCanDecide`, exactly as
 *    the browser does. The token replaces the session cookie and nothing else.
 *
 *    The case that makes it matter: a link that has sat in a mailbox for four days
 *    is precisely when the world has moved — the approver may have been removed
 *    from the ladder, deactivated, or become the submitter's subordinate. All
 *    three are refused by the guard, and none of them is knowable from the token.
 *
 * 2. NOTHING HAPPENS ON A GET. The page renders a confirmation and the decision
 *    is a POST. Mail clients, link scanners and corporate security gateways all
 *    prefetch links in mail; a GET that approved would be approved by Outlook.
 *    This is the one place in the product where that distinction is load-bearing
 *    rather than good practice.
 *
 * 3. THE TENANT IS RESOLVED FROM THE TOKEN, AND NOTHING ELSE IS. The request has
 *    no session, so `withPlatformRead` finds which organization the token belongs
 *    to — and takes only that. Everything after runs inside `withOrg`. That rule
 *    is what makes a cross-tenant read driven by an untrusted value acceptable;
 *    see `lib/tenant/context.ts`.
 */
import { withOrg, withPlatformRead } from '@/lib/tenant/context';
import { userMessageOrGeneric, type UserMessage } from '@/lib/errors/domain';
import { formatMinor } from '@/lib/money';
import { decide, type Decision } from '@/lib/approvals/engine';
import {
  consumeActionToken,
  consumeTaskTokens,
  resolveTokenTenant,
  verifyActionToken,
} from '@/lib/notifications/action-tokens';

export type ApproveOutcome =
  | { kind: 'INVALID' }
  | {
      kind: 'READY';
      action: Decision;
      reportId: string;
      reportTitle: string;
      reportNumber: string | null;
      total: string;
      submitterName: string;
      recipientName: string;
      step: number;
      totalSteps: number;
      /** The rung asked the approver to confirm they reviewed the receipts. */
      requireReceiptViewAck: boolean;
      receiptCount: number;
    }
  | { kind: 'DONE'; action: Decision; reportId: string; reportTitle: string }
  // `reason` is a MESSAGE, not a sentence, since part 2c-2 — `/approve` encodes
  // it and renders it through `ErrorBanner` like every other refusal. Typed as
  // `UserMessage` rather than `string` so a code that does not exist is a
  // compile error here instead of a generic banner in production.
  | { kind: 'REFUSED'; reason: UserMessage; reportId: string | null };

/**
 * What a token is good for, without using it.
 *
 * Deliberately says as little as possible when a token is not valid: `INVALID`
 * covers unknown, expired, consumed and belonging-to-a-deleted-tenant, with no
 * distinction offered. There is nothing useful a legitimate recipient does with
 * "this token expired" that they do not do with "this link no longer works", and
 * the difference is a probe for anybody else.
 */
export async function inspectToken(rawToken: string): Promise<ApproveOutcome> {
  const tenant = await withPlatformRead((tx) => resolveTokenTenant(tx, rawToken));
  if (!tenant) return { kind: 'INVALID' };

  return withOrg(tenant.organizationId, async (tx): Promise<ApproveOutcome> => {
    // Re-verified INSIDE the tenant, under `tenant_isolation` rather than the
    // narrowed platform policy — see `verifyActionToken` on why both guards
    // exist.
    const token = await verifyActionToken(tx, rawToken);
    if (!token) return { kind: 'INVALID' };

    const r = await tx.query(
      `SELECT t.step, t.status AS task_status, t.receipt_view_acknowledged_at,
              q.total_steps, q.status AS run_status, q.policy_snapshot,
              rep.id AS report_id, rep.title, rep.number, rep.status AS report_status,
              rep.total_minor, rep.currency_code,
              COALESCE(sub.display_name, sub.email) AS submitter_name,
              COALESCE(rcp.display_name, rcp.email) AS recipient_name,
              (SELECT count(*)::int FROM receipt rc
                 JOIN expense e ON e.id = rc.expense_id
                WHERE e.report_id = rep.id AND rc.status = 'STORED') AS receipt_count
         FROM approval_task    t
         JOIN approval_request q   ON q.id = t.request_id
         JOIN expense_report   rep ON rep.id = q.report_id
         JOIN app_user         sub ON sub.id = rep.submitter_id
         JOIN app_user         rcp ON rcp.id = $2
        WHERE t.id = $1`,
      [token.taskId, token.recipientId],
    );
    const row = r.rows[0];
    if (!row) return { kind: 'INVALID' };

    if (row.task_status !== 'PENDING') {
      return {
        kind: 'REFUSED',
        // Codes, not sentences. These two were already written for a reader —
        // this file shapes them that way deliberately — which is precisely why
        // they were the strings on the email-approval page that nothing could
        // translate.
        reason: {
          code: row.task_status === 'CANCELLED' ? 'TASK_WITHDRAWN' : 'TASK_ALREADY_DECIDED',
        },
        reportId: row.report_id as string,
      };
    }

    const snapshot = row.policy_snapshot as { step: number; requireReceiptViewAck?: boolean }[];
    const step = snapshot.find((s) => s.step === (row.step as number));
    return {
      kind: 'READY',
      action: token.action === 'APPROVE' ? 'APPROVED' : 'REJECTED',
      reportId: row.report_id as string,
      reportTitle: row.title as string,
      reportNumber: row.number as string | null,
      total: formatMinor(row.total_minor as string, row.currency_code as string),
      submitterName: row.submitter_name as string,
      recipientName: row.recipient_name as string,
      step: row.step as number,
      totalSteps: row.total_steps as number,
      requireReceiptViewAck: step?.requireReceiptViewAck ?? false,
      receiptCount: row.receipt_count as number,
    };
  });
}

/**
 * Use the token. POST only.
 *
 * ORDER MATTERS HERE and it is worth stating: the token is consumed FIRST, then
 * the decision is made. Both are in one transaction, so a failed decision rolls
 * the consume back — but doing the consume first means two simultaneous clicks
 * cannot both reach `decide`, because `consumeActionToken`'s conditional write
 * lets exactly one of them through. `decide`'s own atomic claim would catch it
 * too; this makes the second click a clean "already used" rather than a race
 * decided deeper in.
 */
export async function decideFromToken(
  rawToken: string,
  opts: { receiptViewAcknowledged?: boolean } = {},
): Promise<ApproveOutcome> {
  const tenant = await withPlatformRead((tx) => resolveTokenTenant(tx, rawToken));
  if (!tenant) return { kind: 'INVALID' };

  // The catch is OUTSIDE `withOrg`, and that placement is the whole point.
  // Catching inside would COMMIT the transaction that had already consumed the
  // token, burning a single-use credential on a decision that did not happen —
  // so a recipient who forgot to tick the receipt box would find their link dead.
  // Letting it escape rolls the consume back with everything else.
  try {
    return await withOrg(tenant.organizationId, async (tx): Promise<ApproveOutcome> => {
      const token = await verifyActionToken(tx, rawToken);
      if (!token) return { kind: 'INVALID' };

      if (!(await consumeActionToken(tx, token.id))) return { kind: 'INVALID' };

      const rep = await tx.query(
        `SELECT rep.id, rep.title
           FROM approval_task t
           JOIN approval_request q ON q.id = t.request_id
           JOIN expense_report rep ON rep.id = q.report_id
          WHERE t.id = $1`,
        [token.taskId],
      );
      const reportId = (rep.rows[0]?.id as string | undefined) ?? '';
      const reportTitle = (rep.rows[0]?.title as string | undefined) ?? 'the report';

      const decision: Decision = token.action === 'APPROVE' ? 'APPROVED' : 'REJECTED';
      await decide(
        tx,
        token.taskId,
        token.recipientId,
        decision,
        {
          note: 'Decided from an emailed link.',
          receiptViewAcknowledged: opts.receiptViewAcknowledged === true,
        },
        // NOT `isAdmin: true`. The link carries no elevation — an admin clicking
        // their own emailed link gets exactly the authority the ladder gave them,
        // and the admin override stays something done deliberately from the
        // report, by somebody who is signed in.
        {},
      );

      // The other half of this task's link pair is now a credential with nothing
      // to do. Retire it rather than rely on `decide` refusing it.
      await consumeTaskTokens(tx, token.taskId);

      return { kind: 'DONE', action: decision, reportId, reportTitle };
    });
  } catch (err) {
    // The engine's own message, not a generic one: "this approval step requires
    // you to confirm you reviewed the receipts" is actionable and
    // "could not approve" is not. The token is intact, so the link still works.
    // VX4-7 part 2c-2. `err instanceof Error ? err.message : …` here fed
    // `/approve?error=…` from a LIB rather than an action, so `check:i18n`'s gate
    // — which only scanned `app/` — could not see it. `decide()` sits behind this
    // call and can throw anything the engine, the policy layer or `pg` throws,
    // and all of it went into a URL on a page a link from an EMAIL opens. The
    // gate now scans `lib/` too, because that is how this was found at all.
    const reason = userMessageOrGeneric(err, 'notifications/approve');
    return { kind: 'REFUSED', reason, reportId: await reportIdFor(rawToken) };
  }
}

/** The report a token points at, for a link on the refusal page. Best-effort. */
async function reportIdFor(rawToken: string): Promise<string | null> {
  try {
    const tenant = await withPlatformRead((tx) => resolveTokenTenant(tx, rawToken));
    if (!tenant) return null;
    return await withOrg(tenant.organizationId, async (tx) => {
      const token = await verifyActionToken(tx, rawToken);
      if (!token) return null;
      const r = await tx.query(
        `SELECT q.report_id FROM approval_task t
           JOIN approval_request q ON q.id = t.request_id
          WHERE t.id = $1`,
        [token.taskId],
      );
      return (r.rows[0]?.report_id as string | undefined) ?? null;
    });
  } catch {
    return null;
  }
}
