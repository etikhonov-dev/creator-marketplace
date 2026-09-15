import { asc, eq } from 'drizzle-orm'
import { campaigns, bids, type Creator, type Database } from '@marketplace/db'
import { checkEligibility, scoreFit } from '@marketplace/domain'
import type { MatchedCampaignsResponse } from '../routes/types.js'
import {
  toCampaignSummary, toBidView, toCreatorView, toCreatorProfile, toRequirements,
} from '../repositories/campaigns.js'

/**
 * Ranks every campaign for one creator.
 *
 * Deliberately scored in application code rather than SQL: at this scale the
 * whole campaign set is a few dozen rows, and keeping the rule in the domain
 * package means it is unit-testable and shared. Spec §15 documents the
 * migration path to a set-based query, and the trigger for taking it.
 */
export async function listMatchedCampaigns(
  db: Database,
  creator: Creator,
): Promise<MatchedCampaignsResponse> {
  const profile = toCreatorProfile(creator)

  const [allCampaigns, myBids] = await Promise.all([
    db.select().from(campaigns).orderBy(asc(campaigns.biddingDeadline), asc(campaigns.id)),
    db.select().from(bids).where(eq(bids.creatorId, creator.id)),
  ])
  const bidByCampaign = new Map(myBids.map((b) => [b.campaignId, b]))

  // One clock for the whole response. Reading `new Date()` per campaign would
  // let two campaigns with the same deadline land in different phases.
  const now = new Date()

  const matched: MatchedCampaignsResponse['matched'] = []
  const ineligible: MatchedCampaignsResponse['ineligible'] = []

  for (const campaign of allCampaigns) {
    const requirements = toRequirements(campaign)
    const summary = toCampaignSummary(campaign, now)
    const reasons = checkEligibility(profile, requirements)

    if (reasons.length > 0) {
      // Shown, not hidden — spec §5.5. A creator should learn what to grow toward.
      ineligible.push({ ...summary, reasons })
      continue
    }

    const bid = bidByCampaign.get(campaign.id)
    matched.push({
      ...summary,
      fit: scoreFit(profile, requirements),
      myBid: bid ? toBidView(bid, summary) : null,
    })
  }

  // Ties broken by id so the feed order is stable across refreshes — a list
  // that reshuffles on every poll feels broken.
  matched.sort((a, b) => b.fit.total - a.fit.total || (a.id < b.id ? -1 : 1))

  return { matched, ineligible, creator: toCreatorView(creator) }
}
