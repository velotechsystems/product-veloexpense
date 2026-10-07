/**
 * VX1-7 — the inline policy panel (ExpenseOS Module 9's "warnings the front end
 * surfaces inline").
 *
 * A server component: the findings are already in the database, put there by
 * the validation that ran inside the same transaction as the last save. Nothing
 * here re-runs the rules — the "Re-check" button does, explicitly, for the case
 * where an admin changed a rule while a draft was open.
 *
 * BLOCK findings carry no acknowledge form on purpose. Module 9 is explicit
 * that blocking violations must be fixed rather than waved through, and the
 * service refuses the write regardless of what the UI offers.
 */
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { ValidationSummary } from '@/lib/policy/service';
import { renderViolation } from '@/lib/i18n/catalog/policy-messages';
import {
  acknowledgeViolationFromForm,
  clearAcknowledgementFromForm,
  revalidateFromForm,
} from '../actions';
import { SeverityBadge, cardClass } from '../ui';

export function PolicyPanel({
  reportId,
  summary,
  editable,
  locale,
}: {
  reportId: string;
  summary: ValidationSummary;
  editable: boolean;
  /** Sync component — the page resolves the reader once and threads it down. */
  locale: string;
}) {
  const { violations, counts, blocking } = summary;
  const open = violations.filter((v) => v.resolved_at === null);
  const acknowledged = violations.filter((v) => v.resolved_at !== null);

  return (
    <section className={`${cardClass} flex flex-col gap-4 p-5`}>
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <h2 className="velo-eyebrow">
            Policy
          </h2>
          {counts.BLOCK > 0 ? <SeverityBadge severity="BLOCK" locale={locale} /> : null}
          {counts.WARNING > 0 ? <SeverityBadge severity="WARNING" locale={locale} /> : null}
          {counts.INFO > 0 ? <SeverityBadge severity="INFO" locale={locale} /> : null}
        </div>
        {editable ? (
          <form action={revalidateFromForm}>
            <input type="hidden" name="reportId" value={reportId} />
            <Button type="submit" variant="ghost" size="sm">
              Re-check
            </Button>
          </form>
        ) : null}
      </header>

      {violations.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="policy-clean">
          No policy violations. Rules run on every save.
        </p>
      ) : null}

      {blocking ? (
        <p className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          Blocking violations have to be fixed before this report can be submitted.
        </p>
      ) : null}

      {open.length > 0 ? (
        <ul className="flex flex-col gap-3">
          {open.map((violation) => {
            // VX4-7 part 2b. NOT `violation.message`, which is the sentence
            // frozen in the default locale when whoever last saved the report
            // triggered validation. Rendered once per finding and reused below,
            // because the acknowledge field's aria-label has to say the same
            // words the paragraph does — a screen reader hearing a different
            // sentence than the page shows is the failure this had for free.
            const message = renderViolation(violation, locale);
            return (
              <li
                key={violation.id}
                data-testid="policy-violation"
                data-severity={violation.severity}
                className="flex flex-col gap-2 rounded-lg border border-border px-3 py-2"
              >
                <div className="flex items-start gap-2">
                  <SeverityBadge severity={violation.severity} locale={locale} />
                  <p className="text-sm">{message}</p>
                </div>
                {editable && violation.severity !== 'BLOCK' ? (
                  <form action={acknowledgeViolationFromForm} className="flex flex-wrap gap-2">
                    <input type="hidden" name="reportId" value={reportId} />
                    <input type="hidden" name="violationId" value={violation.id} />
                    <Input
                      name="note"
                      required
                      className="max-w-md flex-1"
                      placeholder="Why is this exception acceptable?"
                      aria-label={`Justification for: ${message}`}
                    />
                    <Button type="submit" variant="outline" size="sm">
                      Acknowledge
                    </Button>
                  </form>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}

      {acknowledged.length > 0 ? (
        <div className="flex flex-col gap-2">
          <h3 className="velo-eyebrow">
            Acknowledged
          </h3>
          <ul className="flex flex-col gap-2">
            {acknowledged.map((violation) => (
              <li
                key={violation.id}
                className="flex flex-wrap items-start justify-between gap-2 rounded-lg border border-dashed border-border px-3 py-2"
              >
                <div className="min-w-0">
                  <p className="text-sm text-muted-foreground line-through">
                    {renderViolation(violation, locale)}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {violation.resolve_note}
                    {violation.resolved_by_name ? ` — ${violation.resolved_by_name}` : ''}
                  </p>
                </div>
                {editable ? (
                  <form action={clearAcknowledgementFromForm}>
                    <input type="hidden" name="reportId" value={reportId} />
                    <input type="hidden" name="violationId" value={violation.id} />
                    <Button type="submit" variant="ghost" size="xs">
                      Clear
                    </Button>
                  </form>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
