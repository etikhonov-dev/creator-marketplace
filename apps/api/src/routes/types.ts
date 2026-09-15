import type { FitScore, IneligibilityReason } from '@marketplace/domain'

export type CampaignSummary = {
  id: string
  brandName: string
  title: string
  brief: string
  targetGenre: string
  minFollowers: number
  minEngagementRate: number
  budgetCents: number
  biddingDeadline: string          // ISO
  /** Derived, never stored — see spec §4.1. */
  phase: 'biddable' | 'awaiting_results' | 'settled'
}

export type MatchedCampaign = CampaignSummary & {
  fit: FitScore
  /** The creator's own bid on this campaign, if any. */
  myBid: BidView | null
}

export type IneligibleCampaign = CampaignSummary & {
  reasons: IneligibilityReason[]
}

export type CreatorView = {
  id: string
  handle: string
  displayName: string
  genre: string
  followerCount: number
  engagementRate: number
  /** Provenance: these stats come from a scraper pipeline, not from us. */
  statsUpdatedAt: string
}

export type MatchedCampaignsResponse = {
  matched: MatchedCampaign[]       // ranked, fit desc
  ineligible: IneligibleCampaign[]
  creator: CreatorView
}

export type BidView = {
  id: string
  campaignId: string
  amountCents: number
  fitScoreAtBidTime: number
  pitch: string | null
  status: 'pending' | 'won' | 'lost' | 'withdrawn'
  createdAt: string
  decidedAt: string | null
  /** Populated for lost bids by the closer. */
  lossReason: 'below_quality_bar' | 'outranked' | 'did_not_fit_remaining_budget' | null
  campaign: CampaignSummary
}
