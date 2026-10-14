// @vitest-environment node
/* eslint-disable @typescript-eslint/no-explicit-any -- VeloExpense: ExpenseOS's suite reads its rows untyped (`db: any`); Biome allows it there. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTenantHarness, type TenantHarness } from '../../../server/__test-helpers__/tenantHarness';

/**
 * Integration test for `expense.receiptChase` against a real database.
 *
 * The cooldown is the part worth pinning: a daily job with no memory would mail
 * the same person every night until they muted notifications, which is worse
 * than never chasing. That behaviour is invisible in a single run, so it's
 * asserted by running the handler twice.
 *
 * Gated on DATABASE_URL; the hermetic CI run skips it.
 *
 * VeloExpense: ExpenseOS's `expense-receipt-chase.db.test.ts` (550b2945), Wave 3 (w3-05). The
 * cases are ExpenseOS's; the harness is VeloExpense's (`createTenantHarness`: the suite's own
 * tenant), and the handler runs as the worker runs it — as its tenant, statement at a time
 * (`withTenantStatements`), so the activity and notification rows go through RLS as
 * `veloapp`. The reminder is RECEIPT_CHASE (d46); `activity` and `notification` have no
 * Prisma model here, so they are read with the superuser pool. Two VeloExpense cases close
 * it: a colleague's ask counts toward the cooldown, and another tenant's reports are not
 * this run's.
 */

vi.mock('@/auth', () => ({ auth: vi.fn(async () => null) }));
vi.mock('@/lib/tenant/request', () => ({ hostTenantSlug: async () => null }));

describe.skipIf(!process.env.DATABASE_URL)('expense.receiptChase (integration)', () => {
  let h: TenantHarness;
  let db: any;

  // Matches JobMap['expense.receiptChase'] without importing the type map.
  let handle: (d: { trigger?: 'cron' | 'manual' }) => Promise<void>;

  let submitterId: string;
  const DAY_MS = 24 * 60 * 60 * 1000;

  /** A report in `status` holding one receiptless expense created `ageDays` ago. */
  async function seedReport(status: string, ageDays: number): Promise<string> {
    // VeloExpense: a currency's key is its ISO code; the status is put there directly, as
    // ExpenseOS creates it in it.
    const r = await db.expenseReport.create({
      data: {
        title: `chase ${status} ${ageDays}d`,
        submitterId,
        currencyId: 'CAD',
        status,
        expenses: {
          create: [
            {
              ownerId: submitterId,
              date: new Date(),
              amountMinor: 5000n,
              currencyId: 'CAD',
              createdAt: new Date(Date.now() - ageDays * DAY_MS),
            },
          ],
        },
      },
      select: { id: true },
    });
    return r.id;
  }

  /** VeloExpense: `activity` is read with the superuser pool, by event type. */
  const remindersFor = async (reportId: string, eventType = 'RECEIPT_CHASE') =>
    Number(
      (
        await h.admin.query(
          `SELECT count(*)::int AS n FROM activity
            WHERE subject_type = 'EXPENSE_REPORT' AND subject_id = $1 AND event_type = $2`,
          [reportId, eventType],
        )
      ).rows[0].n,
    );

  beforeAll(async () => {
    h = await createTenantHarness({ slug: 'receipt-chase', name: 'Receipt Chase' });
    db = h.db;
    submitterId = h.people[0].id;
    const { handleExpenseReceiptChase } = await import('./expense-receipt-chase');
    const { withTenantStatements } = await import('@/lib/db/prisma');
    // VeloExpense: as the worker runs it — the job's tenant, statement at a time.
    handle = (d) => withTenantStatements(h.orgId, () => handleExpenseReceiptChase(d as never));
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterAll(async () => {
    // VeloExpense: the next suite truncates the tenants; only the pool is ours to close.
    await h?.end();
  });

  it('chases a draft whose receiptless expense is old enough', async () => {
    const id = await seedReport('DRAFT', 10);
    await handle({ trigger: 'manual' });
    expect(await remindersFor(id)).toBe(1);
  });

  it('does not chase the same report again inside the cooldown', async () => {
    const id = await seedReport('DRAFT', 10);
    await handle({ trigger: 'manual' });
    await handle({ trigger: 'manual' }); // same day, second run
    expect(await remindersFor(id)).toBe(1);
  });

  it('leaves a freshly-captured expense alone', async () => {
    // Captured today: the submitter hasn't had a chance yet.
    const id = await seedReport('DRAFT', 0);
    await handle({ trigger: 'manual' });
    expect(await remindersFor(id)).toBe(0);
  });

  it('ignores states the submitter cannot act on', async () => {
    // SUBMITTED is out of their hands; APPROVED is settled. Chasing either
    // would be nagging about something they can't fix.
    const submitted = await seedReport('SUBMITTED', 10);
    const approved = await seedReport('APPROVED', 10);
    await handle({ trigger: 'manual' });
    expect(await remindersFor(submitted)).toBe(0);
    expect(await remindersFor(approved)).toBe(0);
  });

  it('chases a RETURNED report — the submitter owns it again', async () => {
    const id = await seedReport('RETURNED', 10);
    await handle({ trigger: 'manual' });
    expect(await remindersFor(id)).toBe(1);
  });

  it('sends one reminder per report, not per receiptless expense', async () => {
    const id = await seedReport('DRAFT', 10);
    // Two more receiptless expenses on the same report.
    await db.expense.createMany({
      data: [1, 2].map(() => ({
        reportId: id,
        ownerId: submitterId,
        date: new Date(),
        amountMinor: 2500n,
        currencyId: 'CAD',
        createdAt: new Date(Date.now() - 10 * DAY_MS),
      })),
    });
    await handle({ trigger: 'manual' });
    expect(await remindersFor(id)).toBe(1);
  });

  it('notifies the submitter, not just the activity row', async () => {
    const id = await seedReport('DRAFT', 10);
    await handle({ trigger: 'manual' });
    const activity = (
      await h.admin.query(
        `SELECT id, actor_id, payload FROM activity
          WHERE subject_id = $1 AND event_type = 'RECEIPT_CHASE'`,
        [id],
      )
    ).rows[0];
    // System-generated, so no actor.
    expect(activity.actor_id).toBeNull();
    // VeloExpense: the count and the report placeholders the message is rendered from.
    expect(activity.payload).toMatchObject({ missing: 1, report: 'chase DRAFT 10d' });
    const notes = Number(
      (
        await h.admin.query(
          `SELECT count(*)::int AS n FROM notification
            WHERE activity_id = $1 AND recipient_id = $2`,
          [activity.id, submitterId],
        )
      ).rows[0].n,
    );
    expect(notes).toBe(1);
  });

  it('VeloExpense: a colleague who asked inside the window counts as the reminder', async () => {
    // ExpenseOS's cooldown reads its one reminder event, which both the job and the person
    // send; here they are two events (d46), and both still count.
    const id = await seedReport('DRAFT', 10);
    await h.admin.query(
      `INSERT INTO activity (organization_id, subject_type, subject_id, event_type, actor_id, payload)
       VALUES ($1, 'EXPENSE_REPORT', $2, 'RECEIPT_REMINDER', $3, '{}'::jsonb)`,
      [h.orgId, id, submitterId],
    );
    await handle({ trigger: 'manual' });
    expect(await remindersFor(id)).toBe(0);
  });

  it('VeloExpense: chases only the tenant it runs as', async () => {
    // Another tenant's old receiptless draft, made with the superuser pool.
    const other = (
      await h.admin.query(
        `INSERT INTO organization (slug, name) VALUES ('receipt-chase-other', 'Other') RETURNING id`,
      )
    ).rows[0].id as string;
    const otherUser = (
      await h.admin.query(
        `INSERT INTO app_user (organization_id, email, display_name, role_id)
         VALUES ($1, 'other@receipt-chase-other.test', 'Other', '019e3000-0000-7000-8000-000000000004') RETURNING id`,
        [other],
      )
    ).rows[0].id as string;
    const otherReport = (
      await h.admin.query(
        `INSERT INTO expense_report (organization_id, title, submitter_id, currency_code, status)
         VALUES ($1, 'other tenant', $2, 'CAD', 'DRAFT') RETURNING id`,
        [other, otherUser],
      )
    ).rows[0].id as string;
    await h.admin.query(
      `INSERT INTO expense (organization_id, report_id, owner_id, txn_date, amount_minor, currency_code, created_at)
       VALUES ($1, $2, $3, now(), 5000, 'CAD', now() - interval '10 days')`,
      [other, otherReport, otherUser],
    );
    await handle({ trigger: 'manual' });
    expect(await remindersFor(otherReport)).toBe(0);
  });
});
