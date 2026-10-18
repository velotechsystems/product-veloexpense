'use server';
/**
 * VX5-2b — the POST that creates the tenant.
 *
 * ── WHY THIS IS A POST AND NOT THE GET ──────────────────────────────────────
 *
 * `app/approve/page.tsx` had this argument first and it applies here with more
 * force. Mail clients and corporate link scanners fetch every URL in a message
 * before a person sees it. `verifySignup` consumes a single-use token and
 * creates an organization, so a bare GET means Outlook provisions somebody's
 * company — and then hands the human a dead link to a tenant they never made
 * and cannot sign into, with no way to start again because the address now has
 * a consumed signup and the slug is taken.
 *
 * The GET renders a question. This runs on the answer.
 *
 * ── WHAT COMES BACK WHEN SOMEBODY IS SECOND ─────────────────────────────────
 *
 * `verifySignup` throws `SIGNUP_LINK_DEAD` for unknown, consumed and expired
 * alike, because `0035`'s policy makes them one case. A second click on a link
 * that worked lands here: the row is no longer live, so it is not found, so the
 * person is told the link is spent rather than being told their own
 * organization's name is taken — which is what a check ordered the other way
 * round would have said.
 */
import { redirect } from 'next/navigation';
import { signupOpen } from '@/lib/onboarding/signupGate';
import { errorParam } from '@/lib/errors/domain';
import { verifySignup } from '@/lib/onboarding/signup';

const PAGE = '/signup/verify';

/** As `app/preferences/actions.ts`: a `redirect()` is a throw, and a bare catch eats it. */
function rethrowRedirect(err: unknown): void {
  if (
    typeof err === 'object' &&
    err !== null &&
    'digest' in err &&
    typeof (err as { digest?: unknown }).digest === 'string' &&
    (err as { digest: string }).digest.startsWith('NEXT_REDIRECT')
  ) {
    throw err;
  }
}

export async function confirmSignupFromForm(form: FormData): Promise<never> {
  // A link mailed before signup was closed must not create an organization after it.
  if (!signupOpen()) redirect(`${PAGE}?error=SIGNUP_CLOSED`);
  const token = String(form.get('token') ?? '');

  let slug: string;
  try {
    const verified = await verifySignup(token);
    slug = verified.slug;
  } catch (err) {
    rethrowRedirect(err);
    redirect(`${PAGE}?error=${encodeURIComponent(errorParam(err, 'signup-verify'))}`);
  }
  // The TOKEN does not survive the redirect, which is the point of redirecting
  // rather than rendering: what is left in the address bar, in history, and in
  // whatever the browser syncs, is a public web address rather than a
  // credential. It is spent either way — but a spent credential in a URL is
  // still a credential somebody can read over a shoulder and try.
  redirect(`${PAGE}?created=${encodeURIComponent(slug)}`);
}
