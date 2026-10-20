import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    include: ['test/unit/**/*.test.ts', 'src/**/*.test.ts'],
    environment: 'node',
    env: { NODE_ENV: 'test' },
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: [
        'src/main.ts',
        'src/cli/**',
        'src/**/*.module.ts',
        'src/**/*.controller.ts',
        'src/app.factory.ts',
      ],
    },
  },
});
