/**
 * VX0-7 login page — the branded split-screen LoginScreen from the vendored
 * auth-kit. SSO-only + invite-only (showCredentials=false). The user types
 * their org slug, clicks Google/Microsoft; we set the org cookie server-side
 * then hand off to NextAuth signIn().
 *
 * VX5-2b made this a server component so it can seed that field from `?org=`,
 * which is how somebody arrives from `/signup/verify`. The screen itself is
 * unchanged, in `login-screen.tsx`.
 */
import { LoginScreen } from './login-screen';
import { checkSlug } from '@/lib/onboarding/slug';

export const dynamic = 'force-dynamic';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ org?: string }>;
}) {
  const { org } = await searchParams;
  // Validated, not trusted. `?org=` is whatever is in the address bar, and it is
  // about to be prefilled into a field whose value goes into an HttpOnly cookie.
  // `setSsoOrgCookie` checks the shape again on the way in — this is the same
  // rule at the other end, so nothing unusable is ever shown as though it were.
  const initialOrgSlug = org !== undefined && checkSlug(org) === null ? org : '';
  return <LoginScreen initialOrgSlug={initialOrgSlug} />;
}
