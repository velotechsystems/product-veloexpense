/**
 * RFC 9728 — OAuth 2.0 Protected Resource Metadata, at the root well-known path. The
 * path-specific copy (`…/oauth-protected-resource/api/mcp`) is the one MCP clients ask for;
 * VeloCRM serves both, and found the hard way that serving only the root 404s Claude.
 */
import { oauthBaseOr503 } from '@/lib/mcpOauth/http';
import { DISCOVERY_CACHE, protectedResourceMetadata } from '@/lib/mcpOauth/metadata';

export const dynamic = 'force-dynamic';

export function GET(request: Request) {
  const gate = oauthBaseOr503(request);
  if ('response' in gate) return gate.response;
  return Response.json(protectedResourceMetadata(gate.base), { headers: DISCOVERY_CACHE });
}
