/**
 * VX4-1 — THE GATE COVERAGE GUARD. Generated from the registry, not hand-written.
 *
 * ── Why this test is the load-bearing half of VX4-1 ────────────────────────
 *
 * `requireModule` is called at the top of each gated service function. That is a
 * gate somebody eventually forgets — which is precisely GAP-AUDIT MT-3, where
 * ExpenseOS ends up with 10 of 40 routers gated and a page gated while the data
 * behind it is not. The fix is not diligence; it is a guard that enumerates.
 *
 * Same relationship the RLS-coverage guard has with the RLS policies, and the same
 * one `test/tenant-fk.db.test.ts` has with the composite foreign keys: the
 * mechanism is in the code, and a generated assertion proves there are no gaps.
 * Three of this project's defects were found by exactly this pattern.
 *
 * ── Why a vitest and not a `scripts/check-*.mjs` ───────────────────────────
 *
 * The other guards read the DATABASE, so a CI step can run them with `psql`
 * before the suite starts. This one reads TypeScript — the registry's own arrays —
 * and re-implementing that parse in a `.mjs` would be a second, weaker copy of the
 * thing being checked.
 *
 * The cost is honest and worth stating: `npm test` is CI step twelve, after the
 * build, the typecheck and the lint, so this guard does NOT fail fast the way the
 * RLS and FK guards do. (An earlier draft of this comment claimed it ran first.
 * It does not — checked against `.github/workflows/ci.yml`.) The trade is a slower
 * red build against a guard that reads the same source the gate lives in.
 *
 * The body scan is deliberately crude (from the export to the next top-level
 * `export`). It cannot be fooled in the direction that matters: a function whose
 * text does not contain `requireModule(tx, '<code>')` fails, and a false PASS
 * would need somebody to write that call and not mean it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { listModules } from '@/lib/modules/registry';

/** Every `export`ed function name in a source file, in order. */
function exportedFunctions(source: string): string[] {
  return [...source.matchAll(/^export (?:async )?function (\w+)/gm)].map((m) => m[1]);
}

/** The text of one exported function: from its `export` to the next top-level one. */
function functionBody(source: string, name: string): string {
  const start = source.search(new RegExp(`^export (?:async )?function ${name}\\b`, 'm'));
  if (start < 0) return '';
  const rest = source.slice(start + 1);
  const next = rest.search(/^export /m);
  return next < 0 ? rest : rest.slice(0, next);
}

const files = new Map<string, string>();
function sourceOf(path: string): string {
  if (!files.has(path)) files.set(path, readFileSync(path, 'utf8'));
  return files.get(path)!;
}

function parse(entry: string): { path: string; name: string } {
  const [path, name] = entry.split('#');
  return { path, name };
}

describe('module gate coverage', () => {
  const modules = listModules();

  it('the registry is not empty, and the accounting module gates something', () => {
    // The self-guard every generated assertion in this repo carries: a broken
    // parse or an emptied array must FAIL rather than vacuously pass. VX3-10's FK
    // gate has the same floor, for the same reason.
    expect(modules.length).toBeGreaterThan(4);
    const accounting = modules.find((m) => m.code === 'accounting');
    expect(accounting).toBeDefined();
    expect(accounting!.gates.length).toBeGreaterThan(10);
  });

  it('every gated export exists and actually calls requireModule with its own code', () => {
    const missing: string[] = [];
    for (const definition of modules) {
      for (const entry of definition.gates) {
        const { path, name } = parse(entry);
        const body = functionBody(sourceOf(path), name);
        if (body === '') {
          missing.push(`${entry} — no such export`);
          continue;
        }
        if (!body.includes(`requireModule(tx, '${definition.code}')`)) {
          missing.push(`${entry} — no requireModule(tx, '${definition.code}') in its body`);
        }
      }
    }
    expect(missing, `gated exports without a gate:\n${missing.join('\n')}`).toEqual([]);
  });

  it('NO EXPORT IN A GATED FILE IS UNACCOUNTED FOR', () => {
    // The half that catches the future: somebody adds an export to a gated
    // service file and forgets the gate. It fails here, with the two ways to fix
    // it named — gate it, or write down why it does not need gating.
    const unaccounted: string[] = [];
    for (const definition of modules) {
      const paths = new Set(
        [...definition.gates, ...Object.keys(definition.ungated)].map((e) => parse(e).path),
      );
      for (const path of paths) {
        for (const name of exportedFunctions(sourceOf(path))) {
          const entry = `${path}#${name}`;
          if (definition.gates.includes(entry)) continue;
          if (entry in definition.ungated) continue;
          unaccounted.push(entry);
        }
      }
    }
    expect(
      unaccounted,
      `these exports live in a gated file and are neither gated nor exempted.\n` +
        `Add requireModule(tx, '<code>') and list it in the module's \`gates\`, or ` +
        `list it in \`ungated\` with the reason:\n${unaccounted.join('\n')}`,
    ).toEqual([]);
  });

  it('every exemption carries a reason, and names a real export', () => {
    // An exemption with an empty reason is a bypass with paperwork.
    for (const definition of modules) {
      for (const [entry, reason] of Object.entries(definition.ungated)) {
        const { path, name } = parse(entry);
        expect(reason.trim().length, `${entry} has no reason`).toBeGreaterThan(10);
        expect(
          exportedFunctions(sourceOf(path)),
          `${entry} is exempted but does not exist`,
        ).toContain(name);
      }
    }
  });

  it('an unavailable module gates nothing, so a dormant declaration cannot refuse anything', () => {
    // The dormant-QuickBooks property: declaring a module this build cannot serve
    // must be inert. A `gates` entry on an unavailable module would refuse calls
    // for a module nobody can enable — unreachable code that fails closed.
    for (const definition of modules.filter((m) => !m.available)) {
      expect(definition.gates, `${definition.code} is unavailable but gates something`).toEqual([]);
    }
  });
});
