import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'packages/*/src/**/*.test.ts',
      'packages/*/test/**/*.test.ts',
      // The web app's server-side state machines — the client is layout, but
      // setup/store/view are logic and test like any package.
      'apps/web/server/**/*.test.ts',
    ],
    // Runs before every test file. Keeps the suite out of the real journal —
    // see vitest.setup.ts for what it was doing to the corpus.
    setupFiles: ['./vitest.setup.ts'],
    // The articulation property suite (§13.1) and long-run stability (§13.6) are
    // slow by construction. Keep the default budget tight enough that the suite
    // runs on every PR — see docs/plan/04-risks-and-decisions.md.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
