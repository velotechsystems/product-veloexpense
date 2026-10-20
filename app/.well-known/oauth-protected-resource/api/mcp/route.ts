/**
 * RFC 9728's path-specific location for the resource `/api/mcp`: the metadata URL formed by
 * inserting the well-known segment before the resource's path. This is the one Claude asks for
 * (VeloCRM: serving only the root 404'd the connector). Same document as the root.
 */
import { oauthBaseOr503 } from '@/lib/mcpOauth/http';
import { DISCOVERY_CACHE, protectedResourceMetadata } from '@/lib/mcpOauth/metadata';

export const dynamic = 'force-dynamic';

export function GET(request: Request) {
  const gate = oauthBaseOr503(request);
  if ('response' in gate) return gate.response;
  return Response.json(protectedResourceMetadata(gate.base), { headers: DISCOVERY_CACHE });
}
