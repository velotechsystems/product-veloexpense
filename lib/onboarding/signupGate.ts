/**
 * Whether this deployment lets anybody create an organization at /signup (decided 18 Oct
 * 2026: production is platform-only, signup off; dev keeps it on).
 *
 * CLOSED unless `SIGNUP_ENABLED` is exactly `true`. Fail-closed on purpose: a new
 * environment that forgets the variable gets no public front door, rather than an open one
 * nobody meant — an open signup on a paid product is free, unbilled tenants for anybody who
 * finds the URL. Read at call time, never at module load (NT-14's rule).
 *
 * The gate is at the edge — the two pages and the two actions — because those are the only
 * callers of `startSignup` / `verifySignup`. Tenants on a closed deployment come from the
 * platform (`/api/platform/provision`), which has its own token and its own gate.
 */
export function signupOpen(): boolean {
  return process.env.SIGNUP_ENABLED === 'true';
}
