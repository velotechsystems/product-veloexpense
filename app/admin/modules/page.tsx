/**
 * VX4-1 part 2 — the Modules screen.
 *
 * ── What it has to say, not just do ────────────────────────────────────────
 *
 * An UNAVAILABLE module is SHOWN, greyed, rather than hidden. A customer asking
 * for Budgets is a sales answer and an empty list is not one — the same reasoning
 * VX3-8 used for registering QuickBooks dormant instead of leaving it out.
 *
 * And the copy says what turning a module OFF actually does, because the honest
 * answer is not "the screens disappear": since migration `0022` the data becomes
 * invisible to the tenant while remaining in the table, so switching accounting
 * off and on again is lossless. An admin about to press a toggle on their
 * production tenant should be told that before they press it, not after.
 */
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { ErrorBanner } from '@/app/expenses/ui';
import { formatInstant } from '@/lib/i18n/format';
import { readerPrefs } from '@/lib/i18n/request';
import { getModulesPage, toggleFromForm } from './actions';

export const dynamic = 'force-dynamic';

export default async function ModulesPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; changed?: string }>;
}) {
  const prefs = await readerPrefs();
  const { error, changed } = await searchParams;
  const { entitlements } = await getModulesPage();
  const on = entitlements.filter((e) => e.enabled).length;

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Modules</h1>
          <p className="text-sm text-muted-foreground">
            {on === 0 ? 'Nothing enabled' : `${on} enabled`}
            {' · '}what this organization may use
          </p>
        </div>
        <div className="flex gap-4">
          <Link href="/admin/integrations" className="text-sm underline underline-offset-4">
            Accounting integrations
          </Link>
          {/* VX4-5 part 3b. There is no global admin nav — the /admin screens
              cross-link ad hoc — so a module made available with nowhere pointing
              at its surface is a surface nobody finds. That is upstream's
              "the surfaces AP could not find" (GAP-AUDIT UD-4's neighbour), and
              one link is cheaper than rediscovering it. */}
          <Link href="/admin/budgets" className="text-sm underline underline-offset-4">
            Budgets
          </Link>
          <Link href="/admin/analytics" className="text-sm underline underline-offset-4">
            Analytics
          </Link>
          {/* VX4-8 part 4, and the note above is why: a module made available with
              nothing pointing at its surface is a surface nobody finds. */}
          <Link href="/admin/compliance" className="text-sm underline underline-offset-4">
            Compliance
          </Link>
        </div>
      </header>

      <ErrorBanner message={error} />
      {changed ? (
        <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm">
          Saved. The change applies immediately, to every screen and to the posting
          queue.
        </p>
      ) : null}

      <p className="rounded-md border border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
        <strong className="font-medium text-foreground">Turning a module off hides its data; it does not delete it.</strong>{' '}
        A disabled module&rsquo;s records stay in the database and become unreadable to this
        organization, so switching one off and on again loses nothing. Approved reports
        still queue for the ledger while accounting is off — they wait rather than fail,
        and go when it is back on.
      </p>

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full min-w-[680px] text-left text-sm">
          <thead className="bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-3 py-2 font-medium">Module</th>
              <th className="px-3 py-2 font-medium">State</th>
              <th className="px-3 py-2 font-medium">Since</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {entitlements.map(({ module: m, enabled, enabledAt, disabledAt, changedByName }) => (
              <tr key={m.code} className="border-t border-border align-top">
                <td className="px-3 py-2">
                  <p className="font-medium">{m.name}</p>
                  <p className="text-xs text-muted-foreground">{m.description}</p>
                </td>
                <td className="px-3 py-2">
                  {!m.available ? (
                    // Shown, not hidden — see the header.
                    <span className="text-muted-foreground">not in this build</span>
                  ) : enabled ? (
                    <span>enabled</span>
                  ) : (
                    <span className="text-muted-foreground">off</span>
                  )}
                </td>
                <td className="px-3 py-2 text-xs text-muted-foreground">
                  {enabled && enabledAt ? (
                    <>
                      {formatInstant(enabledAt, prefs)}
                      {changedByName ? <span className="block">by {changedByName}</span> : null}
                    </>
                  ) : disabledAt ? (
                    <>
                      turned off {formatInstant(disabledAt, prefs)}
                      {changedByName ? <span className="block">by {changedByName}</span> : null}
                    </>
                  ) : (
                    '—'
                  )}
                </td>
                <td className="px-3 py-2">
                  {m.available ? (
                    <form action={toggleFromForm}>
                      <input type="hidden" name="code" value={m.code} />
                      <input type="hidden" name="enable" value={enabled ? 'false' : 'true'} />
                      <Button type="submit" size="sm" variant={enabled ? 'outline' : 'default'}>
                        {enabled ? 'Turn off' : 'Turn on'}
                      </Button>
                    </form>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
