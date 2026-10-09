/**
 * VX4-8 part 3 — the six controls and the run, against a real Postgres.
 * Own org slug ('ctrl-co').
 *
 * ── THE TWO GROUPS THAT MATTER MOST ─────────────────────────────────────────
 *
 * `the run row` is the reason the runner does not share one transaction with its
 * work: a crashed evaluation has to be distinguishable from a clean one. The test
 * makes a control throw and asserts the row survives, says FAILED, and carries
 * the failing control's name — because "no findings" and "never ran" looking
 * identical is the failure this whole module exists to catch elsewhere.
 *
 * `FX_RATE_MISSING` earns its own group for upstream's own reason: matching only
 * expense-to-report would report CRITICAL on reports that convert perfectly well,
 * because a rate quoted one way fills the other by reciprocal. Both directions
 * are tested separately.
 */
process.env.SECRET_ENCRYPTION_KEY =
  process.env.SECRET_ENCRYPTION_KEY ?? Buffer.alloc(32, 11).toString('base64');

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { Pool } from 'pg';
import { withOrg } from '@/lib/tenant/context';
import {
  CONTROLS,
  CONTROL_CHECKS,
  DEFAULT_CONTROL_CONFIG,
  checkApprovedWithoutReceipt,
  checkFxRateMissing,
  checkGlMappingGaps,
  checkReturnsWithoutNote,
  checkStaleDrafts,
  checkSubmittedNoAction,
  defaultPeriod,
  loadControlConfig,
  resolveControlConfig,
  type ControlConfig,
  type Period,
} from '@/lib/fraud/controls';
import { runControlEvaluation } from '@/lib/fraud/evaluate';
import { isModuleDisabled } from '@/lib/modules/errors';
import { renderControlMessage, CONTROL_MESSAGES } from '@/lib/i18n/catalog/control-messages';
import { SUPPORTED_LOCALES } from '@/lib/i18n/locales';

const admin = new Pool({
  connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL,
});

let orgId: string;
let userId: string;
let mappedCategoryId: string;
let unmappedCategoryId: string;

const cfg: ControlConfig = DEFAULT_CONTROL_CONFIG;
const period: Period = defaultPeriod();
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);

/**
 * A report, with `created_at` / `updated_at` / `submitted_at` / `approved_at`
 * forced through the ADMIN pool.
 *
 * Those four have database defaults of `now()`, and every control here is about
 * how long ago something happened — so a fixture that cannot backdate can only
 * test the zero case. Written with `admin` rather than through the tenant path
 * for that one reason: the app has no API for "pretend this was submitted three
 * weeks ago", and it should not have one.
 */
async function report(opts: {
  status: string;
  number: string;
  currency?: string;
  createdDaysAgo?: number;
  updatedDaysAgo?: number;
  submittedDaysAgo?: number;
  approvedDaysAgo?: number;
  totalMinor?: number;
  reimbursedDaysAgo?: number;
}): Promise<string> {
  const r = await admin.query(
    `INSERT INTO expense_report (organization_id, submitter_id, title, currency_code, status,
                                 number, total_minor, created_at, updated_at, submitted_at,
                                 approved_at, reimbursed_at, reimbursed_by_id)
     VALUES ($1, $2, $3, $4, $5::expense_report_status, $6, $7, $8, $9, $10, $11, $12, $13)
     RETURNING id`,
    [
      orgId,
      userId,
      `Report ${opts.number}`,
      opts.currency ?? 'CAD',
      opts.status,
      opts.number,
      opts.totalMinor ?? 10_000,
      daysAgo(opts.createdDaysAgo ?? 10),
      daysAgo(opts.updatedDaysAgo ?? opts.createdDaysAgo ?? 10),
      opts.submittedDaysAgo === undefined ? null : daysAgo(opts.submittedDaysAgo),
      opts.approvedDaysAgo === undefined ? null : daysAgo(opts.approvedDaysAgo),
      // `expense_report_reimbursed_stamped`: REIMBURSED iff reimbursed_at.
      opts.reimbursedDaysAgo === undefined ? null : daysAgo(opts.reimbursedDaysAgo),
      // `expense_report_reimbursement_complete`: the stamp needs a person too.
      opts.reimbursedDaysAgo === undefined ? null : userId,
    ],
  );
  return r.rows[0].id as string;
}

async function expense(
  reportId: string,
  opts: { amountMinor?: number; currency?: string; categoryId?: string; receipt?: boolean } = {},
): Promise<string> {
  const e = await admin.query(
    `INSERT INTO expense (organization_id, report_id, merchant, txn_date, currency_code)
     VALUES ($1, $2, 'A Merchant', current_date, $3) RETURNING id`,
    [orgId, reportId, opts.currency ?? 'CAD'],
  );
  const id = e.rows[0].id as string;
  await admin.query(
    `INSERT INTO expense_line_item (organization_id, expense_id, category_id, amount_minor)
     VALUES ($1, $2, $3, $4)`,
    [orgId, id, opts.categoryId ?? mappedCategoryId, opts.amountMinor ?? 5000],
  );
  if (opts.receipt) {
    await admin.query(
      `INSERT INTO receipt (organization_id, expense_id, s3_key, filename, content_type,
                            size_bytes, uploaded_by_id, status)
       VALUES ($1, $2, $3, 'r.png', 'image/png', 100, $4, 'STORED')`,
      [orgId, id, `k/${id}`, userId],
    );
  }
  return id;
}

beforeAll(async () => {
  const org = await admin.query(
    "INSERT INTO organization (slug, name) VALUES ('ctrl-co','Ctrl Co') RETURNING id",
  );
  orgId = org.rows[0].id;
  await admin.query(
    `INSERT INTO module_entitlement (organization_id, module_code, enabled, enabled_at)
     VALUES ($1, 'compliance', true, clock_timestamp())`,
    [orgId],
  );
  const u = await admin.query(
    `INSERT INTO app_user (organization_id, email, display_name)
     VALUES ($1, 'kit@ctrl.test', 'Kit Controller') RETURNING id`,
    [orgId],
  );
  userId = u.rows[0].id;
  const acct = await admin.query(
    `INSERT INTO gl_account (organization_id, number, name, type, is_postable, source)
     VALUES ($1, '68100', 'Travel', 'expense', true, 'MANUAL') RETURNING id`,
    [orgId],
  );
  const mapped = await admin.query(
    `INSERT INTO expense_category (organization_id, code, label, gl_account_id)
     VALUES ($1, 'meals', '{"en":"Meals"}', $2) RETURNING id`,
    [orgId, acct.rows[0].id],
  );
  mappedCategoryId = mapped.rows[0].id;
  // A THIRD CURRENCY, for the FX control only.
  //
  // `currency` ships CAD and USD, and the seed ships a USD->CAD rate — so with
  // only those two, "no rate for this pair" is unreachable and the first version
  // of the FX group asserted one finding and got none. Deleting the seeded rate
  // was the other option, and was worse while `fx_rate` was global (until 0051): a
  // suite that removed a row removed it for every suite sharing this database.
  await admin.query(
    `INSERT INTO currency (code, name, minor_unit) VALUES ('CHF','Swiss Franc',2)
     ON CONFLICT (code) DO NOTHING`,
  );
  const unmapped = await admin.query(
    `INSERT INTO expense_category (organization_id, code, label)
     VALUES ($1, 'sundry', '{"en":"Sundry"}') RETURNING id`,
    [orgId],
  );
  unmappedCategoryId = unmapped.rows[0].id;
});

beforeEach(async () => {
  await admin.query('DELETE FROM control_finding');
  await admin.query('DELETE FROM control_evaluation_run');
  await admin.query('DELETE FROM expense_report_event');
  await admin.query('DELETE FROM expense_report');
  await admin.query("DELETE FROM fx_rate WHERE source = 'MANUAL'");
  await admin.query("UPDATE organization SET control_config = '{}'::jsonb WHERE id = $1", [orgId]);
});

afterAll(async () => {
  await admin.query('TRUNCATE app_user, organization CASCADE');
  await admin.end();
});

describe('stale drafts', () => {
  it('flags a draft nobody has touched past the threshold', async () => {
    const rep = await report({ status: 'DRAFT', number: 'D-1', updatedDaysAgo: 45 });
    await expense(rep, { amountMinor: 7500 });
    const found = await withOrg(orgId, (tx) => checkStaleDrafts(tx, period, cfg));
    expect(found).toHaveLength(1);
    expect(found[0].subjectLabel).toBe('D-1');
    expect(found[0].severity).toBe('WARNING');
    // The MONEY sitting unrecorded is the point of the control, so it is in the
    // sentence rather than only in the evidence.
    expect(found[0].data.amountMinor).toBe('7500');
  });

  it('measures updated_at, not created_at — work in progress is not abandoned', async () => {
    const rep = await report({ status: 'DRAFT', number: 'D-2', createdDaysAgo: 80, updatedDaysAgo: 2 });
    await expense(rep);
    expect(await withOrg(orgId, (tx) => checkStaleDrafts(tx, period, cfg))).toHaveLength(0);
  });

  it('a submitted report is not a stale draft however old', async () => {
    const rep = await report({
      status: 'SUBMITTED', number: 'D-3', updatedDaysAgo: 60, submittedDaysAgo: 60,
    });
    await expense(rep);
    expect(await withOrg(orgId, (tx) => checkStaleDrafts(tx, period, cfg))).toHaveLength(0);
  });

  it('an empty draft is still a finding, with nothing in it', async () => {
    // LEFT JOIN, not JOIN: a draft with no entries is the commonest abandoned
    // one, and joining would have hidden every single one of them.
    await report({ status: 'DRAFT', number: 'D-4', updatedDaysAgo: 45 });
    const found = await withOrg(orgId, (tx) => checkStaleDrafts(tx, period, cfg));
    expect(found).toHaveLength(1);
    expect(found[0].data.amountMinor).toBe('0');
  });
});

describe('submitted with no action', () => {
  it('warns past the threshold and escalates past double it', async () => {
    await report({ status: 'SUBMITTED', number: 'S-1', submittedDaysAgo: 20, updatedDaysAgo: 20 });
    await report({ status: 'SUBMITTED', number: 'S-2', submittedDaysAgo: 40, updatedDaysAgo: 40 });
    const found = await withOrg(orgId, (tx) => checkSubmittedNoAction(tx, period, cfg));
    const bySubject = Object.fromEntries(found.map((f) => [f.subjectLabel, f]));
    expect(bySubject['S-1'].severity).toBe('WARNING');
    // Past double the threshold it stops being a delay and starts being a control
    // that is not operating at all.
    expect(bySubject['S-2'].severity).toBe('CRITICAL');
    // 39, not 40: `daysBetween` floors, and `daysAgo(40)` is 40 days minus the
    // milliseconds this test took to get here.
    expect(Number(bySubject['S-2'].data.daysWaiting)).toBeGreaterThanOrEqual(39);
  });

  it('inside the threshold is not a finding', async () => {
    await report({ status: 'SUBMITTED', number: 'S-3', submittedDaysAgo: 3, updatedDaysAgo: 3 });
    expect(await withOrg(orgId, (tx) => checkSubmittedNoAction(tx, period, cfg))).toHaveLength(0);
  });

  it('a decided report is not waiting', async () => {
    await report({
      status: 'APPROVED', number: 'S-4', submittedDaysAgo: 40, approvedDaysAgo: 39, updatedDaysAgo: 39,
    });
    expect(await withOrg(orgId, (tx) => checkSubmittedNoAction(tx, period, cfg))).toHaveLength(0);
  });
});

describe('returns without an explanation', () => {
  async function returnEvent(reportId: string, note: string | null) {
    await admin.query(
      `INSERT INTO expense_report_event (organization_id, report_id, action, from_status,
                                         to_status, actor_id, note, created_at)
       VALUES ($1, $2, 'RETURN', 'SUBMITTED', 'RETURNED', $3, $4, $5)`,
      [orgId, reportId, userId, note, daysAgo(5)],
    );
  }

  it('flags a return with no note, and names who did it', async () => {
    const rep = await report({ status: 'RETURNED', number: 'R-1' });
    await returnEvent(rep, null);
    const found = await withOrg(orgId, (tx) => checkReturnsWithoutNote(tx, period));
    expect(found).toHaveLength(1);
    expect(found[0].data.returnedBy).toBe('Kit Controller');
    expect(found[0].subjectLabel).toBe('R-1');
  });

  it('a whitespace-only note is not an explanation', async () => {
    const rep = await report({ status: 'RETURNED', number: 'R-2' });
    await returnEvent(rep, '   ');
    expect(await withOrg(orgId, (tx) => checkReturnsWithoutNote(tx, period))).toHaveLength(1);
  });

  it('a real note is not a finding', async () => {
    const rep = await report({ status: 'RETURNED', number: 'R-3' });
    await returnEvent(rep, 'Please attach the hotel folio.');
    expect(await withOrg(orgId, (tx) => checkReturnsWithoutNote(tx, period))).toHaveLength(0);
  });

  it('reads the transition row, so a REJECT with no note is not a return', async () => {
    const rep = await report({ status: 'REJECTED', number: 'R-4' });
    await admin.query(
      `INSERT INTO expense_report_event (organization_id, report_id, action, from_status,
                                         to_status, actor_id, note, created_at)
       VALUES ($1, $2, 'REJECT', 'SUBMITTED', 'REJECTED', $3, NULL, $4)`,
      [orgId, rep, userId, daysAgo(5)],
    );
    expect(await withOrg(orgId, (tx) => checkReturnsWithoutNote(tx, period))).toHaveLength(0);
  });
});

describe('approved without a receipt', () => {
  it('flags an approval with an unsupported entry, and counts the money', async () => {
    const rep = await report({ status: 'APPROVED', number: 'A-1', approvedDaysAgo: 5, updatedDaysAgo: 5 });
    await expense(rep, { amountMinor: 3000, receipt: true });
    await expense(rep, { amountMinor: 8000, receipt: false });
    const found = await withOrg(orgId, (tx) => checkApprovedWithoutReceipt(tx, period));
    expect(found).toHaveLength(1);
    expect(found[0].severity).toBe('CRITICAL');
    expect(found[0].data).toMatchObject({ missing: 1, entries: 2, unsupportedMinor: '8000' });
  });

  it('a fully documented approval is not a finding', async () => {
    const rep = await report({ status: 'APPROVED', number: 'A-2', approvedDaysAgo: 5, updatedDaysAgo: 5 });
    await expense(rep, { receipt: true });
    expect(await withOrg(orgId, (tx) => checkApprovedWithoutReceipt(tx, period))).toHaveLength(0);
  });

  it('covers REIMBURSED too — the money has already gone out', async () => {
    const rep = await report({
      status: 'REIMBURSED', number: 'A-3', approvedDaysAgo: 6, reimbursedDaysAgo: 5, updatedDaysAgo: 5,
    });
    await expense(rep, { receipt: false });
    expect(await withOrg(orgId, (tx) => checkApprovedWithoutReceipt(tx, period))).toHaveLength(1);
  });

  it('a draft with no receipts is not this control\'s business', async () => {
    const rep = await report({ status: 'DRAFT', number: 'A-4', updatedDaysAgo: 2 });
    await expense(rep, { receipt: false });
    expect(await withOrg(orgId, (tx) => checkApprovedWithoutReceipt(tx, period))).toHaveLength(0);
  });
});

describe('cross-currency with no rate', () => {
  /** A CHF entry on a CAD report — a pair with no seeded rate. */
  async function usdOnCadReport(number: string) {
    const rep = await report({ status: 'SUBMITTED', number, currency: 'CAD', submittedDaysAgo: 5 });
    await expense(rep, { currency: 'CHF', amountMinor: 12_000 });
    return rep;
  }

  it('flags an entry whose currency cannot be converted', async () => {
    await usdOnCadReport('F-1');
    const found = await withOrg(orgId, (tx) => checkFxRateMissing(tx, period));
    expect(found).toHaveLength(1);
    expect(found[0].severity).toBe('CRITICAL');
    expect(found[0].data).toMatchObject({
      expenseCurrency: 'CHF',
      reportCurrency: 'CAD',
      entries: 1,
    });
  });

  it('a rate quoted CHF→CAD clears it', async () => {
    await usdOnCadReport('F-2');
    await admin.query(
      `INSERT INTO fx_rate (organization_id, base, quote, rate, source)
       VALUES ($1, 'CHF', 'CAD', 1.55, 'MANUAL')`,
      [orgId],
    );
    expect(await withOrg(orgId, (tx) => checkFxRateMissing(tx, period))).toHaveLength(0);
  });

  it('AND a rate quoted the OTHER way clears it too — upstream\'s hard-won detail', async () => {
    // Their comment: matching only expense-to-report "would keep reporting
    // CRITICAL on reports that now convert perfectly well… and the compliance
    // screen would contradict the total printed on the report itself." The
    // reciprocal fill in lib/policy/rules.ts makes the same trap live here.
    await usdOnCadReport('F-3');
    await admin.query(
      `INSERT INTO fx_rate (organization_id, base, quote, rate, source)
       VALUES ($1, 'CAD', 'CHF', 0.65, 'MANUAL')`,
      [orgId],
    );
    expect(await withOrg(orgId, (tx) => checkFxRateMissing(tx, period))).toHaveLength(0);
  });

  it('a single-currency report is never a finding', async () => {
    const rep = await report({ status: 'SUBMITTED', number: 'F-4', submittedDaysAgo: 5 });
    await expense(rep, { currency: 'CAD' });
    expect(await withOrg(orgId, (tx) => checkFxRateMissing(tx, period))).toHaveLength(0);
  });
});

describe('GL mapping coverage', () => {
  it('reports the CATEGORY, once, however many reports used it', async () => {
    for (const number of ['G-1', 'G-2', 'G-3']) {
      const rep = await report({ status: 'SUBMITTED', number, submittedDaysAgo: 5 });
      await expense(rep, { categoryId: unmappedCategoryId, amountMinor: 4000 });
    }
    const found = await withOrg(orgId, (tx) => checkGlMappingGaps(tx, period));
    // One finding somebody can fix, not three that all want the same edit.
    expect(found).toHaveLength(1);
    expect(found[0].subjectType).toBe('expense_category');
    expect(found[0].subjectLabel).toBe('sundry');
    expect(found[0].severity).toBe('INFO');
    expect(found[0].data).toMatchObject({ categoryCode: 'sundry', lineItems: 3 });
  });

  it('does NOT sum money across currencies — it does not quote money at all', async () => {
    // The correction to this file's own first draft: line items carry their
    // expense's currency, so a per-category total is a sum of mixed currencies.
    // AN-7's shape, and it would have been reintroduced one ticket after the one
    // that fixed it.
    const rep = await report({ status: 'SUBMITTED', number: 'G-4', submittedDaysAgo: 5 });
    await expense(rep, { categoryId: unmappedCategoryId, currency: 'CAD', amountMinor: 1000 });
    await expense(rep, { categoryId: unmappedCategoryId, currency: 'USD', amountMinor: 1000 });
    const found = await withOrg(orgId, (tx) => checkGlMappingGaps(tx, period));
    expect(found).toHaveLength(1);
    expect(found[0].data).not.toHaveProperty('amountMinor');
    // The currencies involved ARE in the evidence, so a reader can see why there
    // is no total.
    expect(found[0].evidence.currencies).toEqual(['CAD', 'USD']);
  });

  it('a mapped category is not a gap', async () => {
    const rep = await report({ status: 'SUBMITTED', number: 'G-5', submittedDaysAgo: 5 });
    await expense(rep, { categoryId: mappedCategoryId });
    expect(await withOrg(orgId, (tx) => checkGlMappingGaps(tx, period))).toHaveLength(0);
  });

  it('an unmapped category nobody used is not a gap', async () => {
    // "Actually USED in the period" — a category sitting unused in the list is a
    // configuration choice, not a deficiency.
    expect(await withOrg(orgId, (tx) => checkGlMappingGaps(tx, period))).toHaveLength(0);
  });
});

describe('configuration', () => {
  it('falls back field by field', () => {
    expect(resolveControlConfig({})).toEqual(DEFAULT_CONTROL_CONFIG);
    expect(resolveControlConfig({ staleDraftDays: 0 }).staleDraftDays).toBe(30);
    expect(resolveControlConfig({ staleDraftDays: 7 }).staleDraftDays).toBe(7);
  });

  it('ignores keys belonging to the two controls that do not apply here', () => {
    // A tenant blob carrying travel thresholds is harmless rather than a schema
    // error — those two checks are omitted, not disabled.
    const resolved = resolveControlConfig({ travelOverrunPercent: 15, staleDraftDays: 9 });
    expect(resolved).toEqual({ staleDraftDays: 9, submittedNoActionDays: 14 });
  });

  it('is read per tenant, and changes what a control finds', async () => {
    const rep = await report({ status: 'DRAFT', number: 'C-1', updatedDaysAgo: 10 });
    await expense(rep);
    expect(await withOrg(orgId, (tx) => checkStaleDrafts(tx, period, cfg))).toHaveLength(0);
    await admin.query(
      `UPDATE organization SET control_config = '{"staleDraftDays":5}'::jsonb WHERE id = $1`,
      [orgId],
    );
    const loaded = await withOrg(orgId, (tx) => loadControlConfig(tx));
    expect(loaded.staleDraftDays).toBe(5);
    expect(await withOrg(orgId, (tx) => checkStaleDrafts(tx, period, loaded))).toHaveLength(1);
  });
});

describe('the run row', () => {
  it('records a completed run with per-control counts', async () => {
    const rep = await report({ status: 'DRAFT', number: 'X-1', updatedDaysAgo: 45 });
    await expense(rep, { categoryId: unmappedCategoryId });
    const result = await runControlEvaluation(orgId, { requestedByName: 'Kit Controller' });
    expect(result.status).toBe('COMPLETED');
    expect(result.findings).toBeGreaterThan(0);
    expect(result.perControl[CONTROLS.staleDraft]).toBe(1);

    const run = await admin.query('SELECT * FROM control_evaluation_run');
    expect(run.rows).toHaveLength(1);
    expect(run.rows[0].status).toBe('COMPLETED');
    expect(run.rows[0].completed_at).not.toBeNull();
    expect(run.rows[0].error).toBeNull();
    expect(run.rows[0].requested_by_name).toBe('Kit Controller');
    expect(run.rows[0].summary.perControl[CONTROLS.staleDraft]).toBe(1);

    const findings = await admin.query('SELECT run_id FROM control_finding');
    expect(findings.rows.every((r) => r.run_id === result.runId)).toBe(true);
  });

  it('a completed run with nothing wrong is a row, not an absence', async () => {
    const result = await runControlEvaluation(orgId);
    expect(result.status).toBe('COMPLETED');
    expect(result.findings).toBe(0);
    const run = await admin.query('SELECT status FROM control_evaluation_run');
    expect(run.rows[0].status).toBe('COMPLETED');
  });

  it('A CONTROL THAT THROWS is named in the summary and does not stop the run', async () => {
    const rep = await report({ status: 'DRAFT', number: 'X-2', updatedDaysAgo: 45 });
    await expense(rep);
    const broken = CONTROL_CHECKS.find((c) => c.code === CONTROLS.fxRateMissing)!;
    const original = broken.run;
    (broken as { run: unknown }).run = async () => {
      throw new Error('deliberate');
    };
    try {
      const result = await runControlEvaluation(orgId);
      // COMPLETED, because the RUN completed — one control failing is a recorded
      // fact about the run, not a failure of it.
      expect(result.status).toBe('COMPLETED');
      expect(result.failedControls[CONTROLS.fxRateMissing]).toBe('deliberate');
      expect(result.perControl[CONTROLS.staleDraft]).toBe(1);
      const run = await admin.query('SELECT summary FROM control_evaluation_run');
      // In the ROW, not just the return value: the screen reads the row, and a
      // control absent from perControl because it threw would read as "ran,
      // found nothing".
      expect(run.rows[0].summary.failedControls[CONTROLS.fxRateMissing]).toBe('deliberate');
      expect(run.rows[0].summary.perControl).not.toHaveProperty(CONTROLS.fxRateMissing);
    } finally {
      (broken as { run: unknown }).run = original;
    }
  });

  it('is gated on the compliance module, and leaves no RUNNING row behind', async () => {
    await admin.query(
      `UPDATE module_entitlement SET enabled = false
        WHERE organization_id = $1 AND module_code = 'compliance'`,
      [orgId],
    );
    try {
      await expect(runControlEvaluation(orgId)).rejects.toSatisfy(isModuleDisabled);
      // THE POINT OF GATING ON THE FIRST WRITE: a refusal after the run row was
      // opened would leave a RUNNING row nobody will ever close, which is worse
      // than the refusal it was meant to be.
      const run = await admin.query('SELECT count(*)::int AS n FROM control_evaluation_run');
      expect(run.rows[0].n).toBe(0);
    } finally {
      await admin.query(
        `UPDATE module_entitlement SET enabled = true
          WHERE organization_id = $1 AND module_code = 'compliance'`,
        [orgId],
      );
    }
  });

  it('every control message renders from real findings, in every shipped locale', async () => {
    // The same both-directions assertion part 2 makes: the code SETS are checked
    // by `check:i18n`, and only real data can show that every declared key is a
    // key the control actually emits.
    const stale = await report({ status: 'DRAFT', number: 'Y-1', updatedDaysAgo: 45 });
    await expense(stale, { categoryId: unmappedCategoryId });
    await report({ status: 'SUBMITTED', number: 'Y-2', submittedDaysAgo: 40, updatedDaysAgo: 40 });
    const returned = await report({ status: 'RETURNED', number: 'Y-3' });
    await admin.query(
      `INSERT INTO expense_report_event (organization_id, report_id, action, from_status,
                                         to_status, actor_id, note, created_at)
       VALUES ($1, $2, 'RETURN', 'SUBMITTED', 'RETURNED', $3, NULL, $4)`,
      [orgId, returned, userId, daysAgo(5)],
    );
    const approved = await report({
      status: 'APPROVED', number: 'Y-4', approvedDaysAgo: 5, updatedDaysAgo: 5,
    });
    await expense(approved, { receipt: false });
    const fx = await report({ status: 'SUBMITTED', number: 'Y-5', submittedDaysAgo: 5 });
    await expense(fx, { currency: 'CHF' });

    const findings = (
      await Promise.all(
        CONTROL_CHECKS.map((c) => withOrg(orgId, (tx) => c.run(tx, period, cfg))),
      )
    ).flat();

    const seen = new Set(findings.map((f) => f.messageCode));
    expect([...seen].sort()).toEqual([...Object.keys(CONTROL_MESSAGES)].sort());

    for (const f of findings) {
      for (const key of CONTROL_MESSAGES[f.messageCode].requires) {
        expect(
          Object.prototype.hasOwnProperty.call(f.data, key),
          `${f.messageCode} declares data.${key}, which ${f.controlCode} does not emit`,
        ).toBe(true);
      }
      for (const locale of SUPPORTED_LOCALES) {
        const text = renderControlMessage(f.messageCode, f.data, locale);
        expect(text, `${f.messageCode} in ${locale}`).not.toMatch(/^\{.*\}$/);
        // No record id in front of an auditor.
        expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i);
      }
    }

    // AND THE READER DECIDES THE FORMATTING, not the copy. There is one authored
    // locale, so an en-US reader falls back to en-CA COPY and must still get
    // en-US money and dates. Asserted here rather than in a separate unit file
    // because these are the only control sentences that carry both, and part 2b
    // shipped the bug this catches — the copy's locale handed to `Intl`.
    const stale2 = findings.find((f) => f.messageCode === 'STALE_DRAFT')!;
    const inCA = renderControlMessage('STALE_DRAFT', stale2.data, 'en-CA');
    const inUS = renderControlMessage('STALE_DRAFT', stale2.data, 'en-US');
    expect(inCA).toMatch(/\d{4}-\d{2}-\d{2}/); // ISO in en-CA
    expect(inUS).toMatch(/\d{2}\/\d{2}\/\d{4}/); // slashes in en-US
    expect(inUS).not.toBe(inCA);
  });
});
