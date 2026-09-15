import { createDb } from '@marketplace/db'
import { buildApp } from './app.js'
import { loadConfig } from './config.js'

const config = loadConfig()
const { db, close } = createDb(config.DATABASE_URL, { max: 10 })
const app = buildApp({ db, config })

const shutdown = async () => {
  app.log.info('shutting down')
  await app.close()
  await close()
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

await app.listen({ port: config.PORT, host: '0.0.0.0' })
