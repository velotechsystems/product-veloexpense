/**
 * VX1-8 — the submit / recall bar and the transition trail.
 *
 * Server component, plain forms. The button is rendered live whenever the
 * report is a DRAFT with line items; if a blocking violation exists the submit
 * is still offered and the SERVER refuses it, explaining why in the error
 * banner. That is deliberate — a disabled button with no explanation is the
 * worst version of this interaction, and the authoritative check has to happen
 * server-side anyway (the policy engine re-runs inside the submit transaction).
 */
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { ReportEvent } from '@/lib/expenses/lifecycle';
import type { ReportStatus } from '@/lib/expenses/service';
import { recallReportFromForm, submitReportFromForm } from '../actions';
import { StatusBadge, cardClass } from '../ui';
import { formatInstant } from '@/lib/i18n/format';
import {
  enumLabel,
  REPORT_STATUS_COPY,
  TRANSITION_ACTION_COPY,
} from '@/lib/i18n/catalog/enums';
import type { ReaderPrefs } from '@/lib/i18n/resolve';

export function LifecycleBar({
  reportId,
  status,
  locale,
  readiness,
}: {
  reportId: string;
  status: ReportStatus;
  /** Sync component; the page resolves the reader once. */
  locale: string;
  readiness: { canSubmit: boolean; canRecall: boolean; reasons: string[] };
}) {
  return (
    <section className={`${cardClass} flex flex-wrap items-center justify-between gap-3 p-5`}>
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">Status</span>
          <span data-testid="report-status">
            <StatusBadge status={status} locale={locale} />
          </span>
        </div>
        {readiness.reasons.length > 0 ? (
          <p className="text-xs text-muted-foreground">
            Not ready to submit: {readiness.reasons.join('; ')}.
          </p>
        ) : null}
      </div>

      <div className="flex items-center gap-2">
        {status === 'DRAFT' ? (
          <form action={submitReportFromForm}>
            <input type="hidden" name="reportId" value={reportId} />
            <Button type="submit">Submit for approval</Button>
          </form>
        ) : null}

        {readiness.canRecall ? (
          <form action={recallReportFromForm} className="flex items-center gap-2">
            <input type="hidden" name="reportId" value={reportId} />
            <Input name="note" className="max-w-64" placeholder="Reason (optional)" />
            <Button type="submit" variant="outline">
              Recall to draft
            </Button>
          </form>
        ) : null}
      </div>
    </section>
  );
}

export function ReportHistory({
  events,
  prefs,
}: {
  events: ReportEvent[];
  /** Sync, like LifecycleBar — the page resolves once and threads down. */
  prefs: ReaderPrefs;
}) {
  if (events.length === 0) return null;
  return (
    <section className={`${cardClass} flex flex-col gap-3 p-5`}>
      <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        History
      </h2>
      <ul className="flex flex-col gap-2 text-sm">
        {events.map((event) => (
          <li key={event.id} className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <span className="font-medium">
              {enumLabel(TRANSITION_ACTION_COPY, event.action, prefs.locale)}
            </span>
            <span className="text-muted-foreground">
              {enumLabel(REPORT_STATUS_COPY, event.from_status, prefs.locale)} →{' '}
              {enumLabel(REPORT_STATUS_COPY, event.to_status, prefs.locale)}
            </span>
            <span className="text-muted-foreground">
              by {event.actor_name ?? event.actor_email} on {formatInstant(event.created_at, prefs)}
            </span>
            {event.note ? <span className="text-muted-foreground">— {event.note}</span> : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
