import { describe, it, expect } from 'vitest'
import {
  checkEligibility, isEligible, scoreFit,
  FIT_WEIGHTS, ENGAGEMENT_CEILING, AUDIENCE_BASELINE, AUDIENCE_SATURATION_MULTIPLE,
  type CreatorProfile, type CampaignRequirements,
} from './matching.js'

const creator = (o: Partial<CreatorProfile> = {}): CreatorProfile => ({
  genre: 'fitness', followerCount: 100_000, engagementRate: 0.04, ...o,
})
const campaign = (o: Partial<CampaignRequirements> = {}): CampaignRequirements => ({
  targetGenre: 'fitness', minFollowers: 10_000, minEngagementRate: 0.02, ...o,
})

describe('checkEligibility', () => {
  it('passes a creator who clears both gates', () => {
    expect(checkEligibility(creator(), campaign())).toEqual([])
  })

  // Boundary: the requirement is a floor, so exactly meeting it must pass.
  it('treats the minimum as inclusive', () => {
    expect(isEligible(creator({ followerCount: 10_000 }), campaign({ minFollowers: 10_000 }))).toBe(true)
    expect(isEligible(creator({ followerCount: 9_999 }), campaign({ minFollowers: 10_000 }))).toBe(false)
  })

  it('reports every failed gate, with the numbers needed to explain it', () => {
    const reasons = checkEligibility(
      creator({ followerCount: 5_000, engagementRate: 0.01 }),
      campaign({ minFollowers: 50_000, minEngagementRate: 0.03 }),
    )
    expect(reasons).toEqual([
      { code: 'BELOW_MIN_FOLLOWERS', required: 50_000, actual: 5_000 },
      { code: 'BELOW_MIN_ENGAGEMENT', required: 0.03, actual: 0.01 },
    ])
  })

  // Genre is a soft signal, not a gate — see spec §5.2.
  it('does not gate on genre', () => {
    expect(isEligible(creator({ genre: 'gaming' }), campaign({ targetGenre: 'beauty' }))).toBe(true)
  })
})

describe('scoreFit', () => {
  it('declares weights that sum to exactly 1', () => {
    const sum = FIT_WEIGHTS.genre + FIT_WEIGHTS.engagement + FIT_WEIGHTS.audience
    expect(sum).toBeCloseTo(1, 10)
  })

  it('returns 100 for a perfect creator', () => {
    const score = scoreFit(
      creator({ genre: 'fitness', engagementRate: ENGAGEMENT_CEILING, followerCount: 1_000_000 }),
      campaign({ targetGenre: 'fitness', minFollowers: 10_000 }),
    )
    expect(score.total).toBeCloseTo(100, 2)
  })

  it('stays within 0..100 across a wide input sweep', () => {
    for (const followerCount of [0, 1, 1_000, 10_000, 1_000_000, 50_000_000]) {
      for (const engagementRate of [0, 0.001, 0.04, 0.08, 0.5, 1]) {
        for (const genre of ['fitness', 'food', 'gaming'] as const) {
          const { total } = scoreFit(creator({ followerCount, engagementRate, genre }), campaign())
          expect(total).toBeGreaterThanOrEqual(0)
          expect(total).toBeLessThanOrEqual(100)
          expect(Number.isFinite(total)).toBe(true)
        }
      }
    }
  })

  it('returns one component per weighted dimension, each in 0..1', () => {
    const { components } = scoreFit(creator(), campaign())
    expect(components.map((c) => c.key).sort()).toEqual(['audience', 'engagement', 'genre'])
    for (const c of components) {
      expect(c.score).toBeGreaterThanOrEqual(0)
      expect(c.score).toBeLessThanOrEqual(1)
      expect(c.weight).toBe(FIT_WEIGHTS[c.key])
      expect(c.detail.length).toBeGreaterThan(0)
    }
  })

  it('has a total that equals the weighted sum of its own components', () => {
    const score = scoreFit(creator({ genre: 'food' }), campaign())
    const recomputed = score.components.reduce((acc, c) => acc + c.score * c.weight, 0) * 100
    // The breakdown shown in the UI must actually add up to the headline number,
    // or the explanation is a lie.
    expect(score.total).toBeCloseTo(recomputed, 1)
  })

  it('ranks exact genre above adjacent above unrelated, all else equal', () => {
    const exact     = scoreFit(creator({ genre: 'fitness' }), campaign({ targetGenre: 'fitness' })).total
    const adjacent  = scoreFit(creator({ genre: 'food' }),    campaign({ targetGenre: 'fitness' })).total
    const unrelated = scoreFit(creator({ genre: 'beauty' }),  campaign({ targetGenre: 'fitness' })).total
    expect(exact).toBeGreaterThan(adjacent)
    expect(adjacent).toBeGreaterThan(unrelated)
  })

  // The economic point from spec §5.3: a campaign needing 10k followers gets no
  // extra value from a 5M creator, who will be expensive.
  it('saturates audience fit at the saturation multiple', () => {
    const at10x  = scoreFit(creator({ followerCount: 100_000 }),    campaign({ minFollowers: 10_000 })).total
    const at100x = scoreFit(creator({ followerCount: 1_000_000 }),  campaign({ minFollowers: 10_000 })).total
    const at500x = scoreFit(creator({ followerCount: 5_000_000 }),  campaign({ minFollowers: 10_000 })).total
    expect(at10x).toBeCloseTo(at100x, 2)
    expect(at100x).toBeCloseTo(at500x, 2)
  })

  // Without this the engagement component has no discriminating test at all:
  // every other engagement assertion is a saturation or a bounds check, which a
  // function returning a constant would satisfy.
  it('rewards higher engagement below the ceiling', () => {
    const low  = scoreFit(creator({ engagementRate: 0.02 }), campaign()).total
    const mid  = scoreFit(creator({ engagementRate: 0.05 }), campaign()).total
    const high = scoreFit(creator({ engagementRate: ENGAGEMENT_CEILING }), campaign()).total
    expect(mid).toBeGreaterThan(low)
    expect(high).toBeGreaterThan(mid)
  })

  it('saturates engagement fit at the ceiling', () => {
    const atCeiling = scoreFit(creator({ engagementRate: ENGAGEMENT_CEILING }), campaign()).total
    const wayAbove  = scoreFit(creator({ engagementRate: 0.5 }), campaign()).total
    expect(atCeiling).toBeCloseTo(wayAbove, 2)
  })

  it('falls back to the baseline audience when a campaign states no minimum', () => {
    const noMinimum = campaign({ minFollowers: 0 })
    const small = scoreFit(creator({ followerCount: 1_000 }), noMinimum).total
    const large = scoreFit(creator({ followerCount: AUDIENCE_BASELINE * AUDIENCE_SATURATION_MULTIPLE }), noMinimum).total
    // Must still discriminate: a 0 minimum is not "everyone scores full marks".
    expect(large).toBeGreaterThan(small)
    expect(Number.isFinite(small)).toBe(true)
  })

  it('never produces NaN for a zero-follower or zero-engagement creator', () => {
    const { total } = scoreFit(
      creator({ followerCount: 0, engagementRate: 0 }),
      campaign({ minFollowers: 0, minEngagementRate: 0 }),
    )
    expect(Number.isNaN(total)).toBe(false)
    expect(total).toBeGreaterThanOrEqual(0)
  })

  it('is a pure function of its inputs', () => {
    const c = creator(), r = campaign()
    expect(scoreFit(c, r)).toEqual(scoreFit(c, r))
  })
})
