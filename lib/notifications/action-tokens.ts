/**
 * VX2-8 — approve-link tokens: single-use, expiring credentials embedded in an
 * email so an approver can decide without signing in.
 *
 * Ported from ExpenseOS `packages/notifications/src/actionTokens.ts` (GAP-AUDIT
 * NT-17). Their header carries the sentence that makes the whole feature safe,
 * and it is the first thing to understand here:
 *
 *   "The token only authenticates the actor and binds one action to one task; the
 *    caller still re-runs canDecide + the atomic claim, so it never bypasses
 *    authorization."
 *
 * SO A TOKEN AUTHENTICATES. IT DOES NOT AUTHORIZE. It stands in for the session
 * cookie and for nothing else: the click handler goes through `assertCanDecide`
 * and `engine.decide` exactly as the browser does. A token carrying its own
 * permission would let somebody approve a report after being removed as its
 * approver — and the removal is the case this matters in, because a link that has
 * been sitting in a mailbox for four days is precisely when the world has moved.
 *
 * ── Where the guards live ───────────────────────────────────────────────────
 *
 * There are TWO independent guards on expiry and consumption, which is the right
 * number for a credential:
 *
 *   · `0012`'s `platform_read` policy makes an expired or consumed token INVISIBLE
 *     to the cross-tenant lookup. So the check cannot be forgotten, cannot be
 *     reordered, and cannot be defeated by a clock the application reads instead
 *     of the database.
 *   · `verify()` below checks both again in application code, ported verbatim.
 *
 * The second looks redundant against the first. It is not: the policy protects
 * the tenant-resolution read, and `verify` also runs on the tenant-scoped read
 * that follows it, where `tenant_isolation` (not `platform_read`) is the policy in
 * force and carries no expiry predicate at all.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { QueryRunner } from '@/lib/db/client';
import { ORG } from '@/lib/tenant/sql';


export type TokenAction = 'APPROVE' | 'REJECT';

/**
 * How long a link lives.
 *
 * ExpenseOS reads the task's own TTL and falls back to five business days.
 * VeloExpense HAS NO TASK TTL — AP-8's expiry policy is ported into the audit as
 * a spec and nothing implements it — so this is a constant, and five business days
 * is their number. Long enough to survive a weekend plus a short holiday; short
 * enough that a forwarded mailbox stops being a credential store.
 *
 * If AP-8 ever ships, this becomes the fallback and the task's expiry wins, which
 * is the shape ExpenseOS already has.
 */
export const TOKEN_TTL_BUSINESS_DAYS = 5;

/**
 * Business days, Mon–Fri, no holiday calendar.
 *
 * VeloExpense has no working-calendar table and this is not the ticket to invent
 * one, so a public holiday costs a link a day of its life. Said out loud because
 * the alternative — quietly treating "business days" as calendar days — is how a
 * constant stops meaning what it says.
 */
export function addBusinessDays(from: Date, days: number): Date {
  const d = new Date(from.getTime());
  let left = days;
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    const day = d.getUTCDay();
    if (day !== 0 && day !== 6) left -= 1;
  }
  return d;
}

function hashToken(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

export interface IssuedToken {
  /** The value that goes in the link. NOT stored anywhere. */
  raw: string;
  id: string;
  expiresAt: Date;
}

/**
 * Mint a token for (task, action, recipient).
 *
 * 32 random bytes, base64url. Only the sha256 is persisted, so a database leak
 * yields nothing usable — the raw value exists in exactly one place, which is a
 * link in somebody's mailbox.
 */
export async function issueActionToken(
  tx: QueryRunner,
  input: {
    taskId: string;
    action: TokenAction;
    recipientId: string;
    deliveryId?: string | null;
    now?: Date;
  },
): Promise<IssuedToken> {
  const raw = randomBytes(32).toString('base64url');
  const expiresAt = addBusinessDays(input.now ?? new Date(), TOKEN_TTL_BUSINESS_DAYS);
  const r = await tx.query(
    `INSERT INTO action_token
       (organization_id, token_hash, task_id, action, recipient_id, expires_at, delivery_id)
     VALUES (${ORG}, $1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [hashToken(raw), input.taskId, input.action, input.recipientId, expiresAt, input.deliveryId ?? null],
  );
  return { raw, id: r.rows[0].id as string, expiresAt };
}

export interface ResolvedToken {
  id: string;
  organizationId: string;
  taskId: string;
  action: TokenAction;
  recipientId: string;
  expiresAt: Date;
}

/**
 * Which TENANT does this token belong to — the only question answered outside a
 * tenant context.
 *
 * Runs under `withPlatformRead`, so `0012`'s `platform_read` policy applies: an
 * expired or consumed token is not visible and this returns null. The caller then
 * enters `withOrg(organizationId)` and re-resolves with `verify` below.
 *
 * THE CALLER MUST TAKE NOTHING FROM THIS BUT `organizationId`. Everything else is
 * returned for logging and for a fast path, and re-read under the tenant policy
 * before it is acted on. That rule is what makes a cross-tenant read driven by an
 * untrusted value acceptable at all.
 */
export async function resolveTokenTenant(
  tx: QueryRunner,
  raw: string,
): Promise<{ organizationId: string } | null> {
  if (!raw) return null;
  const r = await tx.query(
    `SELECT organization_id FROM action_token WHERE token_hash = $1`,
    [hashToken(raw)],
  );
  return r.rows[0] ? { organizationId: r.rows[0].organization_id as string } : null;
}

/**
 * Resolve a raw token INSIDE its tenant, or null if unknown / expired / consumed.
 *
 * Ported condition, and the comparison is constant-time. That is not in
 * ExpenseOS: their lookup is by hash equality in the database, which is already
 * not a timing oracle worth attacking. It is here because the row we fetch is
 * chosen by an indexed hash lookup and then compared again in JS, and doing that
 * comparison with `===` on a secret-derived value is the kind of thing that reads
 * as a mistake even when it is not exploitable.
 */
export async function verifyActionToken(
  tx: QueryRunner,
  raw: string,
  now: Date = new Date(),
): Promise<ResolvedToken | null> {
  if (!raw) return null;
  const expected = hashToken(raw);
  const r = await tx.query(
    `SELECT id, organization_id, token_hash, task_id, action, recipient_id,
            expires_at, consumed_at
       FROM action_token WHERE token_hash = $1`,
    [expected],
  );
  const row = r.rows[0];
  if (!row) return null;
  if (!sameHash(row.token_hash as string, expected)) return null;
  if (row.consumed_at !== null) return null;
  if ((row.expires_at as Date).getTime() < now.getTime()) return null;
  return {
    id: row.id as string,
    organizationId: row.organization_id as string,
    taskId: row.task_id as string,
    action: row.action as TokenAction,
    recipientId: row.recipient_id as string,
    expiresAt: row.expires_at as Date,
  };
}

function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  // timingSafeEqual throws on a length mismatch, which is itself the answer.
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Mark a token consumed. True only for the call that actually consumed it.
 *
 * The conditional write IS the single-use guarantee — ported verbatim, including
 * the reason: it "guards against double-submit". Same idiom as VX2-3's decision
 * claim and VX2-8's delivery claim; three single-use guarantees in this codebase
 * now share one shape, which is worth more than three clever ones.
 *
 * Requires a tenant context: `0012`'s platform hatch is FOR SELECT only, so this
 * cannot run outside `withOrg`.
 */
export async function consumeActionToken(tx: QueryRunner, id: string): Promise<boolean> {
  const r = await tx.query(
    `UPDATE action_token SET consumed_at = clock_timestamp()
      WHERE id = $1 AND consumed_at IS NULL`,
    [id],
  );
  return r.rowCount === 1;
}

/**
 * Consume every live token on a task, without using one.
 *
 * Called when a task is decided by ANY route — the browser, an admin override,
 * or the other one of this task's own two links. Without it, approving in the app
 * leaves a REJECT link live in somebody's mailbox pointing at a decided task;
 * `decide` would refuse it with ALREADY_DECIDED, so this is not a hole, but a
 * credential that outlives its purpose is one to retire rather than to rely on
 * being refused.
 */
export async function consumeTaskTokens(tx: QueryRunner, taskId: string): Promise<number> {
  const r = await tx.query(
    `UPDATE action_token SET consumed_at = clock_timestamp()
      WHERE task_id = $1 AND consumed_at IS NULL`,
    [taskId],
  );
  return r.rowCount ?? 0;
}
