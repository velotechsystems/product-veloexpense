/**
 * f26 — the caller's receipts address, for /preferences and the expense report list.
 *
 * Built for VeloExpense (ExpenseOS has no screen for this). The address itself is the
 * tenant's — see `lib/receipts/emailAddress.ts` for why, and why there is nothing secret in
 * it to rotate.
 *
 * ## Only ever the caller's own
 *
 * The procedure takes no input. The tenant is the one the caller's transaction runs as (the
 * `tenant` middleware's `app.current_org`), and the `sendFrom` it returns is the caller's own
 * sign-in email from the session — never a person id from the client — so there is no
 * argument with which to ask for somebody else's.
 *
 * ## Who is told
 *
 * Gated on `expense.report.createOwn`: an emailed receipt BECOMES a report the sender owns,
 * so somebody who cannot create one in the browser has no use for the address and would
 * only be told it works when it would refuse them.
 */
import { permissions as P } from '@expenseos/rbac';
import { queryRunnerOf } from '@/lib/db/prisma-pg-bridge';
import { receiptsEmailAddress } from '@/lib/receipts/emailAddress';
import { ORG } from '@/lib/tenant/sql';
import { router, withPermission } from '@/server/trpc';

export type ReceiptsEmailAnswer =
  | { address: string; sendFrom: string }
  | { address: null; reason: 'NOT_CONFIGURED' };

export const receiptsEmailRouter = router({
  mine: withPermission(P.expense.report.createOwn).query(
    async ({ ctx }): Promise<ReceiptsEmailAnswer> => {
      // `organization` has no tenant column and so no RLS policy: filtered by the tenant this
      // transaction runs as (`ORG`), or this would read every tenant's slug.
      const { rows } = await queryRunnerOf(ctx.db).query<{ slug: string }>(
        `SELECT slug FROM organization WHERE id = ${ORG}`,
      );
      const org = rows[0];
      const address = receiptsEmailAddress(org?.slug);
      const sendFrom = ctx.session.user.email ?? '';
      if (!address || !sendFrom) return { address: null, reason: 'NOT_CONFIGURED' };
      return { address, sendFrom };
    },
  ),
});
