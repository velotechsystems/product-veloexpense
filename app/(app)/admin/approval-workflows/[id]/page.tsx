import { permissions as P } from '@expenseos/rbac';
import { forbidden } from 'next/navigation';
import { pageTitle } from '@/lib/i18n/page-title';
import { requireActiveModule } from '@/server/platform/guard';
import { shellContext } from '@/server/shell';
import { WorkflowEditor } from './WorkflowEditor';

// VeloExpense: UD-16 — every route names itself (scripts/check-page-titles.mjs).
export function generateMetadata() {
  return pageTitle('title.admin.approval.workflow.editor');
}

/**
 * /admin/approval-workflows/[id] — the visual workflow editor. Requires
 * manage; authoring without it makes no sense.
 *
 * Ported from ExpenseOS (550b2945), w4-01. VeloExpense: the shell context and `forbidden()`,
 * as on the list page.
 */
export default async function WorkflowEditorPage({ params }: { params: Promise<{ id: string }> }) {
  const shell = await shellContext();
  if (!shell) forbidden();
  await requireActiveModule('expense-management');
  if (!shell.rbac.permissions.includes(P.admin.approvalWorkflow.manage)) forbidden();
  const { id } = await params;
  return <WorkflowEditor workflowId={id} />;
}
