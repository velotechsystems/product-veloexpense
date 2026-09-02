/**
 * VX4-5 part 3a — budget threshold alerts, fired once per crossing.
 *
 * ── What is ported, and what is replaced ────────────────────────────────────
 *
 * ExpenseOS's `fireBudgetThresholdAlerts` (`server/lib/budgetAlerts.ts`) gets the
 * PRODUCT right and the MECHANISM wrong, so its rules are kept verbatim and its
 * bookkeeping is not:
 *
 *   · Fire once per crossing, suppressed until a HIGHER threshold is crossed or
 *     the period falls back under every one — at which point it re-arms. Their
 *     reason: "every save that leaves a period over budget crosses the same
 *     threshold again, and an alert that arrives on every save is one people
 *     filter within a day."
 *   · Owner FIRST, then that threshold's own recipients. An empty recipient list
 *     means "owner only" and never "nobody".
 *   · Nobody to tell is still a crossing: record it, so that making somebody the
 *     owner next month does not deliver a backlog of stale alerts.
 *   · NEVER THROW OUT OF HERE. A failed alert must not roll back the spend that
 *     caused it — "an expense report that cannot be submitted because a
 *     notification failed is a worse outcome than a missing notification."
 *
 * What is replaced is `BudgetPeriod.alertedThresholdBp`, a mutable marker stamped
 * after the fan-out, which BG-6 shows can double-send three ways. The claim is a
 * uniquely-keyed ROW (`0025`), written in the transaction that sends.
 *
 * ── The SAVEPOINT, which is the part worth reading twice ────────────────────
 *
 * Their comment says the marker is stamped last "so a failure re-fires next time
 * rather than marking a crossing nobody was told about". That instinct is right
 * and their ordering cannot deliver it: if the fan-out succeeds and the stamp
 * throws, their `catch` swallows it and the identical alert goes again.
 *
 * Claiming FIRST fixes the race and appears to create their problem in reverse —
 * a claim row committed for a send that then failed. It does not, because both
 * statements are in ONE transaction and this wraps them in a SAVEPOINT: a failed
 * send rolls the claim back with it, and the crossing is re-evaluated next time.
 * So there is no ordering left to get wrong, which is the difference between
 * "stamp late and hope" and a guarantee.
 *
 * The savepoint is also what lets this honour "never throw" while running inside
 * somebody else's transaction. A caught error in Postgres leaves the whole
 * transaction aborted unless there is a savepoint to roll back to — so without
 * one, swallowing an alert failure here would poison the submit that called it,
 * which is precisely the outcome the rule exists to prevent.
 *
 * ── Where this is called from, and where it is NOT ──────────────────────────
 *
 * From `recomputeForReport` — the transition hook — and never from
 * `recomputePeriods` directly. The loader's first-sight recompute
 * (`loadBudgetSnapshots`) also writes totals, but it is a lazy initialisation of
 * a baseline rather than an observation that spend moved: firing there would
 * alert on history the moment somebody opened a draft, attributed to whoever
 * happened to be editing.
 */
import type { QueryRunner } from '@/lib/db/client';
import { formatMinor } from '@/lib/money';
import { crossedThresholdBp } from '@/lib/budgets/scope';
import { notify } from '@/lib/notifications/service';

export interface AlertOutcome {
  /** Crossings claimed and fanned out on this call. */
  fired: number;
  /** Periods that fell back under every threshold and had their claims cleared. */
  rearmed: number;
}

interface PeriodAlertRow {
  period_id: string;
  budget_id: string;
  budget_name: string;
  owner_id: string | null;
  currency_code: string;
  minor_unit: number;
  starts_on: string;
  ends_on: string;
  amount_minor: string;
  actual_minor: string;
  pending_minor: string;
}

/**
 * Evaluate every named period against its budget's thresholds, and alert once per
 * new crossing.
 *
 * `periodIds` is what the rollup just rewrote, so this never scans a period whose
 * numbers did not move.
 */
export async function fireThresholdAlerts(
  tx: QueryRunner,
  periodIds: readonly string[],
  actorId: string | null,
): Promise<AlertOutcome> {
  const out: AlertOutcome = { fired: 0, rearmed: 0 };
  if (periodIds.length === 0) return out;

  const rows = await tx.query(
    `SELECT p.id AS period_id, p.budget_id, b.name AS budget_name, b.owner_id,
            b.currency_code, c.minor_unit,
            p.starts_on::text, p.ends_on::text,
            p.amount_minor, p.actual_minor, p.pending_minor
       FROM budget_period p
       JOIN budget b ON b.id = p.budget_id
       JOIN currency c ON c.code = b.currency_code
      WHERE p.id = ANY($1::uuid[])`,
    [periodIds],
  );

  for (const row of rows.rows as PeriodAlertRow[]) {
    const thresholds = await tx.query(
      'SELECT threshold_bp FROM budget_alert_threshold WHERE budget_id = $1 ORDER BY threshold_bp',
      [row.budget_id],
    );
    const levels = thresholds.rows.map((t) => Number(t.threshold_bp));

    const amountMinor = BigInt(row.amount_minor);
    const usedMinor = BigInt(row.actual_minor) + BigInt(row.pending_minor);
    const crossed =
      levels.length === 0 ? null : crossedThresholdBp(amountMinor, usedMinor, levels);

    if (crossed === null) {
      // Under every threshold — or no thresholds configured at all. RE-ARM.
      // Without this a budget that goes over, gets a correction and goes over
      // again stays silent the second time, because the first crossing's claim
      // suppresses it forever. Their `clearBudgetAlertMarkers` exists for exactly
      // this and the reasoning is theirs.
      const cleared = await tx.query(
        'DELETE FROM budget_alert_claim WHERE period_id = $1 RETURNING id',
        [row.period_id],
      );
      out.rearmed += cleared.rowCount ?? 0;
      continue;
    }

    // The fast-fail. This read RACES and is not the guard — it is here so the
    // common case (a period sitting over budget while reports come and go) costs
    // one indexed read rather than an insert that always conflicts. Same
    // relationship `decide`'s read-check has with its `AND status = 'PENDING'`.
    const already = await tx.query(
      `SELECT 1 FROM budget_alert_claim
        WHERE period_id = $1 AND threshold_bp >= $2 LIMIT 1`,
      [row.period_id, crossed],
    );
    if (already.rows.length > 0) continue;

    await tx.query('SAVEPOINT budget_alert');
    try {
      // THE CLAIM. The loser of a race gets no row back and sends nothing.
      const claim = await tx.query(
        `INSERT INTO budget_alert_claim
           (organization_id, period_id, threshold_bp, used_minor, amount_minor)
         VALUES (NULLIF(current_setting('app.current_org', true), '')::uuid, $1, $2, $3, $4)
         ON CONFLICT (organization_id, period_id, threshold_bp) DO NOTHING
         RETURNING id`,
        [row.period_id, crossed, usedMinor.toString(), amountMinor.toString()],
      );
      if (claim.rows.length === 0) {
        await tx.query('RELEASE SAVEPOINT budget_alert');
        continue;
      }

      const recipients = await tx.query(
        `SELECT r.user_id
           FROM budget_alert_recipient r
           JOIN budget_alert_threshold t ON t.id = r.threshold_id
          WHERE t.budget_id = $1 AND t.threshold_bp = $2`,
        [row.budget_id, crossed],
      );
      // Owner first, then the level's own recipients. `notifyRecipients` de-dupes,
      // so an owner who is also a named recipient gets one row.
      const audience = [
        ...(row.owner_id ? [row.owner_id] : []),
        ...recipients.rows.map((r) => r.user_id as string),
      ];

      const money = (v: bigint) => formatMinor(v, row.currency_code, Number(row.minor_unit));
      const { notified } = await notify(
        tx,
        {
          subjectType: 'BUDGET',
          subjectId: row.budget_id,
          eventType: 'BUDGET_THRESHOLD',
          actorId,
          payload: {
            budget: row.budget_name,
            period: `${row.starts_on} to ${row.ends_on}`,
            thresholdPercent: String(Math.round(crossed / 100)),
            used: money(usedMinor),
            amount: money(amountMinor),
            budgetId: row.budget_id,
            periodId: row.period_id,
            crossedBp: String(crossed),
            // Strings, never bigint: JSON.stringify throws on a BigInt, inside the
            // transaction that was doing real work. Same rule the audit payload
            // follows (AU-5).
            usedMinor: usedMinor.toString(),
            amountMinor: amountMinor.toString(),
          },
        },
        audience,
        // THE ONE PLACE THIS OPTION IS USED. A budget owner who files the claim
        // that breaks their own budget is exactly the person who needs telling —
        // ExpenseOS says so, and the default rule (never notify the actor about
        // their own action) is right for every event whose subject IS the action.
        { includeActor: true },
      );

      // Zero is a real answer and is recorded rather than treated as a failure:
      // "nobody to tell, but the crossing still happened", so making somebody the
      // owner next month does not deliver a backlog of stale alerts.
      await tx.query('UPDATE budget_alert_claim SET notified_count = $2 WHERE id = $1', [
        claim.rows[0].id,
        notified.length,
      ]);
      await tx.query('RELEASE SAVEPOINT budget_alert');
      out.fired += 1;
    } catch (err) {
      // The claim goes back with the send. See the header: this is what makes
      // "re-fires next time rather than marking a crossing nobody was told about"
      // a guarantee instead of an ordering convention — and what keeps a failed
      // alert from poisoning the transaction that was submitting a report.
      await tx.query('ROLLBACK TO SAVEPOINT budget_alert');
      await tx.query('RELEASE SAVEPOINT budget_alert');
      console.warn(
        '[budgets] threshold alert failed',
        row.budget_id,
        row.period_id,
        crossed,
        err,
      );
    }
  }

  return out;
}
