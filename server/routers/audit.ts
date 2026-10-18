/**
 * Audit trail — read surface, chain integrity verification, retention config
 * (Module 12, slice 1).
 *
 * The Audit table itself is append-only and hash-chained (`@expenseos/audit`);
 * nothing here writes business audit rows. What it adds is the ability to *look*
 * at them, to prove they haven't been edited, and to say how long they're kept.
 *
 * Module gate: deliberately NOT applied. Every other Compliance & Audit surface
 * gates on the `compliance-audit` module, but "the auditor can't read the audit
 * log because somebody switched a module off" is the wrong failure mode for the
 * one surface whose job is proving what happened. The RBAC gate is the control
 * here.
 *
 * w5-06 — ported from ExpenseOS `apps/web/src/server/routers/audit.ts` (1e682dd6). VeloExpense,
 * each marked below:
 *   · the rows are VeloExpense's per-tenant `audit_entry` chain (0010), read with tagged
 *     `$queryRaw` on the tenant's transaction (RLS: this tenant's chain only), where ExpenseOS
 *     reads its `Audit` Prisma model;
 *   · ORDER and CURSOR are `sequence`, the database-assigned chain order, where ExpenseOS uses
 *     its UUIDv7 id (0010 says why: a v7 is minted from the app's clock and can disagree with
 *     the order the chain records);
 *   · the verifier is VeloExpense's `lib/audit/verify.ts`, which already reconciles a purge
 *     from the tenant's own watermark (`organization.audit_purged_*`), where ExpenseOS's
 *     router re-runs its verifier against a SystemFlag watermark;
 *   · RETENTION IS READ-ONLY for now (decided 17 Oct 2026): the 7-year floor, shown on the
 *     screen. ExpenseOS's `retention` / `setRetention` arrive with the purge job that honours
 *     them (w5-07), stored per tenant — a setting nothing acts on would be a dead control.
 */
import { auditActions, withAudit } from '@expenseos/audit';
import { Prisma } from '@expenseos/db';
import { permissions as P } from '@expenseos/rbac';
import { z } from 'zod';
import { queryRunnerOf } from '@/lib/db/prisma-pg-bridge';
import { verifyChain } from '@/lib/audit/verify';
import { router, withPermission } from '@/server/trpc';

const auditReadProcedure = withPermission(P.audit.read);
const auditVerifyProcedure = withPermission(P.audit.chainVerify);

/** SOX. VeloExpense: the floor every tenant's chain is kept for (read-only until w5-07). */
export const DEFAULT_RETENTION_YEARS = 7;

/**
 * What the last purge removed, from the tenant's watermark. VeloExpense: the sequence it
 * purged through and that row's hash (0010) — the facts the verifier needs. ExpenseOS's
 * watermark also carries a count and a run time, which VeloExpense's purge (w5-07) will add.
 */
export interface PurgeWatermark {
  purgedThroughSequence: string;
  lastPurgedEntryHash: string;
}

const FILTER_FIELDS = ['actor', 'action', 'entityType', 'entityId', 'ipAddress', 'date'] as const;
const FILTER_OPS = ['contains', 'equals', 'doesNotEqual', 'startsWith', 'after', 'before'] as const;

const filterSchema = z.object({
  field: z.enum(FILTER_FIELDS),
  op: z.enum(FILTER_OPS),
  value: z.string().max(200),
});
export type AuditFilter = z.infer<typeof filterSchema>;

/** ExpenseOS's `AUDIT_SELECT`, as columns of `audit_entry`. VeloExpense: `actorRoleLabel` is
 *  `actor_role` (the role's label at the time), and the actor is a user OR an external email
 *  (`actor_email`), shown under the name. */
const AUDIT_COLUMNS = Prisma.sql`
  id::text AS "id", sequence::text AS "sequence", occurred_at AS "occurredAt",
  actor_id::text AS "actorId", actor_email AS "actorEmail", actor_name AS "actorName",
  actor_role AS "actorRoleLabel", action AS "action", entity_type AS "entityType",
  entity_id::text AS "entityId", details AS "details", host(ip_address) AS "ipAddress",
  user_agent AS "userAgent", request_id::text AS "requestId", prev_hash AS "prevHash",
  entry_hash AS "entryHash", expires_at AS "expiresAt"`;

export interface AuditRowOut {
  id: string;
  sequence: string;
  occurredAt: Date;
  actorId: string | null;
  actorEmail: string | null;
  actorName: string;
  actorRoleLabel: string | null;
  action: string;
  entityType: string | null;
  entityId: string | null;
  details: unknown;
  ipAddress: string | null;
  userAgent: string | null;
  requestId: string | null;
  prevHash: string | null;
  entryHash: string;
  expiresAt: Date | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `%` and `_` are LIKE's own; a person typing them means the character. */
function likeEscape(v: string): string {
  return v.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** Translate the UI's filter clauses into a Prisma where. Unknown combinations
 *  are dropped rather than approximated — a filter that silently means something
 *  else is worse than one that doesn't apply.
 *
 *  VeloExpense: SQL conditions on `audit_entry` rather than a Prisma where; the same
 *  clauses, the same drops. */
export function conditionsFromFilters(filters: readonly AuditFilter[]): Prisma.Sql[] {
  const and: Prisma.Sql[] = [];
  for (const f of filters) {
    const v = f.value.trim();
    if (v.length === 0 && f.op !== 'equals') continue;
    switch (f.field) {
      case 'actor':
        // Matches the snapshot name (which survives a deleted user) or the id,
        // so pasting a UUID from another screen works.
        if (f.op === 'equals') {
          and.push(
            UUID.test(v)
              ? Prisma.sql`(actor_id = ${v}::uuid OR actor_name = ${v})`
              : Prisma.sql`actor_name = ${v}`,
          );
        } else if (f.op === 'contains') {
          and.push(Prisma.sql`actor_name ILIKE ${`%${likeEscape(v)}%`}`);
        }
        break;
      case 'action':
        if (f.op === 'equals') and.push(Prisma.sql`action = ${v}`);
        else if (f.op === 'doesNotEqual') and.push(Prisma.sql`action <> ${v}`);
        else if (f.op === 'startsWith') and.push(Prisma.sql`action LIKE ${`${likeEscape(v)}%`}`);
        else if (f.op === 'contains') and.push(Prisma.sql`action ILIKE ${`%${likeEscape(v)}%`}`);
        break;
      case 'entityType':
        if (f.op === 'equals') and.push(Prisma.sql`entity_type = ${v}`);
        else if (f.op === 'doesNotEqual') {
          // Prisma's `{ not: v }` excludes NULL as well; said so explicitly here.
          and.push(Prisma.sql`entity_type IS NOT NULL AND entity_type <> ${v}`);
        }
        break;
      case 'entityId':
        // A uuid column can't take `contains`; a non-uuid value would throw, so
        // it's dropped instead.
        if (f.op === 'equals' && UUID.test(v)) and.push(Prisma.sql`entity_id = ${v}::uuid`);
        break;
      case 'ipAddress':
        if (f.op === 'equals') and.push(Prisma.sql`host(ip_address) = ${v}`);
        else if (f.op === 'contains') and.push(Prisma.sql`host(ip_address) LIKE ${`%${likeEscape(v)}%`}`);
        break;
      case 'date': {
        const d = new Date(v);
        if (Number.isNaN(d.getTime())) break;
        if (f.op === 'after') and.push(Prisma.sql`occurred_at >= ${d}`);
        else if (f.op === 'before') and.push(Prisma.sql`occurred_at < ${d}`);
        break;
      }
    }
  }
  return and;
}

/** `WHERE a AND b …`, or nothing. */
function whereOf(conditions: Prisma.Sql[]): Prisma.Sql {
  return conditions.length > 0 ? Prisma.sql`WHERE ${Prisma.join(conditions, ' AND ')}` : Prisma.empty;
}

export const auditRouter = router({
  /**
   * Cursor-paginated trail, newest first. Cursored on `id` (UUIDv7, so
   * time-sortable) rather than `occurredAt`: a burst of rows can share a
   * timestamp, and cursoring on a non-unique key drops or repeats rows at the
   * page seam.
   *
   * VeloExpense: cursored on `sequence` — unique and the chain's own order (see the header).
   */
  list: auditReadProcedure
    .input(
      z
        .object({
          limit: z.number().int().min(1).max(200).default(50),
          cursor: z.string().regex(/^\d+$/).nullish(),
          filters: z.array(filterSchema).max(20).optional(),
        })
        .optional(),
    )
    .query(async ({ ctx, input }) => {
      const limit = input?.limit ?? 50;
      const conditions = conditionsFromFilters(input?.filters ?? []);
      if (input?.cursor) conditions.push(Prisma.sql`sequence < ${input.cursor}::bigint`);
      const rows = await ctx.db.$queryRaw<AuditRowOut[]>`
        SELECT ${AUDIT_COLUMNS} FROM audit_entry ${whereOf(conditions)}
         ORDER BY audit_entry.sequence DESC LIMIT ${limit + 1}`;
      // `audit_entry.sequence`, qualified: the select list exposes `sequence` as TEXT, and an
      // unqualified ORDER BY binds to that output column — "9" sorts after "13". A test
      // caught it: the first page came back in string order.
      const hasMore = rows.length > limit;
      const items = hasMore ? rows.slice(0, limit) : rows;
      return { items, nextCursor: hasMore ? (items.at(-1)?.sequence ?? null) : null };
    }),

  /**
   * The distinct `action` and `entityType` values actually present, so the
   * filter dropdowns offer what the log contains instead of a hardcoded list
   * that drifts from `auditActions`.
   */
  facets: auditReadProcedure.query(async ({ ctx }) => {
    const [actions, entityTypes] = await Promise.all([
      ctx.db.$queryRaw<{ v: string }[]>`SELECT DISTINCT action AS v FROM audit_entry ORDER BY 1`,
      ctx.db.$queryRaw<{ v: string }[]>`
        SELECT DISTINCT entity_type AS v FROM audit_entry WHERE entity_type IS NOT NULL ORDER BY 1`,
    ]);
    return {
      actions: actions.map((a) => a.v),
      entityTypes: entityTypes.map((e) => e.v),
    };
  }),

  /** Header numbers: volume, the window covered, retention, and what the last
   *  purge removed. */
  stats: auditReadProcedure.query(async ({ ctx }) => {
    const [[span], [org]] = await Promise.all([
      ctx.db.$queryRaw<{ total: bigint; oldestAt: Date | null; newestAt: Date | null }[]>`
        SELECT count(*) AS total, min(occurred_at) AS "oldestAt", max(occurred_at) AS "newestAt"
          FROM audit_entry`,
      ctx.db.$queryRaw<{ through: string | null; hash: string | null }[]>`
        SELECT audit_purged_through_sequence::text AS through, audit_purged_head_hash AS hash
          FROM organization
         WHERE id = NULLIF(current_setting('app.current_org', true), '')::uuid`,
    ]);
    const lastPurge: PurgeWatermark | null =
      org?.through && org.hash
        ? { purgedThroughSequence: org.through, lastPurgedEntryHash: org.hash }
        : null;
    return {
      total: Number(span?.total ?? 0),
      oldestAt: span?.oldestAt ?? null,
      newestAt: span?.newestAt ?? null,
      retentionYears: DEFAULT_RETENTION_YEARS,
      lastPurge,
    };
  }),

  /**
   * Re-walk the hash chain and report the first row that doesn't reconcile.
   *
   * Windowed by default — a full walk of a multi-year log is a table scan, and
   * `verifyChainWindow` seeds `expectedPrev` from the row before the window, so
   * a window still proves integrity at its own boundary.
   *
   * The verification is itself audited: for SOX, "who checked, and when" is part
   * of the evidence.
   *
   * VeloExpense: windowed by `sequence`; `verifyChain` reads the tenant's purge watermark
   * itself, so `purgeAware` says whether the window began at a purged head.
   */
  verify: auditVerifyProcedure
    .input(
      z
        .object({
          fromSequence: z.string().regex(/^\d+$/).optional(),
          toSequence: z.string().regex(/^\d+$/).optional(),
          /** Verify only the most recent N days when no explicit window is given. */
          lastDays: z.number().int().min(1).max(3650).optional(),
        })
        .optional(),
    )
    .mutation(async ({ ctx, input }) => {
      let fromSequence = input?.fromSequence;
      if (!fromSequence && input?.lastDays) {
        const since = new Date(Date.now() - input.lastDays * 86_400_000);
        const [first] = await ctx.db.$queryRaw<{ s: string }[]>`
          SELECT sequence::text AS s FROM audit_entry
           WHERE occurred_at >= ${since} ORDER BY sequence ASC LIMIT 1`;
        fromSequence = first?.s;
        // No rows in the window — nothing to verify, and passing fromId
        // undefined would silently widen it to the whole table.
        if (!fromSequence) {
          return {
            ok: true as const,
            scanned: 0,
            firstSequence: null,
            lastSequence: null,
            purgeAware: false,
          };
        }
      }

      const tx = queryRunnerOf(ctx.db);
      const result = await verifyChain(tx, { fromSequence, toSequence: input?.toSequence });

      // A purge deletes the head of the chain, so the oldest surviving row's
      // prevHash references a row that's gone. VeloExpense: `verifyChain` already seeds
      // from the tenant's watermark when the window begins at the oldest surviving row, so
      // this only SAYS that it did.
      const [wm] = await ctx.db.$queryRaw<{ through: string | null }[]>`
        SELECT audit_purged_through_sequence::text AS through FROM organization
         WHERE id = NULLIF(current_setting('app.current_org', true), '')::uuid`;
      const [oldest] = await ctx.db.$queryRaw<{ s: string | null }[]>`
        SELECT min(sequence)::text AS s FROM audit_entry`;
      const purgeAware =
        wm?.through != null && (fromSequence === undefined || fromSequence === oldest?.s);

      await withAudit(
        ctx.db,
        {
          action: auditActions.audit.chainVerify,
          // VeloExpense: with no entity id, the writer keeps this in `details.entityType` —
          // the chain records an entity type only with an id (0010).
          entityType: 'Audit',
          actor: {
            kind: 'user',
            id: ctx.rbac.id,
            name: ctx.session.user.name || ctx.session.user.email || ctx.rbac.id,
            roleLabel: ctx.rbac.roleLabel,
          },
          details: {
            ok: result.ok,
            scanned: result.scanned,
            ...(result.ok ? {} : { reason: result.reason, at: result.at.id }),
            ...(purgeAware ? { purgeAware: true } : {}),
          },
        },
        async () => undefined,
      );

      return { ...result, purgeAware };
    }),
});
