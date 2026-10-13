/**
 * /approve — where an emailed approve or reject link used to land (VX2-8).
 *
 * VeloExpense (d62, 13 Oct 2026): approvals are decided on the report, signed in, never
 * from a link in an email. The single-use tokens those links carried are gone with their
 * table (0063), so an old link cannot say which report it was about; it opens the
 * approver's queue, where that report is waiting if it still needs them. `proxy.ts`
 * still lets the path through without a session, so the redirect is what a signed-out
 * reader meets first, and the queue then sends them to sign in and back. Since w4-05/w4-07
 * (d71) the queue is ExpenseOS's, at /expenses/approvals.
 */
import { redirect } from 'next/navigation';
import { pageTitle } from '@/lib/i18n/page-title';

// UD-16: every route names itself (scripts/check-page-titles.mjs). Never rendered —
// the page redirects.
export function generateMetadata() {
  return pageTitle('title.approve');
}

export default function ApprovePage(): never {
  redirect('/expenses/approvals');
}
