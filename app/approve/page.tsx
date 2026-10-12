/**
 * VX2-8 — /approve?token=…, the landing page for an emailed approve link.
 *
 * PUBLIC. No session, no cookie, no tenant in the URL. The token is the only
 * credential and `proxy.ts` has to let this path through — see the PUBLIC list
 * there, where it sits alongside /login.
 *
 * ── This page renders a QUESTION, never a result ────────────────────────────
 *
 * A GET does nothing but read. Deciding is a POST from the form below, and that
 * is not fastidiousness: mail clients, link scanners and corporate security
 * gateways prefetch links in mail, so a GET that approved would be approved by
 * Outlook on the recipient's behalf before they had read the sentence. Of
 * everything in this ticket, this is the property most likely to be "simplified"
 * later by someone who has not been bitten by it.
 *
 * The page therefore repeats the facts the approver needs to have seen — who
 * submitted, how much, how many receipts — because the alternative is
 * a one-click approval of a number nobody looked at, which is how a rubber stamp
 * gets built. Same reasoning as /approvals having no approve buttons in the list.
 */
import Link from 'next/link';
import { readerPrefs } from '@/lib/i18n/request';
import { renderUserMessage } from '@/lib/i18n/catalog/errors';
import { encodeUserMessage } from '@/lib/errors/domain';
import { Button } from '@/components/ui/button';
import { inspectToken } from '@/lib/notifications/approve';
// Only the action comes from './actions' — see the comment there on why nothing
// else may.
import { decideFromTokenForm } from './actions';

import { pageTitle } from '@/lib/i18n/page-title';

// UD-16. See `lib/i18n/page-title.ts` for why the title lives here rather than
// in a map of routes, and `scripts/check-page-titles.mjs` for what enforces it.
export function generateMetadata() {
  return pageTitle('title.approve');
}

export const dynamic = 'force-dynamic';

type Outcome = Awaited<ReturnType<typeof inspectToken>>;

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto flex min-h-svh w-full max-w-xl flex-col justify-center gap-4 p-6">
      {children}
    </div>
  );
}

function Card({
  title,
  children,
  tone = 'plain',
}: {
  title: string;
  children: React.ReactNode;
  tone?: 'plain' | 'bad';
}) {
  return (
    <div
      className={`rounded-xl border p-6 ${
        tone === 'bad' ? 'border-destructive/40 bg-destructive/5' : 'border-border bg-background'
      }`}
    >
      <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
      <div className="mt-2 flex flex-col gap-3 text-sm text-muted-foreground">{children}</div>
    </div>
  );
}

export default async function ApprovePage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string; done?: string; error?: string }>;
}) {
  const { token, done, error } = await searchParams;

  // The POST lands back here with ?done= / ?error=, so the confirmation and the
  // result are one page and the browser's back button cannot re-submit.
  if (done) {
    return (
      <Shell>
        <Card title={done === 'APPROVED' ? 'Approved' : 'Rejected'}>
          <p>
            Thank you — the decision is recorded and the submitter has been notified. This link has
            now been used and will not work again.
          </p>
          <p>
            <Link href="/expenses" className="underline underline-offset-4">
              Sign in to VeloExpense
            </Link>{' '}
            to see the report.
          </p>
        </Card>
      </Shell>
    );
  }

  if (error) {
    return (
      <Shell>
        <Card title="That did not go through" tone="bad">
          <p>{error}</p>
          <p>
            Your link has not been used, so you can try again — or{' '}
            <Link href="/expenses" className="underline underline-offset-4">
              sign in
            </Link>{' '}
            and decide from the report.
          </p>
        </Card>
      </Shell>
    );
  }

  const outcome: Outcome = token ? await inspectToken(token) : { kind: 'INVALID' };

  if (outcome.kind === 'INVALID') {
    return (
      <Shell>
        <Card title="This link no longer works" tone="bad">
          {/* Deliberately one message for expired, already-used and unknown. A
              legitimate recipient does the same thing in all three cases, and the
              difference is a probe for anybody else. */}
          <p>
            Approval links expire after five business days and can only be used once. This one has
            expired, has already been used, or was not valid.
          </p>
          <p>
            <Link href="/expenses" className="underline underline-offset-4">
              Sign in to VeloExpense
            </Link>{' '}
            to see anything still waiting for you.
          </p>
        </Card>
      </Shell>
    );
  }

  if (outcome.kind === 'REFUSED') {
    return (
      <Shell>
        <Card title="Nothing to decide" tone="bad">
          {/* The refusal is a message, not a sentence, since part 2c-2 — rendered
              here in the reader's language. This page is opened from a link in an
              EMAIL by somebody who may not be signed in, so `readerPrefs()` has
              no user to resolve: it falls to the company default and then to the
              constant, which is `resolveLocale`'s pre-auth rung doing its job. */}
          <p>{renderUserMessage(encodeUserMessage(outcome.reason), (await readerPrefs()).locale)}</p>
          {outcome.reportId ? (
            <p>
              <Link href="/expenses" className="underline underline-offset-4">
                Sign in
              </Link>{' '}
              to see the report.
            </p>
          ) : null}
        </Card>
      </Shell>
    );
  }

  if (outcome.kind === 'DONE') {
    // Unreachable from a GET — kept so the union is exhaustive rather than
    // silently falling through if a later change makes inspectToken able to
    // return it.
    return (
      <Shell>
        <Card title="Already decided">
          <p>This approval has already been recorded.</p>
        </Card>
      </Shell>
    );
  }

  const verb = outcome.action === 'APPROVED' ? 'Approve' : 'Reject';

  return (
    <Shell>
      <Card title={`${verb} this expense report?`}>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-foreground">
          <dt className="text-muted-foreground">Report</dt>
          <dd>
            {outcome.reportTitle}
            {outcome.reportNumber ? ` · ${outcome.reportNumber}` : ''}
          </dd>
          <dt className="text-muted-foreground">Submitted by</dt>
          <dd>{outcome.submitterName}</dd>
          <dt className="text-muted-foreground">Total</dt>
          <dd className="tabular-nums">{outcome.total}</dd>
          <dt className="text-muted-foreground">Receipts</dt>
          <dd>{outcome.receiptCount === 0 ? 'none attached' : `${outcome.receiptCount} attached`}</dd>
          <dt className="text-muted-foreground">Acting as</dt>
          <dd>{outcome.recipientName}</dd>
        </dl>

        <form action={decideFromTokenForm} className="mt-2 flex flex-col gap-3">
          <input type="hidden" name="token" value={token ?? ''} />
          <div className="flex items-center gap-3">
            <Button type="submit" variant={outcome.action === 'APPROVED' ? 'default' : 'outline'}>
              Yes, {verb.toLowerCase()} it
            </Button>
            <Link href="/expenses" className="text-sm underline underline-offset-4">
              Sign in instead
            </Link>
          </div>
        </form>

        <p className="text-xs">
          You are acting through a single-use link from your email. Nothing has happened yet.
        </p>
      </Card>
    </Shell>
  );
}
