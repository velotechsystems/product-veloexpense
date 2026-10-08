#!/usr/bin/env node
/**
 * VX4-7 — the locale gate. Runs in CI beside `check:actions` and `check:vendor`.
 *
 * ── WHAT THIS EXISTS TO CATCH, AND WHOSE MISTAKE IT IS ──────────────────────
 *
 * ExpenseOS ships two good i18n gates and both are undermined the same way.
 * `packages/i18n/scripts/check-coverage.mjs` opens with:
 *
 *     const SUPPORTED_LOCALES = ['en', 'fr-CA'];
 *     const DEFAULT_LOCALE = 'en';
 *
 * — a second copy, inside the gate, of the list the gate exists to police. Their
 * `check-used-keys.mjs` restates `DEFAULT_LOCALE` too. So adding a third locale
 * there does not merely leave it unchecked; it leaves it unchecked SILENTLY,
 * because every loop in both gates iterates the stale pair and passes. That is a
 * gate that fails OPEN, which is the only kind that is worse than no gate: it
 * reports success about a question it never asked.
 *
 * IL-7 is the same disease in the product rather than the tooling — the two-key
 * shape pinned in six Zod schemas and eleven form pairs across ~17 files, so
 * their third locale is "a schema-and-form change plus a data backfill".
 *
 * So this script has no locale list. It IMPORTS `SUPPORTED_LOCALES` from
 * `lib/i18n/locales.ts` and then hunts for anywhere else that has one.
 *
 * ── WHY A TEXT SCAN AND NOT A TYPE ──────────────────────────────────────────
 *
 * `Locale` already makes a wrong tag a compile error wherever a value flows into
 * a typed parameter. What the type cannot see is a tag that never becomes a
 * `Locale`: a `<select>` with three hardcoded `<option value="fr-CA">`, a
 * `lang="en"` attribute, a SQL string in a script, an `Intl.NumberFormat('en')`
 * call. Every one of those is a locale decision made outside the registry, and
 * every one type-checks. `test/module-gates.test.ts` makes the same choice for
 * the same reason and its header says so: some guarantees are about the TEXT.
 *
 * Exit codes:
 *   0 — no locale literal outside the registry.
 *   1 — at least one found.
 *   2 — the script could not do its job (registry unreadable, no files seen).
 *       Never silently 0: a gate that passes because it found nothing to look
 *       at is the failure mode this whole file is about.
 */

import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');

/** The registry, and the ONLY file allowed to hold the list. */
const REGISTRY = join(repoRoot, 'lib', 'i18n', 'locales.ts');

/**
 * Read `SUPPORTED_LOCALES` out of the registry's source.
 *
 * Parsed from the text rather than imported, because this is a `.mjs` script and
 * the registry is TypeScript — and because reading the source is what makes the
 * failure mode loud. An `import` that resolved to a stale build artifact would
 * give the gate a plausible-looking list that is not the one in the repo, which
 * is precisely the class of bug the gate is for.
 */
async function readRegistry() {
  const src = await readFile(REGISTRY, 'utf8');
  const array = /export const SUPPORTED_LOCALES = \[([^\]]+)\] as const;/.exec(src);
  const dflt = /export const DEFAULT_LOCALE: Locale = '([^']+)';/.exec(src);
  if (!array || !dflt) {
    throw new Error(
      `could not read SUPPORTED_LOCALES / DEFAULT_LOCALE out of ${relative(repoRoot, REGISTRY)} — ` +
        `if the declaration was reformatted, update this regex; do not delete the check`,
    );
  }
  const locales = [...array[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  if (locales.length === 0) throw new Error('SUPPORTED_LOCALES parsed as empty');
  return { locales, defaultLocale: dflt[1] };
}

/**
 * Where a stray locale literal is a defect.
 *
 * `test/` and `e2e/` are EXCLUDED, deliberately: a test asserting `en-US`
 * behaviour must name `en-US`, and a test that had to ask the registry what to
 * expect would be asserting the registry against itself. `prisma/migrations/` is
 * excluded too — `0027`'s CHECK constraint genuinely contains the three tags,
 * SQL cannot import them, and that copy has its own guard
 * (`test/i18n-schema.db.test.ts` asserts the constraint's accepted set equals
 * `SUPPORTED_LOCALES` in both directions).
 */
const SCAN_ROOTS = ['lib', 'app', 'scripts'];

const RAW_MESSAGE_RE = /instanceof Error\s*\?\s*\w+\.message/;
const ERROR_QUERY_RE = /[?&]error=\$\{([^}]*)\}/g;

/**
 * VX4-7 part 2c — nothing an exception carries may reach a person.
 *
 * TWO checks, with different scopes, because the first draft of this had one and
 * it was wrong in both directions.
 *
 * ── CHECK A: the raw-message SPELLING, in `app/` only ──────────────────────
 *
 * `err instanceof Error ? err.message : 'Something went wrong'` was the pattern
 * at eleven call sites, and it printed whatever ANY exception carried — a
 * `TypeError` from a bug, a `pg` error carrying part of the statement, an
 * adapter's HTTP body — plus our own diagnostics, which interpolate record ids.
 * `errorParam()` in `lib/errors/domain.ts` is the replacement.
 *
 * Scoped to `app/` on purpose, and NOT widened to `lib/`. Part 2c-2 tried that
 * and it flagged fifteen sites, most of them correct: `lib/integrations/
 * dispatch.ts` builds exactly this string to store in a delivery's `last_error`,
 * and `quickbooks.ts` builds it for an adapter diagnostic. **The pattern is not
 * the defect — the destination is.** A gate that fails the build on correct code
 * teaches people to delete gates.
 *
 * What it still earns its place for is the case with no URL in it at all: 2c-1
 * found two `setError(err instanceof Error ? err.message : …)` calls in the
 * receipt drawer, the one client component, which no destination check can see.
 *
 * ── CHECK B: the DESTINATION, everywhere ───────────────────────────────────
 *
 * Every `?error=${…}` must interpolate `errorParam(...)`. This is the invariant
 * that actually matters and it does not care which directory the code is in —
 * which is the point, because part 2c-2 found the raw pattern in
 * `lib/notifications/approve.ts`, one module BELOW where check A was looking:
 * it returns `{ kind: 'REFUSED', reason }` and `app/approve/actions.ts` puts
 * that straight in the URL. Behind `decide()`, which throws whatever the engine,
 * the policy layer or `pg` throws, on a page opened from a link in an email.
 *
 * Found by reading the module rather than by the gate, which is how a gate is
 * not supposed to find things. Check B is the shape that would have caught it.
 */
function rawErrorMessage(text, filePath) {
  const rel = relative(repoRoot, filePath);
  const out = [];
  const lines = text.split('\n');

  // CHECK A — app/ only. See the header on why this is not `lib/` too.
  if (rel.startsWith('app/')) {
    lines.forEach((line, i) => {
      if (RAW_MESSAGE_RE.test(line)) {
        out.push({ file: rel, line: i + 1, text: line.trim(), why: 'raw exception message' });
      }
    });
  }

  // CHECK B — everywhere. `lib/errors/domain.ts` documents the old spelling in
  // its own comments, and is where the replacement lives.
  //
  // The interpolation usually reads `encodeURIComponent(message)`, where
  // `message` was assigned from `errorParam` a few lines up — so a literal
  // substring test rejects correct code. Any identifier the file assigns from
  // `errorParam(` counts as clean. That is a static approximation and it is the
  // honest kind: it can be fooled by reassigning such a variable, and it cannot
  // be fooled by the mistake this exists to catch, which is not routing through
  // `errorParam` at all.
  const cleaned = new Set(
    [...text.matchAll(/(?:const|let|var)\s+(\w+)\s*(?::[^=]+)?=\s*errorParam\(/g)].map((m) => m[1]),
  );
  // This file and `lib/errors/domain.ts` both QUOTE the patterns they police.
  if (rel !== 'lib/errors/domain.ts' && rel !== 'scripts/check-i18n.mjs') {
    lines.forEach((line, i) => {
      for (const m of line.matchAll(ERROR_QUERY_RE)) {
        const ids = [...m[1].matchAll(/[A-Za-z_$][\w$]*/g)].map((x) => x[0]);
        // Three sanctioned producers, all in `lib/errors/domain.ts`: `errorParam`
        // (from an exception), `errorCodeParam` (from a code the caller has) and
        // `encodeUserMessage` (from a `UserMessage` handed over as data).
        const sanctioned = /error(Param|CodeParam)\(|encodeUserMessage\(/.test(m[1]);
        if (!sanctioned && !ids.some((id) => cleaned.has(id))) {
          out.push({
            file: rel,
            line: i + 1,
            text: line.trim(),
            why: `error= built from \`${m[1].trim()}\` rather than errorParam()`,
          });
        }
      }
    });
  }
  return out;
}

const ERRORS_FILE = join(repoRoot, 'lib', 'i18n', 'catalog', 'errors.ts');

/**
 * VX4-7 part 2c-2 — a throw site's params must match what its sentence asks for.
 *
 * This is part 2b's requirement-3 check, in the only form available here.
 * `test/i18n-policy-messages.test.ts` can run the REAL rules and inspect the
 * `data` they emit, because a rule is a pure function of a snapshot. An error is
 * not: reaching a hundred throw sites means reaching a hundred database states,
 * so there is nothing to drive.
 *
 * What IS available is that both halves are literals in the source. Every
 * `{ code: 'X', params: { a, b } }` in `lib/` is read here and compared against
 * the placeholders in `X`'s sentence, in both directions:
 *
 *   a key the sentence needs and the site omits  → the reader gets the generic,
 *     which is the failure this catches. It happened while writing 2c-2: I added
 *     `{detail}` to COA_IMPORT_HAD_PROBLEMS and the throw site still passed only
 *     `problems`, so the sentence would have silently degraded for every bad CSV.
 *   a key the site passes and the sentence ignores → dead weight in a URL, and
 *     usually the sign of a placeholder that was renamed on one side.
 *
 * It cannot see a `params` object built dynamically, and nothing in the repo
 * does that — if something starts to, this needs the runtime check instead of a
 * quiet pass. Stated rather than assumed, because a gate that silently stops
 * covering things is IL-7 again.
 */
async function errorMessageParams() {
  const src = await readFile(ERRORS_FILE, 'utf8');
  // code -> the placeholders in its default-locale sentence
  const wants = new Map();
  for (const m of src.matchAll(/^  (?<code>[A-Z][A-Z0-9_]*): \{\n(?<body>(?:.*\n)*?)  \},$/gm)) {
    const entry = m.groups.body;
    const dflt = entry.match(/'en-CA':\s*((?:'(?:[^'\\]|\\.)*'|\s*\+\s*)+)/);
    if (!dflt) continue;
    wants.set(m.groups.code, new Set([...dflt[1].matchAll(/\{(\w+)\}/g)].map((p) => p[1])));
  }
  if (wants.size === 0) {
    throw new Error(
      `parsed no entries out of ${relative(repoRoot, ERRORS_FILE)} — if ERROR_COPY was ` +
        `reformatted, update this parser; do not delete the check`,
    );
  }

  const problems = [];
  for await (const file of sourceFiles(join(repoRoot, 'lib'))) {
    const rel = relative(repoRoot, file);
    if (rel === 'lib/i18n/catalog/errors.ts') continue;
    const text = await readFile(file, 'utf8');
    for (const m of text.matchAll(/code:\s*'([A-Z][A-Z0-9_]*)'\s*,\s*params:\s*\{/g)) {
      const code = m[1];
      const want = wants.get(code);
      if (want === undefined) continue; // an unknown code is a tsc error already
      // A BRACE SCAN, not a regex. These objects run to twenty lines, hold
      // comments, and interpolate `${…}` inside template literals — the nested
      // braces defeat any regex short of a parser, and the first version of this
      // check reported COA_IMPORT_HAD_PROBLEMS as missing a param it passes.
      // Twice in one gate: fail the build on correct code and people delete it.
      const open = text.indexOf('{', m.index + m[0].length - 1);
      let depth = 0;
      let close = -1;
      for (let i = open; i < text.length; i += 1) {
        if (text[i] === '{') depth += 1;
        else if (text[i] === '}') {
          depth -= 1;
          if (depth === 0) {
            close = i;
            break;
          }
        }
      }
      if (close < 0) continue;
      const body = text.slice(open + 1, close);
      // Keys are at depth 1 only, and comments are stripped first so a `key:`
      // inside prose is not read as one.
      const stripped = body.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
      const got = new Set();
      let d = 0;
      let atKey = true;
      let token = '';
      for (const ch of stripped) {
        if (ch === '{' || ch === '(' || ch === '[') d += 1;
        else if (ch === '}' || ch === ')' || ch === ']') d -= 1;
        if (d === 0 && atKey && /[\w$]/.test(ch)) {
          token += ch;
          continue;
        }
        if (d === 0 && (ch === ':' || ch === ',')) {
          if (token.trim() !== '') got.add(token.trim());
          token = '';
          atKey = ch === ',';
          continue;
        }
        if (d === 0 && /\s/.test(ch)) continue;
        // anything else at depth 0 means we are inside a value
        if (token.trim() !== '' && ch !== ':') {
          atKey = false;
          token = '';
        }
      }
      if (atKey && token.trim() !== '') got.add(token.trim());

      const line = text.slice(0, m.index).split('\n').length;
      for (const key of want) {
        if (!got.has(key)) problems.push({ file: rel, line, code, key, kind: 'missing' });
      }
      for (const key of got) {
        if (!want.has(key)) problems.push({ file: rel, line, code, key, kind: 'unused' });
      }
    }
  }
  return problems;
}

const POLICY_MESSAGES_FILE = join(repoRoot, 'lib', 'i18n', 'catalog', 'policy-messages.ts');
const POLICY_RULES_FILE = join(repoRoot, 'lib', 'policy', 'rules.ts');
const FRAUD_MESSAGES_FILE = join(repoRoot, 'lib', 'i18n', 'catalog', 'fraud-messages.ts');
const FRAUD_RULES_FILE = join(repoRoot, 'lib', 'fraud', 'rules.ts');
const CONTROL_MESSAGES_FILE = join(repoRoot, 'lib', 'i18n', 'catalog', 'control-messages.ts');
const CONTROL_RULES_FILE = join(repoRoot, 'lib', 'fraud', 'controls.ts');

/**
 * VX4-7 part 2b — the message codes in the catalogue and the codes the rules
 * actually emit must be the same set, in BOTH directions.
 *
 * A code in `rules.ts` and not in the catalogue renders as `{THE_CODE}` on a
 * report an employee is reading. A code in the catalogue and not in `rules.ts`
 * is dead copy: harmless today, and the thing somebody translates for a week
 * before discovering nothing shows it.
 *
 * Both directions matter and the second is the one a one-way check misses —
 * which is IL-7's finding restated. The TYPE cannot close this: `PolicyCopy`
 * proves every code HAS copy, and says nothing about whether any rule emits it.
 *
 * Parsed from source rather than imported, for the reason `readRegistry` gives:
 * an import resolving to a stale artifact hands the gate a plausible list that
 * is not the one in the repo.
 */
/**
 * PARAMETERISED IN VX4-8 PART 2, not copied.
 *
 * A second catalogue (`fraud-messages.ts`) needed exactly this scan against
 * exactly this call shape. A second copy of it would be two regexes to keep in
 * step — UD-9's hand-kept correspondence, in the one file whose whole job is
 * catching those. The call sites below are the only difference between the two.
 */
async function messageCodesFor({ label, catalogueFile, arrayName, rulesFile }) {
  const catalogueSrc = await readFile(catalogueFile, 'utf8');
  const array = new RegExp(`export const ${arrayName} = \\[([^\\]]+)\\] as const;`).exec(catalogueSrc);
  if (!array) {
    throw new Error(
      `could not read ${arrayName} out of ${relative(repoRoot, catalogueFile)} — ` +
        `if the declaration was reformatted, update this regex; do not delete the check`,
    );
  }
  const declared = [...array[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  if (declared.length === 0) throw new Error(`${arrayName} parsed as empty`);

  // Every code named as the second argument to `finding(...)`, which is the ONLY
  // way rules.ts builds a Finding — enforced by the object literal being gone
  // from that file, and by `test/i18n-policy-messages.test.ts` driving the real
  // rules and asserting all ten codes are reachable.
  const rulesSrc = await readFile(rulesFile, 'utf8');
  const emitted = new Set();
  // The first argument is the RULE code and may be a variable, not a literal —
  // `rateMissingFinding` forwards the caller's `ruleCode`, which is how
  // RATE_MISSING is shared between two rules. Requiring a literal there made
  // this scan miss it on its first run, and the gate reported it as orphan copy:
  // a true positive about the scan rather than about the code, which is the
  // failure mode worth naming in a gate that fails a build.
  for (const m of rulesSrc.matchAll(/finding\(\s*[^,()]+,\s*'([A-Z_]+)'/g)) emitted.add(m[1]);
  // The ternary form: finding(RULE, cond ? 'A' : 'B', …)
  for (const m of rulesSrc.matchAll(/\?\s*'([A-Z_]+)'\s*:\s*'([A-Z_]+)'/g)) {
    if (declared.includes(m[1])) emitted.add(m[1]);
    if (declared.includes(m[2])) emitted.add(m[2]);
  }
  if (emitted.size === 0) {
    throw new Error(
      `found no finding(RULE, CODE, …) calls in ${relative(repoRoot, rulesFile)} — ` +
        `if findings are built another way now, update this scan; do not delete the check`,
    );
  }
  return {
    label,
    rulesFile: relative(repoRoot, rulesFile),
    catalogueFile: relative(repoRoot, catalogueFile),
    orphanCopy: declared.filter((c) => !emitted.has(c)),
    missingCopy: [...emitted].filter((c) => !declared.includes(c)),
    declared,
  };
}

/** Files exempt from the whole scan. */
/*
 * ── A CATALOGUE NOBODY READS, AND THE DEFECT IT HID ────────────────────────
 *
 * VX4-10 part 4. `RULE_KIND_COPY` was declared in VX4-7 part 2a with complete
 * coverage of `RuleKind` and a passing coverage test — and had exactly two
 * references in the whole tree, both inside that test. Nothing in `lib/` or `app/`
 * ever asked it anything.
 *
 * Meanwhile `lib/policy/rules.ts` carried a `label` on each rule definition: a
 * second list of the same five names, which is what the screen and eight refusal
 * messages actually used. The two drifted on two of five members and no reader
 * ever saw the catalogue's wording, so the drift shipped invisibly.
 *
 * A COVERAGE TEST CANNOT CATCH THIS. It proves a catalogue covers its union; it
 * has no way to notice that the catalogue is dead, and a dead catalogue is exactly
 * where a duplicate hides. So this checks the other direction: every `*_COPY`
 * exported from `enums.ts` must be read from somewhere that is not a test.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: judge whether the call site is the RIGHT one.
 * A catalogue read once, in the wrong place, passes. That is a code-review
 * question. This gate answers the narrower one that was actually load-bearing —
 * is anybody asking? — because that is the question whose answer was "no" for
 * two releases.
 */
/*
 * ── A CONNECTING WORD SPELLED INTO A `join` ────────────────────────────────
 *
 * VX4-10 part 4. `app/admin/expense-policies/page.tsx` built a phrase with
 * `.join(' and ')`, which puts an English conjunction inside a sentence a
 * translator is otherwise free to write. `lib/i18n/list.ts` replaced it with
 * `Intl.ListFormat`.
 *
 * THIS GATE EXISTS BECAUSE THE SABOTAGE CAME BACK GREEN. Reverting that call to
 * `.join(' and ')` left the pseudo-locale crawl at 0 un-catalogued for the page,
 * and the reason is structural rather than a bug: `unbracketed()` drops any TEXT
 * NODE containing a marker, and the join happens inside a catalogued sentence's
 * parameter hole — so the rendered node is `⟦Only ⟦A⟧ and ⟦B⟧ can be …⟧`, one
 * node, marker present, filtered. **Any hardcoded word inside a catalogued
 * sentence is invisible to the crawl.** A static check is the only thing that can
 * see this one.
 *
 * WHAT IT MATCHES, after three rounds of false positives on its first run:
 *
 *   · a `.join()` whose separator contains a LOWER-CASE letter and whitespace.
 *     `join('')`, `join(', ')`, `join('/')` are punctuation and left alone.
 *   · NOT inside a comment. Its own documentation, and the note at the call site
 *     it fixed, both matched on the first run — four hits in `lib/i18n/list.ts`
 *     alone, which is the file that removes the defect.
 *   · NOT an upper-case separator. `where.join(' AND ')` in
 *     `lib/expenses/service.ts` is SQL. A gate that cannot tell a query from a
 *     sentence would be turned off within a week.
 *
 * The crudeness is deliberate and the failure mode is the safe one: somebody
 * joining on a lower-case word for a machine format gets told to think about it,
 * and can add themselves to EXEMPT_JOINS with a reason.
 */
const WORD_JOIN_RE = /\.join\(\s*(['"`])([^'"`]*[a-z][^'"`]*)\1\s*\)/g;

/**
 * Sites that join on a word and are NOT this ticket's to fix, each with a reason.
 *
 * Both entries below are genuinely un-catalogued sentences a person reads —
 * found by this gate on its first run, in integration code rather than on any
 * screen the pseudo-locale crawl visits. They are boarded rather than folded into
 * VX4-10, which is about the seven crawled screens; see HANDOFF.
 *
 * An exemption is a debt with a name on it. It is not an allow-list for
 * convenience.
 */
const EXEMPT_JOINS = new Map([
  [
    'lib/integrations/conflicts.ts',
    'rivalMessage() and its sibling build whole English sentences as template literals — the join is the smallest part of the problem. Needs the integrations refusal catalogue, boarded.',
  ],
  [
    'lib/integrations/service.ts',
    'same family as conflicts.ts, same catalogue, boarded with it.',
  ],
  [
    'lib/i18n/list.ts',
    'the file that REPLACES these joins. Its fallback path joins on a comma and its documentation quotes the defect.',
  ],
  [
    'scripts/check-i18n.mjs',
    'this gate quotes the pattern it refuses.',
  ],
]);

function wordJoins(text, filePath) {
  if (EXEMPT_JOINS.has(filePath)) return [];
  const lines = text.split('\n');
  const out = [];
  for (const m of text.matchAll(WORD_JOIN_RE)) {
    const separator = m[2];
    // A connector is a word with space around it; a delimiter is not.
    if (!/\s/.test(separator)) continue;
    if (!/^\s*[a-z]+\s*$/.test(separator)) continue;
    const lineNo = text.slice(0, m.index).split('\n').length;
    const line = lines[lineNo - 1] ?? '';
    // Comments. Its own docs matched on the first run, four times.
    const before = line.slice(0, line.indexOf('.join('));
    // `{/*` as well as `/*`: a JSX comment is the form this file's own note at
    // the fixed call site takes, and it matched on the second run.
    if (/^\s*[{(]?\s*(\*|\/\/|\/\*)/.test(line) || before.includes('//') || before.includes('/*')) continue;
    out.push({ file: filePath, line: lineNo, separator });
  }
  return out;
}

function deadCatalogues(enumsText, scanned) {
  const declared = [...enumsText.matchAll(/^export const ([A-Z][A-Z0-9_]*_COPY)\b/gm)].map(
    (m) => m[1],
  );
  const dead = [];
  for (const name of declared) {
    const re = new RegExp(`\\b${name}\\b`);
    const readers = scanned.filter(({ rel, text }) => {
      if (rel.endsWith('lib/i18n/catalog/enums.ts')) return false;
      // A test proves coverage, not use. Excluded on purpose — including them is
      // what made this defect invisible for two releases.
      if (rel.startsWith('test/') || rel.includes('.test.')) return false;
      return re.test(text);
    });
    if (readers.length === 0) dead.push(name);
  }
  return dead;
}

const ALLOWED = new Set([
  'lib/i18n/locales.ts', // the registry itself
  'scripts/check-i18n.mjs', // this file: the patterns below are tags
  // A stub server impersonating a third-party ledger vendor, whose own HTML page
  // is not our product's UI. Its `lang` is the fake vendor's, and localising it
  // would make the test double less like the thing it doubles.
  'scripts/e2e-ledger.mjs',
]);

/**
 * Files where AUTHORED COPY lives, keyed by the locale it is written in.
 *
 * Supported tags are allowed here; bare subtags are still refused. The
 * distinction matters and the first run of this gate is what forced it: it
 * flagged the seven `shipped: { 'en-CA': … }` maps in the notification
 * catalogue, and the obvious "fix" was to write `{ [DEFAULT_LOCALE]: … }` so the
 * tag came from the registry.
 *
 * THAT WOULD HAVE BEEN A LIE that happens to be true today. `{actor} approved
 * {report}` is written in Canadian English as a matter of fact, not "in whatever
 * the default is" — so the day `DEFAULT_LOCALE` moves to `fr-CA`, a computed key
 * would silently relabel every English sentence in the product as French, and
 * the coverage check would then pass because the French catalogue would appear
 * complete. A literal tag on authored copy is correct precisely because it does
 * NOT move when the default does.
 *
 * What is genuinely missing here — that every shipped string exists in every
 * locale — is not a text property and cannot be scanned for. It is asserted
 * against the template registry as the source of truth in part 2 (UD-5 req 1/2).
 */
const COPY_FILES = new Set([
  'lib/notifications/catalog.ts',
  // VX4-7 part 2a. The enum catalogue is authored copy keyed by the locale each
  // string is written in — the same case, and it is caught by this gate for the
  // same good reason. What it needs instead of a text scan is COVERAGE, which is
  // not a text property: `test/i18n-enum-catalog.test.ts` asserts every rendered
  // enum member resolves in every shipped locale, enumerating the enums rather
  // than the catalogue's own keys.
  'lib/i18n/catalog/enums.ts',
  // VX4-7 part 2b. Same case again — authored SENTENCES keyed by the locale they
  // are written in. Coverage is not a text property here either, and this file's
  // guarantee is stronger than a scan could give: the type demands the default
  // locale, `test/i18n-policy-messages.test.ts` renders every code in every
  // shipped locale from the rules' own output, and `policyMessageCodes()` above
  // asserts the code set matches lib/policy/rules.ts in both directions.
  'lib/i18n/catalog/policy-messages.ts',
  // VX4-7 part 2c. Authored refusals, keyed by the locale they are written in —
  // third instance of the same case. Coverage here is the plainest of the three:
  // `Record<UserMessageCode, Copy>` demands an entry per code, `Copy` demands the
  // default locale, and `test/i18n-errors.test.ts` walks the runtime array to
  // assert every code resolves in every shipped locale.
  'lib/i18n/catalog/errors.ts',
  // VX4-8 part 2. Fourth instance, and the guarantee is the same as
  // policy-messages': the type demands the default locale, `messageCodesFor`
  // above asserts the code set matches lib/fraud/rules.ts in both directions,
  // and `test/i18n-fraud-messages.test.ts` renders every code in every shipped
  // locale from the detectors' own output.
  'lib/i18n/catalog/fraud-messages.ts',
  // VX4-8 part 3. Fifth instance, same guarantee.
  'lib/i18n/catalog/control-messages.ts',
  // VX4-10. The chrome catalogue, and the SIXTH instance — but its coverage
  // guarantee is weaker than the five above and the difference is worth stating
  // where somebody adding a seventh will read it.
  //
  // Those five are keyed by something the product independently enumerates (a
  // status union, a rule's message codes), so "did you miss one" is a question
  // the type system or a generated assertion can answer. Chrome has no such
  // enumeration — UI_COPY *is* the list — so the type only proves that every key
  // USED exists, never that every string SHOWN is a key.
  //
  // What covers the other direction is not in this file at all: it is the
  // un-catalogued ratchet in `e2e/pseudo-crawl.spec.ts`, which counts what a page
  // renders and refuses to let the number grow. That is why VX4-10 lowers those
  // ceilings as it catalogues rather than deleting the gate.
  'lib/i18n/catalog/ui.ts',
]);

async function* sourceFiles(root) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.next') continue;
      yield* sourceFiles(full);
    } else if (/\.(ts|tsx|mjs|js)$/.test(entry.name)) {
      yield full;
    }
  }
}

/**
 * Bare language subtags that look like locales and are not ones we serve.
 *
 * `'en'` is on this list and it is the whole of IL-1. Upstream shipped `'en'` as
 * their default for years while believing it meant Canadian English; `Intl`
 * treats it as `en-US` (`3/4/2026`, `CA$10,799.00`). A bare subtag in this
 * codebase is therefore never right — it is either a tag somebody meant to be
 * `en-CA` or a language code doing a locale's job.
 */
const BARE_SUBTAGS = ['en', 'fr'];

function findings(text, locales, filePath, isCopyFile) {
  const out = [];
  const isTestFile = /\.test\.tsx?$/.test(filePath);
  const lines = text.split('\n');

  lines.forEach((line, i) => {
    // Comments are prose and may discuss tags — this file's own header does, and
    // so do the migration and registry comments quoted across lib/. Skipping
    // them costs nothing: a locale literal that only appears in a comment is not
    // a locale decision.
    const code = line.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '');
    if (/^\s*\*/.test(line)) return;

    if (!isCopyFile) {
      for (const locale of locales) {
        // Quoted, or an HTML attribute value.
        const re = new RegExp(`(['"\`])${locale}\\1`, 'g');
        const hits = code.match(re)?.length ?? 0;
        for (let n = 0; n < hits; n += 1) {
          out.push({ line: i + 1, text: line.trim(), found: locale, kind: 'supported-tag' });
        }
      }
    }
    for (const bare of BARE_SUBTAGS) {
      // `lang="en"`, `'en'` as an Intl argument, `{ en: '…' }` as a locale map
      // key. Narrow patterns rather than a bare word match, so `'length'` and
      // `en` inside an identifier do not trip it.
      const patterns = [
        new RegExp(`lang\\s*=\\s*["'\`]${bare}["'\`]`),
        new RegExp(`locale\\s*[:=]\\s*['"\`]${bare}['"\`]`),
        new RegExp(`Intl\\.[A-Za-z]+\\(\\s*['"\`]${bare}['"\`]`),
        new RegExp(`toLocale[A-Za-z]*\\(\\s*['"\`]${bare}['"\`]`),
        // The two locale-MAP patterns are skipped in a test file. Wave 0's ported ExpenseOS
        // screens store names as `{ en, fr-CA }` JSON (migration 0045), keyed by ExpenseOS's
        // catalogue locales, and their tests build that DATA as fixtures — a row whose
        // English name is "Meals" is not a locale decision. Product code is still held to
        // both patterns, and a test file still to the four above.
        ...(isTestFile
          ? []
          : [
              new RegExp(`['"\`]${bare}['"\`]\\s*:\\s*['"\`]`), // { 'en': 'some copy' }
              new RegExp(`\\{\\s*${bare}\\s*:\\s*['"\`]`), // { en: 'some copy' }
            ]),
      ];
      if (patterns.some((p) => p.test(code))) {
        out.push({ line: i + 1, text: line.trim(), found: bare, kind: 'bare-subtag' });
      }
    }
  });

  return out.map((f) => ({ ...f, file: relative(repoRoot, filePath) }));
}

/* ── the date-input guard ─────────────────────────────────────────────────── */

/**
 * Display formatters. Their output is localised BY DESIGN and must never reach
 * a date input's value.
 */
const DISPLAY_FORMATTERS = ['formatCalendarDate', 'formatInstant', 'formatMinor', 'formatDate'];

/**
 * Find `<input type="date">` elements whose value comes from a display
 * formatter.
 *
 * ── WHY THIS IS A GATE AND NOT A CODE REVIEW NOTE ───────────────────────────
 *
 * HTML requires the value of a date input to be `YYYY-MM-DD`, always, in every
 * locale. A browser given anything else does not complain — it shows an EMPTY
 * field. So localising one produces a form that looks like the date was never
 * set, and submitting it clears the stored date. Data loss, from a change that
 * reads like an improvement, with no error anywhere.
 *
 * `app/expenses/[reportId]/page.tsx` had exactly this shape before part 1b: it
 * fed the display formatter into `defaultValue` on the expense date field. It
 * was correct only because the formatter was accidentally ISO. The moment that
 * formatter learned about locales — the entire point of this ticket — it would
 * have become a data-loss bug on the most-used form in the product.
 *
 * Neither the type system nor a test catches it: the value is a `string` either
 * way, and an e2e that fills the field passes because filling overwrites
 * whatever was there. It is a TEXT property, so it gets a text gate — the same
 * reasoning `test/module-gates.test.ts` records for scanning source rather than
 * asserting behaviour.
 */
function dateInputMisuse(text, filePath) {
  const out = [];
  const OPEN = /<(input|Input)\b/g;
  for (const m of text.matchAll(OPEN)) {
    // Take the element's own span: from `<input` to the first `>` that closes it.
    // Attribute values here never contain a bare `>`, and a nested JSX expression
    // inside one would end the span early — which costs a miss, not a false
    // alarm, and a gate people trust is worth more than a gate that cries wolf.
    const end = text.indexOf('>', m.index);
    if (end === -1) continue;
    const el = text.slice(m.index, end + 1);
    if (!/type\s*=\s*["']date["']/.test(el)) continue;

    for (const fn of DISPLAY_FORMATTERS) {
      const re = new RegExp(`(?:default)?[Vv]alue\\s*=\\s*\\{[^}]*\\b${fn}\\s*\\(`);
      if (re.test(el)) {
        out.push({
          file: relative(repoRoot, filePath),
          line: text.slice(0, m.index).split('\n').length,
          fn,
        });
      }
    }
  }
  return out;
}

async function main() {
  const { locales, defaultLocale } = await readRegistry();

  const files = [];
  for (const root of SCAN_ROOTS) {
    for await (const f of sourceFiles(join(repoRoot, root))) files.push(f);
  }
  if (files.length === 0) {
    console.error('check:i18n — scanned 0 files; roots missing or renamed');
    process.exit(2);
  }

  const codeSets = [
    await messageCodesFor({
      label: 'policy',
      catalogueFile: POLICY_MESSAGES_FILE,
      arrayName: 'POLICY_MESSAGE_CODES',
      rulesFile: POLICY_RULES_FILE,
    }),
    await messageCodesFor({
      label: 'fraud',
      catalogueFile: FRAUD_MESSAGES_FILE,
      arrayName: 'FRAUD_MESSAGE_CODES',
      rulesFile: FRAUD_RULES_FILE,
    }),
    // Third caller, and the one that paid for parameterising this in part 2:
    // `controlFinding(CODE, MESSAGE_CODE, …)` is the same call shape, so the
    // scan needed no new regex.
    await messageCodesFor({
      label: 'control',
      catalogueFile: CONTROL_MESSAGES_FILE,
      arrayName: 'CONTROL_MESSAGE_CODES',
      rulesFile: CONTROL_RULES_FILE,
    }),
  ];
  const paramProblems = await errorMessageParams();

  const all = [];
  const dateInputs = [];
  const rawErrors = [];
  // Kept for `deadCatalogues` below, so the tree is read once rather than twice.
  const scanned = [];
  const joins = [];
  for (const file of files) {
    const rel = relative(repoRoot, file);
    const text = await readFile(file, 'utf8');
    scanned.push({ rel, text });
    joins.push(...wordJoins(text, rel));
    // NOT skipped for an ALLOWED file: the allow-list is about locale literals,
    // and a file being allowed to name `en-CA` says nothing about whether it may
    // print an exception. Two checks, two questions.
    rawErrors.push(...rawErrorMessage(text, file));
    if (ALLOWED.has(rel)) continue;
    all.push(...findings(text, locales, file, COPY_FILES.has(rel)));
    dateInputs.push(...dateInputMisuse(text, file));
  }

  console.log(
    `check:i18n — registry: ${locales.join(', ')} (default ${defaultLocale}); ` +
      `scanned ${files.length} files in ${SCAN_ROOTS.join(', ')}; ` +
      codeSets.map((c) => `${c.declared.length} ${c.label} message codes`).join('; '),
  );

  if (paramProblems.length > 0) {
    console.error(`\n✗ ${paramProblems.length} error message(s) whose params do not match:\n`);
    for (const p of paramProblems) {
      console.error(
        p.kind === 'missing'
          ? `  ${p.file}:${p.line}  ${p.code} needs {${p.key}} and the throw site omits it`
          : `  ${p.file}:${p.line}  ${p.code} is passed ${p.key}, which its sentence never uses`,
      );
    }
    console.error(
      '\nA missing key makes the sentence degrade to the generic — silently, for every\n' +
        'reader who hits it. An unused one is dead weight in a URL. Both are usually a\n' +
        'placeholder renamed on one side: see lib/i18n/catalog/errors.ts.\n',
    );
    process.exit(1);
  }

  if (rawErrors.length > 0) {
    console.error(`\n✗ ${rawErrors.length} site(s) that can put an exception's own text in front of a person:\n`);
    for (const r of rawErrors) {
      console.error(`  ${r.file}:${r.line}  ${r.why}`);
      console.error(`      ${r.text.slice(0, 100)}`);
    }
    console.error(
      '\n`err instanceof Error ? err.message : …` prints whatever ANY exception carries —\n' +
        'a TypeError from a bug, a pg error carrying part of the statement, and our own\n' +
        'diagnostics, which interpolate record ids. Use errorParam(err, context) from\n' +
        'lib/errors/domain.ts: it emits a message code for a catalogued refusal and logs\n' +
        'anything else instead of showing it.\n',
    );
    process.exit(1);
  }

  for (const set of codeSets) {
    if (set.missingCopy.length === 0 && set.orphanCopy.length === 0) continue;
    console.error(
      `\n✗ ${set.label} message codes disagree between the rules and the catalogue:\n`,
    );
    for (const c of set.missingCopy) {
      console.error(`  ${c}  emitted by ${set.rulesFile}, no copy in the catalogue`);
    }
    for (const c of set.orphanCopy) {
      console.error(`  ${c}  copy exists, no rule emits it`);
    }
    console.error(
      '\nA code with no copy renders as {THE_CODE} in front of somebody reading it.\n' +
        'A code no rule emits is copy that will be translated and never shown.\n' +
        `Add the entry, or delete it — see ${set.catalogueFile}.\n`,
    );
    process.exit(1);
  }

  if (dateInputs.length > 0) {
    console.error(`\n✗ ${dateInputs.length} date input(s) fed by a display formatter:\n`);
    for (const d of dateInputs) {
      console.error(`  ${d.file}:${d.line}  <input type="date"> value uses ${d.fn}()`);
    }
    console.error(
      '\nA date input\'s value must be YYYY-MM-DD in every locale — the browser\n' +
        'rejects anything else SILENTLY and renders an empty field, so submitting\n' +
        'the form clears the stored date. Use toDateInputValue() from\n' +
        'lib/i18n/format.ts, which is deliberately not locale-aware.\n',
    );
    process.exit(1);
  }

  if (all.length > 0) {
    console.error(`\n✗ ${all.length} locale literal(s) outside lib/i18n/locales.ts:\n`);
    for (const f of all) {
      console.error(`  ${f.file}:${f.line}  [${f.found}]  ${f.text.slice(0, 110)}`);
    }
    console.error(
      '\nA locale decided outside the registry is a locale the registry cannot move.\n' +
        'Read the tag from SUPPORTED_LOCALES / DEFAULT_LOCALE, or resolve it per reader\n' +
        'with lib/i18n/request.ts (readerPrefs). A bare "en" is never right — see IL-1.\n',
    );
    process.exit(1);
  }

  if (joins.length > 0) {
    console.error(`\n✗ ${joins.length} join(s) on a connecting WORD:\n`);
    for (const j of joins) console.error(`  ${j.file}:${j.line}  .join('${j.separator}')`);
    console.error(
      '\nA separator with a word in it is copy, and a copy decision no translator can\n' +
        'reach: English puts "and" between the last two, Japanese uses an ideographic\n' +
        'comma and no word at all, Spanish uses "y". Use joinAnd() or joinOr() from\n' +
        'lib/i18n/list.ts.\n' +
        '\nThis is a STATIC gate because the crawl cannot see this: a hardcoded word\n' +
        'inside a catalogued sentence sits in a text node that already carries a\n' +
        'pseudo-locale marker, and unbracketed() filters the whole node.\n',
    );
    process.exit(1);
  }

  const enumsFile = join(repoRoot, 'lib', 'i18n', 'catalog', 'enums.ts');
  const dead = deadCatalogues(await readFile(enumsFile, 'utf8'), scanned);
  if (dead.length > 0) {
    console.error(`\n✗ ${dead.length} enum catalogue(s) that nothing outside a test reads:\n`);
    for (const name of dead) console.error(`  ${name}`);
    console.error(
      '\nA catalogue with no call site is where a DUPLICATE hides. RULE_KIND_COPY sat\n' +
        'here for two releases with full coverage and a passing test, while\n' +
        'lib/policy/rules.ts held a second list of the same five names — the one the\n' +
        'screen actually rendered. They drifted on two members and nobody could see it,\n' +
        'because a coverage test proves a catalogue covers its union and cannot notice\n' +
        'that nobody asks it anything.\n' +
        '\nEither point a render path at it, or delete it. Do not leave it here.\n',
    );
    process.exit(1);
  }

  console.log('check:i18n: OK');
}

main().catch((e) => {
  console.error(`check:i18n could not run: ${e.message}`);
  process.exit(2);
});
