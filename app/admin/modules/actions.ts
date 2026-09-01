'use server';

/**
 * VX4-1 part 2 — /admin/modules.
 *
 * The one admin screen that is NOT gated on a module, for the obvious reason: it
 * is how a module gets turned on. Admin-only through the same `asAdmin` gate every
 * other admin surface uses.
 *
 * Until this screen existed, an entitlement could only be created with SQL — fine
 * while `scripts/seed.mjs` provisions the demo tenants, and the first thing a real
 * second customer would have needed.
 */
import { redirect } from 'next/navigation';
import { auth } from '@/auth';
import { withCurrentOrg } from '@/lib/tenant/request';
import { getEmployeeByEmail, type EmployeeRow } from '@/lib/employees/service';
import { listEntitlements, setEntitlement } from '@/lib/modules/service';
import { requeueWaitingPosts } from '@/lib/integrations/post-outbox';
import type { QueryRunner } from '@/lib/db/client';

const PAGE = '/admin/modules';

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

export async function getModulesPage() {
  return asAdmin(async (tx) => ({ entitlements: await listEntitlements(tx) }));
}

export async function toggleFromForm(form: FormData) {
  const code = String(form.get('code') ?? '').trim();
  const enable = String(form.get('enable') ?? '') === 'true';
  try {
    await asAdmin(async (tx, actor) => {
      await setEntitlement(tx, code, enable, {
        id: actor.id,
        name: actor.display_name ?? actor.email,
        role: actor.role,
      });
      // TURNING A MODULE ON MOVES THE QUEUE, in the same transaction.
      //
      // A post skipped for a configuration reason backs off an hour without
      // burning an attempt, so without this an admin who fixes the configuration
      // watches nothing happen while the screen says the queue "drains on its own
      // once the module is back on". The e2e asserted that sentence and caught it
      // being false.
      //
      // Orchestrated HERE rather than inside `setEntitlement`, deliberately: it is
      // a decision about what an admin pressing a button should experience, not an
      // invariant of the entitlement itself — a seed or a provisioning job enabling
      // a module has nothing queued to nudge.
      if (enable) await requeueWaitingPosts(tx);
    });
  } catch (err) {
    if (
      typeof err === 'object' &&
      err !== null &&
      'digest' in err &&
      typeof (err as { digest: unknown }).digest === 'string' &&
      (err as { digest: string }).digest.startsWith('NEXT_REDIRECT')
    ) {
      throw err;
    }
    redirect(
      `${PAGE}?error=${encodeURIComponent(err instanceof Error ? err.message : String(err))}`,
    );
  }
  redirect(`${PAGE}?changed=${encodeURIComponent(code)}`);
}
