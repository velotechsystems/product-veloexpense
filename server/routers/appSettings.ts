/**
 * Application-settings router — ExpenseOS's `appSettings`, as much of it as is ported.
 *
 * Ported from ExpenseOS `apps/web/src/server/routers/appSettings.ts` (550b2945).
 * ExpenseOS composes `jobLevels`, `fiscalYears` and `currencies` here; each arrives with
 * the Wave 1 item that ports its screen (job levels w1-04, fiscal years w1-05). This
 * starts with `currencies`, which the legal-entity drawer's currency picker reads.
 */
import { permissions as P } from '@expenseos/rbac';
import { router, withPermission } from '@/server/trpc';

// ── currencies (read-only) ────────────────────────────────────────
//
// Surfaced here (vs a standalone `currencies` router) because the
// Application Settings UI is the only consumer today — Organization
// reporting-currency picker and the Approval Threshold currency
// picker both bind to the same list. Promote when a second consumer
// shows up.
//
// VeloExpense: the shared `currency` table (migration 0001) is keyed by the ISO code and
// has an English name and minor units — no uuid, symbol, localized label or active flag.
// Every row is usable, so all are listed, and each is returned in ExpenseOS's shape: the
// code doubles as the id (it is the foreign key's value, prisma/schema.prisma), the name
// becomes `{ en }`, and there is no symbol.

const currencies = router({
  list: withPermission(P.config.policyRead).query(async ({ ctx }) => {
    const rows = await ctx.db.currency.findMany({
      select: { code: true, name: true, minorUnit: true },
      orderBy: { code: 'asc' },
    });
    return rows.map((c) => ({
      id: c.code,
      code: c.code,
      symbol: '',
      label: { en: c.name } as Record<string, string>,
      precision: c.minorUnit,
    }));
  }),
});

// ── Composite export ──────────────────────────────────────────────

export const appSettingsRouter = router({
  currencies,
});
