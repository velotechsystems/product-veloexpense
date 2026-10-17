/**
 * w5-02a — /admin/slack. Connect this organization's own Slack app, test it, disconnect it.
 *
 * VeloExpense-built page (decided 17 Oct 2026: its own page, because /admin/integrations is
 * the accounting ledger's). The layout follows /admin/integrations; the CONTENT is ExpenseOS's
 * Slack integration entry (`apps/web/src/server/platform/catalog.ts`, `slug: 'slack'`,
 * 1e682dd6): its description, its setup steps, its two secret fields and their help text,
 * and its "Test connection".
 *
 * Server component posting plain `<form action={serverAction}>`, no client JS.
 *
 * A SECRET IS NEVER RENDERED. Not masked — absent. A stored secret shows an empty box and
 * the words "already set"; leaving it empty keeps what is stored (/admin/integrations' rule,
 * and ExpenseOS's: "a blank submit means unchanged").
 */
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ErrorBanner } from '@/app/expenses/ui';
import { formatInstant } from '@/lib/i18n/format';
import { readerPrefs } from '@/lib/i18n/request';
import { pageTitle } from '@/lib/i18n/page-title';
import { PageHeader, Screen } from '@/components/screen';
import {
  disconnectSlackFromForm,
  getSlackPage,
  saveSlackFromForm,
  testSlackFromForm,
} from './actions';

// UD-16. See `lib/i18n/page-title.ts` for why the title lives here rather than
// in a map of routes, and `scripts/check-page-titles.mjs` for what enforces it.
export function generateMetadata() {
  return pageTitle('title.admin.slack');
}

export const dynamic = 'force-dynamic';

/**
 * ExpenseOS's setup steps for its Slack entry, in English (VeloExpense: English only for now).
 *
 * VeloExpense: "an ExpenseOS person" reads "a VeloExpense person", and the Event Subscriptions
 * step is held back until replies in Slack arrive (w5-02b) — the events URL does not exist
 * yet, and Slack would refuse to verify it. The `im:history` scope stays in the list now, so
 * nobody has to reinstall the app (which changes the token) when replies arrive.
 */
const SETUP_STEPS = [
  'api.slack.com/apps → Create New App → From scratch, and pick your workspace.',
  'OAuth & Permissions → Bot Token Scopes: add chat:write, users:read, users:read.email and im:history. The email scope is what matches a Slack user to a VeloExpense person — without it nobody can be reached; im:history is what lets the app receive the message.im events that turn a reply into a comment.',
  'Install to Workspace, then copy the Bot User OAuth Token (xoxb-…) into the field below.',
  'Basic Information → App Credentials: copy the Signing Secret. It is REQUIRED for events — inbound replies are rejected without it, since every request Slack sends is signature-verified.',
  'Reinstall to the workspace after any scope change — the Bot User OAuth Token changes, and the old one starts failing with missing_scope.',
  'Each person still opts in from their own notification preferences — connecting Slack does not start messaging anyone.',
];

export default async function SlackPage({
  searchParams,
}: {
  searchParams: Promise<{
    error?: string;
    connected?: string;
    saved?: string;
    disconnected?: string;
    tested?: string;
    detail?: string;
  }>;
}) {
  const prefs = await readerPrefs();
  const { error, connected, saved, disconnected, tested, detail } = await searchParams;
  const { connection, keyConfigured } = await getSlackPage();

  return (
    <Screen>
      <PageHeader
        title="Slack"
        description={
          connection.connected
            ? 'Connected · notifications can reach people in Slack'
            : 'Not connected · deliver notifications to people in Slack through your own Slack app'
        }
      />

      <ErrorBanner message={error} />
      {connected ? (
        <p className="rounded-lg border border-border bg-muted/50 px-3 py-2 text-sm">
          Connected. Press <strong>Test connection</strong> to check it before relying on it.
        </p>
      ) : null}
      {saved ? (
        <p className="rounded-lg border border-border bg-muted/50 px-3 py-2 text-sm">Saved.</p>
      ) : null}
      {disconnected ? (
        <p className="rounded-lg border border-border bg-muted/50 px-3 py-2 text-sm">
          Disconnected, and the stored token and signing secret were deleted.
        </p>
      ) : null}
      {tested ? (
        <p
          className={`rounded-md border px-3 py-2 text-sm ${
            tested === 'ok' ? 'border-border bg-muted/40' : 'border-destructive/40 bg-destructive/5'
          }`}
        >
          <strong className="font-medium">
            {tested === 'ok' ? 'The connection works.' : 'The test failed.'}
          </strong>{' '}
          {detail}
        </p>
      ) : null}

      {!keyConfigured ? (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm">
          <strong className="font-medium">SECRET_ENCRYPTION_KEY is not set in this environment.</strong>{' '}
          The token cannot be encrypted, so connecting will fail. Generate a key with{' '}
          <code>openssl rand -base64 32</code> and set it before continuing.
        </div>
      ) : null}

      {connection.connected ? (
        <section className="flex flex-col gap-3 rounded-lg border border-border p-4">
          <h2 className="text-lg leading-7 font-semibold">Connection</h2>
          <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-1 text-sm">
            <dt className="text-muted-foreground">Connected</dt>
            <dd>
              {connection.connectedAt ? formatInstant(connection.connectedAt, prefs) : '—'}
              {connection.connectedByName ? ` by ${connection.connectedByName}` : ''}
            </dd>
            <dt className="text-muted-foreground">Signing secret</dt>
            <dd>
              {connection.signingSecretSet ? (
                'set'
              ) : (
                <span className="text-destructive">
                  not set — replies in Slack will be refused without it
                </span>
              )}
            </dd>
            <dt className="text-muted-foreground">Last test</dt>
            <dd>
              {connection.lastTestAt === null ? (
                <span className="text-muted-foreground">never tested</span>
              ) : (
                <>
                  <span className={connection.lastTestOk ? '' : 'text-destructive'}>
                    {connection.lastTestOk ? 'worked' : 'failed'}
                  </span>
                  <span className="text-muted-foreground">
                    {' · '}
                    {formatInstant(connection.lastTestAt, prefs)}
                  </span>
                  {connection.lastTestError ? (
                    <span className="block text-xs text-destructive">{connection.lastTestError}</span>
                  ) : null}
                </>
              )}
            </dd>
          </dl>
          <div className="flex flex-wrap items-center gap-2">
            <form action={testSlackFromForm}>
              <Button type="submit" size="sm" variant="outline">
                Test connection
              </Button>
            </form>
            <form action={disconnectSlackFromForm}>
              {/* Says what it destroys, as /admin/integrations' Disconnect does. */}
              <Button type="submit" size="sm" variant="outline">
                Disconnect and delete the token
              </Button>
            </form>
          </div>
          <p className="text-xs text-muted-foreground">
            The test runs Slack&apos;s auth.test with the stored token. It does not check scopes —
            auth.test passes with none.
          </p>
        </section>
      ) : null}

      <section className="flex flex-col gap-3 rounded-lg border border-border p-4">
        <div>
          <h2 className="text-lg leading-7 font-semibold">
            {connection.connected ? 'Change the token or signing secret' : 'Connect Slack'}
          </h2>
          <p className="text-sm text-muted-foreground">
            Deliver notifications to people in Slack through your organization&apos;s own Slack
            app. Recipients are matched by email; each opts in from their notification
            preferences.
          </p>
        </div>
        {!connection.connected ? (
          <div className="rounded-lg border border-border bg-muted/50 p-3 text-sm">
            <p className="font-medium">First, in Slack:</p>
            <ol className="mt-1 list-decimal pl-5 text-muted-foreground">
              {SETUP_STEPS.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
          </div>
        ) : null}
        <form action={saveSlackFromForm} className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <label className="text-xs text-muted-foreground" htmlFor="slack-bot-token">
              Bot User OAuth Token
              {connection.connected ? ' · already set' : ''}
            </label>
            <Input
              id="slack-bot-token"
              name="botToken"
              type="password"
              defaultValue=""
              placeholder={
                connection.connected ? 'leave blank to keep the stored value' : 'xoxb-…'
              }
              required={!connection.connected}
              autoComplete="off"
              className="max-w-md"
            />
            <p className="text-xs text-muted-foreground">
              Slack bot token (xoxb-…) with chat:write + users:read.email scopes.
            </p>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-muted-foreground" htmlFor="slack-signing-secret">
              Signing Secret (optional)
              {connection.signingSecretSet ? ' · already set' : ''}
            </label>
            <Input
              id="slack-signing-secret"
              name="signingSecret"
              type="password"
              defaultValue=""
              placeholder={connection.signingSecretSet ? 'leave blank to keep the stored value' : ''}
              autoComplete="off"
              className="max-w-md"
            />
            <p className="text-xs text-muted-foreground">
              REQUIRED, despite being optional to save: Slack signature-verifies every request it
              sends, so without this inbound replies are rejected. It stays optional only so a
              connection can be saved before the app is finished in Slack.
            </p>
          </div>
          <div>
            <Button type="submit" size="sm">
              {connection.connected ? 'Save' : 'Connect Slack'}
            </Button>
          </div>
        </form>
      </section>
    </Screen>
  );
}
