import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
    environment: 'node',
    // Integration tests each open their own SQLite file. Running files in parallel is
    // fine; running tests within a file in parallel is not, since several share a handle.
    fileParallelism: true,
    testTimeout: 20_000,
  },
});
