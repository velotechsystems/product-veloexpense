import { defineConfig } from 'vitest/config';

// Standalone config, so the app's root vitest.config.ts (test/**) never picks these up.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // A synth is seconds, not milliseconds, and the FIRST one in a file also pays for
    // loading aws-cdk-lib: on a cold CI runner `DeployRoleStack (dev) > creates no OIDC
    // provider` took 6.2s and failed vitest's 5s default on PR #264, a change that touched no
    // infrastructure. The ceiling is for a slow machine, not a slow test.
    testTimeout: 30_000,
  },
});
