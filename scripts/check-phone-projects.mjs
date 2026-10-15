#!/usr/bin/env node
/**
 * VeloExpense: ExpenseOS's `scripts/check-phone-projects.mjs` (1e682dd6), ported with the phone
 * projects. Only `CONSUMERS` differs (marked there). `npm run check:phone-projects`.
 *
 * Phone-project wiring check — is every phone project in `playwright.config.ts` actually
 * wired to the things that measure it?
 *
 * ─── THE HOLE THIS CLOSES ────────────────────────────────────────────────────────────────
 *
 * A phone project is declared in one file and consumed in four others, and every one of
 * those connections fails QUIETLY when it is missed:
 *
 *   · A `mobile-412` whose `testMatch` is misspelled collects ZERO tests. It writes zero
 *     sidecars, never appears in the census's project list, and the census's phone-surface
 *     floor never fires for it — the floor is per project, computed from the projects that
 *     reported. The suite goes green having measured 412 not at all.
 *   · A project missing from `e2e/desktop-notice.spec.ts`'s list asserts the DESKTOP half of
 *     that spec — notice absent, page rendered — at a phone width. Also green, also backwards.
 *   · A project missing from `e2e/support/safe-area.ts`'s list throws, but only once a phone
 *     spec runs, which needs a server, a database and a browser.
 *   · A project missing from `test:e2e:mobile` is never selected by the command whose entire
 *     job is to run the phone projects. Declared, and measuring nothing.
 *
 * Three of those four consumer files already carried a comment saying a third phone project
 * added to the config and not added there should "fail loudly" or "fail the guard rather
 * than pass quietly". This is that guard. It did not exist when those comments were written.
 *
 * ─── WHY IT IS A TEXT SCAN AND NOT A REAL RUN ────────────────────────────────────────────
 *
 * Deliberate, and the only option that works. `playwright.config.ts`'s `webServer` starts
 * `npm run test:server`, which needs Postgres, Redis and MinIO — so `npx playwright test
 * --list` cannot answer "does `mobile-412` collect anything?" on a machine without the
 * stack up, which includes CI's lint/typecheck/test job and every developer who has not run
 * `npm run dev:up`. A scan of the source text needs none of that, runs in milliseconds, and
 * is therefore the only check that can stand between a half-wired project and a green build.
 *
 * ─── WHAT IT DELIBERATELY DOES NOT CHECK ─────────────────────────────────────────────────
 *
 * It never loads Playwright and never resolves a regex against a path, so it cannot tell you
 * that `PHONE_PROJECT_SPECS` matches any file that exists. It proves the projects agree with
 * each other and that each names the SHARED constant; whether that constant matches
 * anything is what `phoneSpecPattern`'s empty-list throw and the census's per-project floor
 * are for. It says nothing about viewports, `isMobile`, retries, or whether a project's
 * emulation actually applied — `e2e/desktop-notice.spec.ts` measures that last one in the
 * browser with `matchMedia`, which is the only place it can honestly be measured.
 *
 * It also assumes the house shape for a project block: `name:` on its own line, first key in
 * the object. A block that puts `testMatch` above `name` reads here as a project with no
 * `testMatch` and fails. That is the safe direction for a guess to be wrong in, and the
 * message says so.
 *
 * Exit 0 clean, 1 on any finding. `--json` for machine-readable output.
 */

import { readFileSync } from 'node:fs';

/** Where each fact lives. Paths are repo-relative; run this from the repo root. */
export const PLAYWRIGHT_CONFIG = 'playwright.config.ts';
export const PHONE_PROJECTS_MODULE = 'e2e/support/phone-projects.ts';
export const PACKAGE_JSON = 'package.json';

/**
 * The files that consume the list. Each must IMPORT it; none may restate it.
 *
 * A new consumer belongs here the moment it needs to know which projects are phones. Not
 * discovered by grepping for `PHONE_PROJECTS`, on purpose: a file that dropped the import
 * and went back to a hardcoded array would drop out of a grep-discovered list and the check
 * would report clean on exactly the regression it exists to catch.
 */
export const CONSUMERS = [
  // VeloExpense: the consumers ported so far. ExpenseOS's three — `e2e/desktop-notice.spec.ts`,
  // `e2e/tap-targets.mobile.spec.ts`, `e2e/support/safe-area.ts` — join this list as each is
  // ported; `expense-workbench.mobile.spec.ts` is here because it imports the list too (its
  // `assertProject` call), which in ExpenseOS this guard did not watch.
  'e2e/expense-workbench.mobile.spec.ts',
];

/** The npm script that must select every phone project. */
export const MOBILE_SCRIPT = 'test:e2e:mobile';

/**
 * What makes a declared project a PHONE project: the name is `mobile-<width>`.
 *
 * A convention, and load-bearing — this is how the check knows a project is in scope
 * without reading its viewport. Naming a phone project anything else (`phone-412`,
 * `pixel-7`) hides it from every check below. The naming rule is itself a ruling: projects
 * are named for a WIDTH and never for a handset, because a handset name is a coverage claim
 * (see ruling 7 and ruling 9 in `docs/design/pwa.md`).
 */
export const PHONE_PROJECT_NAME = /^mobile-\d+$/;

/** `name: 'x',` as its own line — the house shape for the first key of a project block. */
const NAME_LINE = /^[ \t]*name:\s*'([^']+)',?[ \t]*$/gm;
/** `testMatch: <value>,` as its own line, value captured up to the trailing comma. */
const TEST_MATCH_LINE = /^[ \t]*testMatch:\s*(.+?),?[ \t]*$/m;
/** A bare identifier — i.e. a shared constant rather than an inline regex. */
const BARE_IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/**
 * Comments blanked, not deleted, so every reported line number still points at the real
 * line. Lifted from `scripts/check-e2e-ids.mjs`, and needed for the same reason: these files
 * document themselves in enormous prose blocks that name `mobile-360` and `mobile-412`
 * dozens of times, and a scan that counted prose would report the list as restated
 * everywhere. The `//` rule spares `https://…`, whose slashes follow a colon.
 */
const blank = (m) => m.replace(/[^\n]/g, ' ');
export const stripComments = (src) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/(^|[^:])(\/\/[^\n]*)/g, (_, pre, c) => pre + blank(c));

/** 1-based line number of a character offset. */
const lineOf = (text, index) => text.slice(0, index).split('\n').length;

/**
 * Every project the config declares, in order, with its block text.
 *
 * A block runs from its own `name:` line to the next one — good enough because `name` is the
 * first key of every project object here, and wrong in the safe direction otherwise (see the
 * header).
 */
export function declaredProjects(configSource) {
  const src = stripComments(configSource);
  const anchors = [...src.matchAll(NAME_LINE)];
  return anchors.map((m, i) => {
    const start = m.index;
    const end = i + 1 < anchors.length ? anchors[i + 1].index : src.length;
    return {
      name: m[1],
      line: lineOf(src, start),
      block: src.slice(start, end),
    };
  });
}

/** Just the phone ones. */
export const declaredPhoneProjects = (configSource) =>
  declaredProjects(configSource).filter((p) => PHONE_PROJECT_NAME.test(p.name));

/**
 * The names in `export const PHONE_PROJECTS = [...]`.
 *
 * Returns `null` — distinct from `[]` — when the export cannot be found at all, because
 * those are different failures: a missing export is a broken module, an empty array is a
 * list somebody emptied.
 */
export function exportedPhoneProjects(moduleSource) {
  const m = stripComments(moduleSource).match(
    /export\s+const\s+PHONE_PROJECTS\s*(?::[^=]+)?=\s*\[([\s\S]*?)\]/,
  );
  if (!m) return null;
  return [...m[1].matchAll(/'([^']+)'/g)].map((q) => q[1]);
}

/** The `--project=` flags in one npm script's command line. */
export const projectFlagsIn = (command) =>
  [...command.matchAll(/--project=([\w.-]+)/g)].map((m) => m[1]);

/**
 * The whole check. Takes SOURCE TEXT, not paths, so the test can drive it with doctored
 * strings instead of writing files — the same shape `parsePageReadiness` uses for the
 * pwa.md parity check.
 *
 * @param {object} sources
 * @param {string} sources.config            `playwright.config.ts`
 * @param {string} sources.module            `e2e/support/phone-projects.ts`
 * @param {string} sources.packageJson       `package.json`
 * @param {Record<string, string>} sources.consumers  consumer path → source text
 * @returns {{findings: Array<{file: string, line: number, message: string, fix: string}>,
 *            declared: string[], exported: string[] | null}}
 */
export function checkPhoneProjects({ config, module: moduleSource, packageJson, consumers }) {
  const findings = [];
  const add = (file, line, message, fix) => findings.push({ file, line, message, fix });

  // ── 1. Every phone project names the SHARED derived `testMatch`, not its own regex. ──
  const phones = declaredPhoneProjects(config);
  if (phones.length === 0) {
    add(
      PLAYWRIGHT_CONFIG,
      1,
      "no phone projects declared at all — nothing matched `name: 'mobile-<width>'`",
      'either the projects are gone, or a project block no longer puts `name:` on its own ' +
        'line as the first key. Both need a human.',
    );
  }

  const constants = new Map();
  for (const project of phones) {
    const m = project.block.match(TEST_MATCH_LINE);
    if (!m) {
      add(
        PLAYWRIGHT_CONFIG,
        project.line,
        `${project.name} declares no \`testMatch\``,
        "a phone project without one inherits `chromium`'s bucket and re-runs the whole " +
          'desktop suite at a phone width. Add `testMatch: PHONE_PROJECT_SPECS`. (If the ' +
          "block DOES have one, it is below a reordered `name:` — see this script's header.)",
      );
      continue;
    }
    const value = m[1].trim();
    if (!BARE_IDENTIFIER.test(value)) {
      add(
        PLAYWRIGHT_CONFIG,
        project.line,
        `${project.name} uses a bespoke \`testMatch\`: ${value}`,
        'phone projects must share ONE derived constant. A hand-written regex breaks the ' +
          "subset invariant against `chromium`'s `testIgnore` by construction, and the " +
          'symptom lands in `e2e/topbar-overlap.spec.ts` — three files from the edit.',
      );
      continue;
    }
    if (!constants.has(value)) constants.set(value, []);
    constants.get(value).push(project.name);
  }

  if (constants.size > 1) {
    const spelled = [...constants.entries()]
      .map(([id, names]) => `${id} (${names.join(', ')})`)
      .join(' vs ');
    add(
      PLAYWRIGHT_CONFIG,
      phones[0]?.line ?? 1,
      `phone projects use ${constants.size} different \`testMatch\` constants: ${spelled}`,
      'they must all name the same one. Two constants means two spec buckets, and the ' +
        'project on the smaller one measures less than the others while reporting green.',
    );
  }

  for (const id of constants.keys()) {
    if (!new RegExp(String.raw`\bconst\s+${id}\b`).test(stripComments(config))) {
      add(
        PLAYWRIGHT_CONFIG,
        phones[0]?.line ?? 1,
        `\`testMatch: ${id}\` names a constant this config never declares`,
        `either \`${id}\` is a typo for the real constant, or it is imported from somewhere ` +
          'this check cannot follow. Declare it in the config.',
      );
    }
  }

  // ── 2. The config's phone set agrees with the exported constant. ──
  const declared = phones.map((p) => p.name);
  const exported = exportedPhoneProjects(moduleSource);

  if (exported === null) {
    add(
      PHONE_PROJECTS_MODULE,
      1,
      'no `export const PHONE_PROJECTS = [...]` found',
      'this module is the single list every consumer imports. Without it the consumers ' +
        'cannot source the list from anywhere and this whole check is vacuous.',
    );
  } else {
    for (const name of declared) {
      if (!exported.includes(name)) {
        add(
          PHONE_PROJECTS_MODULE,
          1,
          `${name} is declared in ${PLAYWRIGHT_CONFIG} and missing from \`PHONE_PROJECTS\``,
          `add '${name}'. Every consumer reads this array, so a project absent from it is ` +
            'invisible to the safe-area guard, the tap-target project assertion and the ' +
            'desktop-notice inversion — which is a green run that measured the wrong side.',
        );
      }
    }
    for (const name of exported) {
      if (!declared.includes(name)) {
        add(
          PHONE_PROJECTS_MODULE,
          1,
          `\`PHONE_PROJECTS\` lists ${name}, which ${PLAYWRIGHT_CONFIG} does not declare`,
          'a name no project has means the consumers are guarding a project that will ' +
            'never run. Remove it, or declare the project.',
        );
      }
    }
  }

  // ── 3. Every consumer IMPORTS the list and none restates it. ──
  const IMPORTS_LIST =
    /import\s*(?:type\s*)?\{[^}]*\bPHONE_PROJECTS\b[^}]*\}\s*from\s*'[^']*phone-projects'/;
  /** An array literal holding a quoted `mobile-<n>` — i.e. the list, written out again. */
  const RESTATES_LIST = /\[[^\]]*'mobile-\d+'/;

  for (const [file, source] of Object.entries(consumers)) {
    const src = stripComments(source);
    if (!IMPORTS_LIST.test(src)) {
      add(
        file,
        1,
        `does not import \`PHONE_PROJECTS\` from ${PHONE_PROJECTS_MODULE}`,
        'this file needs to know which projects are phones, and there is exactly one place ' +
          'that knows. Import it.',
      );
    }
    const restated = src.match(RESTATES_LIST);
    if (restated) {
      add(
        file,
        lineOf(src, restated.index),
        'restates the phone-project list inline instead of importing it',
        'a hand-kept copy is the failure this check exists for: it stays green while ' +
          'disagreeing with the config. Delete the array and use the imported constant.',
      );
    }
  }

  // ── 4. `test:e2e:mobile` selects every phone project. ──
  let scripts = {};
  let pkgOk = true;
  try {
    scripts = JSON.parse(packageJson).scripts ?? {};
  } catch (e) {
    pkgOk = false;
    add(
      PACKAGE_JSON,
      1,
      `is not valid JSON (${e.message})`,
      'nothing else in this file can be checked until it parses. Note npm itself would ' +
        'have refused the run, so seeing this here usually means the text was doctored ' +
        'in a test rather than broken on disk.',
    );
  }

  if (pkgOk) {
    const command = scripts[MOBILE_SCRIPT];
    const scriptLine = (() => {
      const at = packageJson.indexOf(`"${MOBILE_SCRIPT}"`);
      return at === -1 ? 1 : lineOf(packageJson, at);
    })();

    if (!command) {
      add(
        PACKAGE_JSON,
        1,
        `no \`${MOBILE_SCRIPT}\` script`,
        'this is the command whose whole job is to run the phone projects. It has to exist ' +
          'for anything below to be checkable.',
      );
    } else {
      const selected = projectFlagsIn(command);
      for (const name of declared) {
        if (!selected.includes(name)) {
          add(
            PACKAGE_JSON,
            scriptLine,
            `${MOBILE_SCRIPT} does not run ${name}`,
            `add \`--project=${name}\`. A project declared in the config and never ` +
              'selected here is the "declared but measuring nothing" hole exactly: it ' +
              'writes no sidecars, so the census never lists it and the per-project ' +
              'phone-surface floor never fires for it.',
          );
        }
      }
      for (const name of selected) {
        if (PHONE_PROJECT_NAME.test(name) && !declared.includes(name)) {
          add(
            PACKAGE_JSON,
            scriptLine,
            `${MOBILE_SCRIPT} runs ${name}, which ${PLAYWRIGHT_CONFIG} does not declare`,
            'Playwright exits non-zero on an unknown `--project`, so this breaks the ' +
              'command outright. Remove the flag or declare the project.',
          );
        }
      }
    }
  }

  return { findings, declared, exported };
}

/** Read the real files and check them. Split out so the CLI half stays thin. */
function checkFromDisk() {
  const consumers = Object.fromEntries(CONSUMERS.map((file) => [file, readFileSync(file, 'utf8')]));
  return checkPhoneProjects({
    config: readFileSync(PLAYWRIGHT_CONFIG, 'utf8'),
    module: readFileSync(PHONE_PROJECTS_MODULE, 'utf8'),
    packageJson: readFileSync(PACKAGE_JSON, 'utf8'),
    consumers,
  });
}

function main() {
  const { findings, declared, exported } = checkFromDisk();

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ declared, exported, findings, total: findings.length }, null, 2));
    process.exit(findings.length ? 1 : 0);
  }

  console.log(
    `Phone-project wiring check — ${declared.length} phone project(s) in ` +
      `${PLAYWRIGHT_CONFIG}: ${declared.join(', ') || '(none)'}\n`,
  );

  if (findings.length) {
    console.log(`NOT WIRED (${findings.length}):`);
    for (const f of findings) {
      console.log(`  ${f.file}:${f.line}  ${f.message}`);
      console.log(`    Fix: ${f.fix}`);
    }
    console.log('');
  } else {
    console.log(
      'Clean — every phone project shares the derived `testMatch`, appears in ' +
        `\`PHONE_PROJECTS\`, is selected by \`${MOBILE_SCRIPT}\`, and every consumer ` +
        'imports the list rather than restating it.',
    );
  }

  console.log(
    'Note: this reads SOURCE TEXT and never starts Playwright — it cannot run, because\n' +
      "the config's `webServer` needs Postgres, Redis and MinIO. So it proves the projects\n" +
      'agree with each other; it does NOT prove the shared `testMatch` matches any file that\n' +
      'exists, and it says nothing about viewports or whether emulation actually applied.\n' +
      "Those are the census floor and `e2e/desktop-notice.spec.ts`'s `matchMedia` check.",
  );

  process.exit(findings.length ? 1 : 0);
}

// CLI half only. Importing this module from `check-phone-projects.test.mjs` must not run the
// check or call `process.exit` — same split as `scripts/changed-paths.mjs`.
if (process.argv[1]?.endsWith('check-phone-projects.mjs')) {
  main();
}
