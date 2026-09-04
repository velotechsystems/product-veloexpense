'use server';

/**
 * VX4-7 part 1 — /admin/locale, the company's language and clock.
 *
 * Not gated on a module, for branding's reason: this is not something a tenant
 * buys, it is what the product reads like. Admin-only through the same gate
 * every other admin surface uses.
 *
 * EVERY REFUSAL COMES FROM THE SERVICE OR THE DATABASE. This file validates no
 * tag and no zone — it catches the error and puts its sentence on the screen.
 * MT-3's rule kept rather than restated: the moment this file grows its own
 * locale check there are two answers to "is this locale allowed", and the seed,
 * an HRIS importer and Phase 5's provisioning will use the other one.
 *
 * NOTHING HERE IS EXPORTED THAT IS NOT AN ACTION. `check:actions` exists because
 * of VX2-8's `/approve` bug: Next registers every export of a `'use server'`
 * module as a server action, cannot wrap a type, and rather than failing the
 * build registers NONE of them — so every form on the page posts an id the
 * server has never heard of. The view type below is deliberately not exported
 * and the page infers it.
 */
import { revalidatePath } from 'next/cache';
import { errorParam } from '@/lib/errors/domain';
import { redirect } from 'next/navigation';
import { type EmployeeRow } from '@/lib/employees/service';
import type { QueryRunner } from '@/lib/db/client';
import { localeName, SUPPORTED_LOCALES } from '@/lib/i18n/locales';
import { getOrgDefaults, listTimeZones, setOrgDefaults } from '@/lib/i18n/service';
import { asAdmin, asAdminPage } from '@/lib/auth/admin-guard';

const PAGE = '/admin/locale';

const auditActor = (a: EmployeeRow) => ({
  id: a.id,
  name: a.display_name ?? a.email,
  role: a.role,
});

interface LocalePageView {
  locale: string;
  timeZone: string;
  locales: readonly string[];
  zones: string[];
  /**
   * EVERY locale rendered, not just the saved one — one row per option, the same
   * instant and the same amount in each.
   *
   * The first version of this screen previewed only the CURRENT setting and
   * carried a paragraph saying "the sample shows the setting currently saved,
   * not the one selected above — save to see it change". Looking at the rendered
   * page is what made that unacceptable: it is a caveat apologising for the
   * screen instead of a screen that works. The product ships no client JS, so a
   * `<select>` cannot update a preview live — but nothing stopped rendering all
   * three up front, which is better than a live preview anyway, because the
   * question an admin actually has is comparative.
   *
   * And comparative is precisely IL-1's point: upstream shipped `en` for years
   * believing it was Canadian English. `$10,799.00` beside `CA$10,799.00` in two
   * adjacent rows is that entire finding, visible in one glance, on the screen
   * where somebody can act on it. 0023 put a contrast ratio on the branding
   * screen for the same reason.
   */
  samples: { locale: string; name: string; date: string; money: string; current: boolean }[];
  /** The saved zone the dates above are rendered in. */
  timeZoneInUse: string;
}

/**
 * One fixed instant: 2026-03-04T02:30Z.
 *
 * 02:30 UTC is the PREVIOUS DAY everywhere in North America, so the rendered
 * date moves when the zone changes. A preview whose date never moved would make
 * the zone setting look cosmetic, which is the opposite of true — it is the
 * setting that decides whether a report approved on the 4th reads as the 3rd.
 */
const SAMPLE_INSTANT = new Date(Date.UTC(2026, 2, 4, 2, 30));

export async function getLocalePage(): Promise<LocalePageView> {
  return asAdminPage(async (tx) => {
    const defaults = await getOrgDefaults(tx, await orgIdOf(tx));
    const zones = await listTimeZones(tx);
    return {
      locale: defaults.locale,
      timeZone: defaults.timeZone,
      locales: SUPPORTED_LOCALES,
      zones,
      timeZoneInUse: defaults.timeZone,
      samples: SUPPORTED_LOCALES.map((locale) => ({
        locale,
        name: localeName(locale),
        date: new Intl.DateTimeFormat(locale, {
          dateStyle: 'medium',
          timeStyle: 'short',
          timeZone: defaults.timeZone,
        }).format(SAMPLE_INSTANT),
        money: new Intl.NumberFormat(locale, { style: 'currency', currency: 'CAD' }).format(10799),
        current: locale === defaults.locale,
      })),
    };
  });
}

/**
 * The tenant's own id, from the transaction's context rather than from the
 * session.
 *
 * `withCurrentOrg` has already set `app.current_org`, so asking the transaction
 * is asking the thing that actually scopes every other query on this request. A
 * session-derived id could disagree with it after a re-auth, and the direction it
 * would disagree in is the one where an admin writes another tenant's row.
 */
async function orgIdOf(tx: QueryRunner): Promise<string> {
  const { rows } = await tx.query<{ id: string | null }>(
    `SELECT NULLIF(current_setting('app.current_org', true), '')::uuid AS id`,
  );
  const id = rows[0]?.id;
  if (!id) throw new Error('no tenant context');
  return id;
}

/** Next's redirect() throws a control-flow error that must not be swallowed. */
function rethrowRedirect(err: unknown): void {
  if (
    typeof err === 'object' &&
    err !== null &&
    'digest' in err &&
    typeof (err as { digest: unknown }).digest === 'string' &&
    (err as { digest: string }).digest.startsWith('NEXT_REDIRECT')
  ) {
    throw err;
  }
}

export async function saveLocaleFromForm(form: FormData): Promise<never> {
  const locale = String(form.get('locale') ?? '');
  const timeZone = String(form.get('timeZone') ?? '');
  try {
    await asAdmin(async (tx, actor) => {
      const orgId = await orgIdOf(tx);
      await setOrgDefaults(tx, orgId, auditActor(actor), { locale, timeZone });
    });
  } catch (err) {
    rethrowRedirect(err);
    redirect(
      `${PAGE}?error=${encodeURIComponent(errorParam(err, 'admin/locale'))}`,
    );
  }
  // `revalidatePath('/', 'layout')` — the ROOT layout, not this page, and the
  // e2e is what proved it necessary. Next preserves a layout across the soft
  // navigation a server action's `redirect()` performs, so the page's own sample
  // updated to the new locale while `<html lang>` on the very same response
  // still said the old one. That is not cosmetic: `lang` is what a screen reader
  // picks its voice from, and it would have stayed stale for the whole session,
  // because every client-side navigation after it also keeps the root layout.
  // Invalidating the layout is what makes `readerPrefs()` run again.
  revalidatePath('/', 'layout');
  redirect(`${PAGE}?changed=1`);
}
