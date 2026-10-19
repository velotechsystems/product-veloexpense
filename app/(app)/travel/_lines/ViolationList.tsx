'use client';

import { Button, Input } from '@expenseos/design-system';
import { IconAlertTriangle } from '@tabler/icons-react';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { groupViolations, violationValues } from '@/components/policy/violations';

/**
 * Policy violations on a travel request — the blockers, and the warnings that need a word.
 *
 * The severity split is the point of this component. On an expense report a WARNING is
 * justified through the parent expense's "Explain this charge" field, so the expense
 * workbench's violation line is display-only. A travel line has no such field, so a
 * warning carries its own justification box here — and a BLOCK carries none at all,
 * because a blocking violation must be fixed rather than justified. That refusal is
 * enforced on the server (`travelRequests.justifyViolation`); the absent box is only what
 * stops somebody wasting a paragraph on it.
 *
 * Grouping and placeholder resolution come from `@/components/policy/violations`, shared
 * with the expense side: three lines over one limit is one sentence, and the sentence is
 * assembled in the READER's locale because a traveller and their approver need not share
 * one.
 */

export interface TravelViolation {
  id: string;
  travelLineId: string | null;
  severity: string;
  /** The message KEY. Resolved against `expenses.policy.labels.*` below. */
  message: string;
  data?: unknown;
  resolveNote: string | null;
  resolvedAt: Date | string | null;
}

const ICON_CLASS: Record<string, string> = {
  BLOCK: 'text-destructive',
  WARNING: 'text-warning',
  INFO: 'text-muted-foreground',
};

export function ViolationList({
  violations,
  editable,
  pending,
  onJustify,
}: {
  violations: readonly TravelViolation[];
  editable: boolean;
  pending: boolean;
  onJustify: (violationId: string, note: string | null) => void;
}) {
  const t = useTranslations('travel');
  /**
   * The rule LABELS live in the expenses catalog, and reading them from here is
   * deliberate rather than sloppy.
   *
   * `expenses.policy.labels` is the single registry of rule sentences, and
   * `policy.messageKeys.test.ts` checks EVERY registered kind against it in both locales.
   * A travel-only label namespace would let a travel rule ship with no sentence in either
   * place — which is precisely the failure that test was written for (`perDiemRate`
   * shipped unlabelled and rendered its own identifier at claimants for months).
   */
  const tPolicy = useTranslations('expenses');
  const locale = useLocale();

  if (violations.length === 0) return null;

  return (
    <ul className="flex flex-col gap-1.5">
      {groupViolations(violations).map(({ key, violation, count }) => (
        <ViolationRow
          key={key}
          violation={violation}
          count={count}
          editable={editable}
          pending={pending}
          locale={locale}
          t={t}
          tPolicy={tPolicy}
          onJustify={onJustify}
        />
      ))}
    </ul>
  );
}

function ViolationRow({
  violation,
  count,
  editable,
  pending,
  locale,
  t,
  tPolicy,
  onJustify,
}: {
  violation: TravelViolation;
  count: number;
  editable: boolean;
  pending: boolean;
  locale: string;
  t: ReturnType<typeof useTranslations<'travel'>>;
  tPolicy: ReturnType<typeof useTranslations<'expenses'>>;
  onJustify: (violationId: string, note: string | null) => void;
}) {
  const [note, setNote] = useState(violation.resolveNote ?? '');
  const [open, setOpen] = useState(false);

  const values = violationValues(violation, locale) ?? {};
  // The cabin arrives as its raw token ('BUSINESS') because an interpolation value cannot
  // perform its own catalog lookup. Localized here, where the catalog is in hand.
  const cabinKey = values.cabin ? (`policy.cabin.${values.cabin}` as never) : null;
  const resolved = {
    ...values,
    ...(cabinKey && t.has(cabinKey) ? { cabin: t(cabinKey) } : {}),
  };

  const labelKey = `policy.labels.${violation.message}`;
  const label = tPolicy.has(labelKey as never)
    ? tPolicy(labelKey as never, resolved as never)
    : violation.message;

  const isBlock = violation.severity === 'BLOCK';
  const justified = !!violation.resolvedAt;
  // INFO gets no box either: it blocks nothing, so a justification would be a comment
  // nobody is waiting for.
  const justifiable = editable && violation.severity === 'WARNING';

  return (
    <li className="rounded border border-border bg-muted/20 px-2.5 py-1.5">
      <div className="flex items-start gap-2">
        <IconAlertTriangle
          size={14}
          className={`mt-0.5 shrink-0 ${ICON_CLASS[violation.severity] ?? ICON_CLASS.INFO}`}
        />
        <span className="text-xs">
          <span className="text-muted-foreground">
            {t(`policy.severity.${violation.severity}` as never)}:{' '}
          </span>
          <span className="text-foreground">{label}</span>
          {/**
           * "on 3 lines", not a bare "×3".
           *
           * This is an OCCURRENCE count — how many line items raised the same rule — while the
           * top-bar count and the row badge show DEDUPED issue counts for the same violations.
           * Three numbers about one report, disagreeing, with nothing saying they measure
           * different things (GA readiness report F11; the duplication half of that finding was
           * separately shown not to be a defect). Labelling it is what stops it reading as a
           * competing total.
           */}
          {count > 1 && (
            <span className="ml-1 text-muted-foreground">
              {tPolicy('policy.onNLines', { count })}
            </span>
          )}
        </span>
      </div>

      {isBlock && (
        <p className="mt-1 pl-6 text-[11px] text-muted-foreground">{t('policy.blockHint')}</p>
      )}

      {justifiable && !open && (
        <div className="mt-1 flex items-center gap-2 pl-6">
          {justified && (
            <span className="truncate text-[11px] text-muted-foreground italic">
              {violation.resolveNote}
            </span>
          )}
          <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
            {justified ? t('policy.editJustification') : t('policy.justify')}
          </Button>
        </div>
      )}

      {justifiable && open && (
        <div className="mt-1 flex items-start gap-2 pl-6">
          <Input
            aria-label={t('policy.justify')}
            value={note}
            placeholder={t('policy.justifyPlaceholder')}
            onChange={(e) => setNote(e.target.value)}
          />
          <Button
            size="sm"
            disabled={pending}
            onClick={() => {
              // A blank note CLEARS the justification, which is why it is sent rather
              // than treated as "cancel" — an explanation the traveller no longer stands
              // behind should stop unblocking their submit.
              onJustify(violation.id, note.trim() || null);
              setOpen(false);
            }}
          >
            {t('policy.saveJustification')}
          </Button>
        </div>
      )}
    </li>
  );
}
