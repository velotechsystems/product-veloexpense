/**
 * VX5-3 — `/invite/accept`. Where an invitation link lands.
 *
 * ── WHAT THIS PAGE DOES, WHICH IS LESS THAN IT LOOKS ────────────────────────
 *
 * It sets the organization cookie and sends somebody to sign in. It does NOT
 * accept the invitation, and there is no button here that does.
 *
 * The acceptance happens in `lib/auth/resolve-sso-user.ts`, after Google or
 * Microsoft has verified the address — because that is what an invitation is
 * bound to. A link forwarded to a colleague or pasted into a chat therefore
 * grants nothing: whoever holds it would have to control the invited mailbox as
 * an SSO identity, which is the same thing as being the invited person.
 *
 * That is a stronger position than `/signup/verify`, which DOES act on a button
 * press, and the difference is worth naming rather than looking like an
 * inconsistency: a signup token is the only proof that exists, because there is
 * no tenant and no identity provider in the picture yet. An invite has both.
 *
 * It also means this page is a convenience rather than a gate. Somebody who
 * loses the email can sign in at `/login` with their organization's web address
 * and it works.
 *
 * ── SO WHY READ THE INVITE AT ALL ───────────────────────────────────────────
 *
 * Two reasons, and neither is authorization:
 *
 *   1. To name the organization. "You have been invited to Acme" is the only
 *      thing that lets somebody tell this page from a copy of it, and it is what
 *      stops them signing in to the wrong tenant with the right account.
 *   2. To show WHICH mailbox — masked. Somebody with two work accounts cannot
 *      otherwise tell which to use, and that is the likeliest way this flow
 *      fails for an honest person. `a••••@acme.com` answers it; the full address
 *      would hand a link pasted in a group chat to everybody who can see it.
 *
 * A dead link says so here rather than after a round trip through an identity
 * provider, which is the one thing this page genuinely saves somebody.
 */
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { ErrorBanner } from '@/app/expenses/ui';
import { enumLabel, EMPLOYEE_ROLE_COPY } from '@/lib/i18n/catalog/enums';
import { readerPrefs } from '@/lib/i18n/request';
import { readPendingInvite } from '@/lib/invites/service';
import { Card, Lede, Shell, Title } from '@/app/pre-auth';

export const dynamic = 'force-dynamic';

export default async function AcceptInvitePage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string; error?: string }>;
}) {
  const { token, error } = await searchParams;

  if (error !== undefined) {
    return (
      <Shell>
        <Card>
          <Title>That did not work</Title>
          <ErrorBanner message={error} />
          <p className="text-sm text-muted-foreground">
            Ask whoever invited you to send a new invitation.
          </p>
        </Card>
      </Shell>
    );
  }

  const pending = token === undefined ? null : await readPendingInvite(token);
  if (pending === null) {
    // A missing token and a dead one are the same page, as `/signup/verify`:
    // saying which would tell somebody whether an invitation they hold ever
    // existed.
    return (
      <Shell>
        <Card>
          <Title>That invitation is not usable</Title>
          <ErrorBanner message="INVITE_LINK_DEAD" />
          <p className="text-sm text-muted-foreground">
            Already have an account?{' '}
            <Link className="underline underline-offset-4" href="/login">
              Sign in
            </Link>
          </p>
        </Card>
      </Shell>
    );
  }

  const { locale } = await readerPrefs();
  return (
    /* VX5-6 — the tenant's own colours and mark, on the one pre-auth screen that
     * requires a credential to reach. `PendingInvite.brandColor` carries the
     * argument; the short version is that a live invitation token is not a
     * guessable address, and this is the screen where somebody is deciding
     * whether the email they got was genuine. */
    <Shell
      tenant={{
        name: pending.organizationName,
        brandColor: pending.brandColor,
        logoSrc: pending.logoSrc,
      }}
    >
      <Card>
        <Title>You have been invited to {pending.organizationName}</Title>
        <Lede>
          Sign in with your work account to join as{' '}
          <strong>{enumLabel(EMPLOYEE_ROLE_COPY, pending.role, locale)}</strong>. The invitation
          was sent to <strong>{pending.emailHint}</strong> and only works for that address.
        </Lede>
        <Button asChild>
          <Link href={`/login?org=${encodeURIComponent(pending.organizationSlug)}`}>
            Sign in to accept
          </Link>
        </Button>
        <p className="text-xs text-muted-foreground">
          Nothing is created until you sign in. Signing in with a different account will not
          accept this invitation.
        </p>
      </Card>
    </Shell>
  );
}
