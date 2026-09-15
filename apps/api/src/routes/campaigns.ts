import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { listMatchedCampaigns } from '../services/matching.js'
import { placeBid } from '../services/bidding.js'

const placeBidBody = z.object({
  amountCents: z.number().int().positive().max(100_000_000),
  pitch: z.string().max(500).nullable().default(null),
})

export default async function campaignRoutes(app: FastifyInstance) {
  app.get('/api/campaigns', async (request) =>
    listMatchedCampaigns(app.db, request.creator))

  // Repricing goes through this same route, not a PATCH: placeBid upserts on
  // (campaign_id, creator_id), so there is one code path and one set of
  // validations for "this is my price".
  app.post('/api/campaigns/:id/bids', async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    const body = placeBidBody.parse(request.body)
    const bid = await placeBid(app.db, {
      creator: request.creator, campaignId: id,
      amountCents: body.amountCents, pitch: body.pitch,
    })
    return reply.status(201).send(bid)
  })
}
