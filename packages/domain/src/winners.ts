/**
 * A bid with fit *as snapshotted when it was placed*. The closer never
 * recomputes fit, which is what makes this function a pure function of
 * committed data — and therefore replayable.
 */
export type BidCandidate = {
  id: string
  creatorId: string
  amountCents: number
  /** 0..100, snapshotted at bid time. */
  fitScore: number
  createdAt: Date
}

/**
 * A bid below this cannot win at any price.
 *
 * Required, not optional: pure value-per-euro makes the cheapest junk win.
 * A fit-20 bid at €10 has density 2.0; a fit-90 bid at €1,000 has 0.09. Real
 * marketplaces work the same way — brands set a quality bar, then optimise
 * spend within it.
 *
 * Lives here as a constant rather than a campaigns column because no brand-side
 * UI exists yet to set it. Promoting it to a column is a migration plus reading
 * it from the row; nothing about this function changes.
 */
export const MIN_FIT_TO_WIN = 40

export type LossReason =
  | 'below_quality_bar'
  | 'outranked'
  | 'did_not_fit_remaining_budget'

export type BidOutcome =
  | { bidId: string; won: true }
  | { bidId: string; won: false; reason: LossReason }

export type SelectionResult = {
  /** One entry per input bid, in the order they were evaluated. */
  outcomes: BidOutcome[]
  winningBidIds: string[]
  totalAwardedCents: number
}

/** Value per cent of budget. Higher is better. */
export const valueDensity = (bid: BidCandidate): number => bid.fitScore / bid.amountCents

/**
 * A TOTAL order over bids. Every key after the first exists to make the sort
 * deterministic, which is what makes the closing job reproducible: an unstable
 * sort over equal-density bids could award different winners on a re-run, and
 * then "safe to run twice" would be false no matter how good the locking is.
 *
 *   1. density desc     — the economic rule
 *   2. fit desc         — at equal value, prefer quality
 *   3. createdAt asc    — reward committing early
 *   4. id asc           — arbitrary, but total. Never decides anything
 *                         meaningful, which is exactly why it must be here.
 */
export function compareBidsByValue(a: BidCandidate, b: BidCandidate): number {
  const byDensity = valueDensity(b) - valueDensity(a)
  if (byDensity !== 0) return byDensity

  const byFit = b.fitScore - a.fitScore
  if (byFit !== 0) return byFit

  const byAge = a.createdAt.getTime() - b.createdAt.getTime()
  if (byAge !== 0) return byAge

  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/**
 * Chooses which bids win a campaign, subject to its budget.
 *
 * This is 0/1 knapsack. We deliberately do NOT solve it optimally — see spec
 * §6.2. Exact DP makes a creator's outcome depend combinatorially on every
 * other bid, so there is no threshold price and no advice you can give them.
 * Greedy value-density gives each creator a rule they can act on: improve your
 * fit or lower your price and your rank improves.
 *
 * Invariants this must uphold (all covered by tests):
 *   - sum of winning amounts <= budgetCents, always
 *   - exactly one outcome per input bid
 *   - identical output for any input permutation
 *   - input array is not mutated
 */
export function selectWinners(
  bids: readonly BidCandidate[],
  budgetCents: number,
): SelectionResult {
  if (!Number.isInteger(budgetCents) || budgetCents <= 0) {
    throw new Error(`budgetCents must be a positive integer, got ${budgetCents}`)
  }

  const outcomes: BidOutcome[] = []
  const winningBidIds: string[] = []
  let remaining = budgetCents

  // TODO(you): 1. partition out bids below MIN_FIT_TO_WIN, pushing a
  //               { won: false, reason: 'below_quality_bar' } outcome for each

  // TODO(you): 2. sort the survivors with compareBidsByValue
  //               (remember: do not mutate `bids`)

  // TODO(you): 3. walk the sorted list. For each bid:
  //               - fits in `remaining`  -> win, decrement remaining
  //               - remaining === 0      -> lose, 'outranked'
  //               - otherwise            -> lose, 'did_not_fit_remaining_budget'
  //                                         and CONTINUE to the next bid

  return {
    outcomes,
    winningBidIds,
    totalAwardedCents: budgetCents - remaining,
  }
}
