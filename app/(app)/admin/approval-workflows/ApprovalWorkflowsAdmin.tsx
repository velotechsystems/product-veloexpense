'use client';

/**
 * /admin/approval-workflows — workflow management list (Phase C1). Create,
 * edit metadata, publish the draft, activate/deactivate. Graph authoring is
 * the per-workflow visual editor (Phase C2), reached via "Open editor".
 */
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field as FormField,
  Input,
  RowActionsMenu,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
} from '@expenseos/design-system';
import {
  IconPencil,
  IconPlus,
  IconRocket,
  IconSitemap,
  IconToggleLeft,
  IconToggleRight,
} from '@tabler/icons-react';
import type { inferRouterOutputs } from '@trpc/server';
import { useTranslations } from 'next-intl';
import { useEffect, useMemo, useState } from 'react';
import { slugify } from '@/components/admin/AdminLookupPage';
import {
  type ColumnDef,
  createDataTableState,
  DataTable,
  type DataTableState,
  useTableLabels,
} from '@/components/data-view';
import { useRouter } from '@/i18n/navigation';
import { APPROVAL_SUBJECT_TYPES, type ApprovalSubjectTypeValue } from '@/lib/approvalSubjects';
import { trpc } from '@/lib/trpc/client';
import type { AppRouter } from '@/server/routers/_app';
import { setTopBarSlot } from '../../TopBar';

type WorkflowItem = inferRouterOutputs<AppRouter>['approvalWorkflows']['list']['items'][number];
type ColumnId = 'name' | 'subject' | 'status' | 'actions';

/**
 * Subject types a workflow can govern — the SAME list the router validates against,
 * imported rather than mirrored. This used to be a hand-kept copy annotated "(mirrors
 * the router's SUBJECT_TYPES)", and it had drifted two members behind the model, so the
 * New-workflow picker could not offer travel or limit-increase workflows at all.
 */
const SUBJECT_TYPE_OPTIONS = APPROVAL_SUBJECT_TYPES;
type SubjectType = ApprovalSubjectTypeValue;

const STATUS_VARIANT: Record<string, 'success' | 'warning' | 'secondary'> = {
  published: 'success',
  draftPending: 'warning',
  noVersion: 'secondary',
};

export function statusKey(w: WorkflowItem): 'published' | 'draftPending' | 'noVersion' {
  const hasDraft = w.versions.some((v) => v.status === 'DRAFT');
  if (w.currentVersionId) return hasDraft ? 'draftPending' : 'published';
  return 'noVersion';
}

export function ApprovalWorkflowsAdmin({ canManage }: { canManage: boolean }) {
  const t = useTranslations('workflows');
  const router = useRouter();
  const utils = trpc.useUtils();
  const list = trpc.approvalWorkflows.list.useQuery();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<WorkflowItem | null>(null);
  const [error, setError] = useState<string | null>(null);

  const invalidate = () => utils.approvalWorkflows.list.invalidate();
  const onErr = (e: { message: string }) => setError(e.message);

  const publish = trpc.approvalWorkflows.publish.useMutation({
    onSuccess: invalidate,
    onError: onErr,
  });
  const setMeta = trpc.approvalWorkflows.setMeta.useMutation({
    onSuccess: invalidate,
    onError: onErr,
  });

  useEffect(() => {
    if (!canManage) return;
    setTopBarSlot(
      'right',
      <Button size="sm" onClick={() => setCreating(true)}>
        <IconPlus size={15} className="mr-1.5" />
        {t('list.newWorkflow')}
      </Button>,
    );
    return () => setTopBarSlot('right', null);
  }, [canManage, t]);

  // VeloExpense: memoised, as eslint's exhaustive-deps asks (ExpenseOS lints with Biome); the
  // `?? []` would otherwise hand the two memos below a new array on every render.
  const items = useMemo(() => list.data?.items ?? [], [list.data]);
  // Non-defaults first (drag-reorderable, order = priority, top wins);
  // defaults pinned after them and not draggable.
  const rows = useMemo(
    () => [...items.filter((w) => !w.isDefault), ...items.filter((w) => w.isDefault)],
    [items],
  );
  const defaultIds = useMemo(
    () => new Set(items.filter((w) => w.isDefault).map((w) => w.id)),
    [items],
  );

  const reorder = trpc.approvalWorkflows.reorder.useMutation({
    onSuccess: invalidate,
    onError: onErr,
  });

  const tableLabels = useTableLabels();
  const columns = useMemo<ColumnDef<WorkflowItem, ColumnId>[]>(
    () => [
      {
        id: 'name',
        label: t('list.colName'),
        defaultWidth: 320,
        hideable: false,
        cell: (w) => (
          <div className="flex items-center gap-2">
            <span className="font-medium text-foreground">{w.name}</span>
            {w.isDefault && <Badge variant="outline">{t('list.default')}</Badge>}
            {!w.active && <Badge variant="secondary">{t('actions.deactivate')}d</Badge>}
          </div>
        ),
      },
      {
        id: 'subject',
        label: t('list.colSubject'),
        defaultWidth: 200,
        cell: (w) => <span className="text-muted-foreground">{t(`subject.${w.subjectType}`)}</span>,
      },
      {
        id: 'status',
        label: t('list.colStatus'),
        defaultWidth: 150,
        cell: (w) => {
          const sk = statusKey(w);
          return <Badge variant={STATUS_VARIANT[sk]}>{t(`status.${sk}`)}</Badge>;
        },
      },
      {
        id: 'actions',
        label: '',
        defaultWidth: 80,
        hideable: false,
        draggable: false,
        resizable: false,
        pinnable: false,
        cell: (w) =>
          canManage ? (
            <div className="flex justify-end">
              <RowActionsMenu
                ariaLabel={t('actions.menu')}
                actions={[
                  {
                    id: 'open',
                    icon: <IconSitemap size={14} />,
                    label: t('actions.edit'),
                    onClick: () => router.push(`/admin/approval-workflows/${w.id}`),
                  },
                  {
                    id: 'edit',
                    icon: <IconPencil size={14} />,
                    label: t('actions.editMeta'),
                    onClick: () => setEditing(w),
                  },
                  {
                    id: 'publish',
                    icon: <IconRocket size={14} />,
                    label: t('actions.publish'),
                    disabled: !w.versions.some((v) => v.status === 'DRAFT'),
                    onClick: () => {
                      if (window.confirm(t('publishConfirm'))) {
                        publish.mutate({ workflowId: w.id });
                      }
                    },
                  },
                  { divider: true as const },
                  {
                    id: 'toggle',
                    icon: w.active ? <IconToggleLeft size={14} /> : <IconToggleRight size={14} />,
                    label: w.active ? t('actions.deactivate') : t('actions.activate'),
                    onClick: () => setMeta.mutate({ id: w.id, active: !w.active }),
                  },
                ]}
              />
            </div>
          ) : null,
      },
    ],
    [t, canManage, router, publish, setMeta],
  );

  const [tableState, setTableState] = useState<DataTableState<ColumnId>>(() =>
    createDataTableState(columns as never, {}),
  );

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      {error && (
        <p className="rounded bg-destructive/10 px-3 py-2 text-destructive text-sm">{error}</p>
      )}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border border-border bg-card">
        <DataTable<WorkflowItem, ColumnId>
          columns={columns}
          rows={rows}
          rowKey={(w) => w.id}
          loading={list.isLoading}
          totalCount={rows.length}
          state={tableState}
          onStateChange={setTableState}
          labels={tableLabels}
          disableInfiniteScroll
          renderEmpty={() => (
            <span className="text-muted-foreground text-sm">{t('list.empty')}</span>
          )}
          rowDnd={
            canManage
              ? {
                  canDrag: (w) => !w.isDefault,
                  onReorder: (ids) =>
                    reorder.mutate({ ids: ids.filter((id) => !defaultIds.has(id)) }),
                }
              : undefined
          }
        />
      </div>
      <p className="px-1 text-muted-foreground text-xs">{t('list.reorderHint')}</p>

      {creating && (
        <CreateDialog
          onClose={() => setCreating(false)}
          onCreated={() => {
            invalidate();
            setCreating(false);
          }}
        />
      )}
      {editing && (
        <MetaDialog
          workflow={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            invalidate();
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

// ── Create dialog ──────────────────────────────────────────────────

function CreateDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const t = useTranslations('workflows');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  // VeloExpense: EXPENSE_REPORT is the only subject (lib/approvalSubjects).
  const [subjectType, setSubjectType] = useState<SubjectType>('EXPENSE_REPORT');
  const [isDefault, setIsDefault] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = trpc.approvalWorkflows.create.useMutation({
    onSuccess: onCreated,
    onError: (e) => setError(e.message),
  });

  // Key is derived from the name (slug) — never shown or edited.
  const effectiveKey = slugify(name);
  const canSubmit = name.trim().length > 0 && /^[a-z0-9-]{2,64}$/.test(effectiveKey);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('create.title')}</DialogTitle>
        </DialogHeader>
        {error && <p className="text-destructive text-sm">{error}</p>}
        <div className="space-y-4">
          <FormField htmlFor="wf-name" label={t('create.name')} required>
            <Input
              id="wf-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('create.namePlaceholder')}
            />
          </FormField>
          <FormField htmlFor="wf-desc" label={t('create.description')} optional>
            <Textarea
              id="wf-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
            />
          </FormField>
          <FormField htmlFor="wf-subject" label={t('create.subject')}>
            <Select
              value={subjectType}
              onValueChange={(v) => setSubjectType((v as SubjectType) ?? 'EXPENSE_REPORT')}
            >
              <SelectTrigger id="wf-subject">
                {/* VeloExpense kit: Radix's <SelectValue> renders the chosen item's own label, so
                    ExpenseOS's render-fn mapping for Base UI (which shows the raw value) is not
                    needed (as in components/forms/ColorInput.tsx). */}
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SUBJECT_TYPE_OPTIONS.map((s) => (
                  <SelectItem key={s} value={s}>
                    {t(`subject.${s}` as 'subject.VIRTUAL_CARD_REQUEST')}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>
          <FormField
            htmlFor="wf-default"
            label={t('create.isDefault')}
            controlPosition="inline-leading"
          >
            <input
              id="wf-default"
              type="checkbox"
              checked={isDefault}
              onChange={(e) => setIsDefault(e.target.checked)}
            />
          </FormField>
        </div>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose}>
            {t('create.cancel')}
          </Button>
          <Button
            size="sm"
            disabled={!canSubmit || create.isPending}
            onClick={() =>
              create.mutate({
                name: name.trim(),
                key: effectiveKey,
                description: description.trim() || undefined,
                subjectType,
                isDefault,
              })
            }
          >
            {create.isPending ? t('create.submitting') : t('create.submit')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Edit-meta dialog ───────────────────────────────────────────────

function MetaDialog({
  workflow,
  onClose,
  onSaved,
}: {
  workflow: WorkflowItem;
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useTranslations('workflows');
  const [name, setName] = useState(workflow.name);
  const [description, setDescription] = useState(workflow.description ?? '');
  const [isDefault, setIsDefault] = useState(workflow.isDefault);
  const [error, setError] = useState<string | null>(null);

  const setMeta = trpc.approvalWorkflows.setMeta.useMutation({
    onSuccess: onSaved,
    onError: (e) => setError(e.message),
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('meta.title')}</DialogTitle>
        </DialogHeader>
        {error && <p className="text-destructive text-sm">{error}</p>}
        <div className="space-y-4">
          <FormField htmlFor="m-name" label={t('create.name')} required>
            <Input id="m-name" value={name} onChange={(e) => setName(e.target.value)} />
          </FormField>
          <FormField htmlFor="m-desc" label={t('create.description')} optional>
            <Textarea
              id="m-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
            />
          </FormField>
          <FormField
            htmlFor="m-default"
            label={t('create.isDefault')}
            controlPosition="inline-leading"
          >
            <input
              id="m-default"
              type="checkbox"
              checked={isDefault}
              onChange={(e) => setIsDefault(e.target.checked)}
            />
          </FormField>
        </div>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose}>
            {t('create.cancel')}
          </Button>
          <Button
            size="sm"
            disabled={setMeta.isPending}
            onClick={() =>
              setMeta.mutate({
                id: workflow.id,
                name: name.trim(),
                description: description.trim() || null,
                isDefault,
              })
            }
          >
            {setMeta.isPending ? t('meta.saving') : t('meta.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
