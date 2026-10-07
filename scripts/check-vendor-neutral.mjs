#!/usr/bin/env node
/**
 * VX3-7 — the vendor-neutrality guard.
 *
 * The Plan's Phase-3 wording: "define the accounting-adapter contract once so
 * QuickBooks/Xero/Sage are repeatable; avoid per-vendor special cases leaking
 * into core." VX3-3 built the contract and VX3-8's diff is the acceptance test —
 * adding QuickBooks must touch no file in core. But that test runs ONCE, on the
 * day somebody writes the second adapter. This guard runs on every build, which
 * is the difference between a property and an intention.
 *
 * ── What "leaking into core" actually looked like, so this is not abstract ───
 *
 * GAP-AUDIT AC-13 enumerates it in ExpenseOS. Their `netsuite-gl` module gate
 * exists and is bypassed in four places: `Budget.glAccountId` is a REQUIRED FK to
 * a NetSuite-shaped table on an ungated page; the GL-account pickers are a plain
 * `protectedProcedure` returning empty lists for a tenant with no NetSuite; three
 * generic admin screens render a GL field regardless; and `ExpenseAllocation.
 * classId` — a NetSuite concept — is the product's only class taxonomy, while
 * BusinessUnit and Department are native tables. None of that was a decision. It
 * is what happens when the only integration is also the model.
 *
 * ── WHAT IS POLICED, and why each surface ───────────────────────────────────
 *
 *   1. MIGRATIONS (DDL). A vendor name in a table name, a column name, a type or
 *      a CHECK literal is the hardest kind to undo — it needs a migration, and by
 *      then rows depend on it. A CHECK listing the known vendors is the specific
 *      mistake VX3-3 declined (AC-2/AC-3: the slug is validated against the code
 *      registry, so there is no reflection table to drift). This guard is what
 *      keeps that decision from being quietly reversed.
 *
 *   2. CORE MODULES (`lib/`, `app/`) minus the adapters. `lib/integrations/
 *      <vendor>.ts` is where a vendor name BELONGS. Anywhere else — a shared
 *      enum, a status, a config key, a screen — is a special case.
 *
 *   3. AUDIT ACTIONS and PERMISSION SLUGS specifically. They are strings, so
 *      rule 2 already covers them; they are called out because they are the two
 *      that look harmless. An audit action is written into rows that must be
 *      readable in five years, and a permission slug ends up in a customer's
 *      SSO configuration. Both are effectively permanent once shipped.
 *
 * ── WHAT IS NOT POLICED, deliberately ───────────────────────────────────────
 *
 *   · COMMENTS. Half the value of GAP-AUDIT is naming what ExpenseOS did with
 *     NetSuite and what VeloLedger does differently; a guard that forbade saying
 *     "NetSuite" in a comment would delete the reasoning along with the risk. So
 *     comments are stripped before scanning — `//`, block comments, and SQL `--`.
 *
 *   · ROW DATA. `integration_slug = 'veloledger'` in a seed or an INSERT is a
 *     vendor name as a VALUE, which is the whole point of a registry. Only DDL
 *     is scanned in migrations.
 *
 *   · The adapter modules and the registry's adapter list. Named explicitly in
 *     ALLOWED below rather than pattern-matched, so adding a file to the
 *     exemption is a visible diff somebody has to justify.
 *
 * Exits 1 and names every offender with its file, line and the reason.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT = process.cwd();

/**
 * The vendors. Present ones and the ones on the roadmap, because the point is to
 * catch the leak on the day it is written, and `qbo` is the abbreviation somebody
 * will reach for at 5pm.
 */
const VENDORS = [
  // Accounting — VX3-7's original list.
  'veloledger',
  'quickbooks',
  'qbo',
  'xero',
  'sage',
  'netsuite',
  'intacct',
  'freshbooks',
  // BILLING PROVIDERS — added by VX5-8, and the reason is the same rule rather
  // than a new one. John decided on 6 Sep that subscriptions go to a provider
  // rather than in-house. That decides who runs the money; it is not a licence to
  // model `subscription` around one company, and AC-13 is the record of what
  // happens otherwise — in ExpenseOS the only integration became the model, so a
  // budget carries a required FK to a NetSuite-shaped table on a page that has
  // nothing to do with NetSuite.
  //
  // Until this PR the guard policed ledgers only, so `stripe` in a column name or
  // an audit action would have sailed through the check whose entire purpose is to
  // stop exactly that. The list is what makes the rule real, so it has to name the
  // vendors the product is actually about to acquire.
  'stripe',
  'paddle',
  'chargebee',
  'recurly',
  'braintree',
  'lemonsqueezy',
];

/**
 * Matching is TOKEN-BASED, and it took three attempts to get right. The two
 * failures are worth recording, because both are the kind that make a guard
 * useless in opposite directions:
 *
 *   1. SUBSTRING matching reported 180 offenders, every one of them the word
 *      "message" containing "sage" (`usage` and `passage` too). A guard that
 *      cries wolf gets `|| true` appended to it within a week.
 *
 *   2. `\b<vendor>\b` fixed that and then MISSED `QUICKBOOKS_SPECIAL_CASE`,
 *      because `_` is a word character so there is no boundary after
 *      `QUICKBOOKS`. It would also have missed `quickBooksClient`. Those are
 *      precisely the shapes a leak takes — a constant, a config key, an audit
 *      action, a permission slug — so the guard was blind to the surfaces it
 *      exists to police while looking like it worked.
 *
 * So: split text into tokens on non-letters, split each token at camelCase
 * transitions, and ask whether any CONTIGUOUS RUN of the resulting components
 * spells a vendor name.
 *
 * A THIRD defect, in this file rather than in its logic, and worth the note
 * because nothing about it was visible: the separator below reached PR #61 as
 * three NUL bytes instead of three spaces. The code worked — it split on the same
 * byte it inserted — but `git diff` classified the file as BINARY, so every future
 * diff of the project's newest guard would have shown "Bin 11726 -> 11779 bytes"
 * and nothing else. Found by reading a diffstat, not by any test, because there is
 * no test that could see it. `quickBooksClient` → quick|Books|Client, and the run
 * [0..1] is "quickbooks". `usage` is one component, "usage", which is not
 * "sage". `QUICKBOOKS_SPECIAL_CASE` → quickbooks|special|case.
 */
const VENDOR_SET = new Set(VENDORS);
const LONGEST_VENDOR_WORDS = 2; // 'quickbooks' can arrive as quick|Books

function componentsOf(text) {
  const out = [];
  for (const token of text.split(/[^A-Za-z]+/)) {
    if (!token) continue;
    // Split at a lower→upper transition, and at the tail of an acronym run
    // (`QBOClient` → QBO|Client), so both casing conventions decompose.
    const parts = token
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
      .split(' ');
    out.push(parts.map((p) => p.toLowerCase()));
  }
  return out;
}

/** Every vendor name spelled by a contiguous run of components in `text`. */
function vendorsIn(text) {
  const found = new Set();
  for (const parts of componentsOf(text)) {
    for (let i = 0; i < parts.length; i++) {
      let joined = '';
      for (let n = 0; n < LONGEST_VENDOR_WORDS && i + n < parts.length; n++) {
        joined += parts[i + n];
        if (VENDOR_SET.has(joined)) found.add(joined);
      }
    }
  }
  return found;
}

/**
 * Files where a vendor name is CORRECT. Explicit paths, not globs: an adapter is
 * a small, countable set, and a glob like `lib/integrations/*` would silently
 * exempt the contract and the registry too — the two files whose neutrality is
 * the entire premise of VX3-3.
 */
const ALLOWED = new Set([
  'lib/integrations/veloledger.ts', // the adapter itself
  'lib/integrations/quickbooks.ts', // ditto (VX3-8)
  'lib/integrations/stub.ts', // the test double
  'lib/integrations/registry.ts', // imports the adapters; that is its job
  'scripts/check-vendor-neutral.mjs', // this file names them all
]);

/** Never walked. */
const SKIP_DIRS = new Set(['node_modules', '.next', '.git', 'test-results', 'playwright-report']);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

/**
 * Strip comments so the scan sees CODE. Not a parser, and it does not need to be:
 * a false NEGATIVE here (a vendor name inside a string that looks like a comment)
 * is caught by the migration scan or by review, while a false POSITIVE would make
 * the guard something people disable.
 */
function stripComments(text, sql) {
  let out = text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  const lineComment = sql ? /--.*$/gm : /\/\/.*$/gm;
  out = out.replace(lineComment, (m) => ' '.repeat(m.length));
  return out;
}

/**
 * In a migration, scan DDL only. A vendor name in an INSERT is row data — a slug
 * — and that is the registry working as designed.
 *
 * Statement-aware rather than line-aware, because a multi-line INSERT's VALUES
 * rows do not look like anything on their own: splitting on `;` and dropping
 * whole INSERT statements is what makes a seeded slug legal and a CHECK
 * constraint listing the same string illegal.
 */
function ddlOnly(sqlNoComments) {
  return sqlNoComments
    .split(';')
    .map((stmt) =>
      // INSERT/UPDATE/COPY carry row DATA — a slug is supposed to be a value.
      // COMMENT ON carries DOCUMENTATION: `COMMENT ON TABLE gl_account IS
      // '…number-for-number with VeloLedger…'` is provenance, and provenance is
      // the thing this project is most careful to keep. Blanked rather than
      // dropped so `;` positions — and therefore line numbers — survive.
      /^\s*(INSERT|UPDATE|COPY|COMMENT\s+ON)\b/i.test(stmt) ? stmt.replace(/[^\n]/g, ' ') : stmt,
    )
    .join(';');
}

const offenders = [];

/**
 * Report a hit.
 *
 * The line is found in the SCANNED text — comments blanked, row data blanked —
 * and the text shown comes from the ORIGINAL at the same index. That pairing is
 * the fix for the second bug in this script's first version: it detected on the
 * stripped text but re-scanned the original to find line numbers, so one genuine
 * hit in a file reported every comment in it too. Both stripping passes replace
 * with spaces and keep newlines, so the two texts stay line-aligned.
 */
function record(file, original, scanned, vendor, reason) {
  const scannedLines = scanned.split('\n');
  const originalLines = original.split('\n');
  for (let i = 0; i < scannedLines.length; i++) {
    if (vendorsIn(scannedLines[i]).has(vendor)) {
      offenders.push({
        file,
        line: i + 1,
        vendor,
        reason,
        text: (originalLines[i] ?? scannedLines[i]).trim().slice(0, 120),
      });
    }
  }
}

for (const full of walk(ROOT)) {
  const rel = relative(ROOT, full).split(sep).join('/');
  if (ALLOWED.has(rel)) continue;

  const isMigration = rel.startsWith('prisma/migrations/') && rel.endsWith('.sql');
  // Wave 0: code ported from ExpenseOS keeps ExpenseOS's layout, so it also lives in
  // server/, packages/, components/ and i18n/. Without these the guard would wave a vendor
  // name through simply because it arrived in a ported file.
  const isCore =
    /^(lib|app|server|packages|components|i18n)\//.test(rel) &&
    (rel.endsWith('.ts') || rel.endsWith('.tsx'));
  if (!isMigration && !isCore) continue;

  const original = readFileSync(full, 'utf8');
  let scanned = stripComments(original, isMigration);
  if (isMigration) scanned = ddlOnly(scanned);

  for (const vendor of vendorsIn(scanned)) {
    record(
      rel,
      original,
      scanned,
      vendor,
      isMigration
        ? 'a vendor name in schema DDL — a table, column, type or CHECK literal'
        : 'a vendor name in a core module (only lib/integrations/<vendor>.ts may name one)',
    );
  }
}

if (offenders.length > 0) {
  console.error('');
  console.error(
    'check-vendor-neutral FAILED — a vendor name reached a surface that must stay neutral.',
  );
  console.error('');
  for (const o of offenders) {
    console.error(`  ${o.file}:${o.line}  "${o.vendor}"`);
    console.error(`      ${o.reason}`);
    console.error(`      ${o.text}`);
  }
  console.error('');
  console.error('  Core resolves an integration by CAPABILITY, never by name:');
  console.error("      resolveCapability(tx, 'POST_EXPENSE_REPORT')");
  console.error('  Vendor-specific behaviour belongs in lib/integrations/<vendor>.ts, and');
  console.error('  vendor-specific DATA belongs in a row (integration_slug), not in DDL.');
  console.error('  If a new adapter file is genuinely the right home, add it to ALLOWED in');
  console.error('  scripts/check-vendor-neutral.mjs — as a visible diff, on purpose.');
  console.error('');
  process.exit(1);
}

console.log(
  `check-vendor-neutral OK — no vendor name in schema DDL, core modules, audit actions or ` +
    `permission slugs (${VENDORS.length} vendors checked, ${ALLOWED.size} files exempt).`,
);
