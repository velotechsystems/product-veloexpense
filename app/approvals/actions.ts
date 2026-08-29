'use server';
/**
 * VX2-4 — the approver's actions.
 *
 * Gated as a MEMBER, not an admin: being an eligible approver of a pending task
 * IS the authorization, and there is no blanket "approve" permission. That is
 * ExpenseOS's model too, and their `reportApproval.ts` says it best — "being an
 * eligible (assigned or claimable) approver of a PENDING task on the report's
 * running instance IS the authorization".
 *
 * The decision itself goes through `engine.decide`, which calls
 * `assertCanDecide` as its first statement. So the permission question is asked
 * in exactly one place, by both the page that renders the buttons and the
 * mutation behind them (GAP-AUDIT AP-15).
 */
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { auth } from '@/auth';
import { withCurrentOrg } from '@/lib/tenant/request';
import type { QueryRunner } from '@/lib/db/client';
import { requireActor } from '@/lib/auth/actor';
import type { EmployeeRow } from '@/lib/employees/service';
import { listInbox } from '@/lib/approvals/inbox';
import { decide, type Decision } from '@/lib/approvals/engine';

const PAGE = '/approvals';

async function asActor<T>(fn: (tx: QueryRunner, actor: EmployeeRow) => Promise<T>): Promise<T> {
  const session = await auth();
  const email = session?.user?.email;
  if (!email) throw new Error('unauthenticated');
  return withCurrentOrg(async (tx) => fn(tx, await requireActor(tx, email)));
}

export async function getInbox() {
  return asActor(async (tx, actor) => ({
    tasks: await listInbox(tx, actor.id, { isAdmin: actor.role === 'ADMIN' }),
    actor: { id: actor.id, name: actor.display_name ?? actor.email, role: actor.role },
  }));
}

const DECISIONS: readonly Decision[] = ['APPROVED', 'REJECTED', 'RETURNED'];

function text(form: FormData, key: string): string | null {
  const value = form.get(key);
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * One entry point for all three outcomes. The three buttons are one form with
 * `name="decision"` and different `value`s — no client JS, and no way to submit
 * a decision the server does not recognise.
 */
export async function decideFromForm(form: FormData) {
  const taskId = text(form, 'taskId');
  const reportId = text(form, 'reportId');
  const back = reportId ? `/expenses/${reportId}` : PAGE;
  try {
    const decision = text(form, 'decision');
    if (!decision || !DECISIONS.includes(decision as Decision)) {
      throw new Error('pick approve, return, or reject');
    }
    if (!taskId) throw new Error('taskId is required');
    await asActor((tx, actor) =>
      decide(
        tx,
        taskId,
        actor.id,
        decision as Decision,
        {
          note: text(form, 'note'),
          receiptViewAcknowledged: form.get('receiptViewAcknowledged') !== null,
        },
        { isAdmin: actor.role === 'ADMIN' },
      ),
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Something went wrong';
    redirect(`${back}?error=${encodeURIComponent(message)}`);
  }
  revalidatePath(PAGE);
  if (reportId) revalidatePath(`/expenses/${reportId}`);
  redirect(back);
}
