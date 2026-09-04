/**
 * VX4-9 — what a person sees when they open a page that is not theirs.
 *
 * Rendered by Next for any `forbidden()` call, WITH A 403. Both halves matter and
 * they answer the ticket's two separate complaints: the sentence is for the
 * person who followed a stale bookmark, and the status code is for the operator
 * who could not previously tell a permission denial from a fault.
 *
 * ── WHAT IT DELIBERATELY DOES NOT DO ────────────────────────────────────────
 *
 * IT DOES NOT SAY WHAT THE PAGE WAS. "You cannot see the chart of accounts" tells
 * somebody the chart of accounts exists and where; a refusal should not be a
 * directory. The copy names the CLASS of screen, which they can already infer
 * from the URL they typed.
 *
 * IT DOES NOT OFFER A "REQUEST ACCESS" BUTTON. There is no request-access flow to
 * hang it on, and a button that mails nobody is worse than a sentence saying who
 * to ask.
 *
 * IT IS NOT A REDIRECT. Considered and rejected with John on 4 Sep: somebody
 * following a bookmark or a colleague's link lands somewhere else with no
 * explanation and concludes the link was wrong. A page that says no is duller and
 * truthful.
 *
 * ── LOCALE ──────────────────────────────────────────────────────────────────
 *
 * Copy comes from `lib/i18n/catalog/errors.ts` through `renderUserMessage`, so
 * this screen is not a new un-catalogued surface — VX4-10 has 161 of those
 * already and this ticket is not adding a 162nd.
 */
import Link from 'next/link';
import { readerPrefs } from '@/lib/i18n/request';
import { renderUserMessage } from '@/lib/i18n/catalog/errors';

export default async function Forbidden() {
  // `readerPrefs()` reads the session, which a refused person still has — they
  // are signed in, just not an administrator. A signed-OUT visitor never reaches
  // here: the middleware sends them to /login.
  const prefs = await readerPrefs();
  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-4 p-6">
      <h1 className="text-2xl font-semibold tracking-tight">This is not yours to see</h1>
      <p data-testid="forbidden-reason" className="text-sm">
        {renderUserMessage('ADMIN_ONLY', prefs.locale)}
      </p>
      <p className="text-sm text-muted-foreground">
        Nothing is wrong — you are signed in and the product is working. You simply do not
        administer this organization.
      </p>
      <div className="flex flex-wrap gap-4 text-sm">
        <Link href="/expenses" className="underline underline-offset-4">
          Your reports
        </Link>
        <Link href="/approvals" className="underline underline-offset-4">
          Approvals
        </Link>
      </div>
    </div>
  );
}
