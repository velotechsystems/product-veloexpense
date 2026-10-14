'use client';
/**
 * VX0-7's login screen, moved out of `page.tsx` by VX5-2b.
 *
 * The split exists so the page above can be a SERVER component and read
 * `searchParams`: `/signup/verify` finishes by sending somebody to
 * `/login?org=<their new web address>`, and without this they would read their
 * address on one screen and retype it on the next — on the first sign-in of
 * their first day, which is the worst possible place for that seam.
 *
 * Doing it with `useSearchParams()` instead would have kept one file and cost a
 * Suspense boundary around the whole screen (Next refuses to prerender a client
 * component that reads the query string without one). Reading it on the server
 * and passing a prop is the smaller change and the one that keeps this file's
 * only job — the SSO handoff — intact.
 */
import { useState } from 'react';
import { signIn } from 'next-auth/react';
import { LoginScreen as AuthKitLoginScreen } from '@/src/auth-kit/login/LoginScreen';
import { setSsoOrgCookie } from './actions';

export function LoginScreen({ initialOrgSlug, redirectTo }: { initialOrgSlug: string; redirectTo: string }) {
  const [orgSlug, setOrgSlug] = useState(initialOrgSlug);

  return (
    <AuthKitLoginScreen
      branding={{
        monogram: 'VX',
        productName: 'VeloExpense',
        headline: 'Expense management, simplified.',
        subtitle: 'Submit, approve, and reconcile expenses across your organization.',
        bullets: ['Sign in with Google', 'Multi-currency & tax built in', 'Connects to your accounting system'],
        panelStyle: 'gradient',
        footer: '© 2026 Velotech Systems',
      }}
      labels={{
        signIn: 'Sign in',
        helper: 'Use your work account to continue.',
        organization: 'Organization',
        email: 'Email',
        password: 'Password',
        submit: 'Sign in',
        submitting: 'Signing in…',
        or: '— OR —',
        continueWithGoogle: 'Continue with Google',
        continueWithMicrosoft: 'Continue with Microsoft',
        inviteNote: 'Access is invite-only. Ask your admin for an invite.',
      }}
      showCredentials={false}
      // AUTHKITSYNC-VE-1: no Microsoft button. auth-kit v0.3 does not offer
      // Microsoft to a product that has not bound it to each organization's
      // Entra directory (auth.ts; lib/auth/resolve-sso-user.ts says why), so the
      // button could only lead to an error page.
      providers={{ google: true, microsoft: false }}
      orgSlug={orgSlug}
      onOrgSlugChange={setOrgSlug}
      onSso={async (provider, slug) => {
        const res = await setSsoOrgCookie(slug);
        // `redirectTo` is REQUIRED here: without it next-auth/react returns to
        // `window.location.href` — this login page — and a successful sign-in
        // looks like a refused one (lib/auth/callback-url.ts).
        if (res.ok) signIn(provider, { redirectTo });
      }}
    />
  );
}
