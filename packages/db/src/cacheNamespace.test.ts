// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cacheNamespace } from './cacheNamespace';

/**
 * The namespace that stops one database's cache answering for another's.
 *
 * The incident is written up on the function. What matters here is that the two halves
 * hold: the namespace DISTINGUISHES databases that differ, and it AGREES for processes
 * pointed at the same one — a web app and a worker that disagreed would each be caching
 * for themselves, which is a subtler version of the same bug.
 */

const ORIGINAL = process.env.DATABASE_URL;
const at = (url: string | undefined) => {
  if (url === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = url;
  return cacheNamespace();
};

beforeEach(() => {
  process.env.DATABASE_URL = 'postgresql://u:p@localhost:5432/expenseos';
});
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = ORIGINAL;
});

describe('telling databases apart', () => {
  it('gives the three local databases three different namespaces', () => {
    /**
     * The whole point. These three share one Redis instance on every developer's machine
     * and hold different data under identical seeded ids.
     */
    const dev = at('postgresql://u:p@localhost:5432/expenseos');
    const test = at('postgresql://u:p@localhost:5432/expenseos_test');
    const e2e = at('postgresql://u:p@localhost:5432/expenseos_e2e');
    expect(new Set([dev, test, e2e]).size).toBe(3);
  });

  it('distinguishes the same database name on different hosts', () => {
    // `expenseos` in dev and `expenseos` in staging are not the same data.
    expect(at('postgresql://u:p@localhost:5432/expenseos')).not.toBe(
      at('postgresql://u:p@db.internal:5432/expenseos'),
    );
  });

  it('distinguishes the same database name on different ports', () => {
    expect(at('postgresql://u:p@localhost:5432/expenseos')).not.toBe(
      at('postgresql://u:p@localhost:5433/expenseos'),
    );
  });
});

describe('agreeing where it must', () => {
  it('is identical for two processes on the same database', () => {
    // The web app and the worker SHARE a cache, which is the point of caching it.
    const web = at('postgresql://u:p@localhost:5432/expenseos');
    const worker = at('postgresql://u:p@localhost:5432/expenseos');
    expect(web).toBe(worker);
  });

  it('survives a credential rotation without dumping the cache', () => {
    /**
     * Hashing the whole URL would work and would mean a routine password change silently
     * invalidated every cached entry in the deployment — a thundering herd for a value
     * that did not change. Credentials are deliberately not part of the identity.
     */
    expect(at('postgresql://u:old-secret@localhost:5432/expenseos')).toBe(
      at('postgresql://u:new-secret@localhost:5432/expenseos'),
    );
  });

  it('ignores query parameters, which are connection options and not identity', () => {
    expect(at('postgresql://u:p@localhost:5432/expenseos?schema=public&pool=20')).toBe(
      at('postgresql://u:p@localhost:5432/expenseos'),
    );
  });
});

describe('the shape of it', () => {
  it('carries the readable database name, so a key can be traced in redis-cli', () => {
    // The alternative is `rbac:role:a1b2c3d4:…` and no way to tell which environment it
    // belongs to. A database name is not a secret.
    expect(at('postgresql://u:p@localhost:5432/expenseos_e2e')).toMatch(
      /^expenseos_e2e\.[0-9a-f]{8}$/,
    );
  });

  it('never leaks the credentials into the key', () => {
    const ns = at('postgresql://admin:sup3r-s3cret@localhost:5432/expenseos');
    expect(ns).not.toContain('sup3r-s3cret');
    expect(ns).not.toContain('admin');
  });

  it('strips anything a Redis key should not carry out of the name', () => {
    const ns = at('postgresql://u:p@localhost:5432/Weird Name*With:Junk');
    expect(ns.split('.')[0]).toMatch(/^[a-z0-9_-]*$/);
  });
});

describe('degrading rather than throwing', () => {
  it('has a stable answer with no DATABASE_URL at all', () => {
    // A process with no database has no identity to be confused about, and a cache helper
    // may not be the thing that takes an app down at import time.
    expect(at(undefined)).toBe('nodb');
    expect(at('')).toBe('nodb');
  });

  it('has a stable answer for a URL it cannot parse', () => {
    const first = at('not a url at all');
    const second = at('not a url at all');
    expect(first).toBe(second);
    expect(first).toMatch(/^unknown\.[0-9a-f]{8}$/);
  });

  it('still tells two unparseable URLs apart', () => {
    expect(at('garbage one')).not.toBe(at('garbage two'));
  });
});

describe('the memo', () => {
  it('recomputes when the environment changes, rather than answering with the first', () => {
    // Memoized against the URL, not computed once — otherwise a suite that changes
    // DATABASE_URL between cases gets one answer forever and proves nothing.
    const a = at('postgresql://u:p@localhost:5432/one');
    const b = at('postgresql://u:p@localhost:5432/two');
    const backToA = at('postgresql://u:p@localhost:5432/one');
    expect(a).not.toBe(b);
    expect(backToA).toBe(a);
  });
});

// ── The drift guard ───────────────────────────────────────────────────────────

/**
 * Every Redis key in the repo has to be database-scoped, and a new cache must not be able
 * to reintroduce the bug quietly.
 *
 * This is the check that actually keeps the fix. Namespacing the eight existing caches is
 * a one-time act; the ninth is written by somebody who has never heard of the incident,
 * copying the shape of one of the eight. There is no type to violate and no test that
 * would otherwise fail — the cache simply works, until two databases share a Redis
 * instance and it hands out the wrong answer somewhere unrelated.
 *
 * So the rule is enforced against the source: a file that defines a Redis key prefix must
 * reference `cacheNamespace`, or be named below with a reason.
 */

/** Files that build Redis keys WITHOUT the namespace, each with the reason. */
// VeloExpense: ExpenseOS's one exemption (idleSession.ts) is not ported, so none.
const EXEMPT = new Map<string, string>([]);

/** Prefix constants that are not Redis keys at all. */
// VeloExpense: ExpenseOS's two are not ported; this one is the ported design-system file
// at VeloExpense's path, whose TITLE_KEY_PREFIX keys an in-memory Set, not Redis.
const NOT_REDIS = new Set(['components/data-view/DataTable/devWarnCards.ts']);

function repoRoot(): string {
  return resolve(process.cwd());
}

describe('every Redis key is database-scoped', () => {
  it('finds the key builders, so an empty pass cannot be a false negative', () => {
    // VeloExpense: two key builders here (rateLimit, inboundDedup), where ExpenseOS has
    // more than five.
    expect(keyBuilders().length).toBeGreaterThanOrEqual(2);
  });

  it('scopes every one of them, or names it as an exception', () => {
    /**
     * Checked at the KEY EXPRESSION, not by looking for the word anywhere in the file.
     *
     * The first version of this asserted `src.includes('cacheNamespace')`, and it passed
     * against a deliberately un-namespaced `rbac/cache.ts` — because the doc comment on
     * `key()` still said "see cacheNamespace for the incident". A guard satisfied by a
     * COMMENT is worse than no guard: it reports that the rule holds when it does not.
     *
     * So every `${KEY_PREFIX}` interpolation has to be followed by the namespace call.
     */
    const offenders: string[] = [];
    for (const rel of keyBuilders()) {
      if (EXEMPT.has(rel)) continue;
      const src = readFileSync(resolve(repoRoot(), rel), 'utf8');
      for (const unscoped of unscopedUses(src)) offenders.push(`${rel} — ${unscoped}`);
    }
    expect(
      offenders,
      'These build Redis keys with no database scope, so two databases sharing one Redis ' +
        'instance will collide — see cacheNamespace.ts. Add the namespace, or add the file ' +
        `to EXEMPT with the reason:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('keeps every exemption real, so a stale one cannot hide a regression', () => {
    // An exempted file that no longer builds a Redis key is an exemption nobody reviewed.
    const found = new Set(keyBuilders());
    const stale = [...EXEMPT.keys()].filter((f) => !found.has(f));
    expect(
      stale,
      `EXEMPT names files that no longer define a key prefix:\n${stale.join('\n')}`,
    ).toEqual([]);
  });
});

/**
 * Repo-relative paths of the files that define a Redis key prefix.
 *
 * A filesystem walk rather than `git grep`, deliberately: `git grep` only sees TRACKED
 * files, so a brand-new cache file — exactly the case this guard exists for — would pass
 * it while sitting unstaged in the working tree.
 */
function keyBuilders(): string[] {
  const root = repoRoot();
  const found: string[] = [];
  // VeloExpense: the app is the repository root, not `apps/`.
  for (const base of ['app', 'components', 'lib', 'packages', 'server', 'worker']) {
    walk(resolve(root, base), (file) => {
      if (!file.endsWith('.ts') && !file.endsWith('.tsx')) return;
      if (file.includes('.test.')) return;
      if (!readFileSync(file, 'utf8').includes('KEY_PREFIX = ')) return;
      const rel = relative(root, file);
      if (!NOT_REDIS.has(rel)) found.push(rel);
    });
  }
  return found.sort();
}

/**
 * Every use of the prefix that is not immediately scoped by the namespace call.
 *
 * Deliberately syntactic and deliberately strict: the interpolation has to be
 * `${KEY_PREFIX}${cacheNamespace()}`, with nothing between them. Allowing a gap would let
 * `${KEY_PREFIX}${resource}:${cacheNamespace()}` pass, and a namespace that comes after
 * the resource still shares the SCAN prefix with every other database — which is half of
 * the original bug.
 */
function unscopedUses(source: string): string[] {
  /**
   * Comments stripped first.
   *
   * Not fussiness: the fix in `rbac/cache.ts` is EXPLAINED by a comment that quotes the
   * old unscoped pattern, and the guard flagged its own documentation. A check that
   * punishes writing down why is a check people delete.
   */
  const src = stripComments(source);
  // These two ARE the source text being searched for, so the placeholder syntax is the
  // literal content and not a template that forgot its backticks.
  // biome-ignore lint/suspicious/noTemplateCurlyInString: the needle is source text
  const NEEDLE = '${KEY_PREFIX}';
  // biome-ignore lint/suspicious/noTemplateCurlyInString: the needle is source text
  const SCOPE = '${cacheNamespace()}';
  const out: string[] = [];
  let i = src.indexOf(NEEDLE);
  while (i !== -1) {
    if (!src.startsWith(SCOPE, i + NEEDLE.length)) {
      const line = src.slice(0, i).split('\n').length;
      out.push(`line ${line} builds a key with no database scope`);
    }
    i = src.indexOf(NEEDLE, i + 1);
  }
  return out;
}

/** Block and line comments blanked, preserving newlines so reported line numbers stay true. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length));
}

const SKIP_DIRS = new Set(['node_modules', 'dist', '.next', '.next-e2e', 'coverage', 'generated']);

function walk(dir: string, visit: (file: string) => void): void {
  let entries: { name: string; isDirectory(): boolean }[];
  try {
    entries = readdirSync(dir, { withFileTypes: true, encoding: 'utf8' });
  } catch {
    return; // a directory that does not exist is not a failure of this check
  }
  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.next-e2e') continue;
    const full = resolve(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(full, visit);
    } else {
      visit(full);
    }
  }
}
