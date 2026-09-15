import type { Bid, Campaign, Creator } from '@marketplace/db'
import type { BidView, CampaignSummary, CreatorView } from '../routes/types.js'

/**
 * Three presentation phases from two stored states. The middle one is not
 * cosmetic: it is the real window between a deadline and the worker's next
 * tick, and without it the app looks broken for ~15 seconds.
 */
export function campaignPhase(campaign: Campaign, now = new Date()): CampaignSummary['phase'] {
  if (campaign.status === 'closed') return 'settled'
  return campaign.biddingDeadline > now ? 'biddable' : 'awaiting_results'
}

export const toCampaignSummary = (c: Campaign, now = new Date()): CampaignSummary => ({
  id: c.id, brandName: c.brandName, title: c.title, brief: c.brief,
  targetGenre: c.targetGenre, minFollowers: c.minFollowers,
  minEngagementRate: Number(c.minEngagementRate), budgetCents: c.budgetCents,
  biddingDeadline: c.biddingDeadline.toISOString(), phase: campaignPhase(c, now),
})

export const toBidView = (
  b: Bid, campaign: CampaignSummary, lossReason: BidView['lossReason'] = null,
): BidView => ({
  id: b.id, campaignId: b.campaignId, amountCents: b.amountCents,
  fitScoreAtBidTime: Number(b.fitScore), pitch: b.pitch, status: b.status,
  createdAt: b.createdAt.toISOString(),
  decidedAt: b.decidedAt?.toISOString() ?? null,
  lossReason, campaign,
})

export const toCreatorView = (c: Creator): CreatorView => ({
  id: c.id, handle: c.handle, displayName: c.displayName, genre: c.genre,
  followerCount: c.followerCount, engagementRate: Number(c.engagementRate),
  statsUpdatedAt: c.statsUpdatedAt.toISOString(),
})

/**
 * The shape the domain package needs from a creator row. Converting
 * engagementRate from the driver's string to a number happens exactly here, so
 * no NUMERIC-as-string leaks into a business rule.
 */
export const toCreatorProfile = (c: Creator) => ({
  genre: c.genre,
  followerCount: c.followerCount,
  engagementRate: Number(c.engagementRate),
})

export const toRequirements = (c: Campaign) => ({
  targetGenre: c.targetGenre,
  minFollowers: c.minFollowers,
  minEngagementRate: Number(c.minEngagementRate),
})
