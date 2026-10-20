/**
 * GET /oauth/authorize — the consent screen a Claude connector opens.
 *
 * Ported from VeloCRM `routes/oauth.ts` `GET /oauth/authorize` and `/authorize/resume`
 * (59fce1c). VeloCRM renders a script-free HTML string and bridges signed-out people through its
 * Google SSO with an HMAC'd "pending" cookie, then resumes. VeloExpense (mcp-oauth):
 *
 *   · A page in the app, with the kit's components and the catalogues (en, fr-CA), inside the
 *     app shell when signed in — it is a VeloExpense screen asking a VeloExpense question.
 *   · SIGNED OUT → `/login?callbackUrl=<this URL>`, and the sign-in page brings the person back
 *     here with the request intact. That replaces VeloCRM's pending cookie and resume route:
 *     the authorization request IS the URL, and the sign-in callback already carries a path.
 *     (`proxy.ts` lets `/oauth/` through so this page can do it with the query string kept; its
 *     own redirect keeps only the path.)
 *   · The TENANT is the signed-in person's own (their session's organization), never anything
 *     the request names. One connector URL serves every company; who consents decides where
 *     the grant lives.
 *   · Problems with the client or its redirect URI are shown HERE and nothing is sent to the
 *     redirect URI; problems with the rest of the request go back to the (validated) redirect
 *     URI as RFC 6749 errors.
 *   · The form posts one signed ticket (lib/mcpOauth/authorizeRequest.ts says why).
 */
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { headers } from 'next/headers';
import { PageHeader, Screen } from '@/components/screen';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { pageTitle } from '@/lib/i18n/page-title';
import { oauthBaseUrl } from '@/lib/mcpOauth/host';
import { signingKey } from '@/lib/mcpOauth/keys';
import { findClient } from '@/lib/mcpOauth/service';
import { redirectWith, signTicket, validateAuthorize } from '@/lib/mcpOauth/authorizeRequest';
import { auth } from '@/auth';
import { shellState } from '@/server/shell';

export const dynamic = 'force-dynamic';

export function generateMetadata() {
  return pageTitle('title.oauth.authorize');
}

type Search = Record<string, string | string[] | undefined>;

async function Problem({ reason }: { reason: string }) {
  const t = await getTranslations('oauth');
  return (
    <Screen width="narrow">
      <PageHeader title={t('error.title')} />
      <Card>
        <CardContent className="p-5 text-sm" data-testid="oauth-problem" data-reason={reason}>
          {t(`error.${reason}` as 'error.title')}
        </CardContent>
      </Card>
    </Screen>
  );
}

export default async function AuthorizePage({ searchParams }: { searchParams: Promise<Search> }) {
  const q = await searchParams;
  // The consent route sends an expired or unverifiable ticket back here.
  if (q.expired === '1' && q.client_id === undefined) return <Problem reason="expired" />;
  const base = oauthBaseUrl(await headers());
  if (!base || !signingKey()) return <Problem reason="unavailable" />;

  const clientId = typeof q.client_id === 'string' ? q.client_id : null;
  const client = await findClient(clientId);
  const v = validateAuthorize(q, client);
  if ('kind' in v && v.kind === 'page') return <Problem reason={v.reason} />;
  if ('kind' in v && v.kind === 'redirect') {
    const state = typeof q.state === 'string' ? q.state : undefined;
    redirect(
      redirectWith(q.redirect_uri as string, {
        error: v.error,
        error_description: v.description,
        ...(state ? { state } : {}),
        iss: base,
      }),
    );
  }
  const params = v as Exclude<typeof v, { kind: string }>;

  const session = await auth();
  if (!session?.user?.email) {
    const here = new URLSearchParams();
    for (const [k, val] of Object.entries(q)) if (typeof val === 'string') here.set(k, val);
    redirect(`/login?callbackUrl=${encodeURIComponent(`/oauth/authorize?${here.toString()}`)}`);
  }
  const { shell } = await shellState();
  if (!shell) return <Problem reason="refused" />;

  const t = await getTranslations('oauth');
  const ticket = signTicket({ ...params, userId: shell.rbac.id, organizationId: shell.user.organizationId });
  const name = shell.user.name || shell.user.email;
  const returnHost = new URL(params.redirectUri).host;

  return (
    <Screen width="narrow">
      <PageHeader
        title={t('consent.title', { client: client!.clientName })}
        description={t('consent.lede', { client: client!.clientName, company: shell.organizationName })}
      />
      <Card>
        <CardContent className="flex flex-col gap-4 p-5 text-sm">
          <p className="text-muted-foreground">{t('consent.claimed', { client: client!.clientName })}</p>
          <p data-testid="oauth-signed-in-as">{t('consent.signedInAs', { name })}</p>
          <div className="flex flex-col gap-2">
            <p className="font-medium">{t('consent.scopesTitle')}</p>
            <ul className="list-disc pl-5" data-testid="oauth-scopes">
              {params.scopes.map((s) => (
                <li key={s}>{t(`scope.${s.replace(/\./g, '_')}` as 'consent.title')}</li>
              ))}
            </ul>
          </div>
          <p className="text-muted-foreground">{t('consent.dataNote')}</p>
          <form method="POST" action="/oauth/authorize/consent" className="flex flex-col gap-3 border-t border-border pt-4">
            <input type="hidden" name="ticket" value={ticket} />
            <p className="text-xs text-muted-foreground">{t('consent.returnsTo', { host: returnHost })}</p>
            <div className="flex flex-wrap gap-3">
              <Button type="submit" name="decision" value="allow">
                {t('consent.allow')}
              </Button>
              <Button type="submit" name="decision" value="deny" variant="outline">
                {t('consent.deny')}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </Screen>
  );
}
