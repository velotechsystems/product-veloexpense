/**
 * `jest-axe` ships no type declarations and there is no `@types/jest-axe`. The runtime
 * side is already wired — `tests/setup.ts` extends `expect` with `toHaveNoViolations` —
 * but that file is not type-checked, so the first test under `src/` to import `axe` hit
 * TS7016. This declares the two things a test uses, and merges the matcher into the
 * global `jest.Matchers` that `@vitest/expect`'s `Assertion` extends.
 */
declare module 'jest-axe' {
  import type { AxeResults, RunOptions, Spec } from 'axe-core';

  export type JestAxeConfigureOptions = RunOptions & { globalOptions?: Spec };
  /** Runs axe-core against a mounted element (or an HTML string it mounts for you), with
   *  the colour-contrast rules disabled because jsdom cannot compute them. */
  export function axe(html: Element | string, options?: RunOptions): Promise<AxeResults>;
  export function configureAxe(options?: JestAxeConfigureOptions): typeof axe;
  export const toHaveNoViolations: {
    toHaveNoViolations(results: AxeResults): { pass: boolean; message(): string };
  };
}

declare namespace jest {
  // Type parameters must match `@vitest/expect`'s declaration exactly or the interfaces
  // refuse to merge.
  // biome-ignore lint/complexity/noBannedTypes: mirrors @vitest/expect's `Matchers<R, T = {}>`
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type, @typescript-eslint/no-unused-vars -- same reason (VeloExpense lints with ESLint)
  interface Matchers<R, T = {}> {
    toHaveNoViolations(): R;
  }
}
