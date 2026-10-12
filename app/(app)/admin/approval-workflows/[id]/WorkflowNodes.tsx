'use client';

import type { NodeType, WorkflowNode } from '@expenseos/approvals';
/**
 * Custom React Flow node renderer. A clean card: a type dot + label header and
 * a compact, read-only body (criteria pills). Editing happens in the right-hand
 * config panel — nodes are display-only here, and auto-size to their content.
 * Source handles:
 *   - approval → approve (left, green) + reject (right, red),
 *   - if → true/false; switch → case labels + default; parallel → one per
 *     branch; terminals → none; else one default exit.
 * Flow is top-down (target on top, source on bottom).
 */
import type { Locale } from '@expenseos/i18n/locales';
import { Handle, type NodeProps, Position } from '@xyflow/react';
import { CriteriaPills, type Criterion, PredicatePills, summarizePredicate } from './ConditionBar';
import { useEditorOptions } from './editor-context';
import type { RFNode } from './graph-rf';
import { APPROVER_KIND_LABEL, type EditorOptions, labelForValue } from './options';

export const TYPE_LABEL: Record<NodeType, string> = {
  start: 'Start',
  approved: 'Approved',
  rejected: 'Rejected',
  if: 'If',
  switch: 'Switch',
  parallel: 'Parallel',
  callWorkflow: 'Call workflow',
  approval: 'Approval',
  notify: 'Notify',
  acknowledge: 'Acknowledge',
  action: 'Action',
};

/** Palette groups for the add-node toolbar. */
export const NODE_PALETTE: { group: string; types: NodeType[] }[] = [
  { group: 'Routing', types: ['if', 'switch', 'parallel'] },
  { group: 'Approvals', types: ['approval', 'acknowledge'] },
  { group: 'Automation', types: ['notify', 'action'] },
  { group: 'Sub-flow', types: ['callWorkflow'] },
  { group: 'Terminals', types: ['approved', 'rejected'] },
];

/** Renders the two-way approve/reject exits. Acknowledge parks a task too but
 *  has a single outcome, so it uses a plain pass-through exit instead. */
const hasApproveRejectExits = (t: NodeType) => t === 'approval';

/** Type identity dot color. */
const DOT: Record<NodeType, string> = {
  start: 'bg-muted-foreground',
  approved: 'bg-success',
  rejected: 'bg-destructive',
  if: 'bg-accent-foreground',
  switch: 'bg-accent-foreground',
  parallel: 'bg-accent-foreground',
  callWorkflow: 'bg-primary',
  approval: 'bg-primary',
  notify: 'bg-warning',
  acknowledge: 'bg-primary',
  action: 'bg-accent-foreground',
};

/** Read-only criteria pills for the node body. */
function criteriaFor(
  node: WorkflowNode,
  options: EditorOptions | undefined,
  locale: Locale,
): Criterion[] {
  switch (node.type) {
    case 'approval':
    case 'acknowledge': {
      const a = node.approver;
      const roleLabel = node.type === 'acknowledge' ? 'Acknowledger' : 'Approver';
      const items: Criterion[] = [{ label: roleLabel, value: APPROVER_KIND_LABEL[a.kind] }];
      if (a.kind !== 'manager' && a.minJobLevelId) {
        items.push({
          label: 'Min level',
          value: labelForValue('jobLevelId', a.minJobLevelId, options, locale),
        });
      }
      if (a.kind === 'filter') {
        items.push({ label: 'Who', value: summarizePredicate(a.match, options, locale) });
      }
      return items;
    }
    case 'notify': {
      const NOTIFY_LABEL: Record<string, string> = {
        requester: 'the requester',
        manager: "the requester's manager",
        user: 'a user',
        role: 'a role',
      };
      return [{ label: 'Notify', value: NOTIFY_LABEL[node.target.kind] ?? node.target.kind }];
    }
    case 'action': {
      return node.actions.map((act) => ({
        label: 'Set',
        value: act.kind === 'setField' ? `${act.key} = ${String(act.value)}` : `→ ${act.hook}`,
      }));
    }
    case 'callWorkflow': {
      const name = options?.workflows.find((w) => w.key === node.workflowKey)?.name;
      return [
        node.workflowKey
          ? { label: '→', value: name ?? node.workflowKey }
          : { label: '→', value: 'pick a workflow', warn: true },
      ];
    }
    case 'parallel':
      return [
        {
          label: 'Join',
          value: node.join.kind === 'quorum' ? `quorum(${node.join.k})` : node.join.kind,
        },
      ];
    default:
      return [];
  }
}

function SourceHandle({
  id,
  left,
  label,
  tone,
}: {
  id?: string;
  left: string;
  label?: string;
  tone?: 'approve' | 'reject';
}) {
  const color =
    tone === 'approve'
      ? 'text-success'
      : tone === 'reject'
        ? 'text-destructive'
        : 'text-muted-foreground';
  return (
    <Handle
      id={id}
      type="source"
      position={Position.Bottom}
      style={{
        left,
        width: 11,
        height: 11,
        ...(tone === 'approve'
          ? { background: 'var(--color-success, #16a34a)' }
          : tone === 'reject'
            ? { background: 'var(--color-destructive, #dc2626)' }
            : {}),
      }}
    >
      {label && (
        <span
          className={`pointer-events-none absolute -bottom-4 left-0 -translate-x-1/2 whitespace-nowrap text-[9px] ${color}`}
        >
          {label}
        </span>
      )}
    </Handle>
  );
}

export function WorkflowNodeView({ data, selected }: NodeProps<RFNode>) {
  const node = data.node;
  const t = node.type;
  const { options, locale } = useEditorOptions();
  const hasTarget = t !== 'start';

  let handles: React.ReactNode = null;
  if (t === 'approved' || t === 'rejected') {
    handles = null;
  } else if (hasApproveRejectExits(t)) {
    handles = (
      <>
        <SourceHandle id="approve" left="30%" label="approve" tone="approve" />
        <SourceHandle id="reject" left="70%" label="reject" tone="reject" />
      </>
    );
  } else if (t === 'if') {
    handles = (
      <>
        <SourceHandle id="true" left="30%" label="true" />
        <SourceHandle id="false" left="70%" label="false" />
      </>
    );
  } else if (node.type === 'switch') {
    const all = [
      ...node.cases.map((c, i) => ({ id: c.id, label: c.label?.trim() || `Case ${i + 1}` })),
      { id: 'default', label: 'default' },
    ];
    handles = all.map((h, i) => (
      <SourceHandle
        key={h.id}
        id={h.id}
        left={`${((i + 1) / (all.length + 1)) * 100}%`}
        label={h.label}
      />
    ));
  } else {
    handles = <SourceHandle left="50%" />;
  }

  let body: React.ReactNode = null;
  if (node.type === 'if') {
    body = <PredicatePills value={node.predicate} options={options} locale={locale} />;
  } else if (node.type === 'switch') {
    // Each case in its own fieldset (label as a legend on the border line); the
    // conditions render as individual pills (bold field + operator + value).
    body = (
      <div className="mt-2 space-y-2">
        {node.cases.map((c, i) => (
          <fieldset key={c.id} className="rounded-md border border-border px-2 pt-0 pb-1.5">
            <legend className="px-1 font-bold text-[10px] text-foreground">
              {c.label?.trim() || `Case ${i + 1}`}
            </legend>
            <PredicatePills value={c.predicate} options={options} locale={locale} />
          </fieldset>
        ))}
      </div>
    );
  } else {
    const c = criteriaFor(node, options, locale);
    body = c.length > 0 ? <CriteriaPills items={c} /> : null;
  }

  return (
    // Auto-sizes to content (no manual resize) — grows as conditions/cases add.
    <div
      className={`flex w-max min-w-[200px] max-w-[300px] flex-col rounded-md border bg-card px-3 py-2 transition-shadow ${
        selected
          ? 'border-primary shadow-sm ring-2 ring-primary/40'
          : 'border-border shadow-sm hover:border-primary'
      }`}
    >
      {hasTarget && (
        <Handle type="target" position={Position.Top} style={{ width: 11, height: 11 }} />
      )}
      <div className="flex items-center gap-2">
        <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${DOT[t]}`} />
        <span className="font-medium text-foreground text-xs">{TYPE_LABEL[t]}</span>
      </div>
      {body}
      {handles}
    </div>
  );
}

export const nodeTypes = Object.fromEntries(
  (Object.keys(TYPE_LABEL) as NodeType[]).map((t) => [t, WorkflowNodeView]),
);
