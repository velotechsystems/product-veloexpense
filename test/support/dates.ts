/**
 * VX4-11 — the date a fixture gives an expense when the date is not the subject.
 *
 * ── WHY THIS IS TODAY AND NOT A FIXED DATE ──────────────────────────────────
 *
 * VX4-11 made `txn_date` required at submit, so ~32 fixtures across fifteen
 * suites had to start supplying one. The first attempt hardcoded `2026-08-15`,
 * and it worked — for one day.
 *
 * `test/budgets.db.test.ts` builds its period as `current_date - 20` to
 * `current_date + 20`. On the day that fixture was written, 2026-08-15 was the
 * first day inside the window. The clock rolled to the 5th and the window moved
 * with it, so the same literal was suddenly one day OUTSIDE — the spend fell in
 * no period, twenty-three rollup assertions read 0 instead of 1800, and nothing
 * about the failure pointed at a date.
 *
 * That is the ticket's own subject biting the ticket: `txn_date` decides which
 * fiscal period spend lands in, which is exactly why an undated expense is a
 * problem worth a submit gate. A fixture date that is fixed while the period is
 * relative is a test that expires.
 *
 * So: TODAY. It is inside any window expressed relative to today, it needs no
 * suite to know what the others chose, and it is what a person filing an expense
 * would actually type. Suites where the DATE ITSELF is the subject — the
 * duplicate detector's window, the analytics ranges — set their own and should
 * keep doing so.
 */
export const TODAY = new Date().toISOString().slice(0, 10);
