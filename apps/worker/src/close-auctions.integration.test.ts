import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { bids, campaigns, campaignClosings, closingRuns, bidEvents } from '@marketplace/db'
import { closeExpiredAuctions } from './close-auctions.js'
import { connect, truncateAll, makeCreator, makeCampaign, makeBid } from '@marketplace/db/test-support'

let ctx: ReturnType<typeof connect>

beforeAll(() => { ctx = connect() })
afterAll(async () => { await ctx.close() })
beforeEach(async () => { await truncateAll(ctx.db) })

/** Full state fingerprint, for asserting a re-run changes nothing. */
async function snapshot(db = ctx.db) {
  const [b, c, cl] = await Promise.all([
    db.select({ id: bids.id, status: bids.status, decidedAt: bids.decidedAt })
      .from(bids).orderBy(bids.id),
    db.select({ id: campaigns.id, status: campaigns.status }).from(campaigns).orderBy(campaigns.id),
    db.select().from(campaignClosings).orderBy(campaignClosings.campaignId),
  ])
  return { bids: b, campaigns: c, closings: cl }
}

describe('closeExpiredAuctions', () => {
  it('leaves a campaign whose deadline has not passed untouched', async () => {
    const creator = await makeCreator(ctx.db)
    const campaign = await makeCampaign(ctx.db, { biddingDeadline: new Date(Date.now() + 3_600_000) })
    await makeBid(ctx.db, campaign.id, creator.id)

    const summary = await closeExpiredAuctions(ctx.db, {})

    expect(summary.campaignsClosed).toBe(0)
    const [row] = await ctx.db.select().from(campaigns).where(eq(campaigns.id, campaign.id))
    expect(row!.status).toBe('open')
    const [b] = await ctx.db.select().from(bids)
    expect(b!.status).toBe('pending')
  })

  it('closes an expired campaign and awards winners within budget', async () => {
    const campaign = await makeCampaign(ctx.db, { budgetCents: 300_000 })
    const c1 = await makeCreator(ctx.db)
    const c2 = await makeCreator(ctx.db)
    const c3 = await makeCreator(ctx.db)
    await makeBid(ctx.db, campaign.id, c1.id, { amountCents: 100_000, fitScore: '90.00' })
    await makeBid(ctx.db, campaign.id, c2.id, { amountCents: 150_000, fitScore: '85.00' })
    await makeBid(ctx.db, campaign.id, c3.id, { amountCents: 200_000, fitScore: '50.00' })

    const summary = await closeExpiredAuctions(ctx.db, {})

    expect(summary.campaignsClosed).toBe(1)
    expect(summary.bidsDecided).toBe(3)
    expect(summary.totalAwardedCents).toBeLessThanOrEqual(300_000)

    const [closed] = await ctx.db.select().from(campaigns).where(eq(campaigns.id, campaign.id))
    expect(closed!.status).toBe('closed')

    const [closing] = await ctx.db.select().from(campaignClosings)
    expect(closing!.bidCount).toBe(3)
    expect(closing!.totalAwardedCents).toBe(summary.totalAwardedCents)
    expect(closing!.runId).toBe(summary.runId)

    const all = await ctx.db.select().from(bids)
    expect(all.every((b) => b.status === 'won' || b.status === 'lost')).toBe(true)
    expect(all.every((b) => b.decidedAt !== null)).toBe(true)
    const awarded = all.filter((b) => b.status === 'won').reduce((s, b) => s + b.amountCents, 0)
    expect(awarded).toBe(summary.totalAwardedCents)
  })

  // ── THE requirement from the brief ─────────────────────────────────────────
  it('is idempotent: a second run changes nothing', async () => {
    const campaign = await makeCampaign(ctx.db, { budgetCents: 250_000 })
    for (let i = 0; i < 5; i++) {
      const c = await makeCreator(ctx.db)
      await makeBid(ctx.db, campaign.id, c.id, {
        amountCents: 60_000 + i * 10_000, fitScore: String(50 + i * 10) + '.00',
      })
    }

    const first = await closeExpiredAuctions(ctx.db, {})
    const afterFirst = await snapshot()

    const second = await closeExpiredAuctions(ctx.db, {})
    const afterSecond = await snapshot()

    expect(second.campaignsClosed).toBe(0)
    expect(second.totalAwardedCents).toBe(0)
    expect(afterSecond).toEqual(afterFirst)

    // Exactly one closing row, and no duplicate won/lost events.
    const closings = await ctx.db.select().from(campaignClosings)
    expect(closings).toHaveLength(1)
    const decisionEvents = await ctx.db.select().from(bidEvents)
      .where(sql`${bidEvents.type} IN ('won','lost')`)
    expect(decisionEvents).toHaveLength(5)
    expect(first.campaignsClosed).toBe(1)
  })

  it('is safe under two workers running concurrently', async () => {
    const campaign = await makeCampaign(ctx.db, { budgetCents: 200_000 })
    for (let i = 0; i < 6; i++) {
      const c = await makeCreator(ctx.db)
      await makeBid(ctx.db, campaign.id, c.id, { amountCents: 50_000, fitScore: String(60 + i) + '.00' })
    }

    // Separate connection pools, so these genuinely contend in Postgres.
    const other = connect()
    try {
      const [a, b] = await Promise.all([
        closeExpiredAuctions(ctx.db, {}),
        closeExpiredAuctions(other.db, {}),
      ])
      // Exactly one of them did the work; the other found nothing (SKIP LOCKED).
      expect(a.campaignsClosed + b.campaignsClosed).toBe(1)
    } finally {
      await other.close()
    }

    const closings = await ctx.db.select().from(campaignClosings)
    expect(closings).toHaveLength(1)
    expect(closings[0]!.totalAwardedCents).toBeLessThanOrEqual(200_000)

    const awarded = (await ctx.db.select().from(bids))
      .filter((b) => b.status === 'won')
      .reduce((s, b) => s + b.amountCents, 0)
    expect(awarded).toBeLessThanOrEqual(200_000)
  })

  it('closes a campaign with zero bids, recording an empty result', async () => {
    const campaign = await makeCampaign(ctx.db)
    const summary = await closeExpiredAuctions(ctx.db, {})

    expect(summary.campaignsClosed).toBe(1)
    expect(summary.bidsDecided).toBe(0)
    const [closing] = await ctx.db.select().from(campaignClosings)
    expect(closing!.bidCount).toBe(0)
    expect(closing!.winningBidCount).toBe(0)
    expect(closing!.totalAwardedCents).toBe(0)
    const [c] = await ctx.db.select().from(campaigns).where(eq(campaigns.id, campaign.id))
    expect(c!.status).toBe('closed')
  })

  it('ignores withdrawn bids', async () => {
    const campaign = await makeCampaign(ctx.db, { budgetCents: 500_000 })
    const c1 = await makeCreator(ctx.db)
    const c2 = await makeCreator(ctx.db)
    const active = await makeBid(ctx.db, campaign.id, c1.id, { amountCents: 100_000, fitScore: '90.00' })
    const gone = await makeBid(ctx.db, campaign.id, c2.id, { amountCents: 50_000, fitScore: '95.00' })
    await ctx.db.update(bids).set({ status: 'withdrawn' }).where(eq(bids.id, gone.id))

    const summary = await closeExpiredAuctions(ctx.db, {})

    expect(summary.bidsDecided).toBe(1)
    const [stillWithdrawn] = await ctx.db.select().from(bids).where(eq(bids.id, gone.id))
    expect(stillWithdrawn!.status).toBe('withdrawn')
    expect(stillWithdrawn!.decidedAt).toBeNull()
    const [won] = await ctx.db.select().from(bids).where(eq(bids.id, active.id))
    expect(won!.status).toBe('won')
  })

  it('records a run with a finish time and matching totals', async () => {
    await makeCampaign(ctx.db)
    const summary = await closeExpiredAuctions(ctx.db, {})

    const [run] = await ctx.db.select().from(closingRuns).where(eq(closingRuns.id, summary.runId))
    expect(run!.finishedAt).not.toBeNull()
    expect(run!.campaignsClosed).toBe(summary.campaignsClosed)
    expect(run!.totalAwardedCents).toBe(summary.totalAwardedCents)
    expect(run!.error).toBeNull()
  })

  it('writes a loss reason on every losing bid, attributed to the run', async () => {
    const campaign = await makeCampaign(ctx.db, { budgetCents: 100_000 })
    const c1 = await makeCreator(ctx.db)
    const c2 = await makeCreator(ctx.db)
    await makeBid(ctx.db, campaign.id, c1.id, { amountCents: 100_000, fitScore: '95.00' })
    const loser = await makeBid(ctx.db, campaign.id, c2.id, { amountCents: 90_000, fitScore: '45.00' })

    const summary = await closeExpiredAuctions(ctx.db, {})

    const events = await ctx.db.select().from(bidEvents).where(eq(bidEvents.bidId, loser.id))
    const lost = events.find((e) => e.type === 'lost')!
    expect(lost.actor).toBe('closer')
    expect(lost.runId).toBe(summary.runId)
    expect(typeof (lost.metadata as { reason?: string }).reason).toBe('string')
  })

  it('honours maxCampaigns so one run cannot monopolise the worker', async () => {
    for (let i = 0; i < 4; i++) await makeCampaign(ctx.db)
    const summary = await closeExpiredAuctions(ctx.db, { maxCampaigns: 2 })
    expect(summary.campaignsClosed).toBe(2)

    const remaining = await ctx.db.select().from(campaigns).where(eq(campaigns.status, 'open'))
    expect(remaining).toHaveLength(2)
  })

  it('closes campaigns in deadline order, oldest first', async () => {
    const newer = await makeCampaign(ctx.db, { biddingDeadline: new Date(Date.now() - 10_000) })
    const older = await makeCampaign(ctx.db, { biddingDeadline: new Date(Date.now() - 600_000) })
    await closeExpiredAuctions(ctx.db, { maxCampaigns: 1 })

    const [o] = await ctx.db.select().from(campaigns).where(eq(campaigns.id, older.id))
    const [n] = await ctx.db.select().from(campaigns).where(eq(campaigns.id, newer.id))
    expect(o!.status).toBe('closed')
    expect(n!.status).toBe('open')
  })
})

describe('the completeness assertion (L6)', () => {
  it('refuses to close a campaign while any pending bid is left undecided', async () => {
    const campaign = await makeCampaign(ctx.db, { budgetCents: 500_000 })
    const c1 = await makeCreator(ctx.db)
    await makeBid(ctx.db, campaign.id, c1.id, { amountCents: 100_000, fitScore: '90.00' })

    // A selection that silently drops a bid. Without L6 this closes the
    // campaign and strands the bid as `pending` forever: the campaign is no
    // longer claimable, so nothing will ever decide it.
    const dropsEverything = () => ({ outcomes: [], winningBidIds: [], totalAwardedCents: 0 })

    await expect(
      closeExpiredAuctions(ctx.db, { selectWinners: dropsEverything }),
    ).rejects.toThrow(/did not decide every bid/)

    // Rolled back: still open, still pending, no closing row.
    const [row] = await ctx.db.select().from(campaigns).where(eq(campaigns.id, campaign.id))
    expect(row!.status).toBe('open')
    const [bid] = await ctx.db.select().from(bids)
    expect(bid!.status).toBe('pending')
    expect(await ctx.db.select().from(campaignClosings)).toHaveLength(0)
  })
})
