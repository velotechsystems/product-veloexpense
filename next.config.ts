import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

// Wave 0: ExpenseOS's next-intl, for ported screens. i18n/request.ts says how VeloExpense
// chooses the language (a stored preference, not a URL segment).
const withNextIntl = createNextIntlPlugin("./i18n/request.ts");

// @velotech/* libs ship TypeScript source (main = src/index.ts), so Next must
// transpile them rather than expecting pre-built JS.
const nextConfig: NextConfig = {
  output: "standalone", // slim runtime image (Docker runner copies .next/standalone)
  transpilePackages: ["@velotech/auth-kit", "@velotech/ui"],

  // VX4-9. `forbidden()` and `app/forbidden.tsx` — how a page refuses with a 403
  // instead of throwing into Next's error boundary and answering 500.
  //
  // STILL EXPERIMENTAL in Next 16.3.2, and that is a real dependency rather than
  // a formality, so here is the reasoning. The alternative was a refusal
  // component rendered with a 200, which fixes the visible half (a person reads a
  // sentence instead of "Application error") and not the operator's half — the
  // ticket's second complaint is that monitoring cannot tell a permission denial
  // from a fault, and only a status code answers that.
  //
  // The risk is bounded, and it was MEASURED rather than assumed — the first
  // draft of this comment claimed the flag going away would "fail at build",
  // and the sabotage run for this ticket disproved it. With the flag off,
  // `npm run build` SUCCEEDS and `forbidden()` throws at request time
  // ("`forbidden()` is experimental and only allowed to be enabled when
  // `experimental.authInterrupts` is enabled"), which is a 500 — the exact bug
  // this ticket closed, quietly restored.
  //
  // So the guard against that is not the build, it is `e2e/crawl.spec.ts`: it
  // asserts a 403 on every admin page for a MANAGER and an EMPLOYEE, and with
  // this flag flipped it goes red on all thirty. `next` is pinned exactly in
  // package.json, so the flag cannot disappear without somebody editing that
  // line and running the suite.
  experimental: { authInterrupts: true },
};

export default withNextIntl(nextConfig);
