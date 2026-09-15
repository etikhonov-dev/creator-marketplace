import { createDb } from '@marketplace/db'
import { loadConfig } from './config.js'
import { createLogger } from './logger.js'
import { closeExpiredAuctions } from './close-auctions.js'

const mode = process.argv.includes('--loop') ? 'loop' : 'once'
const config = loadConfig()
const logger = createLogger(config.LOG_LEVEL)
const { db, close } = createDb(config.DATABASE_URL, { max: 4 })

const runOnce = () =>
  closeExpiredAuctions(db, { maxCampaigns: config.MAX_CAMPAIGNS_PER_RUN, logger })

if (mode === 'once') {
  // Exactly a Kubernetes CronJob entrypoint: one pass, then exit with a
  // meaningful status code. Safe to run repeatedly by construction.
  try {
    await runOnce()
    await close()
    process.exit(0)
  } catch {
    await close()
    process.exit(1)
  }
} else {
  logger.info({ intervalMs: config.CLOSE_INTERVAL_MS }, 'worker started in loop mode')
  let stopping = false
  const stop = async () => {
    if (stopping) return
    stopping = true
    logger.info('shutting down')
    await close()
    process.exit(0)
  }
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)

  while (!stopping) {
    // A failed pass must not kill the loop: the next tick retries, and
    // idempotency means a partial failure costs nothing.
    await runOnce().catch((err) => logger.error({ err }, 'pass failed, continuing'))
    await new Promise((r) => setTimeout(r, config.CLOSE_INTERVAL_MS))
  }
}
