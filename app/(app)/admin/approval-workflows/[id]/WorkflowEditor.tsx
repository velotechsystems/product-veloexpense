'use client';

/**
 * Visual workflow editor (React Flow).
 *   - Top bar: breadcrumb + validation popover + History / Settings / Simulate /
 *     Save draft / Publish.
 *   - Left: node palette.   Center: full-width canvas.
 *   - Right: transient Drawers — node config (on select), Settings (workflow
 *     name/priority + trigger condition), History (version list, preview +
 *     restore-into-draft).
 */
import '@xyflow/react/dist/style.css';
import {
  graphSchema,
  type Predicate,
  type PredicateField,
  validateGraph,
  type WorkflowNode,
} from '@expenseos/approvals';
import {
  Badge,
  Button,
  Checkbox,
  Drawer,
  DrawerBody,
  DrawerContent,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  Field,
  Input,
  Textarea,
} from '@expenseos/design-system';
import type { Locale } from '@expenseos/i18n/locales';
import {
  IconBolt,
  IconChevronDown,
  IconChevronLeft,
  IconChevronRight,
  IconHistory,
  IconPencil,
  IconSettings,
  IconTrash,
} from '@tabler/icons-react';
import {
  addEdge,
  type Connection,
  Controls,
  MiniMap,
  ReactFlow,
  type ReactFlowInstance,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
} from '@xyflow/react';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from '@/i18n/navigation';
import type { ApprovalSubjectTypeValue } from '@/lib/approvalSubjects';
import { trpc } from '@/lib/trpc/client';
import { useTopBarSlots } from '../../../TopBar';
import { ConditionBar } from './ConditionBar';
import { EditorOptionsProvider } from './editor-context';
import { defaultNode, fromReactFlow, type RFEdge, type RFNode, toReactFlow } from './graph-rf';
import { NodeConfigPanel } from './NodeConfigPanel';
import { type EditorOptions, fieldsForSubject } from './options';
import { SimulatorDialog } from './SimulatorDialog';
import { NODE_PALETTE, nodeTypes, TYPE_LABEL } from './WorkflowNodes';

const MINIMAL = {
  nodes: [
    { id: 'start', type: 'start' as const, position: { x: 240, y: 40 } },
    { id: 'approved', type: 'approved' as const, position: { x: 240, y: 220 } },
  ],
  edges: [{ id: 'e1', source: 'start', target: 'approved' }],
};

type VersionRow = {
  id: string;
  version: number;
  status: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
  publishedAt: Date | null;
  createdAt: Date;
  matchCondition: unknown;
  graph: unknown;
};

export function WorkflowEditor({ workflowId }: { workflowId: string }) {
  const get = trpc.approvalWorkflows.get.useQuery({ id: workflowId });
  const options = trpc.approvalWorkflows.options.useQuery();
  const t = useTranslations('workflows');

  if (get.isLoading || !get.data) {
    return <p className="p-6 text-muted-foreground text-sm">{t('list.loading')}</p>;
  }
  const wf = get.data.workflow;
  const source = get.data.draft ?? get.data.published;
  const parsed = source ? graphSchema.safeParse(source.graph) : null;
  const initialGraph = parsed?.success ? parsed.data : MINIMAL;
  const initialMatch = (source?.matchCondition as Predicate | undefined) ?? { always: true };

  return (
    <EditorCanvas
      key={workflowId}
      workflowId={workflowId}
      // VeloExpense: `subject_type` is text under a CHECK (0058), not a Prisma enum.
      subjectType={wf.subjectType as ApprovalSubjectTypeValue}
      initialName={wf.name}
      initialDescription={wf.description}
      initialIsDefault={wf.isDefault}
      initialGraph={initialGraph}
      initialMatch={initialMatch}
      options={options.data}
      versions={wf.versions as VersionRow[]}
      currentVersionId={wf.currentVersionId}
    />
  );
}

function EditorCanvas({
  workflowId,
  subjectType,
  initialName,
  initialDescription,
  initialIsDefault,
  initialGraph,
  initialMatch,
  options,
  versions,
  currentVersionId,
}: {
  workflowId: string;
  subjectType: ApprovalSubjectTypeValue;
  initialName: string;
  initialDescription: string | null;
  initialIsDefault: boolean;
  initialGraph: ReturnType<typeof graphSchema.parse>;
  initialMatch: Predicate;
  options: EditorOptions | undefined;
  versions: VersionRow[];
  currentVersionId: string | null;
}) {
  const t = useTranslations('workflows');
  // Condition fields the engine actually populates for this subject (expense
  // reports have no vendor / spend-interval), used to scope every condition
  // builder + the simulator in this editor.
  const availableFields = useMemo(() => fieldsForSubject(subjectType), [subjectType]);
  const locale = useLocale() as Locale;
  const utils = trpc.useUtils();
  const initial = useMemo(() => toReactFlow(initialGraph), [initialGraph]);
  const [nodes, setNodes, onNodesChange] = useNodesState<RFNode>(initial.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<RFEdge>(initial.edges);
  const [matchCondition, setMatchCondition] = useState<Predicate>(initialMatch);
  const [name, setName] = useState(initialName);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(true);
  const [panelCollapsed, setPanelCollapsed] = useState(false);
  const [issuesOpen, setIssuesOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [simOpen, setSimOpen] = useState(false);
  const rf = useRef<ReactFlowInstance<RFNode, RFEdge> | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ versionId: string; version: number } | null>(null);
  const previewGraph = useMemo(() => {
    if (!preview) return null;
    const v = versions.find((x) => x.id === preview.versionId);
    const p = v ? graphSchema.safeParse(v.graph) : null;
    return p?.success ? toReactFlow(p.data) : null;
  }, [preview, versions]);

  const graph = useMemo(() => fromReactFlow(nodes, edges), [nodes, edges]);
  const issues = useMemo(() => {
    const p = graphSchema.safeParse(graph);
    return p.success
      ? validateGraph(p.data)
      : [{ code: 'schema', message: 'Invalid node config.' }];
  }, [graph]);

  const saveDraft = trpc.approvalWorkflows.saveDraft.useMutation({
    onError: (e) => setError(e.message),
  });
  const publish = trpc.approvalWorkflows.publish.useMutation({
    onError: (e) => setError(e.message),
  });
  const setMeta = trpc.approvalWorkflows.setMeta.useMutation({
    onError: (e) => setError(e.message),
  });

  const selectedNode = nodes.find((n) => n.id === selectedId)?.data.node ?? null;
  // Terminals have no config; everything else opens the right config panel.
  const PANEL_TYPES = ['if', 'switch', 'parallel', 'callWorkflow', 'approval'];
  const panelNode = selectedNode && PANEL_TYPES.includes(selectedNode.type) ? selectedNode : null;

  // Centre the selected node in the viewport (keeps it visible beside the panel)
  // and re-open a collapsed panel. Runs on selection change, not on every click.
  useEffect(() => {
    setPanelCollapsed(false);
    if (!selectedId || !rf.current) return;
    const n = rf.current.getNode(selectedId);
    if (!n) return;
    const w = n.measured?.width ?? n.width ?? 200;
    const h = n.measured?.height ?? n.height ?? 80;
    rf.current.setCenter(n.position.x + w / 2, n.position.y + h / 2, {
      zoom: rf.current.getViewport().zoom,
      duration: 250,
    });
  }, [selectedId]);

  const onConnect = (c: Connection) =>
    setEdges((eds) => addEdge({ ...c, id: `e-${crypto.randomUUID().slice(0, 8)}` }, eds));

  function addNode(type: WorkflowNode['type']) {
    const id = `n-${crypto.randomUUID().slice(0, 8)}`;
    setNodes((ns) => [
      ...ns,
      {
        id,
        type,
        position: { x: 240, y: 60 + ns.length * 90 },
        data: { node: defaultNode(type, id) },
      },
    ]);
    setSelectedId(id);
  }

  function updateNode(updated: WorkflowNode) {
    setNodes((ns) => ns.map((n) => (n.id === updated.id ? { ...n, data: { node: updated } } : n)));
  }
  function deleteNode(id: string) {
    setNodes((ns) => ns.filter((n) => n.id !== id));
    setEdges((es) => es.filter((e) => e.source !== id && e.target !== id));
    setSelectedId(null);
  }

  async function doSave(): Promise<boolean> {
    setError(null);
    try {
      await saveDraft.mutateAsync({ workflowId, graph, matchCondition });
      setSavedAt(new Date().toLocaleTimeString(locale));
      utils.approvalWorkflows.get.invalidate({ id: workflowId });
      return true;
    } catch {
      return false;
    }
  }
  async function doPublish() {
    if (issues.length > 0) return;
    if (!(await doSave())) return;
    await publish.mutateAsync({ workflowId });
    utils.approvalWorkflows.list.invalidate();
    utils.approvalWorkflows.get.invalidate({ id: workflowId });
  }

  /** Load a past version's graph + condition into the editable draft. */
  function restoreVersion(v: VersionRow) {
    const p = graphSchema.safeParse(v.graph);
    if (!p.success) return;
    const rf = toReactFlow(p.data);
    setNodes(rf.nodes);
    setEdges(rf.edges);
    setMatchCondition((v.matchCondition as Predicate | undefined) ?? { always: true });
    setPreview(null);
    setHistoryOpen(false);
    setSelectedId(null);
  }

  const renameWorkflow = (next: string) => {
    const v = next.trim();
    if (!v || v === name) return;
    setName(v);
    setMeta.mutate(
      { id: workflowId, name: v },
      {
        onSuccess: () => {
          utils.approvalWorkflows.get.invalidate({ id: workflowId });
          utils.approvalWorkflows.list.invalidate();
        },
      },
    );
  };

  const valid = issues.length === 0;
  const issuesKey = issues.map((i) => `${i.code}:${i.nodeId ?? ''}`).join('|');

  // The breadcrumb (workflow name — double-click to rename) and the action
  // buttons live in the global app TopBar, not a row beneath it. Handlers route
  // through a ref so the injected buttons always act on the latest graph state
  // even when the slot JSX isn't re-injected.
  const actionsRef = useRef({ doSave, doPublish, renameWorkflow });
  actionsRef.current = { doSave, doPublish, renameWorkflow };

  useTopBarSlots(
    () => ({
      left: (
        <nav className="flex min-w-0 items-center gap-1.5 text-sm">
          <Link
            href="/admin/approval-workflows"
            className="shrink-0 text-muted-foreground hover:text-foreground"
          >
            {t('breadcrumb.root')}
          </Link>
          <IconChevronRight size={14} className="shrink-0 text-muted-foreground" />
          <EditableName name={name} onRename={(v) => actionsRef.current.renameWorkflow(v)} />
        </nav>
      ),
      right: (
        <div className="flex items-center gap-2">
          {savedAt && (
            <span className="text-muted-foreground text-xs">
              {t('editor.savedAt', { time: savedAt })}
            </span>
          )}
          <Button size="sm" variant="ghost" onClick={() => setHistoryOpen(true)}>
            <IconHistory size={14} className="mr-1" />
            {t('history.title')}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setSettingsOpen(true)}>
            <IconSettings size={14} className="mr-1" />
            {t('settings.title')}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setSimOpen(true)}>
            <IconBolt size={14} className="mr-1" />
            {t('sim.title')}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={saveDraft.isPending}
            onClick={() => actionsRef.current.doSave()}
          >
            {saveDraft.isPending ? t('editor.saving') : t('editor.save')}
          </Button>
          <Button
            size="sm"
            disabled={publish.isPending || !valid}
            onClick={() => actionsRef.current.doPublish()}
          >
            {publish.isPending ? t('editor.publishing') : t('editor.publish')}
          </Button>
        </div>
      ),
    }),
    [name, valid, issuesKey, savedAt, saveDraft.isPending, publish.isPending],
  );

  return (
    // -m-4 cancels the app shell's main padding so the editor is flush with the
    // top bar and edges; the height adds back the 2rem of padding so the bottom
    // bar reaches the true bottom. bg-background keeps the surface white.
    <div className="-m-4 flex h-[calc(100%+2rem)] min-h-0 flex-col bg-background">
      {error && <p className="bg-destructive/10 px-3 py-1.5 text-destructive text-xs">{error}</p>}

      {/* Preview banner */}
      {preview && (
        <div className="flex shrink-0 items-center gap-3 border-warning/40 border-b bg-warning/10 px-3 py-1.5 text-xs">
          <span className="text-warning-foreground">
            {t('history.previewing', { version: preview.version })}
          </span>
          <div className="ml-auto flex items-center gap-2">
            <Button
              size="xs"
              onClick={() => {
                const v = versions.find((x) => x.id === preview.versionId);
                if (v) restoreVersion(v);
              }}
            >
              {t('history.restore')}
            </Button>
            <Button size="xs" variant="outline" onClick={() => setPreview(null)}>
              {t('history.exitPreview')}
            </Button>
          </div>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        {/* Palette — retractable accordion */}
        {!preview &&
          (paletteOpen ? (
            <aside className="flex w-52 shrink-0 flex-col border-border border-r bg-background">
              <div className="flex items-center justify-between border-border border-b px-3 py-2">
                <span className="font-medium text-foreground text-sm">{t('editor.nodes')}</span>
                <button
                  type="button"
                  aria-label={t('editor.collapse')}
                  className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                  onClick={() => setPaletteOpen(false)}
                >
                  <IconChevronLeft size={15} />
                </button>
              </div>
              <div className="min-h-0 flex-1 space-y-1 overflow-y-auto p-2">
                {NODE_PALETTE.map((g) => (
                  <PaletteGroup key={g.group} group={g.group} types={g.types} onAdd={addNode} />
                ))}
              </div>
            </aside>
          ) : (
            <button
              type="button"
              aria-label={t('editor.expand')}
              className="flex w-8 shrink-0 items-start justify-center border-border border-r pt-2 text-muted-foreground hover:bg-muted hover:text-foreground"
              onClick={() => setPaletteOpen(true)}
            >
              <IconChevronRight size={15} />
            </button>
          ))}

        {/* Canvas */}
        <div className="min-w-0 flex-1 bg-background">
          <EditorOptionsProvider value={{ options, locale, readOnly: !!preview, updateNode }}>
            <ReactFlowProvider>
              {preview && previewGraph ? (
                <ReactFlow
                  nodes={previewGraph.nodes}
                  edges={previewGraph.edges}
                  nodeTypes={nodeTypes}
                  nodesDraggable={false}
                  nodesConnectable={false}
                  elementsSelectable={false}
                  fitView
                  fitViewOptions={{ maxZoom: 1, padding: 0.25 }}
                  proOptions={{ hideAttribution: true }}
                >
                  <Controls showInteractive={false} />
                  <MiniMap pannable zoomable />
                </ReactFlow>
              ) : (
                <ReactFlow
                  nodes={nodes}
                  edges={edges}
                  nodeTypes={nodeTypes}
                  onInit={(inst) => {
                    rf.current = inst;
                  }}
                  onNodesChange={onNodesChange}
                  onEdgesChange={onEdgesChange}
                  onConnect={onConnect}
                  onNodeClick={(_, n) => setSelectedId(n.id)}
                  onPaneClick={() => setSelectedId(null)}
                  deleteKeyCode={['Backspace', 'Delete']}
                  fitView
                  fitViewOptions={{ maxZoom: 1, padding: 0.25 }}
                  minZoom={0.3}
                  maxZoom={1.5}
                  proOptions={{ hideAttribution: true }}
                >
                  <Controls />
                  <MiniMap pannable zoomable />
                </ReactFlow>
              )}
            </ReactFlowProvider>
          </EditorOptionsProvider>
        </div>

        {/* Node config — retractable inline panel (if/switch/parallel/callWorkflow) */}
        {panelNode &&
          (panelCollapsed ? (
            <button
              type="button"
              aria-label={t('editor.expand')}
              className="flex w-8 shrink-0 items-start justify-center border-border border-l pt-2 text-muted-foreground hover:bg-muted hover:text-foreground"
              onClick={() => setPanelCollapsed(false)}
            >
              <IconChevronLeft size={15} />
            </button>
          ) : (
            <aside className="flex w-96 shrink-0 flex-col border-border border-l bg-background">
              <div className="flex items-center justify-between border-border border-b px-3 py-2">
                <span className="font-medium text-foreground text-sm">
                  {TYPE_LABEL[panelNode.type]}
                </span>
                <div className="flex items-center gap-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    aria-label={t('editor.deleteNode')}
                    title={t('editor.deleteNode')}
                    className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                    onClick={() => deleteNode(panelNode.id)}
                  >
                    <IconTrash size={14} />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    aria-label={t('editor.collapse')}
                    onClick={() => setPanelCollapsed(true)}
                  >
                    <IconChevronRight size={15} />
                  </Button>
                </div>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto p-3">
                <NodeConfigPanel
                  node={panelNode}
                  options={options}
                  fields={availableFields}
                  locale={locale}
                  onChange={updateNode}
                />
              </div>
            </aside>
          ))}
      </div>

      {/* Bottom status drawer — validation issue counter; expands upward */}
      {!preview && (
        <div className="shrink-0 border-border border-t bg-background">
          {issuesOpen && (
            <div className="max-h-44 overflow-y-auto border-border border-b px-3 py-2">
              {valid ? (
                <p className="text-muted-foreground text-xs">{t('editor.allChecksPass')}</p>
              ) : (
                <ul className="space-y-1">
                  {issues.map((iss) => (
                    <li
                      key={`${iss.code}-${iss.nodeId ?? ''}-${iss.message}`}
                      className="text-destructive text-xs"
                    >
                      {iss.message}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          <button
            type="button"
            onClick={() => setIssuesOpen((o) => !o)}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-xs hover:bg-muted"
          >
            <span className={`h-2 w-2 rounded-full ${valid ? 'bg-success' : 'bg-warning'}`} />
            <span className="font-medium text-foreground">
              {valid ? t('editor.valid') : t('editor.issues', { count: issues.length })}
            </span>
            <IconChevronDown
              size={14}
              className={`ml-auto text-muted-foreground transition-transform ${
                issuesOpen ? 'rotate-180' : ''
              }`}
            />
          </button>
        </div>
      )}

      {/* Settings drawer */}
      <SettingsDrawer
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        workflowId={workflowId}
        name={name}
        onNameChange={setName}
        initialDescription={initialDescription}
        initialIsDefault={initialIsDefault}
        matchCondition={matchCondition}
        onMatchConditionChange={setMatchCondition}
        options={options}
        fields={availableFields}
        locale={locale}
        setMeta={setMeta}
        onSaved={() => {
          utils.approvalWorkflows.get.invalidate({ id: workflowId });
          utils.approvalWorkflows.list.invalidate();
        }}
        t={t}
      />

      {/* History drawer */}
      <Drawer open={historyOpen} dismissible onOpenChange={setHistoryOpen}>
        <DrawerContent width={420}>
          <DrawerHeader>
            <DrawerTitle>{t('history.title')}</DrawerTitle>
          </DrawerHeader>
          <DrawerBody className="space-y-2">
            {versions.map((v) => (
              <div
                key={v.id}
                className="flex items-center gap-2 rounded-md border border-border px-3 py-2"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="font-medium text-foreground text-sm">v{v.version}</span>
                    <HistoryStatus status={v.status} current={v.id === currentVersionId} t={t} />
                  </div>
                  <div className="text-[11px] text-muted-foreground">
                    {(v.publishedAt ?? v.createdAt).toLocaleDateString(locale)}
                  </div>
                </div>
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => {
                    setPreview({ versionId: v.id, version: v.version });
                    setHistoryOpen(false);
                  }}
                >
                  {t('history.preview')}
                </Button>
                <Button size="xs" variant="outline" onClick={() => restoreVersion(v)}>
                  {t('history.restore')}
                </Button>
              </div>
            ))}
          </DrawerBody>
        </DrawerContent>
      </Drawer>

      {simOpen && (
        <SimulatorDialog
          subjectType={subjectType}
          options={options}
          locale={locale}
          onClose={() => setSimOpen(false)}
        />
      )}
    </div>
  );
}

/** One collapsible palette group (accordion section). */
function PaletteGroup({
  group,
  types,
  onAdd,
}: {
  group: string;
  types: WorkflowNode['type'][];
  onAdd: (t: WorkflowNode['type']) => void;
}) {
  const [open, setOpen] = useState(true);
  return (
    /**
     * THE VERTICAL RHYTHM IS LOAD-BEARING — 8px, not 4px, in both gaps.
     *
     * These buttons are `size="sm"` (36px) and carry `einc-tap-slop`, which reaches 4px past
     * the box top and bottom to make a 44px tap target. On the old 4px rhythm the slop ate
     * the gap from both sides: consecutive buttons' hit regions overlapped by 191x4px, and —
     * worse — the first button's upward slop took the bottom 4px of the section header above
     * it, which is only 23px tall, so three of that header's nine interior points resolved to
     * the button. On a phone, tapping the bottom of "Routing" inserted an `If` node.
     *
     * The remedy is R3 (fix the container, never the slop recipe): 8px on the header/stack gap
     * and 8px between buttons, so 4px of slop each side meets 8px of gutter and the regions
     * end tangent instead of overlapping. Tighten either back to `space-y-1` and
     * `e2e/tap-targets.mobile.spec.ts`'s R1 pass goes red on this route.
     *
     * VeloExpense: the kit's `sm` is 28px, not 36, so its slop reaches 8px each side and this
     * 8px rhythm would overlap by 8px. Found when the kit Button gained ExpenseOS's slop
     * classes (the R1 pass went red on exactly these five pairs). The buttons take `h-9` —
     * ExpenseOS's 36px, the height this rhythm is computed against — rather than the gap
     * growing to 16px: the palette keeps ExpenseOS's look, and the regions end tangent again.
     */
    <div className="space-y-2">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between rounded px-1 py-1 font-medium text-[10px] text-muted-foreground uppercase hover:text-foreground"
      >
        <span>{group}</span>
        <IconChevronDown size={12} className={open ? '' : '-rotate-90'} />
      </button>
      {open && (
        <div className="space-y-2 pb-1">
          {types.map((type) => (
            <Button
              key={type}
              size="sm"
              variant="outline"
              // VeloExpense: `h-9`, ExpenseOS's `sm` height — see the rhythm note above.
              className="h-9 w-full justify-start"
              onClick={() => onAdd(type)}
            >
              {TYPE_LABEL[type]}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Breadcrumb leaf: the workflow name, double-click to rename inline. */
function EditableName({ name, onRename }: { name: string; onRename: (v: string) => void }) {
  const t = useTranslations('workflows');
  const [editing, setEditing] = useState(false);
  if (editing) {
    return (
      <input
        // biome-ignore lint/a11y/noAutofocus: inline rename, focus is expected
        autoFocus
        defaultValue={name}
        onBlur={(e) => {
          onRename(e.target.value);
          setEditing(false);
        }}
        onKeyDown={(e) => {
          const el = e.target as HTMLInputElement;
          if (e.key === 'Enter') el.blur();
          if (e.key === 'Escape') {
            el.value = name;
            el.blur();
          }
        }}
        className="h-7 w-56 rounded border border-input bg-card px-2 font-semibold text-base text-foreground outline-none focus:ring-2 focus:ring-ring"
      />
    );
  }
  return (
    <span className="flex min-w-0 items-center gap-1">
      <button
        type="button"
        onDoubleClick={() => setEditing(true)}
        title={t('renameHint')}
        className="truncate font-semibold text-base text-foreground"
      >
        {name}
      </button>
      <button
        type="button"
        onClick={() => setEditing(true)}
        aria-label={t('renameAria')}
        className="shrink-0 text-muted-foreground hover:text-foreground"
      >
        <IconPencil size={14} />
      </button>
    </span>
  );
}

function HistoryStatus({
  status,
  current,
  t,
}: {
  status: VersionRow['status'];
  current: boolean;
  t: ReturnType<typeof useTranslations>;
}) {
  if (current) return <Badge variant="success">{t('history.current')}</Badge>;
  if (status === 'DRAFT') return <Badge variant="warning">{t('status.draft')}</Badge>;
  if (status === 'PUBLISHED') return <Badge>{t('status.published')}</Badge>;
  return <Badge variant="secondary">{t('status.archived')}</Badge>;
}

/** Workflow settings drawer — name / description / default + the trigger
 *  condition. Metadata saves via setMeta from the footer (the single
 *  confirmation, pinned to the bottom); the trigger condition rides along with
 *  the draft graph (main Save draft). Priority is set by drag-ordering on the
 *  list view, not here. */
function SettingsDrawer({
  open,
  onOpenChange,
  workflowId,
  name,
  onNameChange,
  initialDescription,
  initialIsDefault,
  matchCondition,
  onMatchConditionChange,
  options,
  fields,
  locale,
  setMeta,
  onSaved,
  t,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workflowId: string;
  name: string;
  onNameChange: (v: string) => void;
  initialDescription: string | null;
  initialIsDefault: boolean;
  matchCondition: Predicate;
  onMatchConditionChange: (p: Predicate) => void;
  options: EditorOptions | undefined;
  fields: PredicateField[];
  locale: Locale;
  setMeta: ReturnType<typeof trpc.approvalWorkflows.setMeta.useMutation>;
  onSaved: () => void;
  t: ReturnType<typeof useTranslations>;
}) {
  const [description, setDescription] = useState(initialDescription ?? '');
  const [isDefault, setIsDefault] = useState(initialIsDefault);

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent width={460} resizable storageKey="workflow-settings">
        <DrawerHeader>
          <DrawerTitle>{t('settings.title')}</DrawerTitle>
        </DrawerHeader>
        <DrawerBody className="space-y-5">
          <Field label={t('create.name')}>
            <Input value={name} onChange={(e) => onNameChange(e.target.value)} />
          </Field>
          <Field label={t('create.description')}>
            <Textarea
              value={description}
              rows={2}
              onChange={(e) => setDescription(e.target.value)}
            />
          </Field>
          <label htmlFor="wf-isDefault" className="flex items-center gap-2 text-foreground text-sm">
            <Checkbox
              id="wf-isDefault"
              checked={isDefault}
              onCheckedChange={(c) => {
                const next = c === true;
                setIsDefault(next);
                // A catch-all has no trigger condition — it always applies.
                if (next) onMatchConditionChange({ always: true });
              }}
            />
            {t('create.isDefault')}
          </label>
          {/* The trigger condition is irrelevant for a catch-all default. */}
          {isDefault ? (
            <p className="text-[11px] text-muted-foreground">{t('settings.defaultNote')}</p>
          ) : (
            <div>
              <h4 className="mb-1.5 font-medium text-foreground text-xs uppercase">
                {t('settings.trigger')}
              </h4>
              <p className="mb-2 text-[11px] text-muted-foreground">{t('settings.triggerHint')}</p>
              <ConditionBar
                value={matchCondition}
                onChange={onMatchConditionChange}
                options={options}
                fields={fields}
                locale={locale}
              />
              <p className="mt-2 text-[10px] text-muted-foreground">
                {t('settings.savedWithDraft')}
              </p>
            </div>
          )}
        </DrawerBody>
        <DrawerFooter>
          <Button size="sm" variant="outline" onClick={() => onOpenChange(false)}>
            {t('editor.done')}
          </Button>
          <Button
            size="sm"
            disabled={setMeta.isPending}
            onClick={async () => {
              await setMeta.mutateAsync({
                id: workflowId,
                name,
                description: description.trim() || null,
                isDefault,
              });
              onSaved();
            }}
          >
            {setMeta.isPending ? t('meta.saving') : t('settings.saveDetails')}
          </Button>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}
