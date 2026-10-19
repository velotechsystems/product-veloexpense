/**
 * Travel-category admin router (Module 6 — Travel).
 *
 * A focused router rather than an `adminLookupRouter` instance, for the same reason
 * `expenseCategories` is one: the model carries more than the generic lookup shape —
 * an emoji icon, a pill color, a `lineKind`, a mapping to the expense taxonomy and an
 * optional GL account. Categories are deactivated (`active=false`), never deleted, so
 * there is no delete procedure: a filed estimate must keep saying what it said.
 *
 * The two fields worth understanding before editing one:
 *
 *   · `lineKind` decides which EDITOR BLOCK a budget line in this category opens, and
 *     therefore which payload it carries. Changing it on a category that already has
 *     lines would leave those lines holding a payload their new block cannot read, so
 *     it is refused once any exist — the same rule, for the same reason, that stops an
 *     expense category crossing the mileage boundary after lines are filed.
 *   · `expenseCategoryId` is what lets a generated report code its lines and what lets
 *     budget-vs-actual compare the two sides. Clearing it does not break an estimate,
 *     but it does make one unreconcilable, which is why the list surfaces it.
 */
import { auditActions, withAudit } from '@expenseos/audit';
import { permissions as P } from '@expenseos/rbac';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { router, withPermission } from '@/server/trpc';

const labelSchema = z.object({
  en: z.string().min(1).max(120),
  'fr-CA': z.string().min(1).max(120),
});

const LINE_KINDS = [
  'STANDARD',
  'AIRFARE',
  'LODGING',
  'DEPARTMENT_MEAL',
  'CAR_RENTAL',
  'GROUND',
] as const;

const CATEGORY_SELECT = {
  id: true,
  code: true,
  label: true,
  icon: true,
  color: true,
  lineKind: true,
  active: true,
  sortOrder: true,
  expenseCategoryId: true,
  // Both sides of the GL question in one query: the category's own account, and the
  // one it would inherit from its mapped expense category when it has none.
  glAccountId: true,
  glAccount: { select: { name: true, number: true, isActive: true } },
  expenseCategory: {
    select: { id: true, label: true, glAccount: { select: { name: true, number: true } } },
  },
  // Whether anything has been estimated against this category yet. Decides whether
  // its `lineKind` can still change.
  _count: { select: { budgetLines: true } },
} as const;

const writeFields = {
  label: labelSchema,
  icon: z.string().max(16).nullish(),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'Use a #RRGGBB hex color')
    .nullish(),
  /** Which editor block a line here opens. Guarded on update — see the module note. */
  lineKind: z.enum(LINE_KINDS).optional(),
  /** The expense category this maps to. Null is allowed and means "estimable, but no
   *  actuals to compare against" — a state the admin list makes visible. */
  expenseCategoryId: z.string().uuid().nullish(),
  /** Its own GL account. Null inherits the mapped expense category's, which is the
   *  normal case: a mapped category should declare it in one place. */
  glAccountId: z.string().uuid().nullish(),
  // Display order is managed by drag-and-drop (`reorder`), not the drawer; omit on
  // create to append to the end.
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

export const travelCategoriesRouter = router({
  /** Every category, inactive included — this is the admin list, and an inactive row
   *  is exactly what somebody comes here to re-activate. */
  list: withPermission(P.admin.travelCategory.list).query(async ({ ctx }) => {
    const cats = await ctx.db.travelCategory.findMany({
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      select: CATEGORY_SELECT,
    });
    return cats.map((c) => ({
      ...c,
      // Flattened for the list: what the line will actually stamp, and where it came
      // from. Showing only the category's own column would render the ordinary case
      // (null, inherited) as "no GL account", which is wrong and alarming.
      effectiveGlAccountNumber: c.glAccount?.number ?? c.expenseCategory?.glAccount?.number ?? null,
      effectiveGlAccountName: c.glAccount?.name ?? c.expenseCategory?.glAccount?.name ?? null,
      glAccountInherited: c.glAccountId == null && c.expenseCategory?.glAccount != null,
    }));
  }),

  /** The expense categories a travel category can be mapped to — the picker's source.
   *  Active only: mapping to a retired category produces lines a report cannot file. */
  expenseCategoryOptions: withPermission(P.admin.travelCategory.list).query(async ({ ctx }) => {
    const items = await ctx.db.expenseCategory.findMany({
      where: { active: true },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      select: { id: true, code: true, label: true, icon: true },
    });
    return { items };
  }),

  create: withPermission(P.admin.travelCategory.create)
    .input(z.object(writeFields))
    .mutation(async ({ ctx, input }) =>
      withAudit(
        ctx.db,
        {
          action: auditActions.admin.travelCategoryCreate,
          entityType: 'TravelCategory',
          actor: actorOf(ctx),
          details: { label: input.label, lineKind: input.lineKind ?? 'STANDARD' },
        },
        async (tx) => {
          // Appends to the end of the manual order unless a position is given.
          const sortOrder =
            input.sortOrder ??
            ((await tx.travelCategory.aggregate({ _max: { sortOrder: true } }))._max.sortOrder ??
              -1) + 1;
          return tx.travelCategory.create({
            data: {
              // `code` is deliberately NOT settable: it is the seed's identity for a
              // row, and a hand-made category needs none (nulls do not collide).
              label: input.label,
              icon: input.icon ?? null,
              color: input.color ?? null,
              lineKind: input.lineKind ?? 'STANDARD',
              expenseCategoryId: input.expenseCategoryId ?? null,
              glAccountId: input.glAccountId ?? null,
              sortOrder,
              active: input.active,
            },
            select: CATEGORY_SELECT,
          });
        },
        (r) => (r as { id: string }).id,
      ),
    ),

  update: withPermission(P.admin.travelCategory.update)
    .input(z.object({ id: z.string().uuid() }).merge(z.object(writeFields).partial()))
    .mutation(async ({ ctx, input }) => {
      const { id, ...data } = input;
      if (data.lineKind) {
        const current = await ctx.db.travelCategory.findUnique({
          where: { id },
          select: { lineKind: true, _count: { select: { budgetLines: true } } },
        });
        if (!current) throw new TRPCError({ code: 'NOT_FOUND' });
        /**
         * Changing the block re-defines what a line in this category IS, and every
         * line already written carries a payload shaped for the old one. An airfare
         * line holding a flight number would be handed to the ground-transport block,
         * which has no field for it — so the payload becomes unreadable rather than
         * merely stale. Refused once any line exists; a new category is the answer.
         */
        if (data.lineKind !== current.lineKind && current._count.budgetLines > 0) {
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message:
              `This category already has ${current._count.budgetLines} budget line(s), so its ` +
              'type cannot change — those lines carry fields the new type cannot read. ' +
              'Create a new category instead.',
          });
        }
      }
      return withAudit(
        ctx.db,
        {
          action: auditActions.admin.travelCategoryUpdate,
          entityType: 'TravelCategory',
          entityId: id,
          actor: actorOf(ctx),
          details: { fields: Object.keys(data) },
        },
        // Undefined keys are omitted by Prisma (no change); an explicit null on
        // icon/color/expenseCategoryId/glAccountId clears the column.
        (tx) => tx.travelCategory.update({ where: { id }, data, select: CATEGORY_SELECT }),
      );
    }),

  /** Persist the manual display order after a drag-and-drop reorder: each id's
   *  `sortOrder` becomes its position in `ids`. One transaction; unknown ids are
   *  ignored, which is what makes a stale client list harmless rather than fatal. */
  reorder: withPermission(P.admin.travelCategory.update)
    .input(z.object({ ids: z.array(z.string().uuid()).min(1) }))
    .mutation(async ({ ctx, input }) =>
      withAudit(
        ctx.db,
        {
          action: auditActions.admin.travelCategoryUpdate,
          entityType: 'TravelCategory',
          actor: actorOf(ctx),
          details: { reordered: input.ids.length },
        },
        async (tx) => {
          for (let sortOrder = 0; sortOrder < input.ids.length; sortOrder++) {
            await tx.travelCategory.updateMany({
              where: { id: input.ids[sortOrder] },
              data: { sortOrder },
            });
          }
        },
      ),
    ),
});
