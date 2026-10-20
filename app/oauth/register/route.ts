/**
 * POST /oauth/register — Dynamic Client Registration (RFC 7591).
 *
 * Ported from VeloCRM `routes/oauth.ts` `POST /oauth/register` (59fce1c). VeloExpense
 * (mcp-oauth): ANONYMOUS, as a Claude connector registers — no tenant, no session, no
 * single-tenant special case. A client is global and inert (0080's header): registering one
 * grants nothing until a signed-in person consents to it on the consent screen. Rate-limited per
 * address, VeloCRM's 10 an hour. RFC 7591 errors, 201 with the client's metadata.
 */
import { isDcrError, validateRegistration, type DcrRequest } from '@/lib/mcpOauth/dcr';
import { limited, oauthBaseOr503, oauthError, oauthJson } from '@/lib/mcpOauth/http';
import { registerClient } from '@/lib/mcpOauth/service';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const gate = oauthBaseOr503(request);
  if ('response' in gate) return gate.response;
  const slow = await limited('register', request);
  if (slow) return slow;

  let body: DcrRequest;
  try {
    body = (await request.json()) as DcrRequest;
  } catch {
    return oauthError('invalid_client_metadata', 'The registration body must be JSON.');
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return oauthError('invalid_client_metadata', 'The registration body must be a JSON object.');
  }
  const valid = validateRegistration(body);
  if (isDcrError(valid)) return oauthError(valid.error, valid.error_description);

  const client = await registerClient(valid);
  return oauthJson(
    {
      client_id: client.clientId,
      client_id_issued_at: Math.floor(new Date(client.createdAt).getTime() / 1000),
      client_name: client.clientName,
      redirect_uris: client.redirectUris,
      grant_types: valid.grantTypes,
      response_types: valid.responseTypes,
      token_endpoint_auth_method: 'none',
    },
    201,
  );
}
