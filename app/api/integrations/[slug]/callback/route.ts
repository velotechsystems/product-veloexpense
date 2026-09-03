/**
 * VX3-8 — GET /api/integrations/[slug]/callback
 *
 * Where an admin's browser lands after consenting at the far end. One route for
 * every OAUTH2 adapter, resolved by slug: adding a vendor adds no route, which is
 * the same property `resolveCapability` gives the posting path.
 *
 * ── There is no session here, and that is the whole design problem ───────────
 *
 * The request arrives from the far end. It carries a `code` and a `state` and
 * nothing else — no cookie, no tenant, nothing to trust. So the tenant is derived
 * from the state row, through `0020`'s narrow `platform_read` policy which matches
 * only unconsumed, unexpired attempts. A replayed or stale callback finds no row
 * at all, which makes rejecting it an absence rather than a check somebody has to
 * remember to write.
 *
 * That also means the STATE is the only credential in play, so `lib/integrations/
 * oauth.ts` treats it as one: minted from `randomBytes`, stored as a sha256, used
 * once, and expiring in minutes.
 *
 * ── Why GET, when it changes state ──────────────────────────────────────────
 *
 * Because the far end decides the method, and every OAuth2 provider redirects with
 * a GET. Not a choice this end gets to make. What makes it safe is that the
 * request carries no ambient authority — no cookie is consulted, and a forged
 * request without a valid unconsumed state does nothing at all.
 *
 * ── Errors go to the SCREEN, not to a JSON body ─────────────────────────────
 *
 * A person is looking at this in a browser, mid-task. A JSON error page is a dead
 * end for them, so every outcome redirects back to /admin/integrations carrying a
 * sentence. The one exception is a request so malformed it names no adapter, which
 * gets a plain 400 because there is nowhere sensible to send it.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { IntegrationError } from '@/lib/integrations/errors';
import { completeAuthorisation } from '@/lib/integrations/oauth';
import { adapterFor } from '@/lib/integrations/registry';
import { appOrigin } from '@/lib/notifications/email';

export const dynamic = 'force-dynamic';

const SCREEN = '/admin/integrations';

/**
 * Back to the screen, on the origin the ADMIN is actually using.
 *
 * ── AC-23. This used `req.nextUrl.origin`, and that is the wrong source ─────
 *
 * A round trip has two legs and they were built from two different places.
 * `authoriseFromForm` builds the `redirect_uri` from `appOrigin()` — APP_URL — and
 * this built the way onward from the incoming request's own origin. In a standalone
 * server bound to 0.0.0.0, or behind any proxy, those are not the same string: the
 * e2e landed on `http://0.0.0.0:3000/admin/integrations`, an origin the session
 * cookie does not cover, and middleware bounced the admin to `/login`.
 *
 * The authorisation had SUCCEEDED. The tokens were stored, the connection was
 * live, and the person who pressed the button saw a login page — so the only
 * reasonable thing for them to do is try again, mint another state, and consent a
 * second time to something that already worked.
 *
 * That is NT-14's family: an origin read from the wrong source. Same fix as NT-14's
 * — one authority for the app's own address, read at call time — with the request's
 * origin kept as the fallback for a deployment that has no APP_URL, where a
 * same-origin redirect is still better than none.
 *
 * Found by `e2e/oauth-flow.spec.ts`, which is the only thing in the repo that
 * walks the redirect. No unit test could have: `completeAuthorisation` returns
 * successfully in both worlds.
 */
function back(req: NextRequest, params: Record<string, string>): NextResponse {
  const url = new URL(SCREEN, appOrigin() ?? req.nextUrl.origin);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return NextResponse.redirect(url);
}

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
  const { slug } = await ctx.params;

  // An unknown slug is not worth a redirect: either the deployment changed under
  // an in-flight authorisation, or somebody is poking at URLs.
  if (!adapterFor(slug)) {
    return NextResponse.json({ error: 'unknown integration' }, { status: 404 });
  }

  const sp = req.nextUrl.searchParams;

  // The far end can also come back with a refusal instead of a code — the admin
  // pressed Cancel, or does not have permission on the company they chose. That is
  // a normal outcome and it deserves a sentence, not an error page.
  const providerError = sp.get('error');
  if (providerError) {
    return back(req, {
      error:
        sp.get('error_description') ??
        `The accounting system refused the connection (${providerError}). Nothing was changed.`,
    });
  }

  const code = sp.get('code');
  const state = sp.get('state');
  if (!code || !state) {
    return back(req, {
      error: 'That authorisation came back incomplete. Start the connection again.',
    });
  }

  // Everything else the far end sent, so an adapter can read a vendor-specific
  // identifier without this route knowing what it is called. `code` and `state`
  // are handled above and excluded, so an adapter cannot mistake one for its own.
  const callbackParams: Record<string, string> = {};
  for (const [k, v] of sp.entries()) {
    if (k !== 'code' && k !== 'state') callbackParams[k] = v;
  }

  try {
    const result = await completeAuthorisation({ stateValue: state, code, callbackParams });
    return back(req, {
      notice: `${result.adapterName} is connected. Use "Test" to check it before relying on it.`,
    });
  } catch (err) {
    // `oauth.ts` writes IntegrationError's messages to be read by the admin who
    // just pressed a button, including keeping "unknown", "already used" and
    // "expired" indistinguishable so the wording cannot be used to probe for
    // valid states. Those are surfaced as they are.
    //
    // VX4-7 part 2c narrowed the guard from `instanceof Error`. This handler
    // wraps a call into an adapter, an HTTP client and the database, so the
    // catch-all was reachable by anything any of them throws — a `TypeError`
    // from a bug, or a `pg` error carrying a fragment of the statement — and all
    // of it went into a query string and onto an admin's screen. The message now
    // goes to the log and the admin gets the generic.
    if (!(err instanceof IntegrationError)) {
      console.error('[integrations/callback] unexpected error surfaced to a user:', err);
      return back(req, { error: 'UNEXPECTED' });
    }
    return back(req, { error: err.message });
  }
}
