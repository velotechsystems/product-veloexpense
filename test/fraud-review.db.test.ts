/**
 * VX4-8 part 4 — a person's verdict, a person's flag, and the tenant sweep.
 * Own org slug ('rev-co').
 *
 * ── THE ONE INVARIANT THIS FILE EXISTS FOR ──────────────────────────────────
 *
 * A flag has two authors and neither may undo the other. Part 2 proved the
 * machine's half (a scan cannot touch a reviewed row). This proves the person's:
 * a verdict is a conditional write, so two reviewers clicking at once produce ONE
 * verdict and one refusal — and the refusal says which of the two things went
 * wrong, because "somebody got there first" and "that does not exist" lead a
 * person to different next actions.
 */
process.env.SECRET_ENCRYPTION_KEY =
  process.env.SECRET_ENCRYPTION_KEY ?? Buffer.alloc(32, 13).toString('base64');

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { Pool } from 'pg';
import { withOrg } from '@/lib/tenant/context';
import {
  FLAG_STATUSES,
  VERDICTS,
  isVerdict,
  listFlags,
  flagSummary,
  raiseManualFlag,
  recordVerdict,
} from '@/lib/fraud/review';
import { manualFinding } from '@/lib/fraud/rules';
import { scanAllTenants } from '@/lib/fraud/scan';
import { evaluateAllTenants } from '@/lib/fraud/evaluate';
import { organizationsWithModule } from '@/lib/modules/service';
import { renderFraudMessage } from '@/lib/i18n/catalog/fraud-messages';
import { DEFAULT_LOCALE } from '@/lib/i18n/locales';
import { isModuleDisabled } from '@/lib/modules/errors';

const admin = new Pool({
  connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL,
});

let orgId: string;
let otherOrgId: string;
let reviewerId: string;
let reportId: string;
const actor = { id: '', name: 'Rea Reviewer', role: 'ADMIN' as const };

async function seedFlag(key = 'DUPLICATE:one'): Promise<string> {
  const r = await admin.query(
    `INSERT INTO fraud_flag (organization_id, rule_code, severity, message_code, data,
                             report_id, finding_key)
     VALUES ($1, 'DUPLICATE', 'HIGH', 'DUPLICATE_SAME_REPORT', $2, $3, $4) RETURNING id`,
    [
      orgId,
      JSON.stringify({
        merchant: 'Beck Taxi',
        amountMinor: '4150',
        currencyCode: 'CAD',
        minorUnit: 2,
        otherDate: '2026-03-04',
        windowDays: 3,
      }),
      reportId,
      key,
    ],
  );
  return r.rows[0].id as string;
}

beforeAll(async () => {
  const orgs = await admin.query(
    `INSERT INTO organization (slug, name) VALUES ('rev-co','Rev Co'), ('rev-co-2','Rev Co 2')
     RETURNING id, slug`,
  );
  orgId = orgs.rows.find((r) => r.slug === 'rev-co').id;
  otherOrgId = orgs.rows.find((r) => r.slug === 'rev-co-2').id;
  // Only the FIRST tenant is entitled to COMPLIANCE — the sweep tests turn on
  // that. The second gets a DIFFERENT module, and that detail is load-bearing:
  // with no entitlement row at all it would be invisible to the sweep whether or
  // not the query filtered by module, so a sabotage that dropped the filter
  // passed every test. The surviving tests were the finding.
  await admin.query(
    `INSERT INTO module_entitlement (organization_id, module_code, enabled, enabled_at)
     VALUES ($1, 'compliance', true, clock_timestamp()), ($2, 'accounting', true, clock_timestamp())`,
    [orgId, otherOrgId],
  );
  const u = await admin.query(
    `INSERT INTO app_user (organization_id, email, display_name)
     VALUES ($1,'rea@rev.test','Rea Reviewer') RETURNING id`,
    [orgId],
  );
  reviewerId = u.rows[0].id;
  actor.id = reviewerId;
  const rep = await admin.query(
    `INSERT INTO expense_report (organization_id, submitter_id, title, currency_code, status,
                                 number, total_minor)
     VALUES ($1, $2, 'A report', 'CAD', 'APPROVED', 'EXP-000900', 4150) RETURNING id`,
    [orgId, reviewerId],
  );
  reportId = rep.rows[0].id;
});

beforeEach(async () => {
  await admin.query('DELETE FROM fraud_flag');
  await admin.query('DELETE FROM control_finding');
  await admin.query('DELETE FROM control_evaluation_run');
});

afterAll(async () => {
  await admin.query('TRUNCATE app_user, organization CASCADE');
  await admin.end();
});

describe('the verdict vocabulary', () => {
  it('ACTIVE is not a verdict a person can reach', () => {
    expect([...VERDICTS]).toEqual(['RESOLVED', 'DISMISSED', 'ESCALATED']);
    expect(isVerdict('ACTIVE')).toBe(false);
    // And the status union is the scan's one plus the person's three.
    expect([...FLAG_STATUSES]).toEqual(['ACTIVE', ...VERDICTS]);
  });
});

describe('recording a verdict', () => {
  it('resolves a flag, stamps the reviewer, and audits it against the report', async () => {
    const id = await seedFlag();
    await withOrg(orgId, (tx) => recordVerdict(tx, actor, { flagId: id, verdict: 'RESOLVED' }));
    const row = await admin.query('SELECT * FROM fraud_flag WHERE id = $1', [id]);
    expect(row.rows[0].status).toBe('RESOLVED');
    expect(row.rows[0].reviewed_by_id).toBe(reviewerId);
    expect(row.rows[0].reviewed_at).not.toBeNull();

    const audit = await admin.query(
      // ORDER BY `sequence`, NOT `id`.
      //
      // `audit_entry.id` is `gen_random_uuid()` — random, not time-ordered — so
      // "the latest row" by id is an arbitrary row. This assertion passed for a
      // while and then failed under four unrelated sabotage runs in a row, which
      // is what a flaky test looks like when you finally run the file five times.
      // `sequence` is the chain's own monotonic bigint and is what "latest"
      // means here.
      `SELECT action, entity_type, entity_id, details FROM audit_entry
        WHERE organization_id = $1 ORDER BY sequence DESC LIMIT 1`,
      [orgId],
    );
    expect(audit.rows[0].action).toBe('FRAUD_FLAG_RESOLVED');
    // Against the REPORT, so the decision sits in the same chain as its approval.
    expect(audit.rows[0].entity_type).toBe('expense_report');
    expect(audit.rows[0].entity_id).toBe(reportId);
  });

  it('REFUSES a dismissal with no note — the one verdict somebody may be asked about', async () => {
    const id = await seedFlag();
    await expect(
      withOrg(orgId, (tx) => recordVerdict(tx, actor, { flagId: id, verdict: 'DISMISSED' })),
    ).rejects.toMatchObject({ code: 'NOTE_REQUIRED' });
    // Nothing was written — the guard is before the update, not after it.
    const row = await admin.query('SELECT status FROM fraud_flag WHERE id = $1', [id]);
    expect(row.rows[0].status).toBe('ACTIVE');
  });

  it('accepts a dismissal WITH a note, and keeps the note in both places', async () => {
    const id = await seedFlag();
    await withOrg(orgId, (tx) =>
      recordVerdict(tx, actor, { flagId: id, verdict: 'DISMISSED', note: 'one dinner, two receipts' }),
    );
    const row = await admin.query('SELECT status, review_note FROM fraud_flag WHERE id = $1', [id]);
    expect(row.rows[0].status).toBe('DISMISSED');
    expect(row.rows[0].review_note).toBe('one dinner, two receipts');
    // AND in the audit chain, which outlives the flag: the row cascades with its
    // report, the chain does not.
    const audit = await admin.query(
      // `sequence`, not `id` — see the note above.
      `SELECT details FROM audit_entry WHERE organization_id = $1 ORDER BY sequence DESC LIMIT 1`,
      [orgId],
    );
    expect(audit.rows[0].details.note).toBe('one dinner, two receipts');
  });

  it('resolving and escalating need no note', async () => {
    for (const verdict of ['RESOLVED', 'ESCALATED'] as const) {
      const id = await seedFlag(`DUPLICATE:${verdict}`);
      await expect(
        withOrg(orgId, (tx) => recordVerdict(tx, actor, { flagId: id, verdict })),
      ).resolves.toBeUndefined();
    }
  });

  it('a second verdict is REFUSED, and says somebody got there first', async () => {
    const id = await seedFlag();
    await withOrg(orgId, (tx) => recordVerdict(tx, actor, { flagId: id, verdict: 'ESCALATED' }));
    await expect(
      withOrg(orgId, (tx) => recordVerdict(tx, actor, { flagId: id, verdict: 'RESOLVED' })),
    ).rejects.toMatchObject({ code: 'FLAG_ALREADY_REVIEWED' });
    // The FIRST verdict stands.
    const row = await admin.query('SELECT status FROM fraud_flag WHERE id = $1', [id]);
    expect(row.rows[0].status).toBe('ESCALATED');
  });

  it('a flag that does not exist is a DIFFERENT refusal from one already decided', async () => {
    await expect(
      withOrg(orgId, (tx) =>
        recordVerdict(tx, actor, {
          flagId: '00000000-0000-4000-8000-00000000dead',
          verdict: 'RESOLVED',
        }),
      ),
    ).rejects.toMatchObject({ code: 'FLAG_NOT_FOUND' });
  });

  it('is gated on the compliance module', async () => {
    const id = await seedFlag();
    await admin.query(
      `UPDATE module_entitlement SET enabled = false
        WHERE organization_id = $1 AND module_code = 'compliance'`,
      [orgId],
    );
    try {
      await expect(
        withOrg(orgId, (tx) => recordVerdict(tx, actor, { flagId: id, verdict: 'RESOLVED' })),
      ).rejects.toSatisfy(isModuleDisabled);
    } finally {
      await admin.query(
        `UPDATE module_entitlement SET enabled = true
          WHERE organization_id = $1 AND module_code = 'compliance'`,
        [orgId],
      );
    }
  });
});

describe('raising a flag by hand', () => {
  it('stores the person\'s own words, and they render as the message', async () => {
    const id = await withOrg(orgId, (tx) =>
      raiseManualFlag(tx, actor, {
        note: 'Tip from the Vancouver office about this vendor.',
        severity: 'MEDIUM',
        reportId,
      }),
    );
    const row = await admin.query('SELECT * FROM fraud_flag WHERE id = $1', [id]);
    expect(row.rows[0].rule_code).toBe('MANUAL');
    expect(row.rows[0].message_code).toBe('MANUAL_FLAG');
    expect(row.rows[0].status).toBe('ACTIVE');
    // The catalogue passes it through unchanged — no "A reviewer noted:" wrapper.
    expect(renderFraudMessage('MANUAL_FLAG', row.rows[0].data, DEFAULT_LOCALE)).toBe(
      'Tip from the Vancouver office about this vendor.',
    );
  });

  it('refuses a flag with no subject — a flag about nothing is not a flag', async () => {
    // `fraud_flag_subject_chk` (0031) would refuse it anyway, with the generic
    // "something went wrong". This is the refusal that can say what to do
    // instead — and it had NO unit coverage until a sabotage that removed it
    // failed nothing at all.
    await expect(
      withOrg(orgId, (tx) =>
        raiseManualFlag(tx, actor, { note: 'a concern about nothing', severity: 'LOW' }),
      ),
    ).rejects.toMatchObject({ code: 'SUBJECT_REQUIRED' });
  });

  it('accepts a flag about a PERSON with no report', async () => {
    // The other half of the same rule: a report is not the only subject a
    // concern can have.
    const id = await withOrg(orgId, (tx) =>
      raiseManualFlag(tx, actor, {
        note: 'pattern across several of their reports',
        severity: 'MEDIUM',
        subjectUserId: reviewerId,
      }),
    );
    const row = await admin.query('SELECT report_id, subject_user_id FROM fraud_flag WHERE id = $1', [id]);
    expect(row.rows[0].report_id).toBeNull();
    expect(row.rows[0].subject_user_id).toBe(reviewerId);
  });

  it('refuses an empty note', async () => {
    await expect(
      withOrg(orgId, (tx) => raiseManualFlag(tx, actor, { note: '   ', severity: 'LOW' })),
    ).rejects.toMatchObject({ code: 'NOTE_REQUIRED' });
  });

  it('two people can raise the same concern without overwriting each other', async () => {
    // The one finding key in the product NOT derived from what was found. Two
    // manual flags about one report are two rows, by construction.
    const a = await withOrg(orgId, (tx) =>
      raiseManualFlag(tx, actor, { note: 'first concern', severity: 'LOW', reportId }),
    );
    const b = await withOrg(orgId, (tx) =>
      raiseManualFlag(tx, { ...actor, id: reviewerId }, {
        note: 'second concern',
        severity: 'LOW',
        reportId,
      }),
    );
    expect(a).not.toBe(b);
    const rows = await admin.query('SELECT count(*)::int AS n FROM fraud_flag');
    expect(rows.rows[0].n).toBe(2);
  });

  it('the finding is built in rules.ts, where check:i18n can see its code', () => {
    // Not a style assertion. `scripts/check-i18n.mjs` scans lib/fraud/rules.ts for
    // `finding(RULE, CODE, …)`; a manual flag assembled in review.ts would be a
    // message code the gate cannot see, and part 2 had MANUAL_FLAG refused as
    // orphan copy for exactly that reason.
    const f = manualFinding({
      note: 'x',
      severity: 'LOW',
      reportId: null,
      subjectUserId: null,
      raisedBy: reviewerId,
    });
    expect(f.messageCode).toBe('MANUAL_FLAG');
    expect(f.ruleCode).toBe('MANUAL');
    expect(f.findingKey.startsWith('MANUAL:')).toBe(true);
  });

  it('a manual flag goes through the same review path as a detected one', async () => {
    const id = await withOrg(orgId, (tx) =>
      raiseManualFlag(tx, actor, { note: 'look at this', severity: 'HIGH', reportId }),
    );
    await withOrg(orgId, (tx) =>
      recordVerdict(tx, actor, { flagId: id, verdict: 'DISMISSED', note: 'checked, fine' }),
    );
    const row = await admin.query('SELECT status FROM fraud_flag WHERE id = $1', [id]);
    expect(row.rows[0].status).toBe('DISMISSED');
  });
});

describe('the queue a person reads', () => {
  it('puts open flags first, worst first, and keeps decided ones visible', async () => {
    const high = await seedFlag('K:high');
    await admin.query("UPDATE fraud_flag SET severity = 'HIGH' WHERE id = $1", [high]);
    const low = await seedFlag('K:low');
    await admin.query("UPDATE fraud_flag SET severity = 'LOW' WHERE id = $1", [low]);
    const decided = await seedFlag('K:decided');
    await withOrg(orgId, (tx) =>
      recordVerdict(tx, actor, { flagId: decided, verdict: 'RESOLVED' }),
    );

    const flags = await withOrg(orgId, (tx) => listFlags(tx));
    expect(flags.map((f) => f.id)).toEqual([high, low, decided]);
    // ONE LIST, not a filter the screen has to remember: "what did we decide
    // about this" has to be answerable without another page.
    expect(flags[2].status).toBe('RESOLVED');
  });

  it('summarises open, decided and worth-opening separately', async () => {
    await seedFlag('S:1');
    const two = await seedFlag('S:2');
    await admin.query("UPDATE fraud_flag SET severity = 'LOW' WHERE id = $1", [two]);
    const three = await seedFlag('S:3');
    await withOrg(orgId, (tx) => recordVerdict(tx, actor, { flagId: three, verdict: 'RESOLVED' }));
    const s = await withOrg(orgId, (tx) => flagSummary(tx));
    expect(s).toEqual({ active: 2, reviewed: 1, critical: 1 });
  });
});

describe('the tenant sweep', () => {
  it('lists only tenants entitled to THIS module, through the 0033 hatch', async () => {
    const orgs = await organizationsWithModule('compliance');
    expect(orgs).toContain(orgId);
    // The second tenant HAS an enabled entitlement — for a different module. So
    // this asserts the module filter rather than merely the hatch.
    expect(orgs).not.toContain(otherOrgId);
    expect(await organizationsWithModule('accounting')).toContain(otherOrgId);
  });

  it('a DISABLED entitlement is invisible to the sweep', async () => {
    await admin.query(
      `UPDATE module_entitlement SET enabled = false
        WHERE organization_id = $1 AND module_code = 'compliance'`,
      [orgId],
    );
    try {
      expect(await organizationsWithModule('compliance')).not.toContain(orgId);
    } finally {
      await admin.query(
        `UPDATE module_entitlement SET enabled = true
          WHERE organization_id = $1 AND module_code = 'compliance'`,
        [orgId],
      );
    }
  });

  it('scans every entitled tenant and reports per-tenant failure', async () => {
    const result = await scanAllTenants();
    expect(result.organizations).toBeGreaterThanOrEqual(1);
    expect(result.failed).toEqual([]);
  });

  it('evaluates every entitled tenant, and writes one run each', async () => {
    const before = await admin.query('SELECT count(*)::int AS n FROM control_evaluation_run');
    const result = await evaluateAllTenants();
    expect(result.runs).toBe(result.organizations);
    const after = await admin.query('SELECT count(*)::int AS n FROM control_evaluation_run');
    expect(after.rows[0].n).toBe(before.rows[0].n + result.runs);
    // The unentitled tenant got nothing.
    const other = await admin.query(
      'SELECT count(*)::int AS n FROM control_evaluation_run WHERE organization_id = $1',
      [otherOrgId],
    );
    expect(other.rows[0].n).toBe(0);
  });
});
