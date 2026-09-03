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

const ACTION_ERROR_RE = /instanceof Error\s*\?\s*\w+\.message/;

/**
 * VX4-7 part 2c — no action may put an arbitrary exception's message in a URL.
 *
 * `err instanceof Error ? err.message : 'Something went wrong'` was the pattern
 * at eleven call sites, and it printed whatever ANY exception carried: a
 * `TypeError` from a bug, a `pg` error carrying a fragment of the statement, an
 * adapter's HTTP body. It also printed our own diagnostics, which interpolate
 * record ids — `user <uuid> may not decide approval task <uuid>` reached the
 * screen of somebody who by definition had no right to that task.
 *
 * `errorParam()` in `lib/errors/domain.ts` is the replacement and the only
 * sanctioned way to build the parameter. This refuses the old shape coming back,
 * because it is the shape somebody writes from memory in the next action file.
 *
 * A NARROW check on purpose: it does not try to prove every action routes
 * through `errorParam`, which would need the call graph. It refuses the one
 * spelling that caused this, which is the one a person reaches for.
 */
function rawErrorMessage(text, filePath) {
  const rel = relative(repoRoot, filePath);
  if (!rel.startsWith('app/')) return [];
  const out = [];
  text.split('\n').forEach((line, i) => {
    if (ACTION_ERROR_RE.test(line)) out.push({ file: rel, line: i + 1, text: line.trim() });
  });
  return out;
}

const POLICY_MESSAGES_FILE = join(repoRoot, 'lib', 'i18n', 'catalog', 'policy-messages.ts');
const POLICY_RULES_FILE = join(repoRoot, 'lib', 'policy', 'rules.ts');

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
async function policyMessageCodes() {
  const catalogueSrc = await readFile(POLICY_MESSAGES_FILE, 'utf8');
  const array = /export const POLICY_MESSAGE_CODES = \[([^\]]+)\] as const;/.exec(catalogueSrc);
  if (!array) {
    throw new Error(
      `could not read POLICY_MESSAGE_CODES out of ${relative(repoRoot, POLICY_MESSAGES_FILE)} — ` +
        `if the declaration was reformatted, update this regex; do not delete the check`,
    );
  }
  const declared = [...array[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  if (declared.length === 0) throw new Error('POLICY_MESSAGE_CODES parsed as empty');

  // Every code named as the second argument to `finding(...)`, which is the ONLY
  // way rules.ts builds a Finding — enforced by the object literal being gone
  // from that file, and by `test/i18n-policy-messages.test.ts` driving the real
  // rules and asserting all ten codes are reachable.
  const rulesSrc = await readFile(POLICY_RULES_FILE, 'utf8');
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
      `found no finding(RULE, CODE, …) calls in ${relative(repoRoot, POLICY_RULES_FILE)} — ` +
        `if findings are built another way now, update this scan; do not delete the check`,
    );
  }
  return {
    orphanCopy: declared.filter((c) => !emitted.has(c)),
    missingCopy: [...emitted].filter((c) => !declared.includes(c)),
    declared,
  };
}

/** Files exempt from the whole scan. */
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
        new RegExp(`['"\`]${bare}['"\`]\\s*:\\s*['"\`]`), // { 'en': 'some copy' }
        new RegExp(`\\{\\s*${bare}\\s*:\\s*['"\`]`), // { en: 'some copy' }
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

  const policyCodes = await policyMessageCodes();

  const all = [];
  const dateInputs = [];
  const rawErrors = [];
  for (const file of files) {
    const rel = relative(repoRoot, file);
    const text = await readFile(file, 'utf8');
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
      `${policyCodes.declared.length} policy message codes`,
  );

  if (rawErrors.length > 0) {
    console.error(`\n✗ ${rawErrors.length} action(s) putting a raw exception message in a URL:\n`);
    for (const r of rawErrors) console.error(`  ${r.file}:${r.line}  ${r.text.slice(0, 100)}`);
    console.error(
      '\n`err instanceof Error ? err.message : …` prints whatever ANY exception carries —\n' +
        'a TypeError from a bug, a pg error carrying part of the statement, and our own\n' +
        'diagnostics, which interpolate record ids. Use errorParam(err, context) from\n' +
        'lib/errors/domain.ts: it emits a message code for a catalogued refusal and logs\n' +
        'anything else instead of showing it.\n',
    );
    process.exit(1);
  }

  if (policyCodes.missingCopy.length > 0 || policyCodes.orphanCopy.length > 0) {
    console.error('\n✗ policy message codes disagree between the rules and the catalogue:\n');
    for (const c of policyCodes.missingCopy) {
      console.error(`  ${c}  emitted by lib/policy/rules.ts, no copy in the catalogue`);
    }
    for (const c of policyCodes.orphanCopy) {
      console.error(`  ${c}  copy exists, no rule emits it`);
    }
    console.error(
      '\nA code with no copy renders as {THE_CODE} on a report somebody is reading.\n' +
        'A code no rule emits is copy that will be translated and never shown.\n' +
        'Add the entry to POLICY_MESSAGES, or delete it — see lib/i18n/catalog/policy-messages.ts.\n',
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

  console.log('check:i18n: OK');
}

main().catch((e) => {
  console.error(`check:i18n could not run: ${e.message}`);
  process.exit(2);
});
