/**
 * Expense-category admin router (Module 4 — Expense management config).
 *
 * ExpenseCategory carries more than the generic admin-lookup shape (mapped GL
 * account, emoji icon, pill color, ITC recoverability rates, PST flag,
 * sortOrder) and has no external-id table, so it's a focused router rather than
 * an `adminLookupRouter` instance. Categories are deactivated (`active=false`),
 * never deleted, so there's no delete procedure.
 *
 * Ported from ExpenseOS `apps/web/src/server/routers/expenseCategories.ts` (550b2945).
 * VeloExpense: the NetSuite expense-category column and override (FR-6) are not ported —
 * VeloExpense codes to its own chart of accounts (`gl_account`) and has no NetSuite
 * category mirror. So `list` returns the categories without ExpenseOS's per-row NetSuite
 * cell or the override picker's options, `update` takes no `nsCategoryId`, and the screen
 * leaves out the column and the picker. Everything else is unchanged except where marked.
 */
import { auditActions, auditDiff, withAudit } from '@expenseos/audit';
import { permissions as P } from '@expenseos/rbac';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { ENABLED_LOCALES } from '@expenseos/i18n/locales';
import { router, withPermission } from '@/server/trpc';

/**
 * VeloExpense: the French name is optional while French is switched off (7 Oct) — the
 * screen does not ask for it (`ENABLED_LOCALES`). When French is switched on, this goes
 * back to ExpenseOS's `min(1)`. The database requires the English name either way
 * (migration 0045).
 */
const labelSchema = z
  .object({
    en: z.string().min(1).max(120),
    'fr-CA': z.string().min(1).max(120).optional(),
  })
  .refine((l) => !ENABLED_LOCALES.includes('fr-CA') || l['fr-CA'] !== undefined, {
    path: ['fr-CA'],
    message: 'Required',
  });

const CATEGORY_SELECT = {
  id: true,
  label: true,
  glAccountId: true,
  // Resolved in the same query — the display name no longer needs a number lookup.
  glAccount: { select: { name: true, number: true, isActive: true } },
  icon: true,
  color: true,
  itcGstHstRate: true,
  itcQstRate: true,
  pstRecoverable: true,
  requiresAttendees: true,
  acceptsTip: true,
  // Read-only in the admin, but surfaced so the list can SHOW which category is
  // the distance-based one — the mileage line editor only appears for it, and
  // with nothing naming it the whole feature looks absent.
  isMileage: true,
  active: true,
  sortOrder: true,
  // Whether anything has been filed against this category yet. Decides whether its
  // KIND can still change — see the `kind` field below.
  _count: { select: { lineItems: true } },
} as const;

/**
 * The fields `update` can change, read as they stood before the write, so the audit row
 * can record each change as `{ from, to }` (security MUST-3). The fields are here so
 * that a save of the whole form records only what actually changed. (VeloExpense: no
 * `nsCategoryId`; see the header.)
 */
const BEFORE_SELECT = {
  label: true,
  glAccountId: true,
  icon: true,
  color: true,
  itcGstHstRate: true,
  itcQstRate: true,
  pstRecoverable: true,
  requiresAttendees: true,
  isMileage: true,
  acceptsTip: true,
  sortOrder: true,
  active: true,
} as const;

/** `kind` → the two columns that encode it. The only place the mapping lives. */
function kindToColumns(kind: 'standard' | 'standard-with-tip' | 'mileage'): {
  isMileage: boolean;
  acceptsTip: boolean;
} {
  return {
    isMileage: kind === 'mileage',
    acceptsTip: kind === 'standard-with-tip',
  };
}

const writeFields = {
  label: labelSchema,
  /** The synced account, picked rather than typed. */
  glAccountId: z.string().uuid().nullish(),
  icon: z.string().max(16).nullish(),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'Use a #RRGGBB hex color')
    .nullish(),
  itcGstHstRate: z.number().int().min(0).max(100),
  itcQstRate: z.number().int().min(0).max(100),
  pstRecoverable: z.boolean(),
  /** Requires attendees on expenses coded to this category (meals/ent.). */
  requiresAttendees: z.boolean().optional(),
  /** Whether a line in this category may carry a tip. Restaurants and taxis do;
   *  a software subscription doesn't, and offering the field there is how bad
   *  data gets entered — which is why the line editor reads this flag rather
   *  than showing a tip everywhere.
   *
   *  `isMileage` is deliberately NOT writable here: it changes how a line's
   *  amount is DERIVED (km × rate instead of a typed figure), so flipping it on a
   *  category that already has filed lines would silently reinterpret them. */
  /**
   * What kind of line this category produces. One control, not two booleans, because
   * `isMileage` + `acceptsTip` together is incoherent: a mileage amount is DERIVED from
   * distance × rate, so there is no typed figure for a tip to sit beside.
   *
   *   standard            a typed amount
   *   standard-with-tip   a typed amount that may carry a voluntary tip
   *   mileage             an amount derived from distance
   *
   * `isMileage` used to be unwritable altogether, for a real reason: flipping it on a
   * category with filed lines silently reinterprets them. That reason only holds once
   * lines exist — so it is settable at CREATE (nothing is filed yet) and on update only
   * while the category has no line items, enforced below rather than trusted to the UI.
   */
  kind: z.enum(['standard', 'standard-with-tip', 'mileage']).optional(),
  // Display order is managed by drag-and-drop (see `reorder`), not the drawer;
  // omit on create to append to the end.
  sortOrder: z.number().int().min(0).optional(),
  active: z.boolean(),
};

function actorOf(ctx: {
  rbac: { id: string; roleLabel: string };
  session: { user: { name?: string | null; email?: string | null } };
}) {
  return {
    kind: 'user' as const,
    id: ctx.rbac.id,
    name: ctx.session.user.name ?? ctx.session.user.email ?? ctx.rbac.id,
    roleLabel: ctx.rbac.roleLabel,
  };
}

export const expenseCategoriesRouter = router({
  /**
   * All categories (including inactive) — the admin list.
   *
   * VeloExpense: ExpenseOS also resolves each row's NetSuite expense category here (FR-6)
   * and serves the override picker's options; neither is ported (see the header).
   */
  list: withPermission(P.admin.expenseCategory.list).query(async ({ ctx }) => {
    const cats = await ctx.db.expenseCategory.findMany({
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      select: CATEGORY_SELECT,
    });

    return {
      categories: cats.map(({ glAccount, ...c }) => ({
        ...c,
        // VeloExpense: ExpenseOS's model types `label` as `{ en, fr-CA }`; Prisma reads
        // the JSON column as `JsonValue`, so the shape is restated here for the screen.
        label: c.label as Record<string, string>,
        glAccount: glAccount
          ? { name: glAccount.name, number: glAccount.number, isActive: glAccount.isActive }
          : null,
        // Flattened for the list: the number to show and the name beside it. There is
        // no longer an "unresolved" third state — the legacy free-text number is gone,
        // and its drop migration refuses to run while any number is still unresolved,
        // so a category either references a real account or references none.
        glAccountNumber: glAccount?.number ?? null,
        glAccountName: glAccount?.name ?? null,
      })),
    };
  }),

  create: withPermission(P.admin.expenseCategory.create)
    .input(z.object(writeFields))
    .mutation(async ({ ctx, input }) =>
      withAudit(
        ctx.db,
        {
          action: auditActions.admin.expenseCategoryCreate,
          entityType: 'ExpenseCategory',
          actor: actorOf(ctx),
          details: { label: input.label },
        },
        async (tx) => {
          // New categories append to the end of the manual order unless an
          // explicit position is given.
          const sortOrder =
            input.sortOrder ??
            ((await tx.expenseCategory.aggregate({ _max: { sortOrder: true } }))._max.sortOrder ??
              -1) + 1;
          return tx.expenseCategory.create({
            data: {
              label: input.label,
              glAccountId: input.glAccountId ?? null,
              icon: input.icon ?? null,
              color: input.color ?? null,
              itcGstHstRate: input.itcGstHstRate,
              itcQstRate: input.itcQstRate,
              pstRecoverable: input.pstRecoverable,
              requiresAttendees: input.requiresAttendees ?? false,
              ...kindToColumns(input.kind ?? 'standard'),
              sortOrder,
              active: input.active,
            },
            select: CATEGORY_SELECT,
          });
        },
        (r) => (r as { id: string }).id,
      ),
    ),

  update: withPermission(P.admin.expenseCategory.update)
    .input(
      z
        .object({
          id: z.string().uuid(),
          // VeloExpense: no NetSuite override (`nsCategoryId`); see the header.
        })
        .merge(z.object(writeFields).partial()),
    )
    .mutation(async ({ ctx, input }) => {
      const { id, kind, ...rest } = input;
      /**
       * The row as it stood, for the audit diff and for the kind guard. It is read before
       * the transaction, like the other `auditDiff` callers in `expenses.ts`, because
       * `withAudit` takes its details up front.
       */
      const before = await ctx.db.expenseCategory.findUnique({
        where: { id },
        select: { ...BEFORE_SELECT, _count: { select: { lineItems: true } } },
      });
      if (!before) throw new TRPCError({ code: 'NOT_FOUND' });
      let kindColumns: { isMileage: boolean; acceptsTip: boolean } | undefined;
      if (kind) {
        kindColumns = kindToColumns(kind);
        /**
         * Crossing the mileage boundary re-defines how every line in this category
         * derives its amount — a typed figure becomes distance × rate, or the reverse.
         * Doing that to lines already filed would restate them without touching a
         * single row, so it is refused once any exist. Turning a tip on or off is not
         * guarded: it changes what the editor OFFERS from here on and reinterprets
         * nothing already stored.
         */
        if (kindColumns.isMileage !== before.isMileage && before._count.lineItems > 0) {
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message:
              `This category already has ${before._count.lineItems} line item(s), so it ` +
              'cannot change between mileage and a typed amount — that would restate what ' +
              'has already been filed. Create a new category instead.',
          });
        }
      }
      const data = { ...rest, ...(kindColumns ?? {}) };
      const { _count: _lineItems, ...beforeFields } = before;
      return withAudit(
        ctx.db,
        {
          action: auditActions.admin.expenseCategoryUpdate,
          entityType: 'ExpenseCategory',
          entityId: id,
          actor: actorOf(ctx),
          /**
           * Only what changed, each as `{ from, to }`, with `fields` still listing the
           * names (security MUST-3). It used to be `{ fields: Object.keys(data) }`, the keys
           * the form SENT. That named every field on each save and never gave a value, so
           * a change to what a line posts as could not be reconstructed.
           */
          details: auditDiff(beforeFields, data),
        },
        async (tx) => {
          // Undefined keys are omitted by Prisma (no change); an explicit null on
          // glAccount/icon/color clears the column.
          return tx.expenseCategory.update({ where: { id }, data, select: CATEGORY_SELECT });
        },
      );
    }),

  /** Persist the manual display order after a drag-and-drop reorder: each id's
   *  `sortOrder` becomes its position in `ids`. Ids are updated in one
   *  transaction; unknown ids are ignored. */
  reorder: withPermission(P.admin.expenseCategory.update)
    .input(z.object({ ids: z.array(z.string().uuid()).min(1) }))
    .mutation(async ({ ctx, input }) =>
      withAudit(
        ctx.db,
        {
          action: auditActions.admin.expenseCategoryUpdate,
          entityType: 'ExpenseCategory',
          actor: actorOf(ctx),
          details: { reordered: input.ids.length },
        },
        // withAudit already runs this inside a $transaction, so update rows
        // sequentially on the tx client. updateMany makes unknown ids a no-op.
        async (tx) => {
          for (let sortOrder = 0; sortOrder < input.ids.length; sortOrder++) {
            await tx.expenseCategory.updateMany({
              where: { id: input.ids[sortOrder] },
              data: { sortOrder },
            });
          }
        },
      ),
    ),
});
