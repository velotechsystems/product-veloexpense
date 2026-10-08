/**
 * VX4-8 part 2 — the four detectors and the scan, against a real Postgres.
 * Own org slug ('fraud-co').
 *
 * ── WHAT EACH GROUP IS FOR ──────────────────────────────────────────────────
 *
 * `duplicates` is the rule with the most ported reasoning and the most ways to
 * be subtly wrong: one finding per expense rather than per pair, the LATER copy
 * flagged, merchants compared case-insensitively, and an expense with no lines
 * excluded rather than treated as zero. Each of those is a separate `it`, because
 * a single "it finds the duplicate" would pass with three of the four broken.
 *
 * `the scan` is the reconciliation, and its third case is the one worth the file:
 * a flag a person has DISMISSED must survive the next scan untouched. That is
 * enforced by `ON CONFLICT ... WHERE status = 'ACTIVE'` rather than by a
 * read-then-write, so the test drives the real statement rather than a branch.
 */
process.env.INTEGRATIONS_ENABLE_STUB = '1';
process.env.SECRET_ENCRYPTION_KEY =
  process.env.SECRET_ENCRYPTION_KEY ?? Buffer.alloc(32, 9).toString('base64');

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { Pool } from 'pg';
import { withOrg } from '@/lib/tenant/context';
import {
  DEFAULT_FRAUD_CONFIG,
  DETECTORS,
  FRAUD_RULES,
  detectAmountOutliers,
  detectApproverConcentration,
  detectDuplicates,
  detectViolationDensity,
  loadFraudConfig,
  resolveFraudConfig,
  type FraudConfig,
} from '@/lib/fraud/rules';
import { runFraudScan } from '@/lib/fraud/scan';
import {
  FRAUD_MESSAGES,
  FRAUD_MESSAGE_CODES,
  renderFraudMessage,
} from '@/lib/i18n/catalog/fraud-messages';
import { SUPPORTED_LOCALES } from '@/lib/i18n/locales';
import { isModuleDisabled } from '@/lib/modules/errors';

const admin = new Pool({
  connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL,
});

let orgId: string;
let submitterId: string;
let approverId: string;
let otherApproverId: string;
let categoryId: string;

/** A date `n` days ago, as YYYY-MM-DD — the shape `expense.txn_date` holds. */
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

const cfg: FraudConfig = DEFAULT_FRAUD_CONFIG;

async function report(title: string, opts: { submitter?: string } = {}): Promise<string> {
  return withOrg(orgId, async (tx) => {
    const r = await tx.query(
      `INSERT INTO expense_report (organization_id, submitter_id, title, currency_code,
                                   status, number, total_minor)
       VALUES ($1, $2, $3, 'CAD', 'DRAFT', $4, 0) RETURNING id`,
      [orgId, opts.submitter ?? submitterId, title, `EXP-${Math.floor(Math.random() * 1e6)}`],
    );
    return r.rows[0].id as string;
  });
}

/** An expense with ONE line, which is the ordinary case. `lines: 0` makes none. */
async function expense(
  reportId: string,
  opts: { merchant: string | null; date: string; amountMinor?: number; lines?: number },
): Promise<string> {
  return withOrg(orgId, async (tx) => {
    const e = await tx.query(
      `INSERT INTO expense (organization_id, report_id, merchant, txn_date, currency_code)
       VALUES ($1, $2, $3, $4::date, 'CAD') RETURNING id`,
      [orgId, reportId, opts.merchant, opts.date],
    );
    const id = e.rows[0].id as string;
    const lines = opts.lines ?? 1;
    for (let i = 0; i < lines; i += 1) {
      await tx.query(
        `INSERT INTO expense_line_item (organization_id, expense_id, category_id, amount_minor, description)
         VALUES ($1, $2, $3, $4, 'a line')`,
        [orgId, id, categoryId, Math.round((opts.amountMinor ?? 5000) / lines)],
      );
    }
    return id;
  });
}

beforeAll(async () => {
  const org = await admin.query(
    "INSERT INTO organization (slug, name) VALUES ('fraud-co','Fraud Co') RETURNING id",
  );
  orgId = org.rows[0].id;
  await admin.query(
    `INSERT INTO module_entitlement (organization_id, module_code, enabled, enabled_at)
     VALUES ($1, 'compliance', true, clock_timestamp())`,
    [orgId],
  );
  await withOrg(orgId, async (tx) => {
    const users = await tx.query(
      `INSERT INTO app_user (organization_id, email, display_name) VALUES
         ($1,'sam@fraud.test','Sam Submitter'),
         ($1,'ann@fraud.test','Ann Approver'),
         ($1,'bo@fraud.test','Bo Backup')
       RETURNING id, email`,
      [orgId],
    );
    const byEmail = (e: string) => users.rows.find((r) => r.email === e).id as string;
    submitterId = byEmail('sam@fraud.test');
    approverId = byEmail('ann@fraud.test');
    otherApproverId = byEmail('bo@fraud.test');
    const cat = await tx.query(
      `INSERT INTO expense_category (organization_id, code, label)
       VALUES ($1,'meals','{"en":"Meals"}') RETURNING id`,
      [orgId],
    );
    categoryId = cat.rows[0].id;
  });
});

beforeEach(async () => {
  await admin.query('DELETE FROM fraud_flag');
  await admin.query('DELETE FROM approval_task');
  await admin.query('DELETE FROM approval_request');
  await admin.query('DELETE FROM expense_report');
  await admin.query("UPDATE organization SET fraud_config = '{}'::jsonb WHERE id = $1", [orgId]);
});

afterAll(async () => {
  await admin.query('TRUNCATE app_user, organization CASCADE');
  await admin.end();
});

describe('duplicates', () => {
  it('flags the LATER of two identical charges, once, and names the twin', async () => {
    const rep = await report('dup same');
    await expense(rep, { merchant: 'Beck Taxi', date: daysAgo(10), amountMinor: 4150 });
    const later = await expense(rep, { merchant: 'Beck Taxi', date: daysAgo(9), amountMinor: 4150 });

    const found = await withOrg(orgId, (tx) => detectDuplicates(tx, cfg));
    expect(found).toHaveLength(1);
    // The LATER one: a reviewer opening the flag is looking at the copy.
    expect(found[0].expenseId).toBe(later);
    expect(found[0].messageCode).toBe('DUPLICATE_SAME_REPORT');
    expect(found[0].severity).toBe('MEDIUM');
    expect(found[0].data.merchant).toBe('Beck Taxi');
    // NO RECORD ID in what the reader will see — upstream's sentence names the
    // other expense's uuid, and UD-3's crawl exists to catch exactly that.
    expect(JSON.stringify(found[0].data)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/i);
  });

  it('across two reports it is a different sentence and a heavier severity', async () => {
    const first = await report('dup a');
    const second = await report('dup b');
    await expense(first, { merchant: 'Beck Taxi', date: daysAgo(10), amountMinor: 4150 });
    await expense(second, { merchant: 'Beck Taxi', date: daysAgo(9), amountMinor: 4150 });

    const found = await withOrg(orgId, (tx) => detectDuplicates(tx, cfg));
    expect(found).toHaveLength(1);
    expect(found[0].messageCode).toBe('DUPLICATE_OTHER_REPORT');
    expect(found[0].severity).toBe('HIGH');
    // The other report's NUMBER, which is what a person can look up — not its id.
    expect(String(found[0].data.otherReportNumber)).toMatch(/^EXP-/);
  });

  it('ONE finding per expense, against the nearest twin — not one per pair', async () => {
    // Three identical charges is three pairs. Upstream measured what pair-wise
    // emission costs (300 charges → 14,850 findings) and this is the assertion
    // that keeps the fix: two later copies, two findings, each against the one
    // before it.
    const rep = await report('dup chain');
    await expense(rep, { merchant: 'Beck Taxi', date: daysAgo(12), amountMinor: 4150 });
    const b = await expense(rep, { merchant: 'Beck Taxi', date: daysAgo(11), amountMinor: 4150 });
    const c = await expense(rep, { merchant: 'Beck Taxi', date: daysAgo(10), amountMinor: 4150 });

    const found = await withOrg(orgId, (tx) => detectDuplicates(tx, cfg));
    expect(found).toHaveLength(2);
    expect(new Set(found.map((f) => f.expenseId))).toEqual(new Set([b, c]));
    // c's twin is b (the NEAREST earlier), not the oldest.
    const forC = found.find((f) => f.expenseId === c)!;
    expect(forC.evidence.duplicateOfExpenseId).toBe(b);
  });

  it('compares merchants case-insensitively, and ignores entries with no merchant', async () => {
    const rep = await report('dup case');
    await expense(rep, { merchant: 'BECK TAXI', date: daysAgo(10), amountMinor: 4150 });
    await expense(rep, { merchant: 'beck taxi', date: daysAgo(9), amountMinor: 4150 });
    // Two nameless entries of the same amount are not evidence of anything.
    await expense(rep, { merchant: null, date: daysAgo(8), amountMinor: 9900 });
    await expense(rep, { merchant: null, date: daysAgo(7), amountMinor: 9900 });

    const found = await withOrg(orgId, (tx) => detectDuplicates(tx, cfg));
    expect(found).toHaveLength(1);
    expect(String(found[0].data.merchant).toLowerCase()).toBe('beck taxi');
  });

  it('an entry with no line items has no amount, and is not everybody\'s duplicate', async () => {
    // VX1-5's receipt-first flow creates these. Treating a missing total as zero
    // would make every receiptless entry a duplicate of every other one.
    const rep = await report('dup receipt-first');
    await expense(rep, { merchant: 'Beck Taxi', date: daysAgo(10), lines: 0 });
    await expense(rep, { merchant: 'Beck Taxi', date: daysAgo(9), lines: 0 });
    expect(await withOrg(orgId, (tx) => detectDuplicates(tx, cfg))).toHaveLength(0);
  });

  it('outside the window it is not a duplicate', async () => {
    const rep = await report('dup far apart');
    await expense(rep, { merchant: 'Beck Taxi', date: daysAgo(30), amountMinor: 4150 });
    await expense(rep, { merchant: 'Beck Taxi', date: daysAgo(10), amountMinor: 4150 });
    expect(await withOrg(orgId, (tx) => detectDuplicates(tx, cfg))).toHaveLength(0);
  });

  it('a SPLIT expense is compared on its total, not on one of its lines', async () => {
    // The port's structural difference in one test: upstream compares
    // `Expense.amountMinor`; here the amount is the sum of the lines.
    const rep = await report('dup split');
    await expense(rep, { merchant: 'Beck Taxi', date: daysAgo(10), amountMinor: 6000, lines: 3 });
    await expense(rep, { merchant: 'Beck Taxi', date: daysAgo(9), amountMinor: 6000, lines: 1 });
    const found = await withOrg(orgId, (tx) => detectDuplicates(tx, cfg));
    expect(found).toHaveLength(1);
    expect(found[0].data.amountMinor).toBe('6000');
  });
});

describe('amount outliers', () => {
  /** `n` ordinary expenses, so a baseline exists at all. */
  async function baseline(n: number, amountMinor: number) {
    const rep = await report('baseline');
    for (let i = 0; i < n; i += 1) {
      await expense(rep, { merchant: `Shop ${i}`, date: daysAgo(60 - i), amountMinor });
    }
    return rep;
  }

  it('needs a baseline before anything can be an outlier', async () => {
    const rep = await baseline(3, 5000);
    await expense(rep, { merchant: 'Big', date: daysAgo(2), amountMinor: 500_000 });
    // Three samples is noise, not a baseline. `minSamples` is 10.
    expect(await withOrg(orgId, (tx) => detectAmountOutliers(tx, cfg))).toHaveLength(0);
  });

  it('flags an expense far above that person\'s own mean', async () => {
    const rep = await baseline(12, 5000);
    const big = await expense(rep, { merchant: 'Big', date: daysAgo(2), amountMinor: 500_000 });
    const found = await withOrg(orgId, (tx) => detectAmountOutliers(tx, cfg));
    expect(found.map((f) => f.expenseId)).toContain(big);
    const hit = found.find((f) => f.expenseId === big)!;
    expect(hit.messageCode).toBe('AMOUNT_OUTLIER');
    expect(Number(hit.data.sigmas)).toBeGreaterThanOrEqual(cfg.amountOutlier.sigma);
    // `meanMinor` is whole minor units — a mean of 4133.7 cents is not a thing a
    // currency has, and `f.money` formats minor units.
    expect(Number.isInteger(Number(hit.data.meanMinor))).toBe(true);
  });

  it('ignores a small amount however unusual', async () => {
    const rep = await baseline(12, 100);
    await expense(rep, { merchant: 'Odd', date: daysAgo(2), amountMinor: 9_000 });
    // 9,000 minor units is under the 10,000 floor, whatever its σ.
    expect(await withOrg(orgId, (tx) => detectAmountOutliers(tx, cfg))).toHaveLength(0);
  });

  it('a person whose spend never varies has no outliers', async () => {
    // σ = 0. The HAVING clause excludes them rather than dividing by zero.
    const rep = await baseline(12, 20_000);
    await expense(rep, { merchant: 'Same', date: daysAgo(2), amountMinor: 20_000 });
    expect(await withOrg(orgId, (tx) => detectAmountOutliers(tx, cfg))).toHaveLength(0);
  });
});

describe('violation density', () => {
  /**
   * `key` is `policy_violation.finding_key`, and it is required here rather than
   * optional: 0006 added that column precisely so one rule can emit several
   * findings at one scope, and `policy_violation_identity_idx` refuses a second
   * one without it. The first version of this fixture inserted four violations
   * against one line with the same key and failed on the constraint — which is
   * the schema being right and the fixture being lazy.
   */
  async function violate(reportId: string, lineItemId: string | null, key = '') {
    await withOrg(orgId, (tx) =>
      tx.query(
        `INSERT INTO policy_violation (organization_id, report_id, line_item_id, rule_code,
                                       severity, message, message_code, finding_key)
         VALUES ($1, $2, $3, 'RECEIPT_REQUIRED', 'WARNING', '', 'RECEIPT_REQUIRED', $4)`,
        [orgId, reportId, lineItemId, key],
      ),
    );
  }
  const lineOf = async (expenseId: string) =>
    withOrg(orgId, async (tx) => {
      const r = await tx.query('SELECT id FROM expense_line_item WHERE expense_id = $1', [
        expenseId,
      ]);
      return r.rows[0].id as string;
    });

  it('flags a report whose violated entries reach the ratio', async () => {
    const rep = await report('dense');
    const ids: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      ids.push(await expense(rep, { merchant: `M${i}`, date: daysAgo(5), amountMinor: 3000 }));
    }
    for (const id of ids.slice(0, 2)) await violate(rep, await lineOf(id));

    const found = await withOrg(orgId, (tx) => detectViolationDensity(tx, cfg));
    expect(found).toHaveLength(1);
    expect(found[0].data).toMatchObject({ violatedExpenses: 2, expenses: 4 });
    expect(found[0].reportId).toBe(rep);
  });

  it('four rules broken by ONE entry is not density', async () => {
    // The distinction upstream draws and the one that makes this rule mean
    // something: distinct violated ENTRIES, not violation rows.
    const rep = await report('one bad entry');
    const ids: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      ids.push(await expense(rep, { merchant: `M${i}`, date: daysAgo(5), amountMinor: 3000 }));
    }
    const line = await lineOf(ids[0]);
    for (let i = 0; i < 4; i += 1) await violate(rep, line, `rule-${i}`);
    expect(await withOrg(orgId, (tx) => detectViolationDensity(tx, cfg))).toHaveLength(0);
  });

  it('a report-scope violation counts toward the total but not toward density', async () => {
    const rep = await report('report scope');
    const ids: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      ids.push(await expense(rep, { merchant: `M${i}`, date: daysAgo(5), amountMinor: 3000 }));
    }
    for (const id of ids.slice(0, 2)) await violate(rep, await lineOf(id));
    await violate(rep, null); // a budget overage, say — it belongs to no entry
    const found = await withOrg(orgId, (tx) => detectViolationDensity(tx, cfg));
    expect(found[0].data).toMatchObject({ violatedExpenses: 2, expenses: 4, violations: 3 });
  });

  it('a resolved violation stops counting', async () => {
    const rep = await report('resolved');
    const ids: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      ids.push(await expense(rep, { merchant: `M${i}`, date: daysAgo(5), amountMinor: 3000 }));
    }
    for (const id of ids.slice(0, 2)) await violate(rep, await lineOf(id));
    await admin.query(
      'UPDATE policy_violation SET resolved_at = clock_timestamp(), resolved_by_id = $1',
      [submitterId],
    );
    expect(await withOrg(orgId, (tx) => detectViolationDensity(tx, cfg))).toHaveLength(0);
  });

  it('a small report is not dense however bad it is', async () => {
    const rep = await report('tiny');
    const one = await expense(rep, { merchant: 'M', date: daysAgo(5), amountMinor: 3000 });
    await violate(rep, await lineOf(one));
    expect(await withOrg(orgId, (tx) => detectViolationDensity(tx, cfg))).toHaveLength(0);
  });
});

describe('approver concentration', () => {
  async function approve(reportId: string, deciderId: string) {
    await withOrg(orgId, async (tx) => {
      const req = await tx.query(
        `INSERT INTO approval_request (organization_id, report_id, policy_snapshot, total_steps,
                                       subject_total_minor, subject_currency_code, opened_by_id,
                                       status, closed_at)
         VALUES ($1, $2, '{}'::jsonb, 1, 1000, 'CAD', $3, 'APPROVED', clock_timestamp())
         RETURNING id`,
        [orgId, reportId, submitterId],
      );
      await tx.query(
        `INSERT INTO approval_task (organization_id, request_id, step, assignee_id, status,
                                    decided_by_id, decided_at)
         VALUES ($1, $2, 1, $3, 'APPROVED', $3, clock_timestamp())`,
        [orgId, req.rows[0].id, deciderId],
      );
    });
  }

  it('flags one approver deciding all of one submitter\'s reports', async () => {
    for (let i = 0; i < 10; i += 1) await approve(await report(`conc ${i}`), approverId);
    const found = await withOrg(orgId, (tx) => detectApproverConcentration(tx, cfg));
    expect(found).toHaveLength(1);
    expect(found[0].severity).toBe('LOW'); // an observation, not an accusation
    expect(found[0].data).toMatchObject({
      approverName: 'Ann Approver',
      submitterName: 'Sam Submitter',
      pairApprovals: 10,
      totalApprovals: 10,
    });
    // The key carries the month, so a dismissal does not silence it forever.
    expect(found[0].findingKey).toMatch(/:\d{4}-\d{2}$/);
  });

  it('a second approver breaks the concentration', async () => {
    for (let i = 0; i < 10; i += 1) await approve(await report(`mix ${i}`), approverId);
    await approve(await report('mix other'), otherApproverId);
    // concentration is 1 by default: 10 of 11 is no longer ALL of them.
    expect(await withOrg(orgId, (tx) => detectApproverConcentration(tx, cfg))).toHaveLength(0);
  });

  it('volume alone is not the signal', async () => {
    for (let i = 0; i < 9; i += 1) await approve(await report(`few ${i}`), approverId);
    // Nine is under `minApprovals`, however concentrated.
    expect(await withOrg(orgId, (tx) => detectApproverConcentration(tx, cfg))).toHaveLength(0);
  });

  it('self-approval is excluded rather than counted as a concentrated pair', async () => {
    for (let i = 0; i < 10; i += 1) await approve(await report(`self ${i}`), submitterId);
    expect(await withOrg(orgId, (tx) => detectApproverConcentration(tx, cfg))).toHaveLength(0);
  });
});

describe('configuration', () => {
  it('an empty override is the shipped defaults', () => {
    expect(resolveFraudConfig({})).toEqual(DEFAULT_FRAUD_CONFIG);
    expect(resolveFraudConfig(null)).toEqual(DEFAULT_FRAUD_CONFIG);
  });

  it('a nonsensical value falls back field by field, rather than failing the scan', () => {
    const resolved = resolveFraudConfig({
      lookbackDays: -5,
      duplicate: { windowDays: 7 },
      amountOutlier: { sigma: 'lots' },
    });
    expect(resolved.lookbackDays).toBe(DEFAULT_FRAUD_CONFIG.lookbackDays);
    expect(resolved.duplicate.windowDays).toBe(7);
    expect(resolved.amountOutlier.sigma).toBe(DEFAULT_FRAUD_CONFIG.amountOutlier.sigma);
  });

  it('is read PER TENANT, from the organization row', async () => {
    await admin.query(
      `UPDATE organization SET fraud_config = '{"duplicate":{"windowDays":30}}'::jsonb WHERE id = $1`,
      [orgId],
    );
    const loaded = await withOrg(orgId, (tx) => loadFraudConfig(tx));
    expect(loaded.duplicate.windowDays).toBe(30);
    // And it changes what the rule finds — a config nothing reads is a setting
    // that only looks configurable, which is what `PORT`/`E2E_PORT` was.
    const rep = await report('cfg');
    await expense(rep, { merchant: 'Beck Taxi', date: daysAgo(30), amountMinor: 4150 });
    await expense(rep, { merchant: 'Beck Taxi', date: daysAgo(10), amountMinor: 4150 });
    expect(await withOrg(orgId, (tx) => detectDuplicates(tx, loaded))).toHaveLength(1);
  });
});

describe('the scan', () => {
  async function oneDuplicate() {
    const rep = await report('scan dup');
    await expense(rep, { merchant: 'Beck Taxi', date: daysAgo(10), amountMinor: 4150 });
    await expense(rep, { merchant: 'Beck Taxi', date: daysAgo(9), amountMinor: 4150 });
    return rep;
  }

  it('creates on the first run and refreshes on the second', async () => {
    await oneDuplicate();
    const first = await withOrg(orgId, (tx) => runFraudScan(tx, cfg));
    expect(first.created).toBe(1);
    expect(first.refreshed).toBe(0);

    const second = await withOrg(orgId, (tx) => runFraudScan(tx, cfg));
    expect(second.created).toBe(0);
    expect(second.refreshed).toBe(1);

    const rows = await admin.query('SELECT count(*)::int AS n FROM fraud_flag');
    expect(rows.rows[0].n).toBe(1);
  });

  it('LEAVES A DISMISSED FLAG ALONE — the case the whole table is for', async () => {
    await oneDuplicate();
    await withOrg(orgId, (tx) => runFraudScan(tx, cfg));
    await admin.query(
      `UPDATE fraud_flag SET status = 'DISMISSED', reviewed_at = clock_timestamp(),
                             reviewed_by_id = $1, review_note = 'checked, one dinner'`,
      [submitterId],
    );
    const before = await admin.query('SELECT last_seen_at, review_note FROM fraud_flag');

    const again = await withOrg(orgId, (tx) => runFraudScan(tx, cfg));
    expect(again.created).toBe(0);
    expect(again.refreshed).toBe(0);
    expect(again.suppressed).toBe(1);

    const after = await admin.query('SELECT status, last_seen_at, review_note FROM fraud_flag');
    expect(after.rows[0].status).toBe('DISMISSED');
    expect(after.rows[0].review_note).toBe('checked, one dinner');
    // Not even touched: `last_seen_at` is unchanged, because the row matched no
    // WHERE rather than being updated and reverted.
    expect(after.rows[0].last_seen_at).toEqual(before.rows[0].last_seen_at);
  });

  it('refreshes the numbers on a flag that is still ACTIVE', async () => {
    const rep = await oneDuplicate();
    await withOrg(orgId, (tx) => runFraudScan(tx, cfg));
    const first = await admin.query('SELECT data, last_seen_at FROM fraud_flag');
    // A third copy makes the nearest twin a different, later expense.
    await expense(rep, { merchant: 'Beck Taxi', date: daysAgo(8), amountMinor: 4150 });
    await new Promise((r) => setTimeout(r, 5));
    await withOrg(orgId, (tx) => runFraudScan(tx, cfg));
    const rows = await admin.query('SELECT last_seen_at FROM fraud_flag ORDER BY created_at');
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows[0].last_seen_at.getTime()).toBeGreaterThan(
      first.rows[0].last_seen_at.getTime(),
    );
  });

  it('onlyRules narrows the run', async () => {
    await oneDuplicate();
    const result = await withOrg(orgId, (tx) =>
      runFraudScan(tx, cfg, [FRAUD_RULES.amountOutlier]),
    );
    expect(result.created).toBe(0);
    expect(Object.keys(result.perRule)).toEqual([FRAUD_RULES.amountOutlier]);
  });

  it('is gated on the compliance module, in the service rather than at a caller', async () => {
    await admin.query(
      `UPDATE module_entitlement SET enabled = false
        WHERE organization_id = $1 AND module_code = 'compliance'`,
      [orgId],
    );
    try {
      await expect(withOrg(orgId, (tx) => runFraudScan(tx, cfg))).rejects.toSatisfy(isModuleDisabled);
    } finally {
      await admin.query(
        `UPDATE module_entitlement SET enabled = true
          WHERE organization_id = $1 AND module_code = 'compliance'`,
        [orgId],
      );
    }
  });

  it('one failing rule does not abandon the others, and is REPORTED', async () => {
    // Upstream logs the failure to console.warn and carries on, so a rule that
    // has been throwing for a month looks exactly like a rule finding nothing.
    await oneDuplicate();
    const broken = DETECTORS.find((d) => d.code === FRAUD_RULES.amountOutlier)!;
    const original = broken.run;
    (broken as { run: unknown }).run = async () => {
      throw new Error('deliberate');
    };
    try {
      const result = await withOrg(orgId, (tx) => runFraudScan(tx, cfg));
      expect(result.created).toBe(1);
      expect(result.failed).toEqual([{ code: FRAUD_RULES.amountOutlier, error: 'deliberate' }]);
    } finally {
      (broken as { run: unknown }).run = original;
    }
  });
});

describe('every finding can actually be said', () => {
  /**
   * THE ASSERTION THE CATALOGUE'S `requires` LIST CANNOT MAKE ABOUT ITSELF.
   *
   * `requires` is DECLARED, because a renderer's body cannot be inspected for the
   * keys it will touch. `scripts/check-i18n.mjs` checks the code SETS agree in
   * both directions; only a run against real data can check that the DATA agrees
   * — that every key a sentence declares is a key the detector actually emits.
   *
   * Part 2b shipped that gap: the codes matched and one sentence still could not
   * render, because the rule spelled a key differently from the catalogue.
   */
  it('every code a detector emits renders in every shipped locale, from real data', async () => {
    // One report that trips all four rules at once.
    const rep = await report('everything');
    await expense(rep, { merchant: 'Beck Taxi', date: daysAgo(10), amountMinor: 4150 });
    await expense(rep, { merchant: 'Beck Taxi', date: daysAgo(9), amountMinor: 4150 });
    // A duplicate ACROSS reports too, or DUPLICATE_OTHER_REPORT is unreachable
    // and the coverage assertion at the bottom fails — which is exactly what it
    // did on the first run of this test.
    const otherRep = await report('everything, elsewhere');
    await expense(otherRep, { merchant: 'Pearson Parking', date: daysAgo(20), amountMinor: 2200 });
    await expense(rep, { merchant: 'Pearson Parking', date: daysAgo(19), amountMinor: 2200 });
    for (let i = 0; i < 12; i += 1) {
      await expense(rep, { merchant: `Shop ${i}`, date: daysAgo(60 - i), amountMinor: 5000 });
    }
    await expense(rep, { merchant: 'Big', date: daysAgo(2), amountMinor: 500_000 });
    const lines = await withOrg(orgId, (tx) =>
      tx.query(`SELECT li.id FROM expense_line_item li
                  JOIN expense e ON e.id = li.expense_id WHERE e.report_id = $1 LIMIT 8`, [rep]),
    );
    for (const row of lines.rows) {
      await withOrg(orgId, (tx) =>
        tx.query(
          `INSERT INTO policy_violation (organization_id, report_id, line_item_id, rule_code,
                                         severity, message, message_code)
           VALUES ($1, $2, $3, 'RECEIPT_REQUIRED', 'WARNING', '', 'RECEIPT_REQUIRED')`,
          [orgId, rep, row.id],
        ),
      );
    }
    for (let i = 0; i < 10; i += 1) {
      const r = await report(`conc ${i}`);
      await withOrg(orgId, async (tx) => {
        const req = await tx.query(
          `INSERT INTO approval_request (organization_id, report_id, policy_snapshot, total_steps,
                                         subject_total_minor, subject_currency_code, opened_by_id,
                                         status, closed_at)
           VALUES ($1, $2, '{}'::jsonb, 1, 1000, 'CAD', $3, 'APPROVED', clock_timestamp())
         RETURNING id`,
          [orgId, r, submitterId],
        );
        await tx.query(
          `INSERT INTO approval_task (organization_id, request_id, step, assignee_id, status,
                                      decided_by_id, decided_at)
           VALUES ($1, $2, 1, $3, 'APPROVED', $3, clock_timestamp())`,
          [orgId, req.rows[0].id, approverId],
        );
      });
    }

    const findings = (
      await Promise.all(
        DETECTORS.map((d) => withOrg(orgId, (tx) => d.run(tx, cfg))),
      )
    ).flat();

    const seen = new Set<string>();
    for (const f of findings) {
      seen.add(f.messageCode);
      // Direction 1: every key the sentence DECLARES is a key this finding HAS.
      for (const key of FRAUD_MESSAGES[f.messageCode].requires) {
        expect(
          Object.prototype.hasOwnProperty.call(f.data, key),
          `${f.messageCode} declares data.${key}, which ${f.ruleCode} does not emit`,
        ).toBe(true);
      }
      // Direction 2: it renders — in every locale we ship — rather than falling
      // to the missing-copy marker, which is what a bad key produces.
      for (const locale of SUPPORTED_LOCALES) {
        const text = renderFraudMessage(f.messageCode, f.data, locale);
        expect(text, `${f.messageCode} in ${locale}`).not.toMatch(/^\{.*\}$/);
        expect(text.length).toBeGreaterThan(10);
        // And no record id reaches a reader. UD-3's crawl checks the rendered
        // page; this checks the sentence before it gets there.
        expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i);
      }
    }

    // Every code a DETECTOR can emit was reachable from real data. The
    // `check:i18n` gate compares the SETS; this proves the data can reach them.
    //
    // MANUAL_FLAG is excluded because no detector emits it — a person does, and
    // `test/fraud-review.db.test.ts` covers that path. Written as a subtraction
    // from the catalogue rather than as its own list, so a SEVENTH code added to
    // the catalogue without a detector fails here instead of being quietly
    // absent.
    const detectable = FRAUD_MESSAGE_CODES.filter((c) => c !== 'MANUAL_FLAG');
    expect([...seen].sort()).toEqual([...detectable].sort());
  });
});
