/**
 * VX5-2b — `/signup`. The page VX5-1 and VX5-2 both deliberately shipped
 * without, and the first screen in this product a stranger can reach.
 *
 * Three states, chosen by the query string, because a plain form post has no
 * other way to carry one:
 *
 *   (none)        the form
 *   ?sent=…       we have mailed a link — `first` or `again`
 *   ?error=CODE   the form, with the refusal above it
 *
 * NOTHING HERE READS THE DATABASE. The page has no session, no tenant and no
 * actor; every decision it makes is from the URL, and the only writes are the
 * action's. That is what makes it safe to be the one page middleware lets
 * through unauthenticated.
 */
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { ErrorBanner } from '@/app/expenses/ui';
import { SIGNUP_TTL_MINUTES } from '@/lib/onboarding/signup';
import { startSignupFromForm } from './actions';
import { Card, Field, Lede, Shell, Title } from '@/app/pre-auth';

import { pageTitle } from '@/lib/i18n/page-title';

// UD-16. See `lib/i18n/page-title.ts` for why the title lives here rather than
// in a map of routes, and `scripts/check-page-titles.mjs` for what enforces it.
export function generateMetadata() {
  return pageTitle('title.signup');
}

// A public page reading `searchParams`: nothing here is static.
export const dynamic = 'force-dynamic';

export default async function SignupPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; sent?: string }>;
}) {
  const { error, sent } = await searchParams;

  if (sent === 'first' || sent === 'again') {
    return (
      <Shell>
        <Card>
          <Title>Check your inbox</Title>
          {sent === 'again' ? (
            <Lede>
              That address already had a request open, so we have sent a fresh link — the
              earlier one has stopped working. It expires in {SIGNUP_TTL_MINUTES} minutes.
            </Lede>
          ) : (
            <Lede>
              We have sent you a link to confirm your address. It expires in{' '}
              {SIGNUP_TTL_MINUTES} minutes, and nothing has been created until you click it.
            </Lede>
          )}
          <p className="text-sm text-muted-foreground">
            Nothing arrived?{' '}
            <Link className="underline underline-offset-4" href="/signup">
              Ask again
            </Link>{' '}
            and we will send another.
          </p>
        </Card>
      </Shell>
    );
  }

  return (
    <Shell>
      <Card>
        <Title>Create your organization</Title>
        <Lede>
          Tell us where to reach you. We will send a link to confirm the address, and your
          organization is created when you click it.
        </Lede>

        <ErrorBanner message={error} />

        <form action={startSignupFromForm} className="flex flex-col gap-4">
          <Field
            autoComplete="email"
            label="Your work email"
            name="email"
            required
            type="email"
          />
          <Field
            autoComplete="organization"
            label="Organization name"
            name="organizationName"
            required
            hint="What your people will see when they sign in."
          />
          <Field
            label="Web address (optional)"
            name="slug"
            hint="Lowercase letters, numbers and hyphens. Leave it blank and we will make one from your organization name."
          />
          <Button type="submit">Send the confirmation link</Button>
        </form>

        <p className="text-sm text-muted-foreground">
          Already have an organization?{' '}
          <Link className="underline underline-offset-4" href="/login">
            Sign in
          </Link>
        </p>
      </Card>
    </Shell>
  );
}
