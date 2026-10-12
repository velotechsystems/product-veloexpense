/**
 * Approval-workflow admin — CRUD + draft/publish versioning behind the visual
 * editor. A workflow has at most one editable DRAFT version; publishing freezes
 * it (PUBLISHED + immutable), points `currentVersionId` at it, and archives the
 * prior published version. The engine only ever runs `currentVersionId` when it
 * is PUBLISHED (see server/approvals/engine).
 *
 * VeloExpense: ExpenseOS's router (550b2945), w4-01 (d55: the editor lands before the
 * cutover, so until w4-00c these workflows are authored but the ladder still routes). The
 * plumbing, each marked below:
 *   · a workflow's `key` is unique within the tenant (0058), and RLS scopes every read;
 *   · a currency is keyed by its ISO code, and its symbol comes from the platform;
 *   · there is no vendor table (the `vendorId` field is a virtual-card fact anyway) and no
 *     role table: the roles offered are the ExpenseOS system roles VeloExpense's roles
 *     stand for (`systemRoleFor`), until the role builder (w4-10);
 *   · a person has one display name, carried in `firstName`;
 *   · subjects are VeloExpense's (`@/lib/approvalSubjects`).
 */

import { graphSchema, matchConditionSchema, validateGraph } from '@expenseos/approvals';
import { simulateWorkflow } from '@expenseos/approvals/engine';
import { auditActions, withAudit } from '@expenseos/audit';
import { permissions as P, SYSTEM_ROLE_IDS, SYSTEM_ROLE_LABELS } from '@expenseos/rbac';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { APPROVAL_SUBJECT_TYPES } from '@/lib/approvalSubjects';
import { currencySymbol } from '@/server/lib/currencySymbol';
import { router, withPermission } from '@/server/trpc';

/**
 * Gates both `simulate` and `create`, so a subject absent here is one no admin can
 * author a workflow for and no admin can simulate. It held two of the model's four
 * until the GA v2 audit — `@/lib/approvalSubjects` records what that cost and why the
 * list lives there rather than inline.
 */
const SUBJECT_TYPES = z.enum(APPROVAL_SUBJECT_TYPES);

/** A newly created workflow starts as a trivial auto-approve graph the author
 *  then fleshes out in the editor. */
const SEED_GRAPH = {
  nodes: [
    { id: 'start', type: 'start', position: { x: 240, y: 40 } },
    { id: 'approved', type: 'approved', position: { x: 240, y: 220 } },
  ],
  edges: [{ id: 'e1', source: 'start', target: 'approved' }],
} as const;

function actorOf(ctx: {
  rbac: { id: string; roleLabel: string };
  session: { user: { name?: string | null; email?: string | null } };
}) {
  return {
    kind: 'user' as const,
    id: ctx.rbac.id,
    name: ctx.session.user.name || ctx.session.user.email || ctx.rbac.id,
    roleLabel: ctx.rbac.roleLabel,
  };
}

const VERSION_SELECT = {
  id: true,
  version: true,
  status: true,
  publishedAt: true,
  matchCondition: true,
  graph: true,
  createdAt: true,
} as const;

/** Reject a save/publish whose graph fails structural validation. */
function assertValidGraph(graph: unknown) {
  const parsed = graphSchema.parse(graph);
  const issues = validateGraph(parsed);
  if (issues.length > 0) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `Invalid workflow graph: ${issues.map((i) => i.message).join('; ')}`,
    });
  }
  return parsed;
}

export const approvalWorkflowsRouter = router({
  /** Options for the editor's node-config pickers. */
  options: withPermission(P.admin.approvalWorkflow.manage).query(async ({ ctx }) => {
    const [
      jobLevels,
      departments,
      legalEntities,
      businessUnits,
      currencies,
      vendors,
      workflows,
      roles,
      categories,
      users,
    ] = await Promise.all([
      ctx.db.jobLevel.findMany({
        where: { active: true },
        select: { id: true, code: true, label: true, sortOrder: true },
        orderBy: { sortOrder: 'asc' },
      }),
      ctx.db.department.findMany({
        where: { active: true },
        select: { id: true, label: true },
        orderBy: { createdAt: 'asc' },
      }),
      ctx.db.legalEntity.findMany({
        where: { active: true },
        select: { id: true, label: true },
        orderBy: { createdAt: 'asc' },
      }),
      ctx.db.businessUnit.findMany({
        where: { active: true },
        select: { id: true, label: true },
        orderBy: { createdAt: 'asc' },
      }),
      // VeloExpense: a currency is its ISO code; the symbol comes from the platform.
      ctx.db.currency
        .findMany({ select: { code: true }, orderBy: { code: 'asc' } })
        .then((rows) => rows.map((c) => ({ id: c.code, code: c.code, symbol: currencySymbol(c.code) }))),
      // VeloExpense: no vendor table (and `vendorId` is a virtual-card fact).
      Promise.resolve([] as { id: string; name: string }[]),
      // Targets a CallWorkflow node can reference, keyed by `key`.
      ctx.db.approvalWorkflow.findMany({
        select: { key: true, name: true },
        orderBy: { name: 'asc' },
      }),
      // Roles a Notify node can target ("notify the AP team").
      // VeloExpense: no role table yet — the ExpenseOS system roles VeloExpense's roles stand
      // for (ADMIN → admin, EMPLOYEE and MANAGER → employee), until the role builder (w4-10).
      Promise.resolve(
        (['admin', 'employee'] as const).map((k) => ({ id: SYSTEM_ROLE_IDS[k], label: SYSTEM_ROLE_LABELS[k] })),
      ),
      // Categories an expense-report `categoryIds` condition selects from.
      ctx.db.expenseCategory.findMany({
        where: { active: true },
        select: { id: true, label: true },
        orderBy: { sortOrder: 'asc' },
      }),
      // People an approver's no-manager fallback can name. Active only: a
      // fallback is the last routing hop there is, so offering somebody who has
      // left would park the top of the org chart on a departed employee.
      // VeloExpense: one display name, carried in `firstName`.
      ctx.db.user
        .findMany({
          where: { deletedAt: null, employeeStatus: 'ACTIVE' },
          select: { id: true, name: true, email: true },
          orderBy: [{ name: 'asc' }, { email: 'asc' }],
        })
        .then((rows) => rows.map((u) => ({ id: u.id, firstName: u.name, lastName: null, email: u.email }))),
    ]);
    return {
      jobLevels,
      departments,
      legalEntities,
      businessUnits,
      currencies,
      vendors,
      workflows,
      roles,
      categories,
      users,
    };
  }),

  /** Dry-run: which workflow governs these facts + the approval steps it
   *  requires (assuming every step approves). Reflects PUBLISHED workflows. */
  simulate: withPermission(P.admin.approvalWorkflow.manage)
    .input(
      z.object({
        // VeloExpense: EXPENSE_REPORT is the default (ExpenseOS: VIRTUAL_CARD_REQUEST, not a
        // subject here).
        subjectType: SUBJECT_TYPES.default('EXPENSE_REPORT'),
        amount: z.number().nonnegative().optional(),
        // VeloExpense: a currency is its ISO code.
        currencyId: z.string().regex(/^[A-Z]{3}$/).optional(),
        departmentId: z.string().uuid().optional(),
        jobLevelId: z.string().uuid().optional(),
        legalEntityId: z.string().uuid().optional(),
        businessUnitId: z.string().uuid().optional(),
        // Expense-report-only facts (Phase 5). Booleans arrive as 'true'/'false'
        // to match how the engine emits them.
        categoryIds: z.array(z.string().uuid()).optional(),
        requiresApproval: z.enum(['true', 'false']).optional(),
        hasPolicyViolation: z.enum(['true', 'false']).optional(),
        overPerDiem: z.enum(['true', 'false']).optional(),
        lineCount: z.number().int().nonnegative().optional(),
        maxLineAmount: z.number().nonnegative().optional(),
        perDiemOverageMinor: z.number().nonnegative().optional(),
        overBudget: z.enum(['true', 'false']).optional(),
        budgetOverageMinor: z.number().nonnegative().optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      return simulateWorkflow(ctx.db, input.subjectType, {
        amount: input.amount ?? null,
        currency: input.currencyId ?? null,
        departmentId: input.departmentId ?? null,
        jobLevelId: input.jobLevelId ?? null,
        legalEntityId: input.legalEntityId ?? null,
        businessUnitId: input.businessUnitId ?? null,
        categoryIds: input.categoryIds ?? [],
        requiresApproval: input.requiresApproval ?? null,
        hasPolicyViolation: input.hasPolicyViolation ?? null,
        overPerDiem: input.overPerDiem ?? null,
        lineCount: input.lineCount ?? null,
        maxLineAmount: input.maxLineAmount ?? null,
        perDiemOverageMinor: input.perDiemOverageMinor ?? null,
        overBudget: input.overBudget ?? null,
        budgetOverageMinor: input.budgetOverageMinor ?? null,
      });
    }),

  list: withPermission(P.admin.approvalWorkflow.view).query(async ({ ctx }) => {
    const items = await ctx.db.approvalWorkflow.findMany({
      orderBy: [{ subjectType: 'asc' }, { isDefault: 'asc' }, { priority: 'desc' }],
      select: {
        id: true,
        key: true,
        name: true,
        description: true,
        subjectType: true,
        isDefault: true,
        priority: true,
        active: true,
        currentVersionId: true,
        versions: {
          select: { id: true, version: true, status: true },
          orderBy: { version: 'desc' },
        },
      },
    });
    return { items };
  }),

  get: withPermission(P.admin.approvalWorkflow.view)
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const wf = await ctx.db.approvalWorkflow.findUnique({
        where: { id: input.id },
        select: {
          id: true,
          key: true,
          name: true,
          description: true,
          subjectType: true,
          isDefault: true,
          priority: true,
          active: true,
          currentVersionId: true,
          versions: { select: VERSION_SELECT, orderBy: { version: 'desc' } },
        },
      });
      if (!wf) throw new TRPCError({ code: 'NOT_FOUND' });
      const draft = wf.versions.find((v) => v.status === 'DRAFT') ?? null;
      const published = wf.currentVersionId
        ? (wf.versions.find((v) => v.id === wf.currentVersionId) ?? null)
        : null;
      return { workflow: wf, draft, published };
    }),

  create: withPermission(P.admin.approvalWorkflow.manage)
    .input(
      z.object({
        key: z
          .string()
          .trim()
          .min(2)
          .max(64)
          .regex(/^[a-z0-9-]+$/, 'Lowercase letters, digits, and dashes only.'),
        name: z.string().trim().min(1).max(120),
        description: z.string().trim().max(500).optional(),
        // VeloExpense: EXPENSE_REPORT is the default (see `simulate`).
        subjectType: SUBJECT_TYPES.default('EXPENSE_REPORT'),
        priority: z.number().int().min(0).max(1000).default(0),
        isDefault: z.boolean().default(false),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // VeloExpense: `key` is unique within the tenant (0058); RLS scopes this read to it.
      const dupe = await ctx.db.approvalWorkflow.findFirst({
        where: { key: input.key },
        select: { id: true },
      });
      if (dupe)
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'That key is already in use.' });
      return withAudit(
        ctx.db,
        {
          action: auditActions.approvalWorkflow.create,
          entityType: 'ApprovalWorkflow',
          entityId: ctx.rbac.id,
          actor: actorOf(ctx),
          details: { key: input.key },
        },
        async (tx) => {
          const wf = await tx.approvalWorkflow.create({
            data: {
              key: input.key,
              name: input.name,
              description: input.description ?? null,
              subjectType: input.subjectType,
              priority: input.priority,
              isDefault: input.isDefault,
              createdBy: ctx.rbac.id,
            },
            select: { id: true },
          });
          await tx.approvalWorkflowVersion.create({
            data: {
              workflowId: wf.id,
              version: 1,
              matchCondition: { always: true },
              graph: SEED_GRAPH,
              status: 'DRAFT',
            },
          });
          return wf;
        },
      );
    }),

  setMeta: withPermission(P.admin.approvalWorkflow.manage)
    .input(
      z.object({
        id: z.string().uuid(),
        name: z.string().trim().min(1).max(120).optional(),
        description: z.string().trim().max(500).nullable().optional(),
        priority: z.number().int().min(0).max(1000).optional(),
        isDefault: z.boolean().optional(),
        active: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { id, ...patch } = input;
      return withAudit(
        ctx.db,
        {
          action: auditActions.approvalWorkflow.update,
          entityType: 'ApprovalWorkflow',
          entityId: id,
          actor: actorOf(ctx),
          details: {},
        },
        async (tx) =>
          tx.approvalWorkflow.update({
            where: { id },
            data: { ...patch, updatedBy: ctx.rbac.id },
            select: { id: true },
          }),
      );
    }),

  /** Reorder workflows by priority. `ids` is the desired order, highest
   *  priority first; the list view drives this via drag-and-drop. (The default
   *  catch-all always sorts last regardless, so it isn't included.) */
  reorder: withPermission(P.admin.approvalWorkflow.manage)
    .input(z.object({ ids: z.array(z.string().uuid()).min(1) }))
    .mutation(async ({ ctx, input }) => {
      const n = input.ids.length;
      await ctx.db.$transaction(
        input.ids.map((id, i) =>
          ctx.db.approvalWorkflow.update({
            where: { id },
            data: { priority: n - i, updatedBy: ctx.rbac.id },
            select: { id: true },
          }),
        ),
      );
      return { ok: true };
    }),

  /** Save the editable DRAFT graph + match condition (creating a DRAFT if the
   *  current version is published). Validates structure before persisting. */
  saveDraft: withPermission(P.admin.approvalWorkflow.manage)
    .input(
      z.object({
        workflowId: z.string().uuid(),
        graph: graphSchema,
        matchCondition: matchConditionSchema,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      assertValidGraph(input.graph);
      const existing = await ctx.db.approvalWorkflowVersion.findFirst({
        where: { workflowId: input.workflowId, status: 'DRAFT' },
        select: { id: true },
      });
      return withAudit(
        ctx.db,
        {
          action: auditActions.approvalWorkflow.saveDraft,
          entityType: 'ApprovalWorkflow',
          entityId: input.workflowId,
          actor: actorOf(ctx),
          details: {},
        },
        async (tx) => {
          if (existing) {
            return tx.approvalWorkflowVersion.update({
              where: { id: existing.id },
              data: { graph: input.graph, matchCondition: input.matchCondition },
              select: { id: true, version: true, status: true },
            });
          }
          const max = await tx.approvalWorkflowVersion.aggregate({
            where: { workflowId: input.workflowId },
            _max: { version: true },
          });
          return tx.approvalWorkflowVersion.create({
            data: {
              workflowId: input.workflowId,
              version: (max._max.version ?? 0) + 1,
              graph: input.graph,
              matchCondition: input.matchCondition,
              status: 'DRAFT',
            },
            select: { id: true, version: true, status: true },
          });
        },
      );
    }),

  /** Publish the DRAFT: freeze it, point currentVersionId at it, archive the
   *  prior published version. */
  publish: withPermission(P.admin.approvalWorkflow.manage)
    .input(z.object({ workflowId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const draft = await ctx.db.approvalWorkflowVersion.findFirst({
        where: { workflowId: input.workflowId, status: 'DRAFT' },
        select: { id: true, graph: true },
      });
      if (!draft) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'No draft to publish.' });
      }
      assertValidGraph(draft.graph);
      const wf = await ctx.db.approvalWorkflow.findUnique({
        where: { id: input.workflowId },
        select: { currentVersionId: true },
      });
      return withAudit(
        ctx.db,
        {
          action: auditActions.approvalWorkflow.publish,
          entityType: 'ApprovalWorkflow',
          entityId: input.workflowId,
          actor: actorOf(ctx),
          details: {},
        },
        async (tx) => {
          if (wf?.currentVersionId) {
            await tx.approvalWorkflowVersion.update({
              where: { id: wf.currentVersionId },
              data: { status: 'ARCHIVED' },
            });
          }
          await tx.approvalWorkflowVersion.update({
            where: { id: draft.id },
            data: { status: 'PUBLISHED', publishedAt: new Date(), publishedBy: ctx.rbac.id },
          });
          return tx.approvalWorkflow.update({
            where: { id: input.workflowId },
            data: { currentVersionId: draft.id, updatedBy: ctx.rbac.id },
            select: { id: true },
          });
        },
      );
    }),
});
