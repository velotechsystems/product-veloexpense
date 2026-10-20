/**
 * POST /oauth/revoke — RFC 7009. Always 200: the answer never says whether a token existed.
 * Ported from VeloCRM's `/oauth/revoke` (59fce1c); VeloExpense (mcp-oauth) VERIFIES an access
 * token before acting on it and ends the grant it names (lib/mcpOauth/service.ts says why).
 */
import { oauthBaseOr503, oauthJson, readForm } from '@/lib/mcpOauth/http';
import { revokeByClient } from '@/lib/mcpOauth/service';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const gate = oauthBaseOr503(request);
  if ('response' in gate) return gate.response;
  const form = await readForm(request);
  const token = form?.get('token');
  const clientId = form?.get('client_id');
  if (token && clientId) {
    try {
      await revokeByClient({ base: gate.base, token, clientId });
    } catch (err) {
      console.error('[oauth/revoke] error:', err);
    }
  }
  return oauthJson({});
}
