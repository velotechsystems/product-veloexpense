/**
 * What the app shell needs to know about the reader, resolved once per request.
 *
 * ── WHY IT CAN RETURN NULL, AND NEVER THROWS ────────────────────────────────
 *
 * The shell is drawn by the ROOT layout, so it wraps every page in the product —
 * including the ones that exist to say no (`app/forbidden.tsx`), the ones a
 * signed-out reader sees, and a deactivated employee's refusal. If resolving the
 * sidebar threw, a page whose own job was to render a sentence would render
 * Next's error boundary instead, and the reason would be the MENU. So:
 *
 *   · no session → `null`, and the layout draws no shell;
 *   · the session's email is not an active member here (`requireActor` refuses)
 *     → `null`, for the same reason — the page underneath gives its own refusal;
 *   · anything else fails → `null`, logged. A missing sidebar is a degraded page;
 *     a thrown one is no page at all.
 *
 * This is NOT an authorization decision and nothing reads it as one. Every page
 * still runs its own gate (`asMember`, `asAdminPage`); the menu only avoids
 * offering what the page would refuse — see `lib/nav/sections.ts`.
 *
 * ── THE BADGE ───────────────────────────────────────────────────────────────
 *
 * The count beside Approvals is `listInbox`, the same query the inbox page runs,
 * capped at 100 so it costs the same whatever the backlog (ExpenseOS's sidebar
 * reuses its queue's query for the same reason — UAT A6: an approver had no
 * reason to open the queue because nothing said there was anything in it).
 * An employee with nothing to approve gets an empty list, not a refusal.
 *
 * `cache()`d per request: the layout and anything else that asks share one
 * transaction's worth of reads.
 */
import { cache } from 'react';
import { auth } from '@/auth';
import { asMember } from '@/lib/auth/admin-guard';
import { ForbiddenError, isActiveAdmin } from '@/lib/auth/actor';
import { getBranding } from '@/lib/branding/service';
import { isModuleEnabled } from '@/lib/modules/service';
import { listInbox } from '@/lib/approvals/inbox';
import { SECTIONS } from '@/lib/nav/sections';

export interface NavContext {
  isAdmin: boolean;
  enabledModules: ReadonlySet<string>;
  pendingApprovals: number;
  name: string;
  email: string;
  organizationName: string;
}

/** Every module code a nav item is gated on, read from the menu itself. */
const GATED_MODULES = [
  ...new Set(SECTIONS.flatMap((s) => s.items.map((i) => i.module).filter((m): m is string => !!m))),
];

export const navContext = cache(async function navContext(): Promise<NavContext | null> {
  const session = await auth();
  if (!session?.user?.email) return null;
  try {
    return await asMember(async (tx, actor) => {
      const isAdmin = isActiveAdmin(actor);
      const enabled = new Set<string>();
      // Only an admin sees a module-gated item, so only an admin pays for the reads.
      if (isAdmin) {
        for (const code of GATED_MODULES) {
          if (await isModuleEnabled(tx, code)) enabled.add(code);
        }
      }
      const inbox = await listInbox(tx, actor.id, { limit: 100 });
      return {
        isAdmin,
        enabledModules: enabled,
        pendingApprovals: inbox.length,
        name: actor.display_name ?? actor.email,
        email: actor.email,
        organizationName: (await getBranding(tx)).name,
      };
    });
  } catch (err) {
    // A refused membership is expected here (see the header) and is not logged;
    // anything else is a fault worth seeing, but still not worth a broken page.
    if (!(err instanceof ForbiddenError)) {
      console.error('navContext: shell context unavailable', err);
    }
    return null;
  }
});
