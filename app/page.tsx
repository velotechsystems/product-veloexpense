/**
 * VX5-4 — `/`, the page somebody lands on after signing in.
 *
 * ── WHAT WAS HERE BEFORE ────────────────────────────────────────────────────
 *
 * The unmodified `create-next-app` scaffold. The Next.js logo, "To get started,
 * edit the page.tsx file", and links to Vercel templates — served to every
 * signed-in customer, and crawled by `e2e/crawl.spec.ts` for four phases without
 * anybody noticing, because the crawl asserts a page RENDERS and this one did.
 *
 * ── WHAT IT IS NOW ──────────────────────────────────────────────────────────
 *
 * The setup checklist while a tenant still has decisions outstanding, and a way
 * into the product once it does not. The checklist is admin-only: an employee
 * sees the links and nothing they cannot act on.
 *
 * The sentences live HERE and not in `lib/onboarding/setup.ts`, which returns
 * keys and counts. `SETUP_COPY` is typed `Record<SetupItem, …>`, so adding an
 * item to that list without a sentence is a compile error rather than a blank
 * row — the `EnumCopy` pattern from VX4-7, and IL-7's rule that a list which
 * restates another list stops matching it.
 */
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { SETUP_ITEMS, type SetupItem } from '@/lib/onboarding/setup';
import { getHomeContext, getSetupStatus } from './actions';

import { pageTitle } from '@/lib/i18n/page-title';

// UD-16. See `lib/i18n/page-title.ts` for why the title lives here rather than
// in a map of routes, and `scripts/check-page-titles.mjs` for what enforces it.
export function generateMetadata() {
  return pageTitle('title.home');
}

export const dynamic = 'force-dynamic';

const SETUP_COPY: Record<SetupItem, { title: string; why: string; href: string; cta: string }> = {
  APPROVER: {
    title: 'Invite somebody who can approve',
    // The wall a solo founder hits, said before they hit it. Nothing can be
    // submitted in a tenant of one: the submitter would be the only eligible
    // approver, and self-approval is off by default and stays off.
    why: 'Nothing can be submitted while you are the only person here — an expense report cannot be approved by the person who filed it.',
    href: '/admin/employees/invite',
    cta: 'Invite someone',
  },
  CATEGORIES: {
    title: 'Check your expense categories',
    why: 'Six were created with your organization so you can record an expense straight away. They are yours — rename them, add to them, switch off the ones you do not use.',
    href: '/admin/expense-policies',
    cta: 'Review categories',
  },
  APPROVAL_LADDER: {
    title: 'Decide who approves what',
    why: 'Without a ladder, everything routes up the reporting line. A ladder is how a large amount reaches somebody more senior than a small one.',
    href: '/admin/approval-ladder',
    cta: 'Set up approvals',
  },
  SPEND_POLICY: {
    title: 'Set your spend rules',
    why: 'Limits and receipt requirements are checked when a report is submitted. With no rules, nothing is ever flagged.',
    href: '/admin/expense-policies',
    cta: 'Add a rule',
  },
  STRUCTURE: {
    title: 'Describe your organization',
    why: 'Legal entities, business units and departments are how spending is grouped, reported on and consolidated.',
    href: '/admin/employees',
    cta: 'Add structure',
  },
  BRANDING: {
    title: 'Make it look like yours',
    why: 'Your name and colour appear on the screens your people use and on the emails they receive.',
    href: '/admin/branding',
    cta: 'Add branding',
  },
};

const LINKS = [
  { href: '/expenses', label: 'Expense reports', hint: 'File a report, or pick up a draft.' },
  { href: '/approvals', label: 'Approvals', hint: 'What is waiting on you.' },
  { href: '/notifications', label: 'Notifications', hint: 'What has happened recently.' },
];

export default async function HomePage() {
  const { name, isAdmin, organizationName } = await getHomeContext();
  // Asked for ONLY when the reader is an admin — see `app/actions.ts`.
  const setup = isAdmin ? await getSetupStatus() : null;
  const outstanding =
    setup === null ? [] : SETUP_ITEMS.filter((item) => !setup.items.find((i) => i.item === item)!.done);

  return (
    <main className="mx-auto flex w-full max-w-4xl flex-col gap-8 p-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">{organizationName}</h1>
        <p className="text-sm text-muted-foreground">Signed in as {name}.</p>
      </header>

      {setup !== null && !setup.complete ? (
        <section className="flex flex-col gap-4 rounded-xl border border-border bg-background p-5">
          <div className="flex flex-col gap-1">
            <h2 className="text-base font-semibold">Finish setting up</h2>
            <p className="text-sm text-muted-foreground">
              {outstanding.length} {outstanding.length === 1 ? 'thing' : 'things'} left. Nothing
              here was decided for you — an approval route or a spend limit is a statement about
              how your company works, so we did not invent one.
            </p>
          </div>

          <ol className="flex flex-col gap-4">
            {outstanding.map((item) => {
              const copy = SETUP_COPY[item];
              return (
                <li className="flex flex-col gap-1.5 border-t border-border pt-4" key={item}>
                  <h3 className="text-sm font-medium text-foreground">{copy.title}</h3>
                  <p className="text-sm text-muted-foreground">{copy.why}</p>
                  <div>
                    <Button asChild size="sm" variant="outline">
                      <Link href={copy.href}>{copy.cta}</Link>
                    </Button>
                  </div>
                </li>
              );
            })}
          </ol>

          {setup.memberCount === 1 ? (
            <p className="text-xs text-muted-foreground">
              You are the only person in {organizationName} so far.
            </p>
          ) : null}
        </section>
      ) : null}

      <section className="grid gap-3 sm:grid-cols-3" data-testid="home-links">
        {LINKS.map((link) => (
          <Link
            className="flex flex-col gap-1 rounded-xl border border-border bg-background p-4 transition-colors hover:border-ring"
            href={link.href}
            key={link.href}
          >
            <span className="text-sm font-medium text-foreground">{link.label}</span>
            <span className="text-xs text-muted-foreground">{link.hint}</span>
          </Link>
        ))}
      </section>
    </main>
  );
}
