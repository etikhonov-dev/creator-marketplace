import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createDb } from './client.js'
import { creators, campaigns, bids, closingRuns, campaignClosings } from './schema.js'
import { randomUUID } from 'node:crypto'

const url = process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL
if (!url) throw new Error('DATABASE_URL_TEST or DATABASE_URL is required')

let ctx: ReturnType<typeof createDb>

beforeAll(() => { ctx = createDb(url, { max: 2 }) })
afterAll(async () => { await ctx.close() })

// These tests assert the database refuses bad data. They are the proof that the
// invariants survive a bug in application code.
describe('schema constraints', () => {
  it('rejects a negative follower count', async () => {
    await expect(ctx.db.insert(creators).values({
      handle: `h-${randomUUID()}`, displayName: 'x', genre: 'music',
      followerCount: -1, engagementRate: '0.05',
    })).rejects.toThrow(/creators_followers_non_negative/)
  })

  it('rejects an engagement rate above 1', async () => {
    await expect(ctx.db.insert(creators).values({
      handle: `h-${randomUUID()}`, displayName: 'x', genre: 'music',
      followerCount: 100, engagementRate: '1.5',
    })).rejects.toThrow(/creators_engagement_in_range/)
  })

  it('rejects a non-positive budget', async () => {
    await expect(ctx.db.insert(campaigns).values({
      brandName: 'b', title: 't', brief: 'b', targetGenre: 'music',
      budgetCents: 0, biddingDeadline: new Date(),
    })).rejects.toThrow(/campaigns_budget_positive/)
  })

  it('rejects a won bid with no decided_at', async () => {
    const [creator] = await ctx.db.insert(creators).values({
      handle: `h-${randomUUID()}`, displayName: 'x', genre: 'music',
      followerCount: 100, engagementRate: '0.05',
    }).returning()
    const [campaign] = await ctx.db.insert(campaigns).values({
      brandName: 'b', title: 't', brief: 'b', targetGenre: 'music',
      budgetCents: 100_000, biddingDeadline: new Date(),
    }).returning()

    await expect(ctx.db.insert(bids).values({
      campaignId: campaign!.id, creatorId: creator!.id,
      amountCents: 1000, fitScore: '80.00', status: 'won', decidedAt: null,
    })).rejects.toThrow(/bids_decided_at_matches_status/)
  })

  it('refuses a second closing row for the same campaign', async () => {
    const [run] = await ctx.db.insert(closingRuns).values({}).returning()
    const [campaign] = await ctx.db.insert(campaigns).values({
      brandName: 'b', title: 't', brief: 'b', targetGenre: 'music',
      budgetCents: 100_000, biddingDeadline: new Date(),
    }).returning()

    const row = {
      campaignId: campaign!.id, runId: run!.id,
      bidCount: 0, winningBidCount: 0, totalAwardedCents: 0,
    }
    await ctx.db.insert(campaignClosings).values(row)
    // The structural backstop from spec §7.2 L4.
    await expect(ctx.db.insert(campaignClosings).values(row))
      .rejects.toThrow(/campaign_closings_pkey/)
  })
})
