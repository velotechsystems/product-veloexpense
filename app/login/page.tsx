'use client';
/**
 * VX0-7 login page — the branded split-screen LoginScreen from the vendored
 * auth-kit. SSO-only + invite-only (showCredentials=false). The user types
 * their org slug, clicks Google/Microsoft; we set the org cookie server-side
 * then hand off to NextAuth signIn().
 */
import { useState } from 'react';
import { signIn } from 'next-auth/react';
import { LoginScreen } from '@/src/auth-kit/login/LoginScreen';
import { setSsoOrgCookie } from './actions';

export default function LoginPage() {
  const [orgSlug, setOrgSlug] = useState('');

  return (
    <LoginScreen
      branding={{
        monogram: 'VX',
        productName: 'VeloExpense',
        headline: 'Expense management, simplified.',
        subtitle: 'Submit, approve, and reconcile expenses across your organization.',
        bullets: ['Google & Microsoft SSO', 'Multi-currency & tax built in', 'Connects to your accounting system'],
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
      providers={{ google: true, microsoft: true }}
      orgSlug={orgSlug}
      onOrgSlugChange={setOrgSlug}
      onSso={async (provider, slug) => {
        const res = await setSsoOrgCookie(slug);
        if (res.ok) signIn(provider);
      }}
    />
  );
}
