import type { RbacUser } from '@expenseos/rbac';
import { TRPCError } from '@trpc/server';
import { cache } from 'react';
import { canSeeOthersFor } from '@/app/(app)/canSeeOthers';
import { auth } from '@/auth';
import { getBranding } from '@/lib/branding/service';
import { withTenantDb } from '@/lib/db/prisma';
import { hostTenantSlug } from '@/lib/tenant/request';
import { withOrg } from '@/lib/tenant/context';
import { activeModuleSlugs } from '@/server/platform/modules';
import { resolveTenantMember, type Session } from '@/server/trpc';

/**
 * VeloExpense: what ExpenseOS's `(app)/layout.tsx` resolves for its shell, for VeloExpense's
 * root layout — the session, the `RbacUser`, `canSeeOthers` and the active modules — plus
 * the organization's name, which ExpenseOS (one tenant) has no need of.
 *
 * The reader is resolved by `resolveTenantMember`, the function the tRPC `tenant`
 * middleware uses, so the menu offers exactly what the procedures behind it will allow.
 *
 * ── NULL, NOT A THROW ────────────────────────────────────────────────────────
 *
 * ExpenseOS's layout wraps only its `(app)` group, and redirects a signed-out reader. Here
 * the ROOT layout draws the shell, so it wraps every page — the sign-in page, a
 * deactivated employee's refusal, `app/forbidden.tsx`. A menu that threw would take those
 * pages down with it, so (as the #147 shell's `navContext` did):
 *
 *   · no session, or not an active member here → `null`, and the layout draws no shell;
 *   · anything else fails → `null`, logged.
 *
 * This is not an authorization decision. Every page and procedure still runs its own gate.
 *
 * `cache()`d per request, like `canSeeOthers` — a page that needs the same facts shares them.
 */
export interface ShellContext {
  user: Session['user'];
  rbac: RbacUser;
  canSeeOthers: boolean;
  activeModules: ReadonlySet<string>;
  organizationName: string;
}

export const shellContext = cache(async function shellContext(): Promise<ShellContext | null> {
  const authSession = await auth();
  const email = authSession?.user?.email ?? null;
  const organizationId =
    (authSession?.user as { organizationId?: string } | undefined)?.organizationId ?? null;
  if (!email || !organizationId) return null;
  try {
    const hostSlug = await hostTenantSlug();
    return await withTenantDb(organizationId, async (tx) => {
      const { session, rbac } = await resolveTenantMember(tx, { email, organizationId }, hostSlug);
      const canSeeOthers = await canSeeOthersFor(rbac);
      const activeModules = await activeModuleSlugs();
      const organizationName = await withOrg(organizationId, async (otx) => (await getBranding(otx)).name);
      return { user: session.user, rbac, canSeeOthers, activeModules, organizationName };
    });
  } catch (err) {
    // A refused membership is expected (see the header) and is not logged.
    if (!(err instanceof TRPCError && err.code === 'FORBIDDEN')) {
      console.error('shellContext: shell unavailable', err);
    }
    return null;
  }
});
