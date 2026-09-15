import Fastify from 'fastify'
import { randomUUID } from 'node:crypto'
import type { Database } from '@marketplace/db'
import type { ApiConfig } from './config.js'
import { AppError } from './errors.js'
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

  /**
   * Two routes take no body at all: `POST /api/bids/:id/withdraw` and the dev
   * expire endpoint. Fastify answers 415 when a client sends `Content-Length: 0`
   * with no `Content-Type` — standards-defensible, and unhelpful, since a
   * bodyless POST is exactly what those routes want. Browser `fetch()` sends
   * neither header so it never hit this, but plenty of HTTP clients do send
   * `Content-Length: 0`.
   *
   * Scoped deliberately: an unknown content type with an actual body is still
   * rejected, and `application/json` keeps Fastify's own parser so a malformed
   * body still produces FST_ERR_CTP_INVALID_JSON_BODY rather than a generic 500.
   */
  app.addContentTypeParser('*', { parseAs: 'string' }, (request, body, done) => {
    if (body === '') return done(null, undefined)
    done(new AppError(
      'VALIDATION_FAILED', 415,
      `Unsupported content type: ${request.headers['content-type'] ?? 'none'}`,
    ))
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
