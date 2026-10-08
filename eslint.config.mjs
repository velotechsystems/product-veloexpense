import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

/**
 * Code ported from ExpenseOS, verbatim. ExpenseOS lints with Biome, not with React Compiler's
 * rules (eslint-plugin-react-hooks 6: `refs`, `globals`, `immutability`,
 * `set-state-in-effect`), and VeloExpense does not run the React Compiler either. Those rules
 * describe what the COMPILER can optimise, not bugs, and "fixing" them would mean rewriting
 * ported components. They stay on for VeloExpense's own code. `exhaustive-deps` stays on
 * everywhere.
 */
const PORTED_FROM_EXPENSEOS = [
  "components/data-display/**",
  "components/ui/checkbox.tsx",
  "components/ui/combobox.tsx",
  "components/ui/drawer.tsx",
  "components/ui/emoji-picker.tsx",
  "hooks/useIsCompact.ts",
  "components/data-view/**",
  "components/admin/**",
  "lib/exportTable.ts",
  "lib/exportCsv.ts",
  "lib/useCoarsePointer.ts",
  "lib/useIsBelowLg.ts",
  "test-utils/**",
  // Wave 0 shell: ExpenseOS's app shell and the kit's sidebar primitives.
  "app/(app)/**",
  "components/navigation/**",
  "components/ui/alert.tsx",
  // Wave 0 expense categories: the router, the pickers and ExpenseOS's audit API.
  "server/routers/expenseCategories*.ts",
  "server/routers/pickers*.ts",
  "server/__test-helpers__/**",
  "components/pickers/**",
  "packages/audit/**",
];

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    files: PORTED_FROM_EXPENSEOS,
    // ExpenseOS's own suppressions are written for Biome; ESLint reports the few it carries
    // for ESLint as unused when its rule set differs. Not a finding in ported code.
    linterOptions: { reportUnusedDisableDirectives: "off" },
    rules: {
      // ExpenseOS's (Biome's) convention: a leading underscore marks a deliberately unused name.
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "react-hooks/refs": "off",
      "react-hooks/globals": "off",
      "react-hooks/immutability": "off",
      "react-hooks/set-state-in-effect": "off",
    },
  },
  {
    // ExpenseOS's Avatar renders a remote profile photo (Google) with a plain <img>, and the
    // kit's components must not depend on Next; see the note in the component.
    files: ["components/data-display/Avatar.tsx"],
    rules: { "@next/next/no-img-element": "off" },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // The CDK app has its own package.json, tsconfig and tests (infrastructure/cdk).
    "infrastructure/**",
  ]),
]);

export default eslintConfig;
