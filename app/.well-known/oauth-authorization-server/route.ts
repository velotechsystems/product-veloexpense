/** RFC 8414 — OAuth 2.0 Authorization Server Metadata (ported from VeloCRM's wellKnown.ts). */
import { oauthBaseOr503 } from '@/lib/mcpOauth/http';
import { authorizationServerMetadata, DISCOVERY_CACHE } from '@/lib/mcpOauth/metadata';

export const dynamic = 'force-dynamic';

export function GET(request: Request) {
  const gate = oauthBaseOr503(request);
  if ('response' in gate) return gate.response;
  return Response.json(authorizationServerMetadata(gate.base), { headers: DISCOVERY_CACHE });
}
