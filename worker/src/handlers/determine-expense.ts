import type { JobMap } from '@expenseos/jobs';
import { db } from '@/lib/db/prisma';
import { determineAndRebuild } from './lib/determine';

/**
 * Handler for `expense.determineExpense`. Re-reads an expense's WHOLE document
 * set and rebuilds it from one joint determination (rule 2).
 *
 * BEST-EFFORT, like every extraction path: the receipts and the expense are
 * already persisted by the upload flow, so a missing API key, a model error or an
 * unreadable file leaves the user's files and their expense exactly as they were.
 * A skip is logged with its reason rather than thrown — a business outcome is not
 * a queue failure, and retrying it would just repeat the same skip.
 *
 * Ported from ExpenseOS's `apps/worker/src/handlers/determine-expense.ts` (550b2945), Wave 3
 * (w3-02b). VeloExpense: runs inside the job's tenant scope (worker/src/main.ts).
 */
export async function handleDetermineExpense(
  data: JobMap['expense.determineExpense'],
): Promise<void> {
  const categories = await db.expenseCategory.findMany({
    where: { active: true },
    select: {
      id: true,
      label: true,
      itcGstHstRate: true,
      itcQstRate: true,
      pstRecoverable: true,
      acceptsTip: true,
      isMileage: true,
    },
  });

  try {
    const out = await determineAndRebuild(data.expenseId, categories);
    console.log(
      `[expense.determine] expense=${data.expenseId} → ${out.status}` +
        (out.reason ? ` (${out.reason})` : ''),
    );
  } catch (err) {
    console.warn(
      `[expense.determine] expense=${data.expenseId} failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}
