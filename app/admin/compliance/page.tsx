/**
 * VX4-8 part 4 — /admin/compliance. The queue, the runs, and the thresholds.
 *
 * Server component posting plain `<form action={serverAction}>`, no client JS.
 * Row forms live after each table because a `<form>` may not be a child of a
 * `<tr>`.
 *
 * ── WHAT THIS SCREEN IS CAREFUL TO SAY ──────────────────────────────────────
 *
 * NOTHING HERE ACCUSES ANYBODY. Every heading, and the empty state, says a flag
 * is a thing to look at rather than a finding of wrongdoing. That is the module's
 * first design constraint and the copy is where a person actually meets it —
 * "automated fraud accusations are how you get a wrongful-accusation problem
 * instead of a fraud problem."
 *
 * A DISMISSAL WANTS A REASON, and the field says why rather than just being
 * marked required: it is the one verdict somebody may be asked about later.
 *
 * A RUN THAT DID NOT FINISH LOOKS DIFFERENT FROM A CLEAN ONE. Migration 0032
 * exists for that, so the run list shows the status and, where it failed, the
 * controls that threw — otherwise "no findings" and "never finished" read alike.
 *
 * THE MODULE BEING OFF IS AN ANSWER. AC-22: a gated read would make the off
 * state indistinguishable from an empty queue.
 */
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { EmptyRow, ErrorBanner } from '@/app/expenses/ui';
import { formatInstant } from '@/lib/i18n/format';
import { readerPrefs } from '@/lib/i18n/request';
import {
  CONTROL_RUN_STATUS_COPY,
  CONTROL_SEVERITY_COPY,
  FRAUD_FLAG_STATUS_COPY,
  FRAUD_SEVERITY_COPY,
  enumLabel,
} from '@/lib/i18n/catalog/enums';
import { renderFraudMessage } from '@/lib/i18n/catalog/fraud-messages';
import { renderControlMessage } from '@/lib/i18n/catalog/control-messages';
import { FRAUD_SEVERITIES } from '@/lib/fraud/rules';
import { pageTitle } from '@/lib/i18n/page-title';

// UD-16. See `lib/i18n/page-title.ts` for why the title lives here rather than
// in a map of routes, and `scripts/check-page-titles.mjs` for what enforces it.
export function generateMetadata() {
  return pageTitle('title.admin.compliance');
}

import {
  evaluateNowFromForm,
  getCompliancePage,
  raiseFlagFromForm,
  reviewFlagFromForm,
  saveThresholdsFromForm,
  scanNowFromForm,
} from './actions';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { TableCard } from '@/components/screen';
import { NativeSelect } from '@/components/ui/native-select';
import { PageHeader, Screen } from '@/components/screen';

export const dynamic = 'force-dynamic';

export default async function CompliancePage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; run?: string }>;
}) {
  const prefs = await readerPrefs();
  const { error, run } = await searchParams;
  const view = await getCompliancePage(run);

  if (!view.moduleEnabled) {
    return (
      <Screen width="wide">
        <PageHeader title="Compliance" />
        <p className="rounded-lg border border-border bg-muted/50 px-3 py-2 text-sm">
          <strong className="font-medium">The compliance module is off for this organization.</strong>{' '}
          Every report still goes through policy, approval and reimbursement; nothing is looked at
          again afterwards. Turn it on from{' '}
          <Link href="/admin/modules" className="underline underline-offset-4">
            Modules
          </Link>
          .
        </p>
      </Screen>
    );
  }

  const { flags, summary, runs, findings, selectedRunId, fraudConfig, controlConfig } = view;
  const selectedRun = runs.find((r) => r.id === selectedRunId) ?? null;

  return (
    <Screen width="wide">
      <PageHeader
        title="Compliance"
        description={
          summary.active === 0
            ? 'Nothing open'
            : `${summary.active} open · ${summary.critical} worth opening · ${summary.reviewed} decided`
        }
        actions={
          <>
            <form action={scanNowFromForm}>
              <Button type="submit" variant="outline">
                Look for problems now
              </Button>
            </form>
            <form action={evaluateNowFromForm}>
              <Button type="submit" variant="outline">
                Evaluate the controls now
              </Button>
            </form>
          </>
        }
      />

      <p className="rounded-lg border border-border bg-muted/50 px-3 py-2 text-sm text-muted-foreground">
        <strong className="font-medium text-foreground">Nothing here is an accusation.</strong> These
        are patterns worth a person&rsquo;s attention — a charge that looks entered twice, an amount
        unlike somebody&rsquo;s usual, one approver signing off everything for one employee. None of
        them block a payment, notify an employee, or go anywhere on their own.
      </p>

      <ErrorBanner message={error} />

      {/* ── the queue ───────────────────────────────────────────────────── */}
      <section className="flex flex-col gap-3">
        <h2 className="text-lg leading-7 font-semibold">Flags</h2>
        <TableCard>
          <Table className="min-w-[860px]">
            <TableHeader>
              <TableRow>
                <TableHead>What was noticed</TableHead>
                <TableHead>About</TableHead>
                <TableHead>Weight</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Decision</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {flags.length === 0 ? (
                <EmptyRow colSpan={5}>
                  Nothing has been flagged. Reports are looked at again after the fact — this fills
                  in when something is worth a second look.
                </EmptyRow>
              ) : (
                flags.map((flag) => {
                  const open = flag.status === 'ACTIVE';
                  return (
                    <TableRow key={flag.id} className="align-top">
                      <TableCell>
                        {renderFraudMessage(flag.message_code, flag.data, prefs.locale)}
                        <span className="mt-1 block text-xs text-muted-foreground">
                          first seen {formatInstant(flag.first_seen_at, prefs)}
                        </span>
                      </TableCell>
                      <TableCell>
                        {flag.report_id === null ? (
                          <span className="text-muted-foreground">
                            {flag.subject_name ?? '—'}
                          </span>
                        ) : (
                          <Link
                            href={`/expenses/${flag.report_id}`}
                            className="underline underline-offset-4"
                          >
                            {flag.report_number ?? flag.report_title ?? 'the report'}
                          </Link>
                        )}
                        {flag.subject_name && flag.report_id !== null ? (
                          <span className="block text-xs text-muted-foreground">
                            {flag.subject_name}
                          </span>
                        ) : null}
                      </TableCell>
                      <TableCell>
                        <span
                          data-testid="severity-badge"
                          className={flag.severity === 'HIGH' ? 'text-destructive' : ''}
                        >
                          {enumLabel(FRAUD_SEVERITY_COPY, flag.severity, prefs.locale)}
                        </span>
                      </TableCell>
                      <TableCell>
                        <span data-testid="status-badge">
                          {enumLabel(FRAUD_FLAG_STATUS_COPY, flag.status, prefs.locale)}
                        </span>
                        {flag.reviewed_at ? (
                          <span className="block text-xs text-muted-foreground">
                            {flag.reviewer_name ?? 'somebody'},{' '}
                            {formatInstant(flag.reviewed_at, prefs)}
                          </span>
                        ) : null}
                        {flag.review_note ? (
                          <span className="mt-1 block text-xs">{flag.review_note}</span>
                        ) : null}
                      </TableCell>
                      <TableCell>
                        {open ? (
                          <div className="flex flex-wrap items-center gap-2">
                            <Input
                              form={`review-${flag.id}`}
                              name="note"
                              placeholder="why (needed to set aside)"
                              className="w-48"
                              aria-label="Why"
                            />
                            <Button
                              form={`review-${flag.id}`}
                              type="submit"
                              name="verdict"
                              value="RESOLVED"
                              size="sm"
                              variant="outline"
                            >
                              Dealt with
                            </Button>
                            <Button
                              form={`review-${flag.id}`}
                              type="submit"
                              name="verdict"
                              value="DISMISSED"
                              size="sm"
                              variant="outline"
                            >
                              Set aside
                            </Button>
                            <Button
                              form={`review-${flag.id}`}
                              type="submit"
                              name="verdict"
                              value="ESCALATED"
                              size="sm"
                              variant="outline"
                            >
                              Escalate
                            </Button>
                          </div>
                        ) : (
                          <span className="text-xs text-muted-foreground">
                            decided — a decision here is not reversible
                          </span>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </TableCard>

        {/*
          Row forms, outside the table. THREE SUBMIT BUTTONS, ONE FORM: the
          verdict rides on the button's own `name`/`value`, so the note the person
          typed belongs to whichever verdict they pressed. Three forms would have
          needed three copies of the note field.
        */}
        {flags.map((flag) => (
          <form key={flag.id} id={`review-${flag.id}`} action={reviewFlagFromForm} className="hidden">
            <input type="hidden" name="flagId" value={flag.id} />
          </form>
        ))}

        <details className="rounded-lg border border-border p-4">
          <summary className="cursor-pointer text-sm font-medium">Raise one yourself</summary>
          <p className="mt-2 text-sm text-muted-foreground">
            For something the rules cannot see — a tip, a pattern you noticed, a conversation. It
            goes in the same queue with your name on it.
          </p>
          <form action={raiseFlagFromForm} className="mt-3 flex flex-wrap items-end gap-2">
            <label className="flex flex-col gap-1 text-sm">
              What is the concern?
              <Input name="note" className="w-80" required />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              Weight
              <NativeSelect
                name="severity"
                defaultValue="MEDIUM"
              >
                {FRAUD_SEVERITIES.map((s) => (
                  <option key={s} value={s}>
                    {enumLabel(FRAUD_SEVERITY_COPY, s, prefs.locale)}
                  </option>
                ))}
              </NativeSelect>
            </label>
            {/*
              REQUIRED, because `fraud_flag_subject_chk` requires a subject and a
              flag with nothing to open is not queue work. It shipped as
              "(optional)" and the first raise from this screen hit the CHECK —
              see `raiseManualFlag`.
            */}
            <label className="flex flex-col gap-1 text-sm">
              Which report?
              <Input name="reportId" className="w-72" required />
            </label>
            <Button type="submit" size="sm">
              Raise it
            </Button>
          </form>
        </details>
      </section>

      {/* ── control evaluation ──────────────────────────────────────────── */}
      <section className="flex flex-col gap-3">
        <h2 className="text-lg leading-7 font-semibold">Control evaluations</h2>
        <p className="text-sm text-muted-foreground">
          A run is a snapshot of a period, not a queue. You do not dismiss a deficiency — you fix it
          and the next run stops reporting it.
        </p>
        <TableCard>
          <Table className="min-w-[720px]">
            <TableHeader>
              <TableRow>
                <TableHead>Run</TableHead>
                <TableHead>Period</TableHead>
                <TableHead>Outcome</TableHead>
                <TableHead>Findings</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {runs.length === 0 ? (
                <EmptyRow colSpan={5}>
                  No evaluation has run yet. &ldquo;Evaluate the controls now&rdquo; runs one over
                  the last 90 days.
                </EmptyRow>
              ) : (
                runs.map((r) => (
                  <TableRow key={r.id} className={`align-top ${ r.id === selectedRunId ? 'bg-muted/30' : '' }`}>
                    <TableCell>
                      {formatInstant(r.started_at, prefs)}
                      <span className="block text-xs text-muted-foreground">
                        {r.requested_by_name ?? 'scheduled'}
                      </span>
                    </TableCell>
                    <TableCell className="text-xs">
                      {formatInstant(r.period_start, prefs)} →{' '}
                      {formatInstant(r.period_end, prefs)}
                    </TableCell>
                    <TableCell>
                      <span
                        data-testid="status-badge"
                        className={r.status === 'FAILED' ? 'text-destructive' : ''}
                      >
                        {enumLabel(CONTROL_RUN_STATUS_COPY, r.status, prefs.locale)}
                      </span>
                      {r.error ? (
                        <span className="block text-xs text-destructive">{r.error}</span>
                      ) : null}
                      {/*
                        A control that THREW, named. Without this the count for
                        that control is simply absent, which reads as "ran, found
                        nothing" — the failure migration 0032's summary column
                        exists to prevent.
                      */}
                      {r.summary?.failedControls && Object.keys(r.summary.failedControls).length > 0 ? (
                        <span className="block text-xs text-destructive">
                          could not check: {Object.keys(r.summary.failedControls).join(', ')}
                        </span>
                      ) : null}
                    </TableCell>
                    <TableCell className="tabular-nums">{r.finding_count}</TableCell>
                    <TableCell>
                      {r.id === selectedRunId ? (
                        <span className="text-xs text-muted-foreground">shown below</span>
                      ) : (
                        <Link
                          href={`/admin/compliance?run=${r.id}`}
                          className="text-sm underline underline-offset-4"
                        >
                          Open
                        </Link>
                      )}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </TableCard>

        {selectedRun === null ? null : (
          <TableCard>
            <Table className="min-w-[720px]">
              <TableHeader>
                <TableRow>
                  <TableHead>Control</TableHead>
                  <TableHead>Subject</TableHead>
                  <TableHead>Weight</TableHead>
                  <TableHead>What it found</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {findings.length === 0 ? (
                  <EmptyRow colSpan={4}>
                    {selectedRun.status === 'FAILED'
                      ? 'This run did not finish, so what it would have found is unknown.'
                      : 'Every control passed for this period.'}
                  </EmptyRow>
                ) : (
                  findings.map((f) => (
                    <TableRow key={f.id} className="align-top">
                      <TableCell className="text-xs">{f.control_code}</TableCell>
                      <TableCell>
                        {/*
                          `subject_label` as recorded, never a join — see
                          `runFindings`. A finding whose subject has since been
                          deleted still has to read correctly.
                        */}
                        {f.subject_label ?? '—'}
                        <span className="block text-xs text-muted-foreground">
                          {f.subject_type === 'expense_category' ? 'category' : 'report'}
                        </span>
                      </TableCell>
                      <TableCell>
                        <span
                          data-testid="severity-badge"
                          className={f.severity === 'CRITICAL' ? 'text-destructive' : ''}
                        >
                          {enumLabel(CONTROL_SEVERITY_COPY, f.severity, prefs.locale)}
                        </span>
                      </TableCell>
                      <TableCell>
                        {renderControlMessage(f.message_code, f.data, prefs.locale)}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </TableCard>
        )}
      </section>

      {/* ── thresholds ──────────────────────────────────────────────────── */}
      <section className="flex flex-col gap-3 rounded-lg border border-border p-4">
        <h2 className="text-lg leading-7 font-semibold">Thresholds</h2>
        <p className="text-sm text-muted-foreground">
          Yours alone — every organization tunes its own. Leave a field blank to use the shipped
          default; the number shown is what is in force now.
        </p>
        <form action={saveThresholdsFromForm} className="flex flex-wrap items-end gap-3">
          <Field name="lookbackDays" label="Look back (days)" value={fraudConfig.lookbackDays} />
          <Field name="windowDays" label="Duplicate window (days)" value={fraudConfig.duplicate.windowDays} />
          <Field name="sigma" label="Outlier (σ)" value={fraudConfig.amountOutlier.sigma} />
          <Field
            name="minAmountMinor"
            label="Ignore under (minor units)"
            value={fraudConfig.amountOutlier.minAmountMinor}
          />
          <Field name="ratio" label="Violation ratio" value={fraudConfig.violationDensity.ratio} />
          <Field
            name="minApprovals"
            label="Approvals before concentration counts"
            value={fraudConfig.approverConcentration.minApprovals}
          />
          <Field name="staleDraftDays" label="Stale draft (days)" value={controlConfig.staleDraftDays} />
          <Field
            name="submittedNoActionDays"
            label="Unactioned submit (days)"
            value={controlConfig.submittedNoActionDays}
          />
          <Button type="submit" size="sm" variant="outline">
            Save thresholds
          </Button>
        </form>
      </section>
    </Screen>
  );
}

function Field({ name, label, value }: { name: string; label: string; value: number }) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      {label}
      <Input name={name} defaultValue={String(value)} className="w-40" inputMode="decimal" />
    </label>
  );
}
