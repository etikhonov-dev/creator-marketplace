import type { FastifyInstance } from 'fastify'
import { sql } from 'drizzle-orm'

export default async function healthRoutes(app: FastifyInstance) {
  // Readiness, not liveness: it checks the dependency the process cannot work
  // without, so k8s stops routing traffic here when Postgres is unreachable.
  app.get('/api/health', async (_req, reply) => {
    try {
      await app.db.execute(sql`SELECT 1`)
      return { status: 'ok', database: 'ok' }
    } catch {
      return reply.status(503).send({ status: 'degraded', database: 'unreachable' })
    }
  })
}
