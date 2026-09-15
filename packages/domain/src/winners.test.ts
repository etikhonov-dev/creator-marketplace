import { describe, it, expect } from 'vitest'
import { selectWinners, compareBidsByValue, MIN_FIT_TO_WIN, type BidCandidate } from './winners.js'

let seq = 0
const bid = (o: Partial<BidCandidate> = {}): BidCandidate => ({
  id: `bid-${String(++seq).padStart(4, '0')}`,
  creatorId: `creator-${seq}`,
  amountCents: 100_000,
  fitScore: 80,
  createdAt: new Date(2026, 0, 1, 0, 0, seq),
  ...o,
})

/** Deterministic shuffle so the determinism test is itself reproducible. */
function shuffle<T>(items: readonly T[], seed: number): T[] {
  const out = [...items]
  let s = seed
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) & 0x7fffffff
    const j = s % (i + 1)
    ;[out[i], out[j]] = [out[j]!, out[i]!]
  }
  return out
}

const won = (r: ReturnType<typeof selectWinners>) => r.outcomes.filter((o) => o.won).map((o) => o.bidId)

describe('selectWinners', () => {
  it('returns an empty result for no bids', () => {
    const r = selectWinners([], 500_000)
    expect(r.outcomes).toEqual([])
    expect(r.winningBidIds).toEqual([])
    expect(r.totalAwardedCents).toBe(0)
  })

  it('produces exactly one outcome per input bid', () => {
    const bids = [bid(), bid(), bid({ fitScore: 10 })]
    const r = selectWinners(bids, 250_000)
    expect(r.outcomes).toHaveLength(3)
    expect(new Set(r.outcomes.map((o) => o.bidId))).toEqual(new Set(bids.map((b) => b.id)))
  })

  // The invariant the brief names explicitly.
  it('never exceeds the budget', () => {
    const bids = Array.from({ length: 30 }, () => bid({ amountCents: 90_000, fitScore: 70 }))
    const budget = 500_000
    const r = selectWinners(bids, budget)
    expect(r.totalAwardedCents).toBeLessThanOrEqual(budget)
    // Five at 90_000 is 450_000; a sixth would be 540_000. Pinning the count
    // stops this test from passing against an implementation that awards
    // nothing at all, which is trivially within budget.
    expect(won(r)).toHaveLength(5)
    expect(r.totalAwardedCents).toBe(
      r.outcomes.filter((o) => o.won)
        .reduce((sum, o) => sum + bids.find((b) => b.id === o.bidId)!.amountCents, 0),
    )
  })

  it('awards nothing when every bid alone exceeds the budget', () => {
    const r = selectWinners([bid({ amountCents: 900_000 }), bid({ amountCents: 800_000 })], 100_000)
    expect(won(r)).toEqual([])
    expect(r.totalAwardedCents).toBe(0)
    // Asserted before the .every() below, which is vacuously true on an empty
    // array — the assertion that matters is that both bids were *evaluated*.
    expect(r.outcomes).toHaveLength(2)
    expect(r.outcomes.every((o) => !o.won && o.reason === 'did_not_fit_remaining_budget')).toBe(true)
  })

  it('excludes bids below the quality bar at any price', () => {
    const cheapJunk = bid({ amountCents: 100, fitScore: MIN_FIT_TO_WIN - 1 })
    const solid     = bid({ amountCents: 200_000, fitScore: 90 })
    const r = selectWinners([cheapJunk, solid], 500_000)
    expect(won(r)).toEqual([solid.id])
    const junkOutcome = r.outcomes.find((o) => o.bidId === cheapJunk.id)!
    expect(junkOutcome).toEqual({ bidId: cheapJunk.id, won: false, reason: 'below_quality_bar' })
  })

  it('treats the quality bar as inclusive', () => {
    const atBar = bid({ fitScore: MIN_FIT_TO_WIN, amountCents: 10_000 })
    expect(won(selectWinners([atBar], 500_000))).toEqual([atBar.id])
  })

  it('prefers higher value per euro', () => {
    const efficient = bid({ amountCents: 100_000, fitScore: 90 })  // density 0.0009
    const expensive = bid({ amountCents: 400_000, fitScore: 95 })  // density 0.0002375
    const r = selectWinners([expensive, efficient], 100_000)
    expect(won(r)).toEqual([efficient.id])
  })

  // Spec §6.1 step 3: plain greedy stops at the first bid that doesn't fit,
  // leaving budget unspent for no reason.
  it('continues past an unaffordable bid instead of stopping', () => {
    const dense      = bid({ amountCents: 300_000, fitScore: 100 })
    const tooBig     = bid({ amountCents: 250_000, fitScore: 80 })
    const affordable = bid({ amountCents: 90_000, fitScore: 50 })
    const r = selectWinners([dense, tooBig, affordable], 400_000)
    expect(won(r)).toContain(dense.id)
    expect(won(r)).toContain(affordable.id)
    expect(won(r)).not.toContain(tooBig.id)
    expect(r.totalAwardedCents).toBe(390_000)
  })

  it('distinguishes "did not fit" from "outranked"', () => {
    const winner = bid({ amountCents: 100_000, fitScore: 100 })
    const tooBig = bid({ amountCents: 60_000, fitScore: 50 })
    const r = selectWinners([winner, tooBig], 100_000)
    const loser = r.outcomes.find((o) => o.bidId === tooBig.id)!
    // Budget was fully exhausted by the winner, so nothing remained at all.
    expect(loser).toEqual({ bidId: tooBig.id, won: false, reason: 'outranked' })
  })

  // THE test that makes "safe to run twice" true. See spec §6.5.
  it('is deterministic under any input ordering', () => {
    const bids = Array.from({ length: 24 }, (_, i) => bid({
      amountCents: 50_000 + (i % 6) * 10_000,
      // Deliberately collides on density for several pairs, forcing the
      // tie-breakers to do the work.
      fitScore: 40 + (i % 4) * 15,
    }))
    const baseline = selectWinners(bids, 400_000)
    for (const seed of [1, 2, 3, 7, 42, 1337]) {
      const r = selectWinners(shuffle(bids, seed), 400_000)
      expect(r.winningBidIds).toEqual(baseline.winningBidIds)
      expect(r.totalAwardedCents).toBe(baseline.totalAwardedCents)
    }
  })

  it('does not mutate its input', () => {
    const bids = [bid({ fitScore: 50 }), bid({ fitScore: 90 }), bid({ fitScore: 70 })]
    const before = bids.map((b) => b.id)
    selectWinners(bids, 500_000)
    expect(bids.map((b) => b.id)).toEqual(before)
  })

  it('rejects a non-positive budget rather than awarding for free', () => {
    expect(() => selectWinners([bid()], 0)).toThrow()
    expect(() => selectWinners([bid()], -1)).toThrow()
  })
})

describe('the documented worst case (spec §6.4)', () => {
  // Greedy density is not optimal. Pinning the known failure as a test means the
  // README's caveat is verified rather than asserted — and if someone later
  // swaps in a better algorithm, this test tells them the trade-off changed.
  it('prefers a tiny efficient bid over a budget-filling one', () => {
    const tiny = bid({ amountCents: 100, fitScore: 41 })       // density 0.41
    const big  = bid({ amountCents: 100_000, fitScore: 100 })  // density 0.001
    const r = selectWinners([tiny, big], 100_000)
    // Both fit here thanks to continuation, so total fit is 141.
    expect(won(r)).toHaveLength(2)

    // But make the big one exactly fill the budget and the gap appears:
    const r2 = selectWinners(
      [bid({ amountCents: 100, fitScore: 41 }), bid({ amountCents: 100_000, fitScore: 100 })],
      100_050,
    )
    expect(r2.winningBidIds).toHaveLength(1)
    // Greedy takes the tiny one (fit 41); optimal would take the big one (fit 100).
    expect(r2.totalAwardedCents).toBe(100)
  })
})

describe('compareBidsByValue', () => {
  it('is a total order: no two distinct bids compare equal', () => {
    const bids = Array.from({ length: 40 }, (_, i) =>
      bid({ amountCents: 100_000, fitScore: 40 + (i % 3) * 20 }))
    for (const a of bids) for (const b of bids) {
      if (a.id !== b.id) expect(compareBidsByValue(a, b)).not.toBe(0)
    }
  })

  it('is antisymmetric', () => {
    const a = bid({ fitScore: 90 }), b = bid({ fitScore: 50 })
    expect(Math.sign(compareBidsByValue(a, b))).toBe(-Math.sign(compareBidsByValue(b, a)))
  })
})
