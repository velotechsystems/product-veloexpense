/**
 * VX2-5 — /approvals/delegations. Handing your approvals over while you are away.
 *
 * Server component posting plain `<form action={serverAction}>`, same as the rest
 * of the surface: no client JS, no client state. The revoke forms live after the
 * table because a `<form>` may not be a child of `<tr>`; the buttons point at
 * them with the HTML `form` attribute.
 *
 * ── What this page has to make true, and why ────────────────────────────────
 *
 * 1. IT IS SELF-SERVICE. The person who knows they are away is the person who
 *    can say so. ExpenseOS made cover an admin errand and measured the result:
 *    claims invisible in every queue, auto-rejected five business days later,
 *    80 of 703 users affected (GAP-AUDIT AP-5).
 * 2. IT SAYS WHAT A DELEGATION DOES NOT DO. Two things surprise people, and both
 *    are stated on the page rather than in a wiki nobody reads:
 *      · it does NOT take the work out of your own inbox — you keep it, so a
 *        manager back early still finds their queue;
 *      · it does NOT chain. If your stand-in has a stand-in, your approvals stop
 *        at yours (AP-16). The page detects that case and names both people,
 *        because it is invisible from either end otherwise.
 * 3. THE DATES ARE CALENDAR DATES, inclusive at both ends. `type="date"` submits
 *    'YYYY-MM-DD', which is exactly what `createDelegation` validates and what
 *    the column stores — no timezone anywhere in the round trip.
 *
 * Admins see the whole tenant. That is not a privilege for its own sake: the
 * person who needs a delegation fixed is by definition away, so somebody has to
 * be able to reach it.
 */
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  EmptyRow,
  ErrorBanner,
  fieldClass,
  labelClass,
  } from '@/app/expenses/ui';
import { formatInstant, toDateInputValue } from '@/lib/i18n/format';
import { enumLabel, DELEGATION_SCOPE_COPY } from '@/lib/i18n/catalog/enums';
import type { ReaderPrefs } from '@/lib/i18n/resolve';
import { readerPrefs } from '@/lib/i18n/request';
import { pageTitle } from '@/lib/i18n/page-title';

// UD-16. See `lib/i18n/page-title.ts` for why the title lives here rather than
// in a map of routes, and `scripts/check-page-titles.mjs` for what enforces it.
export function generateMetadata() {
  return pageTitle('title.approvals.delegations');
}

import {
  createDelegationFromForm,
  getDelegationsPage,
  revokeDelegationFromForm,
} from './actions';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { TableCard } from '@/components/screen';
import { NativeSelect } from '@/components/ui/native-select';
import { PageHeader, Screen } from '@/components/screen';
import { Badge } from '@/components/ui/badge';

export const dynamic = 'force-dynamic';

/**
 * Read back off the action rather than importing a type from it: every export of
 * a `'use server'` module must be an async function, so `actions.ts` exports no
 * types and this is how the page stays in step with what it actually returns.
 */
type DelegationCard = Awaited<ReturnType<typeof getDelegationsPage>>['cards'][number];

/**
 * 'YYYY-MM-DD' for `defaultValue` on a date input.
 *
 * VX4-7 part 1b: this used to read the SERVER's calendar day (`d.getFullYear()`
 * and friends are process-local). Its own comment was already half of the
 * finding — "never `toISOString`, which is UTC and so is the previous day for
 * anyone west of it" — but the fix it chose swapped one wrong zone for another:
 * a Vancouver employee opening this form got Toronto's today whenever the server
 * ran in Toronto, and the two disagree for eight hours out of every day.
 *
 * `toDateInputValue` with the reader's zone is the answer, and it stays
 * `YYYY-MM-DD` by construction because that is what a date input requires.
 */
function todayFor(prefs: ReaderPrefs): string {
  return toDateInputValue(new Date(), prefs.timeZone);
}

function StateBadge({ row }: { row: DelegationCard }) {
  if (row.revoked_at !== null) {
    return (
      <Badge variant="muted">ended</Badge>
    );
  }
  if (row.active) {
    return (
      <Badge variant="success">in force</Badge>
    );
  }
  // Not revoked and not active means the window is in the future or the past —
  // "scheduled" would be a lie for the second case, so say neither.
  return (
    <Badge variant="outline">not today</Badge>
  );
}

export default async function DelegationsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; notice?: string }>;
}) {
  const prefs = await readerPrefs();
  const { error, notice } = await searchParams;
  const { cards, candidates, delegators, actor } = await getDelegationsPage();

  const mine = cards.filter((c) => c.given);
  const covering = cards.filter((c) => !c.given && c.to_user_id === actor.id);
  // Admin-only: everything that is neither given by nor to the actor.
  const others = cards.filter((c) => !c.given && c.to_user_id !== actor.id);
  const liveMine = mine.filter((c) => c.active && c.revoked_at === null);

  return (
    <Screen>
      <PageHeader
        title="Delegations"
        description={
          liveMine.length === 0
            ? 'Nobody is standing in for your approvals'
            : `${liveMine.length === 1 ? liveMine[0].to_name + ' is' : liveMine.length + ' people are'} standing in for your approvals today`
        }
      />

      <ErrorBanner message={error} />
      {notice ? (
        <div className="rounded-lg border border-border bg-muted/40 p-3 text-sm">{notice}</div>
      ) : null}

      {/* ── the two things a delegation does not do ───────────────────────── */}
      <div className="rounded-lg border border-border bg-muted/30 p-4 text-sm">
        <p className="font-medium">Two things a delegation does not do.</p>
        <ul className="mt-1 list-disc space-y-1 pl-5 text-muted-foreground">
          <li>
            It does not take the work out of your inbox. You keep every approval you have — your
            stand-in gains the ability to decide, they do not take it from you. Come back early and
            your queue is where you left it.
          </li>
          <li>
            It does not chain. If the person standing in for you has arranged their own cover, your
            approvals stop at them. Name somebody who will actually be there.
          </li>
        </ul>
      </div>

      {/* ── arrange cover ─────────────────────────────────────────────────── */}
      <section className="rounded-lg border border-border p-4">
        <h2 className="text-lg leading-7 font-semibold">Arrange cover</h2>
        <p className="mb-3 text-sm text-muted-foreground">
          Both dates are included. Leave the last day blank for a standing stand-in with no end.
        </p>
        <form action={createDelegationFromForm} className="flex flex-col gap-3">
          <div className="flex flex-wrap gap-3">
            {actor.isAdmin ? (
              <div className={fieldClass}>
                <label className={labelClass} htmlFor="fromUserId">
                  Whose approvals
                </label>
                {/* Admin only. `createDelegation` refuses this field for anyone
                    else, so the select and the rule agree by construction. */}
                <div className="w-56">
                  <NativeSelect
                  id="fromUserId"
                  name="fromUserId"
                  defaultValue={actor.id}
                >
                  {delegators.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.id === actor.id ? `${p.name} (you)` : p.name}
                    </option>
                  ))}
                </NativeSelect>
                </div>
              </div>
            ) : null}
            <div className={fieldClass}>
              <label className={labelClass} htmlFor="toUserId">
                Who stands in
              </label>
              <div className="w-56">
                <NativeSelect id="toUserId" name="toUserId" required>
                <option value="">— choose —</option>
                {candidates.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </NativeSelect>
              </div>
            </div>
            <div className={fieldClass}>
              <label className={labelClass} htmlFor="startsOn">
                First day
              </label>
              <Input
                id="startsOn"
                name="startsOn"
                type="date"
                defaultValue={todayFor(prefs)}
                className="w-40"
                required
              />
            </div>
            <div className={fieldClass}>
              <label className={labelClass} htmlFor="endsOn">
                Last day
              </label>
              <Input id="endsOn" name="endsOn" type="date" className="w-40" />
            </div>
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <div className={fieldClass}>
              <label className={labelClass} htmlFor="scope">
                Covers
              </label>
              {/* ALL and REPORTS are the same thing while the expense report is
                  the only approval subject. The select exists so that adding
                  travel or card approvals later does not silently widen every
                  delegation written before them (0008). */}
              <div className="w-56">
                <NativeSelect id="scope" name="scope" defaultValue="ALL">
                <option value="ALL">Everything I approve</option>
                <option value="REPORTS">Expense reports only</option>
              </NativeSelect>
              </div>
            </div>
            <div className={`${fieldClass} grow`}>
              <label className={labelClass} htmlFor="note">
                Note (optional)
              </label>
              <Input id="note" name="note" placeholder="Annual leave" />
            </div>
            <Button type="submit">Arrange cover</Button>
          </div>
        </form>
      </section>

      {/* ── the tables ────────────────────────────────────────────────────── */}
      <DelegationTable
        prefs={prefs}
        title="Cover you have arranged"
        empty="You have not handed your approvals to anybody."
        rows={mine}
        show="to"
        actorId={actor.id}
        isAdmin={actor.isAdmin}
      />

      <DelegationTable
        prefs={prefs}
        title="Cover you are providing"
        empty="Nobody has handed you their approvals."
        rows={covering}
        show="from"
        actorId={actor.id}
        isAdmin={actor.isAdmin}
      />

      {actor.isAdmin ? (
        <DelegationTable
        prefs={prefs}
          title="Everyone else"
          empty="No other delegations in this organization."
          rows={others}
          show="both"
          actorId={actor.id}
          isAdmin
        />
      ) : null}

      {/* The revoke forms. Outside the tables, referenced by `form=` above. */}
      {cards
        .filter((c) => c.revoked_at === null)
        .map((c) => (
          <form
            key={c.id}
            id={`revoke-${c.id}`}
            action={revokeDelegationFromForm}
            className="hidden"
          >
            <input type="hidden" name="delegationId" value={c.id} />
          </form>
        ))}
    </Screen>
  );
}

/**
 * One table. `show` picks which side of the pair is the interesting column —
 * "who is covering for me" vs "whose work I am covering" — rather than always
 * printing both and making the reader work out which name is theirs.
 */
function DelegationTable({
  title,
  empty,
  rows,
  show,
  actorId,
  isAdmin,
  prefs,
}: {
  // Passed down rather than resolved here: this is a SYNC component, and
  // `readerPrefs()` is async. Threading it as a prop also keeps the resolution
  // on the page — one `await` per request, which is what `cache()` is for.
  prefs: ReaderPrefs;
  title: string;
  empty: string;
  rows: DelegationCard[];
  show: 'to' | 'from' | 'both';
  actorId: string;
  isAdmin: boolean;
}) {
  const cols = show === 'both' ? 6 : 5;
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-lg leading-7 font-semibold">{title}</h2>
      <TableCard>
        <Table className="min-w-[760px]">
          <TableHeader>
            <TableRow>
              {show !== 'to' ? <TableHead>Whose approvals</TableHead> : null}
              {show !== 'from' ? <TableHead>Standing in</TableHead> : null}
              <TableHead>Days</TableHead>
              <TableHead>Covers</TableHead>
              <TableHead>State</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <EmptyRow colSpan={cols}>{empty}</EmptyRow>
            ) : (
              rows.map((row) => {
                // Whether the button is offered mirrors `revokeDelegation`'s own
                // rule exactly — delegator, creator, or admin. Rendering it for
                // anyone else would produce a FORBIDDEN on click.
                const mayRevoke =
                  row.revoked_at === null &&
                  (row.from_user_id === actorId || row.created_by_id === actorId || isAdmin);
                return (
                  <TableRow key={row.id} className="align-top">
                    {show !== 'to' ? <TableCell>{row.from_name}</TableCell> : null}
                    {show !== 'from' ? (
                      <TableCell>
                        {row.to_name}
                        {row.onwardTo ? (
                          <p className="mt-0.5 text-xs text-destructive">
                            {row.to_name} has handed their own approvals to {row.onwardTo}.
                            Delegations do not chain — the work stops at {row.to_name}.
                          </p>
                        ) : null}
                      </TableCell>
                    ) : null}
                    <TableCell className="tabular-nums">
                      {row.starts_on}
                      {' → '}
                      {row.ends_on ?? 'open-ended'}
                    </TableCell>
                    <TableCell>
                      {enumLabel(DELEGATION_SCOPE_COPY, row.scope, prefs.locale)}
                      {row.note ? (
                        <p className="text-xs text-muted-foreground">{row.note}</p>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      <StateBadge row={row} />
                      {row.revoked_at !== null ? (
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          ended by {row.revoked_by_name} on {formatInstant(row.revoked_at, prefs)}
                        </p>
                      ) : row.created_by_id !== row.from_user_id ? (
                        // Worth surfacing: somebody else arranged this. It is why
                        // `created_by_id` is a separate column (0008).
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          arranged by {row.created_by_name}
                        </p>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      {mayRevoke ? (
                        <Button
                          form={`revoke-${row.id}`}
                          type="submit"
                          size="sm"
                          variant="outline"
                        >
                          End it
                        </Button>
                      ) : null}
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </TableCard>
    </section>
  );
}
