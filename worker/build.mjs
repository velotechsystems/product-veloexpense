/**
 * Worker bundle — compiles worker/ + the @expenseos/* workspace TS source
 * into a single dist/main.mjs so the runtime image can run `node dist/main.mjs`
 * instead of `tsx` (no dev toolchain, no source trees shipped).
 *
 * Ported from ExpenseOS's apps/worker/build.mjs (550b2945).
 *
 * VeloExpense: third-party packages are BUNDLED too, except the NATIVE ones listed below.
 * ExpenseOS keeps every third-party package external and ships the worker its own image
 * with a pruned production node_modules. VeloExpense runs ONE image for web, database,
 * tick and worker (Dockerfile), and that image's node_modules is the web app's traced
 * standalone set, which is not the worker's. Bundling removes the dependence on what
 * Next.js happened to trace; a native package cannot be bundled, so each one named here
 * is copied into the image by the Dockerfile and resolved at runtime.
 */
import { build } from 'esbuild';

/** Packages with a native binary — resolved from the image's node_modules at runtime. */
export const NATIVE_EXTERNALS = ['sharp'];

const keepNativeExternal = {
  name: 'keep-native-external',
  setup(b) {
    b.onResolve({ filter: /.*/ }, (args) => {
      if (args.kind === 'entry-point') return undefined;
      const p = args.path;
      // Node builtins stay external (`platform: 'node'` already does this for bare names;
      // the `node:` prefix is said out loud here so nothing tries to bundle it).
      if (p.startsWith('node:')) return { path: p, external: true };
      if (NATIVE_EXTERNALS.some((n) => p === n || p.startsWith(`${n}/`))) {
        return { path: p, external: true };
      }
      // Everything else — relative imports, the @expenseos/* workspace packages, the
      // app's own `@/` modules (resolved through tsconfig.json `paths`) and third-party
      // packages — is bundled.
      return undefined;
    });
  },
};

const here = new URL('.', import.meta.url).pathname;

await build({
  absWorkingDir: here,
  entryPoints: ['src/main.ts'],
  // VeloExpense: .mjs — the repo root is not `"type": "module"` (ExpenseOS's apps/worker
  // package.json is), and Node would otherwise reparse the bundle with a warning per start.
  outfile: 'dist/main.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  // VeloExpense: the Node major this repo pins (Dockerfile node:24-alpine); ExpenseOS's is 25.
  target: 'node24',
  // VeloExpense: the repo-root tsconfig, so `@expenseos/*` and `@/` resolve as they do for
  // the web app (ExpenseOS's workspace packages resolve through node_modules instead).
  tsconfig: `${here}../tsconfig.json`,
  sourcemap: true,
  logLevel: 'info',
  plugins: [keepNativeExternal],
  // ESM output that bundles CJS-interop code may reference require(); provide it.
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
});
