/**
 * /approvals — VeloExpense's own approver inbox until w4-05/w4-07 (d71), when ExpenseOS's
 * inbox replaced it at ExpenseOS's path, /expenses/approvals.
 *
 * Kept as a redirect, not deleted: bookmarks, the home page's old card and links already in
 * people's mail point here. `/approvals/delegations` is a page of its own and unaffected.
 */
import { redirect } from 'next/navigation';
import { pageTitle } from '@/lib/i18n/page-title';

// UD-16: every route names itself (scripts/check-page-titles.mjs). Never rendered —
// the page redirects.
export function generateMetadata() {
  return pageTitle('title.approvals');
}

export default function ApprovalsPage(): never {
  redirect('/expenses/approvals');
}
