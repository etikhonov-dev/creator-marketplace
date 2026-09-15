import { and, asc, eq, lte } from 'drizzle-orm'
import {
  bids, bidEvents, campaigns, campaignClosings, closingRuns, type Database,
} from '@marketplace/db'
import { selectWinners, type BidCandidate } from '@marketplace/domain'
import pino from 'pino'
import type { Logger } from './logger.js'

export type CloseOptions = {
  /** Injected so tests can control the cutoff. Defaults to wall clock. */
  now?: Date
  maxCampaigns?: number
  logger?: Logger
}

export type RunSummary = {
  runId: string
  campaignsClosed: number
  bidsDecided: number
  totalAwardedCents: number
}

/**
 * Closes every campaign whose bidding deadline has passed, selecting winners
 * within budget. Safe to run concurrently with itself and safe to re-run.
 *
 * Correctness rests on five layers (spec §7.2), not on this function being
 * called carefully:
 *   L1  claim with FOR UPDATE SKIP LOCKED, inside the closing transaction
 *   L2  `status = 'open'` evaluated under the lock is the idempotency guard
 *   L3  one transaction per campaign, so a crash rolls back cleanly
 *   L4  campaign_closings.campaign_id is a PK, so a double close cannot commit
 *   L5  the budget assertion before commit
 */
export async function closeExpiredAuctions(
  db: Database,
  { now, maxCampaigns = 50, logger = pino({ enabled: false }) }: CloseOptions,
): Promise<RunSummary> {
  // Committed in its own transaction, before any campaign work, so the
  // per-campaign rows can reference it. A crash therefore leaves
  // finished_at IS NULL — which is the signal, not a gap.
  const [run] = await db.insert(closingRuns).values({}).returning()
  const runId = run!.id
  const log = logger.child({ runId })

  let campaignsClosed = 0
  let bidsDecided = 0
  let totalAwardedCents = 0

  try {
    for (let i = 0; i < maxCampaigns; i++) {
      const result = await closeOneCampaign(db, { runId, now, log })
      if (!result) break
      campaignsClosed += 1
      bidsDecided += result.bidsDecided
      totalAwardedCents += result.awardedCents
    }

    await db.update(closingRuns)
      .set({ finishedAt: new Date(), campaignsClosed, bidsDecided, totalAwardedCents })
      .where(eq(closingRuns.id, runId))

    log.info({ campaignsClosed, bidsDecided, totalAwardedCents }, 'closing run finished')
  } catch (error) {
    // Record the failure on the run row so a crashed run is diagnosable from
    // the database, then rethrow — the caller decides whether to exit non-zero.
    await db.update(closingRuns)
      .set({ finishedAt: new Date(), campaignsClosed, bidsDecided, totalAwardedCents,
             error: error instanceof Error ? error.message : String(error) })
      .where(eq(closingRuns.id, runId))
      .catch(() => { /* the original error matters more than this update */ })
    log.error({ err: error }, 'closing run failed')
    throw error
  }

  return { runId, campaignsClosed, bidsDecided, totalAwardedCents }
}

type OneResult = { bidsDecided: number; awardedCents: number }

/**
 * Claims and closes at most one campaign, atomically. Returns null when there
 * is nothing left to claim.
 *
 * The claim and the close MUST share a transaction: a row lock lives exactly as
 * long as the transaction that took it, so claiming a batch in one transaction
 * and closing each in another would release every lock before any work happened.
 */
async function closeOneCampaign(
  db: Database,
  // `now: Date | undefined`, not `now?: Date`. Under exactOptionalPropertyTypes
  // those differ: the public CloseOptions may omit the key, but this internal
  // call always passes it, possibly holding undefined. Saying so is the honest
  // signature rather than widening the caller.
  { runId, now, log }: { runId: string; now: Date | undefined; log: Logger },
): Promise<OneResult | null> {
  return db.transaction(async (tx) => {
    const cutoff = now ?? new Date()

    // L1 + L2. Under READ COMMITTED, Postgres re-evaluates this WHERE clause
    // after acquiring the row lock, so a campaign another worker closed while
    // we waited is no longer a match — the status predicate is the guard, and
    // the lock is only what makes evaluating it safe.
    const claimed = await tx.select().from(campaigns)
      .where(and(eq(campaigns.status, 'open'), lte(campaigns.biddingDeadline, cutoff)))
      .orderBy(asc(campaigns.biddingDeadline), asc(campaigns.id))
      .limit(1)
      .for('update', { skipLocked: true })

    const campaign = claimed[0]
    if (!campaign) return null

    const pending = await tx.select().from(bids)
      .where(and(eq(bids.campaignId, campaign.id), eq(bids.status, 'pending')))
      .orderBy(asc(bids.id))

    const candidates: BidCandidate[] = pending.map((b) => ({
      id: b.id,
      creatorId: b.creatorId,
      amountCents: b.amountCents,
      // NUMERIC arrives as a string from the driver; the snapshot is authoritative.
      fitScore: Number(b.fitScore),
      createdAt: b.createdAt,
    }))

    const selection = candidates.length > 0
      ? selectWinners(candidates, campaign.budgetCents)
      : { outcomes: [], winningBidIds: [], totalAwardedCents: 0 }

    // L5: refuse to commit rather than overspend. A throw here rolls the whole
    // transaction back and leaves the campaign open for the next run.
    if (selection.totalAwardedCents > campaign.budgetCents) {
      throw new Error(
        `budget invariant violated for campaign ${campaign.id}: ` +
        `awarded ${selection.totalAwardedCents} > budget ${campaign.budgetCents}`,
      )
    }

    const decidedAt = new Date()

    for (const outcome of selection.outcomes) {
      await tx.update(bids)
        .set({ status: outcome.won ? 'won' : 'lost', decidedAt, updatedAt: decidedAt })
        .where(eq(bids.id, outcome.bidId))

      const bid = pending.find((b) => b.id === outcome.bidId)!
      await tx.insert(bidEvents).values({
        bidId: outcome.bidId,
        type: outcome.won ? 'won' : 'lost',
        amountCents: bid.amountCents,
        fitScore: bid.fitScore,
        actor: 'closer',
        runId,
        metadata: outcome.won
          ? { awardedCents: bid.amountCents }
          : { reason: outcome.reason },
      })
    }

    await tx.update(campaigns).set({ status: 'closed' }).where(eq(campaigns.id, campaign.id))

    // L4: PK on campaign_id. If a concurrent worker somehow got this far too,
    // this insert raises a unique violation and the transaction aborts.
    await tx.insert(campaignClosings).values({
      campaignId: campaign.id,
      runId,
      bidCount: candidates.length,
      winningBidCount: selection.winningBidIds.length,
      totalAwardedCents: selection.totalAwardedCents,
    })

    log.info({
      campaignId: campaign.id, bidCount: candidates.length,
      winners: selection.winningBidIds.length,
      awardedCents: selection.totalAwardedCents, budgetCents: campaign.budgetCents,
    }, 'campaign closed')

    return { bidsDecided: candidates.length, awardedCents: selection.totalAwardedCents }
  })
}
