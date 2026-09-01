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
    // The queue nudge that used to live here now lives in `setEntitlement`, so the
    // OAuth callback and a ledger connect get it too — see the note on
    // `requeueWaitingPosts`.
    await asAdmin((tx, actor) =>
      setEntitlement(tx, code, enable, {
        id: actor.id,
        name: actor.display_name ?? actor.email,
        role: actor.role,
      }),
    );
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
