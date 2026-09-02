/**
 * VX2-7 — /admin/notification-templates. What the tenant's messages say.
 *
 * Server component posting plain `<form action={serverAction}>`, no client JS.
 * Each message is its own small form, so a save touches one message and a
 * half-finished edit somewhere else on the page cannot ride along with it.
 *
 * ── What an admin needs to understand from this page ────────────────────────
 *
 * AN EMPTY BOX IS NOT A BLANK MESSAGE — it is the shipped wording. That is the
 * normal state of this screen and it is why the table starts empty rather than
 * pre-filled: a fresh tenant has zero rows, and every message below still
 * renders. The same shape /admin/expense-policies uses for its starter rules,
 * and for the same reason — shipped copy lives in code, so there is no second
 * copy to drift (GAP-AUDIT NT-4, and the decision recorded 2026-08-29).
 *
 * Clearing a box is therefore a RESET, not a way to silence a message. There is
 * deliberately no way to silence one from here: whether somebody hears about an
 * event is their own preference, not an admin's editorial decision.
 */
import { Fragment } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { ErrorBanner, textareaClass } from '@/app/expenses/ui';
import { formatInstant } from '@/lib/i18n/format';
import { readerPrefs } from '@/lib/i18n/request';
import { getTemplatesPage, setTemplateFromForm } from './actions';

export const dynamic = 'force-dynamic';

export default async function NotificationTemplatesPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const prefs = await readerPrefs();
  const { error } = await searchParams;
  const { templates, placeholders } = await getTemplatesPage();
  const overridden = templates.filter((t) => t.body !== null).length;

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Notification wording</h1>
          <p className="text-sm text-muted-foreground">
            {overridden === 0
              ? `All ${templates.length} messages use the shipped wording`
              : `${overridden} of ${templates.length} reworded`}{' '}
            · changes apply to the next notification sent, no deploy
          </p>
        </div>
        <div className="flex items-center gap-3">
          {/* No admin navigation exists yet — HANDOFF §7. */}
          <Link href="/admin/approval-ladder" className="text-sm underline underline-offset-4">
            Approval ladder
          </Link>
          <Link href="/notifications" className="text-sm underline underline-offset-4">
            Notifications
          </Link>
        </div>
      </header>

      <ErrorBanner message={error} />

      <div className="rounded-lg border border-border bg-muted/30 p-4 text-sm">
        <p className="font-medium">An empty box is the shipped wording, not a blank message.</p>
        <p className="mt-1 text-muted-foreground">
          Every message below works with nothing typed into it — the wording is in the product.
          Write something to override it for this organization; clear the box to go back. You cannot
          turn a message off here: whether somebody hears about an event is their own preference.
        </p>
        <p className="mt-2 text-muted-foreground">
          Available placeholders:{' '}
          {placeholders.map((p, i) => (
            <Fragment key={p}>
              {i > 0 ? ', ' : ''}
              <code className="rounded bg-muted px-1">{`{${p}}`}</code>
            </Fragment>
          ))}
          . Anything else you write in braces stays on screen exactly as typed — so a misspelled
          placeholder is visible rather than an empty gap.
        </p>
      </div>

      <div className="flex flex-col gap-4">
        {templates.map((t) => (
          <section key={t.templateKey} className="rounded-lg border border-border p-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="font-medium">{t.name}</h2>
              <span className="text-xs text-muted-foreground">
                {t.body === null ? 'shipped wording' : 'reworded'}
                {t.updatedAt
                  ? ` · ${t.updatedByName ?? 'somebody'} on ${formatInstant(t.updatedAt, prefs)}`
                  : ''}
              </span>
            </div>
            <p className="mt-0.5 text-sm text-muted-foreground">{t.description}</p>
            <p className="mt-2 text-xs text-muted-foreground">
              Shipped: <span className="italic">{t.shipped}</span>
            </p>
            <form action={setTemplateFromForm} className="mt-2 flex flex-col gap-2">
              <input type="hidden" name="templateKey" value={t.templateKey} />
              <textarea
                name="body"
                className={textareaClass}
                defaultValue={t.body ?? ''}
                placeholder={t.shipped}
                aria-label={`Wording for ${t.name}`}
              />
              <div className="flex items-center gap-2">
                <Button type="submit" size="sm">
                  Save
                </Button>
                <span className="text-xs text-muted-foreground">
                  {t.body === null
                    ? 'Nothing typed — this message uses the shipped wording.'
                    : 'Clear the box and save to go back to the shipped wording.'}
                </span>
              </div>
            </form>
          </section>
        ))}
      </div>
    </div>
  );
}
