/**
 * Test factories for this schema. They live in the db package because the db
 * package owns the schema: the alternative had apps/api importing apps/worker's
 * test folder, which couples two independently deployable services through
 * their tests.
 */
import { createDb } from '../client.js'
import { campaigns, creators, bids } from '../schema.js'
import type { Database } from '../client.js'
import { sql } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'

const url = process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL
if (!url) throw new Error('DATABASE_URL_TEST or DATABASE_URL is required')
export const testDbUrl = url

export async function truncateAll(db: Database) {
  // bid_events and campaign_closings cascade from bids/campaigns; closing_runs
  // is referenced by campaign_closings so it must be listed explicitly.
  await db.execute(
    sql`TRUNCATE bid_events, campaign_closings, bids, closing_runs, campaigns, creators CASCADE`,
  )
}

export async function makeCreator(db: Database, o: Partial<{
  genre: 'fitness' | 'food' | 'beauty' | 'gaming'; followerCount: number; engagementRate: string
}> = {}) {
  const [row] = await db.insert(creators).values({
    handle: `c-${randomUUID().slice(0, 8)}`,
    displayName: 'Test Creator',
    genre: o.genre ?? 'fitness',
    followerCount: o.followerCount ?? 100_000,
    engagementRate: o.engagementRate ?? '0.0400',
  }).returning()
  return row!
}

export async function makeCampaign(db: Database, o: Partial<{
  budgetCents: number; biddingDeadline: Date; status: 'open' | 'closed'
}> = {}) {
  const [row] = await db.insert(campaigns).values({
    brandName: 'Test Brand',
    title: 'Test Campaign',
    brief: 'Test brief',
    targetGenre: 'fitness',
    minFollowers: 10_000,
    minEngagementRate: '0.0200',
    budgetCents: o.budgetCents ?? 500_000,
    // Default is in the past so the campaign is immediately claimable.
    biddingDeadline: o.biddingDeadline ?? new Date(Date.now() - 60_000),
    status: o.status ?? 'open',
  }).returning()
  return row!
}

export async function makeBid(db: Database, campaignId: string, creatorId: string, o: Partial<{
  amountCents: number; fitScore: string; createdAt: Date
}> = {}) {
  const [row] = await db.insert(bids).values({
    campaignId, creatorId,
    amountCents: o.amountCents ?? 100_000,
    fitScore: o.fitScore ?? '80.00',
    ...(o.createdAt ? { createdAt: o.createdAt } : {}),
  }).returning()
  return row!
}

export const connect = () => createDb(testDbUrl, { max: 4 })
