#!/usr/bin/env node
/**
 * Wave 0 — the Prisma path stays tenant-scoped (decided 7 Oct).
 *
 * Ported ExpenseOS code reaches the database ONLY through `db` / `withTenantDb`
 * in lib/db/prisma.ts, which runs every query inside a transaction scoped to one
 * organization and throws when used unscoped. Two things would get around that,
 * and both fail CI here:
 *
 *   1. A second PrismaClient. `new PrismaClient(` anywhere but lib/db/prisma.ts
 *      is an unscoped client with full access to whatever RLS would otherwise
 *      have filtered — for `veloapp`, every row its own transaction scope allows,
 *      which with no scope is none, but a client is one `set_config` away from a
 *      cross-tenant read nobody reviewed.
 *   2. Unsafe raw SQL. `$queryRawUnsafe` / `$executeRawUnsafe` take a string, so
 *      an interpolated value is an injection; the tagged `$queryRaw` is safe.
 *
 * Tests are exempt (they construct fixtures deliberately); scripts/ is scanned.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOTS = ['app', 'lib', 'components', 'scripts'];
const HOME = 'lib/db/prisma.ts';
const SELF = 'scripts/check-prisma-scope.mjs';

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const p = join(dir, name);
    // Prisma's own generated client DEFINES the unsafe methods; it is regenerated,
    // never edited, and CI checks the committed copy matches the schema.
    if (p === join('lib', 'generated')) continue;
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|mjs|js)$/.test(p)) out.push(p);
  }
  return out;
}

const problems = [];
let scanned = 0;
for (const root of ROOTS) {
  for (const file of walk(root)) {
    if (file === SELF) continue;
    scanned++;
    const lines = readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach((line, i) => {
      if (/^\s*(\/\/|\*)/.test(line)) return;
      if (/new\s+PrismaClient\s*\(/.test(line) && file !== HOME) {
        problems.push(`${file}:${i + 1}  constructs a PrismaClient — use \`db\` / \`withTenantDb\` from ${HOME}`);
      }
      if (/\$(query|execute)RawUnsafe\b/.test(line)) {
        problems.push(`${file}:${i + 1}  uses an Unsafe raw query — use the tagged \`$queryRaw\` / \`$executeRaw\``);
      }
    });
  }
}

if (problems.length) {
  console.error('check-prisma-scope FAILED:\n');
  for (const p of problems) console.error(`  · ${p}`);
  process.exit(1);
}
console.log(`check-prisma-scope OK — ${scanned} files; one PrismaClient (${HOME}), no unsafe raw SQL.`);
