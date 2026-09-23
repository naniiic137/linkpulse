import { defineConfig } from 'vitest/config';

/**
 * Same test suite, real backends: every app-level test and the store contract
 * run against PostgreSQL + Redis (CI service containers). Files run serially
 * because they share one database and one Redis.
 */
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    setupFiles: ['test/helpers/setup.ts'],
    testTimeout: 30_000,
    fileParallelism: false,
    env: { LP_TEST_BACKEND: 'real' },
  },
});
