/**
 * Policy-violation display helpers, shared by both subjects.
 *
 * Extracted from the expense workbench when travel requests gained violations. The
 * grouping and the placeholder resolution are the same problem on both sides — a rule
 * firing on three lines is one sentence, and a label carrying a money placeholder must
 * be filled in the READER's locale — so they live once, here, with no i18n and no React.
 *
 * What is NOT shared is the rendering, and that is not an oversight. The expense side
 * justifies a warning through the parent expense's "Explain this charge" field, so its
 * violation line is display-only; a travel request has no such field, so its warnings
 * carry their own justification affordance. Two genuinely different controls.
 */

import { formatMinor } from '@/lib/format';

/**
 * The structural shape both subjects' violation rows satisfy.
 *
 * Deliberately not either router's inferred type: this module is imported by the expense
 * workbench and the travel drawer, and coupling it to one of them would make the other's
 * rows "nearly" assignable in the way that produces a cast at every call site.
 */
export interface ViolationView {
  severity: string;
  /** The message KEY, not a sentence. Resolved against `policy.labels.*` at render. */
  message: string;
  data?: unknown;
}

/**
 * One entry per KIND of violation, not one per violation.
 *
 * Three line items over the same per-transaction limit produced three identical
 * sentences, which reads as three problems instead of one. Grouped on
 * (severity, message) — `message` is the label key, so it is exactly what the reader
 * sees, and collapsing on it means no two rendered lines can ever be duplicates.
 *
 * NOT grouped on `ruleCode`: that holds the firing rule INSTANCE's id, so two limits of
 * the same kind (one for meals, one for travel) would stay separate and still render the
 * same sentence twice — the very thing being fixed.
 *
 * The count is kept and shown, because "over the limit" three times is a different
 * situation from once and silently dropping the other two would hide that.
 */
export function groupViolations<V extends ViolationView>(
  violations: readonly V[],
): { key: string; violation: V; count: number }[] {
  const groups = new Map<string, { violation: V; count: number }>();
  const order: string[] = [];
  for (const v of violations) {
    const key = `${v.severity}|${v.message}`;
    const hit = groups.get(key);
    if (hit) hit.count += 1;
    else {
      groups.set(key, { violation: v, count: 1 });
      order.push(key);
    }
  }
  return order.map((key) => {
    const g = groups.get(key) as { violation: V; count: number };
    return { key, ...g };
  });
}

/**
 * Values for the placeholders a policy label carries.
 *
 * The engine stores the message KEY plus a structured `data` payload; the sentence is
 * assembled at render, in the READER's locale. That split is deliberate rather than
 * incidental: a violation is read by the submitter AND by approvers, who need not share
 * a language, so a message pre-localized when the rule fired would be wrong for half its
 * audience. Money formatting is locale-dependent too, which is the same argument again.
 *
 * Anything absent yields no value, and next-intl renders the placeholder — visibly
 * wrong, which is the right failure for a missing payload.
 */
export function violationValues(
  violation: ViolationView,
  locale: string,
): Record<string, string> | undefined {
  const data = violation.data as
    | {
        thresholdMinor?: unknown;
        policyCurrency?: unknown;
        cabin?: unknown;
        overrunPercent?: unknown;
        tolerancePercent?: unknown;
        categoryCount?: unknown;
      }
    | null
    | undefined;
  if (!data) return undefined;
  const out: Record<string, string> = {};

  const code = typeof data.policyCurrency === 'string' ? data.policyCurrency : null;
  const raw = data.thresholdMinor;
  if (code && (typeof raw === 'string' || typeof raw === 'number')) {
    out.threshold = formatMinor(BigInt(raw), { code }, locale);
  }

  /**
   * The travel kinds' placeholders, and both are deliberately NOT money.
   *
   * `TRAVEL_OVERRUN` reports a COUNT of offending categories and the worst percentage.
   * The per-category minor figures stay in `data.categories` — each with the policy
   * currency alongside them — for a drawer that wants to expand the detail.
   */
  if (typeof data.overrunPercent === 'number') out.overrunPercent = String(data.overrunPercent);
  // How many categories overran. The sentence is plural-aware on it, so a missing value
  // renders the placeholder rather than silently reading as one.
  if (typeof data.categoryCount === 'number') out.categoryCount = String(data.categoryCount);
  if (typeof data.tolerancePercent === 'number') {
    out.tolerancePercent = String(data.tolerancePercent);
  }
  /** The RAW cabin token ('BUSINESS'). The caller localizes it — a nested catalog lookup
   *  is not something an interpolation value can do for itself. */
  if (typeof data.cabin === 'string') out.cabin = data.cabin;

  return Object.keys(out).length > 0 ? out : undefined;
}
