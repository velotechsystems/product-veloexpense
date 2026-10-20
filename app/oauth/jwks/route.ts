/** The public key(s) access tokens are signed with (ported from VeloCRM's `/oauth/jwks`). */
import { oauthBaseOr503 } from '@/lib/mcpOauth/http';
import { jwks } from '@/lib/mcpOauth/keys';

export const dynamic = 'force-dynamic';

export function GET(request: Request) {
  const gate = oauthBaseOr503(request);
  if ('response' in gate) return gate.response;
  return Response.json(jwks(), { headers: { 'cache-control': 'public, max-age=300' } });
}
