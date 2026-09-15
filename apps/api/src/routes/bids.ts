import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { listMyBids, withdrawBid } from '../services/bidding.js'

export default async function bidRoutes(app: FastifyInstance) {
  app.get('/api/bids', async (request) => listMyBids(app.db, request.creator))

  app.post('/api/bids/:id/withdraw', async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    return withdrawBid(app.db, { creator: request.creator, bidId: id })
  })
}
