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
import { auditActorOf } from '@/lib/audit/service';
import { auditConnection } from '@/lib/audit/connections';
import { verifySlackToken } from '@/lib/notifications/slack';
import { originForTenant } from '@/lib/notifications/email';
import { candidateSlugFromHost } from '@/lib/tenant/host';
import { ORG } from '@/lib/tenant/sql';
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
    events: await eventsUrl(tx),
  }));
}

/**
 * w5-02b — the Events Request URL to paste into Slack: this tenant's own address, which is how
 * `/api/slack/events` knows whose app is calling (`server/lib/slackTenant.ts`). ExpenseOS's
 * catalog lists it as the entry's `callbackUrls` and renders it against the browser's origin.
 *
 * `reachable` is false when the address is not a tenant address at all — a deployment with no
 * tenant subdomains (`AUTH_COOKIE_DOMAIN` unset) — because the route would answer it 404.
 */
async function eventsUrl(
  tx: Parameters<Parameters<typeof asAdminPage>[0]>[0],
): Promise<{ url: string | null; reachable: boolean }> {
  const r = await tx.query(`SELECT slug FROM organization WHERE id = ${ORG}`);
  const slug = (r.rows[0]?.slug as string | undefined) ?? '';
  const origin = slug ? originForTenant(slug) : null;
  if (!origin) return { url: null, reachable: false };
  return {
    url: `${origin}/api/slack/events`,
    reachable: candidateSlugFromHost(new URL(origin).host) === slug,
  };
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
      const input = { botToken: text(form, 'botToken'), signingSecret: text(form, 'signingSecret') };
      await saveSlackConnection(tx, actor.id, input);
      // f50: ExpenseOS's install / configUpdate rows — which secret changed, never its value.
      // A save with both fields blank changes nothing and records nothing.
      const changed = (['botToken', 'signingSecret'] as const).filter((k) => input[k].trim() !== '');
      if (!before.connected) {
        await auditConnection(tx, auditActorOf(actor), 'installed', { slug: 'slack' });
      } else if (changed.length > 0) {
        await auditConnection(tx, auditActorOf(actor), 'updated', { slug: 'slack', changed: [...changed] });
      }
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
    await asAdmin(async (tx, actor) => {
      const before = await getSlackConnection(tx);
      await disconnectSlack(tx);
      // f50: ExpenseOS's `admin.integration.remove`.
      if (before.connected) await auditConnection(tx, auditActorOf(actor), 'removed', { slug: 'slack' });
    });
  } catch (err) {
    if (isRedirect(err)) throw err;
    fail(err);
  }
  revalidatePath(PAGE);
  redirect(`${PAGE}?disconnected=1`);
}
