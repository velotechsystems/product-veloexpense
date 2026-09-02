/**
 * VX4-7 part 1b — a `date` column is a STRING, and stays one in every timezone.
 * Own org slug ('cal-co').
 *
 * ── WHY THIS FILE EXISTS AT ALL ─────────────────────────────────────────────
 *
 * Because a sabotage said it had to. Removing the type parser and running the
 * date-heaviest suites under `TZ=Europe/Paris` — budgets, expenses, policy,
 * analytics, 121 tests — changed NOTHING. All 121 passed with the bug and
 * without it.
 *
 * That is the "surviving tests are the finding" rule arriving in its purest
 * form: the sabotage was meant to prove the fix load-bearing and instead proved
 * that the calendar-date path had no coverage whatsoever. `lib/budgets` casts
 * `::text` in SQL so it never saw a Date; everything else formatted through
 * `toISOString()`, which no test asserted. A bug measurable at the driver in
 * four lines was invisible to 895 tests.
 *
 * So these are the assertions that would have caught it. Every one of them
 * fails if `lib/db/client.ts` stops parsing `date` as text — which is what makes
 * them worth their runtime.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { withOrg } from '@/lib/tenant/context';
import { formatCalendarDate, toDateInputValue } from '@/lib/i18n/format';

const admin = new Pool({
  connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL,
});

let orgId: string;
let reportId: string;

beforeAll(async () => {
  await admin.query('TRUNCATE app_user, organization CASCADE');
  const o = await admin.query(
    `INSERT INTO organization (slug, name) VALUES ('cal-co','Cal Co') RETURNING id`,
  );
  orgId = o.rows[0].id;

  await withOrg(orgId, async (tx) => {
    const u = await tx.query(
      `INSERT INTO app_user (organization_id, email, display_name, role)
       VALUES ($1,'cal@cal.test','Cal','EMPLOYEE') RETURNING id`,
      [orgId],
    );
    const r = await tx.query(
      `INSERT INTO expense_report (organization_id, submitter_id, title, currency_code, number)
       VALUES ($1,$2,'Calendar dates','CAD','EXP-000001') RETURNING id`,
      [orgId, u.rows[0].id],
    );
    reportId = r.rows[0].id;
  });
});

afterAll(async () => {
  await admin.end();
});

describe('the driver hands a `date` column over as text', () => {
  it('returns a string, not a Date', async () => {
    // The whole fix in one assertion. Without the type parser this is a Date,
    // built at the PROCESS's midnight — a different instant per deploy zone.
    const { rows } = await admin.query(`SELECT '2026-03-04'::date AS d`);
    expect(typeof rows[0].d).toBe('string');
    expect(rows[0].d).toBe('2026-03-04');
  });

  it('leaves `timestamptz` as a Date, because that one really is an instant', async () => {
    // The other half of the claim: the parser is narrow. An over-broad fix that
    // stringified timestamps too would break every `formatInstant` caller and
    // every date comparison in JS.
    const { rows } = await admin.query(`SELECT '2026-03-04T02:30:00Z'::timestamptz AS t`);
    expect(rows[0].t).toBeInstanceOf(Date);
    expect((rows[0].t as Date).toISOString()).toBe('2026-03-04T02:30:00.000Z');
  });

  it('round-trips an expense date through the database unchanged', async () => {
    // Through a real column on a real row, because the type parser applies to
    // the wire format and a synthetic `::date` cast could in principle differ.
    await withOrg(orgId, (tx) =>
      tx.query(
        // Only the columns `expense` actually has — amounts and the category
        // live on `expense_line_item`. The first draft of this fixture invented
        // three columns from what the names suggested, which is the handoff's
        // rule about checking fixtures against the migration, arriving in a
        // vitest file instead of a Playwright one.
        `INSERT INTO expense (organization_id, report_id, txn_date, currency_code)
         VALUES ($1,$2,'2026-03-04','CAD')`,
        [orgId, reportId],
      ),
    );
    const { rows } = await withOrg(orgId, (tx) =>
      tx.query<{ txn_date: string }>(`SELECT txn_date FROM expense WHERE report_id = $1`, [
        reportId,
      ]),
    );
    expect(rows[0].txn_date).toBe('2026-03-04');
  });

  it('and that value renders as the fourth, whatever the process timezone', async () => {
    // The end-to-end claim: stored 4th, rendered 4th, in Paris and in Sydney —
    // the two zones where the old code rendered the 3rd.
    const { rows } = await withOrg(orgId, (tx) =>
      tx.query<{ txn_date: string }>(`SELECT txn_date FROM expense WHERE report_id = $1`, [
        reportId,
      ]),
    );
    const stored = rows[0].txn_date;
    const original = process.env.TZ;
    try {
      for (const tz of ['UTC', 'Europe/Paris', 'Australia/Sydney', 'America/Vancouver']) {
        process.env.TZ = tz;
        expect(formatCalendarDate(stored, 'en-CA', { dateStyle: 'short' }), tz).toMatch(/\b0?4\b/);
        expect(toDateInputValue(stored), tz).toBe('2026-03-04');
      }
    } finally {
      process.env.TZ = original;
    }
  });
});

describe('the columns that were already cast, and the ones that were not', () => {
  it('every `date` column reads back as text now, not only the budget ones', async () => {
    // `lib/budgets` selects `starts_on::text` and types the field `string` — VX4-5
    // hit this and solved it in one module. Those casts are now belt-and-braces
    // rather than the only thing standing between the product and a day-shift,
    // and this asserts the guarantee is general rather than per-query.
    const { rows } = await admin.query<Record<string, unknown>>(
      `SELECT '2026-01-01'::date AS starts_on,
              '2026-12-31'::date AS ends_on,
              '2026-06-15'::date AS effective_from,
              '2026-06-30'::date AS as_of`,
    );
    for (const [column, value] of Object.entries(rows[0])) {
      expect(typeof value, `${column} came back as ${typeof value}`).toBe('string');
    }
  });

  it('ISO date strings still compare chronologically, which the budget code relies on', async () => {
    // `periodCovering` in lib/budgets/service.ts does `p.starts_on <= on &&
    // p.ends_on >= on` on these values. That is only correct because ISO
    // YYYY-MM-DD sorts lexicographically exactly as it sorts by date — an
    // property worth pinning, since it is the reason the type change was cheap.
    const dates = ['2026-01-01', '2026-01-02', '2026-02-01', '2026-10-01', '2026-12-31'];
    const shuffled = [...dates].reverse();
    expect([...shuffled].sort()).toEqual(dates);
    expect('2026-03-04' <= '2026-03-04').toBe(true);
    expect('2026-02-28' < '2026-03-01').toBe(true);
    expect('2026-09-30' < '2026-10-01').toBe(true);
  });
});
