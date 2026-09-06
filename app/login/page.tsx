/**
 * VX0-7 login page — the branded split-screen LoginScreen from the vendored
 * auth-kit. SSO-only + invite-only (showCredentials=false). The user types
 * their org slug, clicks Google/Microsoft; we set the org cookie server-side
 * then hand off to NextAuth signIn().
 *
 * VX5-2b made this a server component so it can seed that field from `?org=`,
 * which is how somebody arrives from `/signup/verify`. The screen itself is
 * unchanged, in `login-screen.tsx`.
 *
 * ── VX5-6: THIS PAGE IS DELIBERATELY NOT BRANDED PER TENANT ─────────────────
 *
 * It could be. Since VX5-5 the host names the tenant before anybody signs in, so
 * `acme.veloexpense.app/login` could show Acme's colours and mark, and every
 * subdomain-per-customer product does exactly that.
 *
 * John's call, and GAP-AUDIT BR-4's warning, is that it should not: a branded
 * sign-in page is "an unauthenticated oracle for — does this company use
 * VeloExpense, and what is its logo", readable by anybody who can guess a
 * company's name. The counter-argument is that the ADDRESS already discloses it
 * and the colours only make it visible; the counter-counter is that the address
 * discloses it to somebody who went looking, and a rendered page discloses it to
 * a crawler.
 *
 * So the tenant's identity appears where a CREDENTIAL earns it —
 * `/invite/accept`, reachable only with a live invitation token — and not here.
 * If this is revisited, revisit BR-4 with it; do not treat the absence as an
 * oversight, because it is the whole of VX5-6's decision.
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
