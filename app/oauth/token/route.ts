/**
 * POST /oauth/token — the authorization_code and refresh_token grants.
 *
 * Ported from VeloCRM `routes/oauth.ts` `POST /oauth/token` (59fce1c): a form body only (a JSON
 * body is refused, as VeloCRM refuses it), `client_id` always, PKCE for the code grant, the
 * issuer and audience taken from the host the client used. The work is in
 * lib/mcpOauth/service.ts. VeloExpense (mcp-oauth): per-address rate limit (VeloCRM has none
 * here), and the client is looked up only to be told `invalid_client` — which tenant the code or
 * refresh token belongs to comes from the code or token itself (0080's hatches), never from the
 * client.
 */
import { limited, oauthBaseOr503, oauthError, oauthJson, readForm } from '@/lib/mcpOauth/http';
import { exchangeCode, findClient, refreshTokens, type TokenResult } from '@/lib/mcpOauth/service';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const gate = oauthBaseOr503(request);
  if ('response' in gate) return gate.response;
  const slow = await limited('token', request);
  if (slow) return slow;

  const form = await readForm(request);
  if (!form) {
    return oauthError(
      'invalid_request',
      'Token endpoint requires application/x-www-form-urlencoded; JSON body is not accepted',
    );
  }
  const grantType = form.get('grant_type');
  const clientId = form.get('client_id');
  if (!grantType) return oauthError('invalid_request', 'grant_type is required');
  if (!clientId) return oauthError('invalid_request', 'client_id is required');
  if (!(await findClient(clientId))) return oauthError('invalid_client', 'Unknown client', 401);

  let result: TokenResult;
  if (grantType === 'authorization_code') {
    const code = form.get('code');
    const codeVerifier = form.get('code_verifier');
    const redirectUri = form.get('redirect_uri');
    if (!code || !codeVerifier || !redirectUri) {
      return oauthError(
        'invalid_request',
        'code, code_verifier, and redirect_uri are required for authorization_code grant',
      );
    }
    result = await exchangeCode({ base: gate.base, code, codeVerifier, clientId, redirectUri });
  } else if (grantType === 'refresh_token') {
    const refreshToken = form.get('refresh_token');
    if (!refreshToken) return oauthError('invalid_request', 'refresh_token is required for refresh_token grant');
    result = await refreshTokens({ base: gate.base, refreshToken, clientId });
  } else {
    return oauthError('unsupported_grant_type', `Unsupported grant_type: ${grantType}`);
  }

  return result.ok ? oauthJson(result.body) : oauthError(result.error, result.description);
}
