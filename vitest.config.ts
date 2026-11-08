import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const src = fileURLToPath(new URL('./src/', import.meta.url));

export default defineConfig({
  // README examples import the package by name; point that at the sources.
  resolve: {
    alias: [
      { find: /^@afkzona\/rationale$/, replacement: `${src}index.ts` },
      { find: /^@afkzona\/rationale\/(.+)$/, replacement: `${src}$1/index.ts` },
    ],
  },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    pool: 'forks',
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts', 'src/node/index.ts', 'src/connectors/index.ts', 'src/cli/bin.ts', 'src/generated/**'],
      reporter: ['text', 'html'],
      thresholds: { lines: 90, functions: 90, statements: 90, branches: 85 },
    },
  },
});
