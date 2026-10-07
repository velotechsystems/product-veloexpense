/**
 * VX2-4a — /admin/approval-ladder. Who signs off on what, per tenant.
 *
 * Server component posting plain `<form action={serverAction}>`, same as
 * /admin/expense-policies and the employee directory: no client JS, no client
 * state. Row forms live after the table because a `<form>` may not be a child of
 * `<tr>`; the inputs point at them with the HTML `form` attribute.
 *
 * ── What an admin needs to understand from this page ────────────────────────
 *
 * The two numbers do different jobs and conflating them is the mistake this page
 * exists to prevent:
 *
 *   ORDER     (sequence)  — who signs FIRST. Finance can sit ahead of a
 *                           second-level manager without touching any amount.
 *   APPLIES AT (threshold) — the total from which the rung is required at all.
 *
 * The ladder is CUMULATIVE: a report collects EVERY enabled rung whose threshold
 * its total meets, in order. It is not a set of bands — a $9,000 report climbs
 * the $0 rung and the $5,000 rung, it does not skip to the top one. That is the
 * deliberate divergence from VeloLedger's mutually-exclusive tiers, because an
 * expense ladder reads "the manager always signs, and finance as well past $5k".
 *
 * With NO rungs configured, every report still goes to the submitter's direct
 * manager (`IMPLICIT_STEP`). This page is for tenants who need more than that;
 * an empty table is a working configuration, not an unfinished one, and the page
 * says so rather than nagging.
 */
import { Fragment } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { minorToDecimalString } from '@/lib/money';
import { MAX_APPROVAL_STEPS, MAX_CONFIGURED_RUNGS } from '@/lib/approvals/tiers';
import {
  encodeApproverToken,
  type ApproverChoice,
} from '@/lib/approvals/approver-token';
import {
  createRungFromForm,
  deleteRungFromForm,
  getLadderPage,
  restoreStarterLadderFromForm,
  updateRungFromForm,
} from './actions';
import { EmptyRow, ErrorBanner, fieldClass, labelClass } from '@/app/expenses/ui';

import { pageTitle } from '@/lib/i18n/page-title';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { TableCard } from '@/components/screen';
import { NativeSelect } from '@/components/ui/native-select';
import { PageHeader, Screen } from '@/components/screen';

// UD-16. See `lib/i18n/page-title.ts` for why the title lives here rather than
// in a map of routes, and `scripts/check-page-titles.mjs` for what enforces it.
export function generateMetadata() {
  return pageTitle('title.admin.approval.ladder');
}

export const dynamic = 'force-dynamic';

const GROUPS: Array<ApproverChoice['group']> = ['Reporting line', 'By role', 'A specific person'];

/**
 * One approver picker. `selected` empty renders the blank "add another" row.
 *
 * Grouped with <optgroup> so "anyone with the ADMIN role" is visibly a different
 * kind of thing from a named person — the difference matters, because a role is a
 * pool nobody is assigned from, and an admin who thinks they picked a person will
 * wonder why nothing landed in that person's inbox.
 */
function ApproverSelect({
  formId,
  choices,
  selected,
  label,
}: {
  /** Omitted when the select sits INSIDE its form (the add-a-rung section).
   *  `form=""` is not the same as no attribute — it names a form with an empty
   *  id, i.e. none, and the select is then submitted with nothing. */
  formId?: string;
  choices: ApproverChoice[];
  selected: string;
  label: string;
}) {
  return (
    <div className={fieldClass}>
      <label className="text-xs text-muted-foreground">{label}</label>
      <NativeSelect
        {...(formId ? { form: formId } : {})}
        name="approver"
        defaultValue={selected}
      >
        <option value="">— none —</option>
        {GROUPS.map((group) => (
          <optgroup key={group} label={group}>
            {choices
              .filter((c) => c.group === group)
              .map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
          </optgroup>
        ))}
      </NativeSelect>
    </div>
  );
}

export default async function ApprovalLadderPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  const { rungs, choices } = await getLadderPage();

  const enabled = rungs.filter((r) => r.enabled);
  const flattenedSteps = enabled.reduce((n, r) => n + r.approvers.length, 0);
  const nextSequence = rungs.reduce((max, r) => Math.max(max, r.sequence), 0) + 1;

  return (
    <Screen width="wide">
      <PageHeader
        title="Approval ladder"
        description={`${
          rungs.length === 0
            ? 'No rungs — every report goes to the submitter’s manager'
            : `${rungs.length} ${rungs.length === 1 ? 'rung' : 'rungs'} · ${flattenedSteps} approval${flattenedSteps === 1 ? '' : 's'} on a report that meets every threshold`
        } · changes apply to the next report submitted, no deploy`}
        actions={
          rungs.length < MAX_CONFIGURED_RUNGS ? (
            <form action={restoreStarterLadderFromForm}>
              <Button type="submit" variant="outline">
                Add the starter ladder
              </Button>
            </form>
          ) : null
        }
      />

      <ErrorBanner message={error} />

      {rungs.length === 0 ? (
        <div className="rounded-lg border border-border bg-muted/30 p-4 text-sm">
          <p className="font-medium">This is a working configuration.</p>
          <p className="mt-1 text-muted-foreground">
            With no rungs, every submitted report is approved by the submitter’s manager — the
            manager set on their employee record. Add a rung when you need more than that: a second
            signature above a certain amount, or finance sign-off on the largest claims.
          </p>
        </div>
      ) : null}

      {flattenedSteps > MAX_APPROVAL_STEPS ? (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm">
          <p className="font-medium">
            A report meeting every threshold would need {flattenedSteps} approvals, and the limit is{' '}
            {MAX_APPROVAL_STEPS}.
          </p>
          <p className="mt-1 text-muted-foreground">
            Submitting such a report will be refused rather than have its last approvals dropped —
            losing the tail would silently remove the sign-off on your largest claims. Disable a rung
            or remove an approver.
          </p>
        </div>
      ) : null}

      <TableCard>
        <Table className="min-w-[980px]">
          <TableHeader>
            <TableRow>
              <TableHead>Order</TableHead>
              <TableHead>Rung</TableHead>
              <TableHead>Applies from</TableHead>
              <TableHead>Approvers, in order</TableHead>
              <TableHead>Receipts</TableHead>
              <TableHead>On</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rungs.length === 0 ? (
              <EmptyRow colSpan={7}>Nothing configured — add a rung below.</EmptyRow>
            ) : (
              rungs.map((rung) => {
                const formId = `rung-${rung.id}`;
                const external = rung.approvers.filter((a) => a.approver_kind === 'EMAIL');
                return (
                  <TableRow key={rung.id} className="align-top">
                    <TableCell>
                      <Input
                        form={formId}
                        name="sequence"
                        type="number"
                        min={1}
                        max={MAX_CONFIGURED_RUNGS}
                        defaultValue={rung.sequence}
                        className="w-16"
                      />
                    </TableCell>
                    <TableCell>
                      <Input form={formId} name="name" defaultValue={rung.name} className="w-48" />
                    </TableCell>
                    <TableCell>
                      <Input
                        form={formId}
                        name="threshold"
                        defaultValue={minorToDecimalString(rung.threshold_minor, 2)}
                        className="w-28"
                        aria-label="Applies from"
                      />
                      <p className="mt-1 text-xs text-muted-foreground">
                        {rung.threshold_minor === '0' ? 'every report' : 'and above'}
                      </p>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-col gap-2">
                        {rung.approvers
                          .filter((a) => a.approver_kind !== 'EMAIL')
                          .map((a, i) => (
                            <ApproverSelect
                              key={a.id}
                              formId={formId}
                              choices={choices}
                              selected={encodeApproverToken(a)}
                              label={`${i + 1}${i === 0 ? 'st' : i === 1 ? 'nd' : i === 2 ? 'rd' : 'th'} to sign`}
                            />
                          ))}
                        <ApproverSelect
                          formId={formId}
                          choices={choices}
                          selected=""
                          label="Add another"
                        />
                        {external.length > 0 ? (
                          <p className="text-xs text-destructive">
                            {external.length} external approver
                            {external.length === 1 ? '' : 's'} ({external.map((a) => a.external_email).join(', ')}) —
                            stored, but a report needing one cannot be submitted until external
                            approve-links ship. Saving this rung removes them.
                          </p>
                        ) : null}
                      </div>
                    </TableCell>
                    <TableCell>
                      <label className="flex items-center gap-2 text-xs">
                        <input
                          form={formId}
                          type="checkbox"
                          name="requireReceiptViewAck"
                          defaultChecked={rung.require_receipt_view_ack}
                        />
                        must confirm
                      </label>
                    </TableCell>
                    <TableCell>
                      <label className="flex items-center gap-2 text-xs">
                        <input
                          form={formId}
                          type="checkbox"
                          name="enabled"
                          defaultChecked={rung.enabled}
                        />
                        enabled
                      </label>
                    </TableCell>
                    <TableCell>
                      <div className="flex gap-2">
                        <Button form={formId} type="submit" size="sm">
                          Save
                        </Button>
                        <Button form={`delete-${rung.id}`} type="submit" size="sm" variant="outline">
                          Remove
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </TableCard>

      {/* The row forms. Outside the table, referenced by `form=` above. */}
      {rungs.map((rung) => (
        <Fragment key={rung.id}>
          <form id={`rung-${rung.id}`} action={updateRungFromForm} className="hidden">
            <input type="hidden" name="policyId" value={rung.id} />
          </form>
          <form id={`delete-${rung.id}`} action={deleteRungFromForm} className="hidden">
            <input type="hidden" name="policyId" value={rung.id} />
          </form>
        </Fragment>
      ))}

      {/* ── add a rung ───────────────────────────────────────────────────── */}
      <section className="rounded-lg border border-border p-4">
        <h2 className="text-lg leading-7 font-semibold">Add a rung</h2>
        <p className="mb-3 text-sm text-muted-foreground">
          <strong>Order</strong> is who signs first. <strong>Applies from</strong> is the report
          total at which this rung becomes required — leave it at 0 for every report. A report
          climbs every rung it qualifies for, so a rung at $5,000 is an <em>extra</em> signature on
          large claims, not a replacement for the ones below it.
        </p>
        <form action={createRungFromForm} className="flex flex-col gap-3">
          <div className="flex flex-wrap gap-3">
            <div className={fieldClass}>
              <label className={labelClass} htmlFor="new-sequence">
                Order
              </label>
              <Input
                id="new-sequence"
                name="sequence"
                type="number"
                min={1}
                max={MAX_CONFIGURED_RUNGS}
                defaultValue={nextSequence}
                className="w-20"
              />
            </div>
            <div className={fieldClass}>
              <label className={labelClass} htmlFor="new-name">
                Rung name
              </label>
              <Input
                id="new-name"
                name="name"
                placeholder="Finance sign-off"
                className="w-56"
                required
              />
            </div>
            <div className={fieldClass}>
              <label className={labelClass} htmlFor="new-threshold">
                Applies from
              </label>
              <Input id="new-threshold" name="threshold" placeholder="0.00" className="w-28" />
            </div>
          </div>
          <div className="flex flex-wrap gap-3">
            <ApproverSelect choices={choices} selected="" label="1st to sign" />
            <ApproverSelect choices={choices} selected="" label="2nd to sign (optional)" />
          </div>
          <div className="flex flex-wrap items-center gap-4 text-sm">
            <label className="flex items-center gap-2">
              <input type="checkbox" name="requireReceiptViewAck" defaultChecked />
              Approvers must confirm they reviewed the receipts
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" name="enabled" defaultChecked />
              Enabled
            </label>
          </div>
          <div>
            <Button type="submit">Add rung</Button>
          </div>
        </form>
      </section>
    </Screen>
  );
}
