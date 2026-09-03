/**
 * VX3-3 — /admin/integrations. Connect a ledger, test it, disconnect it.
 *
 * Server component posting plain `<form action={serverAction}>`, no client JS.
 * Row forms live after the table because a `<form>` may not be a child of a
 * `<tr>`; inputs point at them with the HTML `form` attribute.
 *
 * ── What this screen is careful about ───────────────────────────────────────
 *
 * A SECRET IS NEVER RENDERED. Not masked — absent. A secret field on an existing
 * connection shows an empty box and the words "already set", and leaving it empty
 * keeps what is stored. Masking implies the value is here and merely hidden, which
 * is how a secret ends up in a page's HTML source.
 *
 * DISCONNECT SAYS WHAT IT DESTROYS. It deactivates the connection AND deletes the
 * credentials — a disconnect that leaves a working credential in the database is
 * not a disconnect. The button says so, because "disconnect" otherwise reads as
 * reversible.
 *
 * TESTING IS A QUESTION, NOT A SIDE EFFECT. The result is shown as an answer to
 * the button that was pressed, and the durable record lives on the row so an
 * operator can see that the last successful test was in March.
 */
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { EmptyRow, ErrorBanner } from '@/app/expenses/ui';
import { formatInstant } from '@/lib/i18n/format';
import { enumLabel, CAPABILITY_COPY } from '@/lib/i18n/catalog/enums';
import { readerPrefs } from '@/lib/i18n/request';
import {
  connectFromForm,
  authoriseFromForm,
  disconnectFromForm,
  getIntegrationsPage,
  testFromForm,
  updateFromForm,
} from './actions';

export const dynamic = 'force-dynamic';

type Page = Awaited<ReturnType<typeof getIntegrationsPage>>;
type Installation = Page['installations'][number];
type Available = Page['available'][number];

function ConfigFields({
  fields,
  installation,
  formId,
}: {
  fields: Available['configFields'];
  installation?: Installation;
  formId?: string;
}) {
  return (
    <div className="flex flex-col gap-3">
      {fields.map((field) => {
        const isSecret = field.type === 'secret';
        const alreadySet = installation?.secretsSet.includes(field.name) ?? false;
        const id = `${formId ?? 'new'}-${field.name}`;
        return (
          <div key={field.name} className="flex flex-col gap-1">
            <label className="text-xs text-muted-foreground" htmlFor={id}>
              {field.label}
              {field.required ? '' : ' (optional)'}
              {isSecret && alreadySet ? ' · already set' : ''}
            </label>
            <Input
              id={id}
              form={formId}
              name={`config.${field.name}`}
              type={isSecret ? 'password' : 'text'}
              // A secret is ABSENT, not masked: nothing to leak into page source.
              defaultValue={isSecret ? '' : (installation?.config[field.name] ?? '')}
              placeholder={
                isSecret && alreadySet ? 'leave blank to keep the stored value' : field.placeholder
              }
              // Required only on a NEW connection: on an edit, blank means unchanged.
              required={field.required && !installation}
              autoComplete="off"
              className="max-w-md"
            />
            {field.help ? <p className="text-xs text-muted-foreground">{field.help}</p> : null}
          </div>
        );
      })}
    </div>
  );
}

export default async function IntegrationsPage({
  searchParams,
}: {
  searchParams: Promise<{
    error?: string;
    connected?: string;
    disconnected?: string;
    tested?: string;
    detail?: string;
    /** VX3-8: set by the OAuth callback route, which has a sentence to deliver. */
    notice?: string;
  }>;
}) {
  const prefs = await readerPrefs();
  const { error, connected, disconnected, tested, detail, notice } = await searchParams;
  const { installations, available, keyConfigured, moduleEnabled } = await getIntegrationsPage();

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Accounting integrations</h1>
          <p className="text-sm text-muted-foreground">
            {installations.filter((i) => i.active).length === 0
              ? 'Nothing connected'
              : `${installations.filter((i) => i.active).length} connected`}
            {' · '}approved reports post to the connected ledger
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Link href="/admin/modules" className="text-sm underline underline-offset-4">
            Modules
          </Link>
          <Link href="/admin/chart-of-accounts" className="text-sm underline underline-offset-4">
            Chart of accounts
          </Link>
          <Link href="/admin/expense-policies" className="text-sm underline underline-offset-4">
            Expense policies
          </Link>
        </div>
      </header>

      {!moduleEnabled ? (
        // VX4-1. The reads on this screen are deliberately UNGATED so the page can
        // render, which means an off module looks exactly like an empty one unless
        // the page says otherwise. That is the AC-22 mistake, and this is the
        // sentence that avoids it.
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm">
          <strong className="font-medium">
            Accounting integrations are not enabled for this organization.
          </strong>{' '}
          Everything below is read-only and nothing here will post: approved reports
          are recorded and queued, and go when the module is back on. An
          administrator can turn it on under{' '}
          <Link href="/admin/modules" className="underline underline-offset-4">
            Modules
          </Link>
          .
        </div>
      ) : null}

      <ErrorBanner message={error} />
      {notice ? (
        <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm">{notice}</p>
      ) : null}
      {connected ? (
        <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm">
          Connected. Press <strong>Test</strong> to check it before relying on it.
        </p>
      ) : null}
      {disconnected ? (
        <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm">
          Disconnected, and the stored credentials were deleted.
        </p>
      ) : null}
      {tested ? (
        <p
          className={`rounded-md border px-3 py-2 text-sm ${
            tested === 'ok'
              ? 'border-border bg-muted/40'
              : 'border-destructive/40 bg-destructive/5'
          }`}
        >
          <strong className="font-medium">
            {tested === 'ok' ? 'The connection works.' : 'The test failed.'}
          </strong>{' '}
          {detail}
        </p>
      ) : null}

      {!keyConfigured ? (
        // Said before somebody types a credential, not after the save fails.
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm">
          <strong className="font-medium">
            SECRET_ENCRYPTION_KEY is not set in this environment.
          </strong>{' '}
          Credentials cannot be encrypted, so connecting will fail. Generate a key with{' '}
          <code>openssl rand -base64 32</code> and set it before continuing.
        </div>
      ) : null}

      {/* ── What is connected ────────────────────────────────────────────────── */}
      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-medium">Connections</h2>
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full min-w-[820px] text-left text-sm">
            <thead className="bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">Integration</th>
                <th className="px-3 py-2 font-medium">Can do</th>
                <th className="px-3 py-2 font-medium">Connected</th>
                <th className="px-3 py-2 font-medium">Last test</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {installations.length === 0 ? (
                <EmptyRow colSpan={5}>
                  No ledger is connected. Approved reports are recorded here and posted nowhere.
                </EmptyRow>
              ) : (
                installations.map((i) => (
                  <tr key={i.id} className="border-t border-border align-top">
                    <td className="px-3 py-2">
                      <p className="font-medium">{i.label}</p>
                      <p className="text-xs text-muted-foreground">
                        {i.adapter?.name ?? (
                          // The unknown-adapter case, said plainly rather than
                          // rendered as a blank row.
                          <span className="text-destructive">
                            {i.integration_slug} — this build does not have that integration
                          </span>
                        )}
                        {' · '}
                        {i.code}
                        {i.active ? '' : ' · disconnected'}
                      </p>
                    </td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">
                      {/* Was `.toLowerCase().replace(/_/g, ' ')` — string surgery
                          standing in for copy, which turns POST_EXPENSE_REPORT
                          into "post expense report" and cannot ever say
                          "Pull the chart of accounts". */}
                      {(i.adapter?.capabilities ?? [])
                        .map((c) => enumLabel(CAPABILITY_COPY, c, prefs.locale))
                        .join(', ') || '—'}
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">
                      {i.connected_at ? (
                        <>
                          {formatInstant(i.connected_at, prefs)}
                          {i.connected_by_name ? (
                            <span className="block text-xs">by {i.connected_by_name}</span>
                          ) : null}
                        </>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="px-3 py-2">
                      {i.last_test_at === null ? (
                        <span className="text-muted-foreground">never tested</span>
                      ) : (
                        <>
                          <span className={i.last_test_ok ? '' : 'text-destructive'}>
                            {i.last_test_ok ? 'worked' : 'failed'}
                          </span>
                          <span className="block text-xs text-muted-foreground">
                            {formatInstant(i.last_test_at, prefs)}
                          </span>
                          {i.last_test_error ? (
                            <span className="block text-xs text-destructive">
                              {i.last_test_error}
                            </span>
                          ) : null}
                        </>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex flex-wrap items-center gap-2">
                        {/* VX3-8. An OAUTH2 connection is authorised at the far
                            end, so its primary action is a redirect rather than a
                            form save. The wording changes with the state because
                            "Connect" and "Authorise again" mean different things to
                            somebody looking at a connection that stopped working. */}
                        {i.adapter && i.auth_kind === 'OAUTH2' ? (
                          <Button form={`auth-${i.id}`} type="submit" size="sm">
                            {i.oauth_needs_consent
                              ? 'Authorise again'
                              : i.oauth_authorised_at
                                ? 'Re-authorise'
                                : 'Connect'}
                          </Button>
                        ) : null}
                        {i.adapter ? (
                          <Button form={`test-${i.id}`} type="submit" size="sm" variant="outline">
                            Test
                          </Button>
                        ) : null}
                        {i.active ? (
                          <Button form={`disc-${i.id}`} type="submit" size="sm" variant="outline">
                            Disconnect
                          </Button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {installations.map((i) => (
          <div key={i.id} className="hidden">
            <form id={`test-${i.id}`} action={testFromForm}>
              <input type="hidden" name="id" value={i.id} />
            </form>
            <form id={`disc-${i.id}`} action={disconnectFromForm}>
              <input type="hidden" name="id" value={i.id} />
            </form>
            <form id={`auth-${i.id}`} action={authoriseFromForm}>
              <input type="hidden" name="id" value={i.id} />
            </form>
          </div>
        ))}
      </section>

      {/* ── Editing an active connection ─────────────────────────────────────── */}
      {installations
        .filter((i) => i.active && i.adapter)
        .map((i) => (
          <section key={i.id} className="flex flex-col gap-3 rounded-lg border border-border p-4">
            <h2 className="text-lg font-medium">{i.label} settings</h2>
            <form action={updateFromForm} className="flex flex-col gap-3">
              <input type="hidden" name="id" value={i.id} />
              <div className="flex flex-col gap-1">
                <label className="text-xs text-muted-foreground" htmlFor={`label-${i.id}`}>
                  Name
                </label>
                <Input
                  id={`label-${i.id}`}
                  name="label"
                  defaultValue={i.label}
                  className="max-w-md"
                />
              </div>
              <ConfigFields fields={i.adapter!.configFields} installation={i} />
              <div>
                <Button type="submit" size="sm">
                  Save settings
                </Button>
              </div>
            </form>
          </section>
        ))}

      {/* ── Connecting something new ─────────────────────────────────────────── */}
      {available.length === 0 ? (
        installations.length > 0 ? null : (
          <p className="rounded-lg border border-border p-4 text-sm text-muted-foreground">
            No accounting integrations are available in this build.
          </p>
        )
      ) : (
        <section className="flex flex-col gap-4">
          <h2 className="text-lg font-medium">Connect a ledger</h2>
          {available.map((a) => (
            <form
              key={a.slug}
              action={connectFromForm}
              className="flex flex-col gap-3 rounded-lg border border-border p-4"
            >
              <input type="hidden" name="slug" value={a.slug} />
              <div>
                <p className="font-medium">{a.name}</p>
                <p className="text-sm text-muted-foreground">{a.description}</p>
              </div>
              {a.setupSteps && a.setupSteps.length > 0 ? (
                <div className="rounded-md border border-border bg-muted/30 p-3 text-sm">
                  <p className="font-medium">First, in {a.name}:</p>
                  <ol className="mt-1 list-decimal pl-5 text-muted-foreground">
                    {a.setupSteps.map((step) => (
                      <li key={step}>{step}</li>
                    ))}
                  </ol>
                </div>
              ) : null}
              <div className="flex flex-col gap-1">
                <label className="text-xs text-muted-foreground" htmlFor={`label-new-${a.slug}`}>
                  Name this connection
                </label>
                <Input
                  id={`label-new-${a.slug}`}
                  name="label"
                  defaultValue={a.name}
                  className="max-w-md"
                />
              </div>
              <ConfigFields fields={a.configFields} />
              <div>
                <Button type="submit" size="sm">
                  Connect {a.name}
                </Button>
              </div>
            </form>
          ))}
        </section>
      )}
    </div>
  );
}
