import { defineWorkspace } from 'vitest/config'

export default defineWorkspace([
  {
    // Pure, fast, no external dependencies. Runs on every save.
    test: {
      name: 'unit',
      include: ['packages/**/*.test.ts', 'apps/api/**/*.test.ts'],
      exclude: ['**/*.integration.test.ts', '**/node_modules/**'],
    },
  },
  {
    // Needs a real Postgres. Serial: these tests contend on locks by design.
    test: {
      name: 'integration',
      include: ['apps/**/*.integration.test.ts', 'packages/**/*.integration.test.ts'],
      exclude: ['**/node_modules/**'],
      fileParallelism: false,
      testTimeout: 30_000,
    },
  },
])
