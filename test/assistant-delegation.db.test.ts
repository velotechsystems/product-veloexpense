/**
 * w6-03 — a change the assistant drafted and a person confirmed is audited as theirs, and
 * says the assistant drafted it.
 *
 * ExpenseOS's `runWithDelegation` (packages/audit/src/delegation.ts, ported with the
 * assistant) is what the chat route wraps a confirmed proposal in. Every `writeAudit` inside
 * it adds `viaAssistant` to the row's `details` — inside the hash, so it cannot be stripped
 * without breaking the chain. The actor is still the person who pressed.
 *
 * What only Postgres can prove: the marked row is written into VeloExpense's per-tenant chain
 * through the real tRPC path (the `tenant` middleware, the ported router, `withAudit`), and
 * the chain still verifies with it in.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';

vi.mock('@/auth', () => ({ auth: vi.fn(async () => null) }));
vi.mock('@/lib/tenant/request', () => ({ hostTenantSlug: async () => null }));

const { createOrganization } = await import('@/lib/onboarding/provision');
const { createCallerFactory } = await import('@/server/trpc');
const { appRouter } = await import('@/server/routers/_app');
const { db } = await import('@/lib/db/prisma');
const { withOrg } = await import('@/lib/tenant/context');
const { verifyChain } = await import('@/lib/audit/verify');
const { runWithDelegation } = await import('@expenseos/audit');

const admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL });

let A: string;
let bossA: string;

const as = (email: string, organizationId: string) =>
  createCallerFactory(appRouter)({ session: null, db, rbac: null, caller: { email, organizationId } });

const lastAudit = async (org: string) =>
  (
    await admin.query(
      `SELECT action, actor_id, details FROM audit_entry WHERE organization_id = $1 ORDER BY sequence DESC LIMIT 1`,
      [org],
    )
  ).rows[0];

const NEW = (en: string) => ({
  label: { en },
  itcGstHstRate: 100,
  itcQstRate: 100,
  pstRecoverable: false,
  requiresAttendees: false,
  kind: 'standard' as const,
  active: true,
});

beforeAll(async () => {
  await admin.query('TRUNCATE invite, audit_entry, app_user, organization CASCADE');
  A = (
    await createOrganization({
      name: 'Alpha Assist',
      slug: 'alpha-assist',
      adminEmail: 'boss@alpha-assist.test',
      adminName: 'Boss',
    })
  ).organizationId;
  bossA = (await admin.query("SELECT id FROM app_user WHERE email = 'boss@alpha-assist.test'")).rows[0].id;
});

afterAll(async () => {
  await admin.end();
});

describe('a confirmed assistant action', () => {
  it('is audited as the person who pressed, marked as drafted by the assistant, in a chain that verifies', async () => {
    const via = { conversationId: '11111111-1111-4111-8111-111111111111', toolUseId: 'toolu_fixture_1' };
    await runWithDelegation({ viaAssistant: via }, () =>
      as('boss@alpha-assist.test', A).expenseCategories.create(NEW('Drafted by the assistant')),
    );
    const row = await lastAudit(A);
    expect(row.action).toBe('EXPENSE_CATEGORY_CREATED');
    // Their authority was used, so the row names them — never a robot.
    expect(row.actor_id).toBe(bossA);
    expect(row.details).toMatchObject({ viaAssistant: via });
    expect(await withOrg(A, (tx) => verifyChain(tx))).toMatchObject({ ok: true });
  });

  it('leaves a direct action unmarked', async () => {
    await as('boss@alpha-assist.test', A).expenseCategories.create(NEW('Typed by a person'));
    const row = await lastAudit(A);
    expect(row.details?.viaAssistant).toBeUndefined();
    expect(await withOrg(A, (tx) => verifyChain(tx))).toMatchObject({ ok: true });
  });
});
