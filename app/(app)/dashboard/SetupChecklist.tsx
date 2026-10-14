/**
 * VeloExpense (w4-09, d72): the setup checklist — VeloExpense's, not ExpenseOS's, which is
 * single-tenant and has none. Moved here from VeloExpense's old home page (`/`, VX5-4) when
 * ExpenseOS's dashboard replaced it, unchanged: the same reads (`./actions.ts`: the member
 * read first, the admin read only for an admin), the same two faces (the card, or one
 * collapsed line while steps remain — decided 7 Oct: collapse, never dismiss), the same copy
 * (`app/setupCopy.ts`). It renders above ExpenseOS's cards and nothing at all once setup is
 * complete or for anyone but an admin.
 *
 * `error` is the `?error=` the Hide / Show form reports a refusal through
 * (`setSetupCollapsedFromForm`), handed down by the dashboard page.
 */
import Link from 'next/link';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardHeader } from '@/components/ui/card';
import { ErrorBanner } from '@/app/expenses/ui';
import { SETUP_ITEMS } from '@/lib/onboarding/setup';
import { SETUP_COPY } from '@/app/setupCopy';
import { getHomeContext, getSetupStatus, setSetupCollapsedFromForm } from './actions';

export async function SetupChecklist({ error }: { error?: string }) {
  const { isAdmin, organizationName } = await getHomeContext();
  // Asked for ONLY when the reader is an admin — see `./actions.ts`.
  const setup = isAdmin ? await getSetupStatus() : null;
  const outstanding =
    setup === null ? [] : SETUP_ITEMS.filter((item) => !setup.items.find((i) => i.item === item)!.done);

  return (
    <>
      <ErrorBanner message={error} />

      {/* Collapsed (decided 7 Oct): one line, never gone. The admin put the card
          away; the outstanding count stays in view so "invite an approver" is
          not lost — a tenant of one still cannot submit anything. */}
      {setup !== null && !setup.complete && setup.collapsed ? (
        <section
          className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-card px-5 py-3"
          data-testid="setup-collapsed"
        >
          <p className="text-sm">
            <span className="font-semibold">Finish setting up</span>
            <span className="text-muted-foreground">
              {' · '}
              {outstanding.length} {outstanding.length === 1 ? 'step' : 'steps'} left
            </span>
          </p>
          <form action={setSetupCollapsedFromForm}>
            <input type="hidden" name="collapsed" value="0" />
            <Button type="submit" size="sm" variant="ghost">
              <ChevronDown aria-hidden />
              Show
            </Button>
          </form>
        </section>
      ) : null}

      {setup !== null && !setup.complete && !setup.collapsed ? (
        <Card>
          <CardHeader>
            {/* A real <h2>: the kit's CardTitle is a <div>, and this is the screen's one section heading. */}
            <h2 className="text-lg leading-7 font-semibold">Finish setting up</h2>
            <CardAction>
              <form action={setSetupCollapsedFromForm}>
                <input type="hidden" name="collapsed" value="1" />
                <Button type="submit" size="sm" variant="ghost">
                  <ChevronUp aria-hidden />
                  Hide
                </Button>
              </form>
            </CardAction>
            <CardDescription>
              {outstanding.length} {outstanding.length === 1 ? 'thing' : 'things'} left. Nothing
              here was decided for you — an approval route or a spend limit is a statement about
              how your company works, so we did not invent one.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ol className="flex flex-col">
              {outstanding.map((item) => {
                const copy = SETUP_COPY[item];
                return (
                  <li
                    className="flex flex-wrap items-center justify-between gap-3 border-t border-border py-4 first:border-t-0 first:pt-0 last:pb-0"
                    key={item}
                  >
                    <div className="flex min-w-0 flex-1 flex-col gap-1">
                      <h3 className="text-sm font-semibold text-foreground">{copy.title}</h3>
                      <p className="text-sm text-muted-foreground">{copy.why}</p>
                    </div>
                    <Button asChild size="sm" variant="outline">
                      <Link href={copy.href}>{copy.cta}</Link>
                    </Button>
                  </li>
                );
              })}
            </ol>

            {setup.memberCount === 1 ? (
              <p className="mt-4 text-xs text-muted-foreground">
                You are the only person in {organizationName} so far.
              </p>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

    </>
  );
}
