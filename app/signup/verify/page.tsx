/**
 * VX5-2b — `/signup/verify`. Where the mailed link lands.
 *
 * Four states, and the order they are tested in is deliberate:
 *
 *   ?created=slug   done. Tested FIRST, because the action redirects here and
 *                   carries no token, so a `token`-shaped test would fall
 *                   through to "no link".
 *   ?error=CODE     the refusal the POST came back with.
 *   ?token=…        the QUESTION, if the token is still live. A GET never acts:
 *                   see `actions.ts` for the link-scanner argument.
 *   (none)          somebody typed the URL.
 *
 * The GET reads the signup — `peekSignup`, which does not consume — so a dead
 * link says so immediately rather than after a click, and a live one can name
 * the organization about to be created. That name is the only reason a person
 * can tell this page apart from a phishing copy of it.
 */
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { ErrorBanner } from '@/app/expenses/ui';
import { peekSignup } from '@/lib/onboarding/signup';
import { checkSlug } from '@/lib/onboarding/slug';
import { confirmSignupFromForm } from './actions';
import { Card, Lede, Shell, Title } from '@/app/pre-auth';

import { pageTitle } from '@/lib/i18n/page-title';

// UD-16. See `lib/i18n/page-title.ts` for why the title lives here rather than
// in a map of routes, and `scripts/check-page-titles.mjs` for what enforces it.
export function generateMetadata() {
  return pageTitle('title.signup.verify');
}

export const dynamic = 'force-dynamic';

export default async function VerifySignupPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string; created?: string; error?: string }>;
}) {
  const { token, created, error } = await searchParams;

  /* ── done ──────────────────────────────────────────────────────────────── */
  // `checkSlug` before rendering: `created` arrives from a URL, so it is
  // whatever somebody put there. It is echoed into the page and into a link, and
  // "it came from our own redirect" is an assumption, not a guarantee.
  if (created !== undefined && checkSlug(created) === null) {
    return (
      <Shell>
        <Card>
          <Title>Your organization is ready</Title>
          <Lede>
            You are its first administrator. Sign in with your work account to invite
            everybody else.
          </Lede>
          <p className="text-sm text-foreground">
            Your web address is <strong>{created}</strong> — it is what you type when you
            sign in.
          </p>
          <Button asChild>
            <Link href={`/login?org=${encodeURIComponent(created)}`}>Sign in</Link>
          </Button>
        </Card>
      </Shell>
    );
  }

  /* ── refused ───────────────────────────────────────────────────────────── */
  if (error !== undefined) {
    return (
      <Shell>
        <Card>
          <Title>That did not work</Title>
          <ErrorBanner message={error} />
          <p className="text-sm text-muted-foreground">
            <Link className="underline underline-offset-4" href="/signup">
              Start again
            </Link>{' '}
            and we will send a new link.
          </p>
        </Card>
      </Shell>
    );
  }

  /* ── the question ──────────────────────────────────────────────────────── */
  const pending = token === undefined ? null : await peekSignup(token);
  if (pending === null) {
    // No token and a dead token are the same page on purpose — the same reason
    // `SIGNUP_LINK_DEAD` is one sentence for three cases. Telling somebody which
    // of the two they have says whether a token they are holding ever existed.
    return (
      <Shell>
        <Card>
          <Title>That link is not usable</Title>
          {/* A bare code IS a well-formed `?error=` value — `encodeUserMessage`
              returns exactly the code when there are no params — so the banner
              renders it in the reader's locale like any other. */}
          <ErrorBanner message="SIGNUP_LINK_DEAD" />
          <p className="text-sm text-muted-foreground">
            <Link className="underline underline-offset-4" href="/signup">
              Start again
            </Link>{' '}
            and we will send a new one.
          </p>
        </Card>
      </Shell>
    );
  }

  return (
    <Shell>
      <Card>
        <Title>Confirm your email</Title>
        <Lede>
          This creates <strong>{pending.organizationName}</strong> on VeloExpense, at{' '}
          <strong>{pending.slug}</strong>, with you as its administrator.
        </Lede>
        <form action={confirmSignupFromForm} className="flex flex-col gap-3">
          <input name="token" type="hidden" value={token ?? ''} />
          <Button type="submit">Create {pending.organizationName}</Button>
        </form>
        <p className="text-xs text-muted-foreground">
          Nothing is created until you press the button. If you did not ask for this, close
          this page and the link will expire on its own.
        </p>
      </Card>
    </Shell>
  );
}
