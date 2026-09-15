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
    // Needs a real Postgres. These tests contend on locks by design, and one
    // file TRUNCATEs shared tables, so the files must not overlap.
    //
    // `fileParallelism` is deliberately NOT set here: Vitest honours it only at
    // the root of a workspace and silently ignores it inside a project config.
    // Serialisation comes from `--no-file-parallelism` on the `test:integration`
    // script instead. Removing that flag makes this suite pass or fail on test
    // ordering — verified: the schema file's PK-violation assertion turns into a
    // foreign-key error when the worker file truncates underneath it.
    test: {
      name: 'integration',
      include: ['apps/**/*.integration.test.ts', 'packages/**/*.integration.test.ts'],
      exclude: ['**/node_modules/**'],
      testTimeout: 30_000,
    },
  },
])
