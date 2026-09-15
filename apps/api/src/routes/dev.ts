import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { and, eq } from 'drizzle-orm'
import { campaigns } from '@marketplace/db'
import { notFound } from '../errors.js'

/**
 * Demo affordance so a reviewer does not have to wait out a real deadline.
 *
 * It moves a DEADLINE. It cannot close an auction, select winners, or touch a
 * bid — the worker remains the only thing that closes anything, so the loop
 * being demonstrated is the real one.
 *
 * When disabled, the route is never registered at all, so the 404 comes from
 * Fastify's router rather than from a handler that decided not to act. There is
 * no code path behind the flag for a bug to reach.
 */
export default async function devRoutes(app: FastifyInstance, opts: { enabled: boolean }) {
  if (!opts.enabled) return

  app.post('/api/dev/campaigns/:id/expire', async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    const [updated] = await app.db.update(campaigns)
      .set({ biddingDeadline: new Date() })
      .where(and(eq(campaigns.id, id), eq(campaigns.status, 'open')))
      .returning()

    if (!updated) throw notFound('CAMPAIGN_NOT_FOUND', 'No open campaign with that id')
    request.log.warn({ campaignId: id }, 'dev tool expired a campaign deadline')
    return { id: updated.id, biddingDeadline: updated.biddingDeadline.toISOString() }
  })
}
