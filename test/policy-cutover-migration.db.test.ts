/**
 * w4-02d — migration 0066 (the policy cutover), replayed against a database built to 0065
 * and seeded with v1 rules and findings, so the conversion is checked on real rows.
 *
 *   · each v1 rule kind becomes the ExpenseOS instance the migration's header names,
 *     keeping severity, enabled, category scope and window (a v1 end date becomes the
 *     start of the next day);
 *   · a threshold stated in another currency is converted at the tenant's latest rate
 *     (or the reciprocal of the opposite pair), and with no rate the migration refuses,
 *     naming the tenant;
 *   · findings on DRAFT / RETURNED reports go (the next validate writes them again);
 *     findings on other reports stay, gain their expense, and lose the v1 columns;
 *   · `expense_policy` is dropped and `policy_severity` kept.
 *
 * Its own database, because 0066 drops a table this suite's shared one no longer has.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';

const ROOT = process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL ?? '';
const NAME = `vxmig_0066_${process.pid}`;
const MIGRATIONS = readdirSync('prisma/migrations')
  .filter((d) => /^\d{4}_/.test(d))
  .sort();
const BEFORE = MIGRATIONS.filter((d) => d < '0066');
const CUTOVER = readFileSync('prisma/migrations/0066_policy_cutover/migration.sql', 'utf8');

/** The connection string with its database swapped. Not `new URL()`: a socket-path URL
 *  (`postgresql://postgres@/db?host=/tmp/sock`) has no host, which WHATWG URL refuses. */
const DSN = /^(postgres(?:ql)?:\/\/[^/]*\/)([^?]*)(.*)$/;
function urlFor(database: string): string {
  return ROOT.replace(DSN, `$1${database}$3`);
}

async function withClient<T>(database: string, fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: urlFor(database) });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

const maintenance = () => ROOT.match(DSN)?.[2] ?? 'postgres';

/** A fresh database at 0065, seeded by `seed`; returns its name. */
async function freshAt0065(suffix: string): Promise<string> {
  const name = `${NAME}_${suffix}`;
  await withClient(maintenance(), async (c) => {
    await c.query(`DROP DATABASE IF EXISTS ${name}`);
    await c.query(`CREATE DATABASE ${name}`);
  });
  await withClient(name, async (c) => {
    for (const m of BEFORE) await c.query(readFileSync(`prisma/migrations/${m}/migration.sql`, 'utf8'));
  });
  return name;
}

async function drop(name: string) {
  await withClient(maintenance(), (c) => c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`));
}

const ids: Record<string, string> = {};

/** One tenant (Alpha, policy currency CAD) with every v1 kind and some findings. */
async function seedAlpha(c: Client, opts: { eurRate: boolean }) {
  const one = async (sql: string, params: unknown[] = []) => (await c.query(sql, params)).rows[0];
  await c.query(`INSERT INTO currency (code, name, minor_unit) VALUES ('EUR','Euro',2), ('JPY','Yen',0) ON CONFLICT DO NOTHING`);
  ids.org = (await one(`INSERT INTO organization (name, slug) VALUES ('Alpha', 'alpha-mig') RETURNING id`)).id;
  ids.user = (await one(`INSERT INTO app_user (organization_id, email) VALUES ($1, 'a@alpha.test') RETURNING id`, [ids.org])).id;
  ids.meals = (
    await one(`INSERT INTO expense_category (organization_id, code, label) VALUES ($1, 'MEALS', '{"en":"Meals"}') RETURNING id`, [ids.org])
  ).id;
  ids.taxi = (
    await one(`INSERT INTO expense_category (organization_id, code, label) VALUES ($1, 'TAXI', '{"en":"Taxi"}') RETURNING id`, [ids.org])
  ).id;
  if (opts.eurRate) {
    await c.query(
      `INSERT INTO fx_rate (organization_id, base, quote, rate, fetched_at) VALUES
         ($1, 'EUR', 'CAD', 1.40, now() - interval '2 days'),
         ($1, 'EUR', 'CAD', 1.50, now() - interval '1 day'),
         ($1, 'CAD', 'JPY', 100, now())`,
      [ids.org],
    );
  }
  const rule = async (kind: string, severity: string, params: object, more: Record<string, unknown> = {}) =>
    (
      await one(
        `INSERT INTO expense_policy (organization_id, kind, severity, enabled, category_id, params, effective_from, effective_to, currency_code)
         VALUES ($1, $2, $3::policy_severity, $4, $5, $6::jsonb, $7::date, $8::date, $9) RETURNING id`,
        [
          ids.org,
          kind,
          severity,
          more.enabled ?? true,
          more.category ?? null,
          JSON.stringify(params),
          more.from ?? null,
          more.to ?? null,
          more.currency ?? null,
        ],
      )
    ).id as string;
  await rule('PER_TRANSACTION_LIMIT', 'WARNING', { thresholdMinor: 50000 });
  await rule('PER_TRANSACTION_LIMIT', 'BLOCK', { thresholdMinor: 7500 }, { category: ids.meals, from: '2026-01-01', to: '2026-12-31' });
  await rule('PER_TRANSACTION_LIMIT', 'WARNING', { thresholdMinor: 4000 }, { currency: 'EUR', enabled: false, category: ids.taxi });
  await rule('RECEIPT_REQUIRED', 'BLOCK', { thresholdMinor: 2500 }, { category: ids.meals });
  await rule('RECEIPT_REQUIRED', 'WARNING', {});
  await rule('BUDGET_OVERAGE', 'WARNING', {});
  await rule('CATEGORY_ACTIVE', 'BLOCK', {});
  await rule('NON_NEGATIVE_AMOUNT', 'BLOCK', {});

  // Findings: one on a DRAFT report, two on a SUBMITTED one (line-level and expense-level).
  const report = async (status: string) =>
    (
      await one(
        `INSERT INTO expense_report (organization_id, title, currency_code, submitter_id, status)
         VALUES ($1, $2, 'CAD', $3, $4::expense_report_status) RETURNING id`,
        [ids.org, `R ${status}`, ids.user, status],
      )
    ).id as string;
  ids.draft = await report('DRAFT');
  ids.submitted = await report('SUBMITTED');
  const expense = async (reportId: string) =>
    (
      await one(`INSERT INTO expense (organization_id, report_id, owner_id, currency_code) VALUES ($1, $2, $3, 'CAD') RETURNING id`, [
        ids.org,
        reportId,
        ids.user,
      ])
    ).id as string;
  ids.draftExpense = await expense(ids.draft);
  ids.submittedExpense = await expense(ids.submitted);
  const lineOf = async (expenseId: string) =>
    (
      await one(
        `INSERT INTO expense_line_item (organization_id, expense_id, category_id, amount_minor) VALUES ($1, $2, $3, 9000) RETURNING id`,
        [ids.org, expenseId, ids.meals],
      )
    ).id as string;
  ids.draftLine = await lineOf(ids.draftExpense);
  ids.submittedLine = await lineOf(ids.submittedExpense);
  const finding = (reportId: string, lineId: string | null, key: string, data: object) =>
    c.query(
      `INSERT INTO policy_violation (organization_id, report_id, line_item_id, rule_code, severity, message, finding_key, data, message_code)
       VALUES ($1, $2, $3, 'RECEIPT_REQUIRED', 'WARNING', 'Receipt required', $4, $5::jsonb, 'RECEIPT_MISSING')`,
      [ids.org, reportId, lineId, key, JSON.stringify(data)],
    );
  await finding(ids.draft, ids.draftLine, '', {});
  await finding(ids.submitted, ids.submittedLine, '', {});
  await finding(ids.submitted, null, ids.submittedExpense, { expenseId: ids.submittedExpense });
}

describe('0066 converts every v1 rule and reshapes the findings', () => {
  let name: string;
  const q = async (sql: string, params: unknown[] = []) =>
    withClient(name, async (c) => (await c.query(sql, params)).rows);

  beforeAll(async () => {
    name = await freshAt0065('ok');
    await withClient(name, async (c) => {
      await seedAlpha(c, { eurRate: true });
      await c.query('BEGIN');
      await c.query(CUTOVER);
      await c.query('COMMIT');
    });
  }, 120_000);
  afterAll(async () => {
    if (name) await drop(name);
  });

  it('writes one ExpenseOS instance per v1 rule, and none for NON_NEGATIVE_AMOUNT', async () => {
    const rules = await q(
      `SELECT kind_code, scope, severity::text, enabled, condition, params, message_key, category_id,
              effective_from, effective_to
         FROM policy_rule ORDER BY kind_code, severity, enabled DESC, category_id NULLS FIRST`,
    );
    const at = (iso: string) => new Date(iso);
    expect(rules).toEqual([
      {
        kind_code: 'BUDGET_OVERAGE', scope: 'AGGREGATE', severity: 'WARNING', enabled: true, condition: null,
        params: {}, message_key: 'budgetOverage', category_id: null, effective_from: at('1970-01-01T00:00:00Z'), effective_to: null,
      },
      {
        kind_code: 'CATEGORY_ACTIVE', scope: 'AGGREGATE', severity: 'BLOCK', enabled: true, condition: null,
        params: {}, message_key: 'categoryInactive', category_id: null, effective_from: at('1970-01-01T00:00:00Z'), effective_to: null,
      },
      // The category limit, BLOCK, with its window: the end date's whole day stays in force.
      {
        kind_code: 'PREDICATE_LINE', scope: 'LINE', severity: 'BLOCK', enabled: true,
        condition: { all: [{ field: 'lineAmount', op: 'gt', value: 7500 }] },
        params: {}, message_key: 'perTransactionLimit', category_id: ids.meals,
        effective_from: at('2026-01-01T00:00:00Z'), effective_to: at('2027-01-01T00:00:00Z'),
      },
      {
        kind_code: 'PREDICATE_LINE', scope: 'LINE', severity: 'WARNING', enabled: true,
        condition: { all: [{ field: 'lineAmount', op: 'gt', value: 50000 }] },
        params: {}, message_key: 'perTransactionLimit', category_id: null, effective_from: at('1970-01-01T00:00:00Z'), effective_to: null,
      },
      // €40.00 at the LATEST EUR→CAD rate (1.50, not 1.40): CA$60.00. Disabled stays disabled.
      {
        kind_code: 'PREDICATE_LINE', scope: 'LINE', severity: 'WARNING', enabled: false,
        condition: { all: [{ field: 'lineAmount', op: 'gt', value: 6000 }] },
        params: {}, message_key: 'perTransactionLimit', category_id: ids.taxi, effective_from: at('1970-01-01T00:00:00Z'), effective_to: null,
      },
      {
        kind_code: 'RECEIPT_THRESHOLD', scope: 'AGGREGATE', severity: 'BLOCK', enabled: true, condition: null,
        params: { thresholdMinor: '2500' }, message_key: 'receiptThreshold', category_id: ids.meals,
        effective_from: at('1970-01-01T00:00:00Z'), effective_to: null,
      },
      // No threshold in v1 means every expense: '0'.
      {
        kind_code: 'RECEIPT_THRESHOLD', scope: 'AGGREGATE', severity: 'WARNING', enabled: true, condition: null,
        params: { thresholdMinor: '0' }, message_key: 'receiptThreshold', category_id: null,
        effective_from: at('1970-01-01T00:00:00Z'), effective_to: null,
      },
    ]);
    expect((await q(`SELECT DISTINCT organization_id FROM policy_rule`)).map((r) => r.organization_id)).toEqual([ids.org]);
  });

  it('keeps findings on reports past DRAFT, anchored to their expense, and drops the rest', async () => {
    const rows = await q(`SELECT report_id, line_item_id, expense_id FROM policy_violation ORDER BY line_item_id NULLS LAST`);
    expect(rows).toEqual([
      { report_id: ids.submitted, line_item_id: ids.submittedLine, expense_id: ids.submittedExpense },
      { report_id: ids.submitted, line_item_id: null, expense_id: ids.submittedExpense },
    ]);
    const cols = (
      await q(`SELECT column_name FROM information_schema.columns WHERE table_name = 'policy_violation'`)
    ).map((r) => r.column_name);
    expect(cols).toEqual(expect.arrayContaining(['expense_id', 'rule_code', 'resolved_by_id']));
    for (const gone of ['policy_id', 'finding_key', 'message_code']) expect(cols).not.toContain(gone);
  });

  it('drops expense_policy and keeps policy_severity', async () => {
    expect(await q(`SELECT to_regclass('expense_policy') AS t`)).toEqual([{ t: null }]);
    expect(await q(`SELECT count(*)::int AS n FROM pg_type WHERE typname = 'policy_severity'`)).toEqual([{ n: 1 }]);
  });
});

describe('0066 refuses a threshold it cannot convert', () => {
  let name: string;
  beforeAll(async () => {
    name = await freshAt0065('norate');
    await withClient(name, (c) => seedAlpha(c, { eurRate: false }));
  }, 120_000);
  afterAll(async () => {
    if (name) await drop(name);
  });

  it('names the tenant, the rule and the currencies, and changes nothing', async () => {
    await withClient(name, async (c) => {
      await c.query('BEGIN');
      await expect(c.query(CUTOVER)).rejects.toThrow(
        /tenant alpha-mig has a PER_TRANSACTION_LIMIT rule stated in EUR and no FX rate between EUR and its policy currency CAD/,
      );
      await c.query('ROLLBACK');
      expect((await c.query(`SELECT count(*)::int AS n FROM expense_policy`)).rows[0].n).toBe(8);
      expect((await c.query(`SELECT count(*)::int AS n FROM policy_rule`)).rows[0].n).toBe(0);
    });
  });
});
