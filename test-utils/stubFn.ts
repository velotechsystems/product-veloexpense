import { vi } from 'vitest';

/**
 * `vi.fn()` for a stubbed method whose CALL ARGUMENTS the test reads.
 *
 * `vi.fn(async () => rows)` infers its generic from the implementation it was given,
 * so `Parameters<T>` is the empty tuple and `mock.calls[0]` is a type error — even
 * though every call carried a real argument at runtime. The stub has to admit that it
 * takes some.
 *
 * That matters here more than it would in most codebases: in a router suite the
 * `where` clause a procedure sent IS the thing under test. "Only active rows" and
 * "scoped to this user" are assertions about the query, not about the return value,
 * and a stub that cannot be asked what it was called with cannot express them.
 *
 * Safe to use inside a `vi.mock` factory — those run when the mocked module is first
 * imported, by which point this module is evaluated. NOT safe inside `vi.hoisted`,
 * which runs before any import; use a bare `vi.fn` there.
 */
export function stubFn<R>(impl: (...args: never[]) => R) {
  // biome-ignore lint/suspicious/noExplicitAny: a readable call log is the whole point — with `unknown[]`, every read of an argument is an error
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- same reason (VeloExpense lints with ESLint)
  return vi.fn<(...args: any[]) => R>(impl as (...args: any[]) => R);
}
