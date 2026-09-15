import {
  pgTable, pgEnum, uuid, text, varchar, integer, bigint, numeric,
  timestamp, jsonb, bigserial, index, uniqueIndex, check,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import type { Genre } from '@marketplace/domain'

/**
 * The genre list is restated here rather than imported as a value, because
 * drizzle-kit bundles this file as CJS and cannot resolve the domain package's
 * ESM `.js` specifiers. A type-only import survives that bundling (it is
 * erased), a value import does not.
 *
 * The duplication cannot drift: GENRE_VALUES must be *exactly* the Genre union,
 * and the assertion below is a compile error if a genre is added to or removed
 * from either side. `satisfies` alone would only prove every value is a Genre,
 * not that every Genre is present — hence the bidirectional check.
 */
const GENRE_VALUES = [
  'beauty', 'fashion', 'fitness', 'gaming', 'music', 'food', 'tech', 'travel',
] as const satisfies readonly Genre[]

type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never
const _genreListIsExhaustive: MutuallyAssignable<Genre, (typeof GENRE_VALUES)[number]> = true
void _genreListIsExhaustive

export const genreEnum          = pgEnum('genre', GENRE_VALUES)
export const campaignStatusEnum = pgEnum('campaign_status', ['open', 'closed'])
export const bidStatusEnum      = pgEnum('bid_status', ['pending', 'won', 'lost', 'withdrawn'])
export const bidEventTypeEnum   = pgEnum('bid_event_type',
  ['placed', 'repriced', 'withdrawn', 'reinstated', 'won', 'lost'])

export const creators = pgTable('creators', {
  id:             uuid('id').primaryKey().defaultRandom(),
  handle:         varchar('handle', { length: 64 }).notNull().unique(),
  displayName:    text('display_name').notNull(),
  genre:          genreEnum('genre').notNull(),
  followerCount:  integer('follower_count').notNull(),
  // numeric comes back as a string from the driver; parsed at the repository edge.
  engagementRate: numeric('engagement_rate', { precision: 5, scale: 4 }).notNull(),
  // Stats are a projection of an external scraper pipeline, not facts we own.
  statsUpdatedAt: timestamp('stats_updated_at', { withTimezone: true }).notNull().defaultNow(),
  createdAt:      timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  check('creators_followers_non_negative', sql`${t.followerCount} >= 0`),
  check('creators_engagement_in_range', sql`${t.engagementRate} BETWEEN 0 AND 1`),
])

export const campaigns = pgTable('campaigns', {
  id:                uuid('id').primaryKey().defaultRandom(),
  brandName:         text('brand_name').notNull(),
  title:             text('title').notNull(),
  brief:             text('brief').notNull(),
  targetGenre:       genreEnum('target_genre').notNull(),
  minFollowers:      integer('min_followers').notNull().default(0),
  minEngagementRate: numeric('min_engagement_rate', { precision: 5, scale: 4 }).notNull().default('0'),
  budgetCents:       bigint('budget_cents', { mode: 'number' }).notNull(),
  biddingDeadline:   timestamp('bidding_deadline', { withTimezone: true }).notNull(),
  status:            campaignStatusEnum('status').notNull().default('open'),
  createdAt:         timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  check('campaigns_budget_positive', sql`${t.budgetCents} > 0`),
  check('campaigns_min_followers_non_negative', sql`${t.minFollowers} >= 0`),
  check('campaigns_min_engagement_in_range', sql`${t.minEngagementRate} BETWEEN 0 AND 1`),
  // The closer's hot path. Partial, so it only indexes campaigns awaiting closure
  // and stays small as the table grows without bound.
  index('campaigns_open_by_deadline_idx')
    .on(t.biddingDeadline)
    .where(sql`${t.status} = 'open'`),
])

// One row per pass of the closing worker: the durable join key between a decided
// bid and the run that decided it.
export const closingRuns = pgTable('closing_runs', {
  id:                uuid('id').primaryKey().defaultRandom(),
  startedAt:         timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  finishedAt:        timestamp('finished_at', { withTimezone: true }),
  campaignsClosed:   integer('campaigns_closed').notNull().default(0),
  bidsDecided:       integer('bids_decided').notNull().default(0),
  totalAwardedCents: bigint('total_awarded_cents', { mode: 'number' }).notNull().default(0),
  error:             text('error'),
}, (t) => [
  // finished_at IS NULL with an old started_at is a crashed worker. Partial index
  // makes that a cheap query, so it can back a real alert.
  index('closing_runs_unfinished_idx').on(t.startedAt).where(sql`${t.finishedAt} IS NULL`),
])

export const bids = pgTable('bids', {
  id:          uuid('id').primaryKey().defaultRandom(),
  campaignId:  uuid('campaign_id').notNull().references(() => campaigns.id, { onDelete: 'cascade' }),
  creatorId:   uuid('creator_id').notNull().references(() => creators.id, { onDelete: 'cascade' }),
  amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
  fitScore:    numeric('fit_score', { precision: 5, scale: 2 }).notNull(),
  pitch:       text('pitch'),
  status:      bidStatusEnum('status').notNull().default('pending'),
  createdAt:   timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt:   timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  decidedAt:   timestamp('decided_at', { withTimezone: true }),
}, (t) => [
  uniqueIndex('bids_one_per_creator_per_campaign').on(t.campaignId, t.creatorId),
  index('bids_by_creator_idx').on(t.creatorId, t.createdAt.desc()),
  check('bids_amount_positive', sql`${t.amountCents} > 0`),
  check('bids_fit_score_in_range', sql`${t.fitScore} BETWEEN 0 AND 100`),
  // Makes "a won bid with no decision timestamp" unrepresentable.
  check('bids_decided_at_matches_status',
    sql`(${t.status} IN ('won','lost')) = (${t.decidedAt} IS NOT NULL)`),
])

export const campaignClosings = pgTable('campaign_closings', {
  // PRIMARY KEY, not just FK: a second attempt to close the same campaign dies on
  // a unique violation even if every line of the locking logic is wrong.
  campaignId:        uuid('campaign_id').primaryKey()
                       .references(() => campaigns.id, { onDelete: 'restrict' }),
  runId:             uuid('run_id').notNull().references(() => closingRuns.id),
  closedAt:          timestamp('closed_at', { withTimezone: true }).notNull().defaultNow(),
  bidCount:          integer('bid_count').notNull(),
  winningBidCount:   integer('winning_bid_count').notNull(),
  totalAwardedCents: bigint('total_awarded_cents', { mode: 'number' }).notNull(),
}, (t) => [
  check('closings_counts_non_negative',
    sql`${t.bidCount} >= 0 AND ${t.winningBidCount} >= 0 AND ${t.totalAwardedCents} >= 0`),
  check('closings_winners_within_bids', sql`${t.winningBidCount} <= ${t.bidCount}`),
])

export const bidEvents = pgTable('bid_events', {
  // BIGSERIAL: monotonic ordering, append-only index inserts, natural cursor.
  id:          bigserial('id', { mode: 'number' }).primaryKey(),
  bidId:       uuid('bid_id').notNull().references(() => bids.id, { onDelete: 'cascade' }),
  type:        bidEventTypeEnum('type').notNull(),
  amountCents: bigint('amount_cents', { mode: 'number' }),
  fitScore:    numeric('fit_score', { precision: 5, scale: 2 }),
  // Provenance, not identity: with no auth we record which component acted.
  actor:       text('actor').notNull(),
  runId:       uuid('run_id').references(() => closingRuns.id),
  metadata:    jsonb('metadata').notNull().default({}),
  createdAt:   timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('bid_events_by_bid_idx').on(t.bidId, t.id),
])

export type Creator    = typeof creators.$inferSelect
export type Campaign   = typeof campaigns.$inferSelect
export type Bid        = typeof bids.$inferSelect
export type NewBid     = typeof bids.$inferInsert
export type ClosingRun = typeof closingRuns.$inferSelect
