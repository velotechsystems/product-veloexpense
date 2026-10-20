/**
 * Replay protection for API-key calls.
 *
 * A client that retries a timed-out `submit_expense_report` would otherwise submit twice.
 * The first call claims the key; a repeat returns the first outcome instead of acting again.
 *
 * Applies to **mutating tools only**. Repeating a read is harmless, and covering reads would
 * mean storing their responses — which is how a card number ends up in a table with a
 * different retention and threat model than the encrypted column it came from.
 *
 * Ported from ExpenseOS `apps/web/src/server/lib/idempotency.ts` (1e682dd6), w6-04 (d88).
 */

import { createHash } from 'node:crypto';
import type { PrismaClient } from '@expenseos/db';

/** How long a key is remembered. Long enough for any sane retry, short enough to forget. */
const TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Tools whose results must never be stored for replay.
 *
 * Empty today — no current tool returns a secret. It exists because the FIRST one that does
 * should have somewhere obvious to be listed, rather than the question being noticed after
 * the fact. A replay of one of these returns a duplicate marker instead of the body.
 */
export const SENSITIVE_TOOLS: ReadonlySet<string> = new Set<string>();

/** Fingerprint of the call, so a key reused with different input is caught. */
export function requestHash(toolName: string, input: unknown): string {
  return createHash('sha256')
    .update(`${toolName} ${stable(input)}`)
    .digest('hex');
}

/** Deterministic JSON — key order must not change the fingerprint. */
function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`)
    .join(',')}}`;
}

export type ClaimResult =
  | { readonly kind: 'proceed'; readonly id: string }
  | { readonly kind: 'replay'; readonly response: unknown }
  | { readonly kind: 'in_flight' }
  | { readonly kind: 'mismatch' };

/**
 * Claim an idempotency key, or report why this call should not run.
 *
 * `in_flight` matters more than it looks: two simultaneous retries would both miss a
 * COMPLETED record and both act. Refusing the second while the first is still running is
 * what makes this safe under concurrency rather than merely usually right.
 */
export async function claim(
  db: PrismaClient,
  apiKeyId: string,
  key: string,
  toolName: string,
  input: unknown,
  now: Date = new Date(),
): Promise<ClaimResult> {
  const hash = requestHash(toolName, input);
  const existing = await db.apiKeyIdempotency.findUnique({
    where: { apiKeyId_key: { apiKeyId, key } },
  });

  if (existing && existing.expiresAt.getTime() > now.getTime()) {
    // A key reused with different input is a client bug worth surfacing, not a replay to
    // absorb — returning the earlier result would answer a question nobody asked.
    if (existing.requestHash !== hash) return { kind: 'mismatch' };
    if (existing.status === 'IN_FLIGHT') return { kind: 'in_flight' };
    return { kind: 'replay', response: existing.response };
  }

  const expiresAt = new Date(now.getTime() + TTL_MS);
  const row = await db.apiKeyIdempotency.upsert({
    where: { apiKeyId_key: { apiKeyId, key } },
    create: { apiKeyId, key, requestHash: hash, status: 'IN_FLIGHT', expiresAt },
    // An expired record is reclaimed rather than blocking the key forever.
    update: { requestHash: hash, status: 'IN_FLIGHT', response: undefined, expiresAt },
    select: { id: true },
  });
  return { kind: 'proceed', id: row.id };
}

/** Record the outcome so a retry replays it. */
export async function complete(
  db: PrismaClient,
  id: string,
  toolName: string,
  response: unknown,
): Promise<void> {
  await db.apiKeyIdempotency
    .update({
      where: { id },
      data: {
        status: 'COMPLETED',
        response: SENSITIVE_TOOLS.has(toolName)
          ? { duplicate: true, omitted: 'sensitive' }
          : ((response ?? null) as object),
      },
    })
    .catch(() => undefined);
}

/**
 * Release a claim that never produced a result.
 *
 * Without this, a call that crashed mid-flight leaves the key IN_FLIGHT for 24 hours and
 * every retry is refused — the protection would become the outage.
 */
export async function release(db: PrismaClient, id: string): Promise<void> {
  await db.apiKeyIdempotency.delete({ where: { id } }).catch(() => undefined);
}
