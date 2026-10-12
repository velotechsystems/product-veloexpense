/**
 * VX2-4a — /admin/approval-ladder, retired at the cutover (w4-00c, d50).
 *
 * Approvals run on ExpenseOS's workflow engine now, configured in the builder at
 * /admin/approval-workflows. This address is kept as a redirect so a bookmark, an old
 * email or the setup checklist of an older deploy still lands somewhere useful. The ladder's
 * tables, and this folder, go in w4-00d.
 */
import { redirect } from 'next/navigation';
import { pageTitle } from '@/lib/i18n/page-title';

// UD-16: every route names itself (scripts/check-page-titles.mjs), each with its own key. Never
// rendered — the page redirects — and gone with the route in w4-00d.
export function generateMetadata() {
  return pageTitle('title.admin.approval.ladder');
}

export default function ApprovalLadderPage(): never {
  redirect('/admin/approval-workflows');
}
