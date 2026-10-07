/**
 * VX2-4 — the decision panel on a report an approver may act on.
 *
 * Rendered only when `getDecidableTask` returned a task id, so the panel and the
 * mutation behind it ask the same question of the same function. ExpenseOS
 * rendered its Approve button from a role check while the mutation asked the
 * engine, and once the engine began refusing a requester their own subject the
 * button failed when pressed (GAP-AUDIT AP-15).
 *
 * Three outcomes, one form: `name="decision"` on three submit buttons. No client
 * JS, and no way to post an outcome the server does not recognise.
 */
import { Button } from '@/components/ui/button';
import { decideFromForm } from '@/app/approvals/actions';
import type { InboxTask } from '@/lib/approvals/inbox';
import { cardClass, labelClass } from '../ui';
import { Textarea } from '@/components/ui/textarea';

export function ApprovalPanel({
  taskId,
  reportId,
  step,
  totalSteps,
  rungName,
  requireReceiptViewAck,
  route,
  coveringFor,
  receiptCount,
}: {
  taskId: string;
  reportId: string;
  step: number;
  totalSteps: number;
  rungName: string | null;
  requireReceiptViewAck: boolean;
  route?: InboxTask['route'];
  coveringFor?: string | null;
  receiptCount: number;
}) {
  return (
    <section className={`${cardClass} flex flex-col gap-4 border-primary/40 p-5`}>
      <div className="flex flex-col gap-1">
        <h2 className="text-lg leading-7 font-semibold">Your decision</h2>
        <p className="text-sm text-muted-foreground">
          {rungName ? <strong>{rungName}</strong> : 'Approval'} — step {step} of {totalSteps}.
          {route === 'ROLE_POOL'
            ? ' Anyone holding this role can decide it, so somebody else may get there first.'
            : null}
          {route === 'DELEGATED' && coveringFor
            ? ` You are covering for ${coveringFor}.`
            : null}
        </p>
      </div>

      <form action={decideFromForm} className="flex flex-col gap-3">
        <input type="hidden" name="taskId" value={taskId} />
        <input type="hidden" name="reportId" value={reportId} />

        <div className="flex flex-col gap-1.5">
          <label className={labelClass} htmlFor="decision-note">
            Note {requireReceiptViewAck ? '' : '(optional)'}
          </label>
          <Textarea
            id="decision-note"
            name="note"
            rows={2}
            placeholder="Why you approved, returned, or refused it"
          />
        </div>

        {requireReceiptViewAck ? (
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" name="receiptViewAcknowledged" className="mt-1" />
            <span>
              I reviewed the {receiptCount === 0 ? 'receipts' : `${receiptCount} receipt${receiptCount === 1 ? '' : 's'}`} on
              this report.
              {receiptCount === 0 ? (
                <strong className="ml-1 text-destructive">
                  There are none attached — approving records that.
                </strong>
              ) : null}
            </span>
          </label>
        ) : null}

        <div className="flex flex-wrap gap-2">
          {/* Approve is the affirmative act and needs the acknowledgement above;
              returning or refusing does not, because neither claims the evidence
              was reviewed. The SERVER enforces that, not this markup. */}
          <Button type="submit" name="decision" value="APPROVED">
            Approve
          </Button>
          <Button type="submit" name="decision" value="RETURNED" variant="outline">
            Return for changes
          </Button>
          <Button type="submit" name="decision" value="REJECTED" variant="outline">
            Reject
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Returning sends it back to {'the submitter'} as a draft and ends this approval. Rejecting is
          final.
        </p>
      </form>
    </section>
  );
}
