/**
 * w5-04 — /admin/directory-sync. Connect this organization's own Google Workspace, test it,
 * sync it, see what the last sync did, disconnect it.
 *
 * VeloExpense-built page, modelled on /admin/slack. ExpenseOS has no screen for its directory
 * sync — one Workspace, configured in the environment — so the CONTENT here is what its code
 * says: the read-only scope, the domain-wide delegation it needs, the daily run (02:30 UTC
 * since ExpenseOS 67db2e33, #582), and the run summary its audit row carries (scanned,
 * updated, linked, conflicts, errors, unmapped titles). Batch 4 (#582) changed what the sync
 * writes — Google's blank clears, department, business unit and legal entity are never
 * written — and the page says so.
 * VeloExpense's own rules are stated where they apply: the sync never creates a person, and
 * only ever moves somebody out (d84).
 *
 * Server component posting plain `<form action={serverAction}>`, no client JS.
 *
 * THE KEY IS NEVER RENDERED. Not masked — absent. A stored key shows an empty box and the
 * words "already set"; leaving it empty keeps what is stored.
 */
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ErrorBanner } from '@/app/expenses/ui';
import { formatInstant } from '@/lib/i18n/format';
import { readerPrefs } from '@/lib/i18n/request';
import { pageTitle } from '@/lib/i18n/page-title';
import { PageHeader, Screen } from '@/components/screen';
import type { DirectorySyncSummary } from '@/lib/directory/googleConnection';
import {
  disconnectDirectoryFromForm,
  getDirectorySyncPage,
  saveDirectoryFromForm,
  syncDirectoryNowFromForm,
  testDirectoryFromForm,
} from './actions';

// UD-16. See `lib/i18n/page-title.ts` for why the title lives here rather than
// in a map of routes, and `scripts/check-page-titles.mjs` for what enforces it.
export function generateMetadata() {
  return pageTitle('title.admin.directory.sync');
}

export const dynamic = 'force-dynamic';

/** The scope the sync asks for — ExpenseOS's, read-only. */
const SCOPE = 'https://www.googleapis.com/auth/admin.directory.user.readonly';

const SETUP_STEPS = [
  'In Google Cloud console, create (or pick) a project and enable the Admin SDK API.',
  'IAM & Admin → Service Accounts: create a service account, then Keys → Add key → Create new key → JSON. Google downloads a key file — that file is what you paste below.',
  'Copy the service account’s Client ID (Service account details → Advanced settings).',
  `In the Google Workspace Admin console: Security → Access and data control → API controls → Manage Domain Wide Delegation → Add new. Paste the Client ID, and the scope ${SCOPE}. That scope is read-only: the sync can read your directory and change nothing in it.`,
  'Below, paste the key file and the email of a Workspace administrator for the service account to act as.',
  'Press Test connection. Then Sync now, or wait for the nightly run.',
];

export default async function DirectorySyncPage({
  searchParams,
}: {
  searchParams: Promise<{
    error?: string;
    connected?: string;
    saved?: string;
    disconnected?: string;
    tested?: string;
    detail?: string;
    queued?: string;
  }>;
}) {
  const prefs = await readerPrefs();
  const { error, connected, saved, disconnected, tested, detail, queued } = await searchParams;
  const { connection, keyConfigured, platformDisabled } = await getDirectorySyncPage();

  return (
    <Screen>
      <PageHeader
        title="Directory sync"
        description={
          connection.connected
            ? 'Connected to Google Workspace · people are updated from your directory every night'
            : 'Not connected · keep names, managers, job levels and leavers up to date from Google Workspace'
        }
      />

      <ErrorBanner message={error} />
      {connected ? (
        <Notice>
          Connected. Press <strong>Test connection</strong> to check it before relying on it.
        </Notice>
      ) : null}
      {saved ? <Notice>Saved.</Notice> : null}
      {disconnected ? (
        <Notice>Disconnected, and the stored key was deleted. Nobody here was changed.</Notice>
      ) : null}
      {queued === '1' ? (
        <Notice>
          Sync queued. It runs in the background; reload this page in a minute to see what it did.
        </Notice>
      ) : null}
      {queued === 'failed' ? (
        <p className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm">
          The sync could not be queued just now. The nightly run will still happen.
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
          The key file cannot be encrypted, so connecting will fail. Generate a key with{' '}
          <code>openssl rand -base64 32</code> and set it before continuing.
        </div>
      ) : null}
      {platformDisabled ? (
        <div className="rounded-lg border border-border bg-muted/50 px-3 py-2 text-sm">
          Directory sync is switched off for this whole deployment (GOOGLE_DIRECTORY_DISABLED), so
          nothing will sync until it is switched back on.
        </div>
      ) : null}

      <section className="flex flex-col gap-2 rounded-lg border border-border p-4 text-sm">
        <h2 className="text-lg leading-7 font-semibold">What the sync changes</h2>
        <ul className="list-disc pl-5 text-muted-foreground">
          <li>
            For people already here — matched by their Google account, or by email the first
            time, which links them to it: name, photo, email address, country, manager, and job
            level from their title. Google Workspace is the source of truth for these: a value
            your directory leaves blank is cleared here too. A manager or title that matches
            nothing here changes nothing, and is listed below.
          </li>
          <li>
            Department, business unit and legal entity are yours: the sync never changes them.
            For somebody linked to Google, name, country and manager can only be changed in
            Google Workspace while the sync is connected.
          </li>
          <li>
            Somebody suspended, archived or deleted in Google Workspace is deactivated here, as if an
            administrator had done it: they can no longer sign in, they stop taking a seat, and
            their open reports move to their manager. The last active administrator is never
            deactivated this way.
          </li>
          <li>
            It never adds anybody — people join by invitation — and never reactivates anybody.
            People in your directory who are not here are counted, and left alone.
          </li>
        </ul>
      </section>

      {connection.connected ? (
        <section className="flex flex-col gap-3 rounded-lg border border-border p-4">
          <h2 className="text-lg leading-7 font-semibold">Connection</h2>
          <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-1 text-sm">
            <dt className="text-muted-foreground">Service account</dt>
            <dd className="break-all">{connection.clientEmail}</dd>
            <dt className="text-muted-foreground">Acting as</dt>
            <dd className="break-all">{connection.impersonateEmail}</dd>
            <dt className="text-muted-foreground">Connected</dt>
            <dd>
              {connection.connectedAt ? formatInstant(connection.connectedAt, prefs) : '—'}
              {connection.connectedByName ? ` by ${connection.connectedByName}` : ''}
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
            <form action={testDirectoryFromForm}>
              <Button type="submit" size="sm" variant="outline">
                Test connection
              </Button>
            </form>
            <form action={syncDirectoryNowFromForm}>
              <Button type="submit" size="sm" variant="outline">
                Sync now
              </Button>
            </form>
            <form action={disconnectDirectoryFromForm}>
              {/* Says what it destroys, as /admin/slack's Disconnect does. */}
              <Button type="submit" size="sm" variant="outline">
                Disconnect and delete the key
              </Button>
            </form>
          </div>
          <p className="text-xs text-muted-foreground">
            The test signs in as the service account, acting as the administrator above, and
            reads one person from the directory. It changes nothing here. The sync runs every
            night at 02:30 UTC.
          </p>
        </section>
      ) : null}

      {connection.connected ? (
        <LastSync at={connection.lastSyncAt} summary={connection.lastSync} prefs={prefs} />
      ) : null}

      <section className="flex flex-col gap-3 rounded-lg border border-border p-4">
        <div>
          <h2 className="text-lg leading-7 font-semibold">
            {connection.connected ? 'Change the key or administrator' : 'Connect Google Workspace'}
          </h2>
          <p className="text-sm text-muted-foreground">
            The sync reads your Google Workspace directory with your organization&apos;s own
            service account, and only ever reads it.
          </p>
        </div>
        {!connection.connected ? (
          <div className="rounded-lg border border-border bg-muted/50 p-3 text-sm">
            <p className="font-medium">First, in Google:</p>
            <ol className="mt-1 list-decimal pl-5 text-muted-foreground">
              {SETUP_STEPS.map((step) => (
                <li key={step} className="break-words">
                  {step}
                </li>
              ))}
            </ol>
          </div>
        ) : null}
        <form action={saveDirectoryFromForm} className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <label className="text-xs text-muted-foreground" htmlFor="directory-key">
              Service account key file (JSON)
              {connection.connected ? ' · already set' : ''}
            </label>
            <textarea
              id="directory-key"
              name="serviceAccountJson"
              defaultValue=""
              rows={5}
              spellCheck={false}
              autoComplete="off"
              placeholder={
                connection.connected
                  ? 'leave blank to keep the stored key'
                  : '{ "type": "service_account", … }'
              }
              required={!connection.connected}
              className="max-w-xl rounded-md border border-input bg-transparent px-3 py-2 font-mono text-xs"
            />
            <p className="text-xs text-muted-foreground">
              The whole file Google downloaded. It is encrypted as it is saved and never shown
              again.
            </p>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-muted-foreground" htmlFor="directory-admin">
              Workspace administrator to act as
            </label>
            <Input
              id="directory-admin"
              name="impersonateEmail"
              type="email"
              defaultValue={connection.impersonateEmail ?? ''}
              placeholder="admin@yourcompany.com"
              required
              autoComplete="off"
              className="max-w-md"
            />
            <p className="text-xs text-muted-foreground">
              Domain-wide delegation needs a real administrator to act as. The service account
              only gets what the scope above allows: reading the directory.
            </p>
          </div>
          <div>
            <Button type="submit" size="sm">
              {connection.connected ? 'Save' : 'Connect Google Workspace'}
            </Button>
          </div>
        </form>
      </section>
    </Screen>
  );
}

function Notice({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-lg border border-border bg-muted/50 px-3 py-2 text-sm">{children}</p>
  );
}

/** What the last run did — ExpenseOS's summary audit row, as the screen shows it. */
function LastSync({
  at,
  summary,
  prefs,
}: {
  at: Date | null;
  summary: DirectorySyncSummary | null;
  prefs: Awaited<ReturnType<typeof readerPrefs>>;
}) {
  return (
    <section className="flex flex-col gap-2 rounded-lg border border-border p-4 text-sm">
      <h2 className="text-lg leading-7 font-semibold">Last sync</h2>
      {at === null || summary === null ? (
        <p className="text-muted-foreground">No sync has run yet.</p>
      ) : (
        <>
          <p>
            <span className={summary.status === 'completed' ? '' : 'text-destructive'}>
              {summary.status === 'completed' ? 'Completed' : 'Failed'}
            </span>
            <span className="text-muted-foreground">
              {' · '}
              {formatInstant(at, prefs)}
              {summary.trigger === 'manual' ? ' · started by an administrator' : ''}
            </span>
          </p>
          {summary.message ? <p className="text-destructive">{summary.message}</p> : null}
          <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-1">
            <dt className="text-muted-foreground">In your directory</dt>
            <dd>{summary.scanned}</dd>
            <dt className="text-muted-foreground">Updated here</dt>
            <dd>{summary.updated}</dd>
            <dt className="text-muted-foreground">Deactivated</dt>
            <dd>{summary.offboarded}</dd>
            <dt className="text-muted-foreground">Not here, left alone</dt>
            <dd>{summary.notFound}</dd>
            {summary.linked !== undefined ? (
              <>
                <dt className="text-muted-foreground">Linked to their Google account</dt>
                <dd>{summary.linked}</dd>
              </>
            ) : null}
            {(summary.conflicts ?? 0) > 0 ? (
              <>
                <dt className="text-muted-foreground">Refused</dt>
                <dd className="text-destructive">
                  {summary.conflicts} — the address belongs to somebody linked to another Google
                  account that still exists
                </dd>
              </>
            ) : null}
            {summary.held > 0 ? (
              <>
                <dt className="text-muted-foreground">Not deactivated</dt>
                <dd className="text-destructive">
                  {summary.held} — suspended in Google Workspace, but the last active administrator
                  here
                </dd>
              </>
            ) : null}
            <dt className="text-muted-foreground">Errors</dt>
            <dd className={summary.errors > 0 ? 'text-destructive' : ''}>{summary.errors}</dd>
          </dl>
          {summary.unmappedTitles.length > 0 ? (
            <div>
              <p className="font-medium">Titles with no job level</p>
              <p className="text-xs text-muted-foreground">
                No rule recognized these titles, so these people kept whatever job level they had.
                Job level decides who approves tiered spend, so they are worth a look.
              </p>
              <ul className="mt-1 list-disc pl-5">
                {summary.unmappedTitles.map((t) => (
                  <li key={t.title}>
                    {t.title} <span className="text-muted-foreground">· {t.count}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {(summary.missingJobLevels ?? []).length > 0 ? (
            <div>
              <p className="font-medium">Job levels this organization does not have</p>
              <p className="text-xs text-muted-foreground">
                These people&apos;s titles map to a job level code with no level here, so they
                kept whatever level they had. Add a level with that code under Job levels to place
                them.
              </p>
              <ul className="mt-1 list-disc pl-5">
                {(summary.missingJobLevels ?? []).map((l) => (
                  <li key={l.code}>
                    {l.code} <span className="text-muted-foreground">· {l.count}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
