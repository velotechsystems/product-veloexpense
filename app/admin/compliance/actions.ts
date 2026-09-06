'use server';
/**
 * VX4-8 part 4 — /admin/compliance. The actions behind the review queue.
 *
 * ADMIN only, same gate as every other `/admin` surface, and every export is an
 * `export async function` — see `npm run check:actions`.
 *
 * ── WHAT IS DELIBERATELY NOT HERE ───────────────────────────────────────────
 *
 * No "un-review" and no "delete flag". `lib/fraud/review.ts` argues both: a
 * verdict that can be rewritten is not a review trail, and a rule that stops
 * firing must leave its flag behind because `last_seen_at` going stale is the
 * signal the cause went away.
 */
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { errorParam } from '@/lib/errors/domain';
import { FRAUD_SEVERITIES, loadFraudConfig, type FraudSeverity } from '@/lib/fraud/rules';
import { runFraudScan } from '@/lib/fraud/scan';
import { loadControlConfig } from '@/lib/fraud/controls';
import { runControlEvaluation } from '@/lib/fraud/evaluate';
import {
  flagSummary,
  isVerdict,
  listFlags,
  raiseManualFlag,
  recordVerdict,
} from '@/lib/fraud/review';
import { listRuns, runFindings } from '@/lib/fraud/runs';
import { isModuleEnabled } from '@/lib/modules/service';
import { asAdmin, asAdminPage } from '@/lib/auth/admin-guard';
import { auditActorOf } from '@/lib/audit/service';
import { ORG } from '@/lib/tenant/sql';

const PAGE = '/admin/compliance';


function isRedirect(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'digest' in err &&
    typeof (err as { digest: unknown }).digest === 'string' &&
    (err as { digest: string }).digest.startsWith('NEXT_REDIRECT')
  );
}

async function guarded(fn: () => Promise<void>) {
  try {
    await fn();
  } catch (err) {
    if (isRedirect(err)) throw err;
    redirect(`${PAGE}?error=${encodeURIComponent(errorParam(err, 'admin/compliance'))}`);
  }
  revalidatePath(PAGE);
  redirect(PAGE);
}

function required(form: FormData, key: string): string {
  const value = form.get(key);
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${key} is required`);
  return value.trim();
}

/**
 * NOT an exported interface, and `npm run check:actions` is why.
 *
 * It was one, and the gate refused the build: "every export of a 'use server'
 * module must be `export async function`, and this is not". That is VX2-10's
 * finding, which the gate exists for — Next registers each export as a server
 * action, cannot wrap a type, and rather than failing it registers NONE of the
 * module's actions. Every form on this page would have posted an id the server
 * had never heard of, and the only symptom would have been "Failed to find Server
 * Action" in a browser.
 *
 * The page infers the shape from the function instead, which is what it wanted
 * anyway.
 */
export async function getCompliancePage(runId?: string) {
  return asAdminPage(async (tx) => {
    // ASKED UNGATED, and that is the AC-22 pattern rather than an oversight: a
    // gated read would make "this module is off" indistinguishable from "nothing
    // has been found", and the screen's job is to say which.
    const moduleEnabled = await isModuleEnabled(tx, 'compliance');
    if (!moduleEnabled) {
      return {
        moduleEnabled,
        flags: [],
        summary: { active: 0, reviewed: 0, critical: 0 },
        runs: [],
        findings: [],
        selectedRunId: null,
        fraudConfig: await loadFraudConfig(tx),
        controlConfig: await loadControlConfig(tx),
      };
    }
    const runs = await listRuns(tx);
    const selected = runId ?? runs[0]?.id ?? null;
    return {
      moduleEnabled,
      flags: await listFlags(tx),
      summary: await flagSummary(tx),
      runs,
      findings: selected === null ? [] : await runFindings(tx, selected),
      selectedRunId: selected,
      fraudConfig: await loadFraudConfig(tx),
      controlConfig: await loadControlConfig(tx),
    };
  });
}

/** Resolve, dismiss or escalate one flag. */
export async function reviewFlagFromForm(form: FormData) {
  await guarded(async () => {
    const flagId = required(form, 'flagId');
    const verdict = required(form, 'verdict');
    if (!isVerdict(verdict)) throw new Error('unknown verdict');
    // The note is OPTIONAL here and required for a dismissal in the service —
    // MT-3: the rule belongs beside the write, not in whichever form posts to it.
    const note = (form.get('note') as string | null) ?? null;
    await asAdmin((tx, actor) =>
      recordVerdict(tx, auditActorOf(actor), { flagId, verdict, note }),
    );
  });
}

export async function raiseFlagFromForm(form: FormData) {
  await guarded(async () => {
    const note = required(form, 'note');
    const severity = required(form, 'severity');
    if (!(FRAUD_SEVERITIES as readonly string[]).includes(severity)) {
      throw new Error('unknown severity');
    }
    const reportId = (form.get('reportId') as string | null)?.trim() || null;
    await asAdmin((tx, actor) =>
      raiseManualFlag(tx, auditActorOf(actor), {
        note,
        severity: severity as FraudSeverity,
        reportId,
      }),
    );
  });
}

/**
 * Run the detectors now, for THIS tenant.
 *
 * The scheduled route (`/api/internal/compliance/scan`) sweeps every entitled
 * tenant; this is one tenant on demand, and it goes through the same
 * `runFraudScan` rather than a screen-only path — VX1-9's MemoryStorage lesson.
 */
export async function scanNowFromForm() {
  await guarded(async () => {
    await asAdmin(async (tx) => {
      const cfg = await loadFraudConfig(tx);
      await runFraudScan(tx, cfg);
    });
  });
}

/**
 * Evaluate the controls now, for THIS tenant.
 *
 * NOT inside `asAdmin`'s transaction, because `runControlEvaluation` opens its
 * own — it writes a RUNNING row first so a crashed run still exists, which one
 * transaction cannot do. So the admin check runs first and hands over the org id,
 * the same shape `sendNowFromForm` uses for `postOne`.
 */
export async function evaluateNowFromForm() {
  await guarded(async () => {
    const { orgId, name } = await asAdmin(async (tx, actor) => {
      const r = await tx.query(
        `SELECT ${ORG} AS id`,
      );
      return { orgId: r.rows[0].id as string, name: actor.display_name ?? actor.email };
    });
    await runControlEvaluation(orgId, { requestedByName: name });
  });
}

/** Both threshold forms, saved as a partial override per tenant. */
export async function saveThresholdsFromForm(form: FormData) {
  await guarded(async () => {
    const num = (key: string): number | undefined => {
      const raw = form.get(key);
      if (typeof raw !== 'string' || raw.trim() === '') return undefined;
      const n = Number(raw);
      // REFUSED, not silently dropped. A threshold form that ignores a typo
      // leaves the person believing they changed something.
      if (!Number.isFinite(n) || n <= 0) throw new Error(`${key} must be a positive number`);
      return n;
    };
    const fraud = {
      lookbackDays: num('lookbackDays'),
      duplicate: { windowDays: num('windowDays') },
      amountOutlier: { sigma: num('sigma'), minAmountMinor: num('minAmountMinor') },
      violationDensity: { ratio: num('ratio') },
      approverConcentration: { minApprovals: num('minApprovals') },
    };
    const control = {
      staleDraftDays: num('staleDraftDays'),
      submittedNoActionDays: num('submittedNoActionDays'),
    };
    await asAdmin(async (tx) => {
      // Stored as given; `resolveFraudConfig` / `resolveControlConfig` are what
      // decide what an absent or nonsensical value means, on every read. Writing
      // a fully-resolved blob would freeze today's defaults into every tenant
      // that ever opened this form.
      await tx.query(
        `UPDATE organization SET fraud_config = $1, control_config = $2
          WHERE id = ${ORG}`,
        [JSON.stringify(prune(fraud)), JSON.stringify(prune(control))],
      );
    });
  });
}

/** Drop undefined leaves so an untouched field stays absent rather than null. */
function prune(value: unknown): unknown {
  if (Array.isArray(value) || value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (v === undefined) continue;
    const cleaned = prune(v);
    if (cleaned !== undefined && !(typeof cleaned === 'object' && cleaned !== null && Object.keys(cleaned).length === 0)) {
      out[k] = cleaned;
    }
  }
  return out;
}
