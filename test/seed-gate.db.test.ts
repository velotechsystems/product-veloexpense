/**
 * VX5-18 — the seed refuses an environment that has not identified itself.
 *
 * ── WHY THIS SPAWNS THE SCRIPT INSTEAD OF IMPORTING A FUNCTION ───────────────
 *
 * `scripts/seed.mjs` has no exports and this test deliberately does not give it
 * any. The thing under test is not `checkStage()` — it is what happens when
 * somebody types `npm run seed`, which is the only way this code is ever reached.
 * A unit test of an exported predicate would have passed on the day upstream's
 * defect shipped: their `testUsersAllowed()` was correct in isolation and refused
 * `STAGE=prod` exactly as written. What was wrong was the environment their CD
 * job actually handed it. Only running the real entry point can see that.
 *
 * So each case spawns `node scripts/seed.mjs` with a constructed environment and
 * asserts on the exit code, on stderr, and — for the cases that matter most — on
 * whether the database was actually written to. The last of those is the
 * assertion with teeth: a gate that prints a refusal and seeds anyway would pass
 * the first two.
 *
 * ── ON `env: {}` RATHER THAN DELETING KEYS ──────────────────────────────────
 *
 * The child gets an env built from scratch rather than `{...process.env, STAGE:
 * undefined}`, because this suite itself runs with STAGE set (vitest inherits it
 * from whatever ran `npm test`), and a "STAGE is absent" case that quietly
 * inherited one would be the vacuous test this file exists to avoid. Upstream hit
 * precisely this: their first attempt at the same check was invalid because a
 * `.env.local` on the developer's machine re-supplied the variable they thought
 * they had removed. Only PATH and the database URLs are passed through.
 */
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';

const run = promisify(execFile);
const SEED = fileURLToPath(new URL('../scripts/seed.mjs', import.meta.url));
const REPO = fileURLToPath(new URL('..', import.meta.url));

const admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL });

/**
 * Only what the script genuinely needs. Nothing that could smuggle in a STAGE.
 *
 * `NODE_ENV=development` IS set, on every single case, and that is an assertion
 * rather than a formality — this repo's `ProcessEnv` requires the key, and rather
 * than pass an empty string to satisfy the compiler this passes the most
 * permissive value there is. Every case below therefore also proves that
 * `NODE_ENV` grants nothing, which is where this gate deliberately diverges from
 * ExpenseOS's: theirs accepts `NODE_ENV=development` as an identification, and
 * every developer machine emits it by default.
 */
function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '',
    DATABASE_URL: process.env.DATABASE_URL ?? '',
    NODE_ENV: 'development',
    ...extra,
  };
}

type Outcome = { code: number; stdout: string; stderr: string };

async function seed(extra: Record<string, string> = {}): Promise<Outcome> {
  try {
    const { stdout, stderr } = await run('node', [SEED], { cwd: REPO, env: childEnv(extra) });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

async function orgSlugs(): Promise<string[]> {
  const r = await admin.query('SELECT slug FROM organization ORDER BY slug');
  return r.rows.map((row) => row.slug as string);
}

/**
 * TRUNCATE, like every other db suite here. `organization` cascades to every
 * tenant table, which is what we want: each case starts from a database with no
 * tenants in it, so "did the seed write anything" is answerable.
 */
async function truncateAll(): Promise<void> {
  await admin.query('TRUNCATE organization RESTART IDENTITY CASCADE');
}

beforeAll(async () => {
  await truncateAll();
});

afterAll(async () => {
  // Leave the database seeded. `chain-verify.check.ts` and the e2e both expect
  // the fixture tenants to exist, and this file is the one that last touched them.
  await seed({ STAGE: 'test' });
  await admin.end();
});

describe('the seed refuses an environment that has not said what it is', () => {
  test('NODE_ENV=development does not substitute for STAGE', async () => {
    await truncateAll();
    // The env this spawns with already carries NODE_ENV=development — see
    // childEnv. Named as its own case because it is the one behaviour here that
    // is deliberately STRICTER than the code it was ported from, and a future
    // reader softening the gate "to match upstream" should have to delete a test
    // that says so rather than merely relax a condition.
    const out = await seed();

    expect(out.code).toBe(1);
    expect(out.stderr).toContain('no STAGE is set');
    expect(await orgSlugs()).toEqual([]);
  });

  test('no STAGE: refuses, explains, and writes nothing', async () => {
    await truncateAll();
    const out = await seed();

    expect(out.code).toBe(1);
    expect(out.stderr).toContain('seed refused');
    expect(out.stderr).toContain('no STAGE is set');
    // The remedy, not just the complaint. A refusal that does not say what to do
    // instead is how somebody ends up deleting the check.
    expect(out.stderr).toContain('STAGE=local');

    // The assertion the other two cannot make: nothing was written.
    expect(await orgSlugs()).toEqual([]);
  });

  test('STAGE=prod: refuses, and points at signup rather than at itself', async () => {
    await truncateAll();
    const out = await seed({ STAGE: 'prod' });

    expect(out.code).toBe(1);
    expect(out.stderr).toContain('STAGE=prod');
    expect(out.stderr).toContain('signup');
    expect(await orgSlugs()).toEqual([]);
  });

  test('STAGE=production is refused too — the long spelling is the likelier one', async () => {
    await truncateAll();
    const out = await seed({ STAGE: 'Production' });

    expect(out.code).toBe(1);
    expect(await orgSlugs()).toEqual([]);
  });

  test('STAGE=ci: seeds the three fixture tenants', async () => {
    await truncateAll();
    const out = await seed({ STAGE: 'ci' });

    expect(out.stderr).not.toContain('seed refused');
    expect(out.code).toBe(0);
    expect(await orgSlugs()).toEqual(['blank', 'demo', 'second']);
  });

  test('it is still idempotent under the gate — a second run changes nothing', async () => {
    await truncateAll();
    await seed({ STAGE: 'test' });
    const before = await orgSlugs();

    const out = await seed({ STAGE: 'test' });

    expect(out.code).toBe(0);
    expect(await orgSlugs()).toEqual(before);
  });
});

describe('the order CI actually runs these steps in', () => {
  /**
   * THE CASE THAT KILLED A DESIGN, pinned so it cannot be rediscovered.
   *
   * The first version of this ticket added a second gate that refused any
   * database holding an organization the seed did not create. Its unit tests
   * passed. It would have failed every CI build, because every `.db.test.ts`
   * suite here creates its own organization and CI runs `npm test` and THEN
   * `npm run seed` — deliberately, since the DB suites TRUNCATE and the e2e needs
   * the fixtures back.
   *
   * So this test does what CI does, in CI's order, and requires it to work. It is
   * the assertion the rejected design would have failed, and it is here so that
   * anyone who reads the seed's comment and thinks "surely a data check is
   * obviously right" runs into evidence rather than into a red build.
   */
  test('a db suite leaves its own tenant behind, and the seed still runs after it', async () => {
    await truncateAll();

    // Stand in for any of the ~30 db suites: each creates an org named for itself.
    await admin.query("INSERT INTO organization (slug, name) VALUES ('access-co', 'Access Co')");

    const out = await seed({ STAGE: 'ci' });

    expect(out.stderr).not.toContain('seed refused');
    expect(out.code).toBe(0);
    expect(await orgSlugs()).toEqual(['access-co', 'blank', 'demo', 'second']);
  });

  test('it says which database it is about to write to, without the password', async () => {
    await truncateAll();
    const out = await seed({ STAGE: 'local' });

    expect(out.code).toBe(0);
    // The one mitigation for a STAGE that is right while DATABASE_URL is wrong:
    // put the destination in front of the person who can tell.
    expect(out.stdout).toContain('writing fixture tenants to');
    expect(out.stdout).toContain('STAGE=local');
    // Never the credential. DATABASE_URL carries one in every deployed shape.
    expect(out.stdout).not.toContain('velo:');
    expect(out.stdout).not.toMatch(/:\/\/[^@\s]*:[^@\s]+@/);
  });
});
