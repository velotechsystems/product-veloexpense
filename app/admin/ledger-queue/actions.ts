'use server';
/**
 * VX3-4 — the ledger posting queue: what went, what failed, what needs a person.
 *
 * ADMIN only, same gate as every other /admin surface. Every export is an
 * `export async function` — see `npm run check:actions`.
 */
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { auth } from '@/auth';
import { withCurrentOrg } from '@/lib/tenant/request';
import type { QueryRunner } from '@/lib/db/client';
import { getEmployeeByEmail, type EmployeeRow } from '@/lib/employees/service';
import { cancelPost, listQueue, queueSummary, retryNow } from '@/lib/integrations/post-outbox';
import { postOne } from '@/lib/integrations/dispatch';
import { resolveCapability } from '@/lib/integrations/service';

const PAGE = '/admin/ledger-queue';

async function asAdmin<T>(fn: (tx: QueryRunner, actor: EmployeeRow) => Promise<T>): Promise<T> {
  const session = await auth();
  const email = session?.user?.email;
  if (!email) throw new Error('unauthenticated');
  return withCurrentOrg(async (tx) => {
    const actor = await getEmployeeByEmail(tx, email);
    if (!actor) throw new Error('forbidden: no employee record in this organization');
    if (actor.role !== 'ADMIN' || actor.deleted_at !== null) {
      throw new Error('forbidden: admin role required');
    }
    return fn(tx, actor);
  });
}

export async function getQueuePage() {
  return asAdmin(async (tx) => ({
    rows: await listQueue(tx),
    summary: await queueSummary(tx),
    // Whether anything can post at all. A queue full of PENDING rows with no
    // connected ledger is a configuration problem, not a backlog, and the
    // difference should be on the screen rather than inferred.
    connected: (await resolveCapability(tx, 'POST_EXPENSE_REPORT')) !== null,
  }));
}

function required(form: FormData, key: string): string {
  const value = form.get(key);
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${key} is required`);
  return value.trim();
}

function isRedirect(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'digest' in err &&
    typeof (err as { digest: unknown }).digest === 'string' &&
    (err as { digest: string }).digest.startsWith('NEXT_REDIRECT')
  );
}

async function guarded(fn: () => Promise<void>) {
  try {
    await fn();
  } catch (err) {
    if (isRedirect(err)) throw err;
    const message = err instanceof Error ? err.message : 'Something went wrong';
    redirect(`${PAGE}?error=${encodeURIComponent(message)}`);
  }
  revalidatePath(PAGE);
  redirect(PAGE);
}

export async function retryFromForm(form: FormData) {
  await guarded(async () => {
    await asAdmin((tx) => retryNow(tx, required(form, 'id')));
  });
}

export async function cancelFromForm(form: FormData) {
  await guarded(async () => {
    const reason = (form.get('reason') as string | null)?.trim();
    await asAdmin((tx) =>
      cancelPost(tx, required(form, 'id'), reason || 'withheld by an administrator'),
    );
  });
}

/**
 * Post one row now, rather than waiting for the poller.
 *
 * Goes through `postOne`, the same function the drain route uses, so the path an
 * operator exercises is the path that ships — VX1-9's lesson about MemoryStorage
 * was that a test-only (or screen-only) path proves nothing about the real one.
 */
export async function sendNowFromForm(form: FormData) {
  await guarded(async () => {
    const id = required(form, 'id');
    const orgId = await asAdmin(async (tx) => {
      const r = await tx.query(
        `SELECT organization_id FROM integration_post WHERE id = $1`,
        [id],
      );
      if (r.rows.length === 0) throw new Error('no such queued post');
      return r.rows[0].organization_id as string;
    });
    await postOne(orgId, id);
  });
}
