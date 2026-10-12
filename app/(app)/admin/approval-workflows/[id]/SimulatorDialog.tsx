'use client';

/**
 * Workflow simulator — dry-runs the *published* workflows against hypothetical
 * facts (amount / department / job level) and shows which workflow governs them
 * plus the approval steps it would require (assuming every step approves).
 */
import {
  Badge,
  Button,
  Combobox,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field as FormField,
  Input,
} from '@expenseos/design-system';
import { getLocalized } from '@expenseos/i18n';
import type { Locale } from '@expenseos/i18n/locales';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import type { ApprovalSubjectTypeValue } from '@/lib/approvalSubjects';
import { trpc } from '@/lib/trpc/client';
import type { EditorOptions } from './options';
import { TYPE_LABEL } from './WorkflowNodes';

export function SimulatorDialog({
  subjectType,
  options,
  locale,
  onClose,
}: {
  subjectType: ApprovalSubjectTypeValue;
  options: EditorOptions | undefined;
  locale: Locale;
  onClose: () => void;
}) {
  const t = useTranslations('workflows');
  const isReport = subjectType === 'EXPENSE_REPORT';
  const [amount, setAmount] = useState('');
  const [departmentId, setDepartmentId] = useState<string | null>(null);
  const [jobLevelId, setJobLevelId] = useState<string | null>(null);
  // Expense-report-only facts (Phase 5).
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [maxLineAmount, setMaxLineAmount] = useState('');
  const [requiresApproval, setRequiresApproval] = useState<string | null>(null);
  const [hasPolicyViolation, setHasPolicyViolation] = useState<string | null>(null);
  const [overPerDiem, setOverPerDiem] = useState<string | null>(null);
  const [overBudget, setOverBudget] = useState<string | null>(null);
  const [ran, setRan] = useState(false);

  const asBool = (v: string | null): 'true' | 'false' | undefined =>
    v === 'true' ? 'true' : v === 'false' ? 'false' : undefined;
  const input = {
    /**
     * No narrowing cast here. It used to read
     * `subjectType as 'VIRTUAL_CARD_REQUEST' | 'EXPENSE_REPORT'`, which told TypeScript
     * a lie — the prop is every subject the engine routes, and on a travel workflow the
     * runtime value was 'TRAVEL_REQUEST' reaching an input schema that did not list it.
     * The cast is what kept the compiler quiet while the query failed in the browser.
     */
    subjectType,
    amount: amount.trim() ? Math.round(Number(amount) * 100) : undefined,
    departmentId: departmentId ?? undefined,
    jobLevelId: jobLevelId ?? undefined,
    ...(isReport
      ? {
          categoryIds: categoryId ? [categoryId] : undefined,
          maxLineAmount: maxLineAmount.trim() ? Math.round(Number(maxLineAmount) * 100) : undefined,
          requiresApproval: asBool(requiresApproval),
          hasPolicyViolation: asBool(hasPolicyViolation),
          overPerDiem: asBool(overPerDiem),
          overBudget: asBool(overBudget),
        }
      : {}),
  };
  const sim = trpc.approvalWorkflows.simulate.useQuery(input, { enabled: ran });

  const jobLevelItems = (options?.jobLevels ?? []).map((j) => ({
    value: j.id,
    label: `${j.code} — ${getLocalized(j.label, locale) ?? j.code}`,
  }));
  const deptItems = (options?.departments ?? []).map((d) => ({
    value: d.id,
    label: (getLocalized(d.label, locale) ?? d.id) as string,
  }));
  const categoryItems = (options?.categories ?? []).map((c) => ({
    value: c.id,
    label: (getLocalized(c.label, locale) ?? c.id) as string,
  }));
  const yesNoItems = [
    { value: 'true', label: t('sim.yes') },
    { value: 'false', label: t('sim.no') },
  ];

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('sim.title')}</DialogTitle>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          <FormField htmlFor="sim-amount" label={t('sim.amount')}>
            <Input
              id="sim-amount"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              inputMode="decimal"
              placeholder="50000"
            />
          </FormField>
          <FormField htmlFor="sim-jl" label={t('sim.jobLevel')} optional>
            <Combobox
              id="sim-jl"
              items={jobLevelItems}
              value={jobLevelId}
              onValueChange={setJobLevelId}
              placeholder="—"
            />
          </FormField>
          <FormField htmlFor="sim-dept" label={t('sim.department')} optional>
            <Combobox
              id="sim-dept"
              items={deptItems}
              value={departmentId}
              onValueChange={setDepartmentId}
              placeholder="—"
            />
          </FormField>
          {isReport && (
            <>
              <FormField htmlFor="sim-cat" label={t('sim.category')} optional>
                <Combobox
                  id="sim-cat"
                  items={categoryItems}
                  value={categoryId}
                  onValueChange={setCategoryId}
                  placeholder="—"
                />
              </FormField>
              <FormField htmlFor="sim-maxline" label={t('sim.maxLine')} optional>
                <Input
                  id="sim-maxline"
                  value={maxLineAmount}
                  onChange={(e) => setMaxLineAmount(e.target.value)}
                  inputMode="decimal"
                  placeholder="5000"
                />
              </FormField>
              <FormField htmlFor="sim-reqappr" label={t('sim.requiresApproval')} optional>
                <Combobox
                  id="sim-reqappr"
                  items={yesNoItems}
                  value={requiresApproval}
                  onValueChange={setRequiresApproval}
                  placeholder="—"
                />
              </FormField>
              <FormField htmlFor="sim-violation" label={t('sim.hasPolicyViolation')} optional>
                <Combobox
                  id="sim-violation"
                  items={yesNoItems}
                  value={hasPolicyViolation}
                  onValueChange={setHasPolicyViolation}
                  placeholder="—"
                />
              </FormField>
              <FormField htmlFor="sim-perdiem" label={t('sim.overPerDiem')} optional>
                <Combobox
                  id="sim-perdiem"
                  items={yesNoItems}
                  value={overPerDiem}
                  onValueChange={setOverPerDiem}
                  placeholder="—"
                />
              </FormField>
              <FormField htmlFor="sim-overbudget" label={t('sim.overBudget')} optional>
                <Combobox
                  id="sim-overbudget"
                  items={yesNoItems}
                  value={overBudget}
                  onValueChange={setOverBudget}
                  placeholder="—"
                />
              </FormField>
            </>
          )}
          <div className="flex items-end">
            <Button
              size="sm"
              onClick={() => {
                setRan(true);
                sim.refetch();
              }}
            >
              {sim.isFetching ? t('sim.running') : t('sim.run')}
            </Button>
          </div>
        </div>

        {/*
         * A failed run has to SAY it failed.
         *
         * This block used to be `ran && sim.data && (…)` and nothing else, so any error
         * — a rejected input, a network failure, a server throw — rendered exactly
         * nothing. Pressing Run and watching the dialog not change is indistinguishable
         * from a workflow that produces no steps, and that is how a validation error on
         * `subjectType` got reported as a graph that could not run (GA v2, GA-1).
         */}
        {ran && sim.isError && (
          <p className="mt-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-destructive text-sm">
            {t('sim.failed')}
          </p>
        )}
        {ran && sim.data && (
          <div className="mt-2 space-y-2 rounded-md border border-border p-3">
            <div className="text-sm">
              {sim.data.workflowName ? (
                <>
                  <span className="text-muted-foreground">{t('sim.matched')}: </span>
                  <span className="font-medium text-foreground">{sim.data.workflowName}</span>
                </>
              ) : (
                <span className="text-muted-foreground">{t('sim.none')}</span>
              )}
            </div>
            {sim.data.steps.length === 0 ? (
              <p className="text-muted-foreground text-xs">{t('sim.noSteps')}</p>
            ) : (
              <ol className="space-y-1">
                {sim.data.steps.map((s, i) => (
                  <li key={s.nodeId} className="flex items-center gap-2 text-sm">
                    <span className="text-muted-foreground text-xs tabular-nums">{i + 1}.</span>
                    <span className="text-foreground">
                      {TYPE_LABEL[s.type as keyof typeof TYPE_LABEL] ?? s.type}
                    </span>
                    {/*
                     * WHICH approver, not just "Approval".
                     *
                     * The seeded expense workflow routes by amount to ONE approver of the
                     * appropriate seniority, so a single step is the designed output and
                     * the tier is the whole difference between a $500 claim and a
                     * $500,000 one. Printing only the node type made a correctly tiered
                     * graph indistinguishable from an untiered one, and it was read as
                     * the latter (F42).
                     */}
                    {s.approver && (
                      <span className="text-muted-foreground text-xs">
                        {t(`sim.approver.${s.approver.kind}`)}
                        {s.approver.minJobLevelCode && ` ≥ ${s.approver.minJobLevelCode}`}
                      </span>
                    )}
                  </li>
                ))}
              </ol>
            )}
            <Badge variant={sim.data.status === 'APPROVED' ? 'success' : 'secondary'}>
              {sim.data.status}
            </Badge>
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose}>
            {t('sim.close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
