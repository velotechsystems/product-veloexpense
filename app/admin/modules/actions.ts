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
import { errorParam } from '@/lib/errors/domain';
import { listEntitlements, setEntitlement } from '@/lib/modules/service';
import { asAdmin, asAdminPage } from '@/lib/auth/admin-guard';

const PAGE = '/admin/modules';

export async function getModulesPage() {
  return asAdminPage(async (tx) => ({ entitlements: await listEntitlements(tx) }));
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
        role: actor.role_label,
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
      `${PAGE}?error=${encodeURIComponent(errorParam(err, 'admin/modules'))}`,
    );
  }
  redirect(`${PAGE}?changed=${encodeURIComponent(code)}`);
}
