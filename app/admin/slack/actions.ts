'use server';
/**
 * w5-02a — /admin/slack: connect the tenant's own Slack app, test it, disconnect it.
 *
 * VeloExpense-built, modelled on /admin/integrations (decided 17 Oct 2026: its own page,
 * because /admin/integrations is the accounting ledger's). The behaviour is ExpenseOS's
 * Slack integration: two secret fields, a "Test connection" that runs `auth.test`, and
 * nothing messaged by connecting alone.
 *
 * Admin only, through the gate every admin surface uses. Every export here is an
 * `export async function` (`npm run check:actions`).
 *
 * A credential must not reach a log, an error message, a redirect or the browser. `fail()`
 * carries the store's own sentence, which never contains a config value.
 */
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { errorParam } from '@/lib/errors/domain';
import { asAdmin, asAdminPage } from '@/lib/auth/admin-guard';
import { verifySlackToken } from '@/lib/notifications/slack';
import {
  SlackConnectionError,
  disconnectSlack,
  getSlackConnection,
  recordSlackTest,
  saveSlackConnection,
  slackTokenForTest,
} from '@/lib/notifications/slackConnection';

const PAGE = '/admin/slack';

export async function getSlackPage() {
  return asAdminPage(async (tx) => ({
    connection: await getSlackConnection(tx),
    // Said before somebody pastes a token, not after the save fails — as /admin/integrations.
    keyConfigured: Boolean(process.env.SECRET_ENCRYPTION_KEY),
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
  if (err instanceof SlackConnectionError) {
    redirect(`${PAGE}?error=${encodeURIComponent(errorParam(err, 'admin/slack'))}`);
  }
  throw err;
}

function text(form: FormData, key: string): string {
  const value = form.get(key);
  return typeof value === 'string' ? value : '';
}

export async function saveSlackFromForm(form: FormData) {
  let created = false;
  try {
    created = await asAdmin(async (tx, actor) => {
      const before = await getSlackConnection(tx);
      await saveSlackConnection(tx, actor.id, {
        botToken: text(form, 'botToken'),
        signingSecret: text(form, 'signingSecret'),
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
 * ExpenseOS's "Test connection". Three steps, so the call to Slack is made outside any
 * transaction: read the token, ask Slack, record the answer.
 */
export async function testSlackFromForm() {
  let result: { ok: boolean; message: string } = { ok: false, message: '' };
  try {
    const stored = await asAdmin((tx) => slackTokenForTest(tx));
    result = stored.token === null ? stored.failed : await verifySlackToken(stored.token);
    await asAdmin((tx) => recordSlackTest(tx, result));
  } catch (err) {
    if (isRedirect(err)) throw err;
    fail(err);
  }
  revalidatePath(PAGE);
  // The answer belongs to the button that was pressed; the row's `last_test_*` is the
  // durable record.
  redirect(
    `${PAGE}?tested=${result.ok ? 'ok' : 'failed'}&detail=${encodeURIComponent(result.message)}`,
  );
}

export async function disconnectSlackFromForm() {
  try {
    await asAdmin((tx) => disconnectSlack(tx));
  } catch (err) {
    if (isRedirect(err)) throw err;
    fail(err);
  }
  revalidatePath(PAGE);
  redirect(`${PAGE}?disconnected=1`);
}
