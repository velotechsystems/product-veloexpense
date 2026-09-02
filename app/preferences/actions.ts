'use server';

/**
 * VX4-7 part 1 — /preferences, one person's own language and clock.
 *
 * The counterpart to `/admin/locale`, and the rung above it in the precedence
 * chain. No admin gate: this writes the acting employee's OWN row and nothing
 * else, which is why `asActor` resolves the actor and then uses `actor.id` as
 * the subject rather than taking an id from the form. A `userId` form field here
 * would be an admin surface wearing a self-service screen's clothes.
 *
 * The three-state select is the shape `app/notifications/actions.ts` established
 * for preferences and its reason transfers exactly: "Three states, not two: on,
 * off, and 'no opinion' (which follows the default wherever it goes). The form's
 * third button is what makes the difference reachable rather than only
 * representable." Here the third state is the empty option, and it must submit
 * `''` — which `setUserPrefs` turns into NULL, so the reader follows the company
 * wherever it goes rather than being pinned to today's value.
 */
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { auth } from '@/auth';
import { withCurrentOrg } from '@/lib/tenant/request';
import { requireActor } from '@/lib/auth/actor';
import type { EmployeeRow } from '@/lib/employees/service';
import type { QueryRunner } from '@/lib/db/client';
import { SUPPORTED_LOCALES } from '@/lib/i18n/locales';
import { getOrgDefaults, getUserPrefs, listTimeZones, setUserPrefs } from '@/lib/i18n/service';

const PAGE = '/preferences';

async function asActor<T>(fn: (tx: QueryRunner, actor: EmployeeRow) => Promise<T>): Promise<T> {
  const session = await auth();
  const email = session?.user?.email;
  if (!email) throw new Error('unauthenticated');
  return withCurrentOrg(async (tx) => fn(tx, await requireActor(tx, email)));
}

async function orgIdOf(tx: QueryRunner): Promise<string> {
  const { rows } = await tx.query<{ id: string | null }>(
    `SELECT NULLIF(current_setting('app.current_org', true), '')::uuid AS id`,
  );
  const id = rows[0]?.id;
  if (!id) throw new Error('no tenant context');
  return id;
}

/** Not exported — see the note in /admin/locale/actions.ts on `check:actions`. */
interface PreferencesView {
  /** NULL when this reader follows the company. */
  locale: string | null;
  timeZone: string | null;
  /** What they get when they follow it, so the empty option can say so. */
  companyLocale: string;
  companyTimeZone: string;
  locales: readonly string[];
  zones: string[];
  /** The resolved pair, rendered — what this reader actually sees today. */
  sample: { date: string; money: string };
}

const SAMPLE_INSTANT = new Date(Date.UTC(2026, 2, 4, 2, 30));

export async function getPreferencesPage(): Promise<PreferencesView> {
  return asActor(async (tx, actor) => {
    const mine = await getUserPrefs(tx, actor.id);
    const company = await getOrgDefaults(tx, await orgIdOf(tx));
    const zones = await listTimeZones(tx);

    // Resolved rather than stored: the sample has to show what this reader sees,
    // which for somebody following the company is the company's answer.
    const locale = mine.locale ?? company.locale;
    const timeZone = mine.timeZone ?? company.timeZone;

    return {
      locale: mine.locale,
      timeZone: mine.timeZone,
      companyLocale: company.locale,
      companyTimeZone: company.timeZone,
      locales: SUPPORTED_LOCALES,
      zones,
      sample: {
        date: new Intl.DateTimeFormat(locale, {
          dateStyle: 'medium',
          timeStyle: 'short',
          timeZone,
        }).format(SAMPLE_INSTANT),
        money: new Intl.NumberFormat(locale, { style: 'currency', currency: 'CAD' }).format(10799),
      },
    };
  });
}

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

export async function savePreferencesFromForm(form: FormData): Promise<never> {
  // '' is a real submission meaning "follow the company", not a missing field —
  // so it is read and passed through rather than coalesced away here. The
  // service turns it into NULL; see `normaliseZone`.
  const locale = String(form.get('locale') ?? '');
  const timeZone = String(form.get('timeZone') ?? '');
  try {
    await asActor(async (tx, actor) => {
      await setUserPrefs(
        tx,
        actor.id,
        { id: actor.id, name: actor.display_name ?? actor.email, role: actor.role },
        { locale, timeZone },
      );
    });
  } catch (err) {
    rethrowRedirect(err);
    redirect(
      `${PAGE}?error=${encodeURIComponent(err instanceof Error ? err.message : String(err))}`,
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
