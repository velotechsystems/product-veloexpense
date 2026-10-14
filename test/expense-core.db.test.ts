/**
 * Wave 2, slice 1 (w2-00) — the expense core reshaped to ExpenseOS's fields
 * (migration 0054), against a real database.
 *
 *   · `tax_jurisdiction` is GLOBAL and platform-seeded (d24): the app role reads
 *     ExpenseOS's 64 rows, with ExpenseOS's ids and rates, and can write none of
 *     them — a tenant's request must not change every other tenant's tax;
 *   · an expense inserted without an owner takes its report's submitter (VeloExpense's
 *     own writer predates the column); one that names an owner keeps it;
 *   · ExpenseOS's enums are CHECKs: a value outside them is refused;
 *   · an allocation holds 1–10000 basis points;
 *   · VeloExpense's writer keeps ExpenseOS's invariant — an expense's `amount_minor`
 *     is the sum of its line items — through add, update and remove;
 *   · the Prisma view reads the reshaped tables as ExpenseOS's models, relations
 *     included, inside the tenant scope.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { withOrg } from '@/lib/tenant/context';
import { withTenantDb, db } from '@/lib/db/prisma';
import * as expenses from '@/lib/expenses/service';
import { TEST_ACTOR } from './support/audit-actor';
import { TODAY } from './support/dates';

const admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL });
/** The app role, under RLS exactly as the app is. */
const app = new Pool({ connectionString: process.env.DATABASE_URL });

let orgId: string;
let submitterId: string;
let otherId: string;
let categoryId: string;
const SUBMITTER = 'sub@core.test';

async function draft() {
  return withOrg(orgId, async (tx) => {
    const report = await expenses.createReport(tx, SUBMITTER, { title: 'Core', currencyCode: 'CAD' });
    const expense = await expenses.addExpense(tx, TEST_ACTOR, report.id, {
      txnDate: TODAY,
      currencyCode: 'CAD',
      merchant: 'M',
    });
    return { reportId: report.id as string, expenseId: expense.id as string };
  });
}

const amountOf = async (expenseId: string) =>
  BigInt(
    (await withOrg(orgId, (tx) => tx.query('SELECT amount_minor FROM expense WHERE id = $1', [expenseId]))).rows[0]
      .amount_minor,
  );

beforeAll(async () => {
  await admin.query('TRUNCATE app_user, organization CASCADE');
  orgId = (await admin.query("INSERT INTO organization (slug, name) VALUES ('core-co','Core Co') RETURNING id")).rows[0]
    .id;
  await withOrg(orgId, async (tx) => {
    submitterId = (
      await tx.query(
        `INSERT INTO app_user (organization_id, email, display_name, role_id) VALUES ($1, $2, 'Sub', '019e3000-0000-7000-8000-000000000004') RETURNING id`,
        [orgId, SUBMITTER],
      )
    ).rows[0].id;
    otherId = (
      await tx.query(
        `INSERT INTO app_user (organization_id, email, display_name, role_id) VALUES ($1, 'other@core.test', 'Other', '019e3000-0000-7000-8000-000000000004') RETURNING id`,
        [orgId],
      )
    ).rows[0].id;
    categoryId = (
      await tx.query(`INSERT INTO expense_category (organization_id, code, label) VALUES ($1, 'core', '{"en":"Core"}') RETURNING id`, [
        orgId,
      ])
    ).rows[0].id;
  });
});

afterAll(async () => {
  await admin.end();
  await app.end();
});

describe('tax_jurisdiction (global, platform-seeded)', () => {
  it("holds ExpenseOS's 64 jurisdictions, with its ids and rates, readable by the app role", async () => {
    const all = await app.query('SELECT count(*)::int AS n, count(DISTINCT country_code)::int AS countries FROM tax_jurisdiction');
    expect(all.rows[0]).toEqual({ n: 64, countries: 2 });
    const qc = (
      await app.query(
        `SELECT id, label, gst_rate::text, qst_rate::text, tax_type, version
           FROM tax_jurisdiction WHERE country_code = 'CA' AND code = 'QC'`,
      )
    ).rows[0];
    expect(qc).toEqual({
      id: '82591dbc-b0d9-4139-85a9-b86f38c2dcde',
      label: { en: 'Quebec', 'fr-CA': 'Québec' },
      gst_rate: '5.000',
      qst_rate: '9.975',
      tax_type: 'GST+QST',
      version: '2026.1',
    });
    // Readable inside a tenant scope too — it is not filtered by one.
    const scoped = await withOrg(orgId, (tx) => tx.query('SELECT count(*)::int AS n FROM tax_jurisdiction'));
    expect(scoped.rows[0].n).toBe(64);
  });

  it('cannot be written by the app role, inside a tenant scope or out of one', async () => {
    const attempts = [
      `INSERT INTO tax_jurisdiction (country_code, code, label, tax_type) VALUES ('CA', 'ZZ', '{"en":"Z"}', 'GST')`,
      `UPDATE tax_jurisdiction SET gst_rate = 0 WHERE code = 'ON'`,
      `DELETE FROM tax_jurisdiction WHERE code = 'ON'`,
    ];
    for (const sql of attempts) {
      const out = await app.query(sql).then(
        (r) => `ok:${r.rowCount}`,
        (e: Error) => e.message,
      );
      // An INSERT is refused; an UPDATE or DELETE sees no row it may change.
      expect(out, sql).toMatch(/row-level security|ok:0/);
      const scoped = await withOrg(orgId, (tx) => tx.query(sql)).then(
        (r) => `ok:${r.rowCount}`,
        (e: Error) => e.message,
      );
      expect(scoped, sql).toMatch(/row-level security|ok:0/);
    }
    const on = await app.query(`SELECT hst_rate::text FROM tax_jurisdiction WHERE country_code = 'CA' AND code = 'ON'`);
    expect(on.rows).toEqual([{ hst_rate: '13.000' }]);
  });
});

describe('expense', () => {
  it("takes its report's submitter as owner when none is named, and keeps one that is", async () => {
    const { reportId, expenseId } = await draft();
    const owner = await withOrg(orgId, (tx) => tx.query('SELECT owner_id FROM expense WHERE id = $1', [expenseId]));
    expect(owner.rows[0].owner_id).toBe(submitterId);

    const named = await withOrg(orgId, (tx) =>
      tx.query(
        `INSERT INTO expense (organization_id, report_id, currency_code, owner_id) VALUES ($1, $2, 'CAD', $3) RETURNING owner_id`,
        [orgId, reportId, otherId],
      ),
    );
    expect(named.rows[0].owner_id).toBe(otherId);
  });

  it("refuses values outside ExpenseOS's enums", async () => {
    const { expenseId } = await draft();
    for (const [table, col, value] of [
      ['expense', 'payment_method', 'CASH'],
      ['expense', 'tax_source', 'GUESSED'],
      ['expense', 'fx_rate_source', 'GUESSED'],
      ['expense_line_item', 'kind', 'PER_DIEM'],
      ['expense_line_item', 'mileage_unit', 'FURLONG'],
      ['receipt', 'kind', 'PHOTO'],
    ] as const) {
      const where = table === 'expense' ? 'id' : 'expense_id';
      if (table !== 'expense') {
        await withOrg(orgId, (tx) =>
          table === 'expense_line_item'
            ? expenses.addLineItem(tx, TEST_ACTOR, expenseId, { categoryId, amountMinor: 1 })
            : tx.query(
                `INSERT INTO receipt (organization_id, expense_id, s3_key, filename, content_type, uploaded_by_id)
                 VALUES ($1, $2, $3, 'r.pdf', 'application/pdf', $4)
                 ON CONFLICT DO NOTHING`,
                [orgId, expenseId, `org/${orgId}/receipts/${expenseId}/r.pdf`, submitterId],
              ),
        );
      }
      await expect(
        withOrg(orgId, (tx) => tx.query(`UPDATE ${table} SET ${col} = $1 WHERE ${where} = $2`, [value, expenseId])),
        `${table}.${col}`,
      ).rejects.toThrow(/check constraint/i);
    }
  });

  it('holds an allocation to 1–10000 basis points', async () => {
    const { expenseId } = await draft();
    for (const bp of [0, 10001, -5]) {
      await expect(
        withOrg(orgId, (tx) =>
          tx.query(`INSERT INTO expense_allocation (organization_id, expense_id, percent_bp) VALUES ($1, $2, $3)`, [
            orgId,
            expenseId,
            bp,
          ]),
        ),
        String(bp),
      ).rejects.toThrow(/expense_allocation_percent_bp/);
    }
  });
});

describe("VeloExpense's writer keeps ExpenseOS's invariant (amount = sum of lines)", () => {
  it('through add, update and remove', async () => {
    const { expenseId } = await draft();
    expect(await amountOf(expenseId)).toBe(0n);

    const first = await withOrg(orgId, (tx) =>
      expenses.addLineItem(tx, TEST_ACTOR, expenseId, { categoryId, amountMinor: 12_34 }),
    );
    await withOrg(orgId, (tx) => expenses.addLineItem(tx, TEST_ACTOR, expenseId, { categoryId, amountMinor: 5_00 }));
    expect(await amountOf(expenseId)).toBe(17_34n);

    await withOrg(orgId, (tx) => expenses.updateLineItem(tx, TEST_ACTOR, first.id, { amountMinor: 2_00 }));
    expect(await amountOf(expenseId)).toBe(7_00n);

    await withOrg(orgId, (tx) => expenses.removeLineItem(tx, TEST_ACTOR, first.id));
    expect(await amountOf(expenseId)).toBe(5_00n);
  });
});

describe("the Prisma view reads the reshaped tables as ExpenseOS's models", () => {
  it('report → expenses → lines, allocations, attendees, receipts and jurisdiction', async () => {
    const { reportId, expenseId } = await draft();
    await withOrg(orgId, async (tx) => {
      await expenses.addLineItem(tx, TEST_ACTOR, expenseId, { categoryId, amountMinor: 42_00, description: 'Dinner' });
      await tx.query(
        `UPDATE expense SET tax_jurisdiction_id = (SELECT id FROM tax_jurisdiction WHERE country_code = 'CA' AND code = 'ON'),
                            purpose = 'Client dinner'
          WHERE id = $1`,
        [expenseId],
      );
      await tx.query(`INSERT INTO expense_allocation (organization_id, expense_id, percent_bp) VALUES ($1, $2, 10000)`, [
        orgId,
        expenseId,
      ]);
      await tx.query(
        `INSERT INTO expense_attendee (organization_id, expense_id, name, company, is_external) VALUES ($1, $2, 'Pat', 'Client Co', true)`,
        [orgId, expenseId],
      );
    });

    const report = await withTenantDb(orgId, () =>
      db.expenseReport.findUniqueOrThrow({
        where: { id: reportId },
        include: {
          submitter: { select: { email: true } },
          expenses: {
            include: {
              lineItems: { include: { category: { select: { code: true } } } },
              allocations: true,
              attendees: true,
              receipts: true,
              taxJurisdiction: { select: { code: true } },
              owner: { select: { id: true } },
            },
          },
        },
      }),
    );
    expect(report.status).toBe('DRAFT');
    expect(report.currencyId).toBe('CAD');
    expect(report.submitter.email).toBe(SUBMITTER);
    const [e] = report.expenses;
    expect(e).toMatchObject({
      amountMinor: 42_00n,
      currencyId: 'CAD',
      ownerId: submitterId,
      paymentMethod: 'OUT_OF_POCKET',
      taxSource: 'CALCULATED',
      purpose: 'Client dinner',
      taxJurisdiction: { code: 'ON' },
    });
    expect(e.lineItems).toHaveLength(1);
    expect(e.lineItems[0]).toMatchObject({ kind: 'STANDARD', notes: 'Dinner', category: { code: 'core' } });
    expect(e.allocations.map((a) => a.percentBp)).toEqual([10000]);
    expect(e.attendees).toEqual([expect.objectContaining({ name: 'Pat', company: 'Client Co', isExternal: true })]);
    expect(e.receipts).toEqual([]);
  });
});
