import { z } from 'zod'

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  CLOSE_INTERVAL_MS: z.coerce.number().int().positive().default(15_000),
  MAX_CAMPAIGNS_PER_RUN: z.coerce.number().int().positive().default(50),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
})

export type WorkerConfig = z.infer<typeof schema>

/**
 * Formats every issue, not just the first. `z.prettifyError` is a Zod 4 API and
 * this project is on Zod 3, where the issue list has to be walked by hand.
 */
const formatIssues = (error: z.ZodError): string =>
  error.issues
    .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('\n')

/** Fails fast at boot with every problem listed, not one at a time. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const parsed = schema.safeParse(env)
  if (!parsed.success) {
    throw new Error(`invalid worker configuration:\n${formatIssues(parsed.error)}`)
  }
  return parsed.data
}
