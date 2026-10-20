/**
 * f04 — what a signed-in person sees when their account here is deactivated, or their
 * access has been turned off.
 *
 * Before this, such a person got whatever the page did with no shell: a blank dashboard,
 * or `forbidden.tsx` telling them they do not administer this organization — and, before
 * the shell stopped throwing, a 500. The sentence is the one `requireActor` and the admin
 * gate already use (ACCOUNT_DEACTIVATED / ACCESS_REVOKED), and the one way forward that is
 * theirs to take — sign out, perhaps to sign in to another organization — is a button.
 *
 * Drawn by the root layout in place of the page (app/layout.tsx); every procedure and API
 * route still refuses on its own (resolveTenantMember).
 */
import { renderUserMessage } from '@/lib/i18n/catalog/errors';
import { PageHeader, Screen } from '@/components/screen';
import type { MemberRefusal } from '@/server/trpc';
import { SignOutButton } from './account-unavailable-sign-out';

export function AccountUnavailable({
  reason,
  locale,
}: {
  reason: MemberRefusal['reason'];
  locale: string;
}) {
  return (
    <Screen width="narrow" className="gap-4">
      {/* English, as app/forbidden.tsx's heading: the error catalogue holds sentences. */}
      <PageHeader title="Your account is not open here" />
      <p data-testid="account-unavailable-reason" className="text-sm">
        {renderUserMessage(reason, locale)}
      </p>
      <div>
        <SignOutButton label="Sign out" />
      </div>
    </Screen>
  );
}
