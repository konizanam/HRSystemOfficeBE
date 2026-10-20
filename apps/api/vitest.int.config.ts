import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    include: ['test/int/**/*.test.ts'],
    environment: 'node',
    env: { NODE_ENV: 'test', JOBS_ENABLED: 'false' },
    globalSetup: ['test/support/global-setup.ts'],
    setupFiles: ['test/support/setup-env.ts'],
    // Tests share one database; run files one at a time so audit-chain assertions stay simple.
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 180_000,
  },
});
