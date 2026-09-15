import { sql } from 'drizzle-orm'
import { scoreFit } from '@marketplace/domain'
import { createDb } from './client.js'
import { bidEvents, bids, campaigns, creators } from './schema.js'
import { BID_FIXTURES, CAMPAIGN_FIXTURES, CREATOR_FIXTURES } from './fixtures.js'

const url = process.env.DATABASE_URL
if (!url) throw new Error('DATABASE_URL is required')
const reset = process.argv.includes('--reset')

const { db, close } = createDb(url, { max: 1 })
const now = Date.now()

if (reset) {
  await db.execute(
    sql`TRUNCATE bid_events, campaign_closings, bids, closing_runs, campaigns, creators CASCADE`,
  )
  console.log('truncated')
}

await db.insert(creators).values(CREATOR_FIXTURES.map((c) => ({
  id: c.id, handle: c.handle, displayName: c.displayName, genre: c.genre,
  followerCount: c.followerCount, engagementRate: c.engagementRate,
  statsUpdatedAt: new Date(now - c.statsAgeHours * 3_600_000),
}))).onConflictDoNothing()

await db.insert(campaigns).values(CAMPAIGN_FIXTURES.map((c) => ({
  id: c.id, brandName: c.brandName, title: c.title, brief: c.brief,
  targetGenre: c.targetGenre, minFollowers: c.minFollowers,
  minEngagementRate: c.minEngagementRate, budgetCents: c.budgetCents,
  biddingDeadline: new Date(now + c.deadlineOffsetMinutes * 60_000),
}))).onConflictDoNothing()

// fit_score is snapshotted here using the same domain function the API uses, so
// seeded bids are indistinguishable from bids placed through the UI.
const creatorById = new Map(CREATOR_FIXTURES.map((c) => [c.id, c]))
const campaignById = new Map(CAMPAIGN_FIXTURES.map((c) => [c.id, c]))

const bidRows = BID_FIXTURES.map((b) => {
  const creator = creatorById.get(b.creatorId)!
  const campaign = campaignById.get(b.campaignId)!
  const fit = scoreFit(
    {
      genre: creator.genre, followerCount: creator.followerCount,
      engagementRate: Number(creator.engagementRate),
    },
    {
      targetGenre: campaign.targetGenre, minFollowers: campaign.minFollowers,
      minEngagementRate: Number(campaign.minEngagementRate),
    },
  )
  return {
    campaignId: b.campaignId, creatorId: b.creatorId,
    amountCents: b.amountCents, fitScore: fit.total.toFixed(2), pitch: b.pitch,
  }
})

const inserted = await db.insert(bids).values(bidRows).onConflictDoNothing().returning()

if (inserted.length > 0) {
  await db.insert(bidEvents).values(inserted.map((b) => ({
    bidId: b.id, type: 'placed' as const, amountCents: b.amountCents,
    fitScore: b.fitScore, actor: 'creator', metadata: { source: 'seed' },
  })))
}

await close()
console.log(
  `seeded ${CREATOR_FIXTURES.length} creators, ${CAMPAIGN_FIXTURES.length} campaigns, ` +
  `${inserted.length} bids (all pending)`,
)
console.log('run `pnpm --filter @marketplace/worker start:once` to settle expired auctions')
