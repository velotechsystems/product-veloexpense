'use server';
/**
 * VX5-2b — the form behind `/signup`.
 *
 * ── WHAT THIS ACTION IS ALLOWED TO BE ───────────────────────────────────────
 *
 * A `'use server'` export is reachable by anyone who can guess an action id, and
 * this one is on a PUBLIC page, so "reachable by anyone" is not hypothetical —
 * it is the front door. That is fine, and it is fine for exactly one reason:
 * this action creates nothing. It writes a `signup` row and mails a link. The
 * organization is created at verification, by a token that only reaches the
 * address somebody proved they hold.
 *
 * So the abuse this endpoint permits is "send mail to an address" — which is
 * bounded by `0035`'s partial unique index (one live signup per address, so
 * asking again is a RESEND, not another row) and is a job for the edge beyond
 * that. The migration's header says the same thing about what that index does
 * NOT limit: a thousand addresses is a WAF's problem, not an index's.
 *
 * ── THE WEB ADDRESS IS OPTIONAL ─────────────────────────────────────────────
 *
 * Blank means "derive it from the name", via `slugify`. Most people have no
 * opinion about a URL slug and should not be made to have one to sign up;
 * anybody who does can type it. `checkSlug` adjudicates either way inside
 * `startSignup`, so this branch chooses a candidate and decides nothing.
 *
 * `slugify` returns '' when a name yields no valid DNS label at all (a name in a
 * script it strips to nothing). That falls through as an empty slug and comes
 * back as `ORG_SLUG_SHAPE` — the message names what is allowed, and the field is
 * on screen to type it into.
 *
 * ── WHAT IS NOT PRESERVED ON A REFUSAL, AND WHY ─────────────────────────────
 *
 * A redirect loses what they typed; they retype three short fields. That is the
 * house pattern (`/preferences`, `/admin/locale`), and the alternative — putting
 * the values back through the query string — would put somebody's email address
 * in a URL, which is logged by every proxy between them and us. Repopulating
 * without that means client state, which this product does not have anywhere
 * else. Named here rather than left as an oversight; a client form would be a
 * separate decision, not a side effect of this ticket.
 */
import { redirect } from 'next/navigation';
import { signupOpen } from '@/lib/onboarding/signupGate';
import { errorParam } from '@/lib/errors/domain';
import { startSignup } from '@/lib/onboarding/signup';
import { slugify } from '@/lib/onboarding/slug';

const PAGE = '/signup';

/**
 * Copied verbatim from `app/preferences/actions.ts`, as every actions module
 * that catches around a `redirect()` does: Next signals a redirect by THROWING,
 * so a bare `catch` swallows the navigation and the page silently does nothing.
 */
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

export async function startSignupFromForm(form: FormData): Promise<never> {
  // Closed deployments (production) refuse here too, not only on the page: a form can be
  // posted without the page that renders it.
  if (!signupOpen()) redirect(`${PAGE}?error=SIGNUP_CLOSED`);
  const email = String(form.get('email') ?? '');
  const organizationName = String(form.get('organizationName') ?? '');
  const typedSlug = String(form.get('slug') ?? '').trim();
  const slug = typedSlug === '' ? slugify(organizationName) : typedSlug;

  let resent = false;
  try {
    const started = await startSignup({ email, organizationName, slug });
    resent = started.resent;
  } catch (err) {
    rethrowRedirect(err);
    redirect(`${PAGE}?error=${encodeURIComponent(errorParam(err, 'signup'))}`);
  }
  // `sent` carries WHICH of the two happened and nothing else. Not the address:
  // see the header. The distinction is worth a parameter because "we sent a new
  // link and the old one has stopped working" is the sentence somebody who
  // clicked twice needs, and "check your inbox" is not.
  redirect(`${PAGE}?sent=${resent ? 'again' : 'first'}`);
}
