'use server';
/**
 * w5-04 — /admin/directory-sync: connect the tenant's own Google Workspace, test it, sync it
 * now, disconnect it.
 *
 * VeloExpense-built, modelled on /admin/slack. ExpenseOS configures its one Workspace through
 * environment variables and has no screen; here each tenant's administrator pastes their own
 * service-account key and admin address (d84). The sync itself is ExpenseOS's
 * (`worker/src/handlers/directory-sync.ts`); "Sync now" queues it for this tenant, as
 * ExpenseOS's `trigger: 'manual'` does.
 *
 * Admin only, through the gate every admin surface uses. Every export here is an
 * `export async function` (`npm run check:actions`).
 *
 * A key must not reach a log, an error message, a redirect or the browser. `fail()` carries
 * the store's own sentence, which never contains a config value.
 */
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { enqueue } from '@expenseos/jobs';
import { verifyDirectoryAccess } from '@expenseos/integrations-google';
import { errorParam } from '@/lib/errors/domain';
import { asAdmin, asAdminPage } from '@/lib/auth/admin-guard';
import { ORG } from '@/lib/tenant/sql';
import {
  DirectoryConnectionError,
  directoryCredentials,
  disconnectDirectory,
  getDirectoryConnection,
  recordDirectoryTest,
  saveDirectoryConnection,
} from '@/lib/directory/googleConnection';

const PAGE = '/admin/directory-sync';

export async function getDirectorySyncPage() {
  return asAdminPage(async (tx) => ({
    connection: await getDirectoryConnection(tx),
    // Said before somebody pastes a key, not after the save fails — as /admin/slack.
    keyConfigured: Boolean(process.env.SECRET_ENCRYPTION_KEY),
    // The platform's switch (packages/integrations-google/src/client.ts).
    platformDisabled: process.env.GOOGLE_DIRECTORY_DISABLED === 'true',
  }));
}

function isRedirect(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'digest' in err &&
    typeof (err as { digest: unknown }).digest === 'string' &&
    (err as { digest: string }).digest.startsWith('NEXT_REDIRECT')
  );
}

/** Never carries a config value — see the header. */
function fail(err: unknown): never {
  if (err instanceof DirectoryConnectionError) {
    redirect(`${PAGE}?error=${encodeURIComponent(errorParam(err, 'admin/directory-sync'))}`);
  }
  throw err;
}

function text(form: FormData, key: string): string {
  const value = form.get(key);
  return typeof value === 'string' ? value : '';
}

export async function saveDirectoryFromForm(form: FormData) {
  let created = false;
  try {
    created = await asAdmin(async (tx, actor) => {
      const before = await getDirectoryConnection(tx);
      await saveDirectoryConnection(tx, actor.id, {
        serviceAccountJson: text(form, 'serviceAccountJson'),
        impersonateEmail: text(form, 'impersonateEmail'),
      });
      return !before.connected;
    });
  } catch (err) {
    if (isRedirect(err)) throw err;
    fail(err);
  }
  revalidatePath(PAGE);
  redirect(created ? `${PAGE}?connected=1` : `${PAGE}?saved=1`);
}

/**
 * "Test connection". Three steps, so the call to Google is made outside any transaction:
 * read the key, ask Google, record the answer — as /admin/slack's test.
 */
export async function testDirectoryFromForm() {
  let result: { ok: boolean; message: string } = { ok: false, message: '' };
  try {
    const stored = await asAdmin((tx) => directoryCredentials(tx));
    if (stored.state === 'not-connected') {
      throw new DirectoryConnectionError('there is no connection to test', 'DIRECTORY_NOT_CONNECTED');
    }
    result =
      stored.state === 'unreadable'
        ? { ok: false, message: stored.message }
        : await verifyDirectoryAccess(stored.credentials);
    await asAdmin((tx) => recordDirectoryTest(tx, result));
  } catch (err) {
    if (isRedirect(err)) throw err;
    fail(err);
  }
  revalidatePath(PAGE);
  redirect(
    `${PAGE}?tested=${result.ok ? 'ok' : 'failed'}&detail=${encodeURIComponent(result.message)}`,
  );
}

/** "Sync now": ExpenseOS's manual trigger, for this tenant. The worker does the work. */
export async function syncDirectoryNowFromForm() {
  let organizationId = '';
  try {
    organizationId = await asAdmin(async (tx) => {
      const view = await getDirectoryConnection(tx);
      if (!view.connected) {
        throw new DirectoryConnectionError('there is no connection to sync', 'DIRECTORY_NOT_CONNECTED');
      }
      const r = await tx.query(`SELECT id FROM organization WHERE id = ${ORG}`);
      return String(r.rows[0].id);
    });
  } catch (err) {
    if (isRedirect(err)) throw err;
    fail(err);
  }
  let queued = true;
  try {
    await enqueue('integration.google.directorySync', { trigger: 'manual', organizationId });
  } catch (err) {
    // The queue is down: say so, rather than a 500. The nightly run still happens.
    console.warn('[admin/directory-sync] could not queue a sync:', err);
    queued = false;
  }
  redirect(`${PAGE}?queued=${queued ? '1' : 'failed'}`);
}

export async function disconnectDirectoryFromForm() {
  try {
    await asAdmin((tx) => disconnectDirectory(tx));
  } catch (err) {
    if (isRedirect(err)) throw err;
    fail(err);
  }
  revalidatePath(PAGE);
  redirect(`${PAGE}?disconnected=1`);
}
