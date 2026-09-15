import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { bidEvents, bids } from '@marketplace/db'
import { connect, truncateAll, makeCreator, makeCampaign } from '@marketplace/db/test-support'
import { placeBid, withdrawBid, listMyBids } from './bidding.js'
import { AppError } from '../errors.js'

let ctx: ReturnType<typeof connect>
beforeAll(() => { ctx = connect() })
afterAll(async () => { await ctx.close() })
beforeEach(async () => { await truncateAll(ctx.db) })

/**
 * Asserts the stable error code rather than the message, like the UI does —
 * and asserts the class too, because the error handler branches on
 * `instanceof AppError` to decide between a 4xx and a leak-nothing 500.
 */
async function expectCode(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toSatisfy(
    (e: unknown) => e instanceof AppError && e.code === code,
    `expected AppError with code ${code}`,
  )
}

const biddable = () => makeCampaign(ctx.db, { biddingDeadline: new Date(Date.now() + 600_000) })

describe('placeBid', () => {
  it('snapshots the fit score and records a placed event', async () => {
    const creator = await makeCreator(ctx.db, {
      genre: 'fitness', followerCount: 120_000, engagementRate: '0.0600',
    })
    const campaign = await biddable()

    const bid = await placeBid(ctx.db, {
      creator, campaignId: campaign.id, amountCents: 120_000, pitch: 'hello',
    })

    expect(bid.status).toBe('pending')
    expect(bid.fitScoreAtBidTime).toBeGreaterThan(0)
    const [row] = await ctx.db.select().from(bids).where(eq(bids.id, bid.id))
    // The stored snapshot must equal what the API returned, or the UI and the
    // auction disagree about the same bid.
    expect(Number(row!.fitScore)).toBe(bid.fitScoreAtBidTime)
    const events = await ctx.db.select().from(bidEvents).where(eq(bidEvents.bidId, bid.id))
    expect(events.map((e) => e.type)).toEqual(['placed'])
    expect(events[0]!.actor).toBe('creator')
  })

  it('refuses a creator below a hard gate, naming the gates they missed', async () => {
    const creator = await makeCreator(ctx.db, { followerCount: 500, engagementRate: '0.0010' })
    const campaign = await biddable()

    await expect(placeBid(ctx.db, {
      creator, campaignId: campaign.id, amountCents: 10_000, pitch: null,
    })).rejects.toSatisfy((e: unknown) =>
      e instanceof AppError && e.code === 'CREATOR_INELIGIBLE'
      && Array.isArray(e.details) && e.details.length === 2)

    expect(await ctx.db.select().from(bids)).toHaveLength(0)
  })

  it('refuses a bid larger than the whole budget, which could never win', async () => {
    const creator = await makeCreator(ctx.db)
    const campaign = await makeCampaign(ctx.db, {
      budgetCents: 100_000, biddingDeadline: new Date(Date.now() + 600_000),
    })
    await expectCode(placeBid(ctx.db, {
      creator, campaignId: campaign.id, amountCents: 100_001, pitch: null,
    }), 'BID_EXCEEDS_BUDGET')
  })

  it('refuses a bid once the deadline has passed', async () => {
    const creator = await makeCreator(ctx.db)
    // makeCampaign's default deadline is in the past.
    const campaign = await makeCampaign(ctx.db)
    await expectCode(placeBid(ctx.db, {
      creator, campaignId: campaign.id, amountCents: 50_000, pitch: null,
    }), 'CAMPAIGN_NOT_BIDDABLE')
  })

  it('404s an unknown campaign', async () => {
    const creator = await makeCreator(ctx.db)
    await expectCode(placeBid(ctx.db, {
      creator, campaignId: '11111111-1111-4111-8111-111111111111',
      amountCents: 50_000, pitch: null,
    }), 'CAMPAIGN_NOT_FOUND')
  })

  it('reprices in place rather than creating a second bid', async () => {
    const creator = await makeCreator(ctx.db)
    const campaign = await biddable()

    const first = await placeBid(ctx.db, {
      creator, campaignId: campaign.id, amountCents: 100_000, pitch: 'v1',
    })
    const second = await placeBid(ctx.db, {
      creator, campaignId: campaign.id, amountCents: 80_000, pitch: 'v2',
    })

    // Same row: the unique index on (campaign_id, creator_id) is what makes
    // "one bid per creator per campaign" a fact rather than a convention.
    expect(second.id).toBe(first.id)
    expect(second.amountCents).toBe(80_000)
    expect(second.pitch).toBe('v2')
    expect(await ctx.db.select().from(bids)).toHaveLength(1)

    const events = await ctx.db.select().from(bidEvents).where(eq(bidEvents.bidId, first.id))
    expect(events.map((e) => e.type)).toEqual(['placed', 'repriced'])
  })

  it('records a reinstatement when a withdrawn bid is placed again', async () => {
    const creator = await makeCreator(ctx.db)
    const campaign = await biddable()

    const bid = await placeBid(ctx.db, {
      creator, campaignId: campaign.id, amountCents: 100_000, pitch: null,
    })
    await withdrawBid(ctx.db, { creator, bidId: bid.id })
    const again = await placeBid(ctx.db, {
      creator, campaignId: campaign.id, amountCents: 90_000, pitch: null,
    })

    expect(again.status).toBe('pending')
    const events = await ctx.db.select().from(bidEvents).where(eq(bidEvents.bidId, bid.id))
    expect(events.map((e) => e.type)).toEqual(['placed', 'withdrawn', 'reinstated'])
  })

  it('refuses to reprice a bid the closer has already decided', async () => {
    const creator = await makeCreator(ctx.db)
    const campaign = await biddable()
    const bid = await placeBid(ctx.db, {
      creator, campaignId: campaign.id, amountCents: 100_000, pitch: null,
    })
    await ctx.db.update(bids)
      .set({ status: 'won', decidedAt: new Date() }).where(eq(bids.id, bid.id))

    await expectCode(placeBid(ctx.db, {
      creator, campaignId: campaign.id, amountCents: 50_000, pitch: null,
    }), 'BID_NOT_EDITABLE')
  })
})

describe('withdrawBid', () => {
  it('withdraws a pending bid and leaves an audit event', async () => {
    const creator = await makeCreator(ctx.db)
    const campaign = await biddable()
    const bid = await placeBid(ctx.db, {
      creator, campaignId: campaign.id, amountCents: 100_000, pitch: null,
    })

    const withdrawn = await withdrawBid(ctx.db, { creator, bidId: bid.id })

    expect(withdrawn.status).toBe('withdrawn')
    // A withdrawn bid is not a decided bid: decided_at stays null, which is
    // what bids_decided_at_matches_status enforces.
    expect(withdrawn.decidedAt).toBeNull()
  })

  it('refuses to withdraw somebody else’s bid', async () => {
    const owner = await makeCreator(ctx.db)
    const stranger = await makeCreator(ctx.db)
    const campaign = await biddable()
    const bid = await placeBid(ctx.db, {
      creator: owner, campaignId: campaign.id, amountCents: 100_000, pitch: null,
    })

    await expectCode(withdrawBid(ctx.db, { creator: stranger, bidId: bid.id }), 'NOT_BID_OWNER')

    const [row] = await ctx.db.select().from(bids).where(eq(bids.id, bid.id))
    expect(row!.status).toBe('pending')
  })

  it('refuses to withdraw a decided bid', async () => {
    const creator = await makeCreator(ctx.db)
    const campaign = await biddable()
    const bid = await placeBid(ctx.db, {
      creator, campaignId: campaign.id, amountCents: 100_000, pitch: null,
    })
    await ctx.db.update(bids)
      .set({ status: 'lost', decidedAt: new Date() }).where(eq(bids.id, bid.id))

    await expectCode(withdrawBid(ctx.db, { creator, bidId: bid.id }), 'BID_NOT_EDITABLE')
  })

  it('404s an unknown bid', async () => {
    const creator = await makeCreator(ctx.db)
    await expectCode(
      withdrawBid(ctx.db, { creator, bidId: '11111111-1111-4111-8111-111111111111' }),
      'BID_NOT_FOUND',
    )
  })
})

describe('listMyBids', () => {
  it('returns only the calling creator’s bids, newest first', async () => {
    const mine = await makeCreator(ctx.db)
    const theirs = await makeCreator(ctx.db)
    const a = await makeCampaign(ctx.db, { biddingDeadline: new Date(Date.now() + 600_000) })
    const b = await makeCampaign(ctx.db, { biddingDeadline: new Date(Date.now() + 700_000) })

    await placeBid(ctx.db, { creator: mine, campaignId: a.id, amountCents: 10_000, pitch: null })
    await placeBid(ctx.db, { creator: mine, campaignId: b.id, amountCents: 20_000, pitch: null })
    await placeBid(ctx.db, { creator: theirs, campaignId: a.id, amountCents: 30_000, pitch: null })

    const rows = await listMyBids(ctx.db, mine)
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.campaignId)).toEqual([b.id, a.id])
    // Each bid carries its campaign, so the list view needs no second request.
    expect(rows[0]!.campaign.title).toBe('Test Campaign')
  })

  it('surfaces the loss reason the closer recorded', async () => {
    const creator = await makeCreator(ctx.db)
    const campaign = await biddable()
    const bid = await placeBid(ctx.db, {
      creator, campaignId: campaign.id, amountCents: 10_000, pitch: null,
    })
    await ctx.db.update(bids)
      .set({ status: 'lost', decidedAt: new Date() }).where(eq(bids.id, bid.id))
    await ctx.db.insert(bidEvents).values({
      bidId: bid.id, type: 'lost', amountCents: 10_000, fitScore: '80.00',
      actor: 'closer', metadata: { reason: 'outranked' },
    })

    const [row] = await listMyBids(ctx.db, creator)
    expect(row!.lossReason).toBe('outranked')
  })

  it('returns an empty array rather than throwing for a creator with no bids', async () => {
    const creator = await makeCreator(ctx.db)
    expect(await listMyBids(ctx.db, creator)).toEqual([])
  })
})
