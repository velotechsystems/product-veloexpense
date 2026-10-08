/**
 * pickers — lightweight server-side search for high-cardinality reference
 * entities (vendors, GL accounts, users) that back the design-system
 * `AsyncCombobox`. These replace the old "load the entire table into a
 * dropdown" options procedures that froze the browser.
 *
 * Each `search` returns at most `limit` rows and nothing until the query has
 * MIN_CHARS characters (the client also gates, but we enforce server-side so a
 * crafted call can't dump the table). Matching is case-insensitive substring,
 * mirroring the adminLookup / roles search pattern. `byId` resolves a single
 * row so a picker can show the label of an already-selected value without a
 * search (e.g. when editing an existing record).
 *
 * All procedures are `protectedProcedure`: this is non-sensitive reference data
 * already exposed to any authenticated user via the directory / coding options.
 *
 * Ported from ExpenseOS `apps/web/src/server/routers/pickers.ts` (550b2945).
 * VeloExpense:
 *   · GL accounts search VeloExpense's own chart (`gl_account`), and only POSTABLE
 *     accounts: the database refuses a heading account on a category
 *     (`gl_account_must_be_postable`), so offering one would be offering a refusal.
 *   · People have one name column (`display_name`), not first/last.
 *   · `vendors` is not ported: VeloExpense has no vendor list yet. It arrives with the
 *     screen that needs it. (`externalIdSources` arrived with business units, Wave 1.)
 */
import { z } from 'zod';
import { protectedProcedure, router } from '@/server/trpc';

/** Minimum characters before a search runs (kept in sync with AsyncCombobox). */
const MIN_CHARS = 3;

const searchInput = z.object({
  q: z.string().trim().max(200),
  limit: z.number().int().min(1).max(50).default(20),
});

const idInput = z.object({ id: z.string().uuid() });

/** Compose a person's display label (matches @/lib/format displayName).
 *  VeloExpense: one `name` column (`display_name`), so no first/last join. */
function personLabel(u: { name: string | null; email: string }): string {
  return u.name?.trim() || u.email;
}

/**
 * Label a result set so no two entries read the same.
 *
 * Five people in the seeded directory share a display name with somebody else — two real
 * `User` rows, one human, usually one from the directory sync and one from an import. The
 * picker rendered both as the same string, so choosing an approver meant guessing between
 * two identical lines (GA readiness report F41). Whether the duplicate rows should exist
 * at all is a data question (F37); the picker's job is to stop making the reader guess.
 *
 * Only the ambiguous entries get the qualifier, so the common case stays clean.
 */
function disambiguate<T extends { value: string; label: string }>(
  rows: T[],
  qualifierOf: (row: T) => string,
): T[] {
  const seen = new Map<string, number>();
  for (const r of rows) seen.set(r.label, (seen.get(r.label) ?? 0) + 1);
  return rows.map((r) =>
    (seen.get(r.label) ?? 0) > 1 ? { ...r, label: `${r.label} · ${qualifierOf(r)}` } : r,
  );
}

/** GL account label: "<number> · <name>" (either part may be empty). */
function glLabel(g: { number: string | null; name: string | null }): string {
  return [g.number, g.name].filter(Boolean).join(' · ');
}

export const pickersRouter = router({
  // ── GL accounts (VeloExpense: gl_account) ────────────────────────────────
  glAccounts: router({
    search: protectedProcedure.input(searchInput).query(async ({ ctx, input }) => {
      if (input.q.length < MIN_CHARS) return [];
      const rows = await ctx.db.glAccount.findMany({
        where: {
          isActive: true,
          isPostable: true,
          OR: [
            { name: { contains: input.q, mode: 'insensitive' } },
            { number: { contains: input.q, mode: 'insensitive' } },
          ],
        },
        select: { id: true, number: true, name: true },
        orderBy: [{ number: 'asc' }, { name: 'asc' }],
        take: input.limit,
      });
      return rows.map((g) => ({ value: g.id, label: glLabel(g) }));
    }),
    byId: protectedProcedure.input(idInput).query(async ({ ctx, input }) => {
      const g = await ctx.db.glAccount.findUnique({
        where: { id: input.id },
        select: { id: true, number: true, name: true },
      });
      return g ? { value: g.id, label: glLabel(g) } : null;
    }),
  }),

  // ── Users (active employees) ─────────────────────────────────────────────
  users: router({
    search: protectedProcedure.input(searchInput).query(async ({ ctx, input }) => {
      if (input.q.length < MIN_CHARS) return [];
      const rows = await ctx.db.user.findMany({
        where: {
          deletedAt: null,
          employeeStatus: 'ACTIVE',
          OR: [
            { name: { contains: input.q, mode: 'insensitive' } },
            { email: { contains: input.q, mode: 'insensitive' } },
          ],
        },
        select: { id: true, name: true, email: true },
        orderBy: [{ name: 'asc' }, { email: 'asc' }],
        take: input.limit,
      });
      // Two rows for one human read as one line repeated; the email is what tells them
      // apart, so it is shown on exactly the entries that need it.
      return disambiguate(
        rows.map((u) => ({ value: u.id, label: personLabel(u), email: u.email })),
        (u) => u.email,
      ).map(({ value, label }) => ({ value, label }));
    }),
    byId: protectedProcedure.input(idInput).query(async ({ ctx, input }) => {
      const u = await ctx.db.user.findUnique({
        where: { id: input.id },
        select: { id: true, name: true, email: true },
      });
      return u ? { value: u.id, label: personLabel(u) } : null;
    }),
  }),
  /**
   * The systems this tenant federates identifiers to — every active `ExternalIdSource`.
   *
   * Not a search: the list is a handful of rows and every external-id sub-form in the
   * product needs all of them at once. It lives here rather than on `users` because it
   * is not about users: `users.listFilterFacets` was the only way to reach it, so the
   * admin lookups fell back to a HARDCODED list of four system names — wrong in both
   * directions, offering systems a tenant does not use and unable to offer one they
   * had added.
   *
   * Ordered by code so the picker does not reshuffle between renders.
   */
  externalIdSources: protectedProcedure.query(async ({ ctx }) => {
    const rows = await ctx.db.externalIdSource.findMany({
      where: { active: true },
      select: { code: true, label: true },
      orderBy: { code: 'asc' },
    });
    return rows.map((r) => ({ code: r.code, label: r.label }));
  }),
});
