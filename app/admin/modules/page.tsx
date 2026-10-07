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
import { Button } from '@/components/ui/button';
import { ErrorBanner } from '@/app/expenses/ui';
import { formatInstant } from '@/lib/i18n/format';
import { readerPrefs } from '@/lib/i18n/request';
import { getModulesPage, toggleFromForm } from './actions';

import { pageTitle } from '@/lib/i18n/page-title';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { TableCard } from '@/components/screen';
import { PageHeader, Screen } from '@/components/screen';

// UD-16. See `lib/i18n/page-title.ts` for why the title lives here rather than
// in a map of routes, and `scripts/check-page-titles.mjs` for what enforces it.
export function generateMetadata() {
  return pageTitle('title.admin.modules');
}

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
    <Screen>
      <PageHeader
        title="Modules"
        description={`${on === 0 ? 'Nothing enabled' : `${on} enabled`} · what this organization may use`}
      />

      <ErrorBanner message={error} />
      {changed ? (
        <p className="rounded-lg border border-border bg-muted/50 px-3 py-2 text-sm">
          Saved. The change applies immediately, to every screen and to the posting
          queue.
        </p>
      ) : null}

      <p className="rounded-lg border border-border bg-muted/50 px-3 py-2 text-sm text-muted-foreground">
        <strong className="font-medium text-foreground">Turning a module off hides its data; it does not delete it.</strong>{' '}
        A disabled module&rsquo;s records stay in the database and become unreadable to this
        organization, so switching one off and on again loses nothing. Approved reports
        still queue for the ledger while accounting is off — they wait rather than fail,
        and go when it is back on.
      </p>

      <TableCard>
        <Table className="min-w-[680px]">
          <TableHeader>
            <TableRow>
              <TableHead>Module</TableHead>
              <TableHead>State</TableHead>
              <TableHead>Since</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {entitlements.map(({ module: m, enabled, enabledAt, disabledAt, changedByName }) => (
              <TableRow key={m.code} className="align-top">
                <TableCell>
                  <p className="font-medium">{m.name}</p>
                  <p className="text-xs text-muted-foreground">{m.description}</p>
                </TableCell>
                <TableCell>
                  {!m.available ? (
                    // Shown, not hidden — see the header.
                    <span className="text-muted-foreground">not in this build</span>
                  ) : enabled ? (
                    <span>enabled</span>
                  ) : (
                    <span className="text-muted-foreground">off</span>
                  )}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
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
                </TableCell>
                <TableCell>
                  {m.available ? (
                    <form action={toggleFromForm}>
                      <input type="hidden" name="code" value={m.code} />
                      <input type="hidden" name="enable" value={enabled ? 'false' : 'true'} />
                      <Button type="submit" size="sm" variant={enabled ? 'outline' : 'default'}>
                        {enabled ? 'Turn off' : 'Turn on'}
                      </Button>
                    </form>
                  ) : null}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableCard>
    </Screen>
  );
}
