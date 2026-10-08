/**
 * UD-11 — the regression guard, and it is a DATABASE test on purpose.
 *
 * Own org slug ('editaudit-co'); the DB suites share one database and each
 * TRUNCATEs (vitest.config.ts, fileParallelism: false).
 *
 * The audit says "the from side comes out of the row itself, and a stubbed read
 * would prove only that the code reads something". That is the whole design
 * constraint: `auditDiff` is pure and unit-tested next door, so what is left to
 * prove is that the service reads the row BEFORE it writes, that the entry lands
 * in the SAME transaction, and that the values in `details` are the ones the
 * table actually held. None of that survives a mock.
 *
 * Real seeded employees with real ids here, not `TEST_ACTOR` — "who edited this"
 * is the question under test, and an anonymous stand-in would answer it
 * vacuously. That distinction is the whole reason `TEST_ACTOR` carries a comment
 * saying what it is not for.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { Pool } from 'pg';
import { withOrg } from '@/lib/tenant/context';
import * as svc from '@/lib/expenses/service';
import { auditActorOf } from '@/lib/audit/service';
import { verifyChain } from '@/lib/audit/verify';
import type { AuditActor } from '@/lib/audit/service';
import { TODAY } from './support/dates';

const admin = new Pool({
  connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL,
});

let orgId: string;
let categoryId: string;
let otherCategoryId: string;
let owner: AuditActor;
let ownerEmail: string;

interface Entry {
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  actor_id: string | null;
  actor_name: string;
  actor_role: string;
  details: Record<string, unknown>;
  sequence: string;
}

/** This tenant's chain, oldest first. ORDER BY sequence — `id` is a random uuid. */
async function entries(): Promise<Entry[]> {
  const r = await admin.query(
    `SELECT action, entity_type, entity_id, actor_id, actor_name, actor_role, details, sequence
       FROM audit_entry WHERE organization_id = $1 ORDER BY sequence`,
    [orgId],
  );
  return r.rows as Entry[];
}

const last = async (): Promise<Entry> => {
  const all = await entries();
  expect(all.length, 'expected at least one audit entry').toBeGreaterThan(0);
  return all[all.length - 1];
};

/** A fresh DRAFT report with one expense and one line item, and no audit noise. */
async function seedReport(): Promise<{ reportId: string; expenseId: string; lineId: string }> {
  const made = await withOrg(orgId, async (tx) => {
    const report = await svc.createReport(tx, ownerEmail, {
      title: 'Toronto trip',
      currencyCode: 'CAD',
      purpose: 'Client visit',
    });
    const expense = await svc.addExpense(tx, owner, report.id, { txnDate: TODAY,
      currencyCode: 'CAD',
      merchant: 'Adobe',
    });
    const line = await svc.addLineItem(tx, owner, expense.id, {
      categoryId,
      amountMinor: 7419,
      description: 'Design tools',
    });
    return { reportId: report.id as string, expenseId: expense.id as string, lineId: line.id as string };
  });
  await clearChain();
  return made;
}

/** The purge hatch, in ONE statement so it runs on one pooled connection. */
async function clearChain() {
  await admin.query(
    `BEGIN;
     SELECT set_config('app.audit_purge', 'on', true);
     DELETE FROM audit_entry;
     COMMIT;`,
  );
}

beforeAll(async () => {
  await admin.query('TRUNCATE app_user, organization CASCADE');
  const o = await admin.query(
    "INSERT INTO organization (slug, name) VALUES ('editaudit-co','Edit Audit Co') RETURNING id",
  );
  orgId = o.rows[0].id;
  ownerEmail = 'owner@editaudit.test';

  // VX4-1: ABSENCE MEANS OFF. `gl_account`'s RLS policy is `… AND
  // app_module_enabled('accounting')` (0022's backstop), so without this row the
  // chart of accounts is unwritable and unreadable for this tenant — which is the
  // backstop working, and is how the GL assertion below first failed.
  await admin.query(
    `INSERT INTO module_entitlement (organization_id, module_code, enabled)
     VALUES ($1, 'accounting', true)`,
    [orgId],
  );
  await withOrg(orgId, async (tx) => {
    const u = await tx.query(
      `INSERT INTO app_user (organization_id, email, display_name, role)
       VALUES ($1, $2, 'Ada Owner', 'EMPLOYEE') RETURNING id, email, display_name, role`,
      [orgId, ownerEmail],
    );
    owner = auditActorOf(u.rows[0]);
    const c = await tx.query(
      `INSERT INTO expense_category (organization_id, code, label) VALUES
         ($1,'meals','{"en":"Meals"}'), ($1,'travel','{"en":"Travel"}') RETURNING id, code`,
      [orgId],
    );
    categoryId = c.rows.find((r: { code: string }) => r.code === 'meals').id;
    otherCategoryId = c.rows.find((r: { code: string }) => r.code === 'travel').id;

    // Two postable GL accounts, one per category. Without them
    // `accountForCategory` returns null for both, `gl_account_id` is null on
    // each side of a re-coding, and the AC-10 assertion below passes over a
    // field that never changed — which is how a test proves nothing. The first
    // run of that test failed for exactly this reason, which is the argument for
    // asserting on `fields` rather than on "something changed".
    const g = await tx.query(
      `INSERT INTO gl_account (organization_id, number, name, type, is_postable, active)
       VALUES ($1,'6010','Meals & Entertainment','expense',true,true),
              ($1,'6020','Travel','expense',true,true)
       RETURNING id, number`,
      [orgId],
    );
    const accountOf = (number: string) =>
      g.rows.find((r: { number: string }) => r.number === number).id;
    await tx.query('UPDATE expense_category SET gl_account_id = $2 WHERE id = $1', [
      categoryId,
      accountOf('6010'),
    ]);
    await tx.query('UPDATE expense_category SET gl_account_id = $2 WHERE id = $1', [
      otherCategoryId,
      accountOf('6020'),
    ]);
  });
});

beforeEach(clearChain);

afterAll(async () => {
  await admin.end();
});

describe('an edit records what changed, and from what', () => {
  it('names the field, both sides, and the person — from the row, not the patch', async () => {
    const { lineId } = await seedReport();
    await withOrg(orgId, (tx) =>
      svc.updateLineItem(tx, owner, lineId, { amountMinor: 9900, description: 'Design tools' }),
    );

    const e = await last();
    expect(e.action).toBe('LINE_ITEM_EDITED');
    expect(e.entity_type).toBe('ExpenseLineItem');
    expect(e.entity_id).toBe(lineId);
    // The actor is frozen into the row: a later rename cannot rewrite history.
    expect(e.actor_id).toBe(owner.id);
    expect(e.actor_name).toBe('Ada Owner');
    expect(e.actor_role).toBe('EMPLOYEE');
    // `amount_minor` only — `description` was re-sent unchanged, and re-sending a
    // value is not an edit. This is the assertion the old detail shape
    // (`fields: Object.keys(input)`) could not have passed.
    expect(e.details.fields).toEqual(['amount_minor']);
    expect((e.details.changed as Record<string, unknown>).amount_minor).toEqual({
      from: '7419',
      to: '9900',
    });
    expect(e.details.unchanged).toBe(false);
  });

  it('records a save that changed nothing, and says it changed nothing', async () => {
    const { lineId } = await seedReport();
    await withOrg(orgId, (tx) =>
      svc.updateLineItem(tx, owner, lineId, { description: 'Design tools' }),
    );
    const e = await last();
    expect(e.action).toBe('LINE_ITEM_EDITED');
    expect(e.details.unchanged).toBe(true);
    expect(e.details.fields).toEqual([]);
  });

  it('records a patch that named no column at all — the visit, not an edit', async () => {
    // `sets.length === 0` returns early. It must still append: an audit log that
    // drops the no-op cannot distinguish "opened it and pressed Save" from
    // "nothing happened", and the early return is the easiest place to lose it.
    const { reportId } = await seedReport();
    await withOrg(orgId, (tx) => svc.updateReport(tx, owner, reportId, {}));
    const e = await last();
    expect(e.action).toBe('REPORT_EDITED');
    expect(e.details.unchanged).toBe(true);
  });

  it('records the STORED value, not the typed one — the title is trimmed on the way in', async () => {
    // The row-vs-row diff earns its keep here: a patch diff would record
    // '  Renamed  ' as the new title, which is not what the table holds.
    const { reportId } = await seedReport();
    await withOrg(orgId, (tx) => svc.updateReport(tx, owner, reportId, { title: '  Renamed  ' }));
    const e = await last();
    expect((e.details.changed as Record<string, unknown>).title).toEqual({
      from: 'Toronto trip',
      to: 'Renamed',
    });
  });

  it('records the GL account re-stamp, which no caller ever names', async () => {
    // AC-10: changing the category re-stamps `gl_account_id`. A patch-shaped diff
    // would record a re-coding without recording the account the money moved to,
    // and that is the one column an accountant would check.
    const { lineId } = await seedReport();
    await withOrg(orgId, (tx) =>
      svc.updateLineItem(tx, owner, lineId, { categoryId: otherCategoryId }),
    );
    const e = await last();
    expect(e.details.fields).toContain('category_id');
    expect(e.details.fields).toContain('gl_account_id');
  });

  it('counts the child rows a currency change rewrote in another table', async () => {
    // The write no row diff can see. One click, N rows in `expense`.
    const { reportId } = await seedReport();
    await withOrg(orgId, async (tx) => {
      await svc.addExpense(tx, owner, reportId, { txnDate: TODAY, currencyCode: 'CAD', merchant: 'Second' });
    });
    await clearChain();
    await withOrg(orgId, (tx) => svc.updateReport(tx, owner, reportId, { currencyCode: 'USD' }));
    const e = await last();
    expect((e.details.changed as Record<string, unknown>).currency_code).toEqual({
      from: 'CAD',
      to: 'USD',
    });
    expect(e.details.cascaded_expense_currency).toBe(2);
  });

  it('does not report the derived report total as an edit to the report', async () => {
    // `recomputeReportTotal` rewrites `total_minor` after every line-item change.
    // Reporting it would log one event twice, the second time against the wrong row.
    const { expenseId } = await seedReport();
    await withOrg(orgId, (tx) =>
      svc.addLineItem(tx, owner, expenseId, { categoryId, amountMinor: 100 }),
    );
    const all = await entries();
    expect(all.map((x) => x.action)).toEqual(['LINE_ITEM_ADDED']);
  });
});

/**
 * ── THE GAP A SABOTAGE FOUND, WHICH IS WHY THESE EXIST ─────────────────────
 *
 * Deleting `addExpense`'s audit append outright failed NOTHING: 1329 tests
 * passed with an entire write path recording nothing. The tests above all drive
 * line items and report headers, and `seedReport` purges the chain afterwards —
 * so the one path that creates an expense had no assertion anywhere.
 *
 * That is the house rule doing its job: when a sabotage fails fewer tests than
 * expected, the surviving tests are the finding. One assertion per audited
 * action, so no path can go quiet again.
 */
describe('every audited write actually writes', () => {
  it('records EXPENSE_ADDED, with what was added', async () => {
    const { reportId } = await seedReport();
    const expenseId = await withOrg(orgId, async (tx) => {
      const e = await svc.addExpense(tx, owner, reportId, { txnDate: TODAY,
        currencyCode: 'CAD',
        merchant: 'Air Canada',
      });
      return e.id as string;
    });
    const e = await last();
    expect(e.action).toBe('EXPENSE_ADDED');
    expect(e.entity_type).toBe('Expense');
    expect(e.entity_id).toBe(expenseId);
    expect(e.details.report_id).toBe(reportId);
    expect((e.details.added as Record<string, unknown>).merchant).toBe('Air Canada');
  });

  it('records LINE_ITEM_ADDED, with the amount', async () => {
    const { reportId, expenseId } = await seedReport();
    await withOrg(orgId, (tx) =>
      svc.addLineItem(tx, owner, expenseId, { categoryId, amountMinor: 2599 }),
    );
    const e = await last();
    expect(e.action).toBe('LINE_ITEM_ADDED');
    expect(e.details.report_id).toBe(reportId);
    expect(e.details.expense_id).toBe(expenseId);
    expect((e.details.added as Record<string, unknown>).amount_minor).toBe('2599');
  });

  it('records EXPENSE_EDITED, from the row', async () => {
    const { expenseId } = await seedReport();
    await withOrg(orgId, (tx) =>
      svc.updateExpense(tx, owner, expenseId, { merchant: 'Adobe Inc.' }),
    );
    const e = await last();
    expect(e.action).toBe('EXPENSE_EDITED');
    expect(e.entity_id).toBe(expenseId);
    expect((e.details.changed as Record<string, unknown>).merchant).toEqual({
      from: 'Adobe',
      to: 'Adobe Inc.',
    });
  });

  it('records REPORT_DELETED on the path that succeeds, with the report snapshotted', async () => {
    // The refusal case is below. This is the one that actually deletes, and the
    // snapshot is the only remaining evidence of what the report was.
    const { reportId } = await seedReport();
    await withOrg(orgId, (tx) => svc.deleteReport(tx, owner, reportId));
    const e = await last();
    expect(e.action).toBe('REPORT_DELETED');
    expect(e.entity_id).toBe(reportId);
    const deleted = e.details.deleted as Record<string, unknown>;
    expect(deleted.title).toBe('Toronto trip');
    expect(deleted.purpose).toBe('Client visit');
  });

  it('names all eight audited actions across the life of one report', async () => {
    // The list is the guard: an audited path that stops appending drops out of
    // this, and a NEW write path that forgets to audit never appears in it. Both
    // are the failure this ticket exists to prevent.
    const { reportId } = await seedReport();
    await withOrg(orgId, async (tx) => {
      await svc.updateReport(tx, owner, reportId, { title: 'Renamed' });
      const e = await svc.addExpense(tx, owner, reportId, { txnDate: TODAY, currencyCode: 'CAD' });
      await svc.updateExpense(tx, owner, e.id, { merchant: 'Beck' });
      const l = await svc.addLineItem(tx, owner, e.id, { categoryId, amountMinor: 500 });
      await svc.updateLineItem(tx, owner, l.id, { amountMinor: 600 });
      await svc.removeLineItem(tx, owner, l.id);
      await svc.removeExpense(tx, owner, e.id);
      await svc.deleteReport(tx, owner, reportId);
    });
    expect((await entries()).map((x) => x.action)).toEqual([
      'REPORT_EDITED',
      'EXPENSE_ADDED',
      'EXPENSE_EDITED',
      'LINE_ITEM_ADDED',
      'LINE_ITEM_EDITED',
      'LINE_ITEM_REMOVED',
      'EXPENSE_REMOVED',
      'REPORT_DELETED',
    ]);
  });
});

describe('a deletion says what was deleted', () => {
  it('snapshots the line item, because afterwards there is nothing to read', async () => {
    const { lineId } = await seedReport();
    await withOrg(orgId, (tx) => svc.removeLineItem(tx, owner, lineId));
    const e = await last();
    expect(e.action).toBe('LINE_ITEM_REMOVED');
    const deleted = e.details.deleted as Record<string, unknown>;
    expect(deleted.amount_minor).toBe('7419');
    expect(deleted.description).toBe('Design tools');
    // Not the derived/mechanical columns.
    expect(deleted).not.toHaveProperty('updated_at');
  });

  it('snapshots the line items that went down with an expense', async () => {
    // ON DELETE CASCADE removes them without a statement of their own. "The
    // expense was deleted" does not tell an auditor what was on it.
    const { expenseId } = await seedReport();
    await withOrg(orgId, (tx) => svc.removeExpense(tx, owner, expenseId));
    const e = await last();
    expect(e.action).toBe('EXPENSE_REMOVED');
    const lines = e.details.deleted_line_items as Record<string, unknown>[];
    expect(lines).toHaveLength(1);
    expect(lines[0].amount_minor).toBe('7419');
  });

  it('refuses to log a report deletion that did not happen', async () => {
    // The conditional-write idiom. `assertDraft` ran, but the DELETE is what
    // decides — and an audit row for a deletion that deleted nothing is worse
    // than no row at all.
    const { reportId } = await seedReport();
    await admin.query("UPDATE expense_report SET status = 'SUBMITTED' WHERE id = $1", [reportId]);
    await expect(
      withOrg(orgId, (tx) => svc.deleteReport(tx, owner, reportId)),
    ).rejects.toMatchObject({ code: 'NOT_DRAFT' });
    expect(await entries()).toHaveLength(0);
  });
});

describe('the chain', () => {
  it('still verifies with edit details in the hash payload', async () => {
    // Ours are INSIDE the payload (AU-3), unlike upstream's. So a diff that
    // canonical() cannot render is not a logging bug, it is a failed transaction
    // and a rolled-back edit (AU-5). Amounts and dates both, in one chain.
    const { reportId, lineId } = await seedReport();
    await withOrg(orgId, async (tx) => {
      await svc.updateLineItem(tx, owner, lineId, { amountMinor: 4100 });
      await svc.updateReport(tx, owner, reportId, { purpose: null });
    });
    // `verifyChain` is tenant-scoped by RLS inside `withOrg`, so the window needs
    // no organization id — the rows it can see are this tenant's.
    const result = await withOrg(orgId, (tx) => verifyChain(tx));
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(result.scanned).toBe(2);
  });
});
