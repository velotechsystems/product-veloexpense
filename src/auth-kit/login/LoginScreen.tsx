'use client'

/**
 * The shared VeloTech split-screen login (modeled on the live VeloLedger and
 * VeloCRM screens, captured 2026-07-07):
 *  LEFT  — brand panel: rounded monogram chip, two-line bold headline, muted
 *          subtitle, check-bullet features, © footer. panelStyle 'gradient'
 *          (VeloLedger blue) or 'navy' (VeloCRM).
 *  RIGHT — floating white card (VeloLedger treatment): heading + helper,
 *          UPPERCASE field labels, primary button, "— OR —" divider,
 *          outlined provider buttons, invite-only footnote (VeloCRM copy).
 *
 * The kit stays i18n-framework-agnostic: every string arrives via `labels`
 * so apps can wire next-intl (or anything else) without a hard dependency.
 * Credentials fields render only when `showCredentials` (VeloPulse keeps them
 * for deskless staff; VeloCRM passes false for SSO-only).
 *
 * v0.2 (upstreamed from the VeloPulse AUTH-1 integration):
 *   - required/aria-required on all credential inputs (HTML5 empty-field
 *     validation; VeloPulse e2e asserts empty fields never submit).
 *   - Brand colors come from the --vl-brand-* CSS tokens (every product's
 *     globals.css defines them), not hardcoded VeloLedger blues — 'gradient'
 *     now renders each product's own brand (VeloPulse teal, VeloLedger blue).
 */

import type { FormEvent, ReactNode } from 'react'
import type { LoginBranding } from '../types'

export interface LoginLabels {
  signIn: string
  helper: string
  organization: string
  email: string
  password: string
  submit: string
  submitting: string
  or: string
  continueWithGoogle: string
  continueWithMicrosoft: string
  inviteNote: string
  error?: string
}

export interface LoginScreenProps {
  branding: LoginBranding
  labels: LoginLabels
  showCredentials: boolean
  providers: { google: boolean; microsoft: boolean }
  busy?: boolean
  /** Credentials submit — receives (orgSlug, email, password). */
  onCredentials?: (orgSlug: string, email: string, password: string) => void
  /** SSO click — the app sets the org cookie then calls signIn(provider). */
  onSso?: (provider: 'google' | 'microsoft-entra-id', orgSlug: string) => void
  /** Controlled org slug so SSO + credentials share one field. */
  orgSlug: string
  onOrgSlugChange: (v: string) => void
  emailValue?: string
  onEmailChange?: (v: string) => void
  passwordValue?: string
  onPasswordChange?: (v: string) => void
}

const GoogleGlyph = (): ReactNode => (
  <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
    <path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9 3.5l6.7-6.7C35.6 2.5 30.2 0 24 0 14.6 0 6.5 5.4 2.5 13.2l7.8 6.1C12.2 13.3 17.6 9.5 24 9.5z"/>
    <path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.6 3-2.3 5.5-4.8 7.2l7.5 5.8c4.4-4.1 7.1-10.1 7.1-17.5z"/>
    <path fill="#FBBC05" d="M10.3 28.7a14.5 14.5 0 0 1 0-9.4l-7.8-6.1a24 24 0 0 0 0 21.6l7.8-6.1z"/>
    <path fill="#34A853" d="M24 48c6.2 0 11.4-2 15.2-5.5l-7.5-5.8c-2.1 1.4-4.7 2.3-7.7 2.3-6.4 0-11.8-3.8-13.7-9.3l-7.8 6.1C6.5 42.6 14.6 48 24 48z"/>
  </svg>
)

const MicrosoftGlyph = (): ReactNode => (
  <svg width="16" height="16" viewBox="0 0 23 23" aria-hidden="true">
    <rect x="1" y="1" width="10" height="10" fill="#F25022"/>
    <rect x="12" y="1" width="10" height="10" fill="#7FBA00"/>
    <rect x="1" y="12" width="10" height="10" fill="#00A4EF"/>
    <rect x="12" y="12" width="10" height="10" fill="#FFB900"/>
  </svg>
)

export function LoginScreen(props: LoginScreenProps): ReactNode {
  const { branding, labels, providers } = props
  const panelClass =
    branding.panelStyle === 'gradient'
      ? 'bg-gradient-to-br from-[var(--vl-brand-400)] via-[var(--vl-brand-600)] to-[var(--vl-brand-900)]'
      : 'bg-slate-900'

  function submit(e: FormEvent) {
    e.preventDefault()
    props.onCredentials?.(props.orgSlug.trim(), (props.emailValue ?? '').trim(), props.passwordValue ?? '')
  }

  const orgReady = props.orgSlug.trim().length > 0

  return (
    <div className="flex min-h-screen">
      <aside className={`hidden w-1/2 flex-col justify-between p-10 text-white lg:flex ${panelClass}`}>
        <div className="flex items-center gap-3">
          <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-white/95 text-base font-bold text-[var(--vl-brand-700)]">
            {branding.monogram}
          </span>
          <span className="text-lg font-semibold">{branding.productName}</span>
        </div>
        <div className="max-w-md space-y-5">
          <h1 className="text-4xl font-bold leading-tight">{branding.headline}</h1>
          <p className="text-white/80">{branding.subtitle}</p>
          <ul className="space-y-2">
            {branding.bullets.map((b) => (
              <li key={b} className="flex items-center gap-2 text-sm text-white/90">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <circle cx="12" cy="12" r="11" fill="rgba(255,255,255,.25)"/>
                  <path d="M7 12.5l3 3 7-7" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
                {b}
              </li>
            ))}
          </ul>
        </div>
        <p className="text-xs text-white/60">{branding.footer}</p>
      </aside>

      <main className="flex flex-1 items-center justify-center bg-slate-50 p-6">
        <div className="w-full max-w-md rounded-2xl bg-white p-8 shadow-lg">
          <h2 className="text-2xl font-bold">{labels.signIn}</h2>
          <p className="mt-1 text-sm text-slate-500">{labels.helper}</p>
          {labels.error && (
            <p className="mt-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">{labels.error}</p>
          )}

          <form onSubmit={submit} className="mt-6 space-y-4">
            <label className="block">
              <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">{labels.organization}</span>
              <input
                name="orgSlug"
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-[var(--vl-brand-600)] focus:outline-none"
                value={props.orgSlug}
                onChange={(e) => props.onOrgSlugChange(e.target.value)}
                autoComplete="organization"
                required
                aria-required="true"
              />
            </label>

            {props.showCredentials && (
              <>
                <label className="block">
                  <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">{labels.email}</span>
                  <input
                    name="email"
                    type="email"
                    className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-[var(--vl-brand-600)] focus:outline-none"
                    value={props.emailValue ?? ''}
                    onChange={(e) => props.onEmailChange?.(e.target.value)}
                    autoComplete="email"
                    required
                    aria-required="true"
                  />
                </label>
                <label className="block">
                  <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">{labels.password}</span>
                  <input
                    name="password"
                    type="password"
                    className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-[var(--vl-brand-600)] focus:outline-none"
                    value={props.passwordValue ?? ''}
                    onChange={(e) => props.onPasswordChange?.(e.target.value)}
                    autoComplete="current-password"
                    required
                    aria-required="true"
                  />
                </label>
                <button
                  type="submit"
                  disabled={props.busy}
                  className="w-full rounded-md bg-gradient-to-r from-[var(--vl-brand-600)] to-[var(--vl-brand-900)] py-2.5 text-sm font-semibold text-white disabled:opacity-60"
                >
                  {props.busy ? labels.submitting : labels.submit}
                </button>
              </>
            )}

            {(providers.google || providers.microsoft) && props.showCredentials && (
              <div className="flex items-center gap-3 text-xs uppercase tracking-wide text-slate-400">
                <span className="h-px flex-1 bg-slate-200" />
                {labels.or}
                <span className="h-px flex-1 bg-slate-200" />
              </div>
            )}

            {providers.google && (
              <button
                type="button"
                disabled={props.busy || !orgReady}
                onClick={() => props.onSso?.('google', props.orgSlug.trim())}
                className="flex w-full items-center justify-center gap-2 rounded-md border border-slate-300 py-2.5 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-60"
              >
                <GoogleGlyph /> {labels.continueWithGoogle}
              </button>
            )}
            {providers.microsoft && (
              <button
                type="button"
                disabled={props.busy || !orgReady}
                onClick={() => props.onSso?.('microsoft-entra-id', props.orgSlug.trim())}
                className="flex w-full items-center justify-center gap-2 rounded-md border border-slate-300 py-2.5 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-60"
              >
                <MicrosoftGlyph /> {labels.continueWithMicrosoft}
              </button>
            )}
          </form>

          <p className="mt-6 border-t border-slate-100 pt-4 text-center text-xs text-slate-500">{labels.inviteNote}</p>
        </div>
      </main>
    </div>
  )
}
