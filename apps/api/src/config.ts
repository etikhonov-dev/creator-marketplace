import { z } from 'zod'

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  // Defaults false so the flag fails in the safe direction. Only compose sets it.
  ENABLE_DEV_TOOLS: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
})

export type ApiConfig = z.infer<typeof schema>

/**
 * Formats every issue, not just the first. Duplicated from the worker's config
 * rather than shared: a four-line formatter is not worth coupling two
 * independently deployable services through a common package.
 *
 * (`z.prettifyError` would do this, but it is a Zod 4 API and this project is
 * on Zod 3, where it is undefined at runtime.)
 */
const formatIssues = (error: z.ZodError): string =>
  error.issues.map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n')

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const parsed = schema.safeParse(env)
  if (!parsed.success) throw new Error(`invalid API configuration:\n${formatIssues(parsed.error)}`)
  return parsed.data
}
