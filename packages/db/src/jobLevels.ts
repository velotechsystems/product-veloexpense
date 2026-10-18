/**
 * Employee title → job-level code.
 *
 * w5-04 — ported from ExpenseOS `packages/db/src/jobLevels.ts` (1e682dd6) verbatim, for the
 * directory sync. VeloExpense: a tenant's job levels are its own (0050: `code` is unique per
 * tenant), so a code this returns sets a level only where the tenant has a level with that
 * code; otherwise nothing changes and the title is reported (`syncAllFromDirectory`).
 *
 * Job level is not cosmetic: the approval engine's `managerChain` nodes select
 * an approver by walking up the requester's chain until someone sits at or
 * above the tier's `minJobLevelId` (Director / VP / C-level). An employee with
 * no level is invisible to that walk, so the ladder has to be populated for
 * tiered approvals to route to the right person.
 *
 * Titles come from Google Workspace (`organizations[].title`), which is
 * free-text — 700+ people, no controlled vocabulary, inconsistent
 * abbreviations ("Sr.", "SR", "Senior"). This maps them with an ordered rule
 * list: the FIRST matching rule wins, so the list runs most-senior-first and
 * most-specific-first.
 *
 * ── The "Manager" trap ──────────────────────────────────────────────────
 * `\bmanager\b` is the single biggest source of wrong answers here. In sales
 * and marketing, "Manager" is an individual-contributor title — an Account
 * Manager manages accounts, not people; a Territory Sales Manager manages a
 * territory. Levelling them as people-managers would insert them into the
 * approval ladder. IC_MANAGER_TITLES is checked BEFORE the people-manager
 * rules for exactly this reason.
 *
 * Anything this returns null for is reported by the seed rather than silently
 * left blank — an unmapped title is a data question for a human, not a
 * default. Never guess a level: over-levelling grants approval authority.
 */

/** The ladder, for reference (sortOrder in parentheses):
 *    IC1–IC9  (1–9)    individual contributor
 *    M1–M6    (11–16)  manager → senior director
 *    E1–E4    (17–20)  executive → C-level
 *    Board    (21)
 */
export type JobLevelCode =
  | `IC${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9}`
  | `M${1 | 2 | 3 | 4 | 5 | 6}`
  | `E${1 | 2 | 3 | 4}`
  | 'Board';

/**
 * Titles containing "Manager"/"Lead" that are individual contributors, not
 * people managers. Matched on the normalized title as a whole-word phrase.
 * Add to this list rather than weakening the people-manager rules.
 */
const IC_MANAGER_TITLES: { pattern: RegExp; level: JobLevelCode }[] = [
  // Sales ICs — "manager" of a book of business, not of people.
  { pattern: /\b(senior|sr\.?|principal)\s+account\s+manager\b/, level: 'IC5' },
  { pattern: /\baccount\s+(manager|performance\s+manager|executive)\b/, level: 'IC4' },
  { pattern: /\b(territory|area|regional|district)\s+sales\s+manager\b/, level: 'IC5' },
  { pattern: /\bcustomer\s+success\s+manager\b/, level: 'IC4' },
  // Marketing / delivery ICs.
  { pattern: /\b(marketing\s+)?campaign\s+manager\b/, level: 'IC4' },
  {
    pattern: /\b(product|project|program|community|social\s+media)\s+(manager|owner)\b/,
    level: 'IC5',
  },
];

/**
 * Ordered seniority rules, most senior first. First match wins.
 */
const RULES: { pattern: RegExp; level: JobLevelCode }[] = [
  // ── Board + C-suite ───────────────────────────────────────────────
  { pattern: /\bboard\s+(member|director)\b|\bchairman\b/, level: 'Board' },
  {
    // The lookbehind matters: without it `\bpresident\b` also fires on "Vice
    // President", promoting every VP and SVP straight to C-level.
    pattern: /\bchief\b|\b(ceo|cfo|coo|cto|cio|cmo|cro|cpo|clo|chro)\b|(?<!vice[\s-])\bpresident\b/,
    level: 'E4',
  },
  // ── Executive ─────────────────────────────────────────────────────
  { pattern: /\b(executive|senior|sr\.?)\s+vice[-\s]?president\b|\b(evp|svp)\b/, level: 'E3' },
  { pattern: /\bvice[-\s]?president\b|\bvp\b/, level: 'E2' },
  { pattern: /\bgeneral\s+manager\b|\bhead\s+of\b/, level: 'E1' },
  // ── Manager track ─────────────────────────────────────────────────
  { pattern: /\b(senior|sr\.?|executive)\s+director\b/, level: 'M6' },
  { pattern: /\b(associate\s+)?director\b/, level: 'M5' },
  // Controller is the finance org's director-equivalent, and the title never
  // carries "Director".
  { pattern: /\bcontroller\b/, level: 'M5' },
  { pattern: /\b(senior|sr\.?)\s+manager\b/, level: 'M4' },
  { pattern: /\bmanager\b/, level: 'M3' },
  { pattern: /\b(supervisor|team\s+lead(er)?|foreman)\b/, level: 'M2' },
  // ── Individual contributor ────────────────────────────────────────
  { pattern: /\b(distinguished|fellow)\b/, level: 'IC9' },
  { pattern: /\bprincipal\b/, level: 'IC8' },
  { pattern: /\bstaff\b/, level: 'IC7' },
  { pattern: /\blead\b/, level: 'IC6' },
  { pattern: /\b(senior|sr\.?)\b/, level: 'IC5' },
  { pattern: /\b(intermediate|ii|2)\b/, level: 'IC3' },
  { pattern: /\b(junior|jr\.?|associate|intern|trainee|apprentice|i|1)\b/, level: 'IC1' },
  // Licensed / credentialed professionals that outrank the general IC4 band.
  { pattern: /\b(counsel|attorney|lawyer)\b/, level: 'IC6' },
  // Untitled-seniority professional roles — the broad middle of the org.
  {
    pattern:
      /\b(developer|engineer|analyst|designer|accountant|strategist|specialist|architect|administrator|consultant|partner|representative|scientist|technologist|translator|writer|owner)\b/,
    level: 'IC4',
  },
  { pattern: /\bparalegal\b/, level: 'IC3' },
  // Frontline / operational roles.
  {
    pattern:
      /\b(coordinator|clerk|inspector|driver|mechanic|attendant|technician|detailer|receptionist|assistant|agent|porter|washer|loader|guard|dispatcher|ringperson|maintenance|admin|administration|registration)\b/,
    level: 'IC2',
  },
];

/** Lowercase, collapse whitespace, strip punctuation that splits words. */
function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[.,/&()]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Resolve a free-text employee title to a job-level code, or null when no rule
 * matches. Null means "a human needs to look at this" — callers should report
 * it, never substitute a default.
 */
export function titleToJobLevelCode(title: string | null | undefined): JobLevelCode | null {
  if (!title) return null;
  // Normalization strips the "." from "Sr." and "Jr.", so the rules match both
  // "Sr. Manager" and "SR Manager"; `sr\.?` covers the pre-normalized form too.
  const t = normalizeTitle(title);
  if (!t) return null;
  for (const { pattern, level } of IC_MANAGER_TITLES) {
    if (pattern.test(t)) return level;
  }
  for (const { pattern, level } of RULES) {
    if (pattern.test(t)) return level;
  }
  return null;
}
