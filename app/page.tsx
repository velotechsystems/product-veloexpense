/**
 * `/` — VeloExpense's home page until w4-09, when ExpenseOS's dashboard replaced it at
 * ExpenseOS's path, `/dashboard` (d72). The setup checklist it carried moved with it, as a
 * VeloExpense card above ExpenseOS's (`app/(app)/dashboard/SetupChecklist.tsx`).
 *
 * Kept as a redirect: sign-in lands here, and so do bookmarks and links already in mail.
 */
import { redirect } from 'next/navigation';
import { pageTitle } from '@/lib/i18n/page-title';

// UD-16: every route names itself (scripts/check-page-titles.mjs). Never rendered — the page
// redirects.
export function generateMetadata() {
  return pageTitle('title.home');
}

export default function HomePage(): never {
  redirect('/dashboard');
}
