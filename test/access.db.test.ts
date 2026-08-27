/**
 * VX1-10 — who may touch whose reports and receipts.
 *
 * Own org slug ('access-co'); the DB suites share one database and each
 * TRUNCATEs (vitest.config.ts, fileParallelism: false).
 *
 * The predicates are pure, so most of this is a truth table — but the ownership
 * LOOKUPS are SQL with two LEFT JOINs (a receipt may have no expense, and an
 * expense always has a report), so they get exercised against a real database
 * rather than a hand-built object. The bug this ticket fixes was invisible
 * precisely because RLS made every one of these rows readable.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { withOrg } from '@/lib/tenant/context';
import * as expenses from '@/lib/expenses/service';
import * as receipts from '@/lib/receipts/service';
import * as lifecycle from '@/lib/expenses/lifecycle';
import type { Actor } from '@/lib/auth/actor';

const admin = new Pool({
  connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL,
});

let orgId: string;
let owner: Actor; // submitted the report, uploaded the receipt
let other: Actor; // an unrelated colleague in the same tenant
let boss: Actor; // ADMIN
let manager: Actor; // MANAGER — deliberately gets nothing extra in Phase 1
let categoryId: string;

async function seedUser(tx: Parameters<Parameters<typeof withOrg>[1]>[0], email: string, role: string) {
  const r = await tx.query(
    `INSERT INTO app_user (organization_id, email, display_name, role)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [orgId, email, email.split('@')[0], role],
  );
  return { id: r.rows[0].id as string, role } as Actor;
}

/** A draft owned by `owner`, with one line and one attached receipt. */
async function draftWithReceipt() {
  return withOrg(orgId, async (tx) => {
    const report = await expenses.createReport(tx, 'owner@access.test', {
      title: 'Access subject',
      currencyCode: 'CAD',
    });
    const expense = await expenses.addExpense(tx, report.id, { currencyCode: 'CAD' });
    await expenses.addLineItem(tx, expense.id, { categoryId, amountMinor: 1000 });
    const receipt = await tx.query(
      `INSERT INTO receipt (organization_id, expense_id, s3_key, filename, content_type,
                            size_bytes, status, uploaded_by_id)
       VALUES ($1, $2, $3, 'r.pdf', 'application/pdf', 10, 'STORED', $4) RETURNING id`,
      [orgId, expense.id, `org/${orgId}/receipts/${expense.id}/r.pdf`, owner.id],
    );
    return {
      reportId: report.id as string,
      expenseId: expense.id as string,
      receiptId: receipt.rows[0].id as string,
    };
  });
}

beforeAll(async () => {
  await admin.query('TRUNCATE app_user, organization CASCADE');
  const o = await admin.query(
    "INSERT INTO organization (slug, name) VALUES ('access-co','Access Co') RETURNING id",
  );
  orgId = o.rows[0].id;
  await withOrg(orgId, async (tx) => {
    owner = await seedUser(tx, 'owner@access.test', 'EMPLOYEE');
    other = await seedUser(tx, 'other@access.test', 'EMPLOYEE');
    boss = await seedUser(tx, 'boss@access.test', 'ADMIN');
    manager = await seedUser(tx, 'manager@access.test', 'MANAGER');
    const c = await tx.query(
      "INSERT INTO expense_category (organization_id, code, label) VALUES ($1,'meals','Meals') RETURNING id",
      [orgId],
    );
    categoryId = c.rows[0].id;
  });
});

afterAll(async () => {
  await admin.end();
});

describe('report access', () => {
  it('lets the submitter and an admin in, and keeps everyone else out', async () => {
    const { reportId } = await draftWithReceipt();
    const access = (await withOrg(orgId, (tx) => expenses.getReportAccess(tx, reportId)))!;

    expect(expenses.canViewReport(owner, access)).toBe(true);
    expect(expenses.canViewReport(boss, access)).toBe(true);
    expect(expenses.canViewReport(other, access)).toBe(false);
    // A manager gets no reach over a report until the Phase-2 approval engine
    // defines what that reach is.
    expect(expenses.canViewReport(manager, access)).toBe(false);
  });

  it('stops editing once the report leaves DRAFT, for the admin too', async () => {
    const { reportId } = await draftWithReceipt();
    await withOrg(orgId, async (tx) => {
      await tx.query('DELETE FROM expense_policy');
      await lifecycle.submitReport(tx, reportId, owner.id);
    });
    const access = (await withOrg(orgId, (tx) => expenses.getReportAccess(tx, reportId)))!;

    expect(access.status).toBe('SUBMITTED');
    expect(expenses.canViewReport(owner, access)).toBe(true);
    expect(expenses.canEditReport(owner, access)).toBe(false);
    expect(expenses.canEditReport(boss, access)).toBe(false);
  });
});

describe('receipt ownership', () => {
  it('resolves the whole chain for an attached receipt', async () => {
    const { reportId, expenseId, receiptId } = await draftWithReceipt();
    const ownership = (await withOrg(orgId, (tx) => receipts.getReceiptOwnership(tx, receiptId)))!;
    expect(ownership).toMatchObject({
      receiptId,
      uploaderId: owner.id,
      expenseId,
      reportId,
      reportSubmitterId: owner.id,
      reportStatus: 'DRAFT',
    });
  });

  it('resolves an inbox receipt with nulls rather than failing the join', async () => {
    const receiptId = await withOrg(orgId, async (tx) => {
      const r = await tx.query(
        `INSERT INTO receipt (organization_id, s3_key, filename, content_type, size_bytes,
                              status, uploaded_by_id)
         VALUES ($1, $2, 'inbox.pdf', 'application/pdf', 10, 'STORED', $3) RETURNING id`,
        [orgId, `org/${orgId}/receipts/inbox/inbox.pdf`, owner.id],
      );
      return r.rows[0].id as string;
    });
    const ownership = (await withOrg(orgId, (tx) => receipts.getReceiptOwnership(tx, receiptId)))!;
    expect(ownership).toMatchObject({
      uploaderId: owner.id,
      expenseId: null,
      reportId: null,
      reportSubmitterId: null,
      reportStatus: null,
    });
    // An unattached receipt is nobody's business but its uploader's (and an admin's).
    expect(receipts.canViewReceipt(owner, ownership)).toBe(true);
    expect(receipts.canViewReceipt(boss, ownership)).toBe(true);
    expect(receipts.canViewReceipt(other, ownership)).toBe(false);
    // …and having no report means nothing freezes it.
    expect(receipts.canModifyReceipt(owner, ownership)).toBe(true);
  });

  it('refuses a colleague who merely holds the id', async () => {
    const { receiptId } = await draftWithReceipt();
    const ownership = (await withOrg(orgId, (tx) => receipts.getReceiptOwnership(tx, receiptId)))!;
    // This is the bug: RLS makes the row perfectly readable to `other`,
    // because they are in the same tenant.
    const visibleUnderRls = await withOrg(orgId, (tx) =>
      tx.query('SELECT id FROM receipt WHERE id = $1', [receiptId]),
    );
    expect(visibleUnderRls.rows).toHaveLength(1);

    expect(receipts.canViewReceipt(other, ownership)).toBe(false);
    expect(receipts.canModifyReceipt(other, ownership)).toBe(false);
  });

  it('lets the report submitter act on a receipt someone else uploaded', async () => {
    const { expenseId } = await draftWithReceipt();
    const receiptId = await withOrg(orgId, async (tx) => {
      const r = await tx.query(
        `INSERT INTO receipt (organization_id, expense_id, s3_key, filename, content_type,
                              size_bytes, status, uploaded_by_id)
         VALUES ($1, $2, $3, 'theirs.pdf', 'application/pdf', 10, 'STORED', $4) RETURNING id`,
        [orgId, expenseId, `org/${orgId}/receipts/${expenseId}/theirs.pdf`, other.id],
      );
      return r.rows[0].id as string;
    });
    const ownership = (await withOrg(orgId, (tx) => receipts.getReceiptOwnership(tx, receiptId)))!;
    // Uploaded by `other`, but it now sits on `owner`'s report — the
    // receipt-first flow depends on both being able to act.
    expect(receipts.canViewReceipt(other, ownership)).toBe(true);
    expect(receipts.canViewReceipt(owner, ownership)).toBe(true);
    expect(receipts.canViewReceipt(manager, ownership)).toBe(false);
  });

  it('freezes a receipt when its report is submitted', async () => {
    const { reportId, receiptId } = await draftWithReceipt();
    await withOrg(orgId, async (tx) => {
      await tx.query('DELETE FROM expense_policy');
      await lifecycle.submitReport(tx, reportId, owner.id);
    });
    const ownership = (await withOrg(orgId, (tx) => receipts.getReceiptOwnership(tx, receiptId)))!;

    expect(ownership.reportStatus).toBe('SUBMITTED');
    // Still readable by the people it belongs to…
    expect(receipts.canViewReceipt(owner, ownership)).toBe(true);
    expect(receipts.canViewReceipt(boss, ownership)).toBe(true);
    // …but a frozen report whose receipts can still be deleted is not frozen.
    expect(receipts.canModifyReceipt(owner, ownership)).toBe(false);
    expect(receipts.canModifyReceipt(boss, ownership)).toBe(false);
  });

  it('lets it be changed again after a recall', async () => {
    const { reportId, receiptId } = await draftWithReceipt();
    await withOrg(orgId, async (tx) => {
      await tx.query('DELETE FROM expense_policy');
      await lifecycle.submitReport(tx, reportId, owner.id);
      await lifecycle.recallReport(tx, reportId, owner.id, 'fixing a receipt');
    });
    const ownership = (await withOrg(orgId, (tx) => receipts.getReceiptOwnership(tx, receiptId)))!;
    expect(ownership.reportStatus).toBe('DRAFT');
    expect(receipts.canModifyReceipt(owner, ownership)).toBe(true);
  });
});
