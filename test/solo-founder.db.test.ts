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
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { Pool } from 'pg';
import { withOrg } from '@/lib/tenant/context';
import * as expenses from '@/lib/expenses/service';
import * as lifecycle from '@/lib/expenses/lifecycle';
import * as approvals from '@/lib/approvals/service';
import { userMessageOf } from '@/lib/errors/domain';
import { TEST_ACTOR } from './support/audit-actor';
import { TODAY } from './support/dates';

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
  await withOrg(orgId, async (tx) => {
    const f = await tx.query(
      `INSERT INTO app_user (organization_id, email, display_name, role)
       VALUES ($1,$2,'Founder','ADMIN') RETURNING id`,
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
  await admin.query('DELETE FROM approval_policy WHERE organization_id = $1', [orgId]);
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
    expect((err as { code?: string }).code).toBe('SELF_APPROVAL');
    expect(userMessageOf(err)?.code).toBe('SUBMIT_NEEDS_APPROVER');
    // The refusal is the whole transaction: still a draft, nothing half-submitted.
    expect(await status(reportId)).toBe('DRAFT');
  });

  it('can submit the moment somebody else can approve', async () => {
    const reportId = await draft();
    await admin.query(
      `INSERT INTO app_user (organization_id, email, display_name, role)
       VALUES ($1,'second@solo.test','Second','ADMIN')`,
      [orgId],
    );
    await withOrg(orgId, (tx) => lifecycle.submitReport(tx, reportId, founderId));
    expect(await status(reportId)).toBe('SUBMITTED');
  });
});

describe('any other routing failure at submit', () => {
  it('gets the STEP_UNROUTABLE sentence, rather than no sentence at all', async () => {
    // An EMAIL approver rung, which routing refuses until external approvers
    // can act (EMAIL_APPROVER_UNSUPPORTED) — a routing failure that is not the
    // solo-founder one, so it must NOT get the invite-somebody sentence.
    await admin.query(
      `INSERT INTO app_user (organization_id, email, display_name, role)
       VALUES ($1,'second@solo.test','Second','ADMIN')`,
      [orgId],
    );
    await withOrg(orgId, (tx) =>
      approvals.createPolicy(tx, {
        name: 'External',
        sequence: 1,
        approvers: [{ position: 1, approverKind: 'EMAIL', externalEmail: 'ext@vendor.test' }],
      }),
    );
    const reportId = await draft();
    const err = await withOrg(orgId, (tx) => lifecycle.submitReport(tx, reportId, founderId)).catch(
      (e: unknown) => e,
    );
    expect((err as { code?: string }).code).toBe('EMAIL_APPROVER_UNSUPPORTED');
    expect(userMessageOf(err)?.code).toBe('STEP_UNROUTABLE');
    expect(await status(reportId)).toBe('DRAFT');
  });
});
