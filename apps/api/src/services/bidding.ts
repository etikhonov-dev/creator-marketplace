import { and, desc, eq, inArray } from 'drizzle-orm'
import { bids, bidEvents, campaigns, type Creator, type Database } from '@marketplace/db'
import { checkEligibility, scoreFit } from '@marketplace/domain'
import { conflict, forbidden, notFound, unprocessable } from '../errors.js'
import {
  toBidView, toCampaignSummary, toCreatorProfile, toRequirements,
} from '../repositories/campaigns.js'
import type { BidView } from '../routes/types.js'

export async function placeBid(
  db: Database,
  input: { creator: Creator; campaignId: string; amountCents: number; pitch: string | null },
): Promise<BidView> {
  return db.transaction(async (tx) => {
    // FOR SHARE, not a plain read. This is the fix for the bid/close race
    // (spec §7.3): many bids may proceed concurrently with each other, but this
    // lock BLOCKS the closer's FOR UPDATE, so a bid can never land in the window
    // after the closer read this campaign's bids and before it committed.
    // Without it, a bid placed a millisecond before the deadline stays `pending`
    // forever on a closed auction.
    const [campaign] = await tx.select().from(campaigns)
      .where(eq(campaigns.id, input.campaignId)).limit(1).for('share')

    if (!campaign) throw notFound('CAMPAIGN_NOT_FOUND', 'Campaign not found')

    if (campaign.status !== 'open' || campaign.biddingDeadline <= new Date()) {
      throw conflict('CAMPAIGN_NOT_BIDDABLE', 'Bidding has closed for this campaign')
    }

    const profile = toCreatorProfile(input.creator)
    const requirements = toRequirements(campaign)

    const reasons = checkEligibility(profile, requirements)
    if (reasons.length > 0) {
      throw unprocessable('CREATOR_INELIGIBLE', 'You do not meet this campaign’s requirements', reasons)
    }

    // A bid above the whole budget can never win, so accepting it would be a
    // lie dressed up as a feature.
    if (input.amountCents > campaign.budgetCents) {
      throw unprocessable('BID_EXCEEDS_BUDGET', 'Your bid is larger than the campaign budget')
    }

    const fit = scoreFit(profile, requirements)
    const now = new Date()

    // Upsert on (campaign_id, creator_id): also the reinstate path for a
    // previously withdrawn bid. fit_score is re-snapshotted, because the bid
    // is a new offer and should be judged on today's numbers.
    const [existing] = await tx.select().from(bids)
      .where(and(eq(bids.campaignId, campaign.id), eq(bids.creatorId, input.creator.id)))
      .limit(1)

    // Guarded here so the client gets a stable error code rather than a CHECK
    // violation: resetting a decided bid to 'pending' would leave decided_at
    // set and trip bids_decided_at_matches_status. The constraint is the
    // backstop, this is the message.
    if (existing && (existing.status === 'won' || existing.status === 'lost')) {
      throw conflict('BID_NOT_EDITABLE', 'This bid has already been decided')
    }

    const [bid] = await tx.insert(bids).values({
      campaignId: campaign.id, creatorId: input.creator.id,
      amountCents: input.amountCents, fitScore: fit.total.toFixed(2),
      pitch: input.pitch, status: 'pending', updatedAt: now,
    }).onConflictDoUpdate({
      target: [bids.campaignId, bids.creatorId],
      set: {
        amountCents: input.amountCents, fitScore: fit.total.toFixed(2),
        pitch: input.pitch, status: 'pending', updatedAt: now,
      },
    }).returning()

    // Same transaction as the mutation. An audit log that can survive a
    // rolled-back transaction is a log that lies.
    await tx.insert(bidEvents).values({
      bidId: bid!.id,
      type: !existing ? 'placed' : existing.status === 'withdrawn' ? 'reinstated' : 'repriced',
      amountCents: input.amountCents, fitScore: fit.total.toFixed(2),
      actor: 'creator', metadata: {},
    })

    return toBidView(bid!, toCampaignSummary(campaign, now))
  })
}

export async function withdrawBid(
  db: Database, { creator, bidId }: { creator: Creator; bidId: string },
): Promise<BidView> {
  return db.transaction(async (tx) => {
    const [bid] = await tx.select().from(bids).where(eq(bids.id, bidId)).limit(1).for('update')
    if (!bid) throw notFound('BID_NOT_FOUND', 'Bid not found')
    if (bid.creatorId !== creator.id) {
      // Not security today (there is no auth), but the ownership check belongs
      // in the service so that adding auth later does not require finding
      // every mutation and remembering to guard it.
      throw forbidden('NOT_BID_OWNER', 'Not your bid')
    }
    if (bid.status !== 'pending') throw conflict('BID_NOT_EDITABLE', 'This bid can no longer be changed')

    const now = new Date()
    const [updated] = await tx.update(bids)
      .set({ status: 'withdrawn', updatedAt: now }).where(eq(bids.id, bidId)).returning()

    await tx.insert(bidEvents).values({
      bidId, type: 'withdrawn', amountCents: bid.amountCents,
      fitScore: bid.fitScore, actor: 'creator', metadata: {},
    })

    const [campaign] = await tx.select().from(campaigns).where(eq(campaigns.id, bid.campaignId)).limit(1)
    return toBidView(updated!, toCampaignSummary(campaign!, now))
  })
}

/**
 * A creator's bids, newest first, each carrying the loss reason the closer
 * recorded. The reason lives in bid_events rather than on the bid row because
 * it is a fact about a decision, not current state — and joining it here keeps
 * the read model simple without denormalising.
 */
export async function listMyBids(db: Database, creator: Creator): Promise<BidView[]> {
  const rows = await db.select({ bid: bids, campaign: campaigns })
    .from(bids)
    .innerJoin(campaigns, eq(campaigns.id, bids.campaignId))
    .where(eq(bids.creatorId, creator.id))
    .orderBy(desc(bids.createdAt), desc(bids.id))

  if (rows.length === 0) return []

  const lostIds = rows.filter((r) => r.bid.status === 'lost').map((r) => r.bid.id)
  const reasons = new Map<string, BidView['lossReason']>()
  if (lostIds.length > 0) {
    const events = await db.select().from(bidEvents)
      .where(and(inArray(bidEvents.bidId, lostIds), eq(bidEvents.type, 'lost')))
    for (const e of events) {
      const reason = (e.metadata as { reason?: string }).reason
      if (reason) reasons.set(e.bidId, reason as BidView['lossReason'])
    }
  }

  const now = new Date()
  return rows.map((r) =>
    toBidView(r.bid, toCampaignSummary(r.campaign, now), reasons.get(r.bid.id) ?? null))
}
