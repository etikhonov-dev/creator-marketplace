import type { FastifyInstance } from 'fastify'
import { asc } from 'drizzle-orm'
import { creators } from '@marketplace/db'
import { toCreatorView } from '../repositories/campaigns.js'

export default async function creatorRoutes(app: FastifyInstance) {
  // The only identity-free route: it is the creator picker, so it cannot
  // require the identity it exists to establish.
  app.get('/api/creators', async () => {
    const rows = await app.db.select().from(creators).orderBy(asc(creators.handle))
    return rows.map(toCreatorView)
  })
}
