import { IdentityBannerChip } from '@expenseos/design-system';
import { getLocalized } from '@expenseos/i18n';
import type { Locale } from '@expenseos/i18n/locales';
import { getLocale } from 'next-intl/server';
// VeloExpense: the session comes from the request's shell context, and the profile from
// `getIdentityProfile` — VeloExpense has no `users.get` (see that file).
import { shellContext } from '@/server/shell';
import { getIdentityProfile } from './identityProfile';

/**
 * The two chips on the landing page's identity band: the reader's role, and their
 * department.
 *
 * IT IS THE FETCHED HALF OF THE BAND, AND ONLY THE FETCHED HALF. `page.tsx` owns the navy
 * region, the face and the `h1` — all three from the session, which has already resolved
 * by the time the page renders, so the band can never draw half-finished and the heading
 * can never be swallowed by a failure down here. This file owns the one thing the session
 * cannot answer, `users.get`, and therefore the only thing on the band that can fail. It
 * renders no card, no avatar and no name; it returns chips.
 *
 * IT IS THE PROFILE HEADER, AND THAT IS NOW THE POINT. Its predecessor (`IdentityStrip`)
 * opened by insisting it was *not* that header shrunk — a bordered white strip with a 40px
 * avatar and a grey sub-line, deliberately unlike the profile hero. That decision was
 * reversed: the operator asked for the navy band on the dashboard, `IdentityBanner` was
 * extracted from the then-live `/my-info` to serve both surfaces, and `/dashboard` and
 * `/profile` now draw the same header on purpose. (`/my-info` itself has since been
 * deleted; `/profile` holds the record it carried.) What is left of the old distinction is
 * real and is enforced below — the dashboard's band carries no employee-status badge and
 * no field grid — but "not the profile header" is no longer the shape of it.
 *
 * NO EMPLOYEE-STATUS BADGE. The profile page shows one and keeps it; this band omits it
 * deliberately. A status badge on the first screen after sign-in tells the reader
 * something about their own employment that they already know, in a colour that implies
 * they should do something about it, on a page where there is nothing to do about it. The
 * omission is a decision, not an oversight — do not restore it, and do not remove it from
 * the profile page. (ADR-0002 D6. The badge moved from `/my-info` to `/profile` with the
 * rest of that header before `/my-info` was deleted; it was relocated, not retired, so
 * "the other page keeps it" is still true.) `IdentityBanner`'s
 * `statusBadge` is a NODE rather than a boolean precisely so this omission is the absence
 * of a construction rather than a flag somebody can flip.
 *
 * IT MUST NOT BE ABLE TO 500 THE PAGE. `users.get` throws — `FORBIDDEN` if `canViewUser`
 * says no, `NOT_FOUND` if the row is gone, and anything a database can throw underneath.
 * This is the one way the landing page could go down, so the throw is caught here and the
 * chips degrade to the one fact the session already has in hand (the role label). A
 * degraded band is invisible to the reader; a 500 is not. The name is no longer among the
 * facts degraded to, because the name is no longer rendered here: it sits above every
 * catch in `page.tsx`, where its job is to exist.
 *
 * AND THE `<PanelBoundary fallback={null}>` ABOVE IS THE BACKSTOP UNDER THAT CATCH, not a
 * duplicate of it. `.catch` covers the promise; the boundary covers everything else a
 * render can throw — `getLocalized` on a malformed label, a `getLocale` failure, a bug in
 * this file. `null` and not the standard error face because, per `ux-ui-designer`, a
 * bordered box with a page-reloading Retry button is the wrong offer for a department
 * label, besides being the wrong picture inside a navy band.
 *
 * `data-dashboard-identity` IS AN E2E INSTRUMENT AND IT REPLACED ONE THAT HAD STOPPED
 * PROVING ANYTHING. `dashboard.spec.ts` used to assert the fresh profile was preferred over
 * the session snapshot by matching the full name exactly. Once the name became the `h1` and
 * came from the session, that assertion matched the heading itself and proved nothing — the
 * degraded path prints the identical string whenever the session name and the profile name
 * agree, which is true for all nine seeded actors. `fresh` / `session` says which source
 * answered, so a `users.get` that silently started throwing in every browser run now fails
 * a test instead of passing one. Same reasoning as `page.tsx`'s three `data-dashboard-*`
 * attributes: publish the server's decision, because "absent" and "degraded" otherwise look
 * identical in the DOM.
 *
 * It is an async server component rendered as a CHILD ELEMENT of the page, never an inline
 * `await` in `DashboardPage`. That keeps the page's own render free of this fetch — the
 * band paints as soon as the session is known — and it is why `page.test.tsx` can read the
 * page's element tree without any of this running: that file's hand-rolled walk never
 * invokes a child component, and its `api.users.get` mock throws if anything ever does.
 */
export async function IdentityChips() {
  // VeloExpense: ExpenseOS's `auth()` session, from the shell.
  const shell = await shellContext();
  const session = shell ? { user: shell.user } : null;
  if (!session?.user) return null;

  const locale = (await getLocale()) as Locale;

  /** The fresh profile, or nothing. Never a throw — see the header. */
  const me = await getIdentityProfile({
    id: session.user.id,
    organizationId: session.user.organizationId,
  }).catch((error: unknown): null => {
    console.error('[dashboard] identity chips fell back to the session', error);
    return null;
  });

  /**
   * `session.user.roleLabel` is the right fallback and the wrong first choice, and the
   * reason is narrower than "staleness": `auth.ts:35-43`'s `resolveRoleLabel` returns
   * `label.en` — ALWAYS the English string, whatever locale the reader is in. So the
   * session's copy is a monolingual snapshot, and only the fresh row can be localized.
   */
  const role = (me ? getLocalized(me.role.label, locale) : null) || session.user.roleLabel || '';
  /** Only the fresh profile knows the department. There is no session fallback for it,
   *  and an absent department renders as nothing rather than as an em dash. */
  const department = me?.department ? (getLocalized(me.department.label, locale) ?? '') : '';

  return (
    /*
      `display: contents` — the wrapper carries the instrument and no layout.
      `IdentityBanner` puts `children` straight into a `flex flex-wrap gap-2` row, so a
      wrapper that generated a box would make both chips ONE flex item and take them out
      of the row's wrapping — which is the band's SC 1.4.10 reflow fix (the chips are
      customer-authored labels of unbounded length). `contents` leaves each chip a direct
      child of that row while keeping the attribute in the DOM for Playwright to read.

      Rendered even when both chips are empty, on purpose: the attribute reports WHICH
      SOURCE answered, and a run where `users.get` throws for everybody is exactly the run
      in which an instrument that disappeared with its chips would report nothing at all.
    */
    <div className="contents" data-dashboard-identity={me ? 'fresh' : 'session'}>
      {role && <IdentityBannerChip>{role}</IdentityBannerChip>}
      {department && <IdentityBannerChip>{department}</IdentityBannerChip>}
    </div>
  );
}
