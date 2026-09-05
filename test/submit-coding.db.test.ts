/**
 * UD-2 — a report that cannot post must not be submittable. Own org slug
 * ('coding-co'); the DB suites share one database and each TRUNCATEs.
 *
 * ── WHY THESE ARE DATABASE TESTS ────────────────────────────────────────────
 *
 * The definition of "coded" is a SQL `coalesce` over two LEFT JOINs — the
 * account snapshotted on the line, falling back to the category's current one.
 * A stub could only prove that the gate calls something.
 *
 * ── THE FOUR THINGS THAT HAVE TO HOLD ───────────────────────────────────────
 *
 * 1. With a ledger connected, an unmapped category REFUSES the submit.
 * 2. With NO ledger connected, the same report submits. Upstream's guard is
 *    skipped entirely when `loadNetSuiteConfig` returns null and a test asserts
 *    it is never reached; this is that test. Without it, this ticket invents a
 *    rule for every tenant that has no integration.
 * 3. The gate runs BEFORE the policy pass, so a report with both problems is
 *    told about the coding.
 * 4. The line's SNAPSHOT wins over the category's current state — a line coded
 *    when it was filed stays coded even if an admin later unmaps the category.
 *    That is AC-10's direction, and getting it backwards would refuse submits
 *    for reports that can post perfectly well.
 */
process.env.INTEGRATIONS_ENABLE_STUB = '1';
process.env.SECRET_ENCRYPTION_KEY =
  process.env.SECRET_ENCRYPTION_KEY ?? Buffer.alloc(32, 5).toString('base64');

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { Pool } from 'pg';
import { withOrg } from '@/lib/tenant/context';
import * as svc from '@/lib/expenses/service';
import * as lifecycle from '@/lib/expenses/lifecycle';
import * as integrations from '@/lib/integrations/service';
import * as policy from '@/lib/policy/service';
import { uncodedCategories, uncodedDiagnostic } from '@/lib/integrations/coding';
import { renderUserMessage } from '@/lib/i18n/catalog/errors';
import { errorParam, userMessageOf } from '@/lib/errors/domain';
import { TEST_ACTOR } from './support/audit-actor';
import { TODAY } from './support/dates';

const admin = new Pool({
  connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL,
});

let orgId: string;
let userId: string;
let userEmail: string;
let mappedCategoryId: string;
let unmappedCategoryId: string;
let accountId: string;

async function connectLedger(code = 'ledger') {
  await withOrg(orgId, (tx) =>
    integrations.installIntegration(
      tx,
      {
        slug: 'stub-ledger',
        code,
        label: 'Stub Ledger',
        config: { ledgerUrl: 'https://x.test', apiToken: 'tok' },
      },
      userId,
    ),
  );
}

/** A DRAFT with one line on `categoryId`. Returns the report and line ids. */
async function draftOn(categoryId: string, amountMinor = 5000) {
  return withOrg(orgId, async (tx) => {
    const report = await svc.createReport(tx, userEmail, {
      title: `Trip ${Math.random().toString(36).slice(2, 8)}`,
      currencyCode: 'CAD',
    });
    const expense = await svc.addExpense(tx, TEST_ACTOR, report.id, { txnDate: TODAY,
      currencyCode: 'CAD',
      merchant: 'Beck Taxi',
    });
    const line = await svc.addLineItem(tx, TEST_ACTOR, expense.id, { categoryId, amountMinor });
    return { reportId: report.id as string, lineId: line.id as string };
  });
}

const submit = (reportId: string) =>
  withOrg(orgId, (tx) => lifecycle.submitReport(tx, reportId, userId));

beforeAll(async () => {
  await admin.query('TRUNCATE app_user, organization CASCADE');
  const o = await admin.query(
    "INSERT INTO organization (slug, name) VALUES ('coding-co','Coding Co') RETURNING id",
  );
  orgId = o.rows[0].id;
  // VX4-1: absence means off, and since 0022 the gate is in `gl_account`'s RLS
  // policy, so this has to precede the account insert.
  await admin.query(
    `INSERT INTO module_entitlement (organization_id, module_code, enabled, enabled_at)
     VALUES ($1, 'accounting', true, clock_timestamp())`,
    [orgId],
  );
  userEmail = 'ada@coding.test';
  await withOrg(orgId, async (tx) => {
    // A MANAGER above the submitter. Submitting opens an approval run (VX2-3), and
    // a tenant whose only employee has neither a manager nor an active admin has
    // nobody to approve anything — which the resolver refuses, correctly. The
    // submit-SUCCEEDS cases here all failed on that before this fixture existed,
    // which is the resolver being right and my fixture being a one-person company.
    const m = await tx.query(
      `INSERT INTO app_user (organization_id, email, display_name, role)
       VALUES ($1,'mgr@coding.test','Mgr','MANAGER') RETURNING id`,
      [orgId],
    );
    const u = await tx.query(
      `INSERT INTO app_user (organization_id, email, display_name, role, manager_id)
       VALUES ($1, $2, 'Ada', 'EMPLOYEE', $3) RETURNING id`,
      [orgId, userEmail, m.rows[0].id],
    );
    userId = u.rows[0].id;
    const acct = await tx.query(
      `INSERT INTO gl_account (organization_id, number, name, type, is_postable, source)
       VALUES ($1,'68100','Travel','expense',true,'MANUAL') RETURNING id`,
      [orgId],
    );
    accountId = acct.rows[0].id;
    const mapped = await tx.query(
      `INSERT INTO expense_category (organization_id, code, label, gl_account_id)
       VALUES ($1,'travel','Travel',$2) RETURNING id`,
      [orgId, accountId],
    );
    mappedCategoryId = mapped.rows[0].id;
    const unmapped = await tx.query(
      `INSERT INTO expense_category (organization_id, code, label)
       VALUES ($1,'meals','Meals & Entertainment') RETURNING id`,
      [orgId],
    );
    unmappedCategoryId = unmapped.rows[0].id;
  });
});

beforeEach(async () => {
  await admin.query('DELETE FROM integration_installation');
  await admin.query('DELETE FROM expense_policy');
});

afterAll(async () => {
  await admin.query('TRUNCATE app_user, organization CASCADE');
  await admin.end();
});

describe('what counts as coded', () => {
  it('names the unmapped category and how many lines carry it', async () => {
    const { reportId } = await draftOn(unmappedCategoryId);
    const uncoded = await withOrg(orgId, (tx) => uncodedCategories(tx, reportId));
    expect(uncoded).toEqual([
      {
        categoryId: unmappedCategoryId,
        code: 'meals',
        label: 'Meals & Entertainment',
        lineItems: 1,
      },
    ]);
  });

  it('groups by category, because the category is what somebody fixes', async () => {
    const { reportId } = await draftOn(unmappedCategoryId);
    await withOrg(orgId, async (tx) => {
      const e = await tx.query('SELECT id FROM expense WHERE report_id = $1', [reportId]);
      await svc.addLineItem(tx, TEST_ACTOR, e.rows[0].id, {
        categoryId: unmappedCategoryId,
        amountMinor: 900,
      });
    });
    const uncoded = await withOrg(orgId, (tx) => uncodedCategories(tx, reportId));
    expect(uncoded).toHaveLength(1);
    expect(uncoded[0].lineItems).toBe(2);
  });

  it('says nothing about a mapped category', async () => {
    const { reportId } = await draftOn(mappedCategoryId);
    expect(await withOrg(orgId, (tx) => uncodedCategories(tx, reportId))).toEqual([]);
  });

  /**
   * AC-10's direction, and getting it backwards would refuse submits for reports
   * that can post perfectly well: the account is stamped on the line when the
   * line is filed, and un-mapping the category afterwards does not un-code it.
   */
  it('treats a line as coded from its own SNAPSHOT, not the category as it stands now', async () => {
    const { reportId, lineId } = await draftOn(mappedCategoryId);
    // The line was stamped at write time.
    const stamped = await admin.query('SELECT gl_account_id FROM expense_line_item WHERE id = $1', [
      lineId,
    ]);
    expect(stamped.rows[0].gl_account_id).toBe(accountId);

    // An admin now un-maps the category.
    await admin.query('UPDATE expense_category SET gl_account_id = NULL WHERE id = $1', [
      mappedCategoryId,
    ]);
    expect(await withOrg(orgId, (tx) => uncodedCategories(tx, reportId))).toEqual([]);

    await admin.query('UPDATE expense_category SET gl_account_id = $2 WHERE id = $1', [
      mappedCategoryId,
      accountId,
    ]);
  });

  it('states the size of the job, with the singular handled', () => {
    expect(
      uncodedDiagnostic([{ categoryId: 'a', code: 'm', label: 'Meals', lineItems: 1 }]),
    ).toBe('1 category has no GL account (Meals), covering 1 line item');
    expect(
      uncodedDiagnostic([
        { categoryId: 'a', code: 'm', label: 'Meals', lineItems: 2 },
        { categoryId: 'b', code: 't', label: 'Taxis', lineItems: 1 },
      ]),
    ).toBe('2 categories have no GL account (Meals, Taxis), covering 3 line items');
  });
});

describe('the submit gate', () => {
  it('REFUSES when a ledger is connected and a category is unmapped', async () => {
    await connectLedger();
    const { reportId } = await draftOn(unmappedCategoryId);
    const err = await submit(reportId).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(lifecycle.LifecycleError);
    expect((err as lifecycle.LifecycleError).code).toBe('UNCODED');
    // The diagnostic names the category and the size of the job, for the log.
    expect((err as Error).message).toContain('Meals & Entertainment');
    // The report is still a DRAFT — a refused submit must not half-happen.
    const after = await admin.query('SELECT status FROM expense_report WHERE id = $1', [reportId]);
    expect(after.rows[0].status).toBe('DRAFT');
  });

  it('tells the PERSON which categories, and who can fix them', async () => {
    await connectLedger();
    const { reportId } = await draftOn(unmappedCategoryId);
    const err = await submit(reportId).catch((e: unknown) => e);
    const user = userMessageOf(err);
    expect(user?.code).toBe('SUBMIT_UNCODED_ONE');
    // Rendered through `errorParam`, which is the ONLY path a message takes to a
    // screen — encoding the params into `?error=CODE~<base64url>` and back. A test
    // that rendered from the object would skip the half that can lose them.
    const sentence = renderUserMessage(errorParam(err, 'test'), 'en-CA');
    expect(sentence).toContain('Meals & Entertainment');
    // The employee cannot map a category — a refusal that does not say so leaves
    // them on a screen they have no permission to change.
    expect(sentence).toMatch(/administrator/i);
    // And no identifier reaches the reader (part 2c).
    expect(sentence).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/i);
  });

  /**
   * The test that stops this ticket from inventing a rule. The requirement comes
   * from the integration; a tenant with no ledger has nothing to be coded FOR.
   */
  it('does NOT refuse when no ledger is connected', async () => {
    const { reportId } = await draftOn(unmappedCategoryId);
    const result = await submit(reportId);
    expect(result.report.status).toBe('SUBMITTED');
  });

  it('does not refuse a report whose coding is complete', async () => {
    await connectLedger();
    const { reportId } = await draftOn(mappedCategoryId);
    const result = await submit(reportId);
    expect(result.report.status).toBe('SUBMITTED');
  });

  /**
   * Order matters and is asserted rather than assumed: coding is a FACT about the
   * report, a policy violation is a judgement about it, and somebody fixing
   * coding should not have to read past a policy warning to learn the report
   * cannot post at all.
   */
  it('reports the coding BEFORE the policy pass', async () => {
    await connectLedger();
    // A rule that blocks everything, so both problems are live at once.
    // A real rule kind — `RULE_KINDS` is the registry, and `createPolicy`
    // validates against it rather than a CHECK constraint (VX1-7). My first draft
    // invented 'AMOUNT_LIMIT' and the service refused it, correctly.
    await withOrg(orgId, (tx) =>
      policy.createPolicy(tx, {
        kind: 'PER_TRANSACTION_LIMIT',
        severity: 'BLOCK',
        params: { thresholdMinor: '1' },
      }),
    );
    const { reportId } = await draftOn(unmappedCategoryId);
    const err = await submit(reportId).catch((e: unknown) => e);
    expect((err as lifecycle.LifecycleError).code).toBe('UNCODED');
    expect((err as lifecycle.LifecycleError).code).not.toBe('BLOCKED_BY_POLICY');
  });

  /**
   * VX4-11 vs UD-2, and the order is deliberate. A missing DATE is a fact the
   * person filing has in front of them; an unmapped CATEGORY is admin-owned and a
   * dead end for them. So the one they can act on is reported first — being told
   * to go and ask an administrator, only to be told afterwards that you also
   * forgot the dates, is two trips for one submit.
   */
  it('reports a missing DATE before an unmapped category', async () => {
    await connectLedger();
    const { reportId } = await draftOn(unmappedCategoryId);
    await admin.query('UPDATE expense SET txn_date = NULL WHERE report_id = $1', [reportId]);
    const err = await submit(reportId).catch((e: unknown) => e);
    expect((err as lifecycle.LifecycleError).code).toBe('UNDATED');
  });

  /**
   * AC-22: two connected ledgers make the POSTING path refuse for ambiguity, but
   * the coding requirement does not care which one wins. `capabilityAvailability`
   * answers `connected: true` for this case on purpose, and the gate has to use
   * that answer rather than `requireCapability`, which throws.
   */
  it('still refuses when TWO ledgers are connected', async () => {
    await connectLedger();
    // `installIntegration` REFUSES this — AC-22's rival check runs in code, and
    // `integration_installation_one_active_idx` stops a second active row of the
    // same slug. So the ambiguous state is reached the only way it can be: a
    // second active row of a DIFFERENT slug, written directly. That is not a
    // contrived state — it is what `resolveCapability`'s AMBIGUOUS_CAPABILITY
    // branch and `capabilityAvailability`'s `connected: true` answer exist FOR,
    // and rows predating the rival check would look exactly like this.
    // `connected_at` and `connected_by_id` are all-or-nothing
    // (`integration_installation_connected_complete`), which caught the first
    // version of this insert — a connected row has to say who connected it.
    await admin.query(
      `INSERT INTO integration_installation
         (organization_id, integration_slug, code, label, active, config,
          connected_at, connected_by_id)
       VALUES ($1, 'veloledger', 'rival', 'Rival Ledger', true, '{}'::jsonb,
               clock_timestamp(), $2)`,
      [orgId, userId],
    );
    const { reportId } = await draftOn(unmappedCategoryId);
    const err = await submit(reportId).catch((e: unknown) => e);
    expect((err as lifecycle.LifecycleError).code).toBe('UNCODED');
  });

  /**
   * The accounting module being OFF is `connected: false`, so no gate. Worth its
   * own test because the alternative reading — module off, therefore refuse
   * everything — would break submission for every tenant that has not bought the
   * accounting module.
   */
  it('does not refuse when the accounting module is off', async () => {
    await connectLedger();
    await admin.query(
      'UPDATE module_entitlement SET enabled = false WHERE organization_id = $1 AND module_code = $2',
      [orgId, 'accounting'],
    );
    try {
      const { reportId } = await draftOn(unmappedCategoryId);
      const result = await submit(reportId);
      expect(result.report.status).toBe('SUBMITTED');
    } finally {
      await admin.query(
        'UPDATE module_entitlement SET enabled = true WHERE organization_id = $1 AND module_code = $2',
        [orgId, 'accounting'],
      );
    }
  });
});
