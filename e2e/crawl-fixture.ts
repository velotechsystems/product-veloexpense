/**
 * VX4-10 part 2 — the data the pseudo-locale crawl measures against.
 *
 * ── THE PROBLEM THIS EXISTS TO FIX, AND IT WAS MY OWN ──────────────────────
 *
 * `scripts/seed.mjs` creates tenants, users, policies and reference data. It
 * creates **no reports and no approval tasks** — deliberately, because the
 * product's own e2e specs create the ones they need. The consequence for the
 * crawl is that every list screen it visits renders its EMPTY state, and the
 * ceilings in `pseudo-crawl.spec.ts` were therefore counts of empty pages.
 *
 * `#110` said as much and was right about what it was saying: *"the ratchet still
 * counts fewer un-catalogued strings on a page with less data, so its ceilings
 * are an upper bound rather than a measurement. That is sound for what it is for
 * — refusing GROWTH."* An upper bound is the correct instrument for refusing
 * growth. It is the wrong instrument for VX4-10, which uses those numbers as
 * TARGETS — and in part 1 I used one that way without noticing the difference.
 *
 * ── WHAT A FIXTURE CAN AND CANNOT FIX HERE ────────────────────────────────
 *
 * Not every screen. `pseudo-crawl.spec.ts` already carries `RATCHET_PATH`, which
 * measures `/expenses` through `?q=<a nonce matching nothing>` so its count is
 * chrome plus the empty state and does not drift with however many reports some
 * other spec filed. That is the ROBUST design and this file does not touch it:
 * in CI the crawl runs after the full Playwright suite, so the database holds
 * whatever that suite left, and a fixture makes a count deterministic only if
 * nothing else writes rows. Something else does.
 *
 * What a fixture is genuinely for is the branch that has no empty equivalent.
 * `/admin/billing`'s subscription card is not a table: no filter makes it empty
 * and no query string makes it appear. It renders when a subscription row exists
 * and otherwise does not exist at all — so part 1 measured a page that was only
 * ever half there, wrote `'/admin/billing': 0`, and left two English sentences
 * (`Trial ends …`, `Last confirmed with VeloTech …`) uncatalogued behind a
 * ceiling that claimed the screen was finished. With one subscription inserted by
 * hand that page read 5; with the subscription AND the reading this file installs
 * it reads 8. Both numbers are true of different databases, which is the whole
 * point being made — so the one worth quoting is the one this fixture produces.
 *
 * `/approvals` is the third case: it HAS rows, had no `RATCHET_PATH`, and never
 * got the caveat the file says such a page needs. Its ceiling of 15 was the empty
 * inbox, and it passed only while nothing ahead of it happened to leave a pending
 * task for the crawl's admin. This fixture makes it deterministic from the other
 * direction — it clears foreign pending tasks for that one user and installs
 * exactly two of its own, so the number is the same whatever ran first.
 *
 * ── WHAT IS STILL INVISIBLE, AND IT IS NOT A SMALL LIST ────────────────────
 *
 * The `?q=` trick buys `/expenses` its stability by giving something up, and the
 * spec says so in place: *"a hardcoded string that appears only inside a
 * /expenses table ROW is now invisible to this count."* True, and true of every
 * row-only string on every filtered screen. `{step} of {totalSteps}`,
 * `for <name>`, `routed <n> step(s) from the rung` are all row-only and all bare
 * English today; none would ever have appeared in a ceiling.
 *
 * This fixture is how they became VISIBLE ENOUGH TO CATALOGUE. It does not make
 * them verifiable — after cataloguing, the guarantee for that half is the
 * compiler plus `test/i18n-ui.test.ts`, not the crawl. Two different strengths of
 * evidence for two halves of one screen, which is worth knowing when reading a
 * green run.
 *
 * ── WHY NOT PUT THIS IN `scripts/seed.mjs` ─────────────────────────────────
 *
 * The seed is a product fixture with a gate of its own (VX5-18) and eleven other
 * specs assert against its counts. Reports appearing in it would change what
 * those specs measure, to serve a screen-counting ratchet none of them are about.
 * The crawl's fixture belongs to the crawl.
 *
 * ── WHY IT WRITES THROUGH THE ADMIN CONNECTION ─────────────────────────────
 *
 * `ADMIN_DATABASE_URL`, like `e2e/auth.setup.ts` and for the same reason: this is
 * harness setup standing outside the tenant, not product code, and routing it
 * through `asActor` would mean minting a session to create the data a session is
 * needed to see. Nothing in `lib/` may do this; the check in
 * `scripts/check-tenant-expression.mjs` is unaffected, because no tenant
 * predicate is being redeclared — this connects as a superuser and writes
 * `organization_id` explicitly on every row.
 *
 * IDEMPOTENT, because the crawl is re-run constantly during a cataloguing pass
 * and a fixture that doubled its rows every time would move the ceilings under
 * the work. Keyed on the marker in `TAG` rather than on `ON CONFLICT`, so a
 * partial previous run is cleaned rather than merged with.
 */
import { Pool } from 'pg';

/**
 * Stamped into every title this file writes. The cleanup below deletes by it, so
 * the fixture can never collide with a report a product spec created — and a
 * human staring at a seeded database can tell whose rows these are.
 */
const TAG = '[crawl-fixture]';

const ORG_SLUG = 'demo';
const ADMIN_EMAIL = 'admin@demo.test';
const MANAGER_EMAIL = 'manager@demo.test';
const EMPLOYEE_EMAIL = 'employee@demo.test';

/**
 * Enough reports to force a second page.
 *
 * `/expenses` pages at 25, and the pagination chrome — `Page n of m`, `Previous`,
 * `Next` — renders only when there is more than one. 26 is the smallest number
 * that makes those three strings visible to the ratchet, and they are exactly
 * the kind of copy that would otherwise be catalogued from a reading of the JSX
 * and never checked.
 */
const REPORT_COUNT = 26;

export interface CrawlFixture {
  orgId: string;
  adminId: string;
}

async function userId(pool: Pool, orgId: string, email: string): Promise<string> {
  const r = await pool.query('SELECT id FROM app_user WHERE organization_id = $1 AND email = $2', [
    orgId,
    email,
  ]);
  if (r.rowCount !== 1) {
    // Loud. A fixture that silently skipped a missing user would leave the
    // screens empty and the ceilings would quietly go back to measuring nothing
    // — the failure this whole file exists to stop.
    throw new Error(
      `crawl fixture: expected exactly one ${email} in ${ORG_SLUG}, found ${r.rowCount}. ` +
        'Has scripts/seed.mjs run?',
    );
  }
  return r.rows[0].id as string;
}

export async function installCrawlFixture(): Promise<CrawlFixture> {
  const connectionString = process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!connectionString) throw new Error('crawl fixture: no ADMIN_DATABASE_URL or DATABASE_URL');
  const pool = new Pool({ connectionString });

  try {
    const org = await pool.query('SELECT id FROM organization WHERE slug = $1', [ORG_SLUG]);
    if (org.rowCount !== 1) throw new Error(`crawl fixture: no organization '${ORG_SLUG}'`);
    const orgId = org.rows[0].id as string;

    const adminId = await userId(pool, orgId, ADMIN_EMAIL);
    const managerId = await userId(pool, orgId, MANAGER_EMAIL);
    const employeeId = await userId(pool, orgId, EMPLOYEE_EMAIL);

    // ── clean first ────────────────────────────────────────────────────────
    // Children before parents; `approval_task` has no cascade from the report.
    await pool.query(
      `DELETE FROM approval_task
        WHERE request_id IN (SELECT q.id FROM approval_request q
                               JOIN expense_report r ON r.id = q.report_id
                              WHERE r.title LIKE $1)`,
      [`${TAG}%`],
    );
    await pool.query(
      `DELETE FROM approval_request
        WHERE report_id IN (SELECT id FROM expense_report WHERE title LIKE $1)`,
      [`${TAG}%`],
    );
    await pool.query('DELETE FROM expense_report WHERE title LIKE $1', [`${TAG}%`]);
    await pool.query(
      'DELETE FROM delegation WHERE organization_id = $1 AND note = $2',
      [orgId, TAG],
    );
    // FOREIGN pending tasks for the crawl's admin, cleared.
    //
    // This is the one destructive thing in this file and it needs its reason in
    // place. `/approvals` has no filter that empties it, so unlike `/expenses` it
    // cannot be measured through a nonce — its count is whatever is in that one
    // user's inbox. In CI the crawl runs after the full suite, so anything that
    // spec left pending for `admin@demo.test` would land in the number and push
    // it over a ceiling that has nothing to do with copy.
    //
    // Scoped as narrowly as it can be: this org, this ONE user, status PENDING,
    // and only tasks assigned directly to them. It cannot reach another tenant, it
    // cannot reach a decided task, and it cannot reach anybody else's queue. The
    // crawl is the last thing that runs, so nothing downstream is deprived of a
    // task it was going to assert on — and if that ordering ever changes, this is
    // the line that has to be revisited.
    await pool.query(
      `DELETE FROM approval_task
        WHERE organization_id = $1 AND assignee_id = $2 AND status = 'PENDING'`,
      [orgId, adminId],
    );
    await pool.query('DELETE FROM subscription WHERE organization_id = $1', [orgId]);
    await pool.query('DELETE FROM subscription_meter_reading WHERE organization_id = $1', [orgId]);

    // ── /expenses: rows, every column, and a second page ───────────────────
    //
    // Statuses cycled rather than all SUBMITTED so the catalogued `StatusBadge`
    // renders more than one label. Those ARE catalogued (VX4-7 part 2a), so they
    // do not move the count -- which is the point: a page whose only visible
    // strings are catalogued ones is what "done" looks like here.
    //
    // REIMBURSED is in the cycle and carries its stamps, because the schema
    // refuses it otherwise: `expense_report_reimbursed_stamped` ties the status
    // to `reimbursed_at`, and `expense_report_reimbursement_complete` ties that
    // to `reimbursed_by_id`. A fixture is not a place to route around an
    // invariant -- the first draft of this insert did, and the constraint caught
    // it, which is the constraint doing exactly its job.
    await pool.query(
      `INSERT INTO expense_report
         (organization_id, number, title, status, total_minor, currency_code,
          submitter_id, submitted_at, created_at, reimbursed_at, reimbursed_by_id)
       SELECT $1,
              'EXP-9' || LPAD(i::text, 3, '0'),
              $2 || ' report ' || i,
              status,
              12500 + i * 137,
              'CAD',
              $3,
              now() - (i || ' hours')::interval,
              now() - (i || ' hours')::interval,
              CASE WHEN status = 'REIMBURSED' THEN now() - (i || ' hours')::interval END,
              CASE WHEN status = 'REIMBURSED' THEN $3::uuid END
         FROM generate_series(1, $4) AS i
         CROSS JOIN LATERAL (
           SELECT (ARRAY['SUBMITTED','APPROVED','REJECTED','RETURNED','REIMBURSED','DRAFT']
                     ::expense_report_status[])[1 + (i % 6)] AS status
         ) s`,
      [orgId, TAG, adminId, REPORT_COUNT],
    );

    // ── /approvals: one ASSIGNED task, escalated, with a named rung ────────
    //
    // Submitted by the EMPLOYEE, never by the admin: `canDecide` drops a report
    // routed to its own submitter, and a fixture that tripped over that would
    // leave the inbox empty while looking correct in the SQL.
    //
    // escalation_level 1 is deliberate. It is the only way to render "routed 1
    // step from the rung", a sentence with a count and a plural in it -- and the
    // reason this ticket needs a plural mechanism rather than two more flat keys.
    const assigned = await pool.query(
      `INSERT INTO expense_report
         (organization_id, number, title, status, total_minor, currency_code,
          submitter_id, submitted_at)
       VALUES ($1, 'EXP-9900', $2 || ' awaiting your decision', 'SUBMITTED', 84200, 'CAD', $3, now() - interval '3 days')
       RETURNING id`,
      [orgId, TAG, employeeId],
    );
    const assignedReport = assigned.rows[0].id as string;

    const request = await pool.query(
      `INSERT INTO approval_request
         (organization_id, report_id, policy_snapshot, status, current_step, total_steps,
          subject_total_minor, subject_currency_code, opened_by_id)
       VALUES ($1, $2, $3::jsonb, 'RUNNING', 1, 2, 84200, 'CAD', $4)
       RETURNING id`,
      [
        orgId,
        assignedReport,
        JSON.stringify([
          { step: 1, policyName: 'Manager review', requireReceiptViewAck: false },
          { step: 2, policyName: 'Finance review', requireReceiptViewAck: false },
        ]),
        employeeId,
      ],
    );
    await pool.query(
      `INSERT INTO approval_task
         (organization_id, request_id, step, assignee_id, resolved_via, escalation_level, status)
       VALUES ($1, $2, 1, $3, 'MANAGER_CHAIN', 1, 'PENDING')`,
      [orgId, request.rows[0].id as string, adminId],
    );

    // ── /approvals: one DELEGATED task, so "for <name>" renders ────────────
    const delegated = await pool.query(
      `INSERT INTO expense_report
         (organization_id, number, title, status, total_minor, currency_code,
          submitter_id, submitted_at)
       VALUES ($1, 'EXP-9901', $2 || ' covering for a colleague', 'SUBMITTED', 41000, 'CAD', $3, now() - interval '2 days')
       RETURNING id`,
      [orgId, TAG, employeeId],
    );
    const delegatedRequest = await pool.query(
      `INSERT INTO approval_request
         (organization_id, report_id, policy_snapshot, status, current_step, total_steps,
          subject_total_minor, subject_currency_code, opened_by_id)
       VALUES ($1, $2, $3::jsonb, 'RUNNING', 1, 1, 41000, 'CAD', $4)
       RETURNING id`,
      [
        orgId,
        delegated.rows[0].id as string,
        JSON.stringify([{ step: 1, policyName: 'Manager review', requireReceiptViewAck: false }]),
        employeeId,
      ],
    );
    await pool.query(
      `INSERT INTO approval_task
         (organization_id, request_id, step, assignee_id, resolved_via, escalation_level, status)
       VALUES ($1, $2, 1, $3, 'MANAGER_CHAIN', 0, 'PENDING')`,
      [orgId, delegatedRequest.rows[0].id as string, managerId],
    );
    await pool.query(
      `INSERT INTO delegation
         (organization_id, from_user_id, to_user_id, starts_on, ends_on, scope, created_by_id, note)
       VALUES ($1, $2, $3, current_date - 1, current_date + 30, 'ALL', $2, $4)`,
      [orgId, managerId, adminId, TAG],
    );

    // ── /admin/billing: the branch part 1 never saw ─────────────────────────
    //
    // TRIALING with a plan name, a trial end and a mirror timestamp, because
    // those three are what part 1's ceiling of 0 was blind to. One reading, so
    // the usage table renders rows rather than its empty state -- both branches
    // of that table have their own copy and only one of them was ever counted.
    await pool.query(
      `INSERT INTO subscription
         (organization_id, plan_code, status, plan_name, trial_ends_at, mirrored_at,
          current_period_start, current_period_end)
       VALUES ($1, 'veloexpense-team', 'TRIALING', 'VeloExpense Team',
               now() + interval '9 days', now() - interval '2 hours',
               date_trunc('month', now()), date_trunc('month', now()) + interval '1 month')`,
      [orgId],
    );
    await pool.query(
      `INSERT INTO subscription_meter_reading
         (organization_id, meter, plan_code, period_start, period_end, quantity)
       VALUES ($1, 'SEAT', 'veloexpense-team',
               date_trunc('month', now()) - interval '1 month',
               date_trunc('month', now()), 4)`,
      [orgId],
    );

    return { orgId, adminId };
  } finally {
    await pool.end();
  }
}

/**
 * ── BRANCHES THIS FIXTURE STILL DOES NOT RENDER ────────────────────────────
 *
 * Named because the lesson of part 1 is that an unrendered branch is an
 * uncounted branch, and the only thing worse than a ceiling that is too high is
 * one that is too low for a reason nobody wrote down.
 *
 *   · `/expenses?scope=all` — the org-wide view, which adds a `Submitter`
 *     column. The crawl visits bare paths; adding query strings would make
 *     `PAGES` a list of URLs rather than of screens, and the same argument
 *     applies to every filtered variant after it.
 *   · `/expenses` error banner — needs `?error=`, same reason.
 *   · `/approvals` ROLE_POOL route — needs a task with `claim_role` set and no
 *     assignee. Its label comes from `INBOX_ROUTE_COPY`, which is catalogued and
 *     tested by `test/i18n-enums.test.ts`, so nothing here is uncovered — only
 *     unrendered.
 *   · `/admin/billing` for a LAPSED, CANCELLED or SUSPENDED tenant. Those
 *     statuses render `STATUS_KEYS` entries, all catalogued and all covered by
 *     `test/i18n-ui.test.ts`, which asserts every entry resolves in every locale.
 *     A `Record<SubscriptionStatus, …>` makes a missing one a compile error, so
 *     this is the one place where the type system genuinely does the job the
 *     crawl would otherwise have to.
 *
 * The pattern in the last two is worth stating: an unrendered branch is safe
 * when its copy is reachable from an ENUMERATION the type system checks, and
 * unsafe when it is a literal in JSX. That is the same distinction `ui.ts`'s
 * header draws, arriving from the other direction.
 */
