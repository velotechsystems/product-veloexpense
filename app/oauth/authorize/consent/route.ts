/**
 * POST /oauth/authorize/consent — the person's Allow or Deny.
 *
 * Ported from VeloCRM `routes/oauth.ts` `POST /oauth/authorize/consent` (59fce1c). VeloExpense
 * (mcp-oauth): the form carries one signed ticket, not the request's fields (VeloCRM trusts a
 * posted `tenant_id`, `redirect_uri` and `scope`); the ticket must name the person signed in
 * now, in the tenant their session is in; the client and its redirect URI are checked again;
 * and every redirect is a 303, so the browser follows it with a GET.
 */
import { headers } from 'next/headers';
import { redirectWith, verifyTicket } from '@/lib/mcpOauth/authorizeRequest';
import { oauthBaseUrl } from '@/lib/mcpOauth/host';
import { consent, findClient } from '@/lib/mcpOauth/service';
import { shellState } from '@/server/shell';

export const dynamic = 'force-dynamic';

const seeOther = (location: string) => new Response(null, { status: 303, headers: { location, 'cache-control': 'no-store' } });

export async function POST(request: Request) {
  const form = await request.formData().catch(() => null);
  const ticket = verifyTicket(typeof form?.get('ticket') === 'string' ? (form!.get('ticket') as string) : null);
  // An expired or forged ticket names no redirect URI anyone has validated: back to the screen.
  if (!ticket) return seeOther('/oauth/authorize?expired=1');
  const base = oauthBaseUrl(await headers());

  const client = await findClient(ticket.clientId);
  if (!client || !client.redirectUris.includes(ticket.redirectUri)) return seeOther('/oauth/authorize?expired=1');

  if (form?.get('decision') !== 'allow') {
    return seeOther(
      redirectWith(ticket.redirectUri, { error: 'access_denied', state: ticket.state, ...(base ? { iss: base } : {}) }),
    );
  }

  const { shell } = await shellState();
  if (!shell || shell.rbac.id !== ticket.userId || shell.user.organizationId !== ticket.organizationId) {
    return seeOther('/oauth/authorize?expired=1');
  }

  const { code } = await consent(
    { organizationId: ticket.organizationId, userId: ticket.userId, name: shell.user.name || shell.user.email },
    client,
    ticket.scopes,
    ticket.redirectUri,
    ticket.codeChallenge,
  );
  return seeOther(redirectWith(ticket.redirectUri, { code, state: ticket.state, ...(base ? { iss: base } : {}) }));
}
