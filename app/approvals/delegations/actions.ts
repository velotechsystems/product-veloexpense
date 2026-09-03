'use server';
/**
 * VX2-5 — delegation actions.
 *
 * Gated as a MEMBER, not an admin, and that is deliberate. Arranging cover for
 * your own approvals is self-service: the person who knows they are away is the
 * person who should be able to say so, and making it an admin errand is how a
 * report sits in an empty inbox for a fortnight (GAP-AUDIT AP-5 measured that
 * happening on 11% of ExpenseOS's users).
 *
 * The two privileged cases — naming somebody ELSE as the delegator, and revoking
 * a delegation that is not yours — are checked inside `lib/approvals/delegations`
 * rather than here, so the rule is asked in one place by both the page that
 * renders the controls and the mutation behind them (the same arrangement as
 * VX2-4's `assertCanDecide`, GAP-AUDIT AP-15). This file adds no permission
 * logic of its own; if it did, the page and the action could disagree.
 */
import { redirect } from 'next/navigation';
import { errorParam } from '@/lib/errors/domain';
import { revalidatePath } from 'next/cache';
import { auth } from '@/auth';
import { withCurrentOrg } from '@/lib/tenant/request';
import type { QueryRunner } from '@/lib/db/client';
import { requireActor } from '@/lib/auth/actor';
import type { EmployeeRow } from '@/lib/employees/service';
import type { DelegationScope } from '@/lib/approvals/tiers';
import {
  createDelegation,
  listDelegations,
  onwardDelegation,
  revokeDelegation,
  type DelegationRow,
} from '@/lib/approvals/delegations';

const PAGE = '/approvals/delegations';

async function asActor<T>(fn: (tx: QueryRunner, actor: EmployeeRow) => Promise<T>): Promise<T> {
  const session = await auth();
  const email = session?.user?.email;
  if (!email) throw new Error('unauthenticated');
  return withCurrentOrg(async (tx) => fn(tx, await requireActor(tx, email)));
}

/**
 * Not exported, deliberately. Next.js requires every export of a `'use server'`
 * module to be an async function; a type export is erased before that check runs,
 * but relying on that is a footgun the page does not need — it reads the shape
 * back with `Awaited<ReturnType<typeof getDelegationsPage>>` instead.
 */
interface DelegationCard extends DelegationRow {
  /** True when this is one the actor gave (as opposed to received). */
  given: boolean;
  /**
   * The stand-in's OWN active delegation, if they have one.
   *
   * Computed for every listed row rather than only at creation time, because the
   * onward delegation is usually created AFTERWARDS — Alice arranges cover with
   * Bob on Monday and Bob goes away on Wednesday — and a warning that only fired
   * at creation would never fire in the case that actually happens.
   */
  onwardTo: string | null;
}

interface Person {
  id: string;
  name: string;
}

export async function getDelegationsPage() {
  return asActor(async (tx, actor) => {
    const isAdmin = actor.role === 'ADMIN';
    const rows = await listDelegations(tx, {
      // An admin sees the whole tenant, because they are the person who fixes a
      // delegation nobody else can reach — the delegator is away, which is the
      // entire premise. Everyone else sees only their own two sides.
      forUserId: isAdmin ? undefined : actor.id,
      includeRevoked: true,
    });

    const cards: DelegationCard[] = [];
    for (const row of rows) {
      cards.push({
        ...row,
        given: row.from_user_id === actor.id,
        onwardTo:
          row.active && !row.revoked_at
            ? ((await onwardDelegation(tx, row.to_user_id))?.toName ?? null)
            : null,
      });
    }

    const people = await tx.query(
      `SELECT id, COALESCE(display_name, email) AS name
         FROM app_user
        WHERE deleted_at IS NULL
          AND employee_status = 'ACTIVE'
        ORDER BY COALESCE(display_name, email)`,
    );

    return {
      cards,
      // Everyone active EXCEPT the actor: `delegation_not_self` refuses the pair
      // and `createDelegation` refuses it before that, so offering yourself is
      // offering an error.
      candidates: (people.rows as Person[]).filter((p) => p.id !== actor.id),
      // Only an admin may name a different delegator, so only an admin gets the
      // select. Non-admins get a hidden "me".
      delegators: isAdmin ? (people.rows as Person[]) : [],
      actor: { id: actor.id, name: actor.display_name ?? actor.email, role: actor.role, isAdmin },
    };
  });
}

/* ── mutations ─────────────────────────────────────────────────────────────── */

function text(form: FormData, key: string): string | null {
  const value = form.get(key);
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Run a mutation, turning a thrown message into the redirect that shows it.
 *
 * Returns the outcome rather than assigning to a captured variable: TypeScript
 * does not track an assignment made inside this callback, so a `let notice` set
 * in there narrows to `null` at the `if` below and the branch reads as dead.
 */
type Outcome<T> = { ok: true; value: T } | { ok: false; redirectTo: string };

async function guard<T>(run: () => Promise<T>): Promise<Outcome<T>> {
  try {
    return { ok: true, value: await run() };
  } catch (err) {
    const message = errorParam(err, 'approvals/delegations');
    return { ok: false, redirectTo: `${PAGE}?error=${encodeURIComponent(message)}` };
  }
}

export async function createDelegationFromForm(form: FormData) {
  const outcome = await guard(async () => {
    const toUserId = text(form, 'toUserId');
    if (!toUserId) throw new Error('choose who is standing in');
    const startsOn = text(form, 'startsOn');
    if (!startsOn) throw new Error('give the first day you are away');

    // `fromUserId` is submitted only by the admin form. Passing it through
    // unconditionally would mean a non-admin who forged the field gets a
    // FORBIDDEN from the lib — correct, but a confusing error about a field they
    // never saw. Reading it only when present keeps the ordinary path clean and
    // still leaves the lib as the thing that decides.
    const fromUserId = text(form, 'fromUserId');

    const row = await asActor((tx, actor) =>
      createDelegation(tx, actor, {
        fromUserId: fromUserId ?? undefined,
        toUserId,
        startsOn,
        // An empty end date is open-ended on purpose, not an omission: 0008
        // allows NULL for a standing stand-in.
        endsOn: text(form, 'endsOn'),
        scope: (text(form, 'scope') ?? 'ALL') as DelegationScope,
        note: text(form, 'note'),
      }),
    );

    // The one thing the page cannot work out for itself at this moment: the
    // stand-in has cover of their own, so the work stops at them (AP-16, one hop
    // never a chain). The list warns about this too, but saying it here means the
    // delegator reads it while they are still thinking about it.
    const onward = await asActor((tx) => onwardDelegation(tx, row.to_user_id));
    return onward
      ? `${row.to_name} has handed their own approvals to ${onward.toName}. ` +
          `Delegations do not chain — your approvals stop at ${row.to_name} and will wait there.`
      : null;
  });
  if (!outcome.ok) redirect(outcome.redirectTo);
  revalidatePath(PAGE);
  revalidatePath('/approvals');
  redirect(outcome.value ? `${PAGE}?notice=${encodeURIComponent(outcome.value)}` : PAGE);
}

export async function revokeDelegationFromForm(form: FormData) {
  const outcome = await guard(async () => {
    const id = text(form, 'delegationId');
    if (!id) throw new Error('delegationId is required');
    await asActor((tx, actor) => revokeDelegation(tx, actor, id));
  });
  if (!outcome.ok) redirect(outcome.redirectTo);
  revalidatePath(PAGE);
  revalidatePath('/approvals');
  redirect(PAGE);
}
