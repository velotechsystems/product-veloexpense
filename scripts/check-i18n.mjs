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

  const all = [];
  const dateInputs = [];
  for (const file of files) {
    const rel = relative(repoRoot, file);
    if (ALLOWED.has(rel)) continue;
    const text = await readFile(file, 'utf8');
    all.push(...findings(text, locales, file, COPY_FILES.has(rel)));
    dateInputs.push(...dateInputMisuse(text, file));
  }

  console.log(
    `check:i18n — registry: ${locales.join(', ')} (default ${defaultLocale}); ` +
      `scanned ${files.length} files in ${SCAN_ROOTS.join(', ')}`,
  );

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
