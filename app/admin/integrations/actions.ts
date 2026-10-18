'use server';
/**
 * VX3-3 — the integrations admin surface: connect a ledger, test it, disconnect.
 *
 * ADMIN only, role read from `app_user` inside the tenant transaction, same gate
 * as every other /admin surface. Standing in for per-tenant RBAC — and note this
 * screen is a stronger argument for that ticket than the others, because it is
 * where a tenant's accounting credentials are entered.
 *
 * Every export here is an `export async function`, and that is a rule — see the
 * comment in `app/admin/chart-of-accounts/actions.ts` and `npm run check:actions`.
 *
 * ── The one thing this file must never do ────────────────────────────────────
 *
 * A credential must not reach a log, an error message, or the browser. The
 * service redacts on the way out; this file must not undo that by echoing a form
 * value back into a redirect. `fail()` below carries the service's message, which
 * is written to be safe to show; it never carries a config value.
 */
import { redirect } from 'next/navigation';
import { errorParam } from '@/lib/errors/domain';
import { revalidatePath } from 'next/cache';
import {
  IntegrationError,
  availableAdapters,
  disconnect,
  getInstallation,
  installIntegration,
  listInstallations,
  testInstallation,
  updateInstallation,
} from '@/lib/integrations/service';
import { beginAuthorisation } from '@/lib/integrations/oauth';
import { appOrigin } from '@/lib/notifications/email';
import { isModuleEnabled } from '@/lib/modules/service';
import { asAdmin, asAdminPage } from '@/lib/auth/admin-guard';
import { auditActorOf } from '@/lib/audit/service';
import { auditConnection } from '@/lib/audit/connections';

const PAGE = '/admin/integrations';

export async function getIntegrationsPage() {
  return asAdminPage(async (tx) => ({
    installations: await listInstallations(tx),
    available: await availableAdapters(tx),
    // VX4-1. The screen has to be able to say "this module is off" — the reads
    // above are ungated precisely so it can, and a page that renders an empty
    // list without explaining why is the AC-22 mistake.
    moduleEnabled: await isModuleEnabled(tx, 'accounting'),
    // Whether the envelope can work at all. A screen that lets somebody type a
    // credential into a build with no key would fail on save with a stack trace;
    // saying so first is cheaper than explaining it afterwards.
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
  if (err instanceof IntegrationError) {
    redirect(`${PAGE}?error=${encodeURIComponent(errorParam(err, 'admin/integrations'))}`);
  }
  throw err;
}

function text(form: FormData, key: string): string {
  const value = form.get(key);
  return typeof value === 'string' ? value : '';
}

function required(form: FormData, key: string): string {
  const value = text(form, key).trim();
  if (!value) throw new IntegrationError(`${key} is required`, 'MISSING_FIELD');
  return value;
}

/** Pull `config.<name>` fields off the form for one adapter. */
function configFrom(form: FormData): Record<string, string> {
  const config: Record<string, string> = {};
  for (const [key, value] of form.entries()) {
    if (key.startsWith('config.') && typeof value === 'string') {
      config[key.slice('config.'.length)] = value;
    }
  }
  return config;
}

/**
 * VX3-8 — begin an OAUTH2 authorisation, and hand the browser to the far end.
 *
 * Two things worth noting.
 *
 * The REDIRECT URI is built from the request's own origin via `appOrigin()`,
 * because it has to match byte-for-byte at three points — the authorize URL, the
 * token exchange, and whatever is registered with the vendor. NT-14's rule applies:
 * read at call time, never at module load, so one deployment's origin cannot be
 * baked into another's build.
 *
 * And the `redirect()` at the end is to ANOTHER SITE. That is the one place in this
 * product where a server action sends somebody off the domain, so the URL comes
 * from the adapter's own `authorizeUrl` and nothing in the form.
 */
export async function authoriseFromForm(form: FormData) {
  let target: string;
  try {
    const id = required(form, 'id');
    const origin = appOrigin();
    if (!origin) {
      fail(
        new Error(
          'This deployment has no APP_URL, so there is no address for the accounting ' +
            'system to send you back to. Set APP_URL and try again.',
        ),
      );
      return;
    }
    const { authorizeUrl } = await asAdmin(async (tx, actor) => {
      const installation = await getInstallation(tx, id);
      if (!installation) throw new Error('no such connection');
      return beginAuthorisation(tx, {
        installationId: id,
        actorId: actor.id,
        redirectUri: `${origin}/api/integrations/${installation.integration_slug}/callback`,
      });
    });
    target = authorizeUrl;
  } catch (err) {
    if (isRedirect(err)) throw err;
    fail(err);
    return;
  }
  redirect(target);
}

export async function connectFromForm(form: FormData) {
  try {
    const slug = required(form, 'slug');
    await asAdmin(async (tx, actor) => {
      const installed = await installIntegration(
        tx,
        {
          slug,
          code: text(form, 'code').trim() || slug,
          label: text(form, 'label'),
          config: configFrom(form),
        },
        actor.id,
      );
      // f50: ExpenseOS's `admin.integration.install`, on the same transaction.
      await auditConnection(tx, auditActorOf(actor), 'installed', {
        slug: installed.integration_slug,
        code: installed.code,
        installationId: installed.id,
      });
    });
  } catch (err) {
    if (isRedirect(err)) throw err;
    fail(err);
  }
  revalidatePath(PAGE);
  redirect(`${PAGE}?connected=1`);
}

export async function updateFromForm(form: FormData) {
  try {
    await asAdmin(async (tx, actor) => {
      const id = required(form, 'id');
      const before = await getInstallation(tx, id);
      const label = text(form, 'label');
      const config = configFrom(form);
      const updated = await updateInstallation(tx, id, { label, config });
      // f50: ExpenseOS's `admin.integration.configUpdate` — naming the fields that changed,
      // never their values. A re-save that changed nothing records nothing.
      const changed = changedFields(before, label, config);
      if (changed.length > 0) {
        await auditConnection(tx, auditActorOf(actor), 'updated', {
          slug: updated.integration_slug,
          code: updated.code,
          installationId: updated.id,
          changed,
        });
      }
    });
  } catch (err) {
    if (isRedirect(err)) throw err;
    fail(err);
  }
  revalidatePath(PAGE);
  redirect(PAGE);
}

export async function testFromForm(form: FormData) {
  let ok = false;
  let detail = '';
  try {
    const result = await asAdmin((tx) => testInstallation(tx, required(form, 'id')));
    ok = result.ok;
    detail = result.detail;
  } catch (err) {
    if (isRedirect(err)) throw err;
    fail(err);
  }
  revalidatePath(PAGE);
  // The outcome goes in the query string rather than being read back off the row,
  // so the answer belongs to the button that was pressed. The row's
  // `last_test_*` is the durable record; this is the immediate reply.
  redirect(`${PAGE}?tested=${ok ? 'ok' : 'failed'}&detail=${encodeURIComponent(detail)}`);
}

export async function disconnectFromForm(form: FormData) {
  try {
    await asAdmin(async (tx, actor) => {
      const id = required(form, 'id');
      const before = await getInstallation(tx, id);
      await disconnect(tx, id);
      // f50: ExpenseOS's `admin.integration.remove`.
      if (before) {
        await auditConnection(tx, auditActorOf(actor), 'removed', {
          slug: before.integration_slug,
          code: before.code,
          installationId: before.id,
        });
      }
    });
  } catch (err) {
    if (isRedirect(err)) throw err;
    fail(err);
  }
  revalidatePath(PAGE);
  redirect(`${PAGE}?disconnected=1`);
}

/**
 * f50: which fields an update changed, by NAME. A secret field arrives blank unless somebody
 * typed a new one (blank keeps the stored value), so a non-blank secret is a change; any other
 * field is compared with what the screen showed.
 */
function changedFields(
  before: Awaited<ReturnType<typeof getInstallation>>,
  label: string,
  config: Record<string, string>,
): string[] {
  if (!before) return [];
  const changed: string[] = [];
  if (label.trim() !== '' && label.trim() !== before.label) changed.push('label');
  for (const field of before.adapter?.configFields ?? []) {
    const submitted = config[field.name];
    if (submitted === undefined) continue;
    if (field.type === 'secret') {
      if (submitted.trim() !== '') changed.push(field.name);
    } else if (submitted.trim() !== (before.config[field.name] ?? '').trim()) {
      changed.push(field.name);
    }
  }
  return changed;
}
