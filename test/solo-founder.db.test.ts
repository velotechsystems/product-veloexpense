/**
 * A founder alone in their tenant submits a report — and is told what to DO.
 *
 * Own org slug ('solo-co'), like every other db suite in this project.
 *
 * DECIDED 4 Oct 2026 (John): a one-person tenant keeps segregation of duties.
 * Nobody approves their own expenses, so a founder who is the only person here
 * cannot submit until somebody else can approve. That refusal is correct and it
 * stays. What was wrong was what it SAID.
 *
 * `openRun` let the resolver's `RoutingError` escape untranslated, and a
 * `RoutingError` carries no reader copy — so the person saw the generic
 * "something went wrong", on the one action the product exists for, at the
 * moment they were most likely to give up on it. (The other place a step is
 * routed, advancing a run in `decide`, already translated to STEP_UNROUTABLE:
 * "ask your administrator" — which, said to the only administrator, would have
 * been a dead end of its own.)
 *
 * Now every `RoutingError` carries a sentence: SELF_APPROVAL says who to invite
 * and where; every other code gets the existing STEP_UNROUTABLE sentence instead
 * of nothing. The codes themselves are unchanged — callers and tests that branch
 * on them see what they always saw. Same codes the setup checklist on the home page already uses
 * (`app/page.tsx`, the APPROVER item), so the wall and the warning agree.
 *
 * w4-00c: on ExpenseOS's engine. The default flow (d59) sends a submitter with no manager to
 * the administrators; a founder alone is the one administrator, and may not approve their own
 * report, so the submit is refused with the same sentence (`NO_APPROVER`,
 * `assertSomeoneElseCanDecide` in lib/expenses/lifecycle.ts). The ladder's other routing
 * failure (an external EMAIL approver) went with the ladder; its place is taken by the two
 * refusals the engine's flow can give at submit: a flow naming the submitter, and no flow.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { Pool } from 'pg';
// w4-00c: the lifecycle starts the approval engine, which needs the tenant's Prisma
// transaction (test/support/tenant-tx.ts) — the same `QueryRunner`, under the same name.
import { seedDefaultFlow, withTenantTx as withOrg } from './support/tenant-tx';
import * as expenses from '@/lib/expenses/service';
import * as lifecycle from '@/lib/expenses/lifecycle';
import { userMessageOf } from '@/lib/errors/domain';
import { TEST_ACTOR } from './support/audit-actor';
import { TODAY } from './support/dates';
import { startInstance } from '@expenseos/approvals/engine';
import { onlyRequesterCouldDecide } from '@/lib/approvals/someoneElseCanDecide';

const admin = new Pool({
  connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL,
});

let orgId: string;
let founderId: string;
let categoryId: string;
const FOUNDER = 'founder@solo.test';

async function draft(): Promise<string> {
  return withOrg(orgId, async (tx) => {
    const report = await expenses.createReport(tx, FOUNDER, { title: 'Solo', currencyCode: 'CAD' });
    const expense = await expenses.addExpense(tx, TEST_ACTOR, report.id, {
      txnDate: TODAY,
      currencyCode: 'CAD',
      merchant: 'M',
    });
    await expenses.addLineItem(tx, TEST_ACTOR, expense.id, { categoryId, amountMinor: 25_00 });
    return report.id as string;
  });
}

async function status(reportId: string): Promise<string> {
  const r = await admin.query('SELECT status FROM expense_report WHERE id = $1', [reportId]);
  return r.rows[0].status as string;
}

beforeAll(async () => {
  await admin.query('TRUNCATE app_user, organization CASCADE');
  const o = await admin.query(
    "INSERT INTO organization (slug, name) VALUES ('solo-co','Solo Co') RETURNING id",
  );
  orgId = o.rows[0].id;
  // w4-00c: the default approval flow a provisioned tenant starts with (d54); without it a
  // submit is refused (d58).
  await seedDefaultFlow(orgId);
  await withOrg(orgId, async (tx) => {
    const f = await tx.query(
      `INSERT INTO app_user (organization_id, email, display_name, role_id)
       VALUES ($1,$2,'Founder','019e3000-0000-7000-8000-000000000001') RETURNING id`,
      [orgId, FOUNDER],
    );
    founderId = f.rows[0].id;
    const c = await tx.query(
      `INSERT INTO expense_category (organization_id, code, label) VALUES ($1,'meals','{"en":"Meals"}') RETURNING id`,
      [orgId],
    );
    categoryId = c.rows[0].id;
  });
});

beforeEach(async () => {
  await admin.query('DELETE FROM expense_report WHERE organization_id = $1', [orgId]);
  await admin.query('DELETE FROM travel_request WHERE organization_id = $1', [orgId]);
  await admin.query('DELETE FROM approval_instance WHERE organization_id = $1', [orgId]);
  await admin.query(
    "DELETE FROM approval_workflow WHERE organization_id = $1 AND key NOT IN ('expense-report-default', 'travel-request-default')",
    [orgId],
  );
  await admin.query('UPDATE approval_workflow SET active = true WHERE organization_id = $1', [orgId]);
  await admin.query("DELETE FROM app_user WHERE organization_id = $1 AND id <> $2", [orgId, founderId]);
  await admin.query('UPDATE app_user SET manager_id = NULL WHERE id = $1', [founderId]);
});

afterAll(async () => {
  await admin.query('TRUNCATE app_user, organization CASCADE');
  await admin.end();
});

describe('a founder alone in their tenant', () => {
  it('is refused, and told to invite somebody who can approve — not "something went wrong"', async () => {
    const reportId = await draft();
    const err = await withOrg(orgId, (tx) => lifecycle.submitReport(tx, reportId, founderId)).catch(
      (e: unknown) => e,
    );
    expect((err as { code?: string }).code).toBe('NO_APPROVER');
    expect(userMessageOf(err)?.code).toBe('SUBMIT_NEEDS_APPROVER');
    // The refusal is the whole transaction: still a draft, nothing half-submitted.
    expect(await status(reportId)).toBe('DRAFT');
  });

  it('can submit the moment somebody else can approve', async () => {
    const reportId = await draft();
    await admin.query(
      `INSERT INTO app_user (organization_id, email, display_name, role_id)
       VALUES ($1,'second@solo.test','Second','019e3000-0000-7000-8000-000000000001')`,
      [orgId],
    );
    await withOrg(orgId, (tx) => lifecycle.submitReport(tx, reportId, founderId));
    expect(await status(reportId)).toBe('SUBMITTED');
  });
});

describe('the other refusals the flow can give at submit (w4-00c)', () => {
  it('refuses a flow that names the submitter, with the same sentence', async () => {
    // A second admin exists, so the default flow would reach somebody — but a more specific
    // workflow names the founder as the approver of their own report.
    await admin.query(
      `INSERT INTO app_user (organization_id, email, display_name, role_id)
       VALUES ($1,'second@solo.test','Second','019e3000-0000-7000-8000-000000000001')`,
      [orgId],
    );
    const wf = (
      await admin.query(
        `INSERT INTO approval_workflow (organization_id, key, name, subject_type, priority)
         VALUES ($1, 'self', 'Self', 'EXPENSE_REPORT', 10) RETURNING id`,
        [orgId],
      )
    ).rows[0].id;
    const graph = {
      nodes: [
        { id: 'start', type: 'start' },
        { id: 'a', type: 'approval', approver: { kind: 'manager', fallback: { kind: 'user', userId: founderId } } },
        { id: 'done', type: 'approved' },
      ],
      edges: [
        { id: 'e1', source: 'start', target: 'a' },
        { id: 'e2', source: 'a', target: 'done' },
      ],
    };
    const v = (
      await admin.query(
        `INSERT INTO approval_workflow_version (organization_id, workflow_id, version, match_condition, graph, status)
         VALUES ($1, $2, 1, '{"always": true}', $3::jsonb, 'PUBLISHED') RETURNING id`,
        [orgId, wf, JSON.stringify(graph)],
      )
    ).rows[0].id;
    await admin.query(`UPDATE approval_workflow SET current_version_id = $1 WHERE id = $2`, [v, wf]);

    const reportId = await draft();
    const err = await withOrg(orgId, (tx) => lifecycle.submitReport(tx, reportId, founderId)).catch(
      (e: unknown) => e,
    );
    expect((err as { code?: string }).code).toBe('NO_APPROVER');
    expect(userMessageOf(err)?.code).toBe('SUBMIT_NEEDS_APPROVER');
    expect(await status(reportId)).toBe('DRAFT');
  });

  it('refuses a report no published workflow governs (d58), and says whose fix it is', async () => {
    // ExpenseOS approves it. VeloExpense never approves by omission.
    await admin.query(`UPDATE approval_workflow SET active = false WHERE organization_id = $1`, [orgId]);
    const reportId = await draft();
    const err = await withOrg(orgId, (tx) => lifecycle.submitReport(tx, reportId, founderId)).catch(
      (e: unknown) => e,
    );
    expect((err as { code?: string }).code).toBe('NO_WORKFLOW');
    expect(userMessageOf(err)?.code).toBe('SUBMIT_NO_WORKFLOW');
    expect(await status(reportId)).toBe('DRAFT');
    const runs = await admin.query(`SELECT count(*)::int AS n FROM approval_instance WHERE subject_id = $1`, [
      reportId,
    ]);
    expect(runs.rows[0].n).toBe(0);
  });
});

/**
 * f61: the same rule for a trip. ExpenseOS's travel submit has no such check: a founder alone
 * would submit a request the default travel flow sends to the administrators — themselves —
 * and `canDecide` would then stop them deciding it, so it waits on nobody. `travelRequests.submit`
 * refuses it with the rule reports use (`onlyRequesterCouldDecide`); this runs that rule on the
 * real travel flow (0077's `travel-request-default`) and the real engine.
 */
describe('a founder alone, requesting a trip (f61)', () => {
  async function routeTrip(): Promise<boolean> {
    return withOrg(orgId, async (tx, db) => {
      // `::text`: the function returns void, which the Prisma bridge cannot deserialize.
      await tx.query('SELECT seed_travel_defaults()::text AS done');
      const trip = await tx.query(
        `INSERT INTO travel_request (submitter_id, purpose, destination_label, destination_city,
                                     depart_date, currency_code, status)
         VALUES ($1, 'Client visit', 'Montréal', 'Montréal', now(), 'CAD', 'SUBMITTED') RETURNING id`,
        [founderId],
      );
      const start = await startInstance(db, 'TRAVEL_REQUEST', trip.rows[0].id as string);
      expect(start.status).toBe('RUNNING');
      return onlyRequesterCouldDecide(db, founderId, start.createdTaskIds);
    });
  }

  it('routes only to the traveller, so the submit is refused', async () => {
    expect(await routeTrip()).toBe(true);
  });

  it('reaches somebody else once a second administrator exists', async () => {
    await admin.query(
      `INSERT INTO app_user (organization_id, email, display_name, role_id)
       VALUES ($1,'second@solo.test','Second','019e3000-0000-7000-8000-000000000001')`,
      [orgId],
    );
    expect(await routeTrip()).toBe(false);
  });

  it('reaches somebody else once the traveller has a manager', async () => {
    const m = await admin.query(
      `INSERT INTO app_user (organization_id, email, display_name, role_id)
       VALUES ($1,'manager@solo.test','Manager','019e3000-0000-7000-8000-000000000004') RETURNING id`,
      [orgId],
    );
    await admin.query('UPDATE app_user SET manager_id = $1 WHERE id = $2', [m.rows[0].id, founderId]);
    expect(await routeTrip()).toBe(false);
  });
});
