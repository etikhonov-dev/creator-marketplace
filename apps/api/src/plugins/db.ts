import fp from 'fastify-plugin'
import type { Database } from '@marketplace/db'

declare module 'fastify' {
  interface FastifyInstance { db: Database }
}

export default fp<{ db: Database }>(async (app, opts) => {
  app.decorate('db', opts.db)
})
