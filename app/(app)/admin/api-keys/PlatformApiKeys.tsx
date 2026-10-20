'use client';

/**
 * Platform API keys, on `/admin/api-keys` — minting a service account.
 *
 * This form used to live on `/profile` behind a `kind` dropdown, and that is the whole
 * reason it moved. A platform key is not a personal thing: it names a different subject
 * on each request, so within its scopes it can act as any active user. Offering that one
 * dropdown away from a personal key made the two read as variants of a single choice.
 * They are not.
 *
 * So there is no `kind` control here, and no prop that hides one. The page's own gate
 * (`admin.apiKey.create`) decides whether this component mounts at all; if it is on the
 * screen, the only kind it can mint is PLATFORM. A disabled control, or a prop that hides
 * a field inside a mounted form, would put the decision back on the client — where the
 * server already refuses it.
 *
 * Three pieces carry weight beyond looking right:
 *
 *   · **The issued token gets its own panel that stays until dismissed, announces itself,
 *     and takes focus.** It exists for exactly one render and is never recoverable. A
 *     toast that could be scrolled past would have cost somebody a personal token on
 *     `/profile`; here it costs an impersonation credential. The token itself is rendered
 *     by the shared `TokenReveal`, which is deliberately NOT a form control: this form
 *     used to put it in a `<Textarea>`, where a browser spellchecker may transmit it to a
 *     remote service and a password manager may offer to vault it. A personal key acts as
 *     one user; this one names a different subject per request, so the impersonation
 *     credential is the one that least belongs in a form control. (The allow-list
 *     `<Textarea>` further down is a real input and stays exactly as it is.)
 *   · **Scopes are three-state per resource**, not a checkbox list of scope strings. The
 *     grammar is `resource` (read+write) vs `resource.readonly` (read), and asking somebody
 *     to hold both strings in their head is how a key ends up over-granted. No access is
 *     the default, which matches the server: a key with no scopes can do nothing.
 *   · **The list shows platform keys only.** `apiKeys.list` returns the caller's own USER
 *     keys as well — on `/profile` that was the point; here it would put an admin's
 *     personal keys, each with a live Revoke button, inside the platform-admin surface.
 *
 * Ported from ExpenseOS `apps/web/src/app/[locale]/(app)/admin/api-keys/PlatformApiKeys.tsx` (1e682dd6), w6-04 (d88).
 */

import { type Access, SCOPE_RESOURCES, type ScopeResource } from '@expenseos/api-scopes';
import { Button, Input, Textarea } from '@expenseos/design-system';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { TokenReveal } from '@/components/api-keys/TokenReveal';
import { trpc } from '@/lib/trpc/client';

type ScopeChoice = 'none' | Access;

/** D5's fixed set, in days. `null` is "never". */
const EXPIRY_OPTIONS: ReadonlyArray<{ days: number | null; key: string }> = [
  { days: 30, key: 'expiry30' },
  { days: 7, key: 'expiry7' },
  { days: 90, key: 'expiry90' },
  { days: 180, key: 'expiry180' },
  { days: 365, key: 'expiry365' },
  { days: 730, key: 'expiry730' },
  { days: null, key: 'expiryNever' },
];

/** Turn the three-state picker into the scope strings the server stores. */
export function scopeStringsFrom(choices: Record<string, ScopeChoice>): string[] {
  const out: string[] = [];
  for (const [resource, choice] of Object.entries(choices)) {
    if (choice === 'write') out.push(resource);
    else if (choice === 'read') out.push(`${resource}.readonly`);
  }
  return out.sort();
}

export function PlatformApiKeys() {
  const t = useTranslations('apiKeys');
  const utils = trpc.useUtils();
  const keys = trpc.apiKeys.list.useQuery();

  const [name, setName] = useState('');
  const [expiryDays, setExpiryDays] = useState<number | null>(30);
  const [rateLimit, setRateLimit] = useState('');
  const [ips, setIps] = useState('');
  const [choices, setChoices] = useState<Record<string, ScopeChoice>>({});
  const [issued, setIssued] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const create = trpc.apiKeys.create.useMutation({
    onSuccess: (out) => {
      setIssued(out.token);
      setName('');
      setChoices({});
      setError(null);
      void utils.apiKeys.list.invalidate();
    },
    onError: (e) => setError(e.message),
  });
  const revoke = trpc.apiKeys.revoke.useMutation({
    onSuccess: () => void utils.apiKeys.list.invalidate(),
  });

  /**
   * Clearing the panel is not enough to be rid of the token: it arrived as a MUTATION
   * result, so react-query holds it in the MutationCache until `gcTime` elapses — five
   * minutes by default — long after the panel it was drawn in has gone. `reset()` drops it
   * now.
   */
  const dismiss = () => {
    setIssued(null);
    create.reset();
  };

  const submit = () => {
    const parsedLimit = rateLimit.trim() === '' ? null : Number(rateLimit);
    create.mutate({
      // The only legal kind on this surface, and not a choice anybody makes: the personal
      // path is `apiKeys.requestPersonal`, which takes no configuration at all.
      kind: 'PLATFORM',
      name: name.trim(),
      scopes: scopeStringsFrom(choices),
      rateLimitPerMinute: Number.isFinite(parsedLimit) ? parsedLimit : null,
      allowedIps: ips
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean),
      expiresAt:
        expiryDays === null ? null : new Date(Date.now() + expiryDays * 24 * 60 * 60 * 1000),
    });
  };

  /**
   * `list` returns the caller's own USER keys too. Showing them here would put an admin's
   * personal keys inside the platform-admin surface — a different subject entirely, on a
   * screen about service accounts, each row carrying a live Revoke button.
   */
  const platformKeys = keys.data?.filter((k) => k.kind === 'PLATFORM');

  return (
    <section className="rounded-md border border-border bg-card p-4">
      <h2 className="font-semibold text-foreground">{t('platformTitle')}</h2>
      <p className="mt-1 text-muted-foreground text-sm">{t('platformDescription')}</p>

      {issued && (
        <div role="status" className="mt-4 rounded-md border border-warning/40 bg-warning/5 p-3">
          <p className="font-medium text-foreground text-sm">{t('created')}</p>
          <TokenReveal token={issued} />
          <p className="mt-1 text-muted-foreground text-xs">{t('endpointHint')}</p>
          <Button className="mt-2" size="sm" onClick={dismiss}>
            {t('dismiss')}
          </Button>
        </div>
      )}

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <label htmlFor="ak-name" className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">{t('name')}</span>
          <Input
            id="ak-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('namePlaceholder')}
          />
        </label>

        <label htmlFor="ak-expiry" className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">{t('expiry')}</span>
          <select
            id="ak-expiry"
            className="h-9 rounded-md border border-border bg-background px-2 text-sm"
            value={String(expiryDays)}
            onChange={(e) =>
              setExpiryDays(e.target.value === 'null' ? null : Number(e.target.value))
            }
          >
            {EXPIRY_OPTIONS.map((o) => (
              <option key={o.key} value={String(o.days)}>
                {t(o.key)}
              </option>
            ))}
          </select>
        </label>

        <label htmlFor="ak-rate" className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">{t('rateLimit')}</span>
          <Input
            id="ak-rate"
            inputMode="numeric"
            value={rateLimit}
            onChange={(e) => setRateLimit(e.target.value)}
          />
          <span className="text-muted-foreground text-xs">{t('rateLimitHelp')}</span>
        </label>

        <label htmlFor="ak-ips" className="flex flex-col gap-1 text-sm sm:col-span-2">
          <span className="text-muted-foreground">{t('allowedIps')}</span>
          <Textarea id="ak-ips" rows={2} value={ips} onChange={(e) => setIps(e.target.value)} />
          <span className="text-muted-foreground text-xs">{t('allowedIpsHelp')}</span>
        </label>
      </div>

      <fieldset className="mt-3">
        <legend className="text-muted-foreground text-sm">{t('scopes')}</legend>
        <p className="text-muted-foreground text-xs">{t('scopesHelp')}</p>
        <div className="mt-2 flex flex-col gap-1">
          {SCOPE_RESOURCES.map((resource: ScopeResource) => (
            <div key={resource} className="flex items-center justify-between gap-2 text-sm">
              <code className="truncate text-foreground text-xs">{resource}</code>
              <select
                aria-label={resource}
                className="h-8 shrink-0 rounded-md border border-border bg-background px-2 text-xs"
                value={choices[resource] ?? 'none'}
                onChange={(e) =>
                  setChoices((prev) => ({ ...prev, [resource]: e.target.value as ScopeChoice }))
                }
              >
                <option value="none">{t('scopeNone')}</option>
                <option value="read">{t('scopeReadOnly')}</option>
                <option value="write">{t('scopeReadWrite')}</option>
              </select>
            </div>
          ))}
        </div>
      </fieldset>

      <Button
        className="mt-3"
        disabled={create.isPending || name.trim().length === 0}
        onClick={submit}
      >
        {create.isPending ? t('creating') : t('create')}
      </Button>
      {error && <p className="mt-2 text-destructive text-sm">{error}</p>}

      <ul className="mt-5 flex flex-col gap-2">
        {platformKeys?.length === 0 && (
          <li className="text-muted-foreground text-sm">{t('platformEmpty')}</li>
        )}
        {platformKeys?.map((k) => (
          <li key={k.id} className="rounded-md border border-border p-2">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate font-medium text-foreground text-sm">{k.name}</p>
                <p className="text-muted-foreground text-xs">
                  {t('kindPlatform')} · <code>{k.prefix}</code> · {t('lastUsed')}:{' '}
                  {k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleDateString() : t('never')} ·{' '}
                  {k.expiresAt ? new Date(k.expiresAt).toLocaleDateString() : t('noExpiry')}
                </p>
                <p className="text-muted-foreground text-xs">
                  {t('provisionedBy')}: {k.createdBy.firstName} {k.createdBy.lastName}
                </p>
                {k.scopes.length > 0 && (
                  <p className="mt-1 flex flex-wrap gap-1">
                    {k.scopes.map((s) => (
                      <span
                        key={s}
                        className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
                      >
                        {s}
                      </span>
                    ))}
                  </p>
                )}
                {!k.manageable && (
                  <p className="mt-1 text-muted-foreground text-xs italic">{t('notManageable')}</p>
                )}
              </div>
              {k.manageable && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={revoke.isPending}
                  onClick={() => revoke.mutate({ id: k.id })}
                >
                  {revoke.isPending ? t('revoking') : t('revoke')}
                </Button>
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
