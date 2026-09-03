'use server';
/**
 * VX4-6b — /admin/analytics.
 *
 * ADMIN only, role read from `app_user` inside the tenant transaction, same gate
 * as every other /admin surface.
 *
 * ── Why /admin and not /analytics ──────────────────────────────────────────
 *
 * This screen shows the WHOLE TENANT's spend. ExpenseOS sizes that per reader —
 * `view.own | reportingChain | all` — and AN-8 is the note on how that went: the
 * permission that SIZES the data and the one that OPENS the screen are separate,
 * `ap-clerk` holds `viewAll` without `dashboardView`, so a permission nobody can
 * currently exercise grants company-wide spend the moment the gate changes. "A
 * permission nobody can exercise is a permission nobody has tested."
 *
 * We have one axis — role — so this is ADMIN-only and there is no scope model to
 * get wrong. A per-reader scope is a real feature and it is deliberately NOT
 * invented here; when it arrives it belongs in the service beside the module
 * gate, as a predicate, never as a role check that then queries everything.
 *
 * Every export is an `export async function`: a `'use server'` module registers
 * every export as a server action, and one it cannot wrap makes it register NONE
 * of them (VX2-8's dead form on /approve).
 */
import { auth } from '@/auth';
import { errorParam } from '@/lib/errors/domain';
import { withCurrentOrg } from '@/lib/tenant/request';
import type { QueryRunner } from '@/lib/db/client';
import { getEmployeeByEmail, type EmployeeRow } from '@/lib/employees/service';
import { isModuleEnabled } from '@/lib/modules/service';
import { AnalyticsError, spendSummary, type SpendSummary } from '@/lib/analytics/service';

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

/**
 * NOT EXPORTED, and `npm run check:actions` is why.
 *
 * The header above says every export in a `'use server'` module has to be an
 * `export async function` — and the first version of this file exported this
 * interface three lines below saying so. The guard refused the build in the exact
 * words the rule is written in: "Next registers each export as a server action.
 * It cannot wrap this one, and rather than failing the build it registers NONE of
 * the module's actions — so every form on the page posts an id the server has
 * never heard of." That is VX2-8's dead form on /approve, and it is the reason the
 * check exists at all.
 *
 * The page needs no annotation: it destructures the return value, and TypeScript
 * infers this shape through `getAnalyticsPage`.
 */
interface AnalyticsPage {
  moduleEnabled: boolean;
  summary: SpendSummary | null;
  /** A sentence, when the range itself was the problem. */
  problem: string | null;
}

/**
 * The page's one read.
 *
 * `from`/`to` come off the URL, so the view is linkable and there is no client
 * state anywhere. THE SCREEN SUPPLIES A DEFAULT AND THE SERVICE STILL REFUSES
 * ONE — those are different things, and conflating them is how AN-10 happened:
 * their defect is an UNBOUNDED query (both range ends optional, the home page
 * passing neither, every login aggregating all history). A bounded default chosen
 * by a screen is not that. The service refusing to invent one is what guarantees
 * no other caller can reintroduce it.
 */
export async function getAnalyticsPage(from?: string, to?: string): Promise<AnalyticsPage> {
  return asAdmin(async (tx) => {
    const moduleEnabled = await isModuleEnabled(tx, 'analytics');
    if (!moduleEnabled) return { moduleEnabled, summary: null, problem: null };
    try {
      return {
        moduleEnabled,
        summary: await spendSummary(tx, { from: from ?? yearStart(), to: to ?? today() }),
        problem: null,
      };
    } catch (err) {
      // A bad range is the reader's typo, not a crash: the form comes back with a
      // sentence rather than the Next error boundary.
      if (err instanceof AnalyticsError) {
        // The CODE, rendered by `ErrorBanner` in the reader's locale, rather than
        // the diagnostic. This one never went through `?error=` — it is returned
        // as a prop — so it was outside the gate's reach as well.
        return { moduleEnabled, summary: null, problem: errorParam(err, 'admin/analytics') };
      }
      throw err;
    }
  });
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function yearStart(): string {
  return `${new Date().getUTCFullYear()}-01-01`;
}
