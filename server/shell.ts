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
import { MemberRefusal, resolveTenantMember, type Session } from '@/server/trpc';

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

/**
 * f04 — the shell, and when there is none for a signed-in person who IS on this tenant's
 * books, why: deactivated, or access turned off. The root layout shows that person a
 * refusal with a way to sign out (app/account-unavailable.tsx) instead of rendering pages
 * that cannot work for them — a blank dashboard, or `forbidden.tsx`'s "you do not
 * administer this organization", which is not what happened. ExpenseOS signs such a person
 * out (its session callback returns null on `deletedAt`); VeloExpense's shared auth kit has
 * no such hook, so the layout says it and offers the sign-out.
 */
export interface ShellState {
  shell: ShellContext | null;
  refusal: MemberRefusal['reason'] | null;
}

export const shellState = cache(async function shellState(): Promise<ShellState> {
  const authSession = await auth();
  const email = authSession?.user?.email ?? null;
  const organizationId =
    (authSession?.user as { organizationId?: string } | undefined)?.organizationId ?? null;
  if (!email || !organizationId) return { shell: null, refusal: null };
  try {
    const hostSlug = await hostTenantSlug();
    const shell = await withTenantDb(organizationId, async (tx) => {
      const { session, rbac } = await resolveTenantMember(tx, { email, organizationId }, hostSlug);
      const canSeeOthers = await canSeeOthersFor(rbac);
      const activeModules = await activeModuleSlugs();
      const organizationName = await withOrg(organizationId, async (otx) => (await getBranding(otx)).name);
      return { user: session.user, rbac, canSeeOthers, activeModules, organizationName };
    });
    return { shell, refusal: null };
  } catch (err) {
    // A refused membership is expected (see the header) and is not logged.
    if (err instanceof TRPCError && err.code === 'FORBIDDEN') {
      return { shell: null, refusal: err.cause instanceof MemberRefusal ? err.cause.reason : null };
    }
    console.error('shellContext: shell unavailable', err);
    return { shell: null, refusal: null };
  }
});

export const shellContext = cache(async function shellContext(): Promise<ShellContext | null> {
  return (await shellState()).shell;
});
