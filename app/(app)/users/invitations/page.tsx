/**
 * VX5-3 — the invitations still waiting (/users/invitations).
 *
 * People 4 moved this list here from `/admin/employees` when that screen retired (decided
 * 17 Oct 2026); People's header links to it with a count. ExpenseOS has no equivalent: its
 * people arrive from the Google directory, where VeloExpense's are invited.
 *
 * Server component: reads through the admin-gated server action, which runs inside the
 * tenant transaction so RLS scopes every row to the signed-in tenant. Withdraw posts a plain
 * form, so the page needs no client JS.
 */
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { ErrorBanner } from '@/app/expenses/ui';
import { listLiveInvites, revokeInviteFromForm } from './actions';
import { readerPrefs } from '@/lib/i18n/request';

import { pageTitle } from '@/lib/i18n/page-title';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { BackLink, PageHeader, Screen, TableCard } from '@/components/screen';

// UD-16. See `lib/i18n/page-title.ts` for why the title lives here rather than
// in a map of routes, and `scripts/check-page-titles.mjs` for what enforces it.
export function generateMetadata() {
  return pageTitle('title.people.invitations');
}

export const dynamic = 'force-dynamic';

export default async function InvitationsPage({
  searchParams,
}: {
  searchParams: Promise<{ invited?: string; withdrawn?: string; error?: string }>;
}) {
  const sp = await searchParams;
  const pendingInvites = await listLiveInvites();
  const { locale, timeZone } = await readerPrefs();
  // The reader's locale and zone, as every other date on an admin screen — a
  // date rendered in the server's zone is a date that is wrong for somebody.
  const expiryFormat = new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeZone,
  });

  return (
    <Screen width="wide">
      <div className="flex flex-col gap-2">
        <BackLink href="/users">People</BackLink>
        <PageHeader
          title="Invitations"
          description={`Invited, not yet signed in: ${pendingInvites.length}`}
          actions={
            <Button asChild>
              <Link href="/users/invite">Invite someone</Link>
            </Button>
          }
        />
      </div>

      <ErrorBanner message={sp.error} />
      {sp.invited === 'first' || sp.invited === 'again' ? (
        <p className="rounded-lg border border-primary/40 bg-primary/5 px-3 py-2 text-sm text-primary">
          {sp.invited === 'again'
            ? 'That address already had an invitation open, so we sent a fresh one — the earlier link has stopped working.'
            : 'Invitation sent. They appear in People once they sign in and accept it.'}
        </p>
      ) : null}
      {sp.withdrawn === '1' ? (
        <p className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
          Invitation withdrawn. That link no longer works.
        </p>
      ) : null}

      {/* VX5-3 — the pending list.
        *
        * It exists because People does not contain people who have not arrived,
        * which is the whole point of that ticket and would otherwise read as an
        * admin's invitation vanishing. Live invitations only: an accepted one is
        * a person in People, and a revoked or expired one is a decision already
        * taken. */}
      {pendingInvites.length > 0 ? (
        <section className="flex flex-col gap-2">
          <TableCard>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Email</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Invited by</TableHead>
                  <TableHead>Expires</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {pendingInvites.map((invite) => (
                  <TableRow key={invite.id}>
                    <TableCell>{invite.email}</TableCell>
                    <TableCell>
                      {invite.roleName}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {invite.invitedByName ?? '—'}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {expiryFormat.format(invite.expiresAt)}
                    </TableCell>
                    <TableCell className="text-right">
                      <form action={revokeInviteFromForm}>
                        <input name="inviteId" type="hidden" value={invite.id} />
                        <Button size="sm" type="submit" variant="outline">
                          Withdraw
                        </Button>
                      </form>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableCard>
        </section>
      ) : (
        <p className="text-sm text-muted-foreground">
          No invitations waiting. Everybody invited has signed in, or their invitation was
          withdrawn or ran out.
        </p>
      )}

    </Screen>
  );
}
