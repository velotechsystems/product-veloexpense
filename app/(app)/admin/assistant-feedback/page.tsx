import { ASSISTANT_MODULE_SLUG } from '@expenseos/assistant';
import { permissions as P } from '@expenseos/rbac';
import { forbidden } from 'next/navigation';
import { pageTitle } from '@/lib/i18n/page-title';
import { requireActiveModule } from '@/server/platform/guard';
import { shellContext } from '@/server/shell';
import { AssistantFeedbackAdmin } from './AssistantFeedbackAdmin';

// VeloExpense: UD-16 — every route names itself (scripts/check-page-titles.mjs).
export function generateMetadata() {
  return pageTitle('title.admin.assistant.feedback');
}

/**
 * /admin/assistant-feedback — the assistant's review queue.
 *
 * Gated on `admin.help.manage`, which already existed and was seeded to the admin role but had
 * no screen behind it, and on the assistant module: a workspace that has not installed the chat
 * has no feedback to review.
 *
 * Ported from ExpenseOS (1e682dd6). VeloExpense (w6-03): the session and `RbacUser` come from
 * the request's shell context (server/shell.ts), and a reader without the permission is refused
 * (`forbidden()`), as every VeloExpense admin screen refuses, where ExpenseOS answers 404. The
 * assistant is CORE in VeloExpense (d89), so the module gate always passes; it stays so the page
 * reads as ExpenseOS's does.
 */
export default async function AssistantFeedbackPage() {
  const shell = await shellContext();
  if (!shell) forbidden();
  await requireActiveModule(ASSISTANT_MODULE_SLUG);
  if (!shell.rbac.permissions.includes(P.admin.help.manage)) forbidden();
  return <AssistantFeedbackAdmin />;
}
