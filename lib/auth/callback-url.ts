/**
 * Where to send somebody after they sign in.
 *
 * ── THE BUG THIS EXISTS FOR (7 Oct 2026, the first real sign-in on dev) ──────
 *
 * `app/login/login-screen.tsx` called `signIn(provider)` with no destination.
 * next-auth/react then defaults `redirectTo` to `window.location.href`, which
 * on the login page IS the login page. So a sign-in that SUCCEEDED came back to
 * `/login`, which renders the form regardless of the session: it looked
 * exactly like being refused. CI never saw it because the browser suite mints
 * session cookies directly and never goes through `signIn`
 * (`lib/auth/resolve-sso-user.ts` explains why).
 *
 * The destination is now the `callbackUrl` that `proxy.ts` put on the redirect
 * to `/login` (the page somebody was trying to reach), or `/`.
 *
 * ── WHY IT IS VALIDATED HERE AND NOT LEFT TO AUTH.JS ────────────────────────
 *
 * `callbackUrl` is whatever is in the address bar, so anybody can send a link
 * with one. Auth.js's default `redirect` callback already refuses other origins,
 * but that is one check in a vendored dependency; an open redirect on a sign-in
 * page is the classic phishing aid, so the value is narrowed here as well, to a
 * same-origin PATH:
 *
 *   · must start with exactly one `/`: `//evil.example` and `/\evil.example`
 *     are protocol-relative to a browser, i.e. another origin;
 *   · no control characters or whitespace (some browsers strip them, turning a
 *     harmless-looking path into one of the above);
 *   · never back to `/login`, `/signup` or `/api/auth`, which would put somebody
 *     who just signed in back on a sign-in screen, or into the auth handler.
 *
 * Anything else falls back to `/`.
 */
const NOT_AFTER_SIGN_IN = [/^\/login(?:[/?#]|$)/, /^\/signup(?:[/?#]|$)/, /^\/api\/auth(?:[/?#]|$)/];

export function safeCallbackPath(raw: string | null | undefined): string {
  if (typeof raw !== 'string') return '/';
  const v = raw.trim();
  if (v === '' || v.length > 2048) return '/';
  if (!v.startsWith('/') || v.startsWith('//') || v.startsWith('/\\')) return '/';
  if (/[\u0000-\u001f\u007f\s\\]/.test(v)) return '/';
  if (NOT_AFTER_SIGN_IN.some((re) => re.test(v))) return '/';
  return v;
}
