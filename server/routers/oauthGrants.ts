/**
 * Connected applications — the OAuth grants people have given Claude connectors.
 *
 * Ported from VeloCRM `api/src/routes/oauthGrants.ts` (the person's own: list, revoke) and
 * `routes/oauthAdmin.ts` (the tenant's, for an admin) at 59fce1c, as tRPC procedures.
 *
 * VeloExpense (mcp-oauth):
 *   · A grant is a row (0080), so "connected" is a grant that has been activated (its client
 *     exchanged the code) and not revoked — VeloCRM derives it from distinct live refresh tokens.
 *   · Revoking ends the grant, and through it every access token at once (the token names its
 *     grant). VeloCRM revokes refresh tokens only, leaving the current access token working for
 *     up to 15 minutes.
 *   · VeloCRM's admin "approve / reject a pending client" has no equivalent: a client here is
 *     global and inert until a person consents, so there is nothing for an admin to approve.
 *     What an admin needs is to see who has connected what, and to end it — gated by the API
 *     key permissions, because it is the same question about the same kind of credential.
 */
import { permissions as P } from '@expenseos/rbac';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { revokeGrant } from '@/lib/mcpOauth/service';
import { protectedProcedure, router, withPermission } from '@/server/trpc';

const LIVE = { revokedAt: null, activatedAt: { not: null } } as const;

const GRANT_SELECT = {
  id: true,
  userId: true,
  scopes: true,
  activatedAt: true,
  lastUsedAt: true,
  client: { select: { clientName: true } },
} as const;

type Row = {
  id: string;
  userId: string;
  scopes: string[];
  activatedAt: Date | null;
  lastUsedAt: Date | null;
  client: { clientName: string };
};

const shape = (g: Row) => ({
  id: g.id,
  clientName: g.client.clientName,
  scopes: g.scopes,
  connectedAt: g.activatedAt,
  lastUsedAt: g.lastUsedAt,
});

export const oauthGrantsRouter = router({
  /** The caller's own connected applications (VeloCRM `GET /api/v1/oauth/grants`). */
  mine: protectedProcedure.query(async ({ ctx }) => {
    const rows = await ctx.db.mcpOauthGrant.findMany({
      where: { userId: ctx.rbac.id, ...LIVE },
      select: GRANT_SELECT,
      orderBy: { activatedAt: 'desc' },
    });
    return rows.map(shape);
  }),

  /** Disconnect one of the caller's own (VeloCRM `DELETE /api/v1/oauth/grants/:clientId`). */
  revokeMine: protectedProcedure.input(z.object({ grantId: z.string().uuid() })).mutation(async ({ ctx, input }) => {
    const g = await ctx.db.mcpOauthGrant.findFirst({
      where: { id: input.grantId, userId: ctx.rbac.id, revokedAt: null },
      select: { id: true },
    });
    if (!g) throw new TRPCError({ code: 'NOT_FOUND', message: 'oauthGrants.revokeMine: no live grant of yours by that id.' });
    const name = ctx.session.user.name ?? ctx.session.user.email;
    await revokeGrant(ctx.db, g.id, 'USER', { id: ctx.rbac.id, name });
    return { ok: true as const };
  }),

  /** Every connected application in the tenant, with who connected it. */
  all: withPermission(P.admin.apiKey.list).query(async ({ ctx }) => {
    const rows = await ctx.db.mcpOauthGrant.findMany({
      where: LIVE,
      select: GRANT_SELECT,
      orderBy: { activatedAt: 'desc' },
      take: 500,
    });
    const people = await ctx.db.user.findMany({
      where: { id: { in: [...new Set(rows.map((r) => r.userId))] } },
      select: { id: true, name: true, email: true },
    });
    const byId = new Map(people.map((p) => [p.id, p.name || p.email]));
    return rows.map((r) => ({ ...shape(r), person: byId.get(r.userId) ?? '' }));
  }),

  /** An admin ends somebody's connection. */
  revoke: withPermission(P.admin.apiKey.revoke).input(z.object({ grantId: z.string().uuid() })).mutation(async ({ ctx, input }) => {
    const name = ctx.session.user.name ?? ctx.session.user.email;
    const done = await revokeGrant(ctx.db, input.grantId, 'ADMIN', { id: ctx.rbac.id, name });
    if (!done) throw new TRPCError({ code: 'NOT_FOUND', message: 'oauthGrants.revoke: no live grant by that id.' });
    return { ok: true as const };
  }),
});
