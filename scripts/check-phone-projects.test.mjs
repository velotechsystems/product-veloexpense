import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CONSUMERS,
  checkPhoneProjects,
  declaredPhoneProjects,
  exportedPhoneProjects,
  MOBILE_SCRIPT,
  PACKAGE_JSON,
  PHONE_PROJECTS_MODULE,
  PLAYWRIGHT_CONFIG,
  projectFlagsIn,
} from './check-phone-projects.mjs';

/**
 * The guard's own tests — and the ones that matter are the ones where it FAILS.
 *
 * A checker that returns "clean" for every input reports eternal agreement, and nobody finds
 * out until a phone project ships having measured nothing. Same reasoning as
 * `mobileReadiness.test.ts`'s `it('proves the parity check can fail')`, and the same shape:
 * the REAL repo files are the clean fixture, and every failure case is that text doctored in
 * one of the ways a real half-edit gets it wrong. Doctored strings, never files on disk —
 * `checkPhoneProjects` takes source text precisely so this test never mutates the repo.
 *
 * Read against `scripts/check-phone-projects.mjs`'s header for what it cannot see. These
 * tests inherit every one of those limits: none of them starts a browser, and a green run
 * here is a claim about the wiring, not about the layout at 412px.
 */

/** Repo root, derived from THIS FILE rather than `process.cwd()` — the idiom
 *  `scripts/use-case-docs.test.mjs` uses, for its stated reason: vitest runs from the repo
 *  root today, and a cwd-relative path would silently resolve to nothing the day it does not. */
const HERE = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(HERE, '..', p), 'utf8');

/** The repo as it stands. If this branch is coherent, these are a clean input. */
const real = () => ({
  config: read(PLAYWRIGHT_CONFIG),
  module: read(PHONE_PROJECTS_MODULE),
  packageJson: read(PACKAGE_JSON),
  consumers: Object.fromEntries(CONSUMERS.map((f) => [f, read(f)])),
});

/** `checkPhoneProjects(real())` with one field replaced. */
const withPatch = (patch) => checkPhoneProjects({ ...real(), ...patch });
const messages = (result) => result.findings.map((f) => `${f.file}: ${f.message}`);

describe('the repo as it stands', () => {
  it('is clean', () => {
    const { findings } = checkPhoneProjects(real());
    // Printed rather than just counted: a regression here should say WHAT broke.
    expect(messages({ findings })).toEqual([]);
  });

  it('sees all three phone projects, in the config and in the exported constant', () => {
    const result = checkPhoneProjects(real());
    expect(result.declared).toEqual(['mobile-360', 'mobile-390', 'mobile-412']);
    expect(result.exported).toEqual(['mobile-360', 'mobile-390', 'mobile-412']);
  });

  it('does not mistake `setup` or `chromium` for a phone project', () => {
    const names = declaredPhoneProjects(read(PLAYWRIGHT_CONFIG)).map((p) => p.name);
    expect(names).not.toContain('setup');
    expect(names).not.toContain('chromium');
  });

  it(`selects every phone project from ${MOBILE_SCRIPT}`, () => {
    const command = JSON.parse(read(PACKAGE_JSON)).scripts[MOBILE_SCRIPT];
    expect(projectFlagsIn(command)).toEqual(['mobile-360', 'mobile-390', 'mobile-412']);
  });
});

describe('parsers', () => {
  it('reads the exported list and distinguishes "no export" from "empty list"', () => {
    expect(exportedPhoneProjects("export const PHONE_PROJECTS = ['a', 'b'] as const;")).toEqual([
      'a',
      'b',
    ]);
    expect(exportedPhoneProjects('export const PHONE_PROJECTS = [] as const;')).toEqual([]);
    // Not the same failure as an empty list, and reported differently.
    expect(exportedPhoneProjects('const PHONE_PROJECTS = [];')).toBeNull();
  });

  it('ignores project names that appear only in prose', () => {
    // The config and the module both name every project dozens of times in comments. A scan
    // that counted those would find the list "restated" in every file.
    const commented = `
      /** mobile-999 is discussed at length here, and in ['mobile-998'] too. */
      // name: 'mobile-997',
      export const PHONE_PROJECTS = ['mobile-360'] as const;
    `;
    expect(exportedPhoneProjects(commented)).toEqual(['mobile-360']);
    expect(declaredPhoneProjects(commented)).toEqual([]);
  });
});

describe('proves the check can fail', () => {
  it('catches a bespoke `testMatch` regex on a phone project', () => {
    // The documented half-edit: a third hand-written regex instead of the shared constant.
    // It typechecks, it collects files, and it silently stops agreeing with `chromium`'s
    // `testIgnore`.
    const doctored = read(PLAYWRIGHT_CONFIG).replace(
      "      name: 'mobile-412',",
      "      name: 'mobile-412',\n      testMatch: /.*\\.mobile\\.spec\\.ts$/,",
    );
    const result = withPatch({ config: doctored });
    expect(messages(result)).toContainEqual(
      expect.stringContaining('mobile-412 uses a bespoke `testMatch`'),
    );
  });

  it('catches a MISSPELLED shared constant, which is the quiet version of the same edit', () => {
    // `PHONE_PROJECT_SPEC` — one character off. Two different constants across the phone
    // projects, so two spec buckets, so one project measures less than the others.
    const doctored = read(PLAYWRIGHT_CONFIG).replace(
      "      name: 'mobile-412',\n      // The identical constant",
      "      name: 'mobile-412',\n      testMatch: PHONE_PROJECT_SPEC,\n      // The identical constant",
    );
    expect(doctored).not.toEqual(read(PLAYWRIGHT_CONFIG));
    const result = withPatch({ config: doctored });
    expect(messages(result)).toContainEqual(
      expect.stringContaining('different `testMatch` constants'),
    );
    expect(messages(result)).toContainEqual(
      expect.stringContaining('names a constant this config never declares'),
    );
  });

  it('catches a phone project with no `testMatch` at all', () => {
    const doctored = read(PLAYWRIGHT_CONFIG).replace(
      '      testMatch: PHONE_PROJECT_SPECS,\n      // Zero for the same reason as the other two',
      '      // Zero for the same reason as the other two',
    );
    const result = withPatch({ config: doctored });
    expect(messages(result)).toContainEqual(
      expect.stringContaining('mobile-412 declares no `testMatch`'),
    );
  });

  it('catches a project declared in the config and missing from `PHONE_PROJECTS`', () => {
    const doctored = read(PHONE_PROJECTS_MODULE).replace(
      "export const PHONE_PROJECTS = ['mobile-360', 'mobile-390', 'mobile-412'] as const;",
      "export const PHONE_PROJECTS = ['mobile-360', 'mobile-390'] as const;",
    );
    const result = withPatch({ module: doctored });
    expect(messages(result)).toContainEqual(
      expect.stringContaining('mobile-412 is declared in playwright.config.ts and missing'),
    );
  });

  it('catches the reverse — a name in `PHONE_PROJECTS` that no project declares', () => {
    const doctored = read(PHONE_PROJECTS_MODULE).replace(
      "'mobile-412'] as const;",
      "'mobile-412', 'mobile-430'] as const;",
    );
    const result = withPatch({ module: doctored });
    expect(messages(result)).toContainEqual(expect.stringContaining('lists mobile-430'));
  });

  it('catches a missing `PHONE_PROJECTS` export outright', () => {
    const result = withPatch({ module: '// nothing here\n' });
    expect(messages(result)).toContainEqual(
      expect.stringContaining('no `export const PHONE_PROJECTS = [...]` found'),
    );
  });

  it(`catches a phone project missing from ${MOBILE_SCRIPT}`, () => {
    // The "declared but measuring nothing" hole in its purest form: the project exists, the
    // consumers know about it, and the command that runs the phone suite never selects it.
    const doctored = read(PACKAGE_JSON).replace(' --project=mobile-412', '');
    const result = withPatch({ packageJson: doctored });
    expect(messages(result)).toContainEqual(
      expect.stringContaining(`${MOBILE_SCRIPT} does not run mobile-412`),
    );
  });

  it(`catches ${MOBILE_SCRIPT} naming a project that does not exist`, () => {
    const doctored = read(PACKAGE_JSON).replace(
      '--project=mobile-412',
      '--project=mobile-412 --project=mobile-999',
    );
    const result = withPatch({ packageJson: doctored });
    expect(messages(result)).toContainEqual(
      expect.stringContaining('runs mobile-999, which playwright.config.ts does not declare'),
    );
  });

  it('catches a consumer that restates the list instead of importing it', () => {
    // Precisely the state all three consumers were in before this phase.
    // VeloExpense: on the consumer VeloExpense has (ExpenseOS: `desktop-notice.spec.ts`).
    const file = 'e2e/expense-workbench.mobile.spec.ts';
    const doctored = read(file)
      .replace("import { PHONE_PROJECTS } from './support/phone-projects';\n", '')
      .replace(
        'const CALLER =',
        "const PHONE_PROJECTS = ['mobile-360', 'mobile-390'] as const;\nconst CALLER =",
      );
    expect(doctored).not.toEqual(read(file));
    const result = withPatch({
      consumers: { ...real().consumers, [file]: doctored },
    });
    expect(messages(result)).toContainEqual(
      `${file}: does not import \`PHONE_PROJECTS\` from ${PHONE_PROJECTS_MODULE}`,
    );
    expect(messages(result)).toContainEqual(
      `${file}: restates the phone-project list inline instead of importing it`,
    );
  });

  it('reports the restated list at the line it is actually on', () => {
    // Blanked comments rather than deleted ones. These files carry 100-line prose headers,
    // so collapsing one would move every line after it and send the reader to the wrong
    // place — the bug `check-e2e-ids.mjs` records having shipped once.
    // VeloExpense: on the consumer VeloExpense has (ExpenseOS: `support/safe-area.ts`).
    const file = 'e2e/expense-workbench.mobile.spec.ts';
    const source = read(file);
    const doctored = source.replace(
      'const CALLER =',
      "const COPY = ['mobile-360'];\nconst CALLER =",
    );
    const expectedLine = doctored.split('\n').findIndex((l) => l.startsWith('const COPY')) + 1;
    expect(expectedLine).toBeGreaterThan(50);
    const result = withPatch({ consumers: { ...real().consumers, [file]: doctored } });
    const restated = result.findings.find((f) => f.message.startsWith('restates'));
    expect(restated).toBeDefined();
    expect(restated.line).toBe(expectedLine);
  });

  it('catches a config with no phone projects left in it', () => {
    const result = withPatch({ config: 'export default { projects: [] };\n' });
    expect(messages(result)).toContainEqual(
      expect.stringContaining('no phone projects declared at all'),
    );
  });

  it('says something useful when package.json is not JSON', () => {
    const result = withPatch({ packageJson: '{ not json' });
    expect(messages(result)).toContainEqual(expect.stringContaining('is not valid JSON'));
  });

  it(`catches a missing ${MOBILE_SCRIPT} script`, () => {
    const result = withPatch({ packageJson: JSON.stringify({ scripts: {} }) });
    expect(messages(result)).toContainEqual(
      expect.stringContaining(`no \`${MOBILE_SCRIPT}\` script`),
    );
  });
});

describe('every finding is actionable', () => {
  it('carries a file, a line and a fix', () => {
    // A guard whose output does not say what to do gets suppressed rather than fixed.
    const result = withPatch({ module: '// nothing here\n', packageJson: '{ not json' });
    expect(result.findings.length).toBeGreaterThan(0);
    for (const f of result.findings) {
      expect(f.file).toBeTruthy();
      expect(f.line).toBeGreaterThan(0);
      expect(f.message).toBeTruthy();
      expect(f.fix.length).toBeGreaterThan(20);
    }
  });

  it('names the real paths, so a reader can open what it reports', () => {
    expect(PLAYWRIGHT_CONFIG).toBe('playwright.config.ts');
    expect(PHONE_PROJECTS_MODULE).toBe('e2e/support/phone-projects.ts');
    expect(PACKAGE_JSON).toBe('package.json');
    // VeloExpense: the consumers ported so far (see `CONSUMERS`).
    expect(CONSUMERS).toEqual(['e2e/expense-workbench.mobile.spec.ts']);
  });
});
