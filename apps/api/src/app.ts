import Fastify from 'fastify'
import { randomUUID } from 'node:crypto'
import type { Database } from '@marketplace/db'
import type { ApiConfig } from './config.js'
import dbPlugin from './plugins/db.js'
import errorHandler from './plugins/error-handler.js'
import creatorContext from './plugins/creator-context.js'
import healthRoutes from './routes/health.js'
import creatorRoutes from './routes/creators.js'
import campaignRoutes from './routes/campaigns.js'
import bidRoutes from './routes/bids.js'
import devRoutes from './routes/dev.js'

export function buildApp({ db, config }: { db: Database; config: ApiConfig }) {
  const app = Fastify({
    logger: { level: config.LOG_LEVEL, base: { service: 'api' } },
    // Honour an inbound correlation id so a browser request, this span and a
    // downstream call share one identifier; generate one otherwise.
    genReqId: (req) => (req.headers['x-request-id'] as string) ?? randomUUID(),
  })

  app.addHook('onSend', async (request, reply) => {
    reply.header('x-request-id', request.id)
  })

  app.register(dbPlugin, { db })
  app.register(errorHandler)
  app.register(creatorContext)
  app.register(healthRoutes)
  app.register(creatorRoutes)
  app.register(campaignRoutes)
  app.register(bidRoutes)
  app.register(devRoutes, { enabled: config.ENABLE_DEV_TOOLS })

  return app
}
