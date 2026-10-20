'use client';

/**
 * Connected applications — the OAuth grants behind Claude connectors.
 *
 * Ported from VeloCRM `web/src/app/settings/connected-mcp-clients/page.tsx` (the person's own
 * list, with Disconnect) and `settings/admin/mcp-clients/page.tsx` (the tenant's list, for an
 * admin) at 59fce1c, with `useOAuthGrants`'s queries as tRPC. VeloExpense (mcp-oauth): both are
 * sections rather than pages — the person's sits on /preferences beside the personal API key
 * box, the admin's on /admin/api-keys beside the platform keys and the request log — because a
 * connector and a key are the same kind of credential, and somebody looking for one should find
 * the other. VeloCRM's admin approve/reject has no equivalent (server/routers/oauthGrants.ts).
 */
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@expenseos/design-system';
import { useFormatter, useTranslations } from 'next-intl';
import { useState } from 'react';
import { trpc } from '@/lib/trpc/client';

type Grant = {
  id: string;
  clientName: string;
  scopes: string[];
  connectedAt: Date | string | null;
  lastUsedAt: Date | string | null;
  person?: string;
};

function useWhen() {
  const format = useFormatter();
  return (d: Date | string | null) => (d ? format.dateTime(new Date(d), { dateStyle: 'medium' }) : '');
}

function scopeKey(s: string): string {
  return `scope.${s.replace(/\./g, '_')}`;
}

function DisconnectDialog({
  grant,
  pending,
  onConfirm,
  onClose,
}: {
  grant: Grant | null;
  pending: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const t = useTranslations('oauth');
  return (
    <Dialog open={grant !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('connected.confirmTitle', { client: grant?.clientName ?? '' })}</DialogTitle>
          <DialogDescription>{t('connected.confirmBody')}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={pending}>
            {t('connected.cancel')}
          </Button>
          <Button variant="destructive" onClick={onConfirm} disabled={pending}>
            {pending ? t('connected.disconnecting') : t('connected.disconnect')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The signed-in person's own connected applications, on /preferences. */
export function ConnectedApps() {
  const t = useTranslations('oauth');
  const when = useWhen();
  const utils = trpc.useUtils();
  const grants = trpc.oauthGrants.mine.useQuery();
  const [confirming, setConfirming] = useState<Grant | null>(null);
  const revoke = trpc.oauthGrants.revokeMine.useMutation({
    onSuccess: () => {
      setConfirming(null);
      void utils.oauthGrants.mine.invalidate();
    },
  });

  return (
    <Card className="mx-auto w-full max-w-2xl" data-testid="connected-apps">
      <CardHeader>
        <CardTitle>{t('connected.title')}</CardTitle>
        <CardDescription>{t('connected.description')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {grants.data && grants.data.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('connected.empty')}</p>
        ) : null}
        {(grants.data ?? []).map((g) => (
          <div
            key={g.id}
            className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-border p-3"
            data-testid="connected-app"
          >
            <div className="flex min-w-0 flex-col gap-1 text-sm">
              <span className="font-medium break-words">{g.clientName}</span>
              <ul className="list-disc pl-5 text-muted-foreground">
                {g.scopes.map((s) => (
                  <li key={s}>{t(scopeKey(s) as 'connected.title')}</li>
                ))}
              </ul>
              <span className="text-xs text-muted-foreground">
                {t('connected.since', { date: when(g.connectedAt) })} ·{' '}
                {g.lastUsedAt ? t('connected.lastUsed', { date: when(g.lastUsedAt) }) : t('connected.neverUsed')}
              </span>
            </div>
            <Button variant="outline" size="sm" onClick={() => setConfirming(g)}>
              {t('connected.disconnect')}
            </Button>
          </div>
        ))}
        {revoke.error ? (
          <p role="alert" className="text-sm text-destructive">
            {t('connected.failed')}
          </p>
        ) : null}
      </CardContent>
      <DisconnectDialog
        grant={confirming}
        pending={revoke.isPending}
        onClose={() => setConfirming(null)}
        onConfirm={() => confirming && revoke.mutate({ grantId: confirming.id })}
      />
    </Card>
  );
}

/** Every connected application in the tenant, on /admin/api-keys. */
export function AdminConnectedApps() {
  const t = useTranslations('oauth');
  const when = useWhen();
  const utils = trpc.useUtils();
  const grants = trpc.oauthGrants.all.useQuery();
  const [confirming, setConfirming] = useState<Grant | null>(null);
  const revoke = trpc.oauthGrants.revoke.useMutation({
    onSuccess: () => {
      setConfirming(null);
      void utils.oauthGrants.all.invalidate();
    },
  });

  return (
    <Card data-testid="admin-connected-apps">
      <CardHeader>
        <CardTitle>{t('admin.title')}</CardTitle>
        <CardDescription>{t('admin.description')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {grants.data && grants.data.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('admin.empty')}</p>
        ) : null}
        {(grants.data ?? []).map((g) => (
          <div
            key={g.id}
            className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-border p-3 text-sm"
            data-testid="admin-connected-app"
          >
            <dl className="grid min-w-0 grid-cols-[auto_1fr] gap-x-3 gap-y-1">
              <dt className="text-muted-foreground">{t('admin.person')}</dt>
              <dd className="break-words">{g.person}</dd>
              <dt className="text-muted-foreground">{t('admin.application')}</dt>
              <dd className="break-words">{g.clientName}</dd>
              <dt className="text-muted-foreground">{t('admin.access')}</dt>
              <dd>{g.scopes.map((s) => t(scopeKey(s) as 'admin.title')).join('; ')}</dd>
              <dt className="text-muted-foreground">{t('admin.connected')}</dt>
              <dd>{when(g.connectedAt)}</dd>
              <dt className="text-muted-foreground">{t('admin.lastUsed')}</dt>
              <dd>{g.lastUsedAt ? when(g.lastUsedAt) : t('connected.neverUsed')}</dd>
            </dl>
            <Button variant="outline" size="sm" onClick={() => setConfirming(g)}>
              {t('connected.disconnect')}
            </Button>
          </div>
        ))}
        {revoke.error ? (
          <p role="alert" className="text-sm text-destructive">
            {t('connected.failed')}
          </p>
        ) : null}
      </CardContent>
      <DisconnectDialog
        grant={confirming}
        pending={revoke.isPending}
        onClose={() => setConfirming(null)}
        onConfirm={() => confirming && revoke.mutate({ grantId: confirming.id })}
      />
    </Card>
  );
}
